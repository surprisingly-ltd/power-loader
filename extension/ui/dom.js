// Small DOM helpers shared by every Power Loader page: element creation, and re-rendering that keeps
// focus, unsaved typing and scroll position.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

// Typing that hasn't been saved yet, by input key. Inputs created with draftInput() read and write it,
// so re-rendering a region never loses what someone is typing.
export const drafts = new Map();

export function draftInput(key, attrs = {}, tag = 'input') {
  const el = h(tag, { ...attrs, 'data-key': key, oninput: (e) => { drafts.set(key, e.target.value); attrs.oninput?.(e); } });
  el.value = drafts.has(key) ? drafts.get(key) : attrs.value ?? '';
  return el;
}

export function clearDraft(key) { drafts.delete(key); }

/**
 * Replace a region's contents, then put focus, selection and scroll back where they were. Elements are
 * matched by data-key (or id), so give every focusable control in a re-rendered region a stable one.
 */
export function rerender(region, ...children) {
  const active = document.activeElement;
  const inside = active && region.contains(active) && active !== region;
  const key = inside ? active.getAttribute('data-key') || active.id : null;
  const selection = inside && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
  const scrollers = [region, ...region.querySelectorAll('[data-scroll]')].map((el) => [el.getAttribute('data-scroll') || '', el.scrollTop]);
  region.replaceChildren(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
  for (const [name, top] of scrollers) {
    const el = name ? region.querySelector(`[data-scroll="${CSS.escape(name)}"]`) : region;
    if (el) el.scrollTop = top;
  }
  if (!key) return;
  const next = region.querySelector(`[data-key="${CSS.escape(key)}"]`) || (active.id && region.querySelector(`#${CSS.escape(active.id)}`));
  if (!next) return;
  next.focus({ preventScroll: true });
  if (selection && typeof next.setSelectionRange === 'function') { try { next.setSelectionRange(...selection); } catch { /* not a text input */ } }
}

let liveTimer;
// Announce a short message to screen readers and show it briefly.
export function announce(text) {
  let region = document.getElementById('announce');
  if (!region) {
    region = h('div', { id: 'announce', class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(region);
  }
  region.textContent = text;
  region.classList.add('show');
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => region.classList.remove('show'), 4000);
}

// Copy text to the clipboard and say so.
export async function copyText(text, what = 'Text') {
  try { await navigator.clipboard.writeText(text); announce(`${what} copied`); } catch { announce('Copy was blocked by the browser'); }
}

export const plural = (n, word, many) => `${n} ${n === 1 ? word : many || `${word}s`}`;
export const when = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '');
export const time = (iso, { seconds = false } = {}) => (iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) }) : '');
export const describeError = (e) => (e && e.message ? e.message : String(e));

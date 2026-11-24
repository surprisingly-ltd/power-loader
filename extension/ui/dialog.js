// Modal dialogs: focus moves in and is trapped, the rest of the page is inert, Esc closes, and focus
// returns to the control that opened the dialog.
import { h } from './dom.js';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
let open = null;

export const dialogOpen = () => !!open;

/**
 * openDialog({ title, body: (close) => [nodes], wide, onClose, initialFocus }) → { close, refresh(body) }.
 * The body function is called again by refresh() so a dialog can re-render its own contents.
 */
export function openDialog({ title, body, wide = false, onClose, initialFocus }) {
  if (open) open.close();
  const opener = document.activeElement;
  const titleId = `dlg-title-${Math.random().toString(36).slice(2, 8)}`;
  const content = h('div', { class: 'dialog-body' });
  const dlg = h('div', { class: `dialog${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
    h('h2', { id: titleId }, title), content);
  const back = h('div', { class: 'dialog-back' }, dlg);
  // The live region stays reachable so announcements made while a dialog is open are still read.
  const siblings = [...document.body.children].filter((el) => el.id !== 'announce');
  const state = { closed: false };
  const handle = {
    close(result) {
      if (state.closed) return;
      state.closed = true;
      document.removeEventListener('keydown', onKey, true);
      back.remove();
      siblings.forEach((el) => { if (!el.hasAttribute('data-was-inert')) el.inert = false; el.removeAttribute('data-was-inert'); });
      open = null;
      if (opener && opener.isConnected) opener.focus();
      onClose?.(result);
    },
    refresh() {
      const nodes = body(handle);
      content.replaceChildren(...[nodes].flat(Infinity).filter(Boolean));
    },
    element: dlg,
  };
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); handle.close(); return; }
    if (e.key !== 'Tab') return;
    const items = [...dlg.querySelectorAll(FOCUSABLE)].filter((el) => !el.closest('[hidden]'));
    if (!items.length) { e.preventDefault(); dlg.focus(); return; }
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === dlg)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  siblings.forEach((el) => { if (el.inert) el.setAttribute('data-was-inert', ''); el.inert = true; });
  document.body.append(back);
  document.addEventListener('keydown', onKey, true);
  open = handle;
  handle.refresh();
  const target = (initialFocus && dlg.querySelector(initialFocus)) || dlg.querySelector('[autofocus]') || dlg.querySelector(FOCUSABLE) || dlg;
  target.focus();
  return handle;
}

// A yes/no question. Resolves true when confirmed.
export function confirmDialog({ title, text, confirm, cancel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    let answer = false;
    openDialog({
      title,
      onClose: () => resolve(answer),
      body: (d) => [
        ...[text].flat().map((t) => (typeof t === 'string' ? h('p', {}, t) : t)),
        h('div', { class: 'actions' },
          h('button', { type: 'button', onclick: () => d.close() }, cancel),
          h('button', { type: 'button', class: danger ? 'danger' : 'primary', onclick: () => { answer = true; d.close(); } }, confirm)),
      ],
    });
  });
}

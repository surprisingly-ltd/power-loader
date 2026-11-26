// Showing what a clip gathers: the sidebar's part of lib/gather.js. It asks the page to outline the values a
// template reads, and lists the same values as rows in the step, before the clip (waiting) and after it (with
// their values). Pointing at a row marks its value on the page. Talks to the page only through ask() in
// lib/core.js, which checks the site rules (read, D1), and only when what should be shown has changed.
// jsdom and browsers without matchMedia or Element.animate are treated as "less motion".
import { h, plural } from '../ui/dom.js';
import { ask } from '../lib/core.js';
import { display } from '../lib/fields.js';
import { caseKeys, clipValueState } from '../lib/case.js';

export const gatherUi = {
  shown: '', // what the page is showing now: tab, address, template and state
  shownAt: 0, // when the page was asked to outline its values
  syncing: null, // the page being asked, so an automatic clip waits for its answer
  found: null, // the fields found on the page, once it has answered
  flying: null, // { source, landed: Set } while a clip's values are on their way
  closed: null, // { key: section name or true }: values the page has in a closed part it couldn't open
  follow: null, // { url, key, label, value, at }: a conflict's source being followed to its page
  notHere: null, // the source followed, when its value isn't on its page now (or is in a closed part)
};

export const still = () => typeof window === 'undefined' || typeof window.matchMedia !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const labelOf = (lib, key) => lib.fields[key]?.label || key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

/** What a template reads, as rows: [{ key, label, list, typed }]. typed: a value written into the template (=…). */
export const valueRows = (lib, profile) => Object.entries(profile?.fields || {})
  .filter(([key, spec]) => !key.startsWith('@') && (typeof spec === 'string' || Array.isArray(spec)))
  .map(([key, spec]) => ({ key, label: labelOf(lib, key), list: Array.isArray(spec), typed: typeof spec === 'string' && spec.startsWith('=') }));

/** A row's value from a clip, as the sidebar shows values everywhere (display()), or how many rows a list gave. */
function clipValue(lib, clip, row) {
  if (!clip) return null;
  if (row.list) { const n = (clip.records || []).filter((r) => r.group === row.key).length; return n ? `${n} row${n === 1 ? '' : 's'}` : null; }
  const v = clip.values?.[row.key] ?? clip.extra?.[row.key];
  if (v == null || typeof v === 'object') return null;
  return lib.fields[row.key] ? display(lib.fields[row.key], v) : String(v);
}

// What happened to a value, beside it: a conflict links to its card; a decided one says which way it went.
const WHAT = { conflict: 'Conflict', used: 'used', overridden: 'overridden' };

/**
 * The values a step's page gives, as a list. Before the clip each is waiting, or says "not on this page" when
 * the page has answered without it; after it each has its value, and a value in conflict is orange with ⚠ and
 * the word, linked to its card further down. live: the page in view is this page, so pointing at a row marks
 * its value there.
 */
export function valueList(context, profile, clip, { live }) {
  const { lib, ui, data } = context;
  const c = data?.case;
  const rows = valueRows(lib, profile);
  const flying = gatherUi.flying;
  const keys = c ? new Set(caseKeys(c, lib)) : new Set();
  const point = (key, scroll = false) => { if (live && ui.page) ask(ui.page.id, { type: 'powerloader:pointValue', key, scroll }).catch(() => {}); };
  return h('ul', { class: 'gv-list plain', 'data-key': 'gather-values', onmouseleave: () => point(null) }, rows.map((row) => {
    const value = clipValue(lib, clip, row);
    const absent = !clip && live && gatherUi.found && !gatherUi.found.includes(row.key) && !row.typed;
    const waiting = flying && !flying.landed.has(row.key);
    const state = clip ? (value == null ? 'none' : waiting ? 'flying' : 'got') : absent ? 'none' : 'wait';
    // Only once the value has arrived: what it is to the case now.
    const now = clip && c && state === 'got' && !row.list ? clipValueState(c, lib, clip, row.key, { keys }) : null;
    // A value the page has in a part that is closed and couldn't be opened: where to open it.
    const closed = live ? gatherUi.closed?.[row.key] : null;
    return h('li', {
      class: `gv ${state}${now === 'conflict' ? ' conflict' : now === 'used' || now === 'overridden' ? ' decided' : ''}`, 'data-gather': row.key, 'data-key': `gv-${row.key}`, tabindex: live ? '0' : undefined,
      onmouseenter: () => point(row.key), onclick: () => point(row.key, true), onfocus: () => point(row.key, true), onblur: () => point(null),
    },
    h('span', { class: 'gv-mark', 'aria-hidden': 'true' }, now === 'conflict' ? '⚠' : state === 'got' ? '✓' : state === 'none' ? '–' : ''),
    h('span', { class: 'gv-label' }, row.label),
    h('span', { class: 'gv-value' }, clip ? (value ?? 'not on this page') : absent ? 'not on this page' : ''),
    WHAT[now] ? (now === 'conflict'
      ? h('button', {
        type: 'button', class: 'link sm gv-what', 'data-key': `gv-cf-${row.key}`, 'aria-label': `Conflict: decide ${row.label}`,
        onclick: (e) => { e.stopPropagation(); goToCard(row.key); },
      }, WHAT[now])
      : h('span', { class: 'gv-what small' }, WHAT[now])) : null,
    closed && !absent ? h('span', { class: 'gv-closed small', 'data-key': `gv-closed-${row.key}` }, closedText(closed)) : null);
  }));
}

/** A value in a part of the page that is closed and can't be opened safely. name: the section's heading, if it has one. */
export const closedText = (name) => (typeof name === 'string' && name ? `In a closed part of the page: open ${name} to see it` : 'In a closed part of the page: open it to see it');

// ------------------------------------------------------------------ a clip's line

/** The card a conflict's link has just brought into view, ringed for a moment, through re-renders. */
export const ringing = { key: null, until: 0 };
const RING_MS = 1600;

/** Bring a conflict's card into view, focus it and ring it for a moment. False when it isn't on the screen. */
export function goToCard(key) {
  Object.assign(ringing, { key, until: Date.now() + RING_MS });
  const el = typeof document !== 'undefined' ? document.getElementById(`cf-card-${key}`) : null;
  if (!el) return false;
  el.scrollIntoView?.({ block: 'center', behavior: still() ? 'auto' : 'smooth' });
  el.focus?.({ preventScroll: true });
  el.classList.add('ring');
  setTimeout(() => { document.getElementById(`cf-card-${key}`)?.classList.remove('ring'); }, RING_MS);
  return true;
}
export const isRinging = (key) => ringing.key === key && Date.now() < ringing.until;

/**
 * A clip's line, from clipTally() (lib/case.js), as it is now: "3 matched · 2 new · ⚠ 2 conflicts: Address,
 * Postcode", and after deciding "3 matched · 2 new · 1 used · 1 overridden". Each conflict's name goes to its
 * card. A count of zero isn't shown. key: the line's data-key.
 */
export function tallyLine(context, t, { key = 'clip-tally' } = {}) {
  const { lib } = context;
  const name = (k) => lib.fields[k]?.label || k;
  const parts = [
    t.matched.length ? `${t.matched.length} matched` : null,
    t.new.length ? `${t.new.length} new` : null,
    t.used.length ? `${t.used.length} used` : null,
    t.overridden.length ? `${t.overridden.length} overridden` : null,
    t.conflicts.length ? h('span', { class: 'tally-cf' }, h('span', { 'aria-hidden': 'true' }, '⚠ '), `${plural(t.conflicts.length, 'conflict')}: `,
      t.conflicts.map((k, i) => [i ? ', ' : null, h('button', { type: 'button', class: 'link sm', 'data-key': `${key}-cf-${k}`, onclick: () => goToCard(k) }, name(k))])) : null,
    t.records ? `${plural(t.records, 'row')} for tools` : null,
    t.extra.length ? `${t.extra.length} extra kept` : null,
  ].filter(Boolean);
  if (!parts.length) return null;
  return h('div', { class: 'diff tally', 'data-key': key }, parts.map((p, i) => [i ? h('span', { class: 'sep', 'aria-hidden': 'true' }, ' · ') : null, typeof p === 'string' ? h('span', {}, p) : p]));
}

/**
 * Keep the page's outlines in step with the sidebar: want is { profile, state: 'pending' | 'done' } while the
 * tab shows a page a step clips (or a recognised page), or null. Called after every render of the Case tab.
 * A page the site rules don't let Power Loader read is never asked: ask() refuses before anything is sent.
 */
export async function syncValues(context, want) {
  const { ui, act } = context;
  if (gatherUi.flying) return;
  const tab = ui.page;
  // A conflict decided changes the flags, so the page is asked again: its outline goes from orange to green.
  const key = want && tab ? `${tab.id}|${tab.url}|${want.profile.id}|${want.profile.version}|${want.state}|${JSON.stringify(want.flags || {})}` : '';
  if (key === gatherUi.shown) return;
  const before = gatherUi.shown;
  gatherUi.shown = key;
  if (!want) {
    gatherUi.found = null;
    gatherUi.closed = null;
    // Only a page that is still there has anything to take away.
    if (tab && before.startsWith(`${tab.id}|${tab.url}|`)) await ask(tab.id, { type: 'powerloader:clearValues' }).catch(() => {});
    return;
  }
  try {
    if (!before.startsWith(`${tab.id}|${tab.url}|${want.profile.id}|`)) gatherUi.shownAt = Date.now();
    const asked = ask(tab.id, { type: 'powerloader:showValues', fields: want.profile.fields, state: want.state, flags: want.flags || {}, reveal: want.profile.reveal || [] });
    gatherUi.syncing = asked.catch(() => {});
    const res = await asked;
    if (gatherUi.shown !== key) return;
    const found = res?.found || [];
    const closed = res?.closed || null;
    const changed = JSON.stringify(found) !== JSON.stringify(gatherUi.found) || JSON.stringify(closed) !== JSON.stringify(gatherUi.closed);
    gatherUi.found = found;
    gatherUi.closed = closed;
    // A conflict's link brought the caseworker here: now the page is recognised, its value is held in view.
    const held = await holdFollowed(context);
    if (changed || held) act.render();
  } catch {
    // The site rules don't allow it here, or the page has gone: the step still works without the outlines.
    gatherUi.found = null;
    gatherUi.closed = null;
  }
}

// ------------------------------------------------------------------ from a conflict's card to its page

const sameAddress = (a, b) => !!a && !!b && String(a).split('#')[0] === String(b).split('#')[0];

/**
 * Follow a source named on a conflict card to its page, in the case's tab, through act.openUrl() (the site
 * rules' navigate check). Already there, nothing navigates. Once the page is recognised and outlined
 * (syncValues()), the value is scrolled into view and held in orange with ⚠. follow: { url, key, label,
 * value, at } (value and at: what the page read, and when, for "isn't on this page now").
 */
export async function followSource(context, follow) {
  const { ui, act } = context;
  gatherUi.follow = { ...follow };
  gatherUi.notHere = null;
  if (ui.page && sameAddress(ui.page.url, follow.url)) {
    if (await holdFollowed(context)) act.render();
    return true;
  }
  const went = await act.openUrl(follow.url);
  if (went === false) gatherUi.follow = null;
  return went !== false;
}

/** Hold the followed value on the page in view, if it is the page followed. True when something changed. */
async function holdFollowed(context) {
  const { ui } = context;
  const f = gatherUi.follow;
  if (!f || !ui.page) return false;
  if (!sameAddress(ui.page.url, f.url)) return false;
  gatherUi.follow = null;
  let res = null;
  try { res = await ask(ui.page.id, { type: 'powerloader:pointValue', key: f.key, scroll: true, hold: true }); } catch { res = null; }
  // A page that isn't recognised now, or doesn't have the value any more: the sidebar says so.
  gatherUi.notHere = !res?.found ? { ...f } : res.closed ? { ...f, closed: res.closed } : null;
  return true;
}

/** A conflict's page followed, and its value not there now (or in a closed part): what the sidebar says. */
export function followNotice(context) {
  const { ui, lib } = context;
  const n = gatherUi.notHere;
  if (!n || !ui.page || !sameAddress(ui.page.url, n.url)) return null;
  const name = lib.fields[n.key]?.label || n.key;
  return h('p', { class: 'notice warn small', role: 'status', 'data-key': 'follow-not-here' },
    n.closed ? `${name} is on this page, ${closedText(n.closed).replace(/^In/, 'in')}.`
      : n.unknown ? `Power Loader doesn’t recognise this page now, so it can’t show ${name}. It read ${n.value} at ${n.at}.`
        : `${name} isn’t on this page now. It read ${n.value} at ${n.at}.`);
}

/** Ask the page again (a page that loads its data late, just before a clip): the outlines are on what is there now. */
export function resyncValues() { gatherUi.shown = ''; }

/** The sidebar is closing, or the case ended: take the outlines away. */
export async function clearValues(tabId) {
  gatherUi.shown = '';
  gatherUi.found = null;
  gatherUi.closed = null;
  gatherUi.follow = null;
  gatherUi.notHere = null;
  if (tabId != null) await ask(tabId, { type: 'powerloader:clearValues' }).catch(() => {});
}

// ------------------------------------------------------------------ the values travel (step 7)

/** From a page being recognised to an automatic clip reading it: its values are outlined on the page for this long. */
export const AUTO_CLIP_SHOW_MS = 350; // reading and storing the clip takes the rest of the half second (D3)
const LAND_MS = 420;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const canAnimate = (el) => !still() && typeof el?.animate === 'function';

/**
 * An automatic clip is about to read this page: make sure it has been asked to outline its values, then wait
 * until they have been there for a moment (AUTO_CLIP_SHOW_MS from asking, or until the page answers if that
 * is later). With less motion asked for there is no wait. again: ask afresh (a page that loaded its data late).
 */
export async function outlineFirst(context, want, { again = false } = {}) {
  if (!want) return;
  if (again) resyncValues();
  await syncValues(context, want);
  await gatherUi.syncing;
  if (!still()) await sleep(Math.max(0, gatherUi.shownAt + AUTO_CLIP_SHOW_MS - Date.now()));
}

/** Where this sidebar is on the screen, for the page to send values towards it. Null when Firefox won't say. */
const screenOf = () => {
  const x = typeof window.mozInnerScreenX === 'number' && window.mozInnerScreenX ? window.mozInnerScreenX : null;
  const y = typeof window.mozInnerScreenY === 'number' && window.mozInnerScreenY ? window.mozInnerScreenY : null;
  return { x, y };
};

/** A value arrives: from the edge of the sidebar that faces the page, at the height it left the page, to its row. */
function land(row, { y, fromRight }) {
  const slot = row.querySelector('.gv-value');
  const to = slot.getBoundingClientRect();
  const chip = h('div', { class: 'gv-chip', 'aria-hidden': 'true' }, slot.textContent);
  document.body.append(chip);
  const w = chip.getBoundingClientRect().width;
  const x0 = fromRight ? window.innerWidth + 4 : -w - 4;
  const y0 = y == null ? to.top : y;
  chip.style.left = `${x0}px`;
  chip.style.top = `${y0 - 2}px`;
  const anim = chip.animate([
    { transform: 'translate(0, 0) scale(.94)' },
    { transform: `translate(${to.left - x0 - 6}px, ${to.top - y0}px) scale(1)` },
  ], { duration: LAND_MS, easing: 'cubic-bezier(.2, .7, .2, 1)', fill: 'forwards' });
  // A sidebar that isn't drawn (hidden, or in a background tab) never finishes an animation: don't wait for it.
  return Promise.race([anim.finished.catch(() => {}), sleep(LAND_MS + 250)]).then(() => { chip.remove(); });
}

/**
 * Play a clip that has just been stored, of the page in view: the page sends each value off, and its row here
 * receives it. Each value is independent: one whose row has gone (the caseworker changed tab) is just marked
 * arrived. The rows always end with their values, whether or not the page answers.
 */
export async function gather(context, profile, source) {
  const { ui } = context;
  const rows = () => new Map([...document.querySelectorAll('[data-gather]')].map((el) => [el.getAttribute('data-gather'), el]));
  const reveal = (key) => {
    gatherUi.flying?.landed.add(key);
    const el = rows().get(key);
    if (!el || !el.classList.contains('flying')) return;
    el.classList.replace('flying', 'got');
    el.classList.add('landed');
    const mark = el.querySelector('.gv-mark');
    if (mark) mark.textContent = '✓';
  };
  try {
    const me = screenOf();
    const first = rows().values().next().value;
    first?.closest('.step-body')?.scrollIntoView?.({ block: 'nearest' });
    const targets = me.y == null ? {} : Object.fromEntries([...rows()].map(([key, el]) => [key, el.getBoundingClientRect().top + me.y]));
    let res = null;
    try {
      res = await ask(ui.page.id, { type: 'powerloader:gatherValues', fields: profile.fields, sidebar: me.x == null ? null : { x: me.x, width: window.innerWidth }, targets });
    } catch { /* the page has gone or can't be drawn on: the values simply appear */ }
    await Promise.all((res?.items || []).map(async (item) => {
      if (!still()) await sleep(Math.max(0, item.at - 40));
      const el = rows().get(item.key);
      if (!el || gatherUi.flying?.source !== source) return;
      if (canAnimate(el) && el.classList.contains('flying')) await land(el, { y: item.y != null && me.y != null ? item.y - me.y : null, fromRight: res.toLeft });
      reveal(item.key);
    }));
  } finally {
    // Anything the page couldn't show (a value typed into the template) is simply there.
    for (const key of rows().keys()) reveal(key);
  }
  // What to do next is in view once everything has arrived.
  document.querySelector('.step-body [data-main]')?.scrollIntoView?.({ block: 'nearest', behavior: still() ? 'auto' : 'smooth' });
}

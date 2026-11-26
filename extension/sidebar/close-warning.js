// Clearing an open case: when Firefox closes (workstation.clearCaseOnClose), and after it has been left without
// use (workstation.clearCaseAfterHours, 24 by default). Firefox gives an extension no way to stop it closing or to
// ask a question as it does, so the warning comes before and after: a standing line while a case is open, a
// "leave this page?" where Firefox allows it, a notice in the last hour before a case left unused is deleted,
// and a receipt afterwards. The deletion itself is lib/teardown.js clearCaseAtStart() and clearExpiredCase().
/* global browser */
import { h, plural, time } from '../ui/dom.js';
import { clearsAfter, clearsAt, clearsOnClose, hoursText, warnBeforeMs } from '../lib/teardown.js';
import { counts } from '../lib/case.js';

export const CLOSE_NOTE = 'This case is deleted when you close Firefox.';
export const unusedFor = hoursText;

/** The standing line's words: only what applies, given the settings. null when the case is kept. */
export function closeText(policy, settings) {
  const onClose = clearsOnClose(policy, settings).on;
  const { hours } = clearsAfter(policy, settings);
  if (onClose && hours) return `This case is deleted when you close Firefox, or after ${unusedFor(hours)} without use.`;
  if (onClose) return CLOSE_NOTE;
  if (hours) return `This case is deleted after ${unusedFor(hours)} without use.`;
  return null;
}

/** The standing line, while a case is open. data: { case, policy, settings }. */
export function closeNote(data, attrs = {}) {
  const text = data?.case ? closeText(data.policy, data.settings) : null;
  return text ? h('p', { class: 'close-note small', 'data-key': 'close-note', ...attrs }, text) : null;
}

/**
 * In the last hour before a case left without use is deleted: say so, with a way to keep working. keep() is the
 * caller's: any change to the case resets the time (act.update in the sidebar).
 */
export function expiryNotice(data, keep, now = Date.now()) {
  const c = data?.case;
  const { hours } = clearsAfter(data?.policy, data?.settings);
  const at = clearsAt(c, hours);
  if (at === null || at - now > warnBeforeMs(hours)) return null;
  const minutes = Math.max(1, Math.round((at - now) / 60000));
  return h('div', { class: 'notice warn', role: 'alert', 'data-key': 'expiry-soon' },
    h('p', {}, h('b', {}, `This case is deleted after ${unusedFor(hours)} without use. `), `It hasn’t been used for a while, so it goes in about ${plural(minutes, 'minute')}. Anything you do in it keeps it.`),
    h('button', { type: 'button', class: 'sm primary', 'data-key': 'expiry-keep', onclick: keep }, 'Keep working on it'));
}

/** Draws the page again each minute while a case may reach its last hour, so the notice appears on time. */
export function watchExpiry(render) {
  const timer = setInterval(render, 60_000);
  timer?.unref?.(); // in the tests' Node, it mustn't keep the process alive
  return timer;
}

/** Does the case hold values that haven't gone into a form yet? Then closing loses work. */
export function unsubmitted(c) {
  if (!c) return false;
  const n = counts(c);
  if (!n.values && !n.decisions) return false;
  return !(c.forms?.length && c.forms.every((f) => c.submitted?.[f.id]));
}

/**
 * Ask before this page closes while it is the last Firefox window and the case has unsubmitted values.
 * getData: () => { case, policy, settings }. Firefox decides whether it shows the question (it needs the
 * page to have been used, and may not ask for a sidebar at all).
 */
export function guardClose(getData) {
  let windows = 1;
  const count = () => Promise.resolve(browser.windows?.getAll?.()).then((all) => { if (Array.isArray(all)) windows = all.length; }, () => {});
  void count();
  browser.windows?.onCreated?.addListener(count);
  browser.windows?.onRemoved?.addListener(count);
  // Power Loader's own controls move between the sidebar and its pages (Open as a full page, Back): a close
  // that follows a click in the page is one of those, not Firefox closing, so it isn't asked about.
  let clicked = 0;
  document.addEventListener('click', () => { clicked = Date.now(); }, true);
  window.addEventListener('beforeunload', (e) => {
    const data = getData();
    if (Date.now() - clicked < 1500 || windows > 1 || !unsubmitted(data?.case) || !clearsOnClose(data.policy, data.settings).on) return;
    e.preventDefault();
    e.returnValue = CLOSE_NOTE; // older engines show nothing without it
  });
}

/** The receipt after a case was deleted because Firefox closed with it open, or it was left without use. */
export function closedReceipt(r, hours = r.hours || 24) {
  const n = r.counts;
  const what = n ? ` It was deleted: ${plural(n.values, 'value')}, ${plural(n.clips, 'page')}.` : ' It was deleted.';
  return [
    h('h2', {}, r.outcome === 'expired' ? 'Case deleted after being left open' : 'Case deleted when Firefox closed'),
    h('p', {}, `${r.outcome === 'expired' ? `The case was left open for more than ${unusedFor(hours)} without use.` : 'Firefox was closed with a case open.'}${what} Nothing was sent anywhere.`),
    h('p', { class: 'small muted' }, `Deleted at ${time(r.at)}.`),
  ];
}

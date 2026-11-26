// Finish and Discard share one teardown, and so does a case left open when Firefox closed (clear on close).
// It is recorded before it starts, so a browser closed part-way through is finished at the next start.
/* global browser */
import { mutateStorage } from './storage.js';
import { archiveLog, logEvent } from './activity.js';
import { counts } from './case.js';
import { getPolicy } from './policy.js';

export const CASE_ENDED = 'powerloader:case-ended';
// storage.session keys that hold case data for views (full-page origin, unsaved typing, reader results).
// follow and fetchAgain: what the fetched view asked the sidebar to do on return (follow holds a value read).
export const CASE_SESSION_KEYS = ['fullPage', 'returnFocus', 'caseDrafts', 'readerResult', 'follow', 'fetchAgain'];

export const OUTCOMES = ['finished', 'discarded', 'closed', 'expired'];
const ENDED_EVENT = { finished: 'finish_case', discarded: 'discard_case', closed: 'close_case', expired: 'expire_case' };

/** End the active case. outcome: 'finished' | 'discarded' | 'closed' | 'expired'. Resolves the receipt, which names no one. */
export async function endCase(caseId, outcome, { hours } = {}) {
  if (!OUTCOMES.includes(outcome)) throw new Error('Unknown outcome');
  await mutateStorage(({ case: c, teardown }) => {
    if (teardown) return { result: null }; // already ending; carry on with it
    if (!c || c.id !== caseId) throw new Error('That case is no longer active');
    return { patch: { teardown: { caseId, outcome, startedAt: new Date().toISOString(), ...(hours ? { hours } : {}) } } };
  }, ['case', 'teardown']);
  return completeTeardown();
}

/**
 * Finish any recorded teardown: tell every page and worker to drop the case, archive the log without
 * values or real links, delete the case and its view state, and leave a receipt with counts only.
 */
export async function completeTeardown() {
  const { teardown } = await browser.storage.local.get('teardown');
  if (!teardown) return null;
  // 1–3. Pending AI requests, OCR jobs and scans are cancelled, and views cleared, by the pages that own them.
  await browser.runtime.sendMessage({ type: CASE_ENDED, caseId: teardown.caseId }).catch(() => {});
  // 4. Archive and delete in one commit.
  const coarse = !!(await getPolicy().catch(() => null))?.values.activityLog.coarseTimestamps;
  const receipt = await mutateStorage(({ case: c, processLog = [], teardown: t }) => {
    if (!t) return { result: null };
    if (!c || c.id !== t.caseId) return { patch: { case: null }, result: t.receipt || { outcome: t.outcome, at: new Date().toISOString(), counts: null } };
    const at = new Date().toISOString();
    logEvent(c, ENDED_EVENT[t.outcome] || 'discard_case', { at });
    // A case left without use: the receipt says after how long, as it was set then.
    const r = { outcome: t.outcome, at, counts: counts(c), ...(t.hours ? { hours: t.hours } : {}) };
    return { patch: { case: null, processLog: [...processLog, archiveLog(c, t.outcome, at, { coarse })], teardown: { ...t, receipt: r } }, result: r };
  }, ['case', 'processLog', 'teardown']);
  // Keep the durable checkpoint if transient deletion fails; recovery must retry it too.
  await browser.storage.session?.remove(CASE_SESSION_KEYS);
  // 5. The receipt stays until the next case starts.
  await mutateStorage(() => ({ patch: { teardown: null, receipt } }), ['teardown', 'receipt']);
  return receipt;
}

/**
 * Is the open case deleted when Firefox closes? policy workstation.clearCaseOnClose, when the organisation set
 * it (locked, either way); otherwise the caseworker's Settings; otherwise on.
 */
export function clearsOnClose(policy, settings) {
  const locked = policy?.locked instanceof Set && policy.locked.has('workstation.clearCaseOnClose');
  const p = policy?.values?.workstation?.clearCaseOnClose;
  if (locked) return { on: p !== false, locked: true };
  const mine = settings?.clearCaseOnClose;
  return { on: typeof mine === 'boolean' ? mine : p !== false, locked: false };
}

/**
 * At browser start (runtime.onStartup), before anything else reads the case: a case left open when Firefox
 * closed, or crashed, is deleted as Discard deletes it, with the outcome "closed". Resolves the receipt or null.
 * An update or reload of Power Loader isn't a browser start, so it never clears the case.
 */
export async function clearCaseAtStart() {
  const [policy, { case: c, teardown, settings }] = await Promise.all([
    getPolicy().catch(() => null), browser.storage.local.get(['case', 'teardown', 'settings'])]);
  if (!c || teardown || !clearsOnClose(policy, settings).on) return null; // an interrupted teardown: background.js finishes it
  return endCase(c.id, 'closed');
}

/** A number of hours as Power Loader keeps it: in half hours, lowest 0.5; 0 is never; anything else is null. */
export function cleanHours(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return n === 0 ? 0 : Math.max(0.5, Math.round(n * 2) / 2);
}

/**
 * After how many hours without use is the open case deleted? { hours, locked, max }. hours 0 is never.
 *   policy workstation.clearCaseAfterHours, set: that value, locked (it wins over a maximum).
 *   policy workstation.clearCaseMaxHours, set: the caseworker may choose at or below it, never "never";
 *   a choice above it, or never, is held at the maximum.
 *   otherwise the caseworker's Settings, otherwise 24.
 */
export function clearsAfter(policy, settings) {
  const set = (k) => policy?.locked instanceof Set && policy.locked.has(`workstation.${k}`);
  const max = set('clearCaseMaxHours') ? cleanHours(policy.values.workstation.clearCaseMaxHours) || null : null;
  if (set('clearCaseAfterHours')) return { hours: cleanHours(policy.values.workstation.clearCaseAfterHours) ?? 24, locked: true, max };
  const mine = cleanHours(settings?.clearCaseAfterHours) ?? cleanHours(policy?.values?.workstation?.clearCaseAfterHours) ?? 24;
  return { hours: max && (mine === 0 || mine > max) ? max : mine, locked: false, max };
}

/** Is this a time the caseworker may choose? Resolves null, or why not, in words. */
export function hoursError(policy, value) {
  const n = cleanHours(value);
  if (n === null) return 'Enter a number of hours, such as 4 or 0.5';
  const { locked, max } = clearsAfter(policy, {});
  if (locked) return 'Your organisation has set this';
  if (max && n === 0) return `Your organisation deletes a case left without use after ${hoursText(max)} at most, so “never” can’t be chosen`;
  if (max && n > max) return `Your organisation allows ${hoursText(max)} at most`;
  return null;
}

/** "30 minutes", "1 hour", "4 hours", "1.5 hours", "24 hours": the wording always follows the value. */
export function hoursText(hours) {
  if (hours < 1) return `${Math.round(hours * 60)} minutes`;
  if (hours === 1) return '1 hour';
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} hours`;
}

/** How long before a case left without use is deleted the sidebar says so: an hour, or a sixth of a short limit. */
export const warnBeforeMs = (hours) => Math.min(3600_000, (hours * 3600_000) / 6);

// The last time the case was used: every change to it, each logged activity among them, sets touchedAt (the
// same time the idle check, workstation.idleConfirmMinutes, reads).
export const lastUsed = (c) => Date.parse(c?.touchedAt || c?.createdAt || '') || 0;

/** When the case is deleted for being left without use, in ms, or null when it never is. */
export const clearsAt = (c, hours) => (c && hours ? lastUsed(c) + hours * 3600_000 : null);

/**
 * On the alarm, and when the background starts: a case left without use for longer than clearCaseAfterHours is
 * deleted as Discard deletes it, with the outcome "expired". Resolves the receipt, or null when nothing was due.
 */
export async function clearExpiredCase(now = Date.now()) {
  const [policy, { case: c, teardown, settings }] = await Promise.all([
    getPolicy().catch(() => null), browser.storage.local.get(['case', 'teardown', 'settings'])]);
  const at = clearsAt(c, clearsAfter(policy, settings).hours);
  if (!c || teardown || at === null || now < at) return null;
  return endCase(c.id, 'expired', { hours: clearsAfter(policy, settings).hours });
}

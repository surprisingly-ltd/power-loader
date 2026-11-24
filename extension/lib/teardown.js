// Finish and Discard share one teardown. It is recorded before it starts, so a browser closed part-way
// through is finished at the next start.
/* global browser */
import { mutateStorage } from './storage.js';
import { archiveLog, logEvent } from './activity.js';
import { counts } from './case.js';
import { getPolicy } from './policy.js';

export const CASE_ENDED = 'powerloader:case-ended';
// storage.session keys that hold case data for views (full-page origin, unsaved typing, reader results).
export const CASE_SESSION_KEYS = ['fullPage', 'returnFocus', 'caseDrafts', 'readerResult'];

/** End the active case. outcome: 'finished' | 'discarded'. Resolves the receipt, which names no one. */
export async function endCase(caseId, outcome) {
  if (!['finished', 'discarded'].includes(outcome)) throw new Error('Unknown outcome');
  await mutateStorage(({ case: c, teardown }) => {
    if (teardown) return { result: null }; // already ending; carry on with it
    if (!c || c.id !== caseId) throw new Error('That case is no longer active');
    return { patch: { teardown: { caseId, outcome, startedAt: new Date().toISOString() } } };
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
    logEvent(c, t.outcome === 'finished' ? 'finish_case' : 'discard_case', { at });
    const r = { outcome: t.outcome, at, counts: counts(c) };
    return { patch: { case: null, processLog: [...processLog, archiveLog(c, t.outcome, at, { coarse })], teardown: { ...t, receipt: r } }, result: r };
  }, ['case', 'processLog', 'teardown']);
  // Keep the durable checkpoint if transient deletion fails; recovery must retry it too.
  await browser.storage.session?.remove(CASE_SESSION_KEYS);
  // 5. The receipt stays until the next case starts.
  await mutateStorage(() => ({ patch: { teardown: null, receipt } }), ['teardown', 'receipt']);
  return receipt;
}

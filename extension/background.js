// The toolbar button toggles the sidebar. The background owns the storage writer, finishes any Finish or
// Discard that a closed browser interrupted, and logs navigation for the active case: the sidebar may be
// closed, so it can't be the only place logging happens.
/* global browser */
import './lib/extract.js';
import { mutateStorage, registerStorageWriter } from './lib/storage.js';
import { completeTeardown } from './lib/teardown.js';
import { registerPageRoutes } from './lib/pages.js';
import { ask, caseLibrary, updateCase } from './lib/core.js';
import { visitEvent } from './lib/visits.js';
import { applyRetention, logEvent } from './lib/activity.js';
import { getPolicy } from './lib/policy.js';

registerStorageWriter();
registerPageRoutes({ ask });

browser.action.onClicked.addListener(() => {
  browser.sidebarAction.toggle();
});

// Approved systems only, for the window the case was started in. Never logs addresses of other pages,
// and never logs tab.url anywhere else (auto-clip, which once did, is off for the first release).
async function logVisit(tab, reason) {
  if (!tab?.url || !/^https?:/.test(tab.url)) return;
  const { case: c, teardown, library, profileDrafts = [] } = await browser.storage.local.get(['case', 'teardown', 'library', 'profileDrafts']);
  if (!c || teardown || (c.windowId != null && tab.windowId !== c.windowId)) return;
  let lib;
  try { lib = caseLibrary(library, c); } catch { return; }
  if (!visitEvent(c, lib, { url: tab.url, reason }, profileDrafts)) return;
  await updateCase(c.id, (cs, l) => {
    const ev = visitEvent(cs, l, { url: tab.url, reason }, profileDrafts);
    if (ev) logEvent(cs, 'visit_page', ev);
  }).catch(() => {});
}

browser.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status === 'complete' && tab.active) void logVisit(tab, 'load');
});
browser.tabs.onActivated.addListener(({ tabId }) => {
  browser.tabs.get(tabId).then((tab) => logVisit(tab, 'switch'), () => {});
});

// Kept logs past the retention period are deleted.
async function retain() {
  const days = (await getPolicy()).values.activityLog.retentionDays;
  await mutateStorage(({ processLog = [] }) => {
    const kept = applyRetention(processLog, days);
    return kept.length === processLog.length ? { result: 0 } : { patch: { processLog: kept }, result: processLog.length - kept.length };
  }, ['processLog']);
}

completeTeardown().catch((e) => console.warn('Power Loader could not finish deleting the last case', e.name));
retain().catch(() => {});

// The toolbar button toggles the sidebar. The background owns the storage writer, finishes any Finish or
// Discard that a closed browser interrupted, and logs navigation for the active case: the sidebar may be
// closed, so it can't be the only place logging happens.
/* global browser */
import './lib/extract.js';
import { mutateStorage, registerStorageWriter } from './lib/storage.js';
import { clearCaseAtStart, clearExpiredCase, clearsAfter, clearsAt, completeTeardown } from './lib/teardown.js';
import { registerPageRoutes } from './lib/pages.js';
import { ask, caseLibrary, currentAccess, pruneBlockedOrigins, updateCase } from './lib/core.js';
import { libraryConfig, libraryOrigin, syncLibrary } from './lib/library-sync.js';
import { endpointPattern } from './lib/ai/settings.js';
import { visitEvent } from './lib/visits.js';
import { applyRetention, logEvent } from './lib/activity.js';
import { getPolicy } from './lib/policy.js';
import { toolOn } from './lib/tools.js';

registerStorageWriter();
registerPageRoutes({ ask });

browser.action.onClicked.addListener(() => {
  browser.sidebarAction.toggle();
});

// Approved systems only, for the window the case was started in. Never logs addresses of other pages,
// and never logs tab.url anywhere else (auto-clip, which once did, is off for the first release).
async function logVisit(tab, reason) {
  if (!tab?.url || !/^https?:/.test(tab.url)) return;
  const { case: c, teardown, library } = await browser.storage.local.get(['case', 'teardown', 'library']);
  if (!c || teardown || (c.windowId != null && tab.windowId !== c.windowId)) return;
  let lib;
  try { lib = caseLibrary(library, c); } catch { return; }
  const access = await currentAccess();
  if (!visitEvent(c, lib, { url: tab.url, reason }, access)) return;
  await updateCase(c.id, (cs, l) => {
    const ev = visitEvent(cs, l, { url: tab.url, reason }, access);
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

// Host permissions for sites the rules block entirely are removed: at startup, when the rules change (the
// caseworker's settings, a library sync) and when one is granted from about:addons. The library's and the AI
// gateway's own origins are kept: site rules apply to casework pages, not to Power Loader's infrastructure.
async function prune() {
  const keep = [];
  const cfg = await libraryConfig().catch(() => ({}));
  try { if (cfg.baseUrl) keep.push(libraryOrigin(cfg.baseUrl)); } catch { /* no library address */ }
  const { settings } = await browser.storage.local.get('settings');
  const gateway = (await getPolicy()).values.gateway?.baseUrl;
  for (const url of [settings?.ai?.baseUrl, gateway]) {
    try { if (url) keep.push(endpointPattern(url)); } catch { /* no gateway */ }
  }
  await pruneBlockedOrigins({ keep });
}
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ('settings' in changes || 'library' in changes)) prune().catch(() => {});
});
browser.permissions.onAdded.addListener(() => { prune().catch(() => {}); });
prune().catch(() => {});

// The library keeps itself up to date: at browser start, on install or update, and on a timer
// (policy library.syncMinutes, default 60, 0 for off). Only with the library host already granted: a timed
// sync never asks Firefox for anything. A failure is recorded and tried again at the next interval.
const SYNC_ALARM = 'library-sync';
async function timedSync() {
  const cfg = await libraryConfig();
  if (!cfg.baseUrl) return;
  if (!(await browser.permissions.contains({ origins: [libraryOrigin(cfg.baseUrl)] }))) return;
  await syncLibrary({ auto: true });
}
async function scheduleSync() {
  const minutes = (await getPolicy()).values.library.syncMinutes;
  // The background wakes often: an alarm already set with this period is left to run.
  const set = await browser.alarms.get(SYNC_ALARM);
  if (!minutes) { if (set) await browser.alarms.clear(SYNC_ALARM); return; }
  if (set?.periodInMinutes !== minutes) browser.alarms.create(SYNC_ALARM, { delayInMinutes: minutes, periodInMinutes: minutes });
}
browser.alarms.onAlarm.addListener((alarm) => { if (alarm.name === SYNC_ALARM) timedSync().catch(() => {}); });
// Clear on close: a case left open when Firefox closed is deleted first, then the library syncs.
browser.runtime.onStartup.addListener(() => {
  clearCaseAtStart().catch((e) => console.warn('Power Loader could not delete the case left open', e.name))
    .then(() => clearExpiredCase()).catch(() => {})
    .finally(() => timedSync().catch(() => {}));
});
// A case left without use for longer than workstation.clearCaseAfterHours (as short as half an hour) is deleted:
// on its own alarm, set for the moment it would be due and moved on each time the case is used or the setting
// changes, and whenever the background starts.
const CLEAR_ALARM = 'case-clear';
async function scheduleClear() {
  const [policy, { case: c, teardown, settings }] = await Promise.all([getPolicy(), browser.storage.local.get(['case', 'teardown', 'settings'])]);
  const at = c && !teardown ? clearsAt(c, clearsAfter(policy, settings).hours) : null;
  if (at === null) { await browser.alarms.clear(CLEAR_ALARM); return; }
  if (at <= Date.now()) { await clearExpiredCase(); return; }
  const set = await browser.alarms.get(CLEAR_ALARM);
  if (set?.scheduledTime !== at) browser.alarms.create(CLEAR_ALARM, { when: at });
}
browser.alarms.onAlarm.addListener((alarm) => { if (alarm.name === CLEAR_ALARM) clearExpiredCase().then(() => scheduleClear()).catch(() => {}); });
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ('case' in changes || 'settings' in changes)) scheduleClear().catch(() => {});
});
clearExpiredCase().then(() => scheduleClear()).catch(() => {});
browser.runtime.onInstalled.addListener(() => { timedSync().catch(() => {}); });
scheduleSync().catch(() => {});

// Selecting a region on a build with fixed hosts (tools/build-ext.mjs adds activeTab, menus and the command): Firefox
// grants capture of a tab when it's asked from the page, so the page's right-click menu and Alt+Shift+R start it.
// The sidebar does the selecting; the capture tool and the site rules are checked there, where it is captured.
const REGION = 'select-region';
async function regionMenu() {
  if (!browser.menus) return;
  await browser.menus.remove(REGION).catch(() => {});
  const [policy, { settings }] = await Promise.all([getPolicy(), browser.storage.local.get('settings')]);
  if (!toolOn(policy, settings, 'capture') || !toolOn(policy, settings, 'reader')) return;
  browser.menus.create({ id: REGION, title: 'Select a region with Power Loader', contexts: ['page', 'frame', 'image', 'selection', 'link'] });
}
function startRegion(tab) {
  if (!tab?.id) return;
  void browser.sidebarAction.open().catch(() => {}); // in the user action itself, as Firefox requires
  void browser.storage.session.set({ pendingRegion: { tabId: tab.id, at: Date.now() } });
}
if (browser.menus) {
  browser.menus.onClicked.addListener((info, tab) => { if (info.menuItemId === REGION) startRegion(tab); });
  regionMenu().catch(() => {});
  browser.storage.onChanged.addListener((changes, area) => { if (area === 'local' && 'settings' in changes) regionMenu().catch(() => {}); });
}
browser.commands?.onCommand.addListener((name, tab) => {
  if (name !== REGION) return;
  if (tab) startRegion(tab);
  else browser.tabs.query({ active: true, currentWindow: true }).then(([t]) => startRegion(t), () => {});
});

completeTeardown().catch((e) => console.warn('Power Loader could not finish deleting the last case', e.name));
retain().catch(() => {});

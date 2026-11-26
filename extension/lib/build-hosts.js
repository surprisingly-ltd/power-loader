// The sites this build may ever be granted. The public build asks for each site when it's needed
// (optional_host_permissions <all_urls>). An organisation build with build.hosts (tools/build-ext.mjs) has
// them granted at install as host_permissions, and nothing optional: a site outside them can never be granted.
/* global browser */
import { matchesAny } from './access.js';

export const NOT_HERE = 'Your organisation’s version of Power Loader doesn’t work on this site.';

/** The fixed list of hosts, or null when any site can be granted (asked for one by one). */
export function fixedHosts(manifest = globalThis.browser?.runtime?.getManifest?.()) {
  // Only a build that lists its hosts and can't ask for others has fixed hosts.
  if (!Array.isArray(manifest?.host_permissions) || (manifest.optional_host_permissions || []).includes('<all_urls>')) return null;
  return manifest.host_permissions;
}

/** Could this build ever be granted the site at this address? */
export function canBeGranted(url, manifest) {
  const hosts = fixedHosts(manifest);
  return hosts === null || hosts.includes('<all_urls>') || matchesAny(hosts, url);
}

export const NO_CAPTURE = 'Selecting a region is turned off in your organisation’s version of Power Loader. Paste a screenshot instead: press Win+Shift+S, then Ctrl+V here.';
export const CAPTURE_HOW = 'To select a region, right-click the page and choose “Select a region with Power Loader”, or press Alt+Shift+R. Firefox lets your organisation’s version of Power Loader capture a tab only when you ask it from the page.';

/**
 * Firefox offers tabs.captureVisibleTab only with <all_urls> or activeTab (checked in Firefox 140.17 ESR: the page's
 * own host permission isn't enough, and a click in the sidebar doesn't grant activeTab; the page's right-click menu
 * and a keyboard command do). A build with fixed hosts has activeTab for capture (tools/build-ext.mjs), so capture
 * starts from the page; with the capture tool off in its policy file it has neither, and can't capture.
 */
export const captureByActiveTab = (manifest = globalThis.browser?.runtime?.getManifest?.()) => {
  const h = fixedHosts(manifest);
  return h !== null && !h.includes('<all_urls>') && (manifest.permissions || []).includes('activeTab');
};
export const captureImpossible = (manifest = globalThis.browser?.runtime?.getManifest?.()) => {
  const h = fixedHosts(manifest);
  return h !== null && !h.includes('<all_urls>') && !(manifest.permissions || []).includes('activeTab');
};

/** Has Firefox granted activeTab for the tab showing in this window? A one-pixel capture tells. */
export async function activeTabGranted(windowId) {
  try { await browser.tabs.captureVisibleTab(windowId, { format: 'png', rect: { x: 0, y: 0, width: 1, height: 1 } }); return true; } catch { return false; }
}

// Which navigations the activity log records. Approved systems only: a page is logged when a library
// profile, form or confirmation page matches it, or its host is on the library's approved list. Other
// browsing is never recorded, even while a case is open. Pure functions, no browser APIs.
import { hostApproved, pageProfiles } from './library.js';
import { fillProfileForCase } from './fill.js';
import { NOT_KEPT } from './activity.js';

const E = () => globalThis.PowerLoaderExtract;
const noHash = (u) => String(u || '').split('#')[0];

/** What the log may keep for a page: { type, pattern } or null when the page isn't on an approved system. */
export function pageInfo(lib, url, drafts = []) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const [profile] = pageProfiles(lib, url, drafts);
  if (profile) return { type: `${profile.id}@${profile.version}${profile.draft ? '+draft' : ''}`, pattern: profile.urlPattern || NOT_KEPT };
  for (const form of Object.values(lib.forms)) {
    const fp = fillProfileForCase(lib, form.id, drafts);
    if (fp && E().matchUrl(fp.match, url)) return { type: `form:${form.id}@${form.version}`, pattern: fp.urlPattern || NOT_KEPT };
    if (form.confirmation && E().matchUrl(form.confirmation.match, url)) return { type: `confirm:${form.id}@${form.version}`, pattern: NOT_KEPT };
  }
  // An approved host with no profile: the page type only; the address is never kept.
  if (hostApproved(u.host, lib.approvedHosts)) return { type: 'approved-host', pattern: NOT_KEPT };
  return null;
}

/**
 * Should this navigation add a visit_page event? reason: 'load' (a page finished loading) or 'switch'
 * (the caseworker switched to a tab). Reloads and same-page hash changes are not new visits; switching to a
 * tab that already belongs to the case is one event.
 */
export function visitEvent(c, lib, { url, reason = 'load' }, drafts = []) {
  const info = pageInfo(lib, url, drafts);
  if (!info) return null;
  const visits = c.log.filter((e) => e.activity === 'visit_page');
  const last = visits[visits.length - 1];
  if (last && noHash(last.url) === noHash(url)) return null;
  if (reason === 'switch' && !c.log.some((e) => e.url && noHash(e.url) === noHash(url))) return null;
  return { page: { ...info, url: noHash(url) }, detail: reason === 'switch' ? 'Switched to tab' : '' };
}

// The Power Loader sidebar: start a case from a flow, work its steps, clip pages, decide conflicts, finish.
/* global browser */
import '../lib/extract.js';
import { h, rerender, announce, describeError, plural, drafts } from '../ui/dom.js';
import { tabList, tabPanel } from '../ui/tabs.js';
import {
  CaseEnded, caseLibrary, clipTab, confirmationFor, describeForm, hasPageAccess, libraryAt, pageLogInfo, pageTextOf,
  profilesForTab, startFlowCase, toggleStar, updateCase, updateCaseFlow,
} from '../lib/core.js';
import { CASE_ENDED } from '../lib/teardown.js';
import { caseLabel, conflictKeys, markSubmitted, setCaseRef } from '../lib/case.js';
import { logBlocked, logEvent } from '../lib/activity.js';
import { renderStart } from './start.js';
import { renderCaseTab } from './caseview.js';
import { valuesWanted } from './steps.js';
import { clearValues, followSource, gather, gatherUi, outlineFirst, syncValues } from './gather-ui.js';
import { renderTemplates } from './templates.js';
import { renderSettings } from './settings.js';
import { libraryConfig, libraryOrigin as libraryOriginOf, syncLibrary } from '../lib/library-sync.js';
import { openFullPage, returnToSidebar } from '../lib/pages.js';
import { openRemoveClip, openFinish, openDiscard } from './case-dialogs.js';
import { fillBlock } from './fill-ui.js';
import { cancelRunning, extractWithAI, installPresenter, privacyUi, renderPrivacy, watchModel } from './privacy.js';
import { aiSettingsCard } from './ai-settings.js';
import { renderTools, resetTools, tools } from './tools/tools.js';
import { onPaste, onStepPaste, startPendingRegion } from './tools/reader-ui.js';
import { cancelScans } from '../lib/privacy-client.js';
import { getPolicy } from '../lib/policy.js';
import { saveSettings, settingsUnderPolicy } from '../lib/ai/settings.js';
import { closeNote, expiryNotice, guardClose, watchExpiry } from './close-warning.js';
import { NOT_HERE, canBeGranted } from '../lib/build-hosts.js';
import { fillProfileForCase } from '../lib/fill.js';
import { arriveInBuild, fixInBuild, flowNotePreview, loadFlowEditing, onFlowDragPick, onFlowPicked, renderFlows, startFromFlow, syncFlowPicking } from './flows.js';
import { clearNotes, syncNotes } from './annotate.js';
import { autoClipDelay, refOnArrival } from '../lib/journey.js';
import { accessLayers, allowed, backgroundReading, blockedHere, originVerdict } from '../lib/access.js';
import { cancelFetches, runAgain, syncLists } from './fetch-ui.js';
import { recordFailure } from '../lib/diagnostics.js';

const E = globalThis.PowerLoaderExtract;
const isWebPage = (url) => /^https?:/.test(url || '');
const sameAddress = (a, b) => !!a && !!b && String(a).split('#')[0] === String(b).split('#')[0];

// Two modes, one at a time: Casework (working a case along its flow's steps) and Build (making a flow). Build is
// for everyone: no setting or policy hides it. The site rules bind a flow whoever made it.
export const MODES = {
  casework: ['case', 'tools', 'privacy', 'settings'],
  build: ['flows', 'templates', 'privacy', 'settings'],
};
export const modeOf = (settings) => (settings?.mode === 'build' ? 'build' : 'casework');

export const ui = {
  tab: 'case',
  windowId: null,
  page: null, // { id, url, title }
  info: null, // what the current page is to the case: { kind, access, blocked, profile?, formId?, fillProfile?, confirmation? }
  start: { search: '', flowRef: {} },
  view: { formFilter: null, fieldFilter: 'all', expanded: null, clipOpen: null },
  lastClip: null, // { url, summary }
  busy: null,
  autoClipping: null, // the source auto-clip is working on, so a burst of tab events clips it once
};
// Tab events can arrive while the first storage snapshot is still loading.
let data = { drafts: [], flows: [], starred: [] };

async function load() {
  const s = await browser.storage.local.get(['case', 'teardown', 'receipt', 'starred', 'library', 'flows', 'settings', 'cases', 'profiles', 'processLog']);
  const c = s.case && !s.teardown ? s.case : null;
  let caseLib = null;
  let caseError = null;
  if (c) {
    try { caseLib = caseLibrary(s.library, c); } catch (e) { caseError = describeError(e); }
  }
  const libraryCfg = await libraryConfig().catch(() => ({}));
  const policy = await getPolicy().catch(() => ({ values: {}, locked: new Set() }));
  const lib = s.library ? libraryAt(s.library, s.library.current) : null;
  data = {
    ...s, settings: settingsUnderPolicy(s.settings, policy), case: c, caseLib, caseError, flows: s.flows || [], starred: s.starred || [], libraryCfg, libraryForm: data.libraryForm, policy, aiForm: data.aiForm, aiStatus: data.aiStatus,
    lib, siteForm: data.siteForm,
    // The site rules, for decisions that must be made in a click (asking Firefox for a permission). The
    // choke points in lib/core.js read them again, live, when they act.
    access: accessLayers({ policy, settings: s.settings, caseLib, currentLib: lib }),
    // Read pages in the background: on, or who turned it off (fetch steps say so in words).
    background: backgroundReading({ policy, settings: s.settings, caseLib, currentLib: lib }),
  };
}

// The library that applies right now: the case's pinned version while a case is open.
const activeLib = () => (data.case ? data.caseLib : data.lib);

async function refreshPage() {
  const [tab] = await browser.tabs.query({ active: true, windowId: ui.windowId });
  const page = tab ? { id: tab.id, url: tab.url, title: tab.title, loaded: tab.status !== 'loading' } : null;
  const info = { kind: 'none', access: false };
  const lib = activeLib();
  if (page?.url?.startsWith(browser.runtime.getURL(''))) info.kind = 'fullpage';
  if (page && isWebPage(page.url)) {
    info.kind = 'unknown';
    // What the site rules block here, before any profile is matched: with reading blocked, nothing is.
    info.blocked = blockedHere(data.access, page.url);
    info.originBlocked = originVerdict(data.access, page.url) === 'blocked';
    info.access = await hasPageAccess(page.url).catch(() => false);
    ui.allUrls = await browser.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false);
    info.grantable = canBeGranted(page.url);
    if (info.blocked.read) info.kind = 'blocked';
    else if (info.access && lib) {
      try {
        const [profile] = await profilesForTab(page.id, page.url, lib);
        const fillProfiles = Object.keys(lib.forms).map((id) => fillProfileForCase(lib, id)).filter(Boolean);
        const fill = fillProfiles.filter((p) => E.matchUrl(p.match, page.url));
        const formFill = fill.length ? (await profilesForTab(page.id, page.url, { profiles: fill }))[0] : null;
        if (profile) Object.assign(info, { kind: 'source', profile });
        else if (formFill) {
          const formId = formFill.form?.id || Object.values(lib.forms).find((f) => f.fill === formFill.id)?.id;
          if (formId) Object.assign(info, { kind: 'form', formId, fillProfile: formFill });
        }
        // A form the library knows by its address, but has no fill profile for yet.
        const bare = info.kind === 'unknown' && Object.values(lib.forms).find((f) => f.url && page.url.split(/[?#]/)[0] === f.url);
        if (bare) Object.assign(info, { kind: 'form', formId: bare.id, fillProfile: null });
        if (info.kind === 'unknown' && Object.values(lib.forms).some((f) => f.confirmation && E.matchUrl(f.confirmation.match, page.url))) {
          const { text } = await pageTextOf(page.id);
          const conf = confirmationFor(lib, page.url, text);
          if (conf) Object.assign(info, { kind: 'confirm', formId: conf.formId, confirmation: conf });
        }
      } catch (e) {
        console.warn('Power Loader could not inspect the page', e?.name);
      }
    }
  }
  const moved = ui.page?.id !== page?.id || ui.page?.url !== page?.url;
  ui.page = page;
  ui.info = info;
  if (moved) { ui.lastClip = null; ui.lastBlocked = null; if (ui.refDeclined && ui.refDeclined !== page?.url) ui.refDeclined = null; }
  // A conflict's page being followed: forgotten once the tab has gone somewhere else, and said so when the page
  // it went to isn't one Power Loader recognises now (so there is nothing to outline).
  const f = gatherUi.follow;
  if (f && page?.loaded && !sameAddress(page.url, f.url) && !sameAddress(page.url, f.from)) gatherUi.follow = null;
  else if (f && page?.loaded && sameAddress(page.url, f.url) && info.kind !== 'source') Object.assign(gatherUi, { follow: null, notHere: { ...f, unknown: true } });
  if (moved && gatherUi.notHere && !sameAddress(page?.url, gatherUi.notHere.url)) gatherUi.notHere = null;
  await caseRefFromPage(page, info);
  // A fetch step's lists of links on this page, so its button can say how many it will fetch (D10).
  await syncLists(ctx()).catch(() => {});
  if (info.kind === 'confirm') await recordObservedSubmission(info);
  // Build: arriving on a page of the open flow opens it in the flow's editor.
  if (modeOf(data.settings) === 'build') await arriveInBuild(ctx()).catch(() => {});
  await syncPages();
  render();
  // Build never clips into the open case (D19).
  if (modeOf(data.settings) !== 'casework') return;
  // Auto-clip (Settings): a recognised page not yet clipped into this case is clipped once it has loaded.
  // Tab events arrive in bursts, so the source being clipped is remembered until the case has reloaded.
  const c = data.case;
  const source = info.kind === 'source' ? `${info.profile.id}|${page.url}` : null;
  if (c && data.settings?.autoClip && source && page.loaded && ui.autoClipping !== source && !c.clips.some((x) => x.source === source)) {
    ui.autoClipping = source;
    try {
      // A page that fetches its data after it loads: its step says how long to wait. Still on it after
      // the wait, and not clipped meanwhile, it's clipped.
      const still = () => ui.page?.id === page.id && ui.page?.url === page.url && ui.info?.profile?.id === info.profile.id
        && data.case && data.case.id === c.id && !data.case.clips.some((x) => x.source === source);
      const wait = autoClipDelay(activeLib(), info.profile.id);
      if (wait) {
        announce(`Clipping ${info.profile.name} in ${wait / 1000} s, once its data has loaded`);
        await new Promise((r) => setTimeout(r, wait));
        if (!still()) return;
      }
      // Auto-clip shows what it is about to read: the values are outlined (asked again after a wait, so they
      // are on what is there now), then gathered, about half a second from the page being recognised (D3).
      await outlineFirst(ctx(), valuesWanted(ctx()), { again: !!wait });
      if (!still()) return;
      await act.clip(info.profile, { auto: true });
    } finally { ui.autoClipping = null; }
  }
}

/**
 * The case reference from the case the caseworker opened (a flow's "Choose a case" step): set once, while the
 * case has none, on an address the site rules let Power Loader read, in the case's own window. A different
 * case's page only warns. After Change, the same page doesn't set it again until the tab moves on.
 */
async function caseRefFromPage(page, info) {
  info.otherRef = null;
  const c = data.case;
  if (!c || !page || !isWebPage(page.url)) return;
  const got = refOnArrival({ c, lib: data.caseLib, url: page.url, windowId: ui.windowId, canRead: !info.blocked?.read && info.kind !== 'blocked' });
  if (!got) return;
  if (got.kind === 'other') { info.otherRef = got.ref; return; }
  if (ui.refDeclined === page.url) return;
  await act.update((cs) => { if (!cs.ref) setCaseRef(cs, got.ref, { from: 'address', step: got.step }); }, `Case reference set to ${got.ref}, from the case you opened`);
}

// A library confirmation profile matched the page and its reference: the submission is observed, not reported.
async function recordObservedSubmission(info) {
  const c = data.case;
  if (!c || !c.forms.some((f) => f.id === info.formId) || c.submitted[info.formId]?.how === 'observed') return;
  await act.update((cs, lib) => {
    markSubmitted(cs, info.formId, { how: 'observed', ref: info.confirmation.ref });
    logEvent(cs, 'submit_form', { page: pageLogInfo(lib, { url: ui.page.url, formId: info.formId, confirm: true }), detail: `${info.formId} · observed` });
  }, `${data.caseLib?.forms[info.formId]?.name || 'Form'} submitted`);
}

// ------------------------------------------------------------------ actions used by the views

export const act = {
  render: () => render(),
  refresh: () => refreshPage(),
  setTab(tab) { ui.tab = tab; render(); syncPages().then(render); },
  // Change mode. A case stays open in both; Build never clips into it.
  async setMode(mode, { tab = null } = {}) {
    const want = mode === 'build' ? 'build' : 'casework';
    data.settings = { ...(data.settings || {}), mode: want };
    ui.tab = tab || MODES[want][0];
    render();
    await saveSettings({ mode: want }).catch(() => {});
    announce(want === 'build' ? 'Build: making and mending flows' : 'Casework: working a case');
    await refreshPage();
  },
  // Build → Casework with a case of this flow: the only way from Build to a case.
  async tryFlow(flow, { libraryPath = null } = {}) {
    if (data.case) { announce('Power Loader works on one case at a time. Finish or discard the open case first, in Casework.'); return; }
    await act.setMode('casework');
    await startFromFlow(ctx(), flow, { libraryPath });
  },
  // Casework → Build at this step's page of the case's flow: a library's flow is copied to this computer first.
  fixInBuild: (stepId, opts) => fixInBuild(ctx(), stepId, opts),
  // The open case takes the changed flow, only when the caseworker asks (D17).
  async useChangedFlow(flowId) {
    if (!data.case) return;
    try {
      await updateCaseFlow(data.case.id, flowId);
      announce('This case now uses the changed flow. Its clips, decisions and steps done are kept.');
    } catch (e) { announce(describeError(e)); }
    await load();
    await refreshPage();
  },
  // Run a change against the active case; a case that ended meanwhile is reported, not resurrected.
  async update(fn, done) {
    if (!data.case) { announce('Start a case first: choose a flow on the Case tab and press Start.'); return null; }
    try {
      const out = await updateCase(data.case.id, fn);
      if (done) announce(typeof done === 'function' ? done(out) : done);
      return out;
    } catch (e) {
      // A full disk leaves the case as it was: each commit is all or nothing. Say so, and stop editing.
      if (/quota|storage is full|disk/i.test(e?.message || '') || e?.name === 'QuotaExceededError') ui.readOnly = true;
      announce(e instanceof CaseEnded || e.name === 'CaseEnded' ? 'That case has ended, so the change was dropped' : describeError(e));
      return null;
    } finally {
      await load();
      render();
    }
  },
  async startFlow(flowId, { libraryPath = null, flow = null } = {}) {
    try {
      const page = ui.info?.profile ? pageLogInfo(data.lib, { url: ui.page.url, profile: ui.info.profile }) : undefined;
      // A flow that chooses the case takes its reference from the case opened; any flow's can be typed under its card.
      const ref = ui.start.flowRef?.[flow?.id || flowId] || '';
      const c = await startFlowCase(flowId, { ref, page, windowId: ui.windowId, libraryPath });
      ui.start = { search: '', flowRef: {} };
      Object.assign(ui.view, { formFilter: null, fieldFilter: 'all', expanded: null, clipOpen: null });
      ui.tab = 'case';
      announce(`Case started from the flow ${c.library.flow.name || ''}`.trim());
    } catch (e) { announce(describeError(e)); }
    await load();
    await refreshPage();
  },
  // A flow's star: a library flow by its path, a flow on this computer by its id.
  async star(flowKey) {
    const on = await toggleStar(flowKey);
    announce(on ? 'Starred' : 'Unstarred');
    await load();
    render();
  },
  /**
   * Something the caseworker started was blocked by the site rules: logged once per page and action, with
   * the action and the layer only. Without a case it is counted for diagnostics.
   */
  async blocked(action, rule) {
    const key = `${ui.page?.id}|${ui.page?.url}|${action}`;
    if (ui.lastBlocked === key) return;
    ui.lastBlocked = key;
    if (data.case) await updateCase(data.case.id, (c) => { logBlocked(c, { action, layer: rule?.layer }); }).catch(() => {});
    else void recordFailure(`blocked-${action}`);
  },
  async clip(profile, { auto = false } = {}) {
    if (!data.case) { announce('Start a case first: choose a flow on the Case tab and press Start. Clips go into the open case.'); return; }
    if (ui.busy) return;
    ui.busy = 'clip';
    const url = ui.page.url;
    const source = `${profile.id}|${url}`;
    const had = data.case.clips.find((x) => x.source === source)?.capturedAt;
    // The rows wait for their values to arrive from the page.
    gatherUi.flying = { source, landed: new Set() };
    render();
    try {
      const summary = await clipTab(data.case.id, ui.page, profile, { auto });
      ui.lastClip = { url: ui.page.url, summary };
      const n = summary.conflicts.length;
      const how = auto ? 'Clipped automatically' : 'Clipped';
      announce(summary.identity.length ? `${how}. This may be a different person: check before anything else.`
        : n ? `${how}. ${plural(n, 'conflict')} found` : `${how}: ${profile.name}`);
      ui.lastClip.auto = auto;
    } catch (e) {
      if (e.name === 'Blocked') await act.blocked(e.action, e.rule);
      announce(e.name === 'CaseEnded' ? 'That case has ended, so the clip was dropped' : `Couldn’t clip: ${describeError(e)}`);
    } finally {
      ui.busy = null;
      await load();
      render();
    }
    // The values travel from the page to their rows, if the tab is still on that page and the Case tab shows.
    // It is never the clip's failure: the rows simply have their values.
    try {
      const got = data.case?.clips.find((x) => x.source === source);
      if (got && got.capturedAt !== had && ui.page?.url === url && ui.tab === 'case') await gather(ctx(), profile, source);
    } catch { /* the rows have their values */ } finally {
      gatherUi.flying = null;
      // The page shows its values as read from here on.
      if (ui.page?.url === url) gatherUi.shown = '';
      render();
    }
  },
  // A source on a conflict card: its page, in this tab, with the value held in view (sidebar/gather-ui.js).
  followSource: (follow) => followSource(ctx(), { ...follow, from: ui.page?.url || null }),
  // What a fetch step read from a page: the fetched view, on the full case page.
  openFetched: (clipId, field = null) => act.openPage('case', { view: 'fetched', clip: clipId, ...(field ? { field } : {}) }),
  removeClip: (clipId, preset) => openRemoveClip(ctx(), clipId, preset),
  finish: () => openFinish(ctx()),
  discard: () => openDiscard(ctx()),
  async requestAccess() {
    // permissions.request must run in the click handler itself (user gesture).
    const origin = (() => { try { const u = new URL(ui.page.url); return `${u.protocol}//${u.hostname}/*`; } catch { return null; } })();
    if (!origin) return;
    // Never ask Firefox for a site the rules block entirely.
    if (originVerdict(data.access, origin) === 'blocked') { announce('Power Loader doesn’t work on this site: the site rules block it'); return; }
    // An organisation build with fixed hosts can never be granted a site outside them.
    if (!canBeGranted(ui.page.url)) { announce(NOT_HERE); return; }
    if (await browser.permissions.request({ origins: [origin] })) await refreshPage();
  },
  // Go to a library address (a form, or the page a missing field is usually on) in the current tab. The one
  // place Power Loader opens addresses: one the site rules block isn't opened.
  openUrl: (url) => {
    // Going anywhere closes a step that was opened to look at: the open step is then the one for that page.
    ui.view.step = null;
    const v = allowed(data.access, url, 'navigate');
    if (!v.ok) {
      announce('Power Loader doesn’t open this address: the site rules block it. You can copy it and open it yourself.');
      return act.blocked('navigate', v.rule).then(() => false);
    }
    return browser.tabs.update(ui.page.id, { url }).then(() => true, (e) => { announce(describeError(e)); return false; });
  },
  describeForm: () => describeForm(ui.page.id),
  extractWithAI: () => extractWithAI(ctx()),
  openToolFull: (tool) => act.openPage('case', { view: tool }),
  // Full pages replace the sidebar; call from a click handler.
  openPage(kind, params = {}, focusKey = null) {
    const focus = focusKey || document.activeElement?.getAttribute('data-key') || null;
    openFullPage(kind, { tabId: ui.page?.id, windowId: ui.windowId, url: ui.page?.url, focus }, params);
  },
};

export const ctx = () => ({ ui, data, lib: activeLib(), act, renderFill: (f, o) => fillBlock(ctx(), f, o), extraSettings: (c) => aiSettingsCard(c), aiBusy: !!privacyUi.running });

// Pick mode on the page belongs to the flow editor, on the Flows tab in Build.
async function syncPages() {
  await syncFlowPicking(ctx()).catch(() => {});
  // A flow's notes on the page: the step's, filled from the case, or a preview of the page being edited.
  await syncNotes(ctx(), flowNotePreview(ctx())).catch(() => {});
}

// ------------------------------------------------------------------ rendering

// The two modes, always in the header: the border under it is blue in Casework and purple in Build.
function modeSwitch() {
  const mode = modeOf(data.settings);
  const b = (m, label) => h('button', { type: 'button', class: 'sm', 'data-key': `mode-${m}`, 'aria-pressed': String(mode === m), onclick: () => { if (mode !== m) act.setMode(m); } }, label);
  return h('span', { class: 'mode-switch', role: 'group', 'aria-label': 'Mode' }, b('casework', 'Casework'), b('build', 'Build'));
}

function header() {
  const c = data.case;
  const lib = data.caseLib;
  // No name here: Firefox's own sidebar header, directly above, already says Power Loader.
  return h('header', { class: `sb-head mode-${modeOf(data.settings)}` },
    modeSwitch(),
    h('span', { class: 'case-chip' }, c && lib
      ? [h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { class: 'sr' }, 'Active case: '), h('b', { title: caseLabel(c, lib) }, caseLabel(c, lib))]
      : [h('span', { class: 'dot off', 'aria-hidden': 'true' }), 'No active case']),
    c && lib ? h('button', { type: 'button', class: 'icon', 'data-key': 'open-full', 'aria-label': 'Open the case as a full page', title: 'Open the case as a full page', onclick: () => act.openPage('case') }, '⤢') : null);
}

function footer() {
  const c = data.case;
  if (!c || !data.caseLib || ui.tab === 'settings' || modeOf(data.settings) !== 'casework') return null;
  const onForm = ['form', 'confirm'].includes(ui.info?.kind) && c.forms.some((f) => f.id === ui.info.formId);
  const allSubmitted = c.forms.every((f) => c.submitted[f.id]);
  return h('footer', { class: 'sb-foot' },
    h('span', { class: 'grow small muted' }, `Stored only in this browser · ${plural(c.clips.length, 'clip')}`),
    h('button', { type: 'button', class: 'sm', 'data-key': 'discard', onclick: () => act.discard() }, 'Discard'),
    h('button', { type: 'button', class: onForm || allSubmitted ? 'primary' : '', 'data-key': 'finish', onclick: () => act.finish() }, 'Finish case'));
}

// A full page replaces the sidebar: if someone reopens the sidebar over it, point there instead of repeating it.
function fullPagePointer() {
  const kind = /\/(case|library|log|ready)\//.exec(ui.page?.url || '')?.[1];
  const title = { case: 'The case is open as a full page', library: 'The library is open', log: 'The activity log is open', ready: 'The readiness check is open' }[kind] || 'A Power Loader page is open in this tab';
  return h('div', { class: 'card' },
    h('h2', {}, title),
    h('p', { class: 'muted' }, 'Everything from the sidebar is on that page, so it isn’t repeated here.'),
    h('button', {
      type: 'button', class: 'primary', 'data-key': 'back-from-full', style: 'align-self:flex-start',
      onclick: async () => { const r = await returnToSidebar({ pageTabId: ui.page?.id }); if (!r.ok) announce(r.reason); },
    }, 'Back to the page you were on'));
}

function readOnlyBanner() {
  if (!ui.readOnly) return null;
  return h('div', { class: 'notice bad', role: 'alert' }, h('b', {}, 'This browser’s storage is full. '), 'The last change wasn’t saved, and the case is unchanged. Free some disk space, then try again, or finish the case.');
}

// A case left open beyond the policy idle time asks whether it is still the one being worked on.
function idleCard() {
  const c = data.case;
  const minutes = data.policy?.values?.workstation?.idleConfirmMinutes;
  const last = c?.touchedAt || c?.createdAt;
  if (!c || !minutes || ui.idleConfirmed === c.id || Date.now() - Date.parse(last) < minutes * 60000) return null;
  return h('div', { class: 'notice warn', role: 'alert' },
    h('p', {}, h('b', {}, 'This case has been open with nothing done since '), new Date(last).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }), '. Is it still the case you’re working on?'),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'sm primary', 'data-key': 'idle-ok', onclick: () => { ui.idleConfirmed = c.id; act.update(() => {}, 'Carrying on with this case'); } }, 'Yes, carry on'),
      h('button', { type: 'button', class: 'sm', 'data-key': 'idle-discard', onclick: () => act.discard() }, 'No, discard it')));
}


function render() {
  const app = document.getElementById('app');
  const c = data.case;
  const n = c && data.caseLib ? conflictKeys(c, data.caseLib).length : 0;
  const mode = modeOf(data.settings);
  const labels = { case: 'Case', tools: 'Tools', privacy: 'Privacy', settings: 'Settings', flows: 'Flows', templates: 'Templates' };
  const tabs = MODES[mode].map((key) => ({ key, label: labels[key], ...(key === 'case' && n ? { badge: String(n) } : {}) }));
  if (!MODES[mode].includes(ui.tab)) ui.tab = MODES[mode][0];
  let panel;
  if (ui.info?.kind === 'fullpage' && ui.tab !== 'settings') panel = fullPagePointer();
  else if (ui.tab === 'settings') panel = renderSettings(ctx());
  else if (ui.tab === 'privacy') panel = renderPrivacy(ctx());
  else if (ui.tab === 'flows') panel = renderFlows(ctx());
  else if (ui.tab === 'templates') panel = renderTemplates(ctx());
  else if (ui.tab === 'tools') panel = renderTools(ctx());
  else if (c && data.caseError) panel = [h('div', { class: 'notice bad' }, data.caseError), h('p', {}, 'You can still finish or discard this case.')];
  else if (c) panel = [readOnlyBanner(), expiryNotice(data, () => act.update((cs) => { logEvent(cs, 'keep_case'); }, 'Case kept: it isn’t deleted yet')), idleCard(), renderCaseTab(ctx())];
  else panel = renderStart(ctx());
  rerender(app,
    header(),
    closeNote(data),
    h('nav', { class: 'sb-tabs' }, tabList({ id: 'sb', label: 'Power Loader', tabs, selected: ui.tab, onSelect: (t) => act.setTab(t) })),
    h('main', { class: 'sb-body', 'data-scroll': 'body' }, tabPanel('sb', ui.tab, panel)),
    footer());
  // The values the open step's page gives, outlined on the page: asked for only when that changes.
  void syncValues(ctx(), modeOf(data.settings) === 'casework' ? valuesWanted(ctx()) : null);
}

// ------------------------------------------------------------------ wiring

// Teardown: drop every view that held case data, including unsaved typing.
function resetCaseViews() {
  resetTools();
  cancelRunning();
  cancelScans();
  cancelFetches();
  drafts.clear();
  ui.lastClip = null;
  ui.start = { search: '', flowRef: {} };
  Object.assign(ui.view, { formFilter: null, fieldFilter: 'all', expanded: null, clipOpen: null, step: null });
}

async function init() {
  ui.windowId = (await browser.windows.getCurrent()).id;
  browser.tabs.onActivated.addListener(({ windowId }) => windowId === ui.windowId && refreshPage());
  browser.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (tab.windowId === ui.windowId && tab.active && (change.status === 'complete' || change.url)) refreshPage();
  });
  browser.permissions.onAdded.addListener(() => refreshPage());
  // Capture asked for from the page's right-click menu or the keyboard command (background.js).
  browser.storage.onChanged.addListener((changes, area) => { if (area === 'session' && changes.pendingRegion?.newValue) void startPendingRegion(ctx()); });
  browser.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    if (!['case', 'teardown', 'receipt', 'starred', 'library', 'flows', 'settings', 'cases', 'processLog'].some((k) => k in changes)) return;
    // The case ended here or elsewhere (a context never receives its own CASE_ENDED message).
    if ('case' in changes && changes.case.oldValue && !changes.case.newValue) resetCaseViews();
    // The site rules decide what this page is to Power Loader, so a change to them works the page out again.
    const rulesChanged = 'settings' in changes && JSON.stringify(changes.settings.oldValue?.siteAccess) !== JSON.stringify(changes.settings.newValue?.siteAccess);
    const modeChanged = 'settings' in changes && changes.settings.oldValue?.mode !== changes.settings.newValue?.mode;
    const libraryChanged = rulesChanged || modeChanged || 'library' in changes || ('case' in changes && !changes.case.newValue !== !changes.case.oldValue);
    await load();
    if (libraryChanged) await refreshPage();
    else { await syncPages(); render(); }
  });
  browser.runtime.onMessage.addListener((msg, sender) => {
    if (msg?.type === CASE_ENDED) resetCaseViews();
    if (msg?.type === 'powerloader:picked') onFlowPicked(ctx(), msg, sender);
    if (msg?.type === 'powerloader:dragPick') onFlowDragPick(msg, sender);
    return undefined;
  });
  // A pasted screenshot goes to the reader when it's open.
  document.addEventListener('paste', (e) => {
    if (ui.tab === 'tools' && tools.tab === 'reader') onPaste(ctx(), e);
    else if (ui.tab === 'case') onStepPaste(ctx(), e);
  });
  await loadFlowEditing();
  installPresenter(ctx());
  watchModel(act);
  await load();
  // The first time the sidebar opens, it starts on Settings with what to set up.
  if (!data.settings?.welcomed) {
    Object.assign(ui, { tab: 'settings', welcome: true });
    await saveSettings({ welcomed: new Date().toISOString() }).catch(() => {});
  }
  // Notes go when the sidebar closes: they belong to the case, and the sidebar is what keeps them current.
  window.addEventListener('pagehide', () => { void clearNotes(); void clearValues(ui.page?.id); });
  guardClose(() => data);
  watchExpiry(() => { if (data.case) render(); });
  await refreshPage();
  await focusOnReturn();
  await startPendingRegion(ctx()).catch(() => {});
  // Keep the library fresh: a sync is cheap and falls back to the last good copy. It also syncs by itself
  // (background.js), so not again within five minutes.
  const last = data.library?.lastSync?.at;
  if (data.libraryCfg?.baseUrl && (!last || Date.now() - Date.parse(last) > 300_000)) {
    const origin = (() => { try { return libraryOriginOf(data.libraryCfg.baseUrl); } catch { return null; } })();
    if (origin && await browser.permissions.contains({ origins: [origin] }).catch(() => false)) syncLibrary({ auto: true }).catch(() => {});
  }
}

// Back from a full page: focus the control that opened it.
async function focusOnReturn() {
  // From the fetched view: Open the page (hold the value it was opened for, once the page is recognised) or Fetch again.
  const { follow, fetchAgain } = await browser.storage.session.get(['follow', 'fetchAgain']).catch(() => ({}));
  if (follow || fetchAgain) await browser.storage.session.remove(['follow', 'fetchAgain']).catch(() => {});
  if (follow && data.case) { gatherUi.follow = { ...follow, from: null }; gatherUi.shown = ''; render(); }
  if (fetchAgain && data.case) { ui.view.step = fetchAgain; render(); await runAgain(ctx(), fetchAgain); }
  const { returnFocus } = await browser.storage.session.get('returnFocus').catch(() => ({}));
  if (!returnFocus) return;
  await browser.storage.session.remove('returnFocus').catch(() => {});
  document.querySelector(`[data-key="${CSS.escape(returnFocus)}"]`)?.focus();
}

init();

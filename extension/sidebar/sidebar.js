// The Power Loader sidebar: start a case from library forms, clip pages, decide conflicts, finish.
/* global browser */
import '../lib/extract.js';
import { h, rerender, announce, describeError, plural, drafts } from '../ui/dom.js';
import { tabList, tabPanel } from '../ui/tabs.js';
import {
  CaseEnded, caseLibrary, clipTab, confirmationFor, describeForm, hasPageAccess, libraryAt, pageLogInfo, pageTextOf,
  profilesForTab, startCase, startFlowCase, toggleStar, updateCase,
} from '../lib/core.js';
import { CASE_ENDED } from '../lib/teardown.js';
import { caseLabel, conflictKeys, markSubmitted } from '../lib/case.js';
import { logEvent } from '../lib/activity.js';
import { renderStart } from './start.js';
import { renderCaseTab } from './caseview.js';
import { renderSettings } from './settings.js';
import { libraryConfig, libraryOrigin as libraryOriginOf, syncLibrary } from '../lib/library-sync.js';
import { openFullPage, returnToSidebar } from '../lib/pages.js';
import { openRemoveClip, openFinish, openDiscard } from './case-dialogs.js';
import { fillBlock } from './fill-ui.js';
import { cancelRunning, extractWithAI, installPresenter, mapFormWithAI, privacyUi, renderPrivacy, watchModel } from './privacy.js';
import { aiSettingsCard } from './ai-settings.js';
import { renderTools, resetTools, tools } from './tools/tools.js';
import { onPaste } from './tools/reader-ui.js';
import { cancelScans } from '../lib/privacy-client.js';
import { getPolicy } from '../lib/policy.js';
import { saveSettings } from '../lib/ai/settings.js';
import { fillProfileForCase } from '../lib/fill.js';
import { editorCard, loadEditing, onDragPick, onPicked, openProfileStart, startFillDraft, startNewVersion, syncPicking } from './draft-editor.js';
import { flowPicking, loadFlowEditing, onFlowPicked, renderFlows, syncFlowPicking } from './flows.js';

const E = globalThis.PowerLoaderExtract;
const isWebPage = (url) => /^https?:/.test(url || '');

export const ui = {
  tab: 'case',
  windowId: null,
  page: null, // { id, url, title }
  info: null, // what the current page is to the case: { kind, access, profile?, formId?, fillProfile?, confirmation? }
  start: { select: new Set(), search: '', cat: 'All', ref: '' },
  view: { formFilter: null, fieldFilter: 'all', expanded: null, clipOpen: null },
  lastClip: null, // { url, summary }
  busy: null,
  autoClipping: null, // the source auto-clip is working on, so a burst of tab events clips it once
};
// Tab events can arrive while the first storage snapshot is still loading.
let data = { drafts: [], flows: [], starred: [] };

async function load() {
  const s = await browser.storage.local.get(['case', 'teardown', 'receipt', 'starred', 'library', 'profileDrafts', 'flows', 'settings', 'cases', 'profiles', 'processLog']);
  const c = s.case && !s.teardown ? s.case : null;
  let caseLib = null;
  let caseError = null;
  if (c) {
    try { caseLib = caseLibrary(s.library, c); } catch (e) { caseError = describeError(e); }
  }
  const libraryCfg = await libraryConfig().catch(() => ({}));
  const policy = await getPolicy().catch(() => ({ values: {}, locked: new Set() }));
  data = {
    ...s, case: c, caseLib, caseError, drafts: s.profileDrafts || [], flows: s.flows || [], starred: s.starred || [], libraryCfg, libraryForm: data.libraryForm, policy, aiForm: data.aiForm, aiStatus: data.aiStatus,
    lib: s.library ? libraryAt(s.library, s.library.current) : null,
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
    info.access = await hasPageAccess(page.url).catch(() => false);
    if (info.access && lib) {
      try {
        const [profile] = await profilesForTab(page.id, page.url, lib, data.drafts);
        // Fill profiles, with a tested fill draft in use replacing the library's one for its form.
        const fillProfiles = Object.keys(lib.forms).map((id) => fillProfileForCase(lib, id, data.drafts)).filter(Boolean);
        const fill = fillProfiles.filter((p) => E.matchUrl(p.match, page.url));
        const formFill = fill.length ? (await profilesForTab(page.id, page.url, { profiles: fill }, []))[0] : null;
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
  if (moved) ui.lastClip = null;
  if (info.kind === 'confirm') await recordObservedSubmission(info);
  await syncPages();
  render();
  // Auto-clip (Settings): a recognised page not yet clipped into this case is clipped once it has loaded.
  // Tab events arrive in bursts, so the source being clipped is remembered until the case has reloaded.
  const c = data.case;
  const source = info.kind === 'source' ? `${info.profile.id}|${page.url}` : null;
  if (c && data.settings?.autoClip && source && page.loaded && ui.autoClipping !== source && !c.clips.some((x) => x.source === source)) {
    ui.autoClipping = source;
    try { await act.clip(info.profile, { auto: true }); } finally { ui.autoClipping = null; }
  }
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
  // Run a change against the active case; a case that ended meanwhile is reported, not resurrected.
  async update(fn, done) {
    if (!data.case) { announce('Start a case first: choose a form or a flow on the Case tab and press Start.'); return null; }
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
  async start(formIds) {
    try {
      const page = ui.info?.profile ? pageLogInfo(data.lib, { url: ui.page.url, profile: ui.info.profile }) : undefined;
      await startCase(formIds, { ref: ui.start.ref, page, windowId: ui.windowId });
      ui.start = { select: new Set(), search: '', cat: 'All', ref: '' };
      Object.assign(ui.view, { formFilter: null, fieldFilter: 'all', expanded: null, clipOpen: null });
      const lib = data.lib;
      announce(formIds.length === 1 ? `Case started for ${lib.forms[formIds[0]].name}` : `Case started with ${plural(formIds.length, 'form')}`);
    } catch (e) { announce(describeError(e)); }
    await load();
    await refreshPage();
  },
  async startFlow(flowId) {
    try {
      const page = ui.info?.profile ? pageLogInfo(data.lib, { url: ui.page.url, profile: ui.info.profile }) : undefined;
      const c = await startFlowCase(flowId, { ref: ui.start.ref, page, windowId: ui.windowId });
      ui.start = { select: new Set(), search: '', cat: 'All', ref: '' };
      Object.assign(ui.view, { formFilter: null, fieldFilter: 'all', expanded: null, clipOpen: null });
      ui.tab = 'case';
      announce(`Case started from the flow ${c.library.flow.name || ''}`.trim());
    } catch (e) { announce(describeError(e)); }
    await load();
    await refreshPage();
  },
  async star(formId) {
    const on = await toggleStar(formId);
    announce(on ? 'Starred' : 'Unstarred');
    await load();
    render();
  },
  async clip(profile, { auto = false } = {}) {
    if (!data.case) { announce('Start a case first: choose a form or a flow on the Case tab and press Start. Clips go into the open case.'); return; }
    if (ui.busy) return;
    ui.busy = 'clip';
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
      announce(e.name === 'CaseEnded' ? 'That case has ended, so the clip was dropped' : `Couldn’t clip: ${describeError(e)}`);
    } finally {
      ui.busy = null;
      await load();
      render();
    }
  },
  removeClip: (clipId, preset) => openRemoveClip(ctx(), clipId, preset),
  finish: () => openFinish(ctx()),
  discard: () => openDiscard(ctx()),
  async requestAccess() {
    // permissions.request must run in the click handler itself (user gesture).
    const origin = (() => { try { const u = new URL(ui.page.url); return `${u.protocol}//${u.hostname}/*`; } catch { return null; } })();
    if (!origin) return;
    if (await browser.permissions.request({ origins: [origin] })) await refreshPage();
  },
  // Go to a library address (a form, or the page a missing field is usually on) in the current tab.
  openUrl: (url) => browser.tabs.update(ui.page.id, { url }).catch((e) => announce(describeError(e))),
  describeForm: () => describeForm(ui.page.id),
  makeProfile: () => openProfileStart(ctx()),
  updateProfile: (profile) => startNewVersion(ctx(), profile),
  extractWithAI: () => extractWithAI(ctx()),
  mapFormWithAI: (form) => mapFormWithAI(ctx(), form),
  makeFillProfile: (form) => startFillDraft(ctx(), form),
  openToolFull: (tool) => act.openPage('case', { view: tool }),
  // Full pages replace the sidebar; call from a click handler.
  openPage(kind, params = {}, focusKey = null) {
    const focus = focusKey || document.activeElement?.getAttribute('data-key') || null;
    openFullPage(kind, { tabId: ui.page?.id, windowId: ui.windowId, url: ui.page?.url, focus }, params);
  },
};

export const ctx = () => ({ ui, data, lib: activeLib(), act, renderFill: (f) => fillBlock(ctx(), f), extraSettings: (c) => aiSettingsCard(c), aiBusy: !!privacyUi.running });

// Pick mode on the page belongs to the draft editor or, on the Flows tab, to the flow editor: stop one first.
async function syncPages() {
  await syncPicking(ctx()).catch(() => {});
  await syncFlowPicking(ctx()).catch(() => {});
}

// ------------------------------------------------------------------ rendering

function header() {
  const c = data.case;
  const lib = data.caseLib;
  return h('header', { class: 'sb-head' },
    h('span', { class: 'brand' }, h('img', { src: '../icons/icon.svg', alt: '' }), 'Power Loader'),
    h('span', { class: 'case-chip' }, c && lib
      ? [h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { class: 'sr' }, 'Active case: '), h('b', { title: caseLabel(c, lib) }, caseLabel(c, lib))]
      : [h('span', { class: 'dot off', 'aria-hidden': 'true' }), 'No active case']),
    c && lib ? h('button', { type: 'button', class: 'icon', 'data-key': 'open-full', 'aria-label': 'Open the case as a full page', title: 'Open the case as a full page', onclick: () => act.openPage('case') }, '⤢') : null);
}

function footer() {
  const c = data.case;
  if (!c || !data.caseLib || ui.tab === 'settings') return null;
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
  const tabs = [
    { key: 'case', label: 'Case', badge: n ? String(n) : null },
    { key: 'tools', label: 'Tools' },
    { key: 'privacy', label: 'Privacy' },
    { key: 'flows', label: 'Flows' },
    { key: 'settings', label: 'Settings' },
  ];
  let panel;
  if (ui.info?.kind === 'fullpage' && ui.tab !== 'settings') panel = fullPagePointer();
  else if (ui.tab === 'settings') panel = renderSettings(ctx());
  else if (ui.tab === 'privacy') panel = renderPrivacy(ctx());
  else if (ui.tab === 'flows') panel = renderFlows(ctx());
  else if (ui.tab === 'tools') panel = renderTools(ctx());
  else if (c && data.caseError) panel = [h('div', { class: 'notice bad' }, data.caseError), h('p', {}, 'You can still finish or discard this case.')];
  else if (c) panel = [readOnlyBanner(), idleCard(), editorCard(ctx()), renderCaseTab(ctx())];
  else panel = [editorCard(ctx()), renderStart(ctx())];
  rerender(app,
    header(),
    h('nav', { class: 'sb-tabs' }, tabList({ id: 'sb', label: 'Power Loader', tabs, selected: ui.tab, onSelect: (t) => act.setTab(t) })),
    h('main', { class: 'sb-body', 'data-scroll': 'body' }, tabPanel('sb', ui.tab, panel)),
    footer());
}

// ------------------------------------------------------------------ wiring

// Teardown: drop every view that held case data, including unsaved typing.
function resetCaseViews() {
  resetTools();
  cancelRunning();
  cancelScans();
  drafts.clear();
  ui.lastClip = null;
  ui.start = { select: new Set(), search: '', cat: 'All', ref: '' };
  Object.assign(ui.view, { formFilter: null, fieldFilter: 'all', expanded: null, clipOpen: null });
}

async function init() {
  ui.windowId = (await browser.windows.getCurrent()).id;
  browser.tabs.onActivated.addListener(({ windowId }) => windowId === ui.windowId && refreshPage());
  browser.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (tab.windowId === ui.windowId && tab.active && (change.status === 'complete' || change.url)) refreshPage();
  });
  browser.permissions.onAdded.addListener(() => refreshPage());
  browser.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    if (!['case', 'teardown', 'receipt', 'starred', 'library', 'profileDrafts', 'flows', 'settings', 'cases', 'processLog'].some((k) => k in changes)) return;
    // The case ended here or elsewhere (a context never receives its own CASE_ENDED message).
    if ('case' in changes && changes.case.oldValue && !changes.case.newValue) resetCaseViews();
    const libraryChanged = 'library' in changes || 'profileDrafts' in changes || ('case' in changes && !changes.case.newValue !== !changes.case.oldValue);
    await load();
    if (libraryChanged) await refreshPage();
    else { await syncPages(); render(); }
  });
  browser.runtime.onMessage.addListener((msg, sender) => {
    if (msg?.type === CASE_ENDED) resetCaseViews();
    if (msg?.type === 'powerloader:picked') { if (flowPicking()) onFlowPicked(ctx(), msg, sender); else onPicked(ctx(), msg, sender); }
    if (msg?.type === 'powerloader:dragPick') onDragPick(msg, sender);
    return undefined;
  });
  // A pasted screenshot goes to the reader when it's open.
  document.addEventListener('paste', (e) => { if (ui.tab === 'tools' && tools.tab === 'reader') onPaste(ctx(), e); });
  await loadEditing();
  await loadFlowEditing();
  installPresenter(ctx());
  watchModel(act);
  await load();
  // The first time the sidebar opens, it starts on Settings with what to set up.
  if (!data.settings?.welcomed) {
    Object.assign(ui, { tab: 'settings', welcome: true });
    await saveSettings({ welcomed: new Date().toISOString() }).catch(() => {});
  }
  await refreshPage();
  await focusOnReturn();
  // Keep the library fresh: a sync is cheap and falls back to the last good copy.
  const last = data.library?.lastSync?.at;
  if (data.libraryCfg?.baseUrl && (!last || Date.now() - Date.parse(last) > 3600_000)) {
    const origin = (() => { try { return libraryOriginOf(data.libraryCfg.baseUrl); } catch { return null; } })();
    if (origin && await browser.permissions.contains({ origins: [origin] }).catch(() => false)) syncLibrary().catch(() => {});
  }
}

// Back from a full page: focus the control that opened it.
async function focusOnReturn() {
  const { returnFocus } = await browser.storage.session.get('returnFocus').catch(() => ({}));
  if (!returnFocus) return;
  await browser.storage.session.remove('returnFocus').catch(() => {});
  document.querySelector(`[data-key="${CSS.escape(returnFocus)}"]`)?.focus();
}

init();

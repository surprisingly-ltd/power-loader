// Shared logic for the extension pages and the background script: the library, page access and the
// one active case. Every case write goes through lib/storage.js.
/* global browser */
import { assertTool } from './tools.js';
import { mutateStorage } from './storage.js';
import { indexLibrary, pageProfiles, fillProfileFor, confirmationFor } from './library.js';
import { addClip, clipFromExtract, newCase } from './case.js';
import { logEvent } from './activity.js';
import { flowSet, isFlowCommit, libraryFlow, startable } from './flows.js';
import { contentHash } from './hash.js';
import { Blocked, PAGE_ACTIONS, accessLayers, allowed, originVerdict } from './access.js';
import { getPolicy } from './policy.js';
import { abortInPage, fetchInPage } from './fetch-steps.js';

export { getSettings, saveSettings } from './ai/settings.js';

// ------------------------------------------------------------------ library

// Indexing is pure and a stored set never changes, so each commit is indexed once.
const indexed = new Map();
export function libraryAt(state, commit) {
  const set = state?.sets?.[commit];
  if (!set) return null;
  if (!indexed.has(commit)) indexed.set(commit, indexLibrary(set));
  return indexed.get(commit);
}

export async function getLibraryState() {
  return (await browser.storage.local.get('library')).library || null;
}

// The current library, or null before the first sync.
export async function getLibrary() {
  const state = await getLibraryState();
  return state ? libraryAt(state, state.current) : null;
}

// The library version a case started with. It keeps using it until it ends, or is updated explicitly.
export function caseLibrary(state, c) {
  const lib = c && libraryAt(state, c.library.commit);
  if (c && !lib) throw new Error('The library version this case started with is no longer on this computer');
  return lib;
}

export async function getStarred() {
  return (await browser.storage.local.get('starred')).starred || [];
}

// Stars are on flows: a library's flow by its path (flows/…), a flow on this computer by its id.
export async function toggleStar(flowKey) {
  return mutateStorage(({ starred = [] }) => {
    const next = starred.includes(flowKey) ? starred.filter((x) => x !== flowKey) : [...starred, flowKey];
    return { patch: { starred: next }, result: next.includes(flowKey) };
  }, ['starred']);
}

// Stars whose flow has gone: dropped when the list of flows is drawn.
export async function dropStars(keep) {
  return mutateStorage(({ starred = [] }) => {
    const next = starred.filter((k) => keep.includes(k));
    return { patch: next.length === starred.length ? null : { starred: next }, result: next };
  }, ['starred']);
}

// ------------------------------------------------------------------ page access

export function originPattern(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    // Firefox match patterns have no port: "http://localhost:8787/*" is stored but never matches.
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

export async function hasPageAccess(url) {
  const origin = originPattern(url);
  if (!origin) return false;
  return browser.permissions.contains({ origins: [origin] });
}

// ------------------------------------------------------------------ site rules (lib/access.js)

/**
 * The site rules now: policy, the open case's pinned library and the synced one, and the caseworker's own,
 * read live so a change in Settings applies at the next action. withHosts adds the open case's approved
 * hosts (or, with no case, the synced library's) as the last layer.
 */
export async function currentAccess({ withHosts = false } = {}) {
  const [{ settings, library, case: c, teardown }, policy] = await Promise.all([
    browser.storage.local.get(['settings', 'library', 'case', 'teardown']), getPolicy().catch(() => null)]);
  const currentLib = library ? libraryAt(library, library.current) : null;
  let caseLib = null;
  if (c && !teardown) { try { caseLib = caseLibrary(library, c); } catch { caseLib = null; } }
  const hostsFrom = c && !teardown ? caseLib : currentLib;
  return accessLayers({ policy, settings, caseLib, currentLib, hosts: withHosts && hostsFrom ? hostsFrom.approvedHosts : undefined });
}

/** Throw Blocked unless the rules allow every one of these actions at this address. */
export function checkAccess(layers, url, actions) {
  for (const a of [actions].flat()) {
    const v = allowed(layers, url, a);
    if (!v.ok) throw new Blocked(a, v.rule);
  }
}

// What each message to the in-page agent does to the page. Messages not listed need no check (they scroll,
// stop a picker or take Power Loader's own marks away). A new message type is checked as a read until listed.
// Outlining what a template reads is part of reading the page (D1 of docs/plans/flow-steps-ux.md): the site
// rules' read covers it, not annotate, so it can't be turned off by blocking annotate. Listed only to say so.
export const MESSAGE_ACTIONS = {
  'powerloader:fill': ['fill'], 'powerloader:annotate': ['annotate'], 'powerloader:pickTarget': ['read', 'annotate'], 'powerloader:selectRegion': ['capture'],
  'powerloader:showValues': ['read'], 'powerloader:pointValue': ['read'], 'powerloader:gatherValues': ['read'],
  // A reveal rule only shows what is already being read (docs/plans/conflicts-and-fetch-views.md): a read. A team
  // that would rather it counted as annotate changes these two (and showValues, which applies the rules) here.
  'powerloader:revealBefore': ['read'], 'powerloader:revealAfter': ['read'],
  // A fetch step's box on its trigger page shows, as text, what the page's own site sent: drawn where reading is allowed.
  'powerloader:fetchBox': ['read'],
};
const UNCHECKED = new Set(['ping', 'scroll', 'scrollTo', 'clearPII', 'focusPII', 'pickStop', 'overrideStop', 'cancelRegion', 'clearNotes', 'clearValues'].map((t) => `powerloader:${t}`));
export const messageActions = (type) => (UNCHECKED.has(type) ? [] : MESSAGE_ACTIONS[type] || ['read']);

// Make sure the in-page agent (lib/agent.js) is listening in the tab, injecting it if not. It is never
// injected into a page where the site rules block everything it does.
async function ensureAgent(tabId, url, layers) {
  try {
    if (await browser.tabs.sendMessage(tabId, { type: 'powerloader:ping' }, { frameId: 0 })) return;
  } catch {
    // no agent yet
  }
  const verdicts = PAGE_ACTIONS.map((a) => allowed(layers, url, a));
  if (verdicts.every((v) => !v.ok)) throw new Blocked('read', verdicts[0].rule);
  await browser.scripting.executeScript({ target: { tabId }, files: ['/lib/extract.js', '/lib/capture.js', '/lib/agent.js', '/lib/gather.js'] });
}

/**
 * Every message to the in-page agent goes through here, from the sidebar and the background. The tab's
 * address is checked against the site rules for what the message does, and sent with it: the agent refuses
 * when the page has moved on since (atUrl), so a redirect or pushState between the check and the act fails safe.
 */
export async function ask(tabId, msg, { layers = null } = {}) {
  const tab = await browser.tabs.get(tabId);
  const rules = layers || await currentAccess();
  const actions = messageActions(msg?.type);
  if (actions.length) checkAccess(rules, tab.url, actions);
  await ensureAgent(tabId, tab.url, rules);
  return browser.tabs.sendMessage(tabId, actions.length ? { ...msg, atUrl: tab.url } : msg, { frameId: 0 });
}

/**
 * Remove host permissions for origins the rules block entirely, so Firefox's own panel matches them and
 * nothing can be injected there. Housekeeping, not the guard: every action is checked anyway. The library's
 * and the AI gateway's origins are Power Loader's own infrastructure and are kept.
 */
export async function pruneBlockedOrigins({ keep = [] } = {}) {
  const layers = await currentAccess();
  const { origins = [] } = await browser.permissions.getAll();
  const drop = origins.filter((o) => o !== '<all_urls>' && !keep.includes(o) && originVerdict(layers, o) === 'blocked');
  if (drop.length) await browser.permissions.remove({ origins: drop });
  return drop;
}

// The library's profiles that read this page, narrowed in-page by their `when` selectors.
export async function profilesForTab(tabId, url, lib) {
  const candidates = pageProfiles(lib, url);
  if (!candidates.length || !candidates.some((p) => p.when)) return candidates;
  const ok = await ask(tabId, { type: 'powerloader:applies', profiles: candidates });
  return candidates.filter((_, i) => ok[i]);
}

export const extractFromTab = (tabId, profile) => ask(tabId, { type: 'powerloader:extract', profile });
export const captureTab = (tabId) => ask(tabId, { type: 'powerloader:capture' });
export const describeForm = (tabId) => ask(tabId, { type: 'powerloader:describeForm' });
export const pageTextOf = (tabId) => ask(tabId, { type: 'powerloader:pageText' });

// ------------------------------------------------------------------ the active case

export class CaseEnded extends Error {
  constructor(message = 'That case has ended') { super(message); this.name = 'CaseEnded'; }
}

export async function getCase() {
  const { case: c, teardown } = await browser.storage.local.get(['case', 'teardown']);
  return c && !teardown ? c : null;
}

/**
 * Start a case from a flow, the only way a case starts: the flow, compiled to library files, is stored as a
 * set of its own and the case pins it, as a case pins a library commit. Works with or without a connected
 * library, which lends its privacy patterns. Every form the flow fills is a form of the case.
 */
export async function startFlowCase(flowId, { ref = '', page, windowId, libraryPath = null } = {}) {
  const { flows = [], library } = await browser.storage.local.get(['flows', 'library']);
  // A flow the connected library carries is opened as an import is, then started the same way.
  const flow = libraryPath ? libraryFlow(library ? libraryAt(library, library.current) : null, libraryPath) : flows.find((f) => f.id === flowId);
  if (!flow) throw new Error('That flow is no longer on this computer');
  const can = startable(flow);
  if (!can.ok) throw new Error(can.reason);
  const base = library ? libraryAt(library, library.current) : null;
  // The commit names the content: an unchanged flow gives the same set, a changed one a new set.
  const set = flowSet(flow, { hash: await contentHash(flowSet(flow, { hash: '', base, now: '' }).files), base });
  return mutateStorage(({ case: current, teardown, library: state }) => {
    if (teardown) throw new Error('The last case is still being deleted. Try again in a moment.');
    if (current) throw new Error('Finish or discard the current case first. Power Loader works on one case at a time.');
    const next = { sets: {}, ...(state || {}) };
    // Sets from flows are kept only while a case uses them.
    next.sets = Object.fromEntries(Object.entries(next.sets).filter(([commit]) => !isFlowCommit(commit)));
    next.sets[set.commit] = set;
    const lib = indexLibrary(set);
    // A flow with a list of links to fetch may have no form (an inbox triage): its case has none.
    const c = newCase(lib, Object.keys(lib.forms), { ref, noForms: can.noForms });
    c.library.flow = { id: flow.id, name: flow.name, ...(flow.fromLibrary ? { fromLibrary: flow.fromLibrary } : {}) };
    if (windowId != null) c.windowId = windowId;
    logEvent(c, 'start_case', { detail: `flow · ${c.forms.map((f) => `${f.id}@${f.version}`).join(' + ') || 'no form'}` });
    if (page) logEvent(c, 'visit_page', { page });
    return { patch: { library: next, case: c, receipt: null }, result: c };
  }, ['case', 'teardown', 'library', 'receipt']);
}

/**
 * The open case takes a flow that was changed since it started, when the caseworker asks (D17), never by
 * itself: the flow is compiled as startFlowCase() does, its set added, and the case points at it. The clips,
 * the decisions, the values typed and the reference stay. Steps marked done are kept by step id (a flow's
 * pages keep their ids when it is changed, and when a library's flow is copied); a step that no longer exists
 * drops out. A flow that no longer has a form the case has filled is refused. Logged as update_flow with the
 * flow's name, never its contents.
 */
export async function updateCaseFlow(caseId, flowId) {
  const { flows = [], library } = await browser.storage.local.get(['flows', 'library']);
  const flow = flows.find((f) => f.id === flowId);
  if (!flow) throw new Error('That flow is no longer on this computer');
  const can = startable(flow);
  if (!can.ok) throw new Error(can.reason);
  const base = library ? libraryAt(library, library.current) : null;
  const set = flowSet(flow, { hash: await contentHash(flowSet(flow, { hash: '', base, now: '' }).files), base });
  return mutateStorage(({ case: c, teardown, library: state }) => {
    if (!c || c.id !== caseId || teardown) throw new CaseEnded();
    const lib = indexLibrary(set);
    const lost = c.forms.filter((f) => (c.filled?.[f.id] || c.submitted?.[f.id]) && !lib.forms[f.id]);
    if (lost.length) throw new Error(`The changed flow no longer has ${lost.map((f) => f.id).join(', ')}, which this case has filled. Keep the flow the case started with, or start a new case.`);
    const next = { sets: {}, ...(state || {}) };
    next.sets = Object.fromEntries(Object.entries(next.sets).filter(([commit]) => !isFlowCommit(commit)));
    next.sets[set.commit] = set;
    c.library = { commit: set.commit, flow: { id: flow.id, name: flow.name } };
    c.forms = Object.values(lib.forms).map((f) => ({ id: f.id, version: f.version }));
    const ids = new Set((lib.steps || []).map((s) => s.id));
    c.steps = Object.fromEntries(Object.entries(c.steps || {}).filter(([id]) => ids.has(id)));
    logEvent(c, 'update_flow', { detail: flow.name || 'Flow' });
    return { patch: { library: next, case: c }, result: c };
  }, ['case', 'teardown', 'library']);
}

/**
 * The flow the open case could take instead of its own, changed on this computer since the case started: the
 * case's own flow, or the copy made from its library flow. null when there is none.
 */
export function changedFlowFor(c, flows = [], set = null) {
  const from = c?.library?.flow;
  if (!from) return null;
  const mine = from.fromLibrary ? flows.filter((f) => f.copiedFrom?.path === from.fromLibrary.path).sort((a, b) => String(b.updated).localeCompare(String(a.updated)))[0] : flows.find((f) => f.id === from.id);
  if (!mine) return null;
  const since = set?.syncedAt || c.createdAt;
  return String(mine.updated || '') > String(since || '') ? mine : null;
}

/**
 * Change the active case. fn(case, library) must be synchronous and replay-safe. It throws CaseEnded when
 * that case is no longer active, so results that arrive after Finish or Discard drop themselves.
 */
export async function updateCase(caseId, fn) {
  return mutateStorage(({ case: c, teardown, library }) => {
    if (!c || c.id !== caseId || teardown) throw new CaseEnded();
    const result = fn(c, caseLibrary(library, c));
    // For the idle check: a case left open too long asks for confirmation on return.
    c.touchedAt = new Date().toISOString();
    return { patch: { case: c }, result };
  }, ['case', 'teardown', 'library']);
}

// The page type and link pattern the log may keep for a page, from the case's library.
export function pageLogInfo(lib, { url, profile, formId, confirm }) {
  if (profile) return { type: `${profile.id}@${profile.version}${profile.draft ? '+draft' : ''}`, pattern: profile.urlPattern, url };
  if (formId) {
    const f = lib.forms[formId];
    const fp = fillProfileFor(lib, formId);
    return { type: `${confirm ? 'confirm' : 'form'}:${formId}@${f?.version || ''}`, pattern: confirm ? undefined : fp?.urlPattern, url };
  }
  return { type: '', url };
}

/**
 * Read a page with a profile and add it to the case. Returns the clip summary. The site rules and the case's
 * approved hosts are checked before reading, and again for the address the agent actually read.
 */
export async function clipTab(caseId, tab, profile, { auto = false } = {}) {
  const layers = await currentAccess({ withHosts: true });
  checkAccess(layers, (await browser.tabs.get(tab.id)).url, 'read');
  const res = await ask(tab.id, { type: 'powerloader:extract', profile }, { layers });
  checkAccess(layers, res.url, 'read');
  return updateCase(caseId, (c, lib) => {
    const clip = clipFromExtract(lib, profile, res);
    const summary = addClip(c, lib, clip);
    const n = Object.keys(clip.values).length + clip.records.length;
    logEvent(c, auto ? 'auto_clip_page' : 'clip_page', { page: pageLogInfo(lib, { url: res.url, profile }), detail: `${n} item${n === 1 ? '' : 's'}`, clip: summary.clipId });
    return summary;
  });
}

export { fillProfileFor, confirmationFor };

// ------------------------------------------------------------------ fetch steps (lib/fetch-steps.js)

/**
 * Which world of the trigger tab a fetch step's request is made from. 'ISOLATED' is the content script's
 * (way B of docs/plans/fetch-steps.md, preferred: page scripts can't touch it). If the Firefox suite shows a
 * content-script fetch doesn't carry the page's session in Firefox 140 ESR, change this to 'MAIN' (way C: the
 * packaged function runs as the page). Nothing else changes: the response is read in the extension either way.
 */
export const FETCH_WORLD = 'ISOLATED';

/**
 * Send one fetch step request from the trigger tab: the one place a request leaves the extension. The caller
 * (runFetchStep) has checked the address against the site rules; fetchInPage() checks again that the tab is
 * still at atUrl and on the address's site. signal stops the request in the tab too.
 */
export async function fetchFromTab(tabId, url, { signal, accept, timeoutMs, maxBytes, atUrl }) {
  const id = `f-${Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('')}`;
  const target = { tabId, frameIds: [0] };
  const onAbort = () => { browser.scripting.executeScript({ target, world: FETCH_WORLD, func: abortInPage, args: [id] }).catch(() => {}); };
  if (signal?.aborted) return { error: 'stopped' };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const [r] = await browser.scripting.executeScript({ target, world: FETCH_WORLD, func: fetchInPage, args: [{ url, atUrl, accept, timeoutMs, maxBytes, id }] });
    return r?.result ?? { error: 'network' };
  } catch {
    return { error: 'network' };
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Read a list request's links from the trigger tab, with the trigger page's own profile, as clipping reads a
 * page (the read check, in lib/core.js ask()). Nothing is clipped or kept: only each row's href is returned,
 * for planRun() to check. { url, hrefs } or null when the tab isn't that page (its match and its when).
 */
export async function readListFromTab(tabId, lib, request) {
  const p = lib.profiles.find((x) => x.id === request?.each?.profileId);
  if (!p) return null;
  const tab = await browser.tabs.get(tabId);
  if (!globalThis.PowerLoaderExtract.matchUrl(p.match, tab.url)) return null;
  if (p.when) {
    const [ok] = await ask(tabId, { type: 'powerloader:applies', profiles: [p] });
    if (!ok) return null;
  }
  const res = await ask(tabId, { type: 'powerloader:extract', profile: p });
  const rows = res?.data?.[request.each.list];
  return { url: res?.url || tab.url, hrefs: Array.isArray(rows) ? rows.map((r) => r?.href).filter((x) => typeof x === 'string') : [] };
}

// ------------------------------------------------------------------ flows (lib/flows.js)

export async function updateFlows(fn) {
  return mutateStorage(({ flows = [] }) => {
    const list = structuredClone(flows);
    const result = fn(list);
    return { patch: { flows: list }, result };
  }, ['flows']);
}

export const updateFlow = (id, fn) => updateFlows((list) => {
  const f = list.find((x) => x.id === id);
  if (!f) throw new Error('That flow is no longer on this computer');
  const out = fn(f);
  f.updated = new Date().toISOString();
  return out;
});

export const probeTab = (tabId, profile) => ask(tabId, { type: 'powerloader:probe', profile });
export const pageValues = (tabId) => ask(tabId, { type: 'powerloader:values' });
export const pageLabels = (tabId) => ask(tabId, { type: 'powerloader:labels' });
export const startPicking = (tabId, selected, fields = {}, mode = 'values') => ask(tabId, { type: 'powerloader:pickStart', selected, fields, mode });
export const showPicked = (tabId, selected, fields = {}, current = null) => ask(tabId, { type: 'powerloader:pickSelected', selected, fields, current });
// The override tool: resolves with the element the caseworker clicked, as a candidate, or null.
export const pickAnyElement = (tabId) => ask(tabId, { type: 'powerloader:overrideStart' });
// Notes a flow draws on a page, and choosing where one goes.
// Refused here, where notes are drawn, when the notes tool is off (lib/tools.js).
export const annotateTab = async (tabId, notes) => { await assertTool('notes'); return ask(tabId, { type: 'powerloader:annotate', notes }); };
export const clearTabNotes = (tabId) => ask(tabId, { type: 'powerloader:clearNotes' }).catch(() => {});
export const pickNoteTarget = (tabId) => ask(tabId, { type: 'powerloader:pickTarget' });
export const stopPickAny = (tabId) => ask(tabId, { type: 'powerloader:overrideStop' }).catch(() => {});
export const stopPicking = (tabId) => ask(tabId, { type: 'powerloader:pickStop' }).catch(() => {});

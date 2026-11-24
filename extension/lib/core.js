// Shared logic for the extension pages and the background script: the library, page access and the
// one active case. Every case write goes through lib/storage.js.
/* global browser */
import { mutateStorage } from './storage.js';
import { indexLibrary, pageProfiles, fillProfileFor, confirmationFor } from './library.js';
import { addClip, clipFromExtract, newCase } from './case.js';
import { logEvent } from './activity.js';
import { flowSet, isFlowCommit, startable } from './flows.js';
import { contentHash } from './hash.js';

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

export async function getDrafts() {
  return (await browser.storage.local.get('profileDrafts')).profileDrafts || [];
}

export async function getStarred() {
  return (await browser.storage.local.get('starred')).starred || [];
}

export async function toggleStar(formId) {
  return mutateStorage(({ starred = [] }) => {
    const next = starred.includes(formId) ? starred.filter((x) => x !== formId) : [...starred, formId];
    return { patch: { starred: next }, result: next.includes(formId) };
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

// Make sure the in-page agent (lib/agent.js) is listening in the tab, injecting it if not.
async function ensureAgent(tabId) {
  try {
    if (await browser.tabs.sendMessage(tabId, { type: 'powerloader:ping' }, { frameId: 0 })) return;
  } catch {
    // no agent yet
  }
  await browser.scripting.executeScript({ target: { tabId }, files: ['/lib/extract.js', '/lib/capture.js', '/lib/agent.js'] });
}

export async function ask(tabId, msg) {
  await ensureAgent(tabId);
  return browser.tabs.sendMessage(tabId, msg, { frameId: 0 });
}

// Library profiles (and tested drafts in use) that read this page, narrowed in-page by their `when` selectors.
export async function profilesForTab(tabId, url, lib, drafts = []) {
  const candidates = pageProfiles(lib, url, drafts);
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

export async function startCase(formIds, { ref = '', page, windowId } = {}) {
  return mutateStorage(({ case: current, teardown, library }) => {
    if (teardown) throw new Error('The last case is still being deleted. Try again in a moment.');
    if (current) throw new Error('Finish or discard the current case first. Power Loader works on one case at a time.');
    const lib = libraryAt(library, library?.current);
    if (!lib) throw new Error('Connect the forms library first');
    const c = newCase(lib, formIds, { ref });
    // Navigation is logged for the window the case was started in.
    if (windowId != null) c.windowId = windowId;
    logEvent(c, 'start_case', { detail: c.forms.map((f) => `${f.id}@${f.version}`).join(' + ') });
    if (page) logEvent(c, 'visit_page', { page });
    return { patch: { case: c, receipt: null }, result: c };
  }, ['case', 'teardown', 'library', 'receipt']);
}

/**
 * Start a case from a flow: the flow, compiled to library files, is stored as a set of its own and the case
 * pins it, as a case pins a library commit. Works with or without a connected library, which lends its
 * privacy patterns. Every form the flow fills is a form of the case.
 */
export async function startFlowCase(flowId, { ref = '', page, windowId } = {}) {
  const { flows = [], library } = await browser.storage.local.get(['flows', 'library']);
  const flow = flows.find((f) => f.id === flowId);
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
    const c = newCase(lib, Object.keys(lib.forms), { ref });
    c.library.flow = { id: flow.id, name: flow.name };
    if (windowId != null) c.windowId = windowId;
    logEvent(c, 'start_case', { detail: `flow · ${c.forms.map((f) => `${f.id}@${f.version}`).join(' + ')}` });
    if (page) logEvent(c, 'visit_page', { page });
    return { patch: { library: next, case: c, receipt: null }, result: c };
  }, ['case', 'teardown', 'library', 'receipt']);
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

/** Read a page with a profile and add it to the case. Returns the clip summary. */
export async function clipTab(caseId, tab, profile, { auto = false } = {}) {
  const res = await extractFromTab(tab.id, profile);
  return updateCase(caseId, (c, lib) => {
    const clip = clipFromExtract(lib, profile, res);
    const summary = addClip(c, lib, clip);
    const n = Object.keys(clip.values).length + clip.records.length;
    logEvent(c, auto ? 'auto_clip_page' : 'clip_page', { page: pageLogInfo(lib, { url: res.url, profile }), detail: `${n} item${n === 1 ? '' : 's'}`, clip: summary.clipId });
    return summary;
  });
}

export { fillProfileFor, confirmationFor };

// ------------------------------------------------------------------ drafts

export async function updateDrafts(fn) {
  return mutateStorage(({ profileDrafts = [] }) => {
    const list = structuredClone(profileDrafts);
    const result = fn(list);
    return { patch: { profileDrafts: list }, result };
  }, ['profileDrafts']);
}

export async function updateDraft(id, fn) {
  return updateDrafts((list) => {
    const d = list.find((x) => x.id === id);
    if (!d) throw new Error('That draft is no longer on this computer');
    return fn(d);
  });
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

export const saveDraft = (draft) => updateDrafts((list) => { list.push(draft); return draft; });
export const deleteDraft = (id) => updateDrafts((list) => {
  const i = list.findIndex((x) => x.id === id);
  if (i >= 0) list.splice(i, 1);
});

export const probeTab = (tabId, profile) => ask(tabId, { type: 'powerloader:probe', profile });
export const pageValues = (tabId) => ask(tabId, { type: 'powerloader:values' });
export const pageLabels = (tabId) => ask(tabId, { type: 'powerloader:labels' });
export const startPicking = (tabId, selected, fields = {}, mode = 'values') => ask(tabId, { type: 'powerloader:pickStart', selected, fields, mode });
export const showPicked = (tabId, selected, fields = {}, current = null) => ask(tabId, { type: 'powerloader:pickSelected', selected, fields, current });
// The override tool: resolves with the element the caseworker clicked, as a candidate, or null.
export const pickAnyElement = (tabId) => ask(tabId, { type: 'powerloader:overrideStart' });
export const stopPickAny = (tabId) => ask(tabId, { type: 'powerloader:overrideStop' }).catch(() => {});
export const stopPicking = (tabId) => ask(tabId, { type: 'powerloader:pickStop' }).catch(() => {});

// "Update this case to v5": move the case to the current library commit. Explicit only.
export async function updateCaseLibrary(caseId) {
  return mutateStorage(({ case: c, teardown, library }) => {
    if (!c || c.id !== caseId || teardown) throw new CaseEnded();
    if (c.library.flow) throw new Error('This case comes from a flow, so it keeps that flow until it ends');
    const lib = libraryAt(library, library?.current);
    if (!lib) throw new Error('The library isn’t on this computer');
    const missing = c.forms.filter((f) => !lib.forms[f.id]);
    if (missing.length) throw new Error(`The new library no longer has ${missing.map((f) => f.id).join(', ')}`);
    c.library = { commit: lib.commit };
    c.forms = c.forms.map((f) => ({ id: f.id, version: lib.forms[f.id].version }));
    return { patch: { case: c }, result: c.forms };
  }, ['case', 'teardown', 'library']);
}

// What a case would gain from the current library: forms with a different version there.
export function libraryUpdates(state, c) {
  // A case from a flow keeps that flow; the library is a different source.
  if (c?.library?.flow || isFlowCommit(c?.library?.commit)) return null;
  const lib = libraryAt(state, state?.current);
  if (!c || !lib || lib.commit === c.library.commit) return null;
  const forms = c.forms.filter((f) => lib.forms[f.id] && lib.forms[f.id].version !== f.version)
    .map((f) => ({ id: f.id, name: lib.forms[f.id].name, from: f.version, to: lib.forms[f.id].version }));
  return { commit: lib.commit, forms };
}

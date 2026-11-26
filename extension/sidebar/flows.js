// The Flows tab: author a flow (the forms a case fills, the pages it clips from, and the fields between
// them) on the real pages, with or without a connected library. Output pages come first, because the forms
// say what the flow has to collect. Each page's profile is made with the remote AI, by hand, or both: type
// a field's name, then click its box or value on the page. The flow is checked on every render, and every
// problem says how to fix it. A flow can also guide the caseworker: pages to visit (a case list, a search
// page), what to do on each page with templated links to the next, and timelines drawn from its dates.
// See docs/plans/flow-authoring.md and lib/flows.js.
/* global browser, DOMParser */
import { h, plural, time, announce, describeError, draftInput, clearDraft } from '../ui/dom.js';
import { confirmDialog } from '../ui/dialog.js';
import { saveFile } from '../ui/download.js';
import { contentHash } from '../lib/hash.js';
import { TYPES } from '../lib/fields.js';
import { addRowField, guessKey, judgeFillTest, judgeTest, picksOf, recordTest, removeRowField, rowPicksOf, testedNow } from '../lib/drafts.js';
import {
  addField, addLink, addPage, addSeries, addTimeline, applyFormAnswer, applyPageAnswer, bindPage, contract, exportBlocked, exportedNow, exportFlow, flowFileName, flowLib,
  choosesFrom, setChoose, copyLibraryFlow, libraryFlow, flowFromLibrary, flowReady, flowSnapshot, guessType, importFlow, journeyOf, startable, keysOf, linkUrl, linkVars, mapPick, moveStep, newFlow, pageAddress, pageMatches, pageOf, pagesOf,
  removeField, removeLink, removePage, removeSeries, removeTimeline, renamePage, ROLES, SERIES_KINDS, seriesSpec, setField, setLink, setRequired, setSeries, setStepText, setStepWhen,
  addRead, readsOf, removeRead, setEmail, setRead, addNote, notable, notesOf, removeNote, setNote, setAutoClipDelay,
  splitRowSelector, testCurrent, timelineOf, unmapKey, validateFlow,
  addRequest, addListRequest, isListRequest, linkLists, setShow, fetchedNow, recordFetchedTest, removeRequest, requestPreview, requestUrl, requestsOf, setRequest, setThen, stepPagesOf, thenUrl,
  bindJsonPage, readsJson,
} from '../lib/flows.js';
import { FETCH_LIMITS, FORMATS, failureText, formatOf, judgeDocument, judgeFetched, keyIsPersonal, listAddresses, planRequest } from '../lib/fetch-steps.js';
import { jsonTree } from './json-tree.js';
import { hostsLayer } from '../lib/access.js';
import { CLIP_DELAYS, COLOURS, MAX_REQUESTS, SHAPES, colourOf, REF_LABEL, templateVars } from '../lib/journey.js';
import { ANNOTATION_TYPES, STYLE_PRESETS } from '../lib/annotations.js';
import { noteState } from './annotate.js';
import { parseSnapshot } from '../lib/ai/snapshot.js';
import {
  ask, captureTab, changedFlowFor, currentAccess, describeForm, fetchFromTab, readListFromTab, pageValues, pickAnyElement, pickNoteTarget, probeTab, showPicked, startPicking, stopPickAny, stopPicking, updateFlow, updateFlows,
} from '../lib/core.js';
import { aiReady } from '../lib/ai/settings.js';
import { runAi } from './privacy.js';
import { blockedCard } from './caseview.js';
import { openTemplate } from './templates.js';

const E = globalThis.PowerLoaderExtract;
const TYPE_LABELS = { text: 'Text', longtext: 'Long text', date: 'Date', money: 'Money', number: 'Number', nino: 'NI number', postcode: 'Postcode', phone: 'Phone', email: 'Email', choice: 'Choice', boolean: 'Yes or no' };

export const flowUi = {
  open: null, // the flow being edited
  page: null, // the page of it open in the page editor
  dragging: null, // a value being dragged from the page, if its drag data doesn't reach the sidebar
  addAfter: null, // Build from a case: the page a page added from the tab goes after (the step that was open)
  addSometimes: false, // …and whether to say it can be a step that is only sometimes needed
  arrivedAt: null, // the address the tab last arrived at in Build, so arriving opens a page once
  manual: false, // the manual tool is shown even before anything is mapped
  target: null, // the field waiting for its box or value on the page
  selected: null, // an element clicked on the page with no field waiting: { selector, value, label }
  aiKeys: null, // the fields a "Fix with AI" asked about, for the page's next ✦ request
  timeline: null, // the timeline open in the timeline editor
  seriesTest: {}, // series id → what a test on the page found: { at, rows: [{ label, start, end, at }], count } | { error }
  picking: false, tabId: null, url: null, candidates: [], form: null, probes: {}, overriding: false,
  // Test as fetched: sample values for a request's {names}, in memory only (never saved or exported), and
  // the last result, per field: { pageId, ok, fields, code?, text? }.
  samples: {}, fetchTest: null,
  // A page that reads data (JSON): the sample response as a document, in memory only for this editor session
  // ({ pageId, doc, url, at }), the tree's folds, and the value selected in it (lib/json-dom.js pickFor()).
  jsonSample: null, jsonTree: { open: new Set(), more: {} }, jsonPick: null, jsonResult: null,
  // Recording a reveal rule: { pageId, key, step: 'pick' | 'opening' | 'offer', offer? } (lib/gather.js recordAfter()).
  reveal: null,
};

export async function loadFlowEditing() {
  const { editingFlow } = await browser.storage.session.get('editingFlow').catch(() => ({}));
  Object.assign(flowUi, { open: editingFlow?.open || null, page: editingFlow?.page || null });
}

async function openAt(open, page = null) {
  // Leaving a flow's overview: what's typed in its name and guidance is saved first.
  if (flowUi.open && !flowUi.page) await flushText(flowUi.open);
  if (open !== flowUi.open) { clearDraft('fl-name'); clearDraft('fl-guidance'); flowUi.samples = {}; flowUi.fetchTest = null; }
  // A sample response is dropped when its page's editor closes.
  if (flowUi.jsonSample && (open !== flowUi.open || page !== flowUi.jsonSample.pageId)) Object.assign(flowUi, { jsonSample: null, jsonTree: { open: new Set(), more: {} }, jsonPick: null, jsonResult: null });
  Object.assign(flowUi, { open, page, timeline: null, manual: false, target: null, selected: null, aiKeys: page === flowUi.page ? flowUi.aiKeys : null, probes: {} });
  await browser.storage.session.set({ editingFlow: { open, page } }).catch(() => {});
}

/**
 * Open the Flows tab at a page of a flow (from the Templates tab): a flow on this computer in its editor, a
 * library's flow in its read-only view.
 */
export async function openFlowAt(context, { flowId, pageId = null, library = null }) {
  if (library) { await openAt(null); flowUi.libView = library; } else await openAt(flowId, pageId);
  context.act.setTab('flows');
}

const currentFlow = (data) => (data.flows || []).find((f) => f.id === flowUi.open) || null;
const currentPage = (data) => { const f = currentFlow(data); return f && flowUi.page ? pageOf(f, flowUi.page) : null; };
const isWeb = (url) => /^https?:/.test(url || '');
export const flowPicking = () => flowUi.picking;

// Is the tab showing this page of the flow? A page to visit (or a fetch step's page) by its address pattern,
// the others by their template's.
const onPage = (page, url) => !!url && (page.role === 'guide' || page.role === 'fetch' ? !!(page.match && E.matchUrl(page.match, url)) : pageMatches(page, url, E.matchUrl));

/** The notes to preview on the tab: the page open in the editor, when the tab shows it. */
export function flowNotePreview({ ui, data }) {
  if (ui.tab !== 'flows') return null;
  const flow = currentFlow(data);
  const page = currentPage(data);
  if (!flow || !page || !notable(page) || !notesOf(page).length || !onPage(page, ui.page?.url)) return null;
  return { flow, notes: notesOf(page) };
}

// ------------------------------------------------------------------ the page: picking

const badgesOf = (flow, page) => Object.fromEntries((page.draft ? picksOf(page.draft) : []).filter((p) => p.key)
  .map((p) => [page.role === 'output' ? p.box : p.selector, flow.fields[p.key]?.label || p.key]));
const selectorsOf = (page) => (page.draft ? picksOf(page.draft).map((p) => (page.role === 'output' ? p.box : p.selector)) : []);

/** Keep the page's pick mode in step with the flow page being edited and the tab in view. */
export async function syncFlowPicking(context) {
  const { ui, data } = context;
  const flow = currentFlow(data);
  const page = currentPage(data);
  // A page that reads data is picked in the tree view of its sample, never on a tab.
  const here = !!(flow && page && !readsJson(page) && ui.tab === 'flows' && ui.info?.access && pageMatches(page, ui.page?.url, E.matchUrl));
  const want = here ? ui.page.id : null;
  if (flowUi.picking && (flowUi.tabId !== want || flowUi.url !== ui.page?.url || flowUi.mode !== page?.role)) {
    await stopPicking(flowUi.tabId);
    Object.assign(flowUi, { picking: false, overriding: false, selected: null, target: null });
  }
  if (!want) return;
  if (page.role === 'output' && flowUi.url !== ui.page.url) flowUi.form = await describeForm(want).catch(() => null);
  if (!flowUi.picking) {
    const out = await startPicking(want, selectorsOf(page), badgesOf(flow, page), page.role === 'output' ? 'controls' : 'values').catch(() => null);
    if (!out) return;
    Object.assign(flowUi, { picking: true, tabId: want, url: ui.page.url, mode: page.role, candidates: out.candidates, probes: {} });
  } else {
    await showPicked(want, selectorsOf(page), badgesOf(flow, page), flowUi.selected?.selector || null).catch(() => {});
  }
}

export async function stopFlowPicking() {
  if (flowUi.picking) await stopPicking(flowUi.tabId);
  Object.assign(flowUi, { picking: false, overriding: false, url: null });
}

const change = (context, fn, done) => updateFlow(flowUi.open, fn).then((out) => { if (done) announce(typeof done === 'function' ? done(out) : done); context.act.refresh(); return out; }, (e) => { announce(describeError(e)); context.act.refresh(); });
const changePage = (context, fn, done) => change(context, (f) => fn(f, pageOf(f, flowUi.page)), done);

// A value dragged from the page: remembered for a moment, in case its drag data doesn't reach the sidebar.
export function onFlowDragPick(msg, sender) {
  if (!flowUi.picking || sender.tab?.id !== flowUi.tabId) return;
  flowUi.dragging = { selector: msg.selector, value: msg.value, label: msg.label, at: Date.now() };
}

const DRAG_TYPE = 'application/x-powerloader-pick';
// A field's row is a drop zone: a value dragged from the page onto it is that field's.
function dropZone(context, key) {
  const read = (e) => {
    const raw = e.dataTransfer?.getData(DRAG_TYPE);
    if (raw) { try { return JSON.parse(raw); } catch { /* not ours */ } }
    return flowUi.dragging && Date.now() - flowUi.dragging.at < 60000 ? flowUi.dragging : null;
  };
  return {
    ondragover: (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; e.currentTarget.classList.add('over'); },
    ondragleave: (e) => e.currentTarget.classList.remove('over'),
    ondrop: (e) => {
      e.preventDefault();
      e.currentTarget.classList.remove('over');
      const got = read(e);
      flowUi.dragging = null;
      if (got?.selector) void place(context, key, flowUi.candidates.find((c) => c.selector === got.selector) || { selector: got.selector, value: got.value || '', label: got.label || null });
    },
  };
}

// An element clicked on the page: it goes to the field waiting for it, or waits for a field.
export function onFlowPicked(context, msg, sender) {
  const { ui, data } = context;
  const flow = currentFlow(data);
  const page = currentPage(data);
  if (!flow || !page || sender.tab?.id !== ui.page?.id) return;
  const cand = flowUi.candidates.find((c) => c.selector === msg.selector) || { selector: msg.selector, value: msg.value || '', label: msg.label || null };
  if (flowUi.target) { void place(context, flowUi.target, cand); return; }
  flowUi.selected = { selector: msg.selector, value: msg.value ?? cand.value ?? '', label: msg.label || cand.label || null };
  announce(`Selected ${page.role === 'output' ? 'the box' : `‘${String(flowUi.selected.value).slice(0, 40)}’`}${flowUi.selected.label ? ` (${flowUi.selected.label})` : ''}. Choose its field.`);
  context.act.refresh();
}

async function place(context, key, cand) {
  const flow = currentFlow(context.data);
  const output = currentPage(context.data)?.role === 'output';
  const f = flow?.fields[key];
  const filter = output ? '' : f?.type === 'date' ? 'date' : f?.type === 'money' ? 'number' : f?.long && /\n/.test(cand.value || '') ? 'oneline' : '';
  Object.assign(flowUi, { target: null, selected: null });
  await changePage(context, (fl, p) => mapPick(p, key, cand.selector, { filter }),
    output ? `${f?.label || key} goes in ${cand.label ? `the ${cand.label} box` : 'that box'}` : `${f?.label || key} reads ‘${String(cand.value || '').slice(0, 40)}’`);
}

async function pickAnything(context) {
  if (flowUi.overriding) { await stopPickAny(flowUi.tabId); flowUi.overriding = false; context.act.render(); return; }
  flowUi.overriding = true;
  context.act.render();
  announce('Click the value on the page. Esc cancels.');
  const got = await pickAnyElement(flowUi.tabId).catch(() => null);
  flowUi.overriding = false;
  if (got) {
    if (!flowUi.candidates.some((c) => c.selector === got.selector)) flowUi.candidates.push(got);
    onFlowPicked(context, got, { tab: { id: context.ui.page.id } });
    return;
  }
  context.act.refresh();
}

// ------------------------------------------------------------------ the typeahead

// What the typeahead offers: the flow's fields, the connected library's, and (on a form) its boxes' labels.
function suggestions(context, flow, page) {
  const mapped = new Set(keysOf(page));
  const out = new Map();
  for (const [key, f] of Object.entries(flow.fields)) if (!mapped.has(key) && !(page.role === 'input' && f.manual)) out.set(f.label.toLowerCase(), { label: f.label, key, from: 'flow' });
  if (page.role === 'output') {
    for (const c of [...(flowUi.form?.controls || []), ...(flowUi.form?.groups || []).flatMap((g) => g.controls)]) {
      const label = String(c.label || '').replace(/\s*\(£\)\s*$/, '').replace(/[:*?]+$/, '').trim();
      if (label && !out.has(label.toLowerCase()) && !picksOf(page.draft).some((p) => p.box === c.selector)) out.set(label.toLowerCase(), { label, box: c.selector, from: 'form' });
    }
    for (const [key, f] of Object.entries(context.data.lib?.fields || {})) if (!out.has(f.label.toLowerCase())) out.set(f.label.toLowerCase(), { label: f.label, key, def: f, from: 'library' });
  }
  return [...out.values()];
}

// The typed name becomes a field: the flow's own, a library field, or a new one. Then the page says where.
async function addTyped(context, text) {
  const flow = currentFlow(context.data);
  const page = currentPage(context.data);
  const label = String(text || '').trim();
  if (!flow || !page || !label) return;
  const hit = suggestions(context, flow, page).find((s) => s.label.toLowerCase() === label.toLowerCase());
  if (page.role === 'input' && !hit && !Object.values(flow.fields).some((f) => f.label.toLowerCase() === label.toLowerCase())) {
    if (!await confirmDialog({ title: `Add ${label} to the flow?`, text: 'No form in this flow uses it yet. Fields usually start on a form to fill, so the flow only gathers what a form needs.', confirm: 'Add it' })) return;
  }
  const box = hit?.box || null;
  const key = await updateFlow(flow.id, (f) => addField(f, hit?.def ? { ...hit.def, label: hit.label, key: hit.key } : { label: hit?.label || label, key: hit?.key, type: guessType(label), long: false }));
  const input = document.querySelector('[data-key="fl-add"]');
  if (input) input.value = '';
  const sel = flowUi.selected;
  if (sel || box) { await place(context, key, sel || { selector: box, label: hit.label }); return; }
  flowUi.target = key;
  announce(`Now click ${page.role === 'output' ? 'the box' : 'the value'} for ${flow.fields[key]?.label || label} on the page.`);
  context.act.refresh();
}

function typeahead(context, flow, page) {
  const list = suggestions(context, flow, page);
  const submit = () => addTyped(context, document.querySelector('[data-key="fl-add"]')?.value);
  return h('div', { class: 'stack', style: 'gap:4px' },
    h('label', { class: 'field small', for: 'fl-add' }, page.role === 'output' ? 'Add a field this form collects' : 'Add a field to find on this page',
      h('span', { class: 'hint' }, page.role === 'output' ? 'Type its name and choose it, or add a new one. Then click its box on the page.' : 'Choose one of the flow’s fields, then click its value on the page.')),
    h('div', { class: 'row', style: 'flex-wrap:nowrap' },
      h('input', {
        type: 'text', id: 'fl-add', 'data-key': 'fl-add', list: 'fl-add-list', autocomplete: 'off', placeholder: page.role === 'output' ? 'e.g. Date of birth' : 'Start typing a field name',
        onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } },
        onchange: (e) => { if (list.some((s) => s.label === e.target.value)) submit(); },
      }),
      h('button', { type: 'button', class: 'sm', 'data-key': 'fl-add-go', onclick: submit }, 'Add')),
    h('datalist', { id: 'fl-add-list' }, list.map((s) => h('option', { value: s.label }, { flow: 'In this flow', form: 'A box on this form', library: 'From your library' }[s.from]))));
}

// ------------------------------------------------------------------ the AI

function toAiSettings(context) {
  context.act.setTab('settings');
  announce('The ✦ Remote AI is off. Turn it on under ✦ Remote AI here in Settings, then come back to the Flows tab.');
  setTimeout(() => document.getElementById('ai-setup')?.scrollIntoView({ block: 'start' }), 50);
}

function aiUnavailable(context) {
  return aiReady(context.data.settings) ? null : h('p', { class: 'small muted' }, 'The ✦ Remote AI is off. ',
    h('button', { type: 'button', class: 'link sm', 'data-key': 'fl-ai-settings', onclick: () => toAiSettings(context) }, 'Turn it on in Settings'), ', or make it by hand.');
}

/** Ask the remote AI for this page's profile: for a form, the fields it collects; for a page, where they are. */
async function askAi(context, keys = flowUi.aiKeys) {
  const { ui, data } = context;
  const flow = currentFlow(data);
  const page = currentPage(data);
  if (!flow || !page?.draft) return;
  const lib = flowLib(flow, data.lib);
  // With no case there are no known values, so every value on the page is treated as personal: the AI needs
  // the page's layout and labels, never what it says about someone.
  const values = await pageValues(ui.page.id).catch(() => []);
  const extraKnown = [...new Set(values.map((v) => String(v).trim()).filter((v) => v.length > 2 && v.length <= 200))].map((text) => ({ category: 'reference', text }));
  const ai = { ...context, lib, extraKnown };
  if (page.role === 'output') {
    const form = flowUi.form || await describeForm(ui.page.id);
    const boxes = [...(form.controls || []), ...(form.groups || []).flatMap((g) => g.controls)];
    await runAi(ai, 'flowForm', { form, title: ui.page.title, url: ui.page.url, guidance: flow.guidance }, async (out) => {
      const r = await updateFlow(flow.id, (f) => {
        const p = pageOf(f, page.id);
        if (out.name && /^Form to fill \d+$/.test(p.name)) renamePage(p, out.name);
        return applyFormAnswer(f, page.id, out, boxes);
      });
      flowUi.manual = true;
      announce(`The AI found ${plural(r.mapped, 'field')} on this form${r.added ? `, ${r.added} new to the flow` : ''}${r.dropped.length ? `; ${r.dropped.length} suggestions weren’t boxes on it` : ''}. Check them, then test.`);
    });
    return;
  }
  const want = (keys?.length ? keys : Object.keys(flow.fields)).filter((k) => flow.fields[k] && !flow.fields[k].manual);
  if (!want.length) { announce('The flow has no fields to find yet. Make a form to fill first: its fields are what the pages gather.'); return; }
  const snap = await captureTab(ui.page.id);
  const targets = pagesOf(flow, 'output').map((p) => p.name);
  await runAi(ai, 'profile', { html: snap.html, url: ui.page.url, title: ui.page.title, document, keys: want, targets, guidance: flow.guidance }, async (out) => {
    await updateFlow(flow.id, (f) => applyPageAnswer(pageOf(f, page.id), out.fields, { only: keys?.length ? keys : null }));
    Object.assign(flowUi, { manual: true, aiKeys: null, probes: {} });
    announce(`The AI found ${plural(Object.keys(out.fields).length, 'field')} on this page${out.dropped.length ? `; ${out.dropped.length} left out` : ''}${out.problems?.length ? `; ${plural(out.problems.length, 'problem')} reading it` : ''}. Check them, then test.`);
  });
}

// ------------------------------------------------------------------ testing

async function runTest(context) {
  const { ui, data } = context;
  const flow = currentFlow(data);
  const page = currentPage(data);
  if (!flow || !page?.draft) return;
  const lib = flowLib(flow, data.lib);
  try {
    let test;
    if (page.role === 'output') {
      const boxes = Object.fromEntries(picksOf(page.draft).filter((p) => p.key).map((p) => [p.box, p.box]));
      test = judgeFillTest(page.draft, await probeTab(ui.page.id, { fields: boxes }), { url: ui.page.url, lib });
    } else {
      const probes = await probeTab(ui.page.id, page.draft.profile);
      flowUi.probes = probes;
      test = judgeTest(page.draft, probes, { url: ui.page.url, lib, pageValues: await pageValues(ui.page.id).catch(() => []) });
    }
    await updateFlow(flow.id, (f) => recordTest(pageOf(f, page.id).draft, test));
    const failed = Object.values(test.fields).filter((x) => !x.ok).length;
    announce(test.ok ? 'Test passed on this page.' : `Test failed: ${failed ? plural(failed, 'field') : test.leaks[0]}`);
  } catch (e) { announce(`Couldn’t test: ${describeError(e)}`); }
  context.act.refresh();
}

// ------------------------------------------------------------------ problems and their fixes

function fixButtons(context, flow, i) {
  const { act } = context;
  const out = [];
  const open = (pageId, keys = null) => h('button', {
    type: 'button', class: 'link sm', 'data-key': `fx-open-${i.code}-${pageId}-${i.key || ''}`,
    onclick: async () => { await openAt(flow.id, pageId); flowUi.aiKeys = keys; act.refresh(); },
  }, `Open ${pageOf(flow, pageId)?.name || 'the page'}`);
  const ai = (pageId, keys, label = '✦ Fix with AI') => h('button', {
    type: 'button', class: 'link sm magic', 'data-key': `fx-ai-${i.code}-${pageId}-${i.key || ''}`, disabled: context.aiBusy,
    onclick: async () => {
      if (!aiReady(context.data.settings)) { toAiSettings(context); return; }
      await openAt(flow.id, pageId);
      flowUi.aiKeys = keys;
      const page = pageOf(flow, pageId);
      if (page?.draft && pageMatches(page, context.ui.page?.url, E.matchUrl) && context.ui.info?.access) await askAi(context, keys);
      else announce(`Go to ${page?.name || 'the page'}, then press ✦ there`);
      act.refresh();
    },
  }, label);
  if (i.code === 'when-bad') out.push(h('button', { type: 'button', class: 'link sm', 'data-key': `fx-when-${i.pageId}`, onclick: () => change(context, (f) => setStepWhen(pageOf(f, i.pageId), null), 'Condition removed: the step is always needed') }, 'Remove the condition'));
  if (i.code === 'no-name') out.push(h('button', { type: 'button', class: 'link sm', 'data-key': 'fx-name', onclick: () => document.querySelector('[data-key="fl-name"]')?.focus() }, 'Name it'));
  if (i.pageId) {
    if (flowUi.page !== i.pageId) out.push(open(i.pageId, i.keys || null));
    if (i.ai) out.push(ai(i.pageId, i.keys || null));
    if (['untested', 'changed'].includes(i.code) && flowUi.page === i.pageId) out.push(h('button', { type: 'button', class: 'link sm', 'data-key': `fx-test-${i.pageId}`, onclick: () => runTest(context) }, 'Test it now'));
  }
  if (i.code === 'not-gathered') {
    for (const p of pagesOf(flow, 'input')) {
      if (flowUi.page !== p.id) out.push(open(p.id, i.keys));
      if (p.draft) out.push(ai(p.id, i.keys, `✦ Find it on ${p.name}`));
    }
    out.push(h('button', { type: 'button', class: 'link sm', 'data-key': `fx-typed-${i.key}`, onclick: () => change(context, (f) => setField(f, i.key, { manual: true }), 'Marked as typed by the caseworker') }, 'The caseworker types it'));
  }
  if (i.code === 'not-used') {
    for (const p of pagesOf(flow, 'input').filter((x) => keysOf(x).includes(i.key))) {
      out.push(h('button', { type: 'button', class: 'link sm', 'data-key': `fx-unmap-${p.id}-${i.key}`, onclick: () => change(context, (f) => unmapKey(pageOf(f, p.id), i.key), 'Removed from that page') }, `Stop reading it on ${p.name}`));
    }
  }
  if (i.code === 'unused') out.push(h('button', { type: 'button', class: 'link sm danger', 'data-key': `fx-rm-${i.key}`, onclick: () => change(context, (f) => removeField(f, i.key), 'Field removed') }, 'Remove the field'));
  return out.length ? h('div', { class: 'row', style: 'gap:10px' }, out) : null;
}

function problemsList(context, flow, issues, { title = 'Checks', page = false } = {}) {
  const errors = issues.filter((i) => i.level === 'error');
  return h('div', { class: 'stack', style: 'gap:6px' },
    h('div', { class: 'sec-title' }, h('span', {}, title),
      h('span', { class: `pill ${errors.length ? 'bad' : issues.length ? 'warn' : 'ok'}` }, errors.length ? plural(errors.length, 'problem') : issues.length ? plural(issues.length, 'warning') : page ? '✓ No problems' : '✓ Ready to export')),
    issues.length ? h('ul', { class: 'plain stack', style: 'gap:8px' }, issues.map((i) => h('li', { class: `notice ${i.level === 'error' ? 'bad' : 'warn'} stack`, style: 'gap:4px' },
      h('span', {}, i.text), fixButtons(context, flow, i))))
      : h('p', { class: 'small muted' }, page ? 'This page is made and tested.' : 'Every page is made and tested, and every field a form needs is gathered.'));
}

// ------------------------------------------------------------------ the list

async function importFile(context, file) {
  try {
    const flow = importFlow(JSON.parse(await file.text()));
    await updateFlows((list) => { list.push(flow); });
    await openAt(flow.id);
    announce(`Imported ${flow.name}. Test each page here before you export it again.`);
  } catch (e) { announce(`Couldn’t import: ${describeError(e)}`); }
  context.act.refresh();
}

/** Start a case from a flow: any flow whose files pass the library's checks. Untested pages are a warning. */
export async function startFromFlow(context, flow, { libraryPath = null } = {}) {
  const { data, act } = context;
  if (data.case) { announce('Power Loader works on one case at a time. Finish or discard the open case first: the buttons are at the bottom of the Case tab.'); return; }
  const can = startable(flow, { access: data.access });
  if (!can.ok) { announce(`Can’t start a case from ${flow.name || 'this flow'}: ${can.reason}`); return; }
  const doubts = [
    can.failed.length ? `${can.failed.join(', ')} failed ${can.failed.length === 1 ? 'its' : 'their'} last test.` : '',
    can.untested.length ? `${can.untested.join(', ')} ${can.untested.length === 1 ? 'hasn’t' : 'haven’t'} been tested on this computer.` : '',
    can.unmade.length ? `${can.unmade.join(', ')} ${can.unmade.length === 1 ? 'isn’t' : 'aren’t'} made yet, so ${can.unmade.length === 1 ? 'it' : 'they'} can’t be clipped.` : '',
    // Every fetch step is listed with the systems it reads, so a flow from a file can't fetch unseen.
    ...can.fetches.map((f) => `${f.name} fetches pages in the background from ${f.hosts.join(', ') || 'its page’s system'} when you press its button.`),
  ].filter(Boolean);
  if (doubts.length && !await confirmDialog({
    title: `Start a case from ${flow.name || 'this flow'}?`,
    text: `${doubts.join(' ')} Values are still checked against their fields as you clip.`, confirm: 'Start case',
  })) return;
  await act.startFlow(flow.id, { libraryPath, flow });
}

export async function startNewFlow(context) {
  const flow = newFlow();
  await updateFlows((list) => { list.push(flow); });
  await openAt(flow.id);
  context.ui.tab = 'flows';
  announce('New flow. Name it, add guidance if you like, then open the form to fill.');
  await context.act.refresh();
  document.querySelector('[data-key="fl-name"]')?.focus();
}

// Make a flow from a library form: its fill profile and the page profiles that read its fields, to change
// or to use as it is.
function fromLibraryCard(context) {
  const lib = context.data.lib;
  if (!lib || !Object.keys(lib.forms).length) return null;
  const forms = Object.values(lib.forms).sort((a, b) => a.name.localeCompare(b.name));
  return h('div', { class: 'card stack', style: 'gap:6px' },
    h('label', { class: 'field small', for: 'fl-lib-form' }, 'Make a flow from a library form',
      h('span', { class: 'hint' }, 'Copies the form, its template and the templates of the pages that read its fields. Change it here; the library isn’t changed.')),
    h('div', { class: 'row', style: 'flex-wrap:nowrap' },
      h('select', { id: 'fl-lib-form', 'data-key': 'fl-lib-form' }, forms.map((f) => h('option', { value: f.id }, `${f.name} (${f.version})`))),
      h('button', {
        type: 'button', class: 'sm', 'data-key': 'fl-from-lib',
        onclick: async () => {
          try {
            const flow = flowFromLibrary(lib, [document.getElementById('fl-lib-form').value]);
            await updateFlows((list) => { list.push(flow); });
            await openAt(flow.id);
            announce(`Made ${flow.name} from the library: ${plural(pagesOf(flow, 'input').length, 'page')} to clip`);
          } catch (e) { announce(describeError(e)); }
          context.act.refresh();
        },
      }, 'Make flow')));
}

/** The connected library's flows, each opened as an import is: [{ path, flow }]. One that won't open is left out. */
export function libraryFlows(context) {
  const lib = context.data.lib;
  return (lib?.flows || []).map((e) => { try { return { path: e.path, flow: libraryFlow(lib, e.path) }; } catch { return null; } }).filter(Boolean);
}

/** A library flow on the Flows tab: read-only. It can be looked at, started, or copied to this computer to edit. */
function libraryFlowCard(context, { path, flow }) {
  const { data } = context;
  const open = flowUi.libView === path;
  const steps = journeyOf(flow);
  return h('div', { class: 'fcard flow', 'data-key': `fl-lib-${flow.id}` },
    h('span', { class: 'nm' }, flow.name || 'Untitled flow'),
    h('span', { class: 'meta' }, `${pagesOf(flow, 'output').map((p) => p.name).join(' + ') || 'No form to fill'} · ${plural(steps.length, 'step')} · read-only, from your library`),
    h('span', { class: 'acts' },
      h('button', { type: 'button', class: 'sm', 'data-key': `fl-lib-view-${flow.id}`, 'aria-expanded': String(open), onclick: () => { flowUi.libView = open ? null : path; context.act.render(); } }, open ? 'Hide' : 'Look at it'),
      h('button', {
        type: 'button', class: 'sm', 'data-key': `fl-lib-copy-${flow.id}`,
        onclick: async () => {
          try {
            const copy = copyLibraryFlow(data.lib, path);
            await updateFlows((list) => { list.push(copy); });
            announce(`Copied ${copy.name} to this computer: edit the copy. The library’s flow isn’t changed.`);
            await openAt(copy.id);
          } catch (e) { announce(describeError(e)); }
          context.act.refresh();
        },
      }, 'Make a copy to edit'),
      h('button', { type: 'button', class: 'sm primary', 'data-key': `fl-lib-try-${flow.id}`, disabled: !!data.case, title: data.case ? 'Finish or discard the open case first, in Casework' : undefined, onclick: () => context.act.tryFlow(flow, { libraryPath: path }) }, 'Try it')),
    open ? h('div', { class: 'stack small', style: 'gap:4px', 'data-key': `fl-lib-detail-${flow.id}` },
      flow.guidance ? h('p', { style: 'white-space:pre-wrap' }, flow.guidance) : null,
      h('ol', { class: 'stack', style: 'gap:2px' }, steps.map((p) => h('li', {}, h('b', {}, p.name), ` · ${ROLES[p.role]}${p.step?.text ? `: ${p.step.text}` : ''}`)))) : null);
}

function listView(context) {
  const { data } = context;
  const flows = data.flows || [];
  return [
    h('div', { class: 'stack' },
      h('h2', { class: 'start-title' }, 'Flows'),
      h('p', { class: 'muted' }, 'A flow is the forms a case fills, the pages it clips from, and the fields that go between them. Make one on the real pages, test it, and export it for your forms library. You don’t need a library connected.')),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'primary', 'data-key': 'fl-new', onclick: () => startNewFlow(context) }, 'New flow'),
      h('button', { type: 'button', class: 'sm', 'data-key': 'fl-import-btn', onclick: () => document.getElementById('fl-import')?.click() }, 'Import a flow…'),
      h('input', { type: 'file', id: 'fl-import', accept: '.json,application/json', hidden: true, 'aria-label': 'Flow file to import', onchange: (e) => { const f = e.target.files?.[0]; if (f) importFile(context, f); } })),
    fromLibraryCard(context),
    libraryFlows(context).length ? [
      h('div', { class: 'sec-title' }, h('span', {}, 'From your library'), h('span', { class: 'small' }, `commit ${data.lib.commit} · read-only`)),
      h('div', { class: 'stack', 'data-key': 'fl-library-flows' }, libraryFlows(context).map((x) => libraryFlowCard(context, x))),
    ] : null,
    h('div', { class: 'sec-title' }, h('span', {}, 'On this computer'), h('span', { class: 'small' }, 'yours to edit')),
    flows.length ? h('div', { class: 'stack' }, flows.map((f) => {
      const issues = validateFlow(f, { access: context.data.access });
      const errors = issues.filter((i) => i.level === 'error').length;
      return h('div', { class: 'fcard flow' },
        h('span', { class: 'nm' }, f.name || 'Untitled flow'),
        f.copiedFrom ? h('span', { class: 'meta', 'data-key': `fl-copied-${f.id}` }, `Copied from your library (commit ${f.copiedFrom.commit})`) : null,
        h('span', { class: 'meta' }, `${plural(pagesOf(f, 'output').length, 'form')} to fill · ${plural(pagesOf(f, 'input').length, 'page')} to clip${pagesOf(f, 'guide').length ? ` · ${plural(pagesOf(f, 'guide').length, 'page')} to visit` : ''}${pagesOf(f, 'scan').length ? ` · ${plural(pagesOf(f, 'scan').length, 'screenshot')} to read` : ''}${pagesOf(f, 'email').length ? ` · ${plural(pagesOf(f, 'email').length, 'email')}` : ''}${pagesOf(f, 'fetch').length ? ` · ${plural(pagesOf(f, 'fetch').length, 'fetch step')}` : ''} · ${plural(Object.keys(f.fields).length, 'field')}`),
        h('span', { class: 'acts' },
          h('span', { class: `pill ${errors ? 'bad' : 'ok'}` }, errors ? plural(errors, 'problem') : exportedNow(f) ? '✓ Exported' : '✓ Ready'),
          h('button', { type: 'button', class: 'sm primary', 'data-key': `fl-open-${f.id}`, 'aria-label': `Edit ${f.name || 'Untitled flow'}`, onclick: async () => { await openAt(f.id); context.act.refresh(); } }, 'Edit')));
    })) : h('div', { class: 'card' }, h('p', { class: 'muted' }, 'No flows on this computer yet.')),
  ];
}

// ------------------------------------------------------------------ the overview

function pageStatus(flow, page, issues) {
  const mine = issues.filter((i) => i.pageId === page.id && i.level === 'error');
  if (page.role === 'fetch') return mine.length ? h('span', { class: 'pill bad' }, plural(mine.length, 'problem')) : requestsOf(page).length ? h('span', { class: 'pill ok' }, `✓ Fetches ${plural(requestsOf(page).length, 'page')}`) : h('span', { class: 'pill warn' }, 'Fetches nothing yet');
  if (page.role === 'email') return mine.length ? h('span', { class: 'pill bad' }, plural(mine.length, 'problem')) : h('span', { class: 'pill ok' }, '✓ Written');
  if (page.role === 'scan') return mine.length ? h('span', { class: 'pill bad' }, plural(mine.length, 'problem')) : h('span', { class: 'pill ok' }, `✓ Reads ${plural(readsOf(page).length, 'value')}`);
  if (page.role === 'guide') return mine.length ? h('span', { class: 'pill bad' }, plural(mine.length, 'problem')) : page.url ? h('span', { class: 'pill ok' }, `✓ ${page.step?.text ? 'With instructions' : 'Address set'}`) : h('span', { class: 'pill warn' }, 'No address yet');
  if (!page.draft) return h('span', { class: 'pill warn' }, 'Not made yet');
  if (mine.length) return h('span', { class: 'pill bad' }, plural(mine.length, 'problem'));
  return h('span', { class: 'pill ok' }, `✓ ${plural(keysOf(page).length, 'field')}, tested`);
}

function pageList(context, flow, role, issues) {
  // A page a fetch step fetches is listed under that step, not as a page to clip of its own.
  const pages = stepPagesOf(flow, role);
  return h('div', { class: 'stack', style: 'gap:6px' },
    pages.map((p) => h('div', { class: 'fcard flow' },
      h('span', { class: 'nm' }, p.name),
      h('span', { class: 'meta' }, p.role === 'fetch' ? `${requestsOf(p).map((r) => r.name).join(', ') || 'No pages yet'}${p.url ? ` · from ${p.url.replace(/^https?:\/\//, '')}` : ''}` : p.role === 'email' ? (p.email?.subject ? `Subject: ${p.email.subject}` : 'No subject yet') : p.role === 'scan' ? (readsOf(p).map((r) => (r.key === 'ref' ? REF_LABEL : flow.fields[r.key]?.label || r.key)).join(', ') || 'Reads nothing yet') : p.url ? p.url.replace(/^https?:\/\//, '') : 'No page chosen yet', p.draft ? ` · ${plural(keysOf(p).length, 'field')}` : '', p.step?.links?.length ? ` · ${plural(p.step.links.length, 'link')}` : ''),
      h('span', { class: 'acts' }, pageStatus(flow, p, issues),
        ['input', 'output'].includes(p.role) ? h('button', { type: 'button', class: 'link sm', 'data-key': `fl-tpl-${p.id}`, 'aria-label': `The template for ${p.name}`, onclick: () => openTemplate(context, { flow, page: p }) }, 'Template') : null,
        h('button', { type: 'button', class: 'sm primary', 'data-key': `fl-page-${p.id}`, 'aria-label': `Edit ${p.name}`, onclick: async () => { await openAt(flow.id, p.id); context.act.refresh(); } }, 'Edit')))),
    h('button', {
      type: 'button', class: 'link sm', 'data-key': `fl-add-${role}`, style: 'align-self:flex-start',
      onclick: () => change(context, (f) => addPage(f, role), role === 'output' ? 'Form added' : 'Page added'),
    }, role === 'output' ? '+ Add another form to fill' : role === 'input' ? '+ Add another page to clip'
      : role === 'fetch' ? (pages.length ? '+ Add another fetch step' : '+ Add a fetch step')
      : role === 'email' ? (pages.length ? '+ Add another email' : '+ Add an email to send')
        : role === 'scan' ? (pages.length ? '+ Add another screenshot to read' : '+ Add a screenshot to read')
          : pages.length ? '+ Add another page to visit' : '+ Add a page to visit'));
}

function contractTable(context, flow) {
  const rows = contract(flow);
  const name = (ids) => ids.map((id) => pageOf(flow, id)?.name).filter(Boolean).join(', ');
  return h('div', { class: 'stack', style: 'gap:6px' },
    h('div', { class: 'sec-title' }, h('span', {}, 'Fields'), h('span', { class: 'small' }, 'what goes from the pages to the forms')),
    rows.length ? rows.map((r) => {
      const id = `fl-f-${r.key}`;
      const status = r.manual ? ['', 'Typed by the caseworker'] : r.gathered.length ? ['ok', `✓ From ${name(r.gathered)}`] : r.needed.length ? [r.required.length ? 'bad' : 'warn', 'Not gathered yet'] : ['warn', 'Not used'];
      return h('div', { class: 'stack', style: 'gap:2px;border-top:1px solid var(--border);padding-top:6px' },
        h('div', { class: 'row between', style: 'flex-wrap:nowrap' },
          h('b', {}, r.label, r.required.length ? h('span', { class: 'muted', title: 'Required by a form' }, ' *') : null),
          h('span', { class: `pill ${status[0]}` }, status[1])),
        r.needed.length ? h('span', { class: 'small muted' }, `For ${name(r.needed)}`) : null,
        h('div', { class: 'row small', style: 'gap:10px' },
          h('label', { class: 'sr', for: `${id}-type` }, `Type of ${r.label}`),
          h('select', { id: `${id}-type`, 'data-key': `${id}-type`, class: 'sm', style: 'width:auto', onchange: (e) => change(context, (f) => setField(f, r.key, { type: e.target.value })) },
            TYPES.map((t) => h('option', { value: t, selected: (r.type || 'text') === t }, TYPE_LABELS[t] || t))),
          h('label', { class: 'row small', style: 'flex-wrap:nowrap;gap:4px' },
            h('input', { type: 'checkbox', 'data-key': `${id}-manual`, checked: !!r.manual, onchange: (e) => change(context, (f) => setField(f, r.key, { manual: e.target.checked })) }),
            'The caseworker types it'),
          h('button', {
            type: 'button', class: 'link sm danger', 'data-key': `${id}-rm`,
            onclick: async () => { if (await confirmDialog({ title: `Remove ${r.label}?`, text: 'It’s removed from the flow and from every page that maps it.', confirm: 'Remove it', danger: true })) change(context, (f) => removeField(f, r.key), 'Field removed'); },
          }, 'Remove')));
    }) : h('p', { class: 'small muted' }, 'No fields yet. They come from the forms to fill: open one and let the AI work out what it collects, or add them by hand.'));
}

async function exportNow(context, flow, issues) {
  const blocked = exportBlocked(issues);
  if (blocked) { announce(`Can’t export: ${blocked.text}`); return; }
  const errors = issues.filter((i) => i.level === 'error');
  if (errors.length && !await confirmDialog({
    title: `Export ${flow.name || 'this flow'} with ${plural(errors.length, 'problem')}?`,
    text: 'The file lists the problems. You can import it again to carry on, but a library maintainer can’t publish it until they’re fixed.', confirm: 'Export anyway',
  })) return;
  const body = exportFlow(flow, issues);
  body.exported = { from: `Power Loader ${browser.runtime.getManifest?.().version || ''}`.trim(), date: new Date().toISOString().slice(0, 10), contentHash: await contentHash(body) };
  try {
    await saveFile(flowFileName(flow), JSON.stringify(body, null, 2));
    await updateFlow(flow.id, (f) => { f.exported = { at: new Date().toISOString(), hash: body.exported.contentHash, snapshot: flowSnapshot(f) }; });
    announce(errors.length ? 'Exported, with its problems listed' : 'Exported. Send the file to a library maintainer.');
  } catch (e) { announce(`Couldn’t save: ${describeError(e)}`); }
  context.act.refresh();
}

// The flow's name and guidance save as they're typed (shortly after typing stops) and when you leave the box.
const pending = new Map();
function saveText(context, flowId, field, value, now = false) {
  clearTimeout(pending.get(field));
  const run = () => {
    pending.delete(field);
    updateFlow(flowId, (f) => { f[field] = field === 'name' ? value.trim().slice(0, 80) : value.slice(0, 5000); }).catch((e) => announce(describeError(e)));
  };
  if (now) run(); else pending.set(field, setTimeout(run, 400));
}

// Save what's typed in the name and guidance now, before going somewhere else.
async function flushText(flowId) {
  const typed = Object.fromEntries(['name', 'guidance'].map((k) => [k, document.querySelector(`[data-key="fl-${k}"]`)?.value]).filter(([, v]) => v != null));
  for (const t of pending.values()) clearTimeout(t);
  pending.clear();
  if (Object.keys(typed).length) await updateFlow(flowId, (f) => { if (typed.name != null) f.name = typed.name.trim().slice(0, 80); if (typed.guidance != null) f.guidance = typed.guidance.slice(0, 5000); }).catch(() => {});
}

function overview(context, flow, issues) {
  const { act } = context;
  return [
    h('button', { type: 'button', class: 'link sm', 'data-key': 'fl-back-list', style: 'align-self:flex-start', onclick: async () => { await openAt(null); act.refresh(); } }, '← All flows'),
    h('div', { class: 'card stack' },
      h('label', { class: 'field' }, 'Name of the flow',
        draftInput('fl-name', { type: 'text', value: flow.name, placeholder: 'e.g. Discretionary housing payment', oninput: (e) => saveText(context, flow.id, 'name', e.target.value), onchange: (e) => saveText(context, flow.id, 'name', e.target.value, true) })),
      h('label', { class: 'field' }, 'Guidance (optional)',
        h('span', { class: 'hint' }, 'Describe the flow: what it’s for, which form it fills, which pages hold what, and anything the caseworker types themselves. The AI reads this with each page, after the usual redaction preview. Saved as you type.'),
        draftInput('fl-guidance', { rows: 6, value: flow.guidance, oninput: (e) => saveText(context, flow.id, 'guidance', e.target.value), onchange: (e) => saveText(context, flow.id, 'guidance', e.target.value, true) }, 'textarea'))),
    h('div', { class: 'sec-title' }, h('span', {}, '1. Forms to fill'), h('span', { class: 'small' }, 'start here')),
    h('p', { class: 'small muted' }, 'The forms say what the flow has to collect.'),
    pageList(context, flow, 'output', issues),
    h('div', { class: 'sec-title' }, h('span', {}, '2. Pages to clip from')),
    h('p', { class: 'small muted' }, 'Where each value the forms need comes from.'),
    pageList(context, flow, 'input', issues),
    h('div', { class: 'sec-title' }, h('span', {}, '3. Pages to visit'), h('span', { class: 'small' }, 'optional')),
    h('p', { class: 'small muted' }, 'Pages the caseworker goes through that Power Loader doesn’t clip or fill: where a case starts, such as a list to pick the next case from, or a search page.'),
    pageList(context, flow, 'guide', issues),
    h('div', { class: 'sec-title' }, h('span', {}, '4. Screenshots to read'), h('span', { class: 'small' }, 'optional')),
    h('p', { class: 'small muted' }, 'Values from a system Power Loader can’t clip, such as a desktop app: the caseworker snips it and pastes it in, and OCR on this computer reads the values, or the case reference.'),
    pageList(context, flow, 'scan', issues),
    h('div', { class: 'sec-title' }, h('span', {}, '5. Emails to send'), h('span', { class: 'small' }, 'optional')),
    h('p', { class: 'small muted' }, 'An email written from the case’s values, opened in the caseworker’s own email app to check and send.'),
    pageList(context, flow, 'email', issues),
    h('div', { class: 'sec-title' }, h('span', {}, '6. Pages to fetch'), h('span', { class: 'small' }, 'optional')),
    h('p', { class: 'small muted' }, 'Pages the caseworker doesn’t need to open: when they press the step’s button on its page, Power Loader fetches them from the same system, reads each with its page’s template and adds the values to the case.'),
    pageList(context, flow, 'fetch', issues),
    contractTable(context, flow),
    stepsSection(context, flow, issues),
    timelinesSection(context, flow, issues),
    problemsList(context, flow, issues),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: flowReady(issues) ? 'primary' : '', 'data-key': 'fl-export', onclick: () => exportNow(context, flow, issues) }, 'Export'),
      useChangedButton(context, flow),
      // The only way from Build to a case: Casework, with a case of this flow.
      h('button', { type: 'button', class: 'sm', 'data-key': 'fl-try', disabled: !!context.data.case, title: context.data.case ? 'Finish or discard the open case first, in Casework' : undefined, onclick: () => context.act.tryFlow(flow) }, 'Try it'),
      h('button', { type: 'button', class: 'sm', 'data-key': 'fl-done', onclick: async () => { await openAt(null); announce('Flow saved on this computer'); act.refresh(); } }, 'Done'),
      h('button', {
        type: 'button', class: 'link sm danger', 'data-key': 'fl-delete',
        onclick: async () => {
          if (!await confirmDialog({ title: `Delete ${flow.name || 'this flow'}?`, text: flow.exported ? 'You exported it, so a copy may already be with a maintainer.' : 'It hasn’t been exported.', confirm: 'Delete flow', danger: true })) return;
          await updateFlows((list) => { const i = list.findIndex((x) => x.id === flow.id); if (i >= 0) list.splice(i, 1); });
          await openAt(null);
          act.refresh();
        },
      }, 'Delete flow')),
    h('p', { class: 'small muted' }, `Saved on this computer as you go${flow.exported ? `. Exported ${time(flow.exported.at)}${exportedNow(flow) ? '' : ', changed since'}` : ''}.`),
  ];
}

// ------------------------------------------------------------------ the page editor

function howPill(p) {
  if (!p || p.by === 'you') return null;
  return p.check ? h('span', { class: 'pill warn' }, 'Check this · suggested by the AI') : h('span', { class: 'pill' }, 'Suggested by the AI');
}

const BLOCKED_SITE = 'Power Loader doesn’t work on this site: the site rules block it';

function whereCard(context, flow, page) {
  const { ui, act } = context;
  const onWeb = isWeb(ui.page?.url);
  const here = pageMatches(page, ui.page?.url, E.matchUrl);
  const kind = page.role === 'output' ? 'form' : 'page';
  if (page.draft && here && ui.info?.access) return null;
  const bind = async () => {
    const values = await pageValues(ui.page.id).catch(() => []);
    await stopFlowPicking();
    await change(context, (f) => bindPage(f, page.id, { url: ui.page.url, title: ui.page.title, values }), `${page.name}: using ${ui.page.title || ui.page.url}`);
  };
  // A page the site rules block can't be part of a flow: the button says why.
  const blocked = onWeb && ui.info?.blocked?.[page.role === 'output' ? 'fill' : 'read'];
  // One click: permission for the site (asked in the click itself, as Firefox requires), then this page.
  const useCurrent = async () => {
    if (!ui.info?.access) {
      await act.requestAccess();
      if (!context.ui.info?.access) { announce('Power Loader wasn’t allowed on this site, so it can’t use this page. Choose Allow when Firefox asks.'); return; }
    }
    if (page.draft && !await confirmDialog({ title: `Use this page for ${page.name}?`, text: 'What you mapped on the other page is cleared.', confirm: 'Use this page' })) return;
    await bind();
  };
  const known = page.url && !page.url.includes('{') ? page.url : '';
  // A pasted address is kept on the page and opened in this tab; then it's the current page.
  const go = async () => {
    const raw = document.getElementById('fl-goto-url')?.value.trim() || known;
    let url;
    try { url = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`).href; } catch { announce('Paste the page’s address, such as https://forms.example.gov.uk/apply'); return; }
    if (!page.draft) await updateFlow(flow.id, (f) => { pageOf(f, page.id).url = url; }).catch(() => {});
    await act.openUrl(url);
    announce(`Opening ${url}. When it has loaded, choose Use the current ${kind}.`);
  };
  const host = (() => { try { return new URL(ui.page.url).host; } catch { return ''; } })();
  return h('div', { class: 'notice magic stack', style: 'gap:10px' },
    h('p', {}, h('b', {}, page.draft ? `This ${kind} is made on another page. Go back to it to change it, or use a different one.` : page.role === 'output' ? 'Which form does this flow fill?' : 'Which page has the values?')),
    h('div', { class: 'stack', style: 'gap:4px' },
      h('button', {
        type: 'button', class: 'primary', 'data-key': 'fl-bind', style: 'align-self:flex-start', disabled: !onWeb || !!blocked,
        title: blocked ? BLOCKED_SITE : undefined, onclick: useCurrent,
      }, page.draft ? `Use the current ${kind} instead` : `Use the current ${kind}`),
      blocked ? h('span', { class: 'small', 'data-key': 'fl-blocked' }, `${BLOCKED_SITE}.`) : null,
      onWeb ? h('span', { class: 'small' }, 'This tab: ', h('b', {}, ui.page.title || ui.page.url), host ? h('span', { class: 'muted' }, ` · ${host}`) : null,
        ui.info?.access ? null : h('span', { class: 'muted' }, '. Firefox asks you to allow Power Loader on this site first.'))
        : h('span', { class: 'small muted' }, `This tab isn’t showing a web page. Go to the ${kind}, or paste its address below.`)),
    h('div', { class: 'stack', style: 'gap:4px' },
      h('label', { class: 'small', for: 'fl-goto-url' }, page.draft && known ? `Or go back to it:` : `Or paste the ${kind}’s address:`),
      h('div', { class: 'row', style: 'flex-wrap:nowrap' },
        h('input', { type: 'url', id: 'fl-goto-url', 'data-key': 'fl-goto-url', value: known, placeholder: 'https://…', onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } } }),
        h('button', { type: 'button', class: 'sm', 'data-key': 'fl-goto', onclick: go }, 'Go to it')),
      page.role === 'input' ? h('span', { class: 'small muted' }, 'A real record is fine: nothing from it is kept in the flow.') : null));
}

function selectedBar(context, flow, page) {
  const s = flowUi.selected;
  if (!s) return null;
  const options = Object.entries(flow.fields).filter(([, f]) => page.role === 'output' || !f.manual);
  const guess = options.find(([, f]) => s.label && f.label.toLowerCase() === String(s.label).toLowerCase().replace(/[:*?]+$/, '').trim())?.[0];
  return h('div', { class: 'notice magic stack', role: 'status', style: 'gap:6px' },
    h('span', {}, 'Selected on the page: ', h('b', {}, page.role === 'output' ? (s.label || s.selector) : `‘${String(s.value).slice(0, 60)}’`), page.role !== 'output' && s.label ? ` (${s.label})` : ''),
    options.length ? h('div', { class: 'row', style: 'flex-wrap:nowrap' },
      h('label', { class: 'sr', for: 'fl-sel-key' }, 'Field for the selected element'),
      h('select', { id: 'fl-sel-key', 'data-key': 'fl-sel-key' }, options.map(([k, f]) => h('option', { value: k, selected: k === guess }, f.label))),
      h('button', { type: 'button', class: 'primary sm', 'data-key': 'fl-sel-use', onclick: () => place(context, document.getElementById('fl-sel-key').value, s) }, 'Use for this field')) : null,
    h('span', { class: 'small muted' }, options.length ? 'Or type a new field’s name in the box above.' : 'Type the field’s name in the box above to add it.'),
    h('button', { type: 'button', class: 'link sm', 'data-key': 'fl-sel-cancel', style: 'align-self:flex-start', onclick: () => { flowUi.selected = null; context.act.refresh(); } }, 'Cancel'));
}

function targetBar(context, flow, page) {
  const key = flowUi.target;
  if (!key) return null;
  return h('div', { class: 'notice magic row', role: 'status' },
    h('span', { class: 'grow' }, `Now click ${page.role === 'output' ? 'the box' : 'the value'} for `, h('b', {}, flow.fields[key]?.label || key), ' on the page.'),
    h('button', { type: 'button', class: 'link sm', 'data-key': 'fl-target-cancel', onclick: () => { flowUi.target = null; context.act.render(); } }, 'Cancel'));
}

function fieldRows(context, flow, page) {
  const picks = picksOf(page.draft).filter((p) => p.key);
  const res = testCurrent(page.draft) ? page.draft.tested.fields : {};
  // An input page lists every field the forms need, found or not; a form lists what it collects.
  const wanted = page.role === 'input'
    ? Object.entries(flow.fields).filter(([k, f]) => !f.manual && (pagesOf(flow, 'output').some((o) => keysOf(o).includes(k)) || picks.some((p) => p.key === k))).map(([k]) => k)
    : picks.map((p) => p.key);
  const controls = [...(flowUi.form?.controls || []), ...(flowUi.form?.groups || []).flatMap((g) => g.controls)];
  return wanted.map((key) => {
    const f = flow.fields[key] || { label: key };
    const p = picks.find((x) => x.key === key);
    const id = `fl-r-${key}`;
    const r = p ? res[page.role === 'output' ? p.box : key] : null;
    const cand = p && flowUi.candidates.find((c) => c.selector === (p.selector || p.box));
    const probe = flowUi.probes[key];
    const box = p && page.role === 'output' ? controls.find((c) => c.selector === p.box) : null;
    const elsewhere = page.role === 'input' && !p ? pagesOf(flow, 'input').filter((x) => x.id !== page.id && keysOf(x).includes(key)).map((x) => x.name) : [];
    return h('div', { class: `stack drop${flowUi.target === key ? ' notice magic' : ''}`, 'data-field': key, style: 'gap:3px;border-top:1px solid var(--border);padding-top:6px', ...dropZone(context, key) },
      h('div', { class: 'row between', style: 'flex-wrap:nowrap' },
        h('b', {}, f.label, (page.required || []).includes(key) ? h('span', { class: 'muted', title: 'Required' }, ' *') : null),
        h('span', { class: 'row', style: 'gap:8px;flex-wrap:nowrap' },
          h('button', { type: 'button', class: 'link sm', 'data-key': `${id}-map`, disabled: !flowUi.picking, onclick: () => { flowUi.target = key; flowUi.selected = null; announce(`Click ${page.role === 'output' ? 'the box' : 'the value'} for ${f.label} on the page`); context.act.render(); } }, p ? 'Change' : page.role === 'output' ? 'Choose its box' : 'Find it'),
          p ? h('button', { type: 'button', class: 'link sm', 'data-key': `${id}-rm`, onclick: () => changePage(context, (fl, pg) => unmapKey(pg, key), `${f.label} removed from this page`) }, 'Not this') : null)),
      p ? h('div', { class: 'row small', style: 'gap:4px;flex-wrap:wrap' },
        page.role === 'output' ? h('span', {}, 'Box: ', h('b', {}, box?.label || p.box)) : h('span', {}, 'Reads ', h('b', {}, probe && probe.value != null ? String(probe.value) : cand ? `‘${cand.value}’` : '…')),
        howPill(p)) : h('span', { class: 'small muted' }, elsewhere.length ? `Found on ${elsewhere.join(', ')}. Find it here too only if this page is another source.` : page.role === 'output' ? 'No box yet' : 'Not found on this page yet'),
      p ? h('code', { class: 'small' }, p.selector || p.box) : null,
      page.role === 'output' ? h('div', { class: 'row small', style: 'gap:10px' },
        h('label', { class: 'sr', for: `${id}-type` }, `Type of ${f.label}`),
        h('select', { id: `${id}-type`, 'data-key': `${id}-type`, class: 'sm', style: 'width:auto', onchange: (e) => change(context, (fl) => setField(fl, key, { type: e.target.value })) },
          TYPES.map((t) => h('option', { value: t, selected: (f.type || 'text') === t }, TYPE_LABELS[t] || t))),
        h('label', { class: 'row small', style: 'flex-wrap:nowrap;gap:4px' },
          h('input', { type: 'checkbox', 'data-key': `${id}-req`, checked: (page.required || []).includes(key), onchange: (e) => changePage(context, (fl, pg) => setRequired(pg, key, e.target.checked)) }), 'Required'),
        h('label', { class: 'row small', style: 'flex-wrap:nowrap;gap:4px' },
          h('input', { type: 'checkbox', 'data-key': `${id}-manual`, checked: !!f.manual, onchange: (e) => change(context, (fl) => setField(fl, key, { manual: e.target.checked })) }), 'The caseworker types it')) : null,
      r ? h('span', { class: `pill ${r.ok ? 'ok' : 'bad'}` }, r.ok ? (page.role === 'output' ? '✓ One box' : '✓ Found once, valid') : `✕ ${r.error}`) : null);
  });
}

function testLine(page) {
  const t = page.draft.tested;
  const current = testCurrent(page.draft);
  return h('p', { class: 'small', role: 'status' },
    !t ? h('span', { class: 'pill warn' }, 'Not tested') : !current ? h('span', { class: 'pill warn' }, 'Changed since its test: not tested')
      : t.ok ? [h('span', { class: 'pill ok' }, `✓ Tested ${time(t.at)}`), page.role === 'input' && !page.draft.second?.ok ? ' Test it on another record too: a selector that only works for one person is the common failure.' : page.draft.second?.ok ? ' Also passed on a second record.' : '']
        : h('span', { class: 'pill bad' }, `✕ Test failed ${time(t.at)}`));
}

// While a case of this flow is open, and the flow has changed since it started: the case can take it (D17).
function useChangedButton(context, flow) {
  const { data, act } = context;
  if (!data.case) return null;
  const changed = changedFlowFor(data.case, data.flows || [], data.library?.sets?.[data.case.library?.commit]);
  if (changed?.id !== flow.id) return null;
  return h('button', { type: 'button', class: 'sm primary', 'data-key': 'fl-use-changed', onclick: () => act.useChangedFlow(flow.id) }, 'Use the changed flow for this case');
}

// Where this page is in the flow, at the top of its editor, as Casework shows its step.
function stepOfLine(flow, page) {
  const order = journeyOf(flow);
  const at = order.findIndex((p) => p.id === (page.parent || page.id));
  return at < 0 ? null : h('p', { class: 'small muted', 'data-key': 'fl-step-of' }, `Step ${at + 1} of ${flow.name || 'the flow'}`);
}

function pageEditor(context, flow, page, issues) {
  // A page added from a case, once it passes its test: the open case can take the changed flow.
  const tested = page.draft && testCurrent(page.draft) && page.draft.tested.ok;
  return [
    tested ? useChangedButton(context, flow) : null,
    h('div', { class: 'row between' }, stepOfLine(flow, page),
      ['input', 'output'].includes(page.role) ? h('button', { type: 'button', class: 'link sm', 'data-key': 'fl-tpl', onclick: () => openTemplate(context, { flow, page }) }, 'Its template') : null),
    pageEditorBody(context, flow, page, issues)];
}

function pageEditorBody(context, flow, page, issues) {
  if (page.role === 'guide') return guideEditor(context, flow, page, issues);
  if (page.role === 'email') return offPageEditor(context, flow, page, issues, emailCard(context, flow, page));
  if (page.role === 'scan') return offPageEditor(context, flow, page, issues, scanCard(context, flow, page));
  if (page.role === 'fetch') return fetchEditor(context, flow, page, issues);
  if (readsJson(page)) return jsonEditor(context, flow, page, issues);
  const { ui, act } = context;
  // A page a fetch step fetches goes back to its step.
  const back = async () => { await stopFlowPicking(); await openAt(flow.id, page.parent && pageOf(flow, page.parent) ? page.parent : null); act.refresh(); };
  const here = !!(page.draft && pageMatches(page, ui.page?.url, E.matchUrl) && ui.info?.access);
  const mapped = page.draft ? picksOf(page.draft).filter((p) => p.key).length : 0;
  const showTool = here && (mapped || flowUi.manual);
  const aiKeys = flowUi.aiKeys?.length ? flowUi.aiKeys : null;
  const busy = context.aiBusy;
  const aiLabel = busy ? [h('span', { class: 'spinner' }), ' Waiting for the AI…']
    : aiKeys ? `✦ Find ${aiKeys.map((k) => flow.fields[k]?.label || k).join(', ')} with AI` : mapped ? '✦ Ask the AI again' : '✦ Make the template with AI';
  const t = page.draft?.tested;
  return [
    h('button', { type: 'button', class: 'link sm', 'data-key': 'fl-back', style: 'align-self:flex-start', onclick: back }, `← ${(page.parent && pageOf(flow, page.parent)?.name) || flow.name || 'The flow'}`),
    h('div', { class: 'card', style: 'border:2px solid var(--magic)' },
      h('div', { class: 'ctx-head' }, h('span', { class: `pill ${page.role === 'output' ? 'acc' : 'magic'}` }, page.parent ? 'Page to fetch' : ROLES[page.role]), h('strong', {}, page.name)),
      page.parent ? h('p', { class: 'small muted' }, `${pageOf(flow, page.parent)?.name || 'A fetch step'} fetches this page without showing it. Make its template here, on the real page, as for any page to clip; then test it as fetched.`) : null,
      h('label', { class: 'field small' }, 'Name',
        h('input', { type: 'text', 'data-key': 'fl-page-name', value: page.name, onchange: (e) => changePage(context, (f, p) => renamePage(p, e.target.value)) })),
      whereCard(context, flow, page),
      page.parent && !page.draft ? jsonChoice(context, flow, page) : null,
      here ? h('div', { class: 'stack', style: 'gap:6px' },
        h('p', { class: 'small' }, page.role === 'output'
          ? 'Work out what this form collects: the fields become what the flow has to gather.'
          : 'Find, on this page, the fields the forms need.'),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: `sm magic${mapped ? '' : ' primary'}`, 'data-key': 'fl-ai', disabled: busy, onclick: () => (aiReady(context.data.settings) ? askAi(context) : toAiSettings(context)) }, aiLabel),
          !showTool ? h('button', { type: 'button', class: 'sm', 'data-key': 'fl-manual', onclick: () => { flowUi.manual = true; act.render(); } }, 'Make it by hand') : null),
        aiUnavailable(context),
        aiReady(context.data.settings) ? h('span', { class: 'small muted' }, `Sends ${page.role === 'output' ? 'the form’s boxes (labels and options, not what’s typed in)' : 'the page’s HTML and the flow’s fields, with every value on the page replaced by a placeholder'}${flow.guidance ? ', and your guidance' : ''}. You see exactly what will be sent first.`) : null) : null,
      showTool ? [
        typeahead(context, flow, page),
        targetBar(context, flow, page),
        selectedBar(context, flow, page),
        h('p', { class: 'small muted' }, page.role === 'output'
          ? 'Every box on the form is outlined. Click a box to choose its field, or add a field above and then click its box.'
          : 'Every value Power Loader can read is outlined; found ones show their field. Click a value to choose its field, or choose Find it on a field and then click its value.'),
        h('button', { type: 'button', class: flowUi.overriding ? 'primary sm' : 'sm', 'data-key': 'fl-any', 'aria-pressed': String(flowUi.overriding), disabled: !flowUi.picking, style: 'align-self:flex-start', onclick: () => pickAnything(context) },
          flowUi.overriding ? 'Cancel picking' : 'Pick something that isn’t outlined'),
        h('div', { class: 'stack', style: 'gap:6px' }, fieldRows(context, flow, page)),
      ] : null,
      page.draft && mapped ? [
        testLine(page),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'primary sm', 'data-key': 'fl-test', disabled: !here, onclick: () => runTest(context) }, testedNow(page.draft) && t.ok && t.url !== ui.page?.url ? 'Test on this record too' : 'Test on this page')),
      ] : null),
    page.parent && page.draft && mapped ? fetchedCard(context, flow, page) : null,
    page.role === 'input' && page.draft && mapped ? revealCard(context, flow, page, here) : null,
    page.role === 'input' && !page.parent ? clipDelayCard(context, page) : null,
    page.parent ? null : stepEditor(context, flow, page),
    page.parent ? null : notesEditor(context, flow, page),
    problemsList(context, flow, issues.filter((i) => i.pageId === page.id || (page.role === 'input' && i.code === 'not-gathered')), { title: 'This page’s checks', page: true }),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'sm', 'data-key': 'fl-page-done', onclick: back }, page.parent ? 'Back to the step' : 'Back to the flow'),
      pagesOf(flow, page.role).length > 1 ? h('button', {
        type: 'button', class: 'link sm danger', 'data-key': 'fl-page-rm',
        onclick: async () => {
          if (!await confirmDialog({ title: `Remove ${page.name} from the flow?`, text: 'What you mapped on it is removed too.', confirm: 'Remove it', danger: true })) return;
          await stopFlowPicking();
          await change(context, (f) => removePage(f, page.id), 'Removed from the flow');
          await openAt(flow.id);
          act.refresh();
        },
      }, 'Remove from the flow') : null),
  ];
}

// ------------------------------------------------------------------ fetch steps

const siteOf = (url) => /^https?:\/\/[^/?#]*/i.exec(String(url || ''))?.[0] || '';

/**
 * Test as fetched: fetch the request's address from this tab exactly as a case would (every check, the same
 * request, the same reading), with sample values for its {names}, and judge the profile on the response, not
 * on the tab. The samples stay in memory; only whether the test passed is kept.
 */
async function runFetchedTest(context, flow, page) {
  const { ui, data } = context;
  const step = pageOf(flow, page.parent);
  const r = requestsOf(step).find((x) => x.pageId === page.id);
  if (!r || !page.draft) return;
  const profile = page.draft.profile;
  const lib = flowLib(flow, data.lib);
  if (isListRequest(r)) { await runListTest(context, flow, page, r, lib); return; }
  const tpl = requestUrl(flow, r);
  for (const k of templateVars(tpl)) { const v = document.querySelector(`[data-key="fl-sample-${k}"]`)?.value; if (v != null) flowUi.samples[k] = v.trim(); }
  const say = (out) => { flowUi.fetchTest = { pageId: page.id, at: Date.now(), ...out }; context.act.render(); };
  try {
    const layers = [...await currentAccess(), hostsLayer(lib.approvedHosts)];
    const plan = planRequest({ request: { ...r, url: tpl, method: 'GET', profileId: profile.id }, lib: { profiles: [profile] }, vars: flowUi.samples, layers, tabUrl: ui.page?.url });
    if (plan.problem) {
      const text = plan.problem === 'trigger' ? `Go to a page on ${siteOf(tpl).replace(/^https?:\/\//, '') || 'its system'} first, such as ${step.name}: the test fetches from this tab, as a case fetches from ${step.name}.`
        : plan.problem === 'missing' ? `Give a sample ${plan.missing.map((k) => (k === 'ref' ? REF_LABEL : flow.fields[k]?.label || k)).join(' and ')} first.` : failureText(plan.problem, { name: page.name });
      say({ ok: false, fields: {}, code: plan.problem, text });
      return;
    }
    const res = await fetchFromTab(ui.page.id, plan.url, { accept: FORMATS[formatOf(profile)].accept, timeoutMs: FETCH_LIMITS.timeoutMs, maxBytes: FETCH_LIMITS.maxBytes, atUrl: ui.page.url });
    const out = judgeFetched(page.draft, res, { url: plan.url, layers, lib, DOMParser });
    delete out.doc; // a page's response is never kept
    // A refusal (a redirect, a sign-in, an error) says nothing about the profile: only a read is kept as a verdict.
    if (!out.code || out.code === 'when') await updateFlow(flow.id, (f) => recordFetchedTest(pageOf(f, page.id).draft, { ok: out.ok }));
    say(out);
    announce(out.ok ? 'Test passed as fetched.' : `Test as fetched failed: ${out.text || plural(Object.values(out.fields).filter((x) => !x.ok).length, 'field')}`);
  } catch (e) { say({ ok: false, fields: {}, code: 'error', text: describeError(e) }); }
  context.act.refresh();
}

/**
 * Test as fetched for a list of links: read the list in this tab with the list's page, fetch the first three
 * links exactly as a case would, and judge the page that reads each on every response. It passes when all do.
 */
async function runListTest(context, flow, page, r, lib) {
  const { ui } = context;
  const step = pageOf(flow, page.parent);
  const listPage = pageOf(flow, r.each.pageId);
  const say = (out) => { flowUi.fetchTest = { pageId: page.id, at: Date.now(), ...out }; context.act.render(); };
  try {
    if (!listPage?.draft) { say({ ok: false, fields: {}, code: 'list', text: 'Make the list’s page first.' }); return; }
    const listProfile = { ...listPage.draft.profile, id: listPage.draft.profile.id || 'list' };
    const got = await readListFromTab(ui.page.id, { profiles: [listProfile] }, { each: { ...r.each, profileId: listProfile.id } });
    if (!got) { say({ ok: false, fields: {}, code: 'list', text: `Go to ${step.name} first: the test reads its list of links in this tab.` }); return; }
    const urls = listAddresses(got.hrefs, ui.page.url, 3);
    if (!urls.length) { say({ ok: false, fields: {}, code: 'list', text: `${listPage.name} found no links in “${r.each.list}” on this page.` }); return; }
    const layers = [...await currentAccess(), hostsLayer(lib.approvedHosts)];
    const outs = [];
    for (const url of urls) {
      const plan = planRequest({ request: { ...r, url, method: 'GET', profileId: page.draft.profile.id }, lib: { profiles: [page.draft.profile] }, vars: {}, layers, tabUrl: ui.page.url });
      if (plan.problem) { say({ ok: false, fields: {}, code: plan.problem, text: failureText(plan.problem, { name: page.name }) }); return; }
      const res = await fetchFromTab(ui.page.id, url, { accept: FORMATS[formatOf(page.draft.profile)].accept, timeoutMs: FETCH_LIMITS.timeoutMs, maxBytes: FETCH_LIMITS.maxBytes, atUrl: ui.page.url });
      const out = judgeFetched(page.draft, res, { url, layers, lib, DOMParser });
      delete out.doc;
      outs.push(out);
      if (out.code && out.code !== 'when') { say(out); return; }
    }
    const ok = outs.every((o) => o.ok);
    await updateFlow(flow.id, (f) => recordFetchedTest(pageOf(f, page.id).draft, { ok }));
    say({ ok, fields: outs.find((o) => !o.ok)?.fields || outs[0].fields, text: `Read the first ${plural(outs.length, 'link')} in the list: ${ok ? 'each one passed' : 'not every one passed'}.` });
    announce(ok ? 'Test passed as fetched.' : 'Test as fetched failed.');
  } catch (e) { say({ ok: false, fields: {}, code: 'error', text: describeError(e) }); }
  context.act.refresh();
}

/** The page a fetch step fetches: its test as fetched, with sample values for its address. */
function fetchedCard(context, flow, page) {
  const step = pageOf(flow, page.parent);
  const r = requestsOf(step).find((x) => x.pageId === page.id);
  if (!step || !r) return null;
  const names = isListRequest(r) ? [] : templateVars(requestUrl(flow, r));
  const onPage = testCurrent(page.draft) && page.draft.tested.ok;
  const f = page.draft.tested?.fetched;
  const res = flowUi.fetchTest?.pageId === page.id ? flowUi.fetchTest : null;
  const label = (k) => (k === 'ref' ? REF_LABEL : flow.fields[k]?.label || k);
  return h('div', { class: 'card stack', style: 'gap:8px', 'data-key': 'fl-fetched' },
    h('h3', {}, 'Test as fetched'),
    h('p', { class: 'small muted' }, isListRequest(r)
      ? `A case fetches every link in the list on ${step.name} without opening them. On ${step.name}, this reads the list in this tab and fetches the first three links exactly as a case would.`
      : `A case fetches this page from ${step.name} without opening it. This fetches it from this tab exactly as a case would, and reads the response, not the page in the tab.`),
    names.length ? h('div', { class: 'stack', style: 'gap:4px' },
      h('span', { class: 'small' }, 'Sample values for its address (kept only while you edit, never saved or exported):'),
      names.map((k) => h('label', { class: 'field small' }, label(k),
        h('input', { type: 'text', 'data-key': `fl-sample-${k}`, value: flowUi.samples[k] || '', oninput: (e) => { flowUi.samples[k] = e.target.value; } })))) : null,
    h('p', { class: 'small', role: 'status' },
      !onPage ? h('span', { class: 'pill warn' }, 'Test it on the page first')
        : fetchedNow(page.draft) ? h('span', { class: 'pill ok' }, `✓ Tested as fetched ${time(f.at)}`)
          : f && !f.ok && testCurrent(page.draft) && f.snapshot === page.draft.tested.snapshot ? h('span', { class: 'pill bad' }, `✕ Failed as fetched ${time(f.at)}`) : h('span', { class: 'pill warn' }, 'Not tested as fetched')),
    res ? h('div', { class: 'stack', style: 'gap:2px', 'data-key': 'fl-fetched-result' },
      res.text ? h('p', { class: `small ${res.ok ? 'ok' : 'warn'}` }, res.text) : null,
      Object.entries(res.fields || {}).map(([k, x]) => h('span', { class: `small ${x.ok ? 'ok' : 'bad'}` }, `${x.ok ? '✓' : '✕'} ${flow.fields[k]?.label || k}${x.ok ? '' : `: ${x.error}`}`)),
      !res.ok && !res.code && onPage ? h('p', { class: 'notice warn small' }, 'This page is built after it loads, so it can’t be fetched. Make it a page to clip instead.') : null) : null,
    h('button', { type: 'button', class: 'primary sm', 'data-key': 'fl-test-fetched', style: 'align-self:flex-start', disabled: !onPage, title: onPage ? undefined : 'Test it on the page first', onclick: () => runFetchedTest(context, flow, page) }, 'Test as fetched'));
}

// ------------------------------------------------------------------ pages that read data (JSON)

/** For a page a fetch step fetches, before it's made: the response may be data from an API address. */
function jsonChoice(context, flow, page) {
  const use = () => {
    const url = document.querySelector('[data-key="fl-json-url"]')?.value.trim();
    change(context, (f) => bindJsonPage(f, page.id, { url }), `${page.name}: reads data from that address`);
  };
  return h('div', { class: 'notice stack', style: 'gap:6px', 'data-key': 'fl-json-choice' },
    h('p', {}, h('b', {}, 'Or: the response is data (JSON)')),
    h('p', { class: 'small muted' }, 'Many systems build their pages from their own API. Find the address the page loads its data from in the browser’s network panel and paste it here. Power Loader fetches a sample, and you pick the values from it.'),
    h('label', { class: 'field small' }, 'The data’s address',
      h('input', { type: 'text', 'data-key': 'fl-json-url', placeholder: 'https://…/api/clients/1042', spellcheck: 'false' })),
    h('button', { type: 'button', class: 'sm', 'data-key': 'fl-json-bind', style: 'align-self:flex-start', onclick: use }, 'Read data from this address'));
}

const isPersonalFor = (lib) => keyIsPersonal(lib);

/** Record a test of the JSON page on its sample: it was fetched as a case fetches it, so it's the test as fetched too. */
async function recordJsonTest(flow, page, test) {
  await updateFlow(flow.id, (f) => { const d = pageOf(f, page.id).draft; recordTest(d, test); recordFetchedTest(d, { ok: test.ok }); });
}

/**
 * Fetch a sample: the request's address with sample values, from this tab, exactly as a case would fetch it
 * (every check, the same request, the same reading). The response stays in memory as a document for the tree
 * view; if the page maps anything already, it's tested on it.
 */
async function fetchJsonSample(context, flow, page) {
  const { ui, data } = context;
  const step = pageOf(flow, page.parent);
  const r = requestsOf(step).find((x) => x.pageId === page.id);
  if (!r || !page.draft) return;
  const profile = page.draft.profile;
  const lib = flowLib(flow, data.lib);
  if (isListRequest(r)) { await runListTest(context, flow, page, r, lib); return; }
  const tpl = requestUrl(flow, r);
  for (const k of templateVars(tpl)) { const v = document.querySelector(`[data-key="fl-sample-${k}"]`)?.value; if (v != null) flowUi.samples[k] = v.trim(); }
  const say = (out) => { flowUi.jsonResult = { pageId: page.id, at: Date.now(), ...out }; context.act.render(); };
  try {
    const layers = [...await currentAccess(), hostsLayer(lib.approvedHosts)];
    const plan = planRequest({ request: { ...r, url: tpl, method: 'GET', profileId: profile.id }, lib: { profiles: [profile] }, vars: flowUi.samples, layers, tabUrl: ui.page?.url });
    if (plan.problem) {
      const text = plan.problem === 'trigger' ? `Go to a page on ${siteOf(tpl).replace(/^https?:\/\//, '') || 'its system'} first, such as ${step.name}: the sample is fetched from this tab, as a case fetches from ${step.name}.`
        : plan.problem === 'missing' ? `Give a sample ${plan.missing.map((k) => (k === 'ref' ? REF_LABEL : flow.fields[k]?.label || k)).join(' and ')} first.` : failureText(plan.problem, { name: page.name });
      say({ ok: false, text });
      return;
    }
    const res = await fetchFromTab(ui.page.id, plan.url, { accept: FORMATS.json.accept, timeoutMs: FETCH_LIMITS.timeoutMs, maxBytes: FETCH_LIMITS.maxBytes, atUrl: ui.page.url });
    const out = judgeFetched(page.draft, res, { url: plan.url, layers, lib, DOMParser });
    if (out.code) { say({ ok: false, text: out.text }); announce(`Couldn’t fetch a sample: ${out.text}`); return; }
    Object.assign(flowUi, { jsonSample: { pageId: page.id, doc: out.doc, url: out.url, at: Date.now() }, jsonPick: null });
    const mapped = Object.keys(page.draft.profile.fields || {}).length > 0;
    if (mapped) await recordJsonTest(flow, page, out.test);
    say({ ok: true, text: out.text || (mapped ? (out.test.ok ? 'Fetched a sample, and the test passed on it.' : 'Fetched a sample: the test failed on it.') : 'Fetched a sample. Pick the values the forms need.') });
    announce(mapped ? (out.test.ok ? 'Test passed on the sample.' : 'Test failed on the sample.') : 'Fetched a sample.');
  } catch (e) { say({ ok: false, text: describeError(e) }); }
  context.act.refresh();
}

/** Test again on the sample already fetched, after a change: no new request. */
async function testJsonSample(context, flow, page) {
  const sample = flowUi.jsonSample;
  if (!sample || sample.pageId !== page.id || !page.draft) return;
  const test = judgeDocument(page.draft, sample.doc, { url: sample.url, lib: flowLib(flow, context.data.lib) });
  await recordJsonTest(flow, page, test);
  const failed = Object.values(test.fields).filter((x) => !x.ok).length;
  announce(test.ok ? 'Test passed on the sample.' : `Test failed: ${failed ? plural(failed, 'field') : test.leaks[0]}`);
  context.act.refresh();
}

/** What the value selected in the tree can become: a field read from just this value, or a field of every row. */
function jsonPickCard(context, flow, page) {
  const sel = flowUi.jsonPick;
  if (!sel) return h('p', { class: 'small muted' }, 'Click a value to pick it.');
  const lib = flowLib(flow, context.data.lib);
  const guess = guessKey(lib, globalThis.PowerLoaderJson.humanise(sel.key || '')) || '';
  const keyNow = picksOf(page.draft).find((p) => p.selector === sel.single)?.key || '';
  const useSingle = () => {
    const v = document.querySelector('[data-key="fl-json-field"]')?.value || '';
    if (!v) { announce('Choose its field first'); return; }
    const f = flow.fields[v];
    const filter = f?.type === 'date' ? 'date' : f?.type === 'money' ? 'number' : f?.long && sel.multiline ? 'oneline' : '';
    flowUi.jsonPick = null;
    changePage(context, (fl, p) => {
      const key = v.startsWith('new:') ? addField(fl, { label: v.slice(4), type: guessType(v.slice(4)), long: false }) : v;
      mapPick(p, key, sel.single, { filter: v.startsWith('new:') ? '' : filter });
    }, `${sel.path} picked`);
  };
  const useRows = () => {
    const name = document.querySelector('[data-key="fl-json-rowfield"]')?.value.trim() || sel.rows.field;
    flowUi.jsonPick = null;
    changePage(context, (fl, p) => addRowField(p.draft, { group: sel.rows.group, rows: sel.rows.rows, field: name, item: sel.rows.item }), (g) => `Every item’s ${name} is read, as ${g} rows`);
  };
  return h('div', { class: 'stack', style: 'gap:6px', 'data-key': 'fl-json-pick' },
    h('p', { class: 'small' }, 'Selected ', h('code', {}, sel.path)),
    sel.why ? h('p', { class: 'small warn' }, sel.why) : null,
    sel.single ? h('div', { class: 'stack', style: 'gap:4px' },
      sel.rows ? h('span', { class: 'small' }, h('b', {}, 'Just this one'), sel.rows.position != null ? ` picks item ${sel.rows.position + 1} by position: check it’s the right one on another record.` : '') : null,
      h('div', { class: 'row', style: 'flex-wrap:nowrap' },
        h('label', { class: 'sr', for: 'fl-json-field' }, 'Its field'),
        h('select', { id: 'fl-json-field', 'data-key': 'fl-json-field', class: 'sm' },
          h('option', { value: '' }, 'Choose its field…'),
          Object.entries(flow.fields).map(([k, f]) => h('option', { value: k, selected: k === (keyNow || guess) }, f.label)),
          sel.key ? h('option', { value: `new:${globalThis.PowerLoaderJson.humanise(sel.key).replace(/^./, (c) => c.toUpperCase())}` }, `New field: ${globalThis.PowerLoaderJson.humanise(sel.key)}`) : null),
        h('button', { type: 'button', class: 'sm primary', 'data-key': 'fl-json-use', onclick: useSingle }, 'Use it'))) : null,
    sel.rows ? h('div', { class: 'stack', style: 'gap:4px' },
      h('span', { class: 'small' }, h('b', {}, `Every item in ${sel.rows.group}`), ', as rows for the tools'),
      h('div', { class: 'row', style: 'flex-wrap:nowrap' },
        h('label', { class: 'sr', for: 'fl-json-rowfield' }, 'The rows’ field'),
        h('input', { type: 'text', id: 'fl-json-rowfield', 'data-key': 'fl-json-rowfield', class: 'sm', value: sel.rows.field, spellcheck: 'false' }),
        h('button', { type: 'button', class: 'sm', 'data-key': 'fl-json-rows', onclick: useRows }, 'Read every item'))) : null);
}

/** What the page maps, shown as paths: .person.dateOfBirth, not the CSS. */
function jsonPicksList(context, flow, page) {
  const J = globalThis.PowerLoaderJson;
  const t = testCurrent(page.draft) ? page.draft.tested : null;
  const picks = picksOf(page.draft).filter((p) => p.key);
  const rows = rowPicksOf(page.draft);
  if (!picks.length && !rows.length) return h('p', { class: 'small muted' }, 'Nothing picked yet.');
  const res = (k) => t?.fields?.[k];
  return h('ul', { class: 'plain stack', style: 'gap:4px', 'data-key': 'fl-json-picks' },
    picks.map((p) => h('li', { class: 'row between', style: 'flex-wrap:nowrap' },
      h('span', {}, h('b', {}, flow.fields[p.key]?.label || p.key), ' ', h('code', { class: 'small' }, J.selectorToPath(p.selector) || p.selector)),
      res(p.key) ? h('span', { class: `pill ${res(p.key).ok ? 'ok' : 'bad'}` }, res(p.key).ok ? '✓ Found once, valid' : `✕ ${res(p.key).error}`) : null,
      h('button', { type: 'button', class: 'link sm', 'data-key': `fl-json-rm-${p.key}`, onclick: () => changePage(context, (fl, pg) => unmapKey(pg, p.key), `${flow.fields[p.key]?.label || p.key} removed`) }, 'Remove'))),
    rows.map((r) => h('li', { class: 'stack', style: 'gap:2px' },
      h('span', {}, h('b', {}, `${r.group} rows`), ' ', h('code', { class: 'small' }, `${J.selectorToPath(r.rows.replace(/\s*>\s*\*$/, '')) || r.rows}[]`),
        res(r.group) ? h('span', { class: `pill ${res(r.group).ok ? 'ok' : 'bad'}`, style: 'margin-left:6px' }, res(r.group).ok ? `✓ ${plural(res(r.group).count, 'row')}` : `✕ ${res(r.group).error}`) : null),
      Object.entries(r.items).map(([k, item]) => h('span', { class: 'row', style: 'flex-wrap:nowrap;gap:6px;padding-left:12px' },
        h('span', { class: 'small' }, k, ' ', h('code', {}, J.selectorToPath(item) || item)),
        h('button', { type: 'button', class: 'link sm', 'data-key': `fl-json-rmrow-${r.group}-${k}`, onclick: () => changePage(context, (fl, pg) => removeRowField(pg.draft, r.group, k), `${k} removed from ${r.group}`) }, 'Remove'))))));
}

/** The editor for a page that reads data: its address, a sample fetched from this tab, the tree, the picks and the test. */
function jsonEditor(context, flow, page, issues) {
  const { act } = context;
  const step = pageOf(flow, page.parent);
  const r = requestsOf(step).find((x) => x.pageId === page.id);
  const back = async () => { await openAt(flow.id, page.parent && pageOf(flow, page.parent) ? page.parent : null); act.refresh(); };
  const tpl = r ? requestUrl(flow, r) : page.url;
  const names = templateVars(tpl);
  const label = (k) => (k === 'ref' ? REF_LABEL : flow.fields[k]?.label || k);
  const sample = flowUi.jsonSample?.pageId === page.id ? flowUi.jsonSample : null;
  const res = flowUi.jsonResult?.pageId === page.id ? flowUi.jsonResult : null;
  const lib = flowLib(flow, context.data.lib);
  const isPersonal = isPersonalFor(lib);
  const picked = new Map(picksOf(page.draft).filter((p) => p.key).map((p) => [p.selector, flow.fields[p.key]?.label || p.key]));
  const onPick = (el) => {
    const pick = globalThis.PowerLoaderJson.pickFor(el, { isPersonal });
    flowUi.jsonPick = { ...pick, multiline: !!el.querySelector('br') };
    act.render();
  };
  const mapped = Object.keys(page.draft.profile.fields || {}).length > 0;
  return [
    h('button', { type: 'button', class: 'link sm', 'data-key': 'fl-back', style: 'align-self:flex-start', onclick: back }, `← ${step?.name || flow.name || 'The flow'}`),
    h('div', { class: 'card stack', style: 'border:2px solid var(--magic);gap:8px', 'data-key': 'fl-json' },
      h('div', { class: 'ctx-head' }, h('span', { class: 'pill magic' }, 'Data to fetch'), h('strong', {}, page.name)),
      h('p', { class: 'small muted' }, `${step?.name || 'A fetch step'} fetches this data (JSON) without showing it. Fetch a sample from this tab, then pick the values the forms need from it.`),
      h('label', { class: 'field small' }, 'Name',
        h('input', { type: 'text', 'data-key': 'fl-page-name', value: page.name, onchange: (e) => changePage(context, (f, p) => renamePage(p, e.target.value)) })),
      h('p', { class: 'small' }, 'Address: ', h('code', {}, tpl || 'none yet'), h('br'), h('span', { class: 'muted' }, 'Change it on the step. Sends Accept: application/json, and reads only a response that says it’s JSON.')),
      names.length ? h('div', { class: 'stack', style: 'gap:4px' },
        h('span', { class: 'small' }, 'Sample values for its address (kept only while you edit, never saved or exported):'),
        names.map((k) => h('label', { class: 'field small' }, label(k),
          h('input', { type: 'text', 'data-key': `fl-sample-${k}`, value: flowUi.samples[k] || '', oninput: (e) => { flowUi.samples[k] = e.target.value; } })))) : null,
      h('div', { class: 'row' },
        h('button', { type: 'button', class: sample ? 'sm' : 'primary sm', 'data-key': 'fl-json-fetch', onclick: () => fetchJsonSample(context, flow, page) }, sample ? (testedNow(page.draft) && page.draft.tested.ok ? 'Try another record' : 'Fetch the sample again') : 'Fetch a sample')),
      res ? h('p', { class: `small ${res.ok ? 'ok' : 'warn'}`, role: 'status', 'data-key': 'fl-json-result' }, res.text) : null),
    sample ? h('div', { class: 'card stack', style: 'gap:8px' },
      h('h3', {}, 'The sample'),
      h('p', { class: 'small muted' }, 'Only on this computer, until you close this page. Values are shown here for you to pick; none of them goes into the template.'),
      h('div', { 'data-scroll': 'json-tree', style: 'max-height:320px;overflow:auto' },
        jsonTree(sample.doc, { state: flowUi.jsonTree, picked, selected: flowUi.jsonPick?.path || null, isPersonal, onPick, onChange: () => act.render() })),
      jsonPickCard(context, flow, page)) : null,
    h('div', { class: 'card stack', style: 'gap:8px' },
      h('h3', {}, 'What it reads'),
      jsonPicksList(context, flow, page),
      mapped ? [testLine(page),
        h('div', { class: 'row' }, h('button', { type: 'button', class: 'primary sm', 'data-key': 'fl-json-test', disabled: !sample, title: sample ? undefined : 'Fetch a sample first', onclick: () => testJsonSample(context, flow, page) }, 'Test on the sample'))] : null),
    problemsList(context, flow, issues.filter((i) => i.pageId === page.id), { title: 'This page’s checks', page: true }),
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'sm', 'data-key': 'fl-page-done', onclick: back }, 'Back to the step')),
  ];
}

/** A request as it will be sent: the site written out, each {name} named, what it sends, the page that reads it. */
function requestPreviewLine(flow, r) {
  const pv = requestPreview(flow, r);
  if (pv.each) return h('p', { class: 'small', 'data-key': `fl-rq-${r.id}-preview` }, h('code', {}, pv.method), ' ', pv.text);
  return h('p', { class: 'small', 'data-key': `fl-rq-${r.id}-preview` },
    h('code', {}, pv.method), ' ', h('b', {}, pv.site || 'no site yet'), h('code', {}, pv.path), h('br'),
    `Sends: ${pv.sends.length ? `${pv.sends.map((x) => `${x.label}, from the case`).join('; ')}, in the address` : 'nothing from the case'}`,
    ` · ${pv.data ? 'Reads data (JSON) with' : 'Read with'} ${pv.page || 'no page yet'}`);
}

/** A list of links in the fetch step's editor: the list's page and field, the maximum, and the page that reads each link. */
function listEditorRow(context, flow, page, r, i, issues) {
  const { act } = context;
  const child = pageOf(flow, r.pageId);
  const listPage = pageOf(flow, r.each.pageId);
  const lists = linkLists(listPage);
  const id = `fl-rq-${r.id}`;
  return h('div', { class: 'stack', style: 'gap:4px;border-top:1px solid var(--border);padding-top:6px', 'data-key': id },
    h('div', { class: 'row between', style: 'flex-wrap:nowrap' }, h('b', {}, `${i + 1}. ${r.name || 'Every link in a list'}`), child ? pageStatus(flow, child, issues) : null),
    h('label', { class: 'field small' }, 'Name (what the links are, such as Messages)',
      h('input', { type: 'text', 'data-key': `${id}-name`, value: r.name, onchange: (e) => change(context, (f) => setRequest(f, page.id, r.id, { name: e.target.value })) })),
    h('label', { class: 'field small' }, 'The list on this page',
      h('span', { class: 'hint' }, `Lists ${listPage?.name || 'the list’s page'} reads that have an href column.`),
      h('select', { 'data-key': `${id}-list`, disabled: !lists.length, onchange: (e) => change(context, (f) => setRequest(f, page.id, r.id, { list: e.target.value })) },
        lists.length ? [h('option', { value: '', selected: !r.each.list }, 'Choose a list'), ...lists.map((k) => h('option', { value: k, selected: r.each.list === k }, k))] : h('option', { value: '' }, 'Make the list’s page first'))),
    h('label', { class: 'field small' }, `At most (1 to ${FETCH_LIMITS.perList})`,
      h('input', { type: 'number', min: '1', max: String(FETCH_LIMITS.perList), 'data-key': `${id}-max`, value: String(r.each.max), onchange: (e) => change(context, (f) => setRequest(f, page.id, r.id, { max: Number(e.target.value) })) })),
    requestPreviewLine(flow, r),
    h('div', { class: 'row', style: 'gap:10px' },
      listPage ? h('button', { type: 'button', class: 'sm', 'data-key': `${id}-list-page`, onclick: async () => { await openAt(flow.id, listPage.id); act.refresh(); } }, listPage.draft ? 'Edit the list’s page' : 'Make the list’s page') : null,
      child ? h('button', { type: 'button', class: 'sm', 'data-key': `${id}-page`, onclick: async () => { await openAt(flow.id, child.id); act.refresh(); } }, child.draft ? 'Edit the page each link opens' : 'Make the page each link opens') : null,
      h('button', {
        type: 'button', class: 'link sm danger', 'data-key': `${id}-rm`,
        onclick: async () => { if (await confirmDialog({ title: `Stop fetching ${r.name || 'these links'}?`, text: 'Its two pages and what you mapped on them are removed too.', confirm: 'Remove it', danger: true })) change(context, (f) => removeRequest(f, page.id, r.id), 'Removed'); },
      }, 'Remove')));
}

/** What the step's card lists after a run: the rows of a type whose values match, and markers on the page. */
function showEditor(context, flow, page) {
  const sh = page.fetch?.show || null;
  const save = (patch) => changePage(context, (f, p) => setShow(p, { ...(p.fetch?.show || { type: '', where: {}, label: '', columns: [] }), ...patch }), 'Saved');
  const where = Object.entries(sh?.where || {}).map(([k, v]) => `${k} = ${v}`).join('\n');
  return h('div', { class: 'card stack', style: 'gap:6px', 'data-key': 'fl-show' },
    h('h3', {}, 'After a run, list'),
    h('label', { class: 'row small', style: 'gap:6px' },
      h('input', { type: 'checkbox', 'data-key': 'fl-show-on', checked: !!sh, onchange: (e) => (e.target.checked ? save({}) : changePage(context, (f, p) => setShow(p, null), 'Saved')) }),
      'List the rows that match, on the step’s card'),
    sh ? [
      h('label', { class: 'field small' }, 'Heading, such as Open urgent referrals', h('input', { type: 'text', 'data-key': 'fl-show-label', value: sh.label, onchange: (e) => save({ label: e.target.value }) })),
      h('label', { class: 'field small' }, 'Type of row (its @type)', h('input', { type: 'text', 'data-key': 'fl-show-type', value: sh.type, onchange: (e) => save({ type: e.target.value.trim() }) })),
      h('label', { class: 'field small' }, 'Rows where (one “field = value” a line, exact matches only)',
        h('textarea', { rows: 3, 'data-key': 'fl-show-where', onchange: (e) => save({ where: Object.fromEntries(e.target.value.split('\n').map((l) => l.split('=').map((x) => x.trim())).filter(([k, v]) => k && v !== undefined)) }) }, where)),
      h('label', { class: 'field small' }, 'Columns to show (field names, with commas)', h('input', { type: 'text', 'data-key': 'fl-show-columns', value: (sh.columns || []).join(', '), onchange: (e) => save({ columns: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) }) })),
      h('label', { class: 'field small' }, 'Marker on each matching row of the page (fixed words, optional)', h('input', { type: 'text', 'data-key': 'fl-show-mark-text', value: sh.mark?.text || '', onchange: (e) => save({ mark: e.target.value.trim() ? { row: sh.mark?.row || '', key: sh.mark?.key || '', rowKey: sh.mark?.rowKey || '', ...(sh.mark || {}), text: e.target.value.trim() } : undefined }) })),
      sh.mark ? h('div', { class: 'row', style: 'gap:6px' },
        h('label', { class: 'field small' }, 'Rows on the page', h('input', { type: 'text', 'data-key': 'fl-show-mark-row', value: sh.mark.row, placeholder: '#inbox tbody tr', onchange: (e) => save({ mark: { ...sh.mark, row: e.target.value.trim() } }) })),
        h('label', { class: 'field small' }, 'Row’s attribute', h('input', { type: 'text', 'data-key': 'fl-show-mark-rowkey', value: sh.mark.rowKey, placeholder: '@data-id', onchange: (e) => save({ mark: { ...sh.mark, rowKey: e.target.value.trim() } }) })),
        h('label', { class: 'field small' }, 'Equals the field', h('input', { type: 'text', 'data-key': 'fl-show-mark-key', value: sh.mark.key, onchange: (e) => save({ mark: { ...sh.mark, key: e.target.value.trim() } }) }))) : null,
    ] : null);
}

/** A fetch step: the page it starts from, the pages it fetches (each a page to clip), and where it goes next. */
function fetchEditor(context, flow, page, issues) {
  const { ui, act } = context;
  const onWeb = isWeb(ui.page?.url);
  const here = !!(page.match && ui.page?.url && E.matchUrl(page.match, ui.page.url));
  const reqs = requestsOf(page);
  const others = journeyOf(flow).filter((p) => p.id !== page.id);
  const fieldOpts = [['ref', REF_LABEL], ...Object.entries(flow.fields).map(([k, f]) => [k, f.label])];
  const use = () => change(context, (f) => bindPage(f, page.id, { url: ui.page.url, title: ui.page.title }), `${page.name}: starts on ${ui.page.title || ui.page.url}`);
  const row = (r, i) => {
    const child = pageOf(flow, r.pageId);
    const id = `fl-rq-${r.id}`;
    if (isListRequest(r)) return listEditorRow(context, flow, page, r, i, issues);
    return h('div', { class: 'stack', style: 'gap:4px;border-top:1px solid var(--border);padding-top:6px', 'data-key': id },
      h('div', { class: 'row between', style: 'flex-wrap:nowrap' }, h('b', {}, `${i + 1}. ${r.name || child?.name || 'Page'}`), child ? pageStatus(flow, child, issues) : h('span', { class: 'pill bad' }, 'No page')),
      h('label', { class: 'field small' }, 'Name',
        h('input', { type: 'text', 'data-key': `${id}-name`, value: r.name, onchange: (e) => change(context, (f) => setRequest(f, page.id, r.id, { name: e.target.value })) })),
      h('label', { class: 'field small' }, 'Address',
        h('span', { class: 'hint' }, 'Write the site out in full; put values from the case in the path or query with {name}, such as /clients/{clientId}. It must be on the same site as this step’s page.'),
        h('input', { type: 'text', 'data-key': `${id}-url`, value: r.url || '', placeholder: requestUrl(flow, r) || 'https://…', spellcheck: 'false', onchange: (e) => change(context, (f) => setRequest(f, page.id, r.id, { url: e.target.value })) })),
      h('div', { class: 'row small', style: 'gap:10px' },
        h('label', { class: 'sr', for: `${id}-ins` }, 'Put a value in the address'),
        h('select', {
          id: `${id}-ins`, 'data-key': `${id}-ins`, class: 'sm', style: 'width:auto',
          onchange: (e) => { const k = e.target.value; if (k) change(context, (f) => setRequest(f, page.id, r.id, { url: `${requestUrl(f, r) || ''}{${k}}` }), `Added {${k}} to the address`); },
        }, h('option', { value: '' }, 'Put a value in it…'), fieldOpts.map(([k, lbl]) => h('option', { value: k }, `${lbl} {${k}}`))),
        h('label', { class: 'row small', style: 'flex-wrap:nowrap;gap:4px' },
          h('input', { type: 'checkbox', 'data-key': `${id}-required`, checked: r.required !== false, onchange: (e) => change(context, (f) => setRequest(f, page.id, r.id, { required: e.target.checked })) }),
          'Needed for the step to be done')),
      requestPreviewLine(flow, r),
      h('div', { class: 'row', style: 'gap:10px' },
        child ? h('button', { type: 'button', class: 'sm', 'data-key': `${id}-page`, onclick: async () => { await openAt(flow.id, child.id); act.refresh(); } }, child.draft ? 'Edit its page' : 'Make its page') : null,
        h('button', {
          type: 'button', class: 'link sm danger', 'data-key': `${id}-rm`,
          onclick: async () => { if (await confirmDialog({ title: `Stop fetching ${r.name || 'this page'}?`, text: 'Its page and what you mapped on it are removed too.', confirm: 'Remove it', danger: true })) change(context, (f) => removeRequest(f, page.id, r.id), 'Removed'); },
        }, 'Remove')));
  };
  return [
    h('button', { type: 'button', class: 'link sm', 'data-key': 'fl-back', style: 'align-self:flex-start', onclick: async () => { await openAt(flow.id); act.refresh(); } }, `← ${flow.name || 'The flow'}`),
    h('div', { class: 'card stack', style: 'border:2px solid var(--magic);gap:8px' },
      h('div', { class: 'ctx-head' }, h('span', { class: 'pill' }, ROLES.fetch), h('strong', {}, page.name)),
      h('label', { class: 'field small' }, 'Name',
        h('input', { type: 'text', 'data-key': 'fl-page-name', value: page.name, onchange: (e) => changePage(context, (f, p) => renamePage(p, e.target.value)) })),
      h('p', { class: 'small muted' }, 'The caseworker presses this step’s button on its page. Power Loader then fetches each page below from the same system, reads it with that page’s template, and adds the values to the case. Nothing is fetched until they press it.'),
      page.url ? h('p', { class: 'small' }, 'Starts on: ', h('code', {}, page.url), here ? h('span', { class: 'pill ok', style: 'margin-left:6px' }, '✓ This tab') : null) : null,
      here ? null : h('div', { class: 'row' },
        h('button', { type: 'button', class: page.url ? 'sm' : 'primary sm', 'data-key': 'fl-bind', disabled: !onWeb || !!ui.info?.blocked?.navigate, title: ui.info?.blocked?.navigate ? BLOCKED_SITE : undefined, onclick: use }, page.url ? 'Start on the current page instead' : 'Use the current page'),
        onWeb ? h('span', { class: 'small' }, 'This tab: ', h('b', {}, ui.page.title || ui.page.url)) : h('span', { class: 'small muted' }, 'Go to the page this step starts on.'))),
    h('div', { class: 'card stack', style: 'gap:8px' },
      h('h3', {}, `Pages it fetches · ${reqs.filter((r) => !isListRequest(r)).length} of at most ${MAX_REQUESTS}${reqs.some(isListRequest) ? ', and a list of links' : ''}`),
      reqs.length ? reqs.map(row) : h('p', { class: 'small muted' }, 'None yet. Add one, then make its page on the real page, as for a page to clip.'),
      h('div', { class: 'row', style: 'gap:10px' },
        reqs.filter((r) => !isListRequest(r)).length < MAX_REQUESTS ? h('button', {
          type: 'button', class: 'link sm', 'data-key': 'fl-rq-add',
          onclick: async () => { const made = await change(context, (f) => addRequest(f, page.id), 'Page to fetch added'); if (made?.page) { await openAt(flow.id, made.page.id); act.refresh(); } },
        }, '+ One page') : null,
        reqs.some(isListRequest) ? null : h('button', {
          type: 'button', class: 'link sm', 'data-key': 'fl-rq-add-list',
          onclick: async () => { const made = await change(context, (f) => addListRequest(f, page.id), 'List of links added: make the page with the list first'); if (made?.listPage) { await openAt(flow.id, made.listPage.id); act.refresh(); } },
        }, '+ Every link in a list on this page'))),
    reqs.some(isListRequest) ? showEditor(context, flow, page) : null,
    h('div', { class: 'card stack', style: 'gap:6px' },
      h('h3', {}, 'Then'),
      h('label', { class: 'field small' }, 'Once the pages are fetched, the caseworker goes to',
        h('select', { 'data-key': 'fl-then-to', onchange: (e) => changePage(context, (f, p) => setThen(p, { to: e.target.value })) },
          h('option', { value: '', selected: !page.fetch?.then?.to }, 'An address, or nowhere'), others.map((p) => h('option', { value: p.id, selected: page.fetch?.then?.to === p.id }, `${p.name} (${ROLES[p.role].toLowerCase()})`)))),
      h('label', { class: 'field small' }, 'Address (optional)',
        h('input', { type: 'text', 'data-key': 'fl-then-url', value: page.fetch?.then?.url || '', placeholder: thenUrl(flow, page) || 'https://…', onchange: (e) => changePage(context, (f, p) => setThen(p, { url: e.target.value })) })),
      h('span', { class: 'small muted' }, 'The step shows a button to go there once its pages are in the case. It never opens by itself.')),
    stepEditor(context, flow, page),
    problemsList(context, flow, issues.filter((i) => i.pageId === page.id || reqs.some((r) => r.pageId === i.pageId)), { title: 'This step’s checks', page: true }),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'sm', 'data-key': 'fl-page-done', onclick: async () => { await openAt(flow.id); act.refresh(); } }, 'Back to the flow'),
      h('button', {
        type: 'button', class: 'link sm danger', 'data-key': 'fl-page-rm',
        onclick: async () => {
          if (!await confirmDialog({ title: `Remove ${page.name} from the flow?`, text: 'The pages it fetches, and what you mapped on them, go too.', confirm: 'Remove it', danger: true })) return;
          await change(context, (f) => removePage(f, page.id), 'Removed from the flow');
          await openAt(flow.id);
          act.refresh();
        },
      }, 'Remove from the flow')),
  ];
}

// ------------------------------------------------------------------ pages to visit

function guideEditor(context, flow, page, issues) {
  const { ui, act } = context;
  const onWeb = isWeb(ui.page?.url);
  const here = !!(page.match && ui.page?.url && E.matchUrl(page.match, ui.page.url));
  const use = async () => {
    const values = ui.info?.access ? await pageValues(ui.page.id).catch(() => []) : [];
    await change(context, (f) => bindPage(f, page.id, { url: ui.page.url, title: ui.page.title, values }), `${page.name}: using ${ui.page.title || ui.page.url}`);
  };
  const go = async () => {
    const raw = document.getElementById('fl-goto-url')?.value.trim() || page.url;
    let url;
    try { url = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`).href; } catch { announce('Paste the page’s address, such as https://cases.example.gov.uk/queue'); return; }
    await change(context, (f) => bindPage(f, page.id, { url, title: '' }));
    await act.openUrl(url);
  };
  return [
    h('button', { type: 'button', class: 'link sm', 'data-key': 'fl-back', style: 'align-self:flex-start', onclick: async () => { await openAt(flow.id); act.refresh(); } }, `← ${flow.name || 'The flow'}`),
    h('div', { class: 'card', style: 'border:2px solid var(--magic)' },
      h('div', { class: 'ctx-head' }, h('span', { class: 'pill' }, ROLES.guide), h('strong', {}, page.name)),
      h('label', { class: 'field small' }, 'Name',
        h('input', { type: 'text', 'data-key': 'fl-page-name', value: page.name, onchange: (e) => changePage(context, (f, p) => renamePage(p, e.target.value)) })),
      h('p', { class: 'small muted' }, 'Power Loader doesn’t read or fill this page. It shows the caseworker what to do here and where to go next.'),
      page.url ? h('p', { class: 'small' }, 'Address: ', h('code', {}, page.url), here ? h('span', { class: 'pill ok', style: 'margin-left:6px' }, '✓ This tab') : null) : null,
      here ? null : h('div', { class: 'notice magic stack', style: 'gap:8px' },
        h('button', { type: 'button', class: 'primary', 'data-key': 'fl-bind', style: 'align-self:flex-start', disabled: !onWeb || !!ui.info?.blocked?.navigate, title: ui.info?.blocked?.navigate ? BLOCKED_SITE : undefined, onclick: use }, page.url ? 'Use the current page instead' : 'Use the current page'),
        onWeb && ui.info?.blocked?.navigate ? h('span', { class: 'small', 'data-key': 'fl-blocked' }, `${BLOCKED_SITE}.`) : null,
        onWeb ? h('span', { class: 'small' }, 'This tab: ', h('b', {}, ui.page.title || ui.page.url)) : h('span', { class: 'small muted' }, 'This tab isn’t showing a web page.'),
        h('label', { class: 'small', for: 'fl-goto-url' }, 'Or paste its address:'),
        h('div', { class: 'row', style: 'flex-wrap:nowrap' },
          h('input', { type: 'url', id: 'fl-goto-url', 'data-key': 'fl-goto-url', value: page.url || '', placeholder: 'https://…', onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } } }),
          h('button', { type: 'button', class: 'sm', 'data-key': 'fl-goto', onclick: go }, 'Use and go to it')))),
    chooseEditor(context, flow, page),
    stepEditor(context, flow, page),
    notesEditor(context, flow, page),
    problemsList(context, flow, issues.filter((i) => i.pageId === page.id), { title: 'This page’s checks', page: true }),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'sm', 'data-key': 'fl-page-done', onclick: async () => { await openAt(flow.id); act.refresh(); } }, 'Back to the flow'),
      h('button', {
        type: 'button', class: 'link sm danger', 'data-key': 'fl-page-rm',
        onclick: async () => {
          if (!await confirmDialog({ title: `Remove ${page.name} from the flow?`, text: 'Its instructions and links go too, and links to it from other pages no longer open it.', confirm: 'Remove it', danger: true })) return;
          await change(context, (f) => removePage(f, page.id), 'Removed from the flow');
          await openAt(flow.id);
          act.refresh();
        },
      }, 'Remove from the flow')),
  ];
}

// ------------------------------------------------------------------ emails and screenshots

// A step that isn't a web page: its name, its own card, its instructions and links, its checks.
function offPageEditor(context, flow, page, issues, card) {
  const { act } = context;
  return [
    h('button', { type: 'button', class: 'link sm', 'data-key': 'fl-back', style: 'align-self:flex-start', onclick: async () => { await openAt(flow.id); act.refresh(); } }, `← ${flow.name || 'The flow'}`),
    h('div', { class: 'card stack', style: 'border:2px solid var(--magic);gap:8px' },
      h('div', { class: 'ctx-head' }, h('span', { class: 'pill' }, ROLES[page.role]), h('strong', {}, page.name)),
      h('label', { class: 'field small' }, 'Name',
        h('input', { type: 'text', 'data-key': 'fl-page-name', value: page.name, onchange: (e) => changePage(context, (f, p) => renamePage(p, e.target.value)) })),
      card),
    stepEditor(context, flow, page),
    problemsList(context, flow, issues.filter((i) => i.pageId === page.id), { title: 'This step’s checks', page: true }),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'sm', 'data-key': 'fl-page-done', onclick: async () => { await openAt(flow.id); act.refresh(); } }, 'Back to the flow'),
      h('button', {
        type: 'button', class: 'link sm danger', 'data-key': 'fl-page-rm',
        onclick: async () => {
          if (!await confirmDialog({ title: `Remove ${page.name} from the flow?`, text: 'Its instructions and links go too.', confirm: 'Remove it', danger: true })) return;
          await change(context, (f) => removePage(f, page.id), 'Removed from the flow');
          await openAt(flow.id);
          act.refresh();
        },
      }, 'Remove from the flow')),
  ];
}

const fieldChoices = (flow) => [['ref', REF_LABEL], ...Object.entries(flow.fields).map(([k, f]) => [k, f.label])];

// The email's parts, each a template: {ref} or {fieldKey} is filled in from the case when the step is shown.
function emailCard(context, flow, page) {
  const e = page.email || {};
  const part = (k, label, hint, attrs = {}, tag) => h('label', { class: 'field small' }, label,
    hint ? h('span', { class: 'hint' }, hint) : null,
    draftInput(`fl-em-${page.id}-${k}`, { value: e[k] || '', ...attrs, onchange: (ev) => changePage(context, (f, p) => setEmail(p, { [k]: ev.target.value }), 'Email saved') }, tag));
  return h('div', { class: 'stack', style: 'gap:6px' },
    h('p', { class: 'small muted' }, 'Power Loader doesn’t send it. On the Case tab the caseworker sees it written from the case, and opens it in their email app to check and send.'),
    part('to', 'To', 'Addresses, separated by commas, or {field} for an email address the case holds. Leave it empty for the caseworker to choose.', { type: 'text', placeholder: 'e.g. housing.team@council.gov.uk, {landlordEmail}' }),
    part('cc', 'Cc (optional)', '', { type: 'text' }),
    part('subject', 'Subject', '', { type: 'text', placeholder: 'e.g. Referral {ref}: {lastName}' }),
    part('body', 'Text', '', { rows: 8, placeholder: 'e.g. Dear {landlordName},\n\nWe have received a discretionary housing payment application from your tenant at {address}…' }, 'textarea'),
    h('div', { class: 'row small', style: 'gap:10px' },
      h('label', { class: 'sr', for: 'fl-em-ins' }, 'Put a value in the text'),
      h('select', {
        id: 'fl-em-ins', 'data-key': 'fl-em-ins', class: 'sm', style: 'width:auto',
        onchange: (ev) => {
          const k = ev.target.value;
          if (!k) return;
          const typed = document.querySelector(`[data-key="fl-em-${page.id}-body"]`)?.value ?? e.body ?? '';
          clearDraft(`fl-em-${page.id}-body`);
          changePage(context, (f, p) => setEmail(p, { body: `${typed}{${k}}` }), `Added {${k}} to the text`);
        },
      }, h('option', { value: '' }, 'Put a value in the text…'), fieldChoices(flow).map(([k, lbl]) => h('option', { value: k }, `${lbl} {${k}}`)))),
    h('p', { class: 'small muted' }, `Names it can use: ${VAR_HINT(flow)}. Dates and amounts are written as a person reads them.`));
}

// What a screenshot step reads: each value is the text after its label, or the first text with its shape.
function scanCard(context, flow, page) {
  const reads = readsOf(page);
  const taken = new Set(reads.map((r) => r.key));
  const choices = fieldChoices(flow).filter(([k]) => !taken.has(k) && !flow.fields[k]?.manual);
  return h('div', { class: 'stack', style: 'gap:6px' },
    h('p', { class: 'small muted' }, 'On the Case tab the caseworker snips the system’s screen (Win+Shift+S) and pastes it, or selects a region of the tab. OCR on this computer reads it, and they check each value before it’s added.'),
    reads.length ? reads.map((r) => {
      const id = `fl-rd-${r.key}`;
      const name = r.key === 'ref' ? REF_LABEL : flow.fields[r.key]?.label || r.key;
      return h('div', { class: 'stack', style: 'gap:4px;border-top:1px solid var(--border);padding-top:6px' },
        h('div', { class: 'row between' }, h('b', {}, name),
          h('button', { type: 'button', class: 'link sm danger', 'data-key': `${id}-rm`, onclick: () => changePage(context, (f, p) => removeRead(p, r.key), `${name} removed`) }, 'Remove')),
        h('div', { class: 'row', style: 'flex-wrap:nowrap' },
          h('label', { class: 'field small', style: 'flex:1' }, 'Text before it',
            h('input', { type: 'text', 'data-key': `${id}-anchor`, value: r.anchor || '', placeholder: r.key === 'ref' ? 'e.g. Case ref:' : `e.g. ${name}:`, onchange: (e) => changePage(context, (f, p) => setRead(p, r.key, { anchor: e.target.value })) })),
          h('label', { class: 'field small', style: 'flex:1' }, 'Its shape (optional)',
            h('input', { type: 'text', 'data-key': `${id}-pattern`, value: r.pattern || '', placeholder: r.key === 'ref' ? 'e.g. CM-\\d{6}' : 'a regular expression', spellcheck: 'false', onchange: (e) => changePage(context, (f, p) => setRead(p, r.key, { pattern: e.target.value })) }))));
    }) : h('p', { class: 'small muted' }, 'It reads nothing yet.'),
    choices.length ? h('div', { class: 'row small' },
      h('label', { class: 'sr', for: 'fl-rd-add' }, 'Add a value to read'),
      h('select', {
        id: 'fl-rd-add', 'data-key': 'fl-rd-add', class: 'sm', style: 'width:auto',
        onchange: (e) => { const k = e.target.value; if (k) changePage(context, (f, p) => addRead(p, k), 'Added'); },
      }, h('option', { value: '' }, '+ Add a value to read…'), choices.map(([k, lbl]) => h('option', { value: k }, lbl)))) : null,
    h('p', { class: 'small muted' }, 'With neither, the value is found next to its field’s name. With only a shape, such as CM-\\d{6} for a case number, the first text anywhere with that shape is used; put the part you want in brackets to take only that.'));
}

// ------------------------------------------------------------------ the caseworker's steps

const VAR_HINT = (flow) => linkVars(flow).map((k) => `{${k}}`).join(' ');

/** What the caseworker does on this page and the links that take them on: shown on the Case tab at this step. */
/**
 * A page to visit can be where the caseworker chooses the case, such as a work queue: the page they open
 * next, whose address has {ref} in it, gives the case reference, so nobody types it.
 */
function chooseEditor(context, flow, page) {
  const next = choosesFrom(flow, page);
  const options = flow.pages.filter((p) => p.id !== page.id && p.role !== 'email' && p.role !== 'scan' && !p.parent);
  return h('div', { class: 'card stack', style: 'gap:6px' },
    h('label', { class: 'row small', style: 'gap:6px' },
      h('input', {
        type: 'checkbox', 'data-key': 'fl-choose', checked: !!page.choose,
        onchange: (e) => changePage(context, (f, p) => {
          if (!e.target.checked) { setChoose(p, null); return; }
          // The page after this one in the order is the likely one: the case page.
          const order = journeyOf(f);
          const after = order[order.findIndex((x) => x.id === p.id) + 1];
          setChoose(p, (after && after.role !== 'email' && after.role !== 'scan' ? after : options[0])?.id || null);
        }, e.target.checked ? 'This page is where the caseworker chooses the case' : 'Saved'),
      }),
      'This page is where the caseworker chooses the case'),
    page.choose ? h('label', { class: 'field small' }, 'Which page’s address holds the case reference?',
      h('span', { class: 'hint' }, 'When the caseworker opens that page, Power Loader takes the reference from its address. The address needs {ref} in it, such as …/case-{ref}.html.'),
      h('select', { 'data-key': 'fl-choose-next', onchange: (e) => changePage(context, (f, p) => setChoose(p, e.target.value), 'Saved') },
        options.map((p) => h('option', { value: p.id, selected: next?.id === p.id }, `${p.name}${pageAddress(p) ? ` (${pageAddress(p).replace(/^https?:\/\//, '')})` : ''}`)))) : null);
}

/** This step is needed: always, or only when the case has no (or has a) value of one field or the case reference. */
function whenEditor(context, flow, page) {
  const w = page.step?.when || null;
  const how = w ? w.is : 'always';
  const choices = fieldChoices(flow);
  const save = (is, field) => changePage(context, (f, p) => setStepWhen(p, is === 'always' ? null : { is, field }), is === 'always' ? 'The step is always needed' : 'Saved: Next passes over it when it isn’t needed');
  return h('div', { class: 'row small', style: 'gap:8px', 'data-key': 'fl-when', role: 'group', 'aria-label': 'When the step is needed' },
    h('label', { for: `fl-when-is-${page.id}` }, 'This step is needed'),
    h('select', { id: `fl-when-is-${page.id}`, 'data-key': 'fl-when-is', class: 'sm', style: 'width:auto', onchange: (e) => save(e.target.value, w?.field || choices.find(([k]) => k !== 'ref')?.[0] || 'ref') },
      h('option', { value: 'always', selected: how === 'always' }, 'always'),
      h('option', { value: 'missing', selected: how === 'missing' }, 'only when the case has no …'),
      h('option', { value: 'present', selected: how === 'present' }, 'only when the case has …')),
    w ? [h('label', { class: 'sr', for: `fl-when-field-${page.id}` }, 'Which value'),
      h('select', { id: `fl-when-field-${page.id}`, 'data-key': 'fl-when-field', class: 'sm', style: 'width:auto', onchange: (e) => save(w.is, e.target.value) },
        choices.map(([k, lbl]) => h('option', { value: k, selected: w.field === k }, lbl)))] : null);
}

function stepEditor(context, flow, page) {
  const st = page.step || { text: '', links: [] };
  const others = journeyOf(flow).filter((p) => p.id !== page.id);
  const fieldOpts = [['ref', 'Case reference'], ...Object.entries(flow.fields).map(([k, f]) => [k, f.label])];
  const linkRow = (l, i) => {
    const id = `fl-ln-${l.id}`;
    const url = linkUrl(flow, l);
    return h('div', { class: 'stack', style: 'gap:4px;border-top:1px solid var(--border);padding-top:6px' },
      h('div', { class: 'row', style: 'flex-wrap:nowrap' },
        h('label', { class: 'field small', style: 'flex:1' }, 'Words on the button',
          h('input', { type: 'text', 'data-key': `${id}-label`, value: l.label, placeholder: l.to ? `Open ${pageOf(flow, l.to)?.name || 'the page'}` : 'e.g. Search for the tenant', onchange: (e) => changePage(context, (f, p) => setLink(p, l.id, { label: e.target.value })) })),
        h('label', { class: 'field small', style: 'flex:1' }, 'Opens',
          h('select', {
            'data-key': `${id}-to`,
            onchange: (e) => changePage(context, (f, p) => { const to = e.target.value; setLink(p, l.id, { to, ...(to && !l.url ? { url: pageAddress(pageOf(f, to)) } : {}) }); }),
          }, h('option', { value: '', selected: !l.to }, 'Another address'), others.map((p) => h('option', { value: p.id, selected: l.to === p.id }, `${p.name} (${ROLES[p.role].toLowerCase()})`))))),
      h('label', { class: 'field small' }, 'Address',
        h('span', { class: 'hint' }, l.to && !l.url ? 'The page’s own address. Type one to put a value from the case in it.' : 'Put a value from the case in it with {name}, such as ?q={lastName}.'),
        h('input', { type: 'text', 'data-key': `${id}-url`, value: l.url || '', placeholder: url || 'https://…', onchange: (e) => changePage(context, (f, p) => setLink(p, l.id, { url: e.target.value.trim() })) })),
      h('div', { class: 'row small', style: 'gap:10px' },
        h('label', { class: 'sr', for: `${id}-ins` }, 'Put a value in the address'),
        h('select', {
          id: `${id}-ins`, 'data-key': `${id}-ins`, class: 'sm', style: 'width:auto',
          onchange: (e) => { const k = e.target.value; if (!k) return; changePage(context, (f, p) => setLink(p, l.id, { url: `${linkUrl(f, l) || ''}{${k}}` }), `Added {${k}} to the address`); },
        }, h('option', { value: '' }, 'Put a value in it…'), fieldOpts.map(([k, lbl]) => h('option', { value: k }, `${lbl} {${k}}`))),
        h('button', { type: 'button', class: 'link sm danger', 'data-key': `${id}-rm`, onclick: () => changePage(context, (f, p) => removeLink(p, l.id), 'Link removed') }, `Remove link ${i + 1}`)));
  };
  return h('div', { class: 'card stack', style: 'gap:8px' },
    h('h3', {}, 'What the caseworker does here'),
    h('span', { class: 'small muted' }, 'Shown on the Case tab when they reach this step, with the links. Write it so they don’t need the written guidance again.'),
    h('label', { class: 'sr', for: `fl-step-${page.id}` }, `Instructions for ${page.name}`),
    whenEditor(context, flow, page),
    draftInput(`fl-step-${page.id}`, { id: `fl-step-${page.id}`, rows: 4, value: st.text || '', placeholder: page.role === 'guide' ? 'e.g. Pick the oldest case marked “New”, note its case number, and open the client.' : page.role === 'email' ? 'e.g. Attach the signed form before you send it.' : page.role === 'scan' ? 'e.g. Open the case in CaseWorks, then snip the header with the case reference.' : page.role === 'input' ? 'e.g. Check the address matches the referral, then clip the page.' : 'e.g. Fill the form, check every box, then submit it.', onchange: (e) => changePage(context, (f, p) => setStepText(p, e.target.value), 'Instructions saved') }, 'textarea'),
    h('h4', {}, 'Links to the next step'),
    (st.links || []).length ? (st.links || []).map(linkRow) : h('p', { class: 'small muted' }, 'No links yet. A link can open another page of the flow, or any address with values from the case in it.'),
    h('button', { type: 'button', class: 'link sm', 'data-key': 'fl-ln-add', style: 'align-self:flex-start', onclick: () => changePage(context, (f, p) => { const next = journeyOf(f)[journeyOf(f).findIndex((x) => x.id === p.id) + 1]; addLink(p, next ? { to: next.id, url: '' } : {}); }, 'Link added') }, '+ Add a link'),
    h('p', { class: 'small muted' }, `Names an address can use: ${VAR_HINT(flow)}. {ref} is the case reference.`));
}

// ------------------------------------------------------------------ auto-clip

const DELAY_LABELS = { 0: 'As soon as it loads', 500: 'Half a second after it loads', 1000: '1 second after it loads', 2000: '2 seconds after it loads', 5000: '5 seconds after it loads' };

/** With auto-clip on, how long to wait on this page: for a page that fetches its data after it loads. */
// ------------------------------------------------------------------ closed parts of the page (reveal rules)

/**
 * A value in a closed part of the page (an accordion, a tab not chosen): the author opens it by hand, and the
 * class names that changed are offered as the template's reveal rule. Nobody types a selector. Power Loader
 * only ever adds or removes those class names, opens a <details> or removes hidden; it never clicks.
 */
function revealCard(context, flow, page, here) {
  const { ui, act } = context;
  const rules = page.draft?.profile.reveal || [];
  const picks = picksOf(page.draft).filter((p) => p.key && p.selector);
  const r = flowUi.reveal?.pageId === page.id ? flowUi.reveal : null;
  const ruleWords = (x) => [
    x.addClass?.length ? `add ${x.addClass.join(', ')}` : '', x.removeClass?.length ? `remove ${x.removeClass.join(', ')}` : '',
    x.open ? 'open it' : '', x.unhide ? 'show it' : ''].filter(Boolean).join(' and ');
  const start = async () => {
    const key = (flowUi.reveal?.pageId === page.id && flowUi.reveal.key) || picks[0]?.key;
    const pick = picks.find((p) => p.key === key);
    if (!pick) return;
    try {
      const got = await ask(ui.page.id, { type: 'powerloader:revealBefore', spec: pick.selector });
      if (!got?.found) { announce('That value isn’t on this page'); return; }
      flowUi.reveal = { pageId: page.id, key, step: 'opening' };
      announce('Open that part of the page yourself, then press I’ve opened it');
    } catch (e) { announce(describeError(e)); }
    act.render();
  };
  const after = async () => {
    try {
      const got = await ask(ui.page.id, { type: 'powerloader:revealAfter' });
      flowUi.reveal = { ...r, step: 'offer', offer: got };
    } catch (e) { announce(describeError(e)); flowUi.reveal = null; }
    act.render();
  };
  const use = () => changePage(context, (f, p) => {
    const all = [...(p.draft.profile.reveal || []), ...(r.offer.rules || [])];
    // The same element twice: its class names together, once.
    const merged = [];
    for (const x of all) {
      const same = merged.find((m) => m.selector === x.selector);
      if (!same) { merged.push(structuredClone(x)); continue; }
      for (const k of ['addClass', 'removeClass']) if (x[k]) same[k] = [...new Set([...(same[k] || []), ...x[k]])];
      if (x.open) same.open = true;
      if (x.unhide) same.unhide = true;
    }
    p.draft.profile.reveal = merged.slice(0, 20);
  }, 'Power Loader will open that part when it needs to show the value').then(() => { flowUi.reveal = null; act.render(); });
  return h('div', { class: 'card stack', style: 'gap:6px', 'data-key': 'fl-reveal' },
    h('h4', {}, 'Values in a closed part of the page'),
    rules.length ? h('ul', { class: 'plain stack small', style: 'gap:4px' }, rules.map((x, i) => h('li', { class: 'row between', style: 'flex-wrap:nowrap' },
      h('span', { style: 'min-width:0;overflow-wrap:anywhere' }, `To show a value, ${ruleWords(x)} on `, h('code', {}, x.selector)),
      h('button', { type: 'button', class: 'link sm', 'data-key': `fl-reveal-rm-${i}`, onclick: () => changePage(context, (f, p) => { p.draft.profile.reveal = (p.draft.profile.reveal || []).filter((_, j) => j !== i); if (!p.draft.profile.reveal.length) delete p.draft.profile.reveal; }, 'Rule removed') }, 'Remove')))) : null,
    !here ? h('p', { class: 'small muted' }, 'Open this page in the tab to add one.')
      : !r || r.step === 'pick' ? h('div', { class: 'stack', style: 'gap:4px' },
        h('p', { class: 'small' }, 'Is a value in an accordion or a tab that is closed when the page opens? Choose it, then open that part of the page yourself.'),
        h('div', { class: 'row', style: 'flex-wrap:nowrap' },
          h('label', { class: 'sr', for: 'fl-reveal-key' }, 'Value'),
          h('select', { id: 'fl-reveal-key', 'data-key': 'fl-reveal-key', class: 'sm', disabled: !picks.length, onchange: (e) => { flowUi.reveal = { pageId: page.id, key: e.target.value, step: 'pick' }; } },
            picks.map((p) => h('option', { value: p.key, selected: r?.key === p.key }, flow.fields[p.key]?.label || p.key))),
          h('button', { type: 'button', class: 'sm', 'data-key': 'fl-reveal-start', disabled: !picks.length, onclick: start }, 'It’s in a closed part')))
        : r.step === 'opening' ? h('div', { class: 'notice magic stack', style: 'gap:6px', role: 'status' },
          h('p', { class: 'small' }, h('b', {}, `Open the part of the page ${flow.fields[r.key]?.label || r.key} is in, by hand. `), 'Power Loader watches only which class names change.'),
          h('div', { class: 'row' },
            h('button', { type: 'button', class: 'sm primary', 'data-key': 'fl-reveal-done', onclick: after }, 'I’ve opened it'),
            h('button', { type: 'button', class: 'link sm', 'data-key': 'fl-reveal-cancel', onclick: () => { flowUi.reveal = null; act.render(); } }, 'Cancel')))
          : r.offer?.rules?.length ? h('div', { class: 'notice stack', style: 'gap:6px', 'data-key': 'fl-reveal-offer' },
            r.offer.rules.map((x) => h('p', { class: 'small' }, `To show this, Power Loader will ${ruleWords(x)} on `, r.offer.name ? h('i', {}, r.offer.name) : h('code', {}, x.selector), '.')),
            r.offer.shown ? null : h('p', { class: 'small muted' }, 'The value still has no size on the page: check that part is open.'),
            h('div', { class: 'row' },
              h('button', { type: 'button', class: 'sm primary', 'data-key': 'fl-reveal-use', onclick: use }, 'Use this'),
              h('button', { type: 'button', class: 'link sm', 'data-key': 'fl-reveal-drop', onclick: () => { flowUi.reveal = null; act.render(); } }, 'Don’t use it')))
            : h('div', { class: 'notice warn stack', style: 'gap:6px', 'data-key': 'fl-reveal-none' },
              h('p', { class: 'small' }, 'No class name changed, so Power Loader can’t open this part by itself. The caseworker will be told to open it.'),
              h('button', { type: 'button', class: 'link sm', style: 'align-self:flex-start', onclick: () => { flowUi.reveal = null; act.render(); } }, 'OK')));
}

function clipDelayCard(context, page) {
  return h('div', { class: 'card stack', style: 'gap:6px' },
    h('label', { class: 'field small' }, 'With auto-clip on, clip this page',
      h('span', { class: 'hint' }, 'Wait a little if the page fills in its values after it loads (from the system’s own requests), so the clip doesn’t miss them. Auto-clip is in the caseworker’s Settings.'),
      h('select', { 'data-key': 'fl-clip-delay', onchange: (e) => changePage(context, (f, p) => setAutoClipDelay(p, Number(e.target.value)), 'Saved') },
        CLIP_DELAYS.map((ms) => h('option', { value: String(ms), selected: (page.autoClipDelay || 0) === ms }, DELAY_LABELS[ms])))));
}

// ------------------------------------------------------------------ notes on the page

async function chooseNoteTarget(context, noteId) {
  const { ui } = context;
  await stopFlowPicking();
  announce('Click where the note goes on the page. Esc cancels.');
  const got = await pickNoteTarget(ui.page.id).catch(() => null);
  if (got?.selector) await changePage(context, (f, p) => setNote(p, noteId, { selector: got.selector }), `The note goes by ${got.label || 'that element'}`);
  else context.act.refresh();
}

/** Notes the flow draws on this page for the caseworker: where, how, its look and what it says. */
function notesEditor(context, flow, page) {
  const { ui } = context;
  const here = onPage(page, ui.page?.url) && ui.info?.access;
  const list = notesOf(page);
  const result = here && noteState.mode === 'preview' ? noteState.result : null;
  const fieldOpts = [['ref', 'Case reference'], ...Object.entries(flow.fields).map(([k, f]) => [k, f.label])];
  const row = (n, i) => {
    const id = `fl-nt-${n.id}`;
    const found = result ? (result.shown.includes(n.id) ? ['ok', '✓ Shown on this page'] : ['warn', 'Not found on this page']) : null;
    return h('div', { class: 'stack', style: 'gap:4px;border-top:1px solid var(--border);padding-top:6px' },
      h('div', { class: 'row between' }, h('b', {}, `Note ${i + 1}`), found ? h('span', { class: `pill ${found[0]}` }, found[1]) : null),
      h('label', { class: 'field small' }, 'Where it goes',
        h('span', { class: 'hint' }, 'Next to what this finds: a CSS selector or label(…), as in a page’s template. Inside a table cell or list item; after anything else.'),
        h('div', { class: 'row', style: 'flex-wrap:nowrap' },
          h('input', { type: 'text', 'data-key': `${id}-sel`, value: n.selector, spellcheck: 'false', placeholder: 'e.g. #person label(Rent arrears)', onchange: (e) => changePage(context, (f, p) => setNote(p, n.id, { selector: e.target.value })) }),
          h('button', { type: 'button', class: 'sm', 'data-key': `${id}-pick`, disabled: !here, title: here ? undefined : 'Open this page in the tab first', onclick: () => chooseNoteTarget(context, n.id) }, 'Choose on the page'))),
      h('div', { class: 'row', style: 'flex-wrap:nowrap' },
        h('label', { class: 'field small', style: 'flex:1' }, 'How it shows',
          h('select', { 'data-key': `${id}-type`, onchange: (e) => changePage(context, (f, p) => setNote(p, n.id, { type: e.target.value })) },
            Object.entries(ANNOTATION_TYPES).map(([k, lbl]) => h('option', { value: k, selected: n.type === k }, lbl)))),
        h('label', { class: 'field small', style: 'flex:1' }, 'Look',
          h('select', { 'data-key': `${id}-preset`, onchange: (e) => changePage(context, (f, p) => setNote(p, n.id, { style: e.target.value })) },
            Object.entries(STYLE_PRESETS).map(([css, lbl]) => h('option', { value: css, selected: (n.style || '') === css }, lbl)),
            Object.prototype.hasOwnProperty.call(STYLE_PRESETS, n.style || '') ? null : h('option', { value: n.style, selected: true }, 'Your own style')))),
      h('label', { class: 'field small' }, 'Style (CSS)',
        h('span', { class: 'hint' }, 'How the note looks, such as color:#d4351c; font-weight:bold. Colours, fonts, borders and spacing only.'),
        h('input', { type: 'text', 'data-key': `${id}-style`, value: n.style || '', spellcheck: 'false', onchange: (e) => changePage(context, (f, p) => setNote(p, n.id, { style: e.target.value })) })),
      h('label', { class: 'field small' }, 'What it says',
        h('span', { class: 'hint' }, 'Text with <b>, <i>, <p>, <ul>/<li>, <br> and links (<a href="https://…">). {name} puts in a value from the case, as text.'),
        draftInput(`${id}-html`, { rows: 4, value: n.html || '', spellcheck: 'true', placeholder: 'e.g. <b>Check the arrears:</b> the referral says {arrears}.', onchange: (e) => changePage(context, (f, p) => setNote(p, n.id, { html: e.target.value }), 'Note saved') }, 'textarea')),
      h('div', { class: 'row small', style: 'gap:10px' },
        h('label', { class: 'sr', for: `${id}-ins` }, 'Put a value in the note'),
        h('select', {
          id: `${id}-ins`, 'data-key': `${id}-ins`, class: 'sm', style: 'width:auto',
          onchange: (e) => {
            const k = e.target.value;
            if (!k) return;
            const typed = document.querySelector(`[data-key="${id}-html"]`)?.value ?? n.html ?? '';
            clearDraft(`${id}-html`);
            changePage(context, (f, p) => setNote(p, n.id, { html: `${typed}{${k}}` }), `Added {${k}} to the note`);
          },
        }, h('option', { value: '' }, 'Put a value in it…'), fieldOpts.map(([k, lbl]) => h('option', { value: k }, `${lbl} {${k}}`))),
        h('button', { type: 'button', class: 'link sm danger', 'data-key': `${id}-rm`, onclick: () => changePage(context, (f, p) => removeNote(p, n.id), 'Note removed') }, `Remove note ${i + 1}`)));
  };
  return h('div', { class: 'card stack', style: 'gap:8px' },
    h('h3', {}, 'Notes on the page'),
    h('span', { class: 'small muted' }, 'Shown on this page while a case from the flow is open, filled in from the case: what to check here, a warning, a value to compare. Each note says it’s from Power Loader.'),
    list.length ? list.map(row) : h('p', { class: 'small muted' }, 'No notes yet.'),
    h('button', { type: 'button', class: 'link sm', 'data-key': 'fl-nt-add', style: 'align-self:flex-start', disabled: list.length >= 20, onclick: () => changePage(context, (f, p) => addNote(p), 'Note added') }, '+ Add a note to the page'),
    list.length ? h('p', { class: 'small muted' }, here ? 'Previewed on this page, with the fields’ names in place of values.' : 'Open this page in the tab to see the notes on it.') : null);
}

/** Write the steps with the AI from the guidance and the pages: only steps with no instructions yet are filled. */
async function askSteps(context, flow) {
  if (!aiReady(context.data.settings)) { toAiSettings(context); return; }
  const pages = journeyOf(flow).map((p) => ({ id: p.id, role: ROLES[p.role], name: p.name, url: pageAddress(p) }));
  const ai = { ...context, lib: flowLib(flow, context.data.lib) };
  await runAi(ai, 'flowSteps', { guidance: flow.guidance, pages }, async (out) => {
    const n = await updateFlow(flow.id, (f) => {
      let wrote = 0;
      for (const st of out.steps) {
        const p = pageOf(f, st.page);
        if (!p) continue;
        const had = !!p.step?.text?.trim();
        if (!had && st.text) { setStepText(p, st.text); wrote++; }
        // Guidance that says "only if" becomes a condition rather than a sentence.
        if (st.when && !p.step?.when && (st.when.field === 'ref' || f.fields[st.when.field])) setStepWhen(p, st.when);
        for (const l of st.links) if (!(p.step?.links || []).some((x) => x.to === l.to && x.url === l.url)) addLink(p, l);
      }
      return wrote;
    });
    announce(`The AI wrote instructions for ${plural(n, 'step')}${n < out.steps.length ? '; your own instructions are kept' : ''}. Check each step and its links.`);
  });
}

function stepsSection(context, flow, issues) {
  const order = journeyOf(flow);
  const bad = (p) => issues.some((i) => i.pageId === p.id && i.code.startsWith('link'));
  return h('div', { class: 'stack', style: 'gap:6px' },
    h('div', { class: 'sec-title' }, h('span', {}, 'The caseworker’s steps'), h('span', { class: 'small' }, 'in the order they take them')),
    h('p', { class: 'small muted' }, 'A case from this flow shows each step on the Case tab: what to do there and links to the next page, with values from the case in them.'),
    h('ol', { class: 'plain stack', style: 'gap:6px' }, order.map((p, i) => h('li', { class: 'fcard flow' },
      h('span', { class: 'nm' }, `${i + 1}. ${p.name}`),
      h('span', { class: 'meta' }, `${ROLES[p.role]} · ${p.step?.text?.trim() ? 'with instructions' : 'no instructions yet'}${p.step?.links?.length ? ` · ${plural(p.step.links.length, 'link')}` : ''}${choosesFrom(flow, p) ? ` · Sets the case reference from the address of ${choosesFrom(flow, p).name}` : ''}`, bad(p) ? h('span', { class: 'pill bad', style: 'margin-left:4px' }, 'link problem') : null),
      h('span', { class: 'acts' },
        h('button', { type: 'button', class: 'sm icon', 'data-key': `fl-up-${p.id}`, 'aria-label': `Move ${p.name} earlier`, disabled: i === 0, onclick: () => change(context, (f) => moveStep(f, p.id, -1)) }, '↑'),
        h('button', { type: 'button', class: 'sm icon', 'data-key': `fl-down-${p.id}`, 'aria-label': `Move ${p.name} later`, disabled: i === order.length - 1, onclick: () => change(context, (f) => moveStep(f, p.id, 1)) }, '↓'),
        h('button', { type: 'button', class: 'sm', 'data-key': `fl-step-edit-${p.id}`, 'aria-label': `Edit the step ${p.name}`, onclick: async () => { await openAt(flow.id, p.id); context.act.refresh(); setTimeout(() => document.getElementById(`fl-step-${p.id}`)?.scrollIntoView({ block: 'center' }), 50); } }, 'Edit'))))),
    flow.guidance?.trim() ? h('div', { class: 'stack', style: 'gap:2px' },
      h('button', { type: 'button', class: 'sm magic', 'data-key': 'fl-steps-ai', style: 'align-self:flex-start', disabled: context.aiBusy, onclick: () => askSteps(context, flow) }, context.aiBusy ? [h('span', { class: 'spinner' }), ' Waiting for the AI…'] : '✦ Write the steps from the guidance'),
      h('span', { class: 'small muted' }, 'Sends your guidance and the pages’ names and link shapes. Steps you’ve written are kept.')) : null);
}

// ------------------------------------------------------------------ timelines

function timelinesSection(context, flow, issues) {
  const list = flow.timelines || [];
  return h('div', { class: 'stack', style: 'gap:6px' },
    h('div', { class: 'sec-title' }, h('span', {}, 'Timelines'), h('span', { class: 'small' }, 'optional')),
    h('p', { class: 'small muted' }, 'Choose which dates the case’s timeline shows: series of periods, such as employments and tenancies, as coloured bars, and single dates as pointers.'),
    list.map((t) => {
      const errors = issues.filter((i) => i.timelineId === t.id && i.level === 'error').length;
      return h('div', { class: 'fcard flow' },
        h('span', { class: 'nm' }, t.name),
        h('span', { class: 'meta' }, t.series.length ? t.series.map((x) => x.label).join(', ') : 'No series yet'),
        h('span', { class: 'acts' },
          h('span', { class: `pill ${errors ? 'bad' : t.series.length ? 'ok' : 'warn'}` }, errors ? plural(errors, 'problem') : t.series.length ? `✓ ${plural(t.series.length, 'series', 'series')}` : 'Empty'),
          h('button', { type: 'button', class: 'sm', 'data-key': `fl-tl-${t.id}`, 'aria-label': `Edit ${t.name}`, onclick: () => { flowUi.timeline = t.id; flowUi.seriesTest = {}; context.act.render(); } }, 'Edit')));
    }),
    h('button', {
      type: 'button', class: 'link sm', 'data-key': 'fl-tl-add', style: 'align-self:flex-start',
      onclick: async () => { const t = await change(context, (f) => addTimeline(f)); if (t) { flowUi.timeline = t.id; context.act.render(); } },
    }, '+ Add a timeline'));
}

const DATE_PARTS = { rows: 'The rows', label: 'Each row’s name', start: 'Start date', end: 'End date', at: 'Date' };

// Pick a cell on the page: its row becomes the series' rows (if not set yet) and the cell the part within a row.
async function pickPart(context, flow, t, s, part) {
  const { ui } = context;
  const page = pageOf(flow, s.source.pageId);
  if (!pageOnTab(context, page)) { announce(`Go to ${page?.name || 'the page'} in this tab first`); return; }
  try {
    await startPicking(ui.page.id, [], {}, 'values');
    announce(`Click ${part === 'label' ? 'a row’s name' : part === 'rows' ? 'anything in one of the rows' : `a ${DATE_PARTS[part].toLowerCase()}`} on the page. Esc cancels.`);
    const got = await pickAnyElement(ui.page.id);
    if (!got) { announce('Picking cancelled'); return; }
    const split = splitRowSelector(got.selector);
    if (!split) { announce('That isn’t in a repeating row, such as a table row. Pick a cell in the table, or type the selectors.'); return; }
    const change2 = part === 'rows' ? { rows: split.rows } : { ...(s.source.rows ? {} : { rows: split.rows }), [part]: split.cell };
    await change(context, (f) => setSeries(f, t.id, s.id, { source: change2 }), part === 'rows' ? `Rows: ${split.rows}` : `${DATE_PARTS[part]}: ${split.cell}`);
  } catch (e) { announce(`Couldn’t pick: ${describeError(e)}`); } finally { await stopPicking(ui.page.id); context.act.refresh(); }
}

const pageOnTab = ({ ui }, page) => !!(page?.draft && ui.info?.access && pageMatches(page, ui.page?.url, E.matchUrl));

// Read the series on the page open now, as a clip would: how many rows, and the first few.
async function testSeries(context, s) {
  const { ui } = context;
  try {
    const snap = await captureTab(ui.page.id);
    const doc = parseSnapshot(snap.html, document);
    const out = E.extract(doc, { name: 'Test', match: '*', fields: { rows: seriesSpec(s) } }, { baseUrl: ui.page.url });
    const rows = (out.data.rows || []).filter((r) => r && (r.start || r.at));
    flowUi.seriesTest[s.id] = { at: Date.now(), count: rows.length, rows: rows.slice(0, 4), undated: (out.data.rows || []).length - rows.length };
    announce(rows.length ? `Found ${plural(rows.length, 'dated row')} on this page` : 'No dated rows found on this page');
  } catch (e) { flowUi.seriesTest[s.id] = { error: describeError(e) }; }
  context.act.render();
}

function seriesCard(context, flow, t, s) {
  const id = `fl-s-${s.id}`;
  const set = (ch, done) => change(context, (f) => setSeries(f, t.id, s.id, ch), done);
  const src = s.source;
  const inputs = pagesOf(flow, 'input');
  const dateFields = Object.entries(flow.fields).filter(([, f]) => f.type === 'date');
  const page = src.type === 'page' ? pageOf(flow, src.pageId) : null;
  const onTab = pageOnTab(context, page);
  const test = flowUi.seriesTest[s.id];
  const part = (k) => h('div', { class: 'stack', style: 'gap:2px' },
    h('label', { class: 'small', for: `${id}-${k}` }, DATE_PARTS[k], k === 'end' ? h('span', { class: 'muted' }, ' (optional: empty means ongoing)') : k === 'label' ? h('span', { class: 'muted' }, ` (optional: else “${s.label}”)`) : null),
    h('div', { class: 'row', style: 'flex-wrap:nowrap' },
      h('input', { type: 'text', id: `${id}-${k}`, 'data-key': `${id}-${k}`, value: src[k] || '', placeholder: k === 'rows' ? 'e.g. #history tbody tr' : 'e.g. td:nth-child(3)', onchange: (e) => set({ source: { [k]: e.target.value } }) }),
      h('button', { type: 'button', class: 'sm', 'data-key': `${id}-${k}-pick`, disabled: !onTab, title: onTab ? undefined : `Go to ${page?.name || 'the page'} to pick`, onclick: () => pickPart(context, flow, t, s, k) }, 'Pick')));
  const fieldSel = (k) => h('label', { class: 'field small' }, DATE_PARTS[k],
    h('select', { 'data-key': `${id}-${k}`, onchange: (e) => set({ source: { [k]: e.target.value } }) },
      h('option', { value: '', selected: !src[k] }, k === 'end' ? 'None: ongoing' : 'Choose a date field'),
      dateFields.map(([key, f]) => h('option', { value: key, selected: src[k] === key }, f.label))));
  return h('div', { class: 'card stack', style: `gap:6px;border-left:6px solid ${colourOf(s.colour)}` },
    h('div', { class: 'row', style: 'flex-wrap:nowrap' },
      h('label', { class: 'field small', style: 'flex:1' }, 'Name', h('input', { type: 'text', 'data-key': `${id}-name`, value: s.label, onchange: (e) => set({ label: e.target.value }) })),
      h('label', { class: 'field small' }, 'Drawn as', h('select', { 'data-key': `${id}-kind`, onchange: (e) => set({ kind: e.target.value }) }, Object.entries(SERIES_KINDS).map(([k, l]) => h('option', { value: k, selected: s.kind === k }, l))))),
    h('div', { class: 'row small', style: 'gap:10px' },
      h('label', { class: 'row', style: 'gap:4px;flex-wrap:nowrap' }, 'Colour',
        h('select', { 'data-key': `${id}-colour`, class: 'sm', style: 'width:auto', onchange: (e) => set({ colour: e.target.value }) },
          Object.keys(COLOURS).map((c) => h('option', { value: c, selected: s.colour === c }, c)), COLOURS[s.colour] ? null : h('option', { value: s.colour, selected: true }, s.colour)),
        h('input', { type: 'color', 'data-key': `${id}-hex`, 'aria-label': 'Your own colour', value: colourOf(s.colour), onchange: (e) => set({ colour: e.target.value }) })),
      s.kind === 'point' ? h('label', { class: 'row', style: 'gap:4px;flex-wrap:nowrap' }, 'Shape',
        h('select', { 'data-key': `${id}-shape`, class: 'sm', style: 'width:auto', onchange: (e) => set({ shape: e.target.value }) }, SHAPES.map((x) => h('option', { value: x, selected: s.shape === x }, x))))
        : h('label', { class: 'row', style: 'gap:4px;flex-wrap:nowrap' }, h('input', { type: 'checkbox', 'data-key': `${id}-gaps`, checked: s.gaps !== false, onchange: (e) => set({ gaps: e.target.checked }) }), 'Count it when finding gaps')),
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Where the dates come from' },
      h('button', { type: 'button', 'data-key': `${id}-src-page`, 'aria-pressed': String(src.type === 'page'), onclick: () => set({ type: 'page' }) }, 'Rows on a page'),
      h('button', { type: 'button', 'data-key': `${id}-src-fields`, 'aria-pressed': String(src.type === 'fields'), onclick: () => set({ type: 'fields' }) }, 'The flow’s date fields')),
    src.type === 'page' ? [
      h('label', { class: 'field small' }, 'Page to clip',
        h('select', { 'data-key': `${id}-page`, onchange: (e) => set({ source: { pageId: e.target.value } }) },
          h('option', { value: '', selected: !page }, 'Choose a page'), inputs.map((p) => h('option', { value: p.id, selected: p.id === src.pageId }, p.name)))),
      page ? h('p', { class: 'small muted' }, onTab ? 'Pick a cell in the table on the page: its row becomes the rows to read. Each row is one period or date.' : `Go to ${page.name} in this tab to pick on it, or type the selectors.`) : null,
      part('rows'), part('label'), s.kind === 'bar' ? [part('start'), part('end')] : part('at'),
      onTab && src.rows ? h('button', { type: 'button', class: 'sm', 'data-key': `${id}-test`, style: 'align-self:flex-start', onclick: () => testSeries(context, s) }, 'Test on this page') : null,
      test ? (test.error ? h('p', { class: 'error-text small' }, `Test failed: ${test.error}`) : h('div', { class: 'small stack', style: 'gap:2px', role: 'status' },
        h('span', { class: `pill ${test.count ? 'ok' : 'bad'}` }, test.count ? `✓ ${plural(test.count, 'dated row')}` : '✕ No dated rows'),
        test.undated ? h('span', { class: 'muted' }, `${plural(test.undated, 'row')} without a date ${test.undated === 1 ? 'is' : 'are'} left out (headers, empty rows).`) : null,
        test.rows.map((r) => h('span', {}, `${r.label || s.label}: ${r.at || `${r.start} – ${r.end || 'ongoing'}`}`)),
        h('span', { class: 'muted' }, 'Shown here only: nothing from the page is kept in the flow.'))) : null,
    ] : (dateFields.length ? (s.kind === 'bar' ? [fieldSel('start'), fieldSel('end')] : fieldSel('at')) : h('p', { class: 'small muted' }, 'The flow has no date fields yet. Set a field’s type to Date under Fields.')),
    h('button', { type: 'button', class: 'link sm danger', 'data-key': `${id}-rm`, style: 'align-self:flex-start', onclick: () => change(context, (f) => removeSeries(f, t.id, s.id), 'Series removed') }, `Remove ${s.label}`));
}

function timelineEditor(context, flow, t, issues) {
  const { act } = context;
  const back = () => { flowUi.timeline = null; act.render(); };
  return [
    h('button', { type: 'button', class: 'link sm', 'data-key': 'fl-tl-back', style: 'align-self:flex-start', onclick: back }, `← ${flow.name || 'The flow'}`),
    h('div', { class: 'card stack' },
      h('div', { class: 'ctx-head' }, h('span', { class: 'pill magic' }, 'Timeline'), h('strong', {}, t.name)),
      h('label', { class: 'field small' }, 'Name', h('input', { type: 'text', 'data-key': 'fl-tl-name', value: t.name, onchange: (e) => change(context, (f) => { const x = timelineOf(f, t.id); if (x) x.name = e.target.value.trim().slice(0, 80) || x.name; }) })),
      h('p', { class: 'small muted' }, 'The case’s timeline offers this one by name. Each series is a lane: bars for periods with a start and an end, pointers for single dates.')),
    t.series.map((s) => seriesCard(context, flow, t, s)),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'sm', 'data-key': 'fl-s-add-bar', onclick: () => change(context, (f) => addSeries(f, t.id, { kind: 'bar' }), 'Series added') }, '+ Add bars'),
      h('button', { type: 'button', class: 'sm', 'data-key': 'fl-s-add-point', onclick: () => change(context, (f) => addSeries(f, t.id, { kind: 'point' }), 'Series added') }, '+ Add pointers')),
    problemsList(context, flow, issues.filter((i) => i.timelineId === t.id), { title: 'This timeline’s checks', page: true }),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'sm', 'data-key': 'fl-tl-done', onclick: back }, 'Back to the flow'),
      h('button', {
        type: 'button', class: 'link sm danger', 'data-key': 'fl-tl-rm',
        onclick: async () => { if (!await confirmDialog({ title: `Delete ${t.name}?`, text: 'The case’s timeline won’t offer it any more.', confirm: 'Delete timeline', danger: true })) return; await change(context, (f) => removeTimeline(f, t.id), 'Timeline deleted'); back(); },
      }, 'Delete timeline')),
  ];
}

// ------------------------------------------------------------------ the tab

export function renderFlows(context) {
  const flow = currentFlow(context.data);
  if (!flow) return [addPageCard(context, null), listView(context)];
  const issues = validateFlow(flow, { access: context.data.access });
  const page = currentPage(context.data);
  const tl = flowUi.timeline && timelineOf(flow, flowUi.timeline);
  if (tl && !page) return timelineEditor(context, flow, tl, issues);
  return page ? pageEditor(context, flow, page, issues) : [addPageCard(context, flow), overview(context, flow, issues)];
}

// ------------------------------------------------------------------ Build: the page in view

const ADD_ROLES = [['input', 'A page to take data from'], ['output', 'A form to fill'], ['guide', 'A page to go through']];

/** The flow's page that is the page in view, if any (a page a fetch step fetches counts as its step's). */
export const flowPageHere = (flow, url) => (flow && url ? flow.pages.find((p) => onPage(p, url)) || null : null);

/**
 * Build: a page in view that isn't in the open flow is something to add to it, as a page to take data from,
 * a form to fill or a page to go through. Each makes the page with the tools the Flows tab already has.
 * after: the page the new step goes after in the caseworker's order (from a case, the step that was open).
 */
export function addPageCard(context, flow) {
  const { ui } = context;
  if (!isWeb(ui.page?.url) || ui.info?.kind === 'fullpage') return null;
  if (flow && flowPageHere(flow, ui.page.url)) return null;
  if (!flow) {
    return h('div', { class: 'notice magic', 'data-key': 'fl-add-here' },
      h('p', {}, 'Open a flow, or start a new one, to add this page.'));
  }
  // Building on a page the rules block is refused as clipping it would be, with the same words.
  if (ui.info?.blocked?.read) return blockedCard(ui.info);
  return h('div', { class: 'card stack', 'data-key': 'fl-add-here', style: 'gap:8px;border:2px solid var(--magic)' },
    h('h3', {}, `Add this page to ${flow.name || 'the flow'}`),
    h('p', { class: 'small' }, 'This tab: ', h('b', {}, ui.page.title || ui.page.url)),
    flowUi.addAfter && pageOf(flow, flowUi.addAfter) ? h('p', { class: 'small muted' }, `It goes after ${pageOf(flow, flowUi.addAfter).name}.`) : null,
    h('div', { class: 'row' }, ADD_ROLES.map(([role, label]) => h('button', {
      type: 'button', class: 'sm', 'data-key': `fl-add-here-${role}`,
      disabled: role === 'output' && !!ui.info?.blocked?.fill,
      title: role === 'output' && ui.info?.blocked?.fill ? BLOCKED_SITE : undefined,
      onclick: () => addPageHere(context, flow, role),
    }, label))),
    h('label', { class: 'check small' },
      h('input', { type: 'checkbox', 'data-key': 'fl-add-sometimes', checked: !!flowUi.addSometimes, onchange: (e) => { flowUi.addSometimes = e.target.checked; } }),
      h('span', {}, 'Only needed sometimes', h('br'), h('span', { class: 'muted' }, 'Then say when, in its step: This step is needed · only when the case has…'))));
}

async function addPageHere(context, flow, role) {
  const { ui } = context;
  const values = role !== 'guide' && ui.info?.access ? await pageValues(ui.page.id).catch(() => []) : [];
  const after = flowUi.addAfter;
  const made = await change(context, (f) => {
    const p = addPage(f, role);
    bindPage(f, p.id, { url: ui.page.url, title: ui.page.title, values });
    // The new step goes after the one that was open, or at the end.
    const order = journeyOf(f).map((x) => x.id).filter((id) => id !== p.id);
    const at = after && order.includes(after) ? order.indexOf(after) + 1 : order.length;
    order.splice(at, 0, p.id);
    f.journey = order;
    return p;
  }, `${ROLES[role]} added to ${flow.name || 'the flow'}`);
  if (!made) return;
  const sometimes = flowUi.addSometimes;
  Object.assign(flowUi, { addAfter: null, addSometimes: false });
  await openAt(flow.id, made.id);
  await context.act.refresh();
  // Only needed sometimes: the step's condition is where to go next.
  if (sometimes) document.querySelector('[data-key="fl-when-is"]')?.focus();
}

/** Build, arriving on a page of the open flow: that page opens in its editor, as Casework opens its step. */
export async function arriveInBuild(context) {
  const { ui, data } = context;
  const flow = currentFlow(data);
  // Once for each address the tab arrives at, so going back to the overview on the same page stays there.
  if (!isWeb(ui.page?.url) || flowUi.arrivedAt === ui.page.url) return;
  flowUi.arrivedAt = ui.page.url;
  // A timeline being edited stays open: its dates are picked on the page.
  if (ui.tab !== 'flows' || !flow || flowUi.timeline) return;
  const here = flowPageHere(flow, ui.page.url);
  if (!here || here.id === flowUi.page) return;
  // A page a fetch step fetches is made from its step's page (its sample is fetched there): it stays open.
  if (pageOf(flow, flowUi.page)?.parent === here.id) return;
  await stopFlowPicking();
  await openAt(flow.id, here.id);
}

/**
 * Casework → Build, from a step of the open case: the case's flow opens at that step's page. A flow from the
 * library is never changed in place (D18): it is copied to this computer first (or the copy made before is
 * used), and the sidebar says so. The open case stays open; Build never clips into it.
 */
export async function fixInBuild(context, stepId, { after = null, sometimes = false } = {}) {
  const { data, act } = context;
  const from = data.case?.library?.flow;
  if (!from) return null;
  let id = from.id;
  if (from.fromLibrary) {
    const mine = (data.flows || []).find((f) => f.copiedFrom?.path === from.fromLibrary.path);
    if (mine) { id = mine.id; announce(`Opened your copy of ${from.name || 'the flow'} on this computer.`); }
    else {
      try {
        const copy = copyLibraryFlow(data.lib, from.fromLibrary.path);
        await updateFlows((list) => { list.push(copy); });
        id = copy.id;
        announce(`${from.name || 'This flow'} is from your library, so a copy is made on this computer for you to change.`);
      } catch (e) { announce(describeError(e)); return null; }
    }
  } else if (!(data.flows || []).some((f) => f.id === id)) { announce('That flow is no longer on this computer'); return null; }
  const flows = (await browser.storage.local.get('flows')).flows || [];
  const flow = flows.find((f) => f.id === id);
  Object.assign(flowUi, { addAfter: after, addSometimes: sometimes });
  await openAt(id, stepId && flow && pageOf(flow, stepId) ? stepId : null);
  await act.setMode('build', { tab: 'flows' });
  return id;
}

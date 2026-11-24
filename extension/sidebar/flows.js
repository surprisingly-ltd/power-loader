// The Flows tab: author a flow (the forms a case fills, the pages it clips from, and the fields between
// them) on the real pages, with or without a connected library. Output pages come first, because the forms
// say what the flow has to collect. Each page's profile is made with the remote AI, by hand, or both: type
// a field's name, then click its box or value on the page. The flow is checked on every render, and every
// problem says how to fix it. A flow can also guide the caseworker: pages to visit (a case list, a search
// page), what to do on each page with templated links to the next, and timelines drawn from its dates.
// See docs/plans/flow-authoring.md and lib/flows.js.
/* global browser */
import { h, plural, time, announce, describeError, draftInput, clearDraft } from '../ui/dom.js';
import { confirmDialog } from '../ui/dialog.js';
import { saveFile } from '../ui/download.js';
import { contentHash } from '../lib/hash.js';
import { TYPES } from '../lib/fields.js';
import { judgeFillTest, judgeTest, picksOf, recordTest, testedNow } from '../lib/drafts.js';
import {
  addField, addLink, addPage, addSeries, addTimeline, applyFormAnswer, applyPageAnswer, bindPage, contract, exportBlocked, exportedNow, exportFlow, flowFileName, flowLib,
  flowFromLibrary, flowReady, flowSnapshot, guessType, importFlow, journeyOf, startable, keysOf, linkUrl, linkVars, mapPick, moveStep, newFlow, pageAddress, pageMatches, pageOf, pagesOf,
  removeField, removeLink, removePage, removeSeries, removeTimeline, renamePage, ROLES, SERIES_KINDS, seriesSpec, setField, setLink, setRequired, setSeries, setStepText,
  splitRowSelector, testCurrent, timelineOf, unmapKey, validateFlow,
} from '../lib/flows.js';
import { COLOURS, SHAPES, colourOf } from '../lib/journey.js';
import { parseSnapshot } from '../lib/ai/snapshot.js';
import {
  captureTab, describeForm, pageValues, pickAnyElement, probeTab, showPicked, startPicking, stopPickAny, stopPicking, updateFlow, updateFlows,
} from '../lib/core.js';
import { aiReady } from '../lib/ai/settings.js';
import { runAi } from './privacy.js';

const E = globalThis.PowerLoaderExtract;
const TYPE_LABELS = { text: 'Text', longtext: 'Long text', date: 'Date', money: 'Money', number: 'Number', nino: 'NI number', postcode: 'Postcode', phone: 'Phone', email: 'Email', choice: 'Choice', boolean: 'Yes or no' };

export const flowUi = {
  open: null, // the flow being edited
  page: null, // the page of it open in the page editor
  manual: false, // the manual tool is shown even before anything is mapped
  target: null, // the field waiting for its box or value on the page
  selected: null, // an element clicked on the page with no field waiting: { selector, value, label }
  aiKeys: null, // the fields a "Fix with AI" asked about, for the page's next ✦ request
  timeline: null, // the timeline open in the timeline editor
  seriesTest: {}, // series id → what a test on the page found: { at, rows: [{ label, start, end, at }], count } | { error }
  picking: false, tabId: null, url: null, candidates: [], form: null, probes: {}, overriding: false,
};

export async function loadFlowEditing() {
  const { editingFlow } = await browser.storage.session.get('editingFlow').catch(() => ({}));
  Object.assign(flowUi, { open: editingFlow?.open || null, page: editingFlow?.page || null });
}

async function openAt(open, page = null) {
  // Leaving a flow's overview: what's typed in its name and guidance is saved first.
  if (flowUi.open && !flowUi.page) await flushText(flowUi.open);
  if (open !== flowUi.open) { clearDraft('fl-name'); clearDraft('fl-guidance'); }
  Object.assign(flowUi, { open, page, timeline: null, manual: false, target: null, selected: null, aiKeys: page === flowUi.page ? flowUi.aiKeys : null, probes: {} });
  await browser.storage.session.set({ editingFlow: { open, page } }).catch(() => {});
}

const currentFlow = (data) => (data.flows || []).find((f) => f.id === flowUi.open) || null;
const currentPage = (data) => { const f = currentFlow(data); return f && flowUi.page ? pageOf(f, flowUi.page) : null; };
const isWeb = (url) => /^https?:/.test(url || '');
export const flowPicking = () => flowUi.picking;

// ------------------------------------------------------------------ the page: picking

const badgesOf = (flow, page) => Object.fromEntries((page.draft ? picksOf(page.draft) : []).filter((p) => p.key)
  .map((p) => [page.role === 'output' ? p.box : p.selector, flow.fields[p.key]?.label || p.key]));
const selectorsOf = (page) => (page.draft ? picksOf(page.draft).map((p) => (page.role === 'output' ? p.box : p.selector)) : []);

/** Keep the page's pick mode in step with the flow page being edited and the tab in view. */
export async function syncFlowPicking(context) {
  const { ui, data } = context;
  const flow = currentFlow(data);
  const page = currentPage(data);
  const here = !!(flow && page && ui.tab === 'flows' && ui.info?.access && pageMatches(page, ui.page?.url, E.matchUrl));
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
export async function startFromFlow(context, flow) {
  const { data, act } = context;
  if (data.case) { announce('Power Loader works on one case at a time. Finish or discard the open case first: the buttons are at the bottom of the Case tab.'); return; }
  const can = startable(flow);
  if (!can.ok) { announce(`Can’t start a case from ${flow.name || 'this flow'}: ${can.reason}`); return; }
  const doubts = [
    can.failed.length ? `${can.failed.join(', ')} failed ${can.failed.length === 1 ? 'its' : 'their'} last test.` : '',
    can.untested.length ? `${can.untested.join(', ')} ${can.untested.length === 1 ? 'hasn’t' : 'haven’t'} been tested on this computer.` : '',
    can.unmade.length ? `${can.unmade.join(', ')} ${can.unmade.length === 1 ? 'isn’t' : 'aren’t'} made yet, so ${can.unmade.length === 1 ? 'it' : 'they'} can’t be clipped.` : '',
  ].filter(Boolean);
  if (doubts.length && !await confirmDialog({
    title: `Start a case from ${flow.name || 'this flow'}?`,
    text: `${doubts.join(' ')} Values are still checked against their fields as you clip.`, confirm: 'Start case',
  })) return;
  await act.startFlow(flow.id);
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
      h('span', { class: 'hint' }, 'Copies the form, its fill profile and the page profiles that read its fields. Change it here; the library isn’t changed.')),
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

/** Flows on this computer, for the start screen: a case can start from any of them. */
export function flowStartCard(context) {
  const flows = context.data.flows || [];
  if (!flows.length) return null;
  return [
    h('div', { class: 'sec-title' }, h('span', {}, `Flows · ${flows.length}`), h('span', { class: 'small' }, 'on this computer')),
    h('div', { class: 'stack' }, flows.map((f) => h('div', { class: 'fcard flow' },
      h('span', { class: 'nm' }, f.name || 'Untitled flow'),
      h('span', { class: 'meta' }, `${pagesOf(f, 'output').map((p) => p.name).join(' + ')} · ${plural(pagesOf(f, 'input').length, 'page')} to clip`),
      h('span', { class: 'acts' }, h('button', { type: 'button', class: 'sm primary', 'data-key': `start-flow-${f.id}`, onclick: () => startFromFlow(context, f) }, 'Start'))))),
  ];
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
    flows.length ? h('div', { class: 'stack' }, flows.map((f) => {
      const issues = validateFlow(f);
      const errors = issues.filter((i) => i.level === 'error').length;
      return h('div', { class: 'fcard flow' },
        h('span', { class: 'nm' }, f.name || 'Untitled flow'),
        h('span', { class: 'meta' }, `${plural(pagesOf(f, 'output').length, 'form')} to fill · ${plural(pagesOf(f, 'input').length, 'page')} to clip${pagesOf(f, 'guide').length ? ` · ${plural(pagesOf(f, 'guide').length, 'page')} to visit` : ''} · ${plural(Object.keys(f.fields).length, 'field')}`),
        h('span', { class: 'acts' },
          h('span', { class: `pill ${errors ? 'bad' : 'ok'}` }, errors ? plural(errors, 'problem') : exportedNow(f) ? '✓ Exported' : '✓ Ready'),
          h('button', { type: 'button', class: 'sm', 'data-key': `fl-open-${f.id}`, 'aria-label': `Edit ${f.name || 'Untitled flow'}`, onclick: async () => { await openAt(f.id); context.act.refresh(); } }, 'Edit'),
          h('button', { type: 'button', class: 'sm primary', 'data-key': `fl-start-${f.id}`, disabled: !!data.case, title: data.case ? 'Finish or discard the open case first, with the buttons at the bottom of the Case tab' : undefined, onclick: () => startFromFlow(context, f) }, 'Start case')));
    })) : h('div', { class: 'card' }, h('p', { class: 'muted' }, 'No flows on this computer yet.')),
  ];
}

// ------------------------------------------------------------------ the overview

function pageStatus(flow, page, issues) {
  const mine = issues.filter((i) => i.pageId === page.id && i.level === 'error');
  if (page.role === 'guide') return mine.length ? h('span', { class: 'pill bad' }, plural(mine.length, 'problem')) : page.url ? h('span', { class: 'pill ok' }, `✓ ${page.step?.text ? 'With instructions' : 'Address set'}`) : h('span', { class: 'pill warn' }, 'No address yet');
  if (!page.draft) return h('span', { class: 'pill warn' }, 'Not made yet');
  if (mine.length) return h('span', { class: 'pill bad' }, plural(mine.length, 'problem'));
  return h('span', { class: 'pill ok' }, `✓ ${plural(keysOf(page).length, 'field')}, tested`);
}

function pageList(context, flow, role, issues) {
  const pages = pagesOf(flow, role);
  return h('div', { class: 'stack', style: 'gap:6px' },
    pages.map((p) => h('div', { class: 'fcard flow' },
      h('span', { class: 'nm' }, p.name),
      h('span', { class: 'meta' }, p.url ? p.url.replace(/^https?:\/\//, '') : 'No page chosen yet', p.draft ? ` · ${plural(keysOf(p).length, 'field')}` : '', p.step?.links?.length ? ` · ${plural(p.step.links.length, 'link')}` : ''),
      h('span', { class: 'acts' }, pageStatus(flow, p, issues),
        h('button', { type: 'button', class: 'sm primary', 'data-key': `fl-page-${p.id}`, 'aria-label': `Edit ${p.name}`, onclick: async () => { await openAt(flow.id, p.id); context.act.refresh(); } }, 'Edit')))),
    h('button', {
      type: 'button', class: 'link sm', 'data-key': `fl-add-${role}`, style: 'align-self:flex-start',
      onclick: () => change(context, (f) => addPage(f, role), role === 'output' ? 'Form added' : 'Page added'),
    }, role === 'output' ? '+ Add another form to fill' : role === 'input' ? '+ Add another page to clip' : pages.length ? '+ Add another page to visit' : '+ Add a page to visit'));
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
    contractTable(context, flow),
    stepsSection(context, flow, issues),
    timelinesSection(context, flow, issues),
    problemsList(context, flow, issues),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: flowReady(issues) ? 'primary' : '', 'data-key': 'fl-export', onclick: () => exportNow(context, flow, issues) }, 'Export'),
      h('button', { type: 'button', class: 'sm', 'data-key': 'fl-start', disabled: !!context.data.case, title: context.data.case ? 'Finish or discard the open case first, with the buttons at the bottom of the Case tab' : undefined, onclick: () => startFromFlow(context, flow) }, 'Start a case'),
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
        type: 'button', class: 'primary', 'data-key': 'fl-bind', style: 'align-self:flex-start', disabled: !onWeb,
        onclick: useCurrent,
      }, page.draft ? `Use the current ${kind} instead` : `Use the current ${kind}`),
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
    return h('div', { class: `stack${flowUi.target === key ? ' notice magic' : ''}`, 'data-field': key, style: 'gap:3px;border-top:1px solid var(--border);padding-top:6px' },
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

function pageEditor(context, flow, page, issues) {
  if (page.role === 'guide') return guideEditor(context, flow, page, issues);
  const { ui, act } = context;
  const here = !!(page.draft && pageMatches(page, ui.page?.url, E.matchUrl) && ui.info?.access);
  const mapped = page.draft ? picksOf(page.draft).filter((p) => p.key).length : 0;
  const showTool = here && (mapped || flowUi.manual);
  const aiKeys = flowUi.aiKeys?.length ? flowUi.aiKeys : null;
  const busy = context.aiBusy;
  const aiLabel = busy ? [h('span', { class: 'spinner' }), ' Waiting for the AI…']
    : aiKeys ? `✦ Find ${aiKeys.map((k) => flow.fields[k]?.label || k).join(', ')} with AI` : mapped ? '✦ Ask the AI again' : '✦ Generate the extraction profile with AI';
  const t = page.draft?.tested;
  return [
    h('button', { type: 'button', class: 'link sm', 'data-key': 'fl-back', style: 'align-self:flex-start', onclick: async () => { await stopFlowPicking(); await openAt(flow.id); act.refresh(); } }, `← ${flow.name || 'The flow'}`),
    h('div', { class: 'card', style: 'border:2px solid var(--magic)' },
      h('div', { class: 'ctx-head' }, h('span', { class: `pill ${page.role === 'output' ? 'acc' : 'magic'}` }, ROLES[page.role]), h('strong', {}, page.name)),
      h('label', { class: 'field small' }, 'Name',
        h('input', { type: 'text', 'data-key': 'fl-page-name', value: page.name, onchange: (e) => changePage(context, (f, p) => renamePage(p, e.target.value)) })),
      whereCard(context, flow, page),
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
    stepEditor(context, flow, page),
    problemsList(context, flow, issues.filter((i) => i.pageId === page.id || (page.role === 'input' && i.code === 'not-gathered')), { title: 'This page’s checks', page: true }),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'sm', 'data-key': 'fl-page-done', onclick: async () => { await stopFlowPicking(); await openAt(flow.id); act.refresh(); } }, 'Back to the flow'),
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
        h('button', { type: 'button', class: 'primary', 'data-key': 'fl-bind', style: 'align-self:flex-start', disabled: !onWeb, onclick: use }, page.url ? 'Use the current page instead' : 'Use the current page'),
        onWeb ? h('span', { class: 'small' }, 'This tab: ', h('b', {}, ui.page.title || ui.page.url)) : h('span', { class: 'small muted' }, 'This tab isn’t showing a web page.'),
        h('label', { class: 'small', for: 'fl-goto-url' }, 'Or paste its address:'),
        h('div', { class: 'row', style: 'flex-wrap:nowrap' },
          h('input', { type: 'url', id: 'fl-goto-url', 'data-key': 'fl-goto-url', value: page.url || '', placeholder: 'https://…', onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } } }),
          h('button', { type: 'button', class: 'sm', 'data-key': 'fl-goto', onclick: go }, 'Use and go to it')))),
    stepEditor(context, flow, page),
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

// ------------------------------------------------------------------ the caseworker's steps

const VAR_HINT = (flow) => linkVars(flow).map((k) => `{${k}}`).join(' ');

/** What the caseworker does on this page and the links that take them on: shown on the Case tab at this step. */
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
    draftInput(`fl-step-${page.id}`, { id: `fl-step-${page.id}`, rows: 4, value: st.text || '', placeholder: page.role === 'guide' ? 'e.g. Pick the oldest case marked “New”, note its case number, and open the client.' : page.role === 'input' ? 'e.g. Check the address matches the referral, then clip the page.' : 'e.g. Fill the form, check every box, then submit it.', onchange: (e) => changePage(context, (f, p) => setStepText(p, e.target.value), 'Instructions saved') }, 'textarea'),
    h('h4', {}, 'Links to the next step'),
    (st.links || []).length ? (st.links || []).map(linkRow) : h('p', { class: 'small muted' }, 'No links yet. A link can open another page of the flow, or any address with values from the case in it.'),
    h('button', { type: 'button', class: 'link sm', 'data-key': 'fl-ln-add', style: 'align-self:flex-start', onclick: () => changePage(context, (f, p) => { const next = journeyOf(f)[journeyOf(f).findIndex((x) => x.id === p.id) + 1]; addLink(p, next ? { to: next.id, url: '' } : {}); }, 'Link added') }, '+ Add a link'),
    h('p', { class: 'small muted' }, `Names an address can use: ${VAR_HINT(flow)}. {ref} is the case reference.`));
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
      h('span', { class: 'meta' }, `${ROLES[p.role]} · ${p.step?.text?.trim() ? 'with instructions' : 'no instructions yet'}${p.step?.links?.length ? ` · ${plural(p.step.links.length, 'link')}` : ''}`, bad(p) ? h('span', { class: 'pill bad', style: 'margin-left:4px' }, 'link problem') : null),
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
  if (!flow) return listView(context);
  const issues = validateFlow(flow);
  const page = currentPage(context.data);
  const tl = flowUi.timeline && timelineOf(flow, flowUi.timeline);
  if (tl && !page) return timelineEditor(context, flow, tl, issues);
  return page ? pageEditor(context, flow, page, issues) : overview(context, flow, issues);
}

/** A card for the start screen with no library: authoring works without one. */
export function authorCard(context) {
  return h('div', { class: 'card' },
    h('h2', {}, 'Or make a flow'),
    h('p', { class: 'muted' }, 'Writing the library? Make a flow: the forms a case fills, the pages it clips from and the fields between them, on the real pages. No library is needed, and you export the result for one.'),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'sm primary', 'data-key': 'start-new-flow', onclick: () => startNewFlow(context) }, 'New flow'),
      (context.data.flows || []).length ? h('button', { type: 'button', class: 'sm', 'data-key': 'start-flows', onclick: () => context.act.setTab('flows') }, `Your flows (${context.data.flows.length})`) : null));
}

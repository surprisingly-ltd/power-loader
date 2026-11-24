// Making and editing a profile draft in the sidebar, on the page it reads. Profiles are made target first:
// a form's fill profile maps its boxes to the form's fields; a gather page's profile is made for chosen target
// forms, whose fields become drop zones here. Every value on the page is outlined, and the rules (plus the
// on-device model, when it can run) match values to fields straight away. The caseworker corrects that by
// dragging a value from the page onto a field, by clicking a value and choosing its field, or with the
// override tool for something that wasn't outlined. Only a passing draft is used for clipping or filling.
/* global browser */
import { h, plural, time, announce, describeError } from '../ui/dom.js';
import { confirmDialog } from '../ui/dialog.js';
import {
  diffDraft, draftFromProfile, editDraft, editPicks, judgeFillTest, judgeTest, nameWithout, newFillDraft, newPageDraft, picksOf, PARTS,
  recordTest, setUse, testedNow,
} from '../lib/drafts.js';
import {
  captureTab, deleteDraft, describeForm, pageLabels, pageValues, pickAnyElement, probeTab, saveDraft, saveSettings, showPicked, startPicking, stopPickAny,
  stopPicking, updateDraft,
} from '../lib/core.js';
import { boxCandidates, categorise, filterFor, joinValues, matchFields, scorePair, targetFields } from '../lib/assist.js';
import { assist, assistReady, describeAssist, loadAssist, onAssistChange, refineWithModel } from '../lib/assist-client.js';
import { assistSource } from '../lib/model-fetch.js';
import { detect, patternsFor } from '../lib/privacy-detect.js';
import { modelReady, scanText } from '../lib/privacy-client.js';
import { aiReady } from '../lib/ai/settings.js';
import { runAi } from './privacy.js';

const E = globalThis.PowerLoaderExtract;
const DRAG_TYPE = 'application/x-powerloader-pick';
export const editor = {
  id: null, tabId: null, url: null, candidates: [], labels: [], form: null, probes: {}, picking: false,
  choosing: null, // the "what is this page for" step: { controls }
  selected: null, // the value chosen on the page (click or override tool), waiting for its field
  dragging: null, // the value being dragged from the page, if its drag data doesn't reach the sidebar
  overriding: false,
  matched: null, // { id, rules, total, model: { changed, agreed } | null }
};

export async function loadEditing() {
  const { editingDraft } = await browser.storage.session.get('editingDraft').catch(() => ({}));
  editor.id = editingDraft || null;
}

async function setEditing(id) {
  editor.id = id;
  editor.selected = null;
  editor.choosing = null;
  await browser.storage.session.set({ editingDraft: id }).catch(() => {});
}

export const editingDraft = (data) => data.drafts.find((d) => d.id === editor.id) || null;
const here = (d, page) => !!(page && E.matchUrl(d.profile.match, page.url));
const selectorsOf = (d) => picksOf(d).map((p) => p.selector);
let watching = false;

// The fields a draft is matched against: its target forms' fields, or for a fill draft its form's fields.
function fieldsFor(d, lib) {
  if (d.kind === 'fill') return targetFields(lib, [d.profile.form?.id], { manual: true });
  if (d.targets?.length) return targetFields(lib, d.targets);
  return Object.entries(lib.fields).filter(([, f]) => !f.manual).map(([key, f]) => ({ key, ...f }));
}

// { selector: "Field, Field" } for the badges on the page.
function badgesOf(d, lib) {
  const out = {};
  for (const p of picksOf(d)) if (p.key && p.selector) out[p.selector] = out[p.selector] ? `${out[p.selector]}, ${lib.fields[p.key]?.label || p.key}` : lib.fields[p.key]?.label || p.key;
  return out;
}

// Keep the page's pick mode in step with the draft being edited and the tab in view.
export async function syncPicking(context) {
  const { ui, data, lib } = context;
  // The Flows tab has the page to itself.
  const d = ui.tab === 'flows' ? null : editingDraft(data);
  const want = d && d.kind !== 'fill' && ui.info?.access && here(d, ui.page) ? ui.page.id : null;
  if (editor.picking && (editor.tabId !== want || editor.url !== ui.page?.url)) {
    await stopPicking(editor.tabId);
    Object.assign(editor, { picking: false, selected: null, overriding: false });
  }
  if (d?.kind === 'fill' && ui.info?.access && here(d, ui.page) && editor.url !== ui.page.url) {
    editor.form = await describeForm(ui.page.id).catch(() => null);
    editor.url = ui.page.url;
  }
  if (!want || !lib) return;
  if (!editor.picking) {
    const out = await startPicking(want, selectorsOf(d), badgesOf(d, lib)).catch(() => null);
    if (!out) return;
    Object.assign(editor, { picking: true, tabId: want, url: ui.page.url, candidates: await withCategories(out.candidates, lib), probes: {} });
    editor.labels = await pageLabels(want).catch(() => []);
    if (!d.assisted && !picksOf(d).length) await autoMatch(context, d);
  } else {
    await showPicked(want, selectorsOf(d), badgesOf(d, lib), editor.selected?.selector || null).catch(() => {});
  }
}

// Each value's privacy category: the library's patterns, plus the privacy model's spans when it's loaded.
async function withCategories(candidates, lib) {
  const { text, at } = joinValues(candidates);
  const modelSpans = modelReady() ? await scanText(text).catch(() => []) : [];
  return categorise(candidates, detect(text, { patterns: patternsFor(lib), modelSpans }), at);
}

// ------------------------------------------------------------------ matching

const pickOf = (m, kind) => (kind === 'fill'
  ? { box: m.selector, key: m.key, by: m.by, score: m.score, check: m.check }
  : { key: m.key, selector: m.selector, part: m.part || 'all', ...(m.filter ? { filter: m.filter } : {}), by: m.by, score: m.score, check: m.check });

// The rules first, at once; then the on-device model, if it's on and can run here, refines what the caseworker
// hasn't touched yet. Picks the caseworker made (by: 'you') are never changed.
async function autoMatch(context, d) {
  const { lib, act } = context;
  const fields = fieldsFor(d, lib);
  const cands = d.kind === 'fill' ? boxCandidates(editor.form) : editor.candidates;
  const rule = matchFields(cands, fields);
  await updateDraft(d.id, (x) => {
    x.assisted = true;
    if (d.kind !== 'fill') nameWithout(x, cands.map((c) => c.value), lib);
    editPicks(x, (ps) => { ps.splice(0, ps.length, ...rule.matches.map((m) => pickOf(m, d.kind))); });
  });
  editor.matched = { id: d.id, rules: rule.matches.length, total: fields.length, model: null };
  announce(`${plural(rule.matches.length, 'field')} of ${fields.length} matched${rule.matches.some((m) => m.check) ? '. Check the ones marked Check this' : ''}.`);
  act.refresh();
  // The model can take minutes the first time (download), so it never holds up the page or the sidebar.
  void refine(context, d, rule, cands, fields);
}

async function refine(context, d, rule, cands, fields) {
  const { data, act } = context;
  // With the remote AI turned on, the caseworker asks it instead: the on-device model isn't downloaded or run.
  if (aiReady(data.settings)) return;
  const source = assistSource(data.policy, data.settings);
  if (!watching) { watching = true; onAssistChange(() => act.render()); }
  const a = await loadAssist(source);
  if (a.state !== 'ready' || editor.id !== d.id) return;
  try {
    const out = await refineWithModel(rule, cands, fields, undefined, { suffix: source.promptSuffix });
    let changed = 0;
    await updateDraft(d.id, (x) => editPicks(x, (ps) => {
      const mine = ps.filter((p) => p.by === 'you');
      const mineKeys = new Set(mine.map((p) => p.key));
      const next = out.matches.filter((m) => !mineKeys.has(m.key)).map((m) => pickOf(m, d.kind));
      changed = next.filter((p) => !ps.some((q) => q.key === p.key && (q.selector || q.box) === (p.selector || p.box))).length;
      ps.splice(0, ps.length, ...mine, ...next);
    }));
    editor.matched = { ...editor.matched, model: { changed, agreed: out.agreed } };
    announce(`The on-device model checked the matches: ${changed ? `${plural(changed, 'change')}, marked Check this` : 'no changes'}.`);
  } catch (e) {
    announce(`The on-device model couldn’t check the matches: ${describeError(e)}`);
  }
  act.refresh();
}

// Put a page value in a field: it replaces whatever the field had. The same value may feed two fields
// (an address and its postcode).
async function assign(context, d, key, cand) {
  const f = context.lib.fields[key];
  await updateDraft(d.id, (x) => editPicks(x, (ps) => {
    if (d.kind === 'fill') {
      for (let i = ps.length - 1; i >= 0; i--) if (ps[i].box === cand.selector) ps.splice(i, 1);
      ps.push({ box: cand.selector, key, by: 'you', check: false });
      return;
    }
    for (let i = ps.length - 1; i >= 0; i--) if (ps[i].key === key) ps.splice(i, 1);
    const filter = filterFor({ key, ...f }, cand);
    ps.push({ key, selector: cand.selector, part: 'all', ...(filter ? { filter } : {}), by: 'you', check: false });
  }));
  editor.selected = null;
  announce(`${f?.label || key} reads ‘${String(cand.value || '').slice(0, 40)}’`);
  context.act.refresh();
}

const unassign = (context, d, key) => updateDraft(d.id, (x) => editPicks(x, (ps) => {
  for (let i = ps.length - 1; i >= 0; i--) if (ps[i].key === key) ps.splice(i, 1);
})).then(context.act.refresh);

const candidateFor = (selector, msg = {}) => editor.candidates.find((c) => c.selector === selector)
  || { id: `x${editor.candidates.length}`, selector, value: msg.value || '', label: msg.label || null };

// A value clicked on the page (or chosen with Tab and Space): it becomes the selection, waiting for a field.
export async function onPicked(context, msg, sender) {
  const { ui, data, act } = context;
  const d = editingDraft(data);
  if (!d || d.kind === 'fill' || sender.tab?.id !== ui.page?.id) return;
  editor.selected = candidateFor(msg.selector, msg);
  const best = bestFields(context, d, editor.selected)[0];
  announce(`Selected ‘${String(msg.value || '').slice(0, 40)}’. Choose its field${best ? `: ${best.label} is the best guess` : ''}.`);
  act.refresh();
}

export function onDragPick(msg, sender) {
  if (sender.tab?.id !== editor.tabId) return;
  editor.dragging = { selector: msg.selector, value: msg.value, label: msg.label, at: Date.now() };
}

// The draft's fields, best first for this value.
function bestFields(context, d, cand) {
  return fieldsFor(d, context.lib).map((f) => ({ ...f, s: scorePair(cand, f).score })).sort((a, b) => b.s - a.s);
}

async function pickAnything(context, d) {
  if (editor.overriding) { await stopPickAny(editor.tabId); editor.overriding = false; context.act.render(); return; }
  editor.overriding = true;
  context.act.render();
  announce('Click the value on the page. Esc cancels.');
  const got = await pickAnyElement(editor.tabId).catch(() => null);
  editor.overriding = false;
  if (got) {
    const [cand] = await withCategories([got], context.lib);
    if (!editor.candidates.some((c) => c.selector === cand.selector)) editor.candidates.push(cand);
    editor.selected = cand;
    announce(`Selected ‘${String(cand.value).slice(0, 40)}’. Choose its field, or drag it onto one.`);
  }
  context.act.refresh();
}

// ------------------------------------------------------------------ the remote AI

// Ask the remote AI for the profile: the page's reduced HTML (or, for a form, its boxes' labels and options),
// anonymised and shown in the preview first, with the draft's target fields. Its answer replaces the matches
// the caseworker hasn't made themselves, each marked Check this, and the draft must still pass its test.
async function askRemote(context, d) {
  const { ui, lib } = context;
  const fields = fieldsFor(d, lib);
  const keys = fields.map((f) => f.key);
  const targets = d.kind === 'fill' ? [lib.forms[d.profile.form?.id]?.name].filter(Boolean) : (d.targets || []).map((id) => lib.forms[id]?.name).filter(Boolean);
  const keep = (x) => picksOf(x).filter((p) => p.by === 'you');
  if (d.kind === 'fill') {
    const form = editor.form || await describeForm(ui.page.id);
    await runAi(context, 'form', { form, title: ui.page.title, url: ui.page.url, keys, targets }, async (out) => {
      await updateDraft(d.id, (x) => editPicks(x, (ps) => {
        const mine = keep(x);
        const boxes = new Set(mine.map((p) => p.box));
        ps.splice(0, ps.length, ...mine, ...Object.entries(out.fields).filter(([box]) => !boxes.has(box)).map(([box, key]) => ({ box, key, by: 'ai', check: true })));
      }));
      announce(`The remote AI mapped ${plural(Object.keys(out.fields).length, 'box', 'boxes')}${out.dropped.length ? `; ${out.dropped.length} suggestions weren’t on this form or aren’t its fields` : ''}. Check them, then test.`);
    });
    return;
  }
  const snap = await captureTab(ui.page.id);
  await runAi(context, 'profile', { html: snap.html, url: ui.page.url, title: ui.page.title, document, keys, targets }, async (out) => {
    await updateDraft(d.id, (x) => editPicks(x, (ps) => {
      const mine = keep(x);
      const taken = new Set(mine.map((p) => p.key));
      ps.splice(0, ps.length, ...mine, ...Object.entries(out.fields).filter(([key]) => !taken.has(key)).map(([key, selector]) => ({ key, selector, part: 'all', by: 'ai', check: true })));
    }));
    editor.probes = {};
    announce(`The remote AI suggested ${plural(Object.keys(out.fields).length, 'field')}${out.dropped.length ? `; ${out.dropped.length} left out` : ''}${out.problems?.length ? `; ${plural(out.problems.length, 'problem')} reading the page` : ''}. Check them, then test.`);
  });
}

function remoteButton(context, d) {
  if (!aiReady(context.data.settings)) return null;
  const busy = context.aiBusy;
  return h('div', { class: 'stack', style: 'gap:2px' },
    h('button', { type: 'button', class: 'sm magic', 'data-key': `ed-remote-${d.id}`, style: 'align-self:flex-start', disabled: busy, onclick: () => askRemote(context, d) },
      busy ? [h('span', { class: 'spinner' }), ' Waiting for the remote AI…'] : '✦ Ask the remote AI for this profile'),
    h('span', { class: 'small muted' }, `Sends the ${d.kind === 'fill' ? 'form’s boxes (labels and options, not what’s typed in)' : 'page’s HTML'}${fieldsFor(d, context.lib).length ? ' and the target fields' : ''}, with personal data replaced by placeholders. You see exactly what will be sent first.`));
}

// ------------------------------------------------------------------ starting

// "Make a profile for this page": first say what the values are for.
export async function openProfileStart({ ui, act }) {
  const form = await describeForm(ui.page.id).catch(() => null);
  editor.choosing = { controls: form ? form.controls.length : 0, targets: null, form: '' };
  act.refresh();
}

// Forms that have a fill profile (the library's, or a draft): only those can be targets for gathering.
function targetable(lib, drafts) {
  return Object.values(lib.forms).map((f) => ({
    form: f,
    ready: !!(lib.fill.find((p) => p.id === f.fill || p.form?.id === f.id) || drafts.some((d) => d.kind === 'fill' && d.profile.form?.id === f.id)),
  }));
}

function startCard(context) {
  const { ui, data, lib, act } = context;
  const ch = editor.choosing;
  const forms = targetable(lib, data.drafts);
  const caseForms = new Set((data.case?.forms || []).map((f) => f.id));
  ch.targets ??= new Set(forms.filter((x) => x.ready && caseForms.has(x.form.id)).map((x) => x.form.id));
  const formLike = ch.controls >= 3;
  const fillCard = h('div', { class: 'stack', style: 'gap:6px' },
    h('h3', {}, 'This page is a form to fill'),
    h('p', { class: 'small muted' }, `Power Loader matches its ${plural(ch.controls, 'box', 'boxes')} to the form’s fields. Do this first: the form is the target the other pages gather for.`),
    h('label', { class: 'sr', for: 'ps-form' }, 'Which form is this?'),
    h('select', { id: 'ps-form', 'data-key': 'ps-form', onchange: (e) => { ch.form = e.target.value; } },
      [h('option', { value: '' }, 'Which form is this?'), ...forms.map((x) => h('option', { value: x.form.id, selected: ch.form === x.form.id }, `${x.form.name}${x.ready ? ' (has a fill profile)' : ''}`))]),
    h('button', {
      type: 'button', class: formLike ? 'primary sm' : 'sm', 'data-key': 'ps-fill', style: 'align-self:flex-start', disabled: !ch.controls,
      onclick: () => { const f = lib.forms[document.getElementById('ps-form').value]; if (f) startFillDraft(context, f); else announce('Choose the form first'); },
    }, 'Map this form’s boxes'));
  const gatherCard = h('div', { class: 'stack', style: 'gap:6px' },
    h('h3', {}, 'This page has details for…'),
    h('p', { class: 'small muted' }, 'Choose the forms the values will go into. Their fields become the list you drag values onto.'),
    h('fieldset', {}, h('legend', { class: 'sr' }, 'Target forms'),
      forms.map((x) => h('label', { class: 'row small', style: 'flex-wrap:nowrap' },
        h('input', {
          type: 'checkbox', 'data-key': `ps-t-${x.form.id}`, checked: ch.targets.has(x.form.id), disabled: !x.ready,
          onchange: (e) => { if (e.target.checked) ch.targets.add(x.form.id); else ch.targets.delete(x.form.id); act.render(); },
        }),
        h('span', {}, x.form.name, x.ready ? '' : h('span', { class: 'muted' }, ' · map that form first'))))),
    h('button', {
      type: 'button', class: formLike ? 'sm' : 'primary sm', 'data-key': 'ps-gather', style: 'align-self:flex-start', disabled: !ch.targets.size,
      onclick: () => startPageDraft(context, [...ch.targets]),
    }, 'Find the values'));
  return h('div', { class: 'card', style: 'border:2px solid var(--magic)' },
    h('div', { class: 'ctx-head' }, h('span', { class: 'pill magic' }, 'New profile'), h('strong', {}, ui.page?.title || 'This page')),
    h('p', { class: 'small' }, 'Profiles start from the target: the form the values go into.'),
    formLike ? [fillCard, gatherCard] : [gatherCard, ch.controls ? fillCard : null],
    h('button', { type: 'button', class: 'link sm', 'data-key': 'ps-cancel', style: 'align-self:flex-start', onclick: () => { editor.choosing = null; act.render(); } }, 'Cancel'));
}

export async function startPageDraft({ ui, act }, targets = null) {
  const d = newPageDraft({ url: ui.page.url, title: ui.page.title, from: 'local', targets });
  await saveDraft(d);
  await setEditing(d.id);
  announce('Draft started. Matching the values on this page…');
  act.refresh();
}

// Update a published page profile: a new version as a draft, or the draft already started for it.
export async function startNewVersion({ data, lib, act }, profile) {
  const base = profile.draft ? null : lib.profiles.find((p) => p.id === profile.id);
  const existing = data.drafts.find((d) => d.kind !== 'fill' && (d.id === profile.draft || d.base?.id === profile.id));
  const d = existing || (base ? draftFromProfile(base, lib.commit) : null);
  if (!d) return;
  if (!existing) await saveDraft(d);
  await setEditing(d.id);
  announce(existing ? `Editing your draft ${d.profile.version}. Pick values on the page.` : `Draft ${d.profile.version} made from ${base.version}. Pick values on the page to add or remove them.`);
  act.refresh();
}

export async function startFillDraft(context, form) {
  const { ui, act } = context;
  const d = newFillDraft(form, { url: ui.page.url, from: 'local' });
  await saveDraft(d);
  await setEditing(d.id);
  editor.form = await describeForm(ui.page.id).catch(() => null);
  editor.url = ui.page.url;
  act.refresh();
  if (editor.form) await autoMatch({ ...context, data: { ...context.data, drafts: [...context.data.drafts, d] } }, d);
}

export async function editExisting(id, act) {
  await setEditing(id);
  act.refresh();
}

async function runTest(context, d, use) {
  const { ui, lib, act } = context;
  try {
    let test;
    if (d.kind === 'fill') {
      const boxes = Object.fromEntries(picksOf(d).filter((p) => p.key).map((p) => [p.box, p.box]));
      test = judgeFillTest(d, await probeTab(ui.page.id, { fields: boxes }), { url: ui.page.url, lib });
    } else {
      const probes = await probeTab(ui.page.id, d.profile);
      editor.probes = probes;
      test = judgeTest(d, probes, { url: ui.page.url, lib, pageValues: await pageValues(ui.page.id).catch(() => []) });
    }
    await updateDraft(d.id, (x) => { recordTest(x, test); if (use && test.ok) setUse(x, true); });
    const failed = Object.values(test.fields).filter((f) => !f.ok).length;
    announce(test.ok ? (use ? 'Test passed. The draft is in use on this computer.' : 'Test passed on this record too.') : `Test failed: ${failed ? plural(failed, 'field') : test.leaks[0]}`);
  } catch (e) { announce(`Couldn’t test: ${describeError(e)}`); }
  act.refresh();
}

// ------------------------------------------------------------------ the editor

function howPill(p) {
  if (!p || p.by === 'you') return null;
  const text = { label: 'Matched by label', type: 'Matched by type', model: 'Matched by the on-device model', ai: 'Suggested by the remote AI', derived: 'Worked out from another value' }[p.by] || 'Matched';
  return p.check ? h('span', { class: 'pill warn' }, `Check this · ${text.toLowerCase()}`) : h('span', { class: 'pill' }, text);
}

function dropZone(context, d, key, ...children) {
  const read = (e) => {
    const raw = e.dataTransfer?.getData(DRAG_TYPE);
    if (raw) { try { return JSON.parse(raw); } catch { /* not ours */ } }
    return editor.dragging && Date.now() - editor.dragging.at < 60000 ? editor.dragging : null;
  };
  return h('div', {
    class: 'ed-row drop stack', 'data-field': key, style: 'gap:4px;border-top:1px solid var(--border);padding:6px 4px 4px',
    ondragover: (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; e.currentTarget.classList.add('over'); },
    ondragleave: (e) => e.currentTarget.classList.remove('over'),
    ondrop: (e) => {
      e.preventDefault();
      e.currentTarget.classList.remove('over');
      const got = read(e);
      editor.dragging = null;
      if (got?.selector) assign(context, d, key, candidateFor(got.selector, got));
    },
  }, children);
}

function extractRows(context, d) {
  const { lib, act } = context;
  const res = d.tested && testedNow(d) ? d.tested.fields : {};
  const picks = picksOf(d);
  const fields = fieldsFor(d, lib);
  const listed = d.targets?.length ? fields.map((f) => f.key) : [];
  const keys = [...listed, ...new Set(picks.map((p) => p.key).filter((k) => k && !listed.includes(k)))];
  const rows = keys.map((key) => {
    const f = lib.fields[key] || { label: key };
    const i = picks.findIndex((p) => p.key === key);
    const p = picks[i];
    const cand = p && editor.candidates.find((c) => c.selector === p.selector);
    const probe = editor.probes[key];
    const r = res[key];
    const id = `ed-${d.id}-${key}`;
    const req = fields.find((x) => x.key === key)?.required;
    return dropZone(context, d, key,
      h('div', { class: 'row between', style: 'flex-wrap:nowrap' },
        h('b', {}, f.label, req ? h('span', { class: 'muted', title: 'Required by a target form' }, ' *') : null),
        p ? h('button', { type: 'button', class: 'link sm', 'data-key': `${id}-rm`, onclick: () => unassign(context, d, key) }, 'Not this') : null),
      p ? [
        h('div', { class: 'row small', style: 'flex-wrap:wrap;gap:4px' },
          h('span', {}, 'Reads ', h('b', {}, probe && probe.value != null ? String(probe.value) : cand ? `‘${cand.value}’` : '…')),
          howPill(p)),
        h('code', { class: 'small' }, p.selector),
        h('div', { class: 'row', style: 'flex-wrap:nowrap' },
          h('label', { class: 'sr', for: `${id}-part` }, `Part of the text for ${f.label}`),
          h('select', { id: `${id}-part`, 'data-key': `${id}-part`, style: 'width:auto', onchange: (e) => { const v = e.target.value; updateDraft(d.id, (x) => editPicks(x, (ps) => { ps[i].part = v; ps[i].check = false; })).then(act.refresh); } },
            [...Object.entries(PARTS), ['2', 'Word 2'], ['3', 'Word 3']].map(([v, l]) => h('option', { value: v, selected: String(p.part || 'all') === v }, l)))),
      ] : h('span', { class: 'small muted' }, 'Drag a value here from the page'),
      h('label', { class: 'sr', for: `${id}-val` }, `Value on this page for ${f.label}`),
      h('select', {
        id: `${id}-val`, 'data-key': `${id}-val`, class: 'sm',
        onchange: (e) => { const c = editor.candidates[Number(e.target.value)]; if (c) assign(context, d, key, c); },
      }, [h('option', { value: '' }, p ? 'Use another value on this page' : 'Choose a value on this page'),
        ...editor.candidates.map((c, n) => h('option', { value: String(n) }, `${String(c.value).slice(0, 40)}${c.label ? ` (${c.label})` : ''}`))]),
      r ? h('span', { class: `pill ${r.ok ? 'ok' : 'bad'}` }, r.ok ? '✓ Found once, valid' : `✕ ${r.error}`) : null);
  });
  // A pick without a field yet (an older draft): offer the field list.
  const loose = picks.map((p, i) => [p, i]).filter(([p]) => !p.key).map(([p, i]) => h('div', { class: 'ed-row row', style: 'flex-wrap:nowrap;border-top:1px solid var(--border);padding-top:6px' },
    h('code', { class: 'small' }, p.selector),
    h('label', { class: 'sr', for: `ed-${d.id}-${i}-key` }, `Case field for ${p.selector}`),
    h('select', { id: `ed-${d.id}-${i}-key`, 'data-key': `ed-${d.id}-${i}-key`, onchange: (e) => { const v = e.target.value; updateDraft(d.id, (x) => editPicks(x, (ps) => { ps[i].key = v; ps[i].by = 'you'; })).then(act.refresh); } },
      [h('option', { value: '' }, 'Choose a case field'), ...fields.map((x) => h('option', { value: x.key }, x.label))]),
    h('button', { type: 'button', class: 'link sm', onclick: () => updateDraft(d.id, (x) => editPicks(x, (ps) => ps.splice(i, 1))).then(act.refresh) }, 'Remove')));
  return [...rows, ...loose];
}

// The selection bar: a value chosen on the page, waiting for its field.
function selectedBar(context, d) {
  const s = editor.selected;
  if (!s) return null;
  const options = bestFields(context, d, s);
  return h('div', { class: 'notice magic stack', role: 'status', style: 'gap:6px' },
    h('span', {}, 'Selected on the page: ', h('b', {}, `‘${String(s.value).slice(0, 60)}’`), s.label ? ` (${s.label})` : ''),
    h('div', { class: 'row', style: 'flex-wrap:nowrap' },
      h('label', { class: 'sr', for: 'ed-sel-key' }, 'Field for the selected value'),
      h('select', { id: 'ed-sel-key', 'data-key': 'ed-sel-key' }, options.map((f, n) => h('option', { value: f.key, selected: n === 0 }, f.label))),
      h('button', { type: 'button', class: 'primary sm', 'data-key': 'ed-sel-use', onclick: () => assign(context, d, document.getElementById('ed-sel-key').value, s) }, 'Use for this field'),
      h('button', { type: 'button', class: 'link sm', 'data-key': 'ed-sel-cancel', onclick: () => { editor.selected = null; context.act.refresh(); } }, 'Cancel')));
}

function assistLine(context, d) {
  const { data, act } = context;
  const m = editor.matched?.id === d.id ? editor.matched : null;
  const rules = m ? h('span', {}, `${m.rules} of ${m.total} fields matched by the page’s labels and values${m.model ? `; the on-device model ${m.model.changed ? `changed ${m.model.changed}` : 'agreed'}` : ''}.`) : null;
  if (aiReady(data.settings)) {
    return h('div', { class: 'stack small', style: 'gap:4px' }, rules,
      h('span', { class: 'muted' }, 'The remote AI is turned on, so the on-device model isn’t used.'), remoteButton(context, d));
  }
  const src = assistSource(data.policy, data.settings);
  const busy = ['starting', 'downloading', 'testing'].includes(assist.state);
  return h('div', { class: 'stack small', style: 'gap:2px' },
    m ? h('span', {}, `${m.rules} of ${m.total} fields matched by the page’s labels and values${m.model ? `; the on-device model ${m.model.changed ? `changed ${m.model.changed}` : 'agreed'}` : ''}.`) : null,
    h('span', { class: 'muted', role: 'status' }, busy ? [h('span', { class: 'spinner' }), ' '] : null, src.enabled ? describeAssist() : describeAssist({ state: 'off', message: src.locked ? 'Switched off by your organisation' : '' })),
    h('label', { class: 'row small', style: 'flex-wrap:nowrap' },
      h('input', {
        type: 'checkbox', 'data-key': 'ed-assist', checked: src.enabled, disabled: src.locked,
        onchange: (e) => saveSettings({ assist: { ...(data.settings?.assist || {}), model: e.target.checked } }).then(act.refresh),
      }),
      h('span', {}, `Use the on-device model to match (${src.sizeMB ? `about ${src.sizeMB} MB, ` : ''}downloaded once; nothing leaves this computer)`)),
    src.enabled && !busy && !assistReady() && (editor.candidates.length || editor.form) ? h('button', {
      type: 'button', class: 'link sm', 'data-key': 'ed-rematch', style: 'align-self:flex-start',
      onclick: () => autoMatch(context, d),
    }, 'Match again') : null);
}

export function editorCard(context) {
  const { ui, data, lib, act } = context;
  if (!lib) return null;
  if (editor.choosing && ui.info?.access) return startCard(context);
  const d = editingDraft(data);
  if (!d) return null;
  const onPage = here(d, ui.page);
  const diff = d.base ? diffDraft(d, lib.profiles.concat(lib.fill).find((p) => p.id === d.base.id)) : null;
  const t = d.tested;
  const current = testedNow(d);
  const targets = (d.targets || []).map((id) => lib.forms[id]?.name).filter(Boolean);
  return h('div', { class: 'card', style: 'border:2px solid var(--magic)' },
    h('div', { class: 'ctx-head' }, h('span', { class: 'pill magic' }, `Editing draft ${d.profile.version}`), h('strong', {}, d.profile.name)),
    targets.length ? h('p', { class: 'small' }, 'Gathering for: ', h('b', {}, targets.join(', '))) : null,
    d.kind === 'fill' && lib.forms[d.profile.form?.id] ? h('p', { class: 'small' }, 'Fill profile for: ', h('b', {}, lib.forms[d.profile.form.id].name)) : null,
    !onPage ? h('p', { class: 'muted' }, `Go to a page this profile reads (${[d.profile.match].flat().join(', ')}) to ${d.kind === 'fill' ? 'map its boxes' : 'pick values'}.`)
      : d.kind === 'fill' ? [h('p', { class: 'small' }, 'Each box is matched to one of the form’s fields. Check the ones marked Check this. Boxes left empty are not filled.'), assistLine(context, d)]
        : [
          h('p', { class: 'small' }, 'Every value Power Loader can read is outlined on the page; matched ones are solid and show their field. Drag a value from the page onto a field below, or click it on the page and choose its field. With a keyboard, Tab to a value and press Space, or choose from each field’s list.'),
          assistLine(context, d),
          selectedBar(context, d),
          h('div', { class: 'row' },
            h('button', { type: 'button', class: editor.overriding ? 'primary sm' : 'sm', 'data-key': `ed-any-${d.id}`, 'aria-pressed': String(editor.overriding), disabled: !editor.picking, onclick: () => pickAnything(context, d) },
              editor.overriding ? 'Cancel picking' : 'Pick something that isn’t outlined'),
            editor.labels.length ? h('select', {
              'data-key': `ed-lab-${d.id}`, 'aria-label': 'Select a labelled value on this page', class: 'sm',
              onchange: async (e) => {
                const l = editor.labels[Number(e.target.value)];
                if (!l) return;
                const [cand] = await withCategories([{ id: `l${e.target.value}`, selector: l.selector, value: l.value, label: l.label }], lib);
                editor.selected = cand;
                act.refresh();
              },
            }, [h('option', { value: '' }, 'Or select a labelled value'), ...editor.labels.map((l, i) => h('option', { value: String(i) }, `${l.label}: ${String(l.value).slice(0, 30)}`))]) : null),
        ],
    h('div', { class: 'stack', style: 'gap:6px' }, d.kind === 'fill' ? fillRows(context, d) : extractRows(context, d)),
    picksOf(d).length || d.targets?.length ? null : h('p', { class: 'muted small' }, 'No fields yet.'),
    d.kind === 'fill' ? null : h('p', { class: 'small muted' }, 'Repeating rows, nested groups, conditional sections and labels that appear twice on a page can’t be authored here yet. Ask a library maintainer for those.'),
    h('label', { class: 'field small' }, 'Link pattern for the activity log',
      h('span', { class: 'hint' }, 'Placeholders in braces replace anything that identifies a person or case, for example /clients/{clientId}.'),
      h('input', {
        type: 'text', 'data-key': `ed-pat-${d.id}`, value: d.profile.urlPattern || '',
        onchange: (e) => { const v = e.target.value.trim(); updateDraft(d.id, (x) => editDraft(x, (p) => { p.urlPattern = v; })).then(act.refresh); },
      })),
    diff ? h('div', { class: 'diff' }, diff.same ? h('span', { class: 'pill' }, `Same as ${d.base.version}`) : [
      diff.added.length ? h('span', { class: 'pill ok' }, `+${plural(diff.added.length, 'field')}`) : null,
      diff.removed.length ? h('span', { class: 'pill bad' }, `−${plural(diff.removed.length, 'field')}`) : null,
      diff.remapped.length ? h('span', { class: 'pill warn' }, `${diff.remapped.length} changed`) : null,
      diff.meta.length ? h('span', { class: 'pill warn' }, `Changed: ${diff.meta.map((m) => m.what).join(', ')}`) : null,
    ]) : h('div', { class: 'diff' }, h('span', { class: 'pill magic' }, 'New profile')),
    h('p', { class: 'small', role: 'status' },
      !t ? h('span', { class: 'pill warn' }, 'Not tested') : !current ? h('span', { class: 'pill warn' }, 'Changed since its test: not tested')
        : t.ok ? [h('span', { class: 'pill ok' }, `✓ Tested ${time(t.at)}`), d.use ? ' In use on this computer.' : ' Not in use.', d.second?.ok ? ' Also passed on a second record.' : ' Test it on another record too: a selector that works for one person is the common failure.']
          : [h('span', { class: 'pill bad' }, `✕ Test failed ${time(t.at)}`), t.leaks.length ? ` ${t.leaks[0]} appear${t.leaks[0].startsWith('1 ') ? 's' : ''} in the selectors.` : '']),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'primary sm', 'data-key': `ed-test-${d.id}`, disabled: !onPage || !ui.info?.access, onclick: () => runTest(context, d, true) }, 'Test and use on this computer'),
      current && t.ok && t.url !== ui.page?.url ? h('button', { type: 'button', class: 'sm', 'data-key': `ed-test2-${d.id}`, disabled: !onPage, onclick: () => runTest(context, d, false) }, 'Test on this record too') : null,
      d.use ? h('button', { type: 'button', class: 'sm', 'data-key': `ed-unuse-${d.id}`, onclick: () => updateDraft(d.id, (x) => setUse(x, false)).then(act.refresh) }, 'Stop using it') : null,
      h('button', { type: 'button', class: 'sm', 'data-key': `ed-done-${d.id}`, onclick: async () => { await setEditing(null); if (editor.picking) await stopPicking(editor.tabId); editor.picking = false; editor.url = null; announce('Draft saved on this computer'); act.refresh(); } }, 'Done'),
      h('button', { type: 'button', class: 'sm', 'data-key': `ed-lib-${d.id}`, onclick: () => act.openPage('library', { draft: d.id }) }, 'Open in the library'),
      h('button', {
        type: 'button', class: 'link sm danger', 'data-key': `ed-del-${d.id}`,
        onclick: async () => {
          if (!await confirmDialog({ title: `Delete draft ${d.profile.name} ${d.profile.version}?`, text: d.exported ? 'You exported it, so a copy may already be with a maintainer.' : 'It hasn’t been exported.', confirm: 'Delete draft', danger: true })) return;
          await deleteDraft(d.id);
          await setEditing(null);
          act.refresh();
        },
      }, 'Delete draft')));
}

function fillRows(context, d) {
  const { lib, act } = context;
  const picks = picksOf(d);
  const controls = editor.form ? [...editor.form.controls, ...editor.form.groups.flatMap((g) => g.controls)] : picks.map((p) => ({ selector: p.box, label: p.box }));
  const res = d.tested && testedNow(d) ? d.tested.fields : {};
  const formKeys = new Set(fieldsFor(d, lib).map((f) => f.key));
  const option = (k, f, pick) => h('option', { value: k, selected: k === pick?.key }, f.label);
  return controls.map((ctl, i) => {
    const pick = picks.find((p) => p.box === ctl.selector);
    const id = `fd-${d.id}-${i}`;
    const r = res[ctl.selector];
    return h('div', { class: 'stack', style: 'gap:2px;border-top:1px solid var(--border);padding-top:6px' },
      h('div', { class: 'row between', style: 'flex-wrap:nowrap' },
        h('label', { for: id, style: 'min-width:0' }, ctl.label, h('br'), h('code', { class: 'small' }, ctl.selector)),
        h('select', {
          id, 'data-key': id, style: 'width:auto;max-width:55%',
          onchange: (e) => {
            const v = e.target.value;
            updateDraft(d.id, (x) => editPicks(x, (ps) => {
              const j = ps.findIndex((p) => p.box === ctl.selector);
              if (j >= 0) { if (v) Object.assign(ps[j], { key: v, by: 'you', check: false }); else ps.splice(j, 1); } else if (v) ps.push({ box: ctl.selector, key: v, by: 'you', check: false });
            })).then(act.refresh);
          },
        }, [h('option', { value: '' }, 'Leave empty'),
          h('optgroup', { label: 'This form’s fields' }, Object.entries(lib.fields).filter(([k]) => formKeys.has(k)).map(([k, f]) => option(k, f, pick))),
          h('optgroup', { label: 'Other case fields' }, Object.entries(lib.fields).filter(([k]) => !formKeys.has(k)).map(([k, f]) => option(k, f, pick)))]),
        r ? h('span', { class: `pill ${r.ok ? 'ok' : 'bad'}` }, r.ok ? '✓' : `✕ ${r.error}`) : null),
      pick ? howPill(pick) : null);
  });
}

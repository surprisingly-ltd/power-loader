// The full case page: Fields, Sources, Matrix and Activity views of the active case, and the calculator and
// timeline at full size. It replaces the sidebar while open, and "Back to the sidebar" returns to the tab,
// scroll position and control the caseworker came from.
/* global browser */
import '../lib/extract.js';
import { h, rerender, announce, copyText, describeError, plural, time, draftInput, clearDraft, drafts } from '../ui/dom.js';
import { tabList, tabPanel } from '../ui/tabs.js';
import { CaseEnded, caseLibrary, updateCase } from '../lib/core.js';
import {
  caseKeys, caseLabel, caseText, contribution, decide, excludeValue, fieldState, fillStale, formProgress, isRequired, neededBy,
  restoreValue, setManual, settled, undecide,
} from '../lib/case.js';
import { display, norm } from '../lib/fields.js';
import { ACTIVITIES, allRows, exportRows, logEvent, toCsv } from '../lib/activity.js';
import { returnToSidebar } from '../lib/pages.js';
import { CASE_ENDED } from '../lib/teardown.js';
import { getPolicy } from '../lib/policy.js';
import { openFinish, openRemoveClip } from '../sidebar/case-dialogs.js';
import { conflictCard, shortUrl, whereFound } from '../sidebar/caseview.js';
import { installPresenter } from '../sidebar/privacy.js';
import { toolBlock } from '../sidebar/tools/tools.js';

export const ui = { view: 'fields', form: null, status: 'all', open: null, src: null, realLinks: false };
let data = {};

async function load() {
  const s = await browser.storage.local.get(['case', 'teardown', 'library', 'settings']);
  const c = s.case && !s.teardown ? s.case : null;
  let lib = null;
  try { lib = c ? caseLibrary(s.library, c) : null; } catch { lib = null; }
  const policy = await getPolicy().catch(() => ({ values: {}, locked: new Set() }));
  data = { case: c, lib, library: s.library, settings: s.settings || {}, policy };
}

export const act = {
  render: () => render(),
  async update(fn, done) {
    if (!data.case) return null;
    try {
      const out = await updateCase(data.case.id, fn);
      if (done) announce(typeof done === 'function' ? done(out) : done);
      return out;
    } catch (e) {
      announce(e instanceof CaseEnded || e.name === 'CaseEnded' ? 'That case has ended, so the change was dropped' : describeError(e));
      return null;
    } finally { await load(); render(); }
  },
  refresh: async () => { await load(); render(); },
};
const VIEWS = ['fields', 'sources', 'matrix', 'activity', 'calc', 'timeline'];
// What the shared case components need. Events logged here are logged against the full case page.
const ctx = () => ({ data, lib: data.lib, act, ui, logPage: () => page });
const label = (k) => data.lib.fields[k]?.label || k;
const clipOf = (id) => data.case.clips.find((x) => x.id === id);
const page = { type: 'case-page' };

// Exclude or restore one source's value for a field, and log it.
function setExcluded(cl, k, on) {
  const d = data.lib.fields[k];
  return act.update((cs, l) => {
    (on ? excludeValue : restoreValue)(cs, cl.id, k);
    logEvent(cs, on ? 'exclude_source_value' : 'restore_source_value', { page, detail: l.fields[k].label });
  }, on ? `Excluded ${d.label} from ${cl.name}` : `${d.label} from ${cl.name} restored`);
}

// Worked out once per render and shared by every view: the case's keys, each field's state, which forms need it.
let view = null;
function viewOf() {
  const c = data.case;
  const lib = data.lib;
  const keys = caseKeys(c, lib);
  const states = Object.fromEntries(keys.map((k) => [k, fieldState(c, lib, k)]));
  const forms = Object.fromEntries(keys.map((k) => [k, neededBy(c, lib, k)]));
  return { keys, keySet: new Set(keys), states, forms, required: new Set(keys.filter((k) => isRequired(c, lib, k))), conflicts: keys.filter((k) => states[k].status === 'conflict') };
}
const inForm = (k) => !ui.form || view.forms[k]?.includes(ui.form);
const contrib = (cl, k) => contribution(data.case, data.lib, cl, k, { keys: view.keySet, state: view.states[k] });

// A link to where a value came from. Opens in a new tab: this page stays as it is.
function srcLink(cl) {
  if (!cl.url || !/^https?:/.test(cl.url)) return h('span', { class: 'small muted' }, cl.kind === 'document' ? 'Read from a document' : cl.kind === 'region' ? 'Read from the screen' : '');
  return h('a', { class: 'srclink', href: cl.url, target: '_blank', rel: 'noopener', title: 'Open this source in a new tab' }, `${shortUrl(cl.url)} ↗`);
}
const kindLabel = (cl) => ({ page: `Page profile ${cl.profile?.id || ''} ${cl.profile?.version || ''}${cl.profile?.draft ? ' (your draft)' : ''}`, document: 'Document, read on this computer', region: 'Screen region, read on this computer', ai: 'AI extraction, redacted' }[cl.kind] || 'Source');

function statusPill(k, st) {
  if (settled(st.status) && !st.valid) return h('span', { class: 'pill bad' }, 'Needs fixing');
  const req = view.required.has(k);
  const [cls, text] = { ok: ['ok', 'Gathered'], resolved: ['acc', 'You chose'], manual: ['acc', 'Edited by you'], conflict: ['bad', 'Conflict'], missing: ['warn', req ? 'Missing, required' : 'Missing'] }[st.status];
  return h('span', { class: `pill ${cls}` }, text);
}

function bucket(st) {
  if (st.status === 'missing') return 'missing';
  if (st.status === 'conflict') return 'conflict';
  if (!st.valid) return 'fix';
  return st.status === 'manual' || st.status === 'resolved' ? 'edited' : 'done';
}

function formChips() {
  const c = data.case;
  return h('div', { class: 'chips', role: 'group', 'aria-label': 'Form' }, [['', 'All forms'], ...c.forms.map((f) => [f.id, data.lib.forms[f.id]?.name || f.id])].map(([id, l]) => h('button', {
    type: 'button', 'data-key': `fc-${id || 'all'}`, 'aria-pressed': String((ui.form || '') === id), onclick: () => { ui.form = id || null; render(); },
  }, l)));
}

// ------------------------------------------------------------------ fields

function curatePanel(k, st) {
  const c = data.case;
  const d = data.lib.fields[k];
  const key = `cp-${k}`;
  const save = (value) => act.update((cs, l) => { setManual(cs, k, value); logEvent(cs, value ? 'edit_value' : 'clear_my_value', { page, detail: l.fields[k].label }); }, value ? `${d.label} saved` : `${d.label} cleared`);
  const choose = (value) => act.update((cs, l) => { decide(cs, l, k, value); logEvent(cs, st.status === 'conflict' ? 'resolve_conflict' : 'choose_value', { page, detail: l.fields[k].label }); }, `${d.label} decided`);
  const inUse = (cd) => settled(st.status) && cd.n === norm(d, st.value);
  const excludedHere = c.clips.filter((cl) => k in cl.values && c.excluded.includes(`${cl.id}:${k}`));
  const where = whereFound(data.lib, k);
  const own = d.options
    ? h('div', { class: 'row', role: 'group', 'aria-label': d.label }, d.options.map((o) => h('button', { type: 'button', class: `sm${st.status === 'manual' && st.value === o ? ' primary' : ''}`, 'data-key': `${key}-${o}`, 'aria-pressed': String(st.status === 'manual' && st.value === o), onclick: () => save(o) }, o)))
    : h('div', { class: 'row', style: 'flex-wrap:nowrap' },
      (() => { const el = draftInput(`${key}-own`, { type: 'text', id: `${key}-own`, 'aria-label': `Your value for ${d.label}`, value: c.manual[k] ?? (st.status === 'resolved' ? st.value : ''), 'aria-describedby': settled(st.status) && !st.valid ? `${key}-err` : undefined }, d.long ? 'textarea' : 'input'); if (d.long) el.rows = 3; return el; })(),
      h('button', {
        type: 'button', class: 'sm primary', 'data-key': `${key}-save`,
        onclick: () => { const v = (drafts.get(`${key}-own`) ?? c.manual[k] ?? '').trim(); clearDraft(`${key}-own`); return st.status === 'conflict' ? (v && choose(v)) : save(v); },
      }, st.status === 'conflict' ? 'Use' : 'Save'));
  return h('div', { class: 'curate' },
    h('div', { class: 'stack' },
      h('h4', {}, 'Found in sources'),
      st.reopened ? h('p', { class: 'notice warn' }, h('b', {}, 'The sources changed since you decided. '), `You chose ${display(d, st.previous)}. Decide again.`) : null,
      st.cands.map((cd, i) => h('div', { class: `cand${inUse(cd) ? ' on' : ''}` },
        h('div', { class: 'row between' }, h('b', {}, display(d, cd.value)),
          inUse(cd) ? h('span', { class: 'pill ok' }, 'In use') : h('button', { type: 'button', class: 'sm', 'data-key': `${key}-use-${i}`, onclick: () => choose(cd.value) }, 'Use this value')),
        cd.sources.map((id) => clipOf(id)).filter(Boolean).map((cl) => h('div', { class: 'srcrow' },
          h('span', {}, `${cl.name} · clipped ${time(cl.capturedAt)}`), srcLink(cl),
          cl.quotes?.[k] ? h('q', {}, cl.quotes[k]) : null,
          h('button', { type: 'button', class: 'link sm', 'data-key': `${key}-ex-${cl.id}`, onclick: () => setExcluded(cl, k, true) }, 'Exclude'))))),
      !st.cands.length ? h('p', { class: 'small muted' }, where.length ? `No source has this yet. It’s usually on ${where.join(' or ')}.` : 'No source has this yet.') : null,
      excludedHere.length ? [h('h4', { style: 'margin-top:4px' }, 'Excluded'), excludedHere.map((cl) => h('div', { class: 'srcrow ex' },
        h('s', {}, display(d, cl.values[k])), h('span', {}, `from ${cl.name}`), srcLink(cl),
        h('button', { type: 'button', class: 'link sm', 'data-key': `${key}-re-${cl.id}`, onclick: () => setExcluded(cl, k, false) }, 'Restore')))] : null),
    h('div', { class: 'stack' },
      h('h4', {}, 'Your value'), own,
      settled(st.status) && !st.valid ? h('p', { class: 'error-text', id: `${key}-err` }, `Needs fixing: ${st.error}. It won’t be filled until it’s fixed.`) : null,
      h('p', { class: 'small muted' }, 'Your value overrides the sources and is marked “Edited by you”.'),
      st.status === 'manual' ? h('button', { type: 'button', class: 'sm', 'data-key': `${key}-back`, style: 'align-self:flex-start', onclick: () => { clearDraft(`${key}-own`); save(''); } }, 'Remove my value') : null,
      st.status === 'resolved' ? h('button', { type: 'button', class: 'sm', 'data-key': `${key}-change`, style: 'align-self:flex-start', onclick: () => act.update((cs) => undecide(cs, k), `${d.label} is open again`) }, 'Undo my choice') : null));
}

function fieldsView() {
  const c = data.case;
  const lib = data.lib;
  const keys = view.keys.filter(inForm);
  const { states } = view;
  const excluded = new Set(c.excluded);
  const counts = { all: keys.length, missing: 0, conflict: 0, fix: 0, done: 0, edited: 0 };
  keys.forEach((k) => counts[bucket(states[k])]++);
  const filters = [['all', 'All'], ['missing', 'Missing'], ['conflict', 'Conflicts'], ['fix', 'Needs fixing'], ['done', 'From sources'], ['edited', 'Edited by you']].filter(([f]) => f !== 'fix' || counts.fix);
  const shown = keys.filter((k) => ui.status === 'all' || bucket(states[k]) === ui.status);
  const conflicts = view.conflicts.filter(inForm);
  const rows = [];
  let section = null;
  for (const k of shown) {
    const d = lib.fields[k];
    const st = states[k];
    if ((d.section || '') !== section) { section = d.section || ''; rows.push(h('tr', { class: 'sechead' }, h('th', { colspan: '4', scope: 'colgroup' }, section || 'Other'))); }
    const open = ui.open === k;
    const value = settled(st.status) ? display(d, st.value) : st.status === 'conflict' ? st.cands.map((x) => display(d, x.value)).join(' ≠ ') : d.manual ? 'Not on any page. Enter it here' : 'Missing';
    const multi = st.cands.length > 1;
    let srcs = st.cands.flatMap((cd) => cd.sources.map((id) => clipOf(id)).filter(Boolean).map((cl) => h('div', { class: 'srcref' },
      h('b', {}, cl.name), multi ? h('span', { class: 'muted' }, display(d, cd.value)) : null, srcLink(cl))));
    if (st.status === 'manual') srcs.unshift(h('div', { class: 'srcref' }, h('b', {}, 'Typed by you')));
    const ex = c.clips.filter((cl) => k in cl.values && excluded.has(`${cl.id}:${k}`)).length;
    if (ex) srcs.push(h('div', { class: 'srcref muted' }, `${ex} excluded`));
    if (!srcs.length) { const w = whereFound(lib, k); srcs = [h('span', { class: 'small muted' }, w.length ? `Usually on ${w.join(' or ')}` : 'You enter this')]; }
    const cls = settled(st.status) && !st.valid ? 'invalid' : st.status;
    rows.push(h('tr', { class: `s-${cls} frw${open ? ' open' : ''}`, onclick: (e) => { if (e.target.closest('a, button')) return; ui.open = open ? null : k; render(); } },
      h('td', {}, h('button', { type: 'button', class: 'rowbtn', 'data-key': `fr-${k}`, 'aria-expanded': String(open), 'aria-controls': `cp-row-${k}`, onclick: () => { ui.open = open ? null : k; render(); } }, d.label),
        view.required.has(k) ? h('span', { class: 'req', 'aria-label': 'required' }, ' *') : null,
        h('div', { class: 'small muted' }, view.forms[k].map((id) => lib.forms[id]?.short || id).join(' · '))),
      h('td', { class: 'v' }, value),
      h('td', {}, statusPill(k, st)),
      h('td', {}, srcs)));
    if (open) rows.push(h('tr', { class: 'cur', id: `cp-row-${k}` }, h('td', { colspan: '4' }, curatePanel(k, st))));
  }
  const workings = c.workings || [];
  return [
    h('div', { class: 'fbar' }, formChips(),
      h('div', { class: 'chips', role: 'group', 'aria-label': 'Status' }, filters.map(([f, l]) => h('button', { type: 'button', 'data-key': `ff-${f}`, 'aria-pressed': String(ui.status === f), onclick: () => { ui.status = f; render(); } }, `${l} `, h('span', { class: 'num' }, String(counts[f])))))),
    h('p', { class: 'small muted' }, `Every field the ${ui.form ? `${lib.forms[ui.form]?.name} form expects` : 'case’s forms expect'}. Open a row to see each source, open it, exclude it or set your own value.`),
    conflicts.length ? h('section', { class: 'conflicts', 'aria-labelledby': 'cf-title' },
      h('h3', { id: 'cf-title' }, `⚠ ${plural(conflicts.length, 'conflict')} to decide before filling`),
      h('div', { class: 'cf-grid' }, conflicts.map((k) => conflictCard(ctx(), k)))) : null,
    h('div', { class: 'tbl-wrap' }, h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col', style: 'width:22%' }, 'Field'), h('th', { scope: 'col', style: 'width:24%' }, 'Value in case'), h('th', { scope: 'col', style: 'width:14%' }, 'Status'), h('th', { scope: 'col' }, 'Sources'))),
      h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colspan: '4', class: 'muted' }, 'No fields match this filter.'))))),
    h('section', { class: 'workings' }, h('h2', { class: 'section' }, 'Workings'),
      workings.length ? workings.map((w) => h('div', { class: 'card' }, h('div', { class: 'row between' }, h('b', {}, w.title), h('span', { class: 'small muted' }, time(w.at))), h('pre', { class: 'json' }, w.text)))
        : h('p', { class: 'muted' }, 'Results saved from the calculator or timeline appear here and are included when you copy the case.')),
  ];
}

// ------------------------------------------------------------------ sources

function sourcesView() {
  const c = data.case;
  const lib = data.lib;
  if (!c.clips.length) return h('p', { class: 'muted' }, 'Nothing clipped yet.');
  const sel = clipOf(ui.src) || c.clips[0];
  const { keys } = view;
  const order = (k) => { const i = keys.indexOf(k); return i < 0 ? 999 : i; };
  const shown = Object.keys(sel.values).filter((k) => !view.keySet.has(k) || inForm(k)).sort((a, b) => order(a) - order(b));
  const visits = sel.url ? c.log.filter((e) => e.activity === 'visit_page' && e.url === sel.url).length : 0;
  const list = c.clips.map((cl) => {
    const st = Object.keys(cl.values).map((k) => contrib(cl, k).s);
    const used = st.filter((x) => x === 'used').length;
    const bad = st.filter((x) => ['conflict', 'excluded', 'over'].includes(x)).length;
    return h('button', { type: 'button', class: 'srccard', 'data-key': `src-${cl.id}`, 'aria-current': String(cl.id === sel.id), onclick: () => { ui.src = cl.id; render(); } },
      h('b', {}, cl.name), h('span', { class: 'muted' }, shortUrl(cl.url) || kindLabel(cl)), h('span', { class: 'muted' }, `${kindLabel(cl)} · ${time(cl.capturedAt)}`),
      h('span', { class: 'row', style: 'gap:4px' }, h('span', { class: 'pill ok' }, `${used} used`), bad ? h('span', { class: 'pill warn' }, `${bad} not used`) : null, cl.records?.length ? h('span', { class: 'pill' }, `${cl.records.length} rows`) : null));
  });
  const recTypes = [...new Set((sel.records || []).map((r) => r.type))];
  return [
    h('div', { class: 'fbar' }, formChips()),
    h('div', { class: 'srcs-layout' },
      h('nav', { class: 'stack', 'aria-label': 'Sources' }, list),
      h('div', { class: 'card', style: 'gap:10px' },
        h('div', { class: 'row between' }, h('h3', {}, sel.name), h('button', { type: 'button', class: 'sm', 'data-key': `rm-${sel.id}`, onclick: () => openRemoveClip(ctx(), sel.id) }, 'Remove source')),
        sel.identity && !sel.identity.confirmed ? h('p', { class: 'notice bad', role: 'alert' }, `This may be a different person: ${sel.identity.mismatched.map(label).join(', ')} don’t match the rest of the case.`) : null,
        h('dl', { class: 'kv' },
          h('dt', {}, 'Link'), h('dd', {}, srcLink(sel)),
          h('dt', {}, 'Read by'), h('dd', {}, kindLabel(sel)),
          h('dt', {}, 'Clipped'), h('dd', {}, `${time(sel.capturedAt)}${visits ? ` · page visited ${plural(visits, 'time')}` : ''}`)),
        h('div', { class: 'tbl-wrap' }, h('table', { class: 'grid', style: 'min-width:560px' },
          h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Field'), h('th', { scope: 'col' }, 'Value here'), h('th', { scope: 'col' }, 'In the case'), h('th', { scope: 'col' }, 'Forms'), h('th', { scope: 'col' }, h('span', { class: 'sr' }, 'Action')))),
          h('tbody', {}, shown.length ? shown.map((k) => {
            const cs = contrib(sel, k);
            return h('tr', { class: cs.s === 'extra' ? 'xtra' : '' },
              h('td', {}, cs.s === 'extra' ? label(k) : h('button', { type: 'button', class: 'link', 'data-key': `sf-${k}`, onclick: () => { ui.view = 'fields'; ui.open = k; render(); } }, label(k))),
              h('td', { class: 'v' }, display(lib.fields[k], sel.values[k]), sel.quotes?.[k] ? h('div', {}, h('q', {}, sel.quotes[k])) : null),
              h('td', {}, h('span', { class: `pill ${cs.c}` }, cs.t)),
              h('td', { class: 'small' }, view.keySet.has(k) ? view.forms[k].map((id) => lib.forms[id]?.short || id).join(' · ') : '–'),
              h('td', {}, cs.s === 'extra' ? null : cs.s === 'excluded'
                ? h('button', { type: 'button', class: 'link sm', 'data-key': `sx-${k}`, onclick: () => setExcluded(sel, k, false) }, 'Restore')
                : h('button', { type: 'button', class: 'link sm', 'data-key': `sx-${k}`, onclick: () => setExcluded(sel, k, true) }, 'Exclude')));
          }) : h('tr', {}, h('td', { colspan: '5', class: 'muted' }, 'This source has no field values.'))))),
        recTypes.length ? h('p', { class: 'small muted' }, `Also holds ${recTypes.map((t) => plural(sel.records.filter((r) => r.type === t).length, t === 'money' ? 'payment' : t === 'note' ? 'note' : t === 'period' ? 'dated period' : 'row')).join(', ')} used by the tools.`) : null)),
  ];
}

// ------------------------------------------------------------------ matrix

function matrixView() {
  const c = data.case;
  const lib = data.lib;
  if (!c.clips.length) return h('p', { class: 'muted' }, 'Nothing clipped yet.');
  const keys = view.keys.filter(inForm);
  return [
    h('div', { class: 'fbar' }, formChips(),
      h('div', { class: 'tr-legend', 'aria-hidden': 'true' }, h('span', { class: 'mxl used' }, 'Used'), h('span', { class: 'mxl conflict' }, 'Conflict'), h('span', { class: 'mxl over' }, 'Not used'), h('span', { class: 'mxl excluded' }, 'Excluded'))),
    h('p', { class: 'small muted' }, 'Rows are the fields the forms expect. Columns are the sources. Choose a field or a source to look at it in detail.'),
    h('div', { class: 'tbl-wrap' }, h('table', { class: 'mxt' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Field'), h('th', { scope: 'col' }, 'In case'),
        c.clips.map((cl) => h('th', { scope: 'col' }, h('button', { type: 'button', class: 'link sm', 'data-key': `mh-${cl.id}`, title: shortUrl(cl.url), onclick: () => { ui.view = 'sources'; ui.src = cl.id; render(); } }, cl.name))))),
      h('tbody', {}, keys.map((k) => {
        const st = view.states[k];
        return h('tr', {},
          h('th', { scope: 'row' }, h('button', { type: 'button', class: 'rowbtn', 'data-key': `mf-${k}`, onclick: () => { ui.view = 'fields'; ui.open = k; render(); } }, label(k)), view.required.has(k) ? h('span', { class: 'req' }, ' *') : null),
          h('td', { class: `mxv s-${st.status}` }, settled(st.status) ? display(lib.fields[k], st.value) : st.status === 'conflict' ? 'Conflict' : '–'),
          c.clips.map((cl) => {
            if (!(k in cl.values)) return h('td', { class: 'mx none' }, h('span', { 'aria-hidden': 'true' }, '·'), h('span', { class: 'sr' }, 'Not in this source'));
            const cs = contrib(cl, k);
            return h('td', { class: `mx ${cs.s}`, title: cs.t }, display(lib.fields[k], cl.values[k]), h('span', { class: 'sr' }, ` (${cs.t})`));
          }));
      })))),
  ];
}

// ------------------------------------------------------------------ activity

// A page type as a person reads it: the profile's or form's name from the library.
function typeLabel(t) {
  const lib = data.lib;
  if (!t) return 'Not recognised';
  const [kind, rest] = t.includes(':') ? t.split(':') : ['page', t];
  const id = rest.split('@')[0];
  if (kind === 'form') return `Form: ${lib.forms[id]?.name || id}`;
  if (kind === 'confirm') return `Submitted: ${lib.forms[id]?.name || id}`;
  return lib.profiles.find((p) => p.id === id)?.name || (t === 'case-page' ? 'Full case page' : t === 'document' ? 'Document' : id);
}

function activityView() {
  const c = data.case;
  const log = c.log;
  const visits = log.filter((e) => e.activity === 'visit_page');
  const first = log[0]?.timestamp;
  const mins = first ? Math.max(1, Math.round((Date.now() - Date.parse(first)) / 60000)) : 0;
  const trace = [];
  for (const e of visits) { const t = typeLabel(e.page_type); if (trace[trace.length - 1] !== t) trace.push(t); }
  const decisions = log.filter((e) => ['edit_value', 'resolve_conflict', 'choose_value', 'exclude_source_value'].includes(e.activity)).length;
  // "Until next" for each page visit, from one pass backwards over the log.
  const until = new Array(log.length).fill('');
  let next = null;
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].activity !== 'visit_page') continue;
    const ms = next ? Date.parse(next) - Date.parse(log[i].timestamp) : 0;
    until[i] = next ? `${Math.floor(ms / 60000)}m ${Math.round(ms / 1000) % 60}s` : 'now';
    next = log[i].timestamp;
  }
  const rows = log.map((e, i) => {
    const visit = e.activity === 'visit_page';
    return h('tr', { class: visit ? 'visit' : 'action' },
      h('td', { class: 'num' }, time(e.timestamp, { seconds: true })),
      h('td', {}, visit ? null : h('span', { class: 'muted', 'aria-hidden': 'true' }, '↳ '), ACTIVITIES[e.activity] || e.activity, e.detail ? h('span', { class: 'muted' }, ` · ${e.detail}`) : null, e.note ? h('div', { class: 'lg-notetxt' }, `Note: ${e.note}`) : null),
      h('td', {}, typeLabel(e.page_type)),
      h('td', { class: 'small', style: 'overflow-wrap:anywhere' }, shortUrl(ui.realLinks && e.url ? e.url : e.url_pattern)),
      h('td', { class: 'num' }, until[i]));
  });
  // Downloads follow the organisation's timestamp policy, as on the activity log page.
  const rowsOut = () => exportRows(allRows(c, []), { coarse: !!data.policy.values.activityLog?.coarseTimestamps });
  return [
    h('div', { class: 'stats wide-stats' },
      h('div', { class: 'stat' }, h('div', { class: 'k' }, 'Events'), h('div', { class: 'v' }, String(log.length)), h('div', { class: 'd' }, `since ${first ? time(first) : '–'}`)),
      h('div', { class: 'stat' }, h('div', { class: 'k' }, 'Page visits'), h('div', { class: 'v' }, String(visits.length)), h('div', { class: 'd' }, plural(new Set(visits.map((e) => e.url_pattern)).size, 'different page'))),
      h('div', { class: 'stat' }, h('div', { class: 'k' }, 'Time on case'), h('div', { class: 'v' }, `${mins} min`), h('div', { class: 'd' }, 'so far')),
      h('div', { class: 'stat' }, h('div', { class: 'k' }, 'Sources clipped'), h('div', { class: 'v' }, String(c.clips.length)), h('div', { class: 'd' }, plural(decisions, 'manual decision')))),
    h('div', { class: 'card' }, h('h3', {}, 'Path through the systems'),
      trace.length ? h('div', { class: 'trace' }, trace.map((t, i) => [i ? h('span', { class: 'ar', 'aria-hidden': 'true' }, '→') : null, h('span', { class: 'st' }, t)])) : h('p', { class: 'muted' }, 'No approved pages visited yet.'),
      h('p', { class: 'small muted' }, 'Repeated runs of this path across many cases show which steps can be automated.')),
    h('div', { class: 'row between' },
      h('label', { class: 'check small' }, h('input', { type: 'checkbox', 'data-key': 'real-links', checked: ui.realLinks, onchange: (e) => { ui.realLinks = e.target.checked; render(); } }), h('span', {}, 'Show real links (only while the case is open)')),
      h('span', { class: 'row' },
        h('button', { type: 'button', class: 'sm', 'data-key': 'open-log', onclick: () => { location.href = browser.runtime.getURL('log/log.html'); } }, 'All cases’ log'),
        h('button', { type: 'button', class: 'sm', 'data-key': 'copy-csv', onclick: () => copyText(toCsv(rowsOut()), 'CSV') }, 'Copy as CSV'),
        h('button', { type: 'button', class: 'sm', 'data-key': 'copy-json', onclick: () => copyText(JSON.stringify(rowsOut(), null, 2), 'JSON') }, 'Copy as JSON'))),
    h('div', { class: 'tbl-wrap' }, h('table', { class: 'grid logt' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col', style: 'width:84px' }, 'Time'), h('th', { scope: 'col' }, 'Activity'), h('th', { scope: 'col', style: 'width:20%' }, 'Page type'),
        h('th', { scope: 'col', style: 'width:30%' }, ui.realLinks ? 'Link' : 'Link pattern'), h('th', { scope: 'col', style: 'width:90px', title: 'Time until the next page visit. Includes calls, breaks and other tabs.' }, 'Until next'))),
      h('tbody', {}, rows))),
    h('p', { class: 'small muted' }, 'When the case ends, the log is kept without case values or real links. One row per event: case id, activity, timestamp, page type, link pattern. That is the standard event-log shape for process-mining tools.'),
  ];
}

// ------------------------------------------------------------------ page

function progress() {
  const c = data.case;
  return h('div', { class: 'fprog' }, c.forms.map((fv) => {
    const f = data.lib.forms[fv.id];
    const p = formProgress(c, data.lib, fv.id);
    const stale = fillStale(c, data.lib, fv.id);
    return h('button', {
      type: 'button', class: 'fpc', 'data-key': `fpc-${fv.id}`, 'aria-pressed': String(ui.form === fv.id),
      'aria-label': `${f.name}: ${p.done} of ${p.req} required fields ready. Show only this form’s fields`, onclick: () => { ui.form = ui.form === fv.id ? null : fv.id; render(); },
    },
    h('span', { class: 'row between' }, h('b', {}, f.name), h('span', { class: 'num' }, `${p.done}/${p.req}`)),
    h('span', { class: 'bar', 'aria-hidden': 'true' }, h('i', { style: `width:${p.req ? (p.done / p.req) * 100 : 0}%` }), h('i', { class: 'c', style: `width:${p.req ? (p.conflicts.length / p.req) * 100 : 0}%` })),
    h('span', { class: 'fp-meta' },
      p.conflicts.length ? h('span', { class: 'c' }, plural(p.conflicts.length, 'conflict')) : null,
      p.invalid.length ? h('span', { class: 'c' }, `${p.invalid.length} need fixing`) : null,
      p.missing.length ? h('span', { class: 'm' }, `Missing: ${p.missing.map(label).join(', ')}`) : null,
      p.ready ? h('span', { class: 'r' }, 'Ready to fill') : null,
      c.submitted[fv.id] ? h('span', { class: 'r' }, c.submitted[fv.id].how === 'observed' ? 'Submitted (seen)' : 'Submitted (you said)')
        : c.filled[fv.id] ? h('span', { class: stale ? 'c' : '' }, stale ? 'Filled · check again' : `Filled ${time(c.filled[fv.id].at)}`) : null));
  }));
}

export function render() {
  const app = document.getElementById('app');
  const c = data.case;
  const back = h('button', {
    type: 'button', 'data-key': 'back',
    onclick: async () => { const r = await returnToSidebar(); if (!r.ok) announce(r.reason); },
  }, 'Back to the sidebar');
  if (!c || !data.lib) {
    return rerender(app, h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'No active case')), back),
      h('p', {}, 'The case has been finished or discarded, so its data has been deleted from this browser.'));
  }
  view = viewOf();
  const n = view.conflicts.length;
  const tabs = [
    { key: 'fields', label: 'Fields', badge: n ? String(n) : null }, { key: 'sources', label: `Sources · ${c.clips.length}` }, { key: 'matrix', label: 'Matrix' },
    { key: 'activity', label: `Activity · ${c.log.length}` }, { key: 'calc', label: 'Calculator' }, { key: 'timeline', label: 'Timeline' },
  ];
  const body = ui.view === 'sources' ? sourcesView() : ui.view === 'matrix' ? matrixView() : ui.view === 'activity' ? activityView()
    : ui.view === 'calc' || ui.view === 'timeline' ? h('div', { class: 'tool' }, toolBlock(ctx(), ui.view, { wide: true })) : fieldsView();
  document.title = `${caseLabel(c, data.lib)} – Power Loader`;
  return rerender(app,
    h('div', { class: 'page-head' },
      h('div', {}, h('div', { class: 'eyebrow' }, 'Active case'), h('h1', {}, caseLabel(c, data.lib)),
        h('div', { class: 'meta' }, `Started ${time(c.createdAt)} · ${c.forms.map((f) => data.lib.forms[f.id]?.name).join(' + ')} · stored only in this browser`)),
      h('div', { class: 'row' }, back,
        h('button', { type: 'button', 'data-key': 'copy-case', onclick: () => copyText(caseText(c, data.lib), 'Case text') }, 'Copy as text'),
        h('button', { type: 'button', class: 'primary', 'data-key': 'finish', onclick: () => openFinish(ctx()) }, 'Finish case'))),
    progress(),
    tabList({ id: 'case', label: 'Case views', tabs, selected: ui.view, onSelect: (v) => { ui.view = v; history.replaceState(null, '', `?view=${v}`); render(); } }),
    tabPanel('case', ui.view, body));
}

export async function start() {
  browser.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local' || !['case', 'teardown', 'library', 'settings'].some((k) => k in changes)) return;
    if ('case' in changes && !changes.case.newValue) drafts.clear();
    await load();
    render();
  });
  browser.runtime.onMessage.addListener((msg) => { if (msg?.type === CASE_ENDED) { drafts.clear(); ui.open = null; ui.src = null; } });
  installPresenter(ctx());
  // Logged before the first render, so opening the page renders once rather than twice.
  const { case: open } = await browser.storage.local.get('case');
  if (open) await updateCase(open.id, (c) => { logEvent(c, 'open_full_case_view', { page }); }).catch(() => {});
  await load();
  const params = new URLSearchParams(location.search);
  const field = params.get('field');
  if (field) ui.open = field;
  if (VIEWS.includes(params.get('view'))) ui.view = params.get('view');
  render();
  if (field) document.querySelector(`[data-key="fr-${CSS.escape(field)}"]`)?.focus();
}

start();

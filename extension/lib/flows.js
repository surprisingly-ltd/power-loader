// Flows: what a library author makes in Power Loader, with or without a connected library. A flow is the forms
// a case fills (output pages), the pages it clips from (input pages) and the contract between them: the
// fields, defined once. It compiles to the files of a library, so a maintainer can add it as it is.
// Pure functions, no browser APIs. See docs/plans/flow-authoring.md.
//
// Flow: { schema, id, name, guidance, created, updated, fields: { key: FieldDef }, pages: [Page],
//         journey?: [pageId] (the order the caseworker takes the pages), timelines?: [Timeline] }
// Page: { id, role: 'output' | 'input' | 'guide', name, url, required: [key], draft: Draft | null,
//         match? (guide pages), step?: { text, links: [{ id, label, url, to }] } }
//   An output page's draft is a fill draft (box → field); an input page's is an extraction draft. A guide
//   page (a case list, a search page) has no draft: it is a step on the way, with its instructions and links.
// Timeline: { id, name, series: [{ id, label, kind: 'bar' | 'point', colour, shape, gaps,
//             source: { type: 'page', pageId, rows, label, start, end, at } | { type: 'fields', start, end, at } }] }
import { canonical } from './hash.js';
import { TYPES, validateFieldDefs } from './fields.js';
import { indexLibrary } from './library.js';
import { COLOURS, SHAPES, STEPS_SCHEMA, TIMELINES_SCHEMA, templateErrors, templateVars } from './journey.js';
import {
  editDraft, editPicks, exportBody, newFillDraft, newPageDraft, picksOf, randomDraftId, SCHEMA as PROFILE_SCHEMA, suggestPatterns,
} from './drafts.js';

export const FLOW_SCHEMA = 'powerloader-flow/1';
export const ROLES = { output: 'Form to fill', input: 'Page to clip', guide: 'Page to visit' };
// A flow needs a form to fill and a page to clip; pages to visit are optional.
const NEEDED = ['output', 'input'];
const now = () => new Date().toISOString();
const rid = (p) => `${p}-${randomDraftId().slice(2)}`;
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'page';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function newPage(role, n = 1) {
  return { id: rid('p'), role, name: `${ROLES[role]} ${n}`, url: '', required: [], draft: null, ...(role === 'guide' ? { match: '' } : {}) };
}

export function newFlow({ name = '', guidance = '' } = {}) {
  return {
    schema: FLOW_SCHEMA, id: rid('f'), name: String(name).trim(), guidance: String(guidance), created: now(), updated: now(),
    fields: {}, pages: [newPage('output'), newPage('input')], journey: [], timelines: [],
  };
}

export const pagesOf = (flow, role) => flow.pages.filter((p) => p.role === role);
export const pageOf = (flow, id) => flow.pages.find((p) => p.id === id) || null;

export function addPage(flow, role) {
  const p = newPage(role, pagesOf(flow, role).length + 1);
  flow.pages.push(p);
  return p;
}

export function removePage(flow, id) {
  const p = pageOf(flow, id);
  if (!p) return false;
  if (NEEDED.includes(p.role) && pagesOf(flow, p.role).length <= 1) throw new Error(`A flow needs at least one ${ROLES[p.role].toLowerCase()}`);
  flow.pages.splice(flow.pages.indexOf(p), 1);
  flow.journey = (flow.journey || []).filter((x) => x !== id);
  for (const q of flow.pages) for (const l of q.step?.links || []) if (l.to === id) l.to = '';
  for (const t of flow.timelines || []) for (const s of t.series) if (s.source?.pageId === id) s.source.pageId = '';
  return true;
}

// ------------------------------------------------------------------ the caseworker's steps

const ROLE_ORDER = { guide: 0, input: 1, output: 2 };

/** The pages in the order the caseworker takes them: the author's order, then any page not placed yet. */
export function journeyOf(flow) {
  const byId = new Map(flow.pages.map((p) => [p.id, p]));
  const placed = [...new Set(flow.journey || [])].filter((id) => byId.has(id));
  const rest = flow.pages.filter((p) => !placed.includes(p.id)).sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);
  return [...placed.map((id) => byId.get(id)), ...rest];
}

/** Move a page earlier (-1) or later (+1) in the caseworker's steps. */
export function moveStep(flow, id, delta) {
  const order = journeyOf(flow).map((p) => p.id);
  const i = order.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= order.length) return false;
  [order[i], order[j]] = [order[j], order[i]];
  flow.journey = order;
  return true;
}

const stepOf = (page) => { page.step = { text: '', links: [], ...(page.step || {}) }; page.step.links = page.step.links || []; return page.step; };

export function setStepText(page, text) { stepOf(page).text = String(text || '').slice(0, 5000); }

/** A link the caseworker follows from this step. url is a template: {ref}, or {fieldKey} for a case value. */
export function addLink(page, { label = '', url = '', to = '' } = {}) {
  const link = { id: rid('l'), label: String(label).slice(0, 80), url: String(url).slice(0, 2000), to: String(to) };
  stepOf(page).links.push(link);
  return link;
}

export function setLink(page, linkId, change) {
  const l = stepOf(page).links.find((x) => x.id === linkId);
  if (!l) return;
  for (const k of ['label', 'url', 'to']) if (typeof change[k] === 'string') l[k] = change[k].slice(0, k === 'url' ? 2000 : 80);
}

export function removeLink(page, linkId) { const st = stepOf(page); st.links = st.links.filter((l) => l.id !== linkId); }

/** Where a page is, as a link template: a form's address, a page to clip's link pattern, a page to visit's address. */
export const pageAddress = (page) => (page ? page.url || '' : '');
/** A link's address: its own, or the page it opens. */
export const linkUrl = (flow, link) => link.url || (link.to ? pageAddress(pageOf(flow, link.to)) : '');
/** The names a link template can use: ref and the flow's fields. */
export const linkVars = (flow) => ['ref', ...Object.keys(flow.fields)];

// ------------------------------------------------------------------ timelines

export const SERIES_KINDS = { bar: 'Bars: a start and an end date', point: 'Pointers: one date each' };
const COLOUR_NAMES = Object.keys(COLOURS);

export function addTimeline(flow, name = '') {
  flow.timelines = flow.timelines || [];
  const t = { id: rid('t'), name: String(name).trim().slice(0, 80) || `Timeline ${flow.timelines.length + 1}`, series: [] };
  flow.timelines.push(t);
  return t;
}

export const timelineOf = (flow, id) => (flow.timelines || []).find((t) => t.id === id) || null;

export function removeTimeline(flow, id) { flow.timelines = (flow.timelines || []).filter((t) => t.id !== id); }

/** A series of bars or pointers. Its dates come from rows on a page to clip, or from the flow's date fields. */
export function addSeries(flow, timelineId, { label = '', kind = 'bar', type = 'page' } = {}) {
  const t = timelineOf(flow, timelineId);
  if (!t) throw new Error('That timeline is no longer in the flow');
  const used = new Set(t.series.map((s) => s.colour));
  const s = {
    id: `s${randomDraftId().slice(2)}`, label: String(label).trim().slice(0, 80) || `Series ${t.series.length + 1}`, kind: kind === 'point' ? 'point' : 'bar',
    colour: COLOUR_NAMES.find((c) => !used.has(c)) || 'grey', shape: 'circle', gaps: kind !== 'point',
    source: type === 'fields' ? { type: 'fields', start: '', end: '', at: '' } : { type: 'page', pageId: pagesOf(flow, 'input')[0]?.id || '', rows: '', label: '', start: '', end: '', at: '' },
  };
  t.series.push(s);
  return s;
}

export function setSeries(flow, timelineId, seriesId, change) {
  const s = timelineOf(flow, timelineId)?.series.find((x) => x.id === seriesId);
  if (!s) return;
  if (typeof change.label === 'string') s.label = change.label.slice(0, 80);
  if (change.kind === 'bar' || change.kind === 'point') s.kind = change.kind;
  if (typeof change.colour === 'string' && (COLOURS[change.colour] || /^#[0-9a-f]{6}$/i.test(change.colour))) s.colour = change.colour;
  if (SHAPES.includes(change.shape)) s.shape = change.shape;
  if (typeof change.gaps === 'boolean') s.gaps = change.gaps;
  if (change.type === 'page' && s.source.type !== 'page') s.source = { type: 'page', pageId: pagesOf(flow, 'input')[0]?.id || '', rows: '', label: '', start: '', end: '', at: '' };
  if (change.type === 'fields' && s.source.type !== 'fields') s.source = { type: 'fields', start: '', end: '', at: '' };
  for (const k of ['pageId', 'rows', 'label', 'start', 'end', 'at']) if (typeof change.source?.[k] === 'string') s.source[k] = change.source[k].trim().slice(0, 300);
}

export function removeSeries(flow, timelineId, seriesId) {
  const t = timelineOf(flow, timelineId);
  if (t) t.series = t.series.filter((s) => s.id !== seriesId);
}

/**
 * A picked element's selector, split into the repeating row and the part within it:
 * "#history > tbody > tr:nth-of-type(2) > td:nth-of-type(3)" → { rows: "#history > tbody > tr", cell: "td:nth-of-type(3)" }.
 */
export function splitRowSelector(selector) {
  const parts = String(selector || '').split(/\s*>\s*/).filter(Boolean);
  const nth = /^([a-z][a-z0-9-]*):nth-of-type\(\d+\)$/;
  // The row is the deepest numbered element that isn't the picked one itself, preferring table rows and list items.
  let at = -1;
  for (let i = parts.length - 2; i >= 0; i--) if (nth.test(parts[i]) && /^(tr|li)\b/.test(parts[i])) { at = i; break; }
  if (at < 0) for (let i = parts.length - 2; i >= 0; i--) if (nth.test(parts[i])) { at = i; break; }
  if (at < 0) return null;
  return { rows: [...parts.slice(0, at), nth.exec(parts[at])[1]].join(' > '), cell: parts.slice(at + 1).join(' > ') };
}

const seriesKey = (s) => `tl_${s.id}`;
const dateExpr = (sel) => (/\|/.test(sel) ? sel : `${sel} | date`);
const seriesComplete = (s) => (s.source.type === 'page'
  ? !!(s.source.pageId && s.source.rows && (s.kind === 'bar' ? s.source.start : s.source.at))
  : !!(s.kind === 'bar' ? s.source.start : s.source.at));

/** The list a page profile reads for a series: one record per row, with its label and dates. */
export function seriesSpec(s) {
  const src = s.source;
  const row = { '@type': s.kind === 'point' ? 'tlpoint' : 'tlbar', label: src.label ? src.label : `=${s.label}` };
  if (s.kind === 'point') row.at = dateExpr(src.at);
  else { row.start = dateExpr(src.start); if (src.end) row.end = dateExpr(src.end); }
  return [src.rows, row];
}

// The series a page to clip reads, as profile fields.
const seriesFields = (flow, pageId) => Object.fromEntries((flow.timelines || []).flatMap((t) => t.series)
  .filter((s) => s.source.type === 'page' && s.source.pageId === pageId && seriesComplete(s)).map((s) => [seriesKey(s), seriesSpec(s)]));

// ------------------------------------------------------------------ the contract

/** A field key from a label: "Date of birth" → dateOfBirth, made unique among the keys taken. */
export function fieldKey(label, taken = {}) {
  const words = String(label).replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  let base = words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('').slice(0, 40) || 'field';
  if (!/^[A-Za-z]/.test(base)) base = `f${base}`;
  let key = base;
  for (let n = 2; key in taken; n++) key = `${base}${n}`;
  return key;
}

// A first guess at a new field's type from its name; the author can change it.
export function guessType(label) {
  const l = String(label).toLowerCase();
  if (/national insurance|\bni\b|nino/.test(l)) return 'nino';
  if (/postcode|post code/.test(l)) return 'postcode';
  if (/e-?mail/.test(l)) return 'email';
  if (/phone|mobile|telephone/.test(l)) return 'phone';
  if (/\bdate\b|birth|\bdob\b|\bstart\b|\bend\b|\bfrom\b|\buntil\b/.test(l)) return 'date';
  if (/rent|income|arrears|amount|award|salary|wage|£|pay\b|balance|cost/.test(l)) return 'money';
  if (/address/.test(l)) return 'longtext';
  return 'text';
}

// A field definition as fields.json has it. Identity, privacy and placeholder categories come from a library
// field and are kept, so a case from the flow checks identity and redacts as the library's would.
const cleanDef = (d) => {
  const out = { label: String(d.label || '').trim().slice(0, 80) };
  if (d.type && TYPES.includes(d.type) && d.type !== 'text') out.type = d.type;
  if (Array.isArray(d.options) && d.options.length) out.options = d.options.map(String).slice(0, 40);
  if (d.long) out.long = true;
  if (d.manual) out.manual = true;
  if (d.identity === true || d.identity === 'strong') out.identity = d.identity;
  if (Array.isArray(d.accepts) && d.accepts.every((a) => typeof a === 'string')) out.accepts = [...d.accepts];
  if (typeof d.privacy === 'string') out.privacy = d.privacy;
  if (typeof d.section === 'string' && d.section.trim()) out.section = d.section.trim().slice(0, 60);
  return out;
};

/**
 * Add a field to the contract, or find the one with the same key or label. Returns its key.
 * def: { label, key?, type?, options?, long?, manual? }
 */
export function addField(flow, def) {
  const label = String(def.label || '').trim();
  if (!label) throw new Error('A field needs a name');
  if (def.key && flow.fields[def.key]) return def.key;
  const same = Object.entries(flow.fields).find(([, f]) => f.label.toLowerCase() === label.toLowerCase());
  if (same) return same[0];
  const key = def.key && /^[A-Za-z][A-Za-z0-9_]*$/.test(def.key) ? def.key : fieldKey(label, flow.fields);
  flow.fields[key] = cleanDef({ ...def, label });
  return key;
}

export function setField(flow, key, change) {
  if (!flow.fields[key]) return;
  flow.fields[key] = cleanDef({ ...flow.fields[key], ...change });
}

/** Remove a field from the contract and from every page that maps it. */
export function removeField(flow, key) {
  delete flow.fields[key];
  for (const p of flow.pages) {
    p.required = (p.required || []).filter((k) => k !== key);
    if (p.draft && picksOf(p.draft).some((x) => x.key === key)) editPicks(p.draft, (ps) => { for (let i = ps.length - 1; i >= 0; i--) if (ps[i].key === key) ps.splice(i, 1); });
  }
}

export const keysOf = (page) => (page.draft ? [...new Set(picksOf(page.draft).map((p) => p.key).filter(Boolean))] : []);
export const requiredBy = (flow, key) => pagesOf(flow, 'output').filter((p) => keysOf(p).includes(key) && (p.required || []).includes(key));
export const neededBy = (flow, key) => pagesOf(flow, 'output').filter((p) => keysOf(p).includes(key));
export const gatheredBy = (flow, key) => pagesOf(flow, 'input').filter((p) => keysOf(p).includes(key));

/** The contract as rows: who needs each field and who gathers it. */
export function contract(flow) {
  return Object.entries(flow.fields).map(([key, f]) => ({
    key, ...f, needed: neededBy(flow, key).map((p) => p.id), required: requiredBy(flow, key).map((p) => p.id), gathered: gatheredBy(flow, key).map((p) => p.id),
  }));
}

// The hosts the flow's pages are on. Without a library they are what the flow is allowed to read.
export function flowHosts(flow) {
  const hosts = new Set();
  for (const p of flow.pages) {
    for (const m of [p.url, ...[p.draft?.profile.match].flat()].filter(Boolean)) {
      const h = /^(?:https?|\*):\/\/([^/]+)/.exec(String(m))?.[1];
      if (h && !h.includes('*')) hosts.add(h.toLowerCase());
    }
  }
  return [...hosts].sort();
}

/**
 * The flow as a library, for the editor, the AI requests and the validators: its own fields and hosts.
 * A connected library lends its privacy patterns and identifier types, and its approved hosts.
 */
export function flowLib(flow, base = null) {
  return {
    commit: `flow-${flow.id}`, message: flow.name, syncedAt: null,
    approvedHosts: [...new Set([...(base?.approvedHosts || []), ...flowHosts(flow)])],
    fields: structuredClone(flow.fields), identifierTypes: base?.identifierTypes || {}, privacy: base?.privacy || null,
    forms: {}, profiles: [], fill: [], documents: [], problems: [],
  };
}

// ------------------------------------------------------------------ pages

const bareUrl = (url) => { const u = new URL(url); return `${u.origin}${u.pathname}`; };

/**
 * Bind a page of the flow to the web page open now: its address, a name (unless it would hold a value from
 * the page) and an empty draft of the right kind. values: text on the page, which a name must not contain.
 */
export function bindPage(flow, pageId, { url, title = '', values = [] }) {
  const p = pageOf(flow, pageId);
  if (!p) throw new Error('That page is no longer in the flow');
  const name = String(title).split(/ [–|-] /)[0].trim().slice(0, 60);
  const leaks = name && values.some((v) => String(v).trim().length > 3 && name.includes(String(v).trim()));
  if (name && !leaks && /^(Form to fill|Page to clip|Page to visit) \d+$/.test(p.name)) p.name = name;
  if (p.role === 'guide') {
    // A page to visit is opened as it is (a case list, a search page) and recognised by its match pattern.
    const u = new URL(url);
    u.hash = '';
    p.url = u.href;
    p.match = suggestPatterns(url).match;
    return p;
  }
  p.url = p.role === 'output' ? bareUrl(url) : suggestPatterns(url).urlPattern;
  if (p.role === 'output') {
    p.draft = newFillDraft({ id: slug(p.name), name: p.name, version: 'v1' }, { url, from: 'you' });
  } else {
    p.draft = newPageDraft({ url, title: p.name, from: 'you' });
    p.draft.profile.name = p.name;
  }
  return p;
}

// The last test was of exactly this profile, passed or not.
export const testCurrent = (draft) => !!(draft?.tested && draft.tested.snapshot === canonical(draft.profile));

export const pageMatches = (page, url, matchUrl) => !!(page?.draft && url && matchUrl(page.draft.profile.match, url));

/** Map a form box to a field (output pages) or a field to a selector (input pages); either replaces the old one. */
export function mapPick(page, key, target, { by = 'you', check = false, filter = '' } = {}) {
  editPicks(page.draft, (ps) => {
    if (page.role === 'output') {
      for (let i = ps.length - 1; i >= 0; i--) if (ps[i].box === target || ps[i].key === key) ps.splice(i, 1);
      ps.push({ box: target, key, by, check });
    } else {
      for (let i = ps.length - 1; i >= 0; i--) if (ps[i].key === key) ps.splice(i, 1);
      ps.push({ key, selector: target, part: 'all', ...(filter ? { filter } : {}), by, check });
    }
  });
  if (page.role === 'output' && !(page.required || []).includes(key)) page.required = [...(page.required || []), key];
}

export function unmapKey(page, key) {
  if (!page.draft) return;
  editPicks(page.draft, (ps) => { for (let i = ps.length - 1; i >= 0; i--) if (ps[i].key === key) ps.splice(i, 1); });
  page.required = (page.required || []).filter((k) => k !== key);
}

export function setRequired(page, key, on) {
  const set = new Set(page.required || []);
  if (on) set.add(key); else set.delete(key);
  page.required = [...set];
}

export function renamePage(page, name) {
  page.name = String(name).trim().slice(0, 60) || page.name;
  if (page.draft) editDraft(page.draft, (pr) => { pr.name = page.name; });
}

// ------------------------------------------------------------------ the AI's answers

const KEY = /^[A-Za-z][A-Za-z0-9]{0,39}$/;

/**
 * Apply the AI's answer for an output page: the fields the form collects, and the box each goes in. Fields
 * join the contract (an existing one with the same key or label is reused); mappings the author made
 * themselves are kept. Returns { added, mapped, dropped }.
 */
export function applyFormAnswer(flow, pageId, answer, boxes) {
  const page = pageOf(flow, pageId);
  const known = new Map(boxes.map((b) => [b.selector, b]));
  const mine = picksOf(page.draft).filter((p) => p.by === 'you');
  const taken = new Set(mine.map((p) => p.box));
  let added = 0;
  const mapped = [];
  const dropped = [];
  for (const f of answer.fields || []) {
    const box = known.get(f.box);
    if (!box || taken.has(f.box) || !f.label) { dropped.push(f.box); continue; }
    const before = Object.keys(flow.fields).length;
    const key = addField(flow, {
      label: f.label, key: KEY.test(f.key || '') ? f.key : undefined, type: TYPES.includes(f.type) ? f.type : undefined,
      options: box.options?.length ? box.options.filter((o) => !/^(choose|select|please)/i.test(o)) : undefined, long: box.tag === 'textarea', manual: !!f.typed,
    });
    if (Object.keys(flow.fields).length > before) added++;
    taken.add(f.box);
    mapped.push({ box: f.box, key, required: f.required !== false });
  }
  editPicks(page.draft, (ps) => { ps.splice(0, ps.length, ...mine, ...mapped.map((m) => ({ box: m.box, key: m.key, by: 'ai', check: true }))); });
  page.required = [...new Set([...(page.required || []).filter((k) => mine.some((p) => p.key === k)), ...mapped.filter((m) => m.required).map((m) => m.key)])];
  return { added, mapped: mapped.length, dropped };
}

/** Apply the AI's selectors for an input page; the author's own picks are kept. */
export function applyPageAnswer(page, fields, { only = null } = {}) {
  editPicks(page.draft, (ps) => {
    const keep = ps.filter((p) => p.by === 'you' || (only && !only.includes(p.key)));
    const taken = new Set(keep.map((p) => p.key));
    ps.splice(0, ps.length, ...keep, ...Object.entries(fields).filter(([k]) => !taken.has(k)).map(([key, selector]) => ({ key, selector, part: 'all', by: 'ai', check: true })));
  });
}

// ------------------------------------------------------------------ validation

const issue = (level, code, text, extra = {}) => ({ level, code, text, ...extra });

/**
 * Everything wrong with the flow now. Each issue: { level: 'error' | 'warn', code, text, pageId?, key?,
 * keys?, ai?: true } where ai says an ✦ request for that page (and keys) can help.
 */
export function validateFlow(flow) {
  const out = [];
  if (!String(flow.name || '').trim()) out.push(issue('error', 'no-name', 'Give the flow a name'));
  const lib = flowLib(flow);
  const defErrors = validateFieldDefs(flow.fields);
  for (const e of defErrors) out.push(issue('error', 'field-def', e));
  for (const p of flow.pages) {
    const what = `${p.name}`;
    stepIssues(flow, p, out);
    if (p.role === 'guide') {
      if (!p.url) out.push(issue('warn', 'guide-unbound', `${what} has no address yet: open it on its page`, { pageId: p.id }));
      continue;
    }
    if (!p.draft) { out.push(issue('error', 'unbound', `${what} isn’t made yet: open it on its page`, { pageId: p.id, ai: true })); continue; }
    const picks = picksOf(p.draft).filter((x) => x.key);
    if (!picks.length) { out.push(issue('error', 'empty', `${what} maps no fields yet`, { pageId: p.id, ai: true })); continue; }
    const unknown = picks.filter((x) => !flow.fields[x.key]).map((x) => x.key);
    if (unknown.length) out.push(issue('error', 'unknown-field', `${what} maps ${unknown.join(', ')}, which ${unknown.length === 1 ? 'isn’t a field' : 'aren’t fields'} of this flow`, { pageId: p.id, keys: unknown }));
    const t = p.draft.tested;
    if (!t) out.push(issue('error', 'untested', `${what} hasn’t been tested on its page`, { pageId: p.id }));
    else if (!testCurrent(p.draft)) out.push(issue('error', 'changed', `${what} changed since its test`, { pageId: p.id }));
    else if (!t.ok) {
      const bad = Object.entries(t.fields).filter(([, r]) => !r.ok);
      const keyOf = (k) => (p.role === 'output' ? picks.find((x) => x.box === k)?.key || k : k);
      for (const [k, r] of bad) {
        const key = keyOf(k);
        out.push(issue('error', 'broken', `${what}: ${flow.fields[key]?.label || key}: ${r.error}`, { pageId: p.id, key, keys: [key], ai: true }));
      }
      if (t.leaks.length) out.push(issue('error', 'leaks', `${what}: ${t.leaks[0]} appear in its profile. Selectors must describe the page, never a person.`, { pageId: p.id, leaks: true }));
    }
  }
  const inputs = pagesOf(flow, 'input');
  for (const row of contract(flow)) {
    if (row.manual) continue;
    if (!row.gathered.length && row.needed.length) {
      const req = row.required.length > 0;
      out.push(issue(req ? 'error' : 'warn', 'not-gathered', `No page gathers ${row.label}${req ? ', which a form requires' : ''}`, { key: row.key, keys: [row.key], ai: inputs.some((p) => p.draft) }));
    }
    if (row.gathered.length && !row.needed.length) out.push(issue('warn', 'not-used', `${row.label} is gathered, but no form uses it`, { key: row.key }));
    if (!row.gathered.length && !row.needed.length && !usedElsewhere(flow).has(row.key)) out.push(issue('warn', 'unused', `${row.label} isn’t used by any page`, { key: row.key }));
  }
  timelineIssues(flow, out);
  // The files the flow becomes must pass the library's own checks.
  if (!out.some((i) => i.level === 'error')) {
    const { files, hosts } = compileFlow(flow);
    const indexed = indexLibrary({ files }, { approvedHosts: hosts });
    for (const pr of indexed.problems) out.push(issue('error', 'library', `${pr.path}: ${pr.errors[0]}`));
  }
  return out;
}

export const flowReady = (issues) => !issues.some((i) => i.level === 'error');

// Fields a timeline or a link uses, so they aren't reported as unused.
function usedElsewhere(flow) {
  const keys = new Set();
  for (const t of flow.timelines || []) for (const s of t.series) if (s.source.type === 'fields') ['start', 'end', 'at'].forEach((k) => s.source[k] && keys.add(s.source[k]));
  for (const p of flow.pages) for (const l of p.step?.links || []) templateVars(linkUrl(flow, l)).forEach((v) => keys.add(v));
  return keys;
}

function stepIssues(flow, p, out) {
  for (const l of p.step?.links || []) {
    const url = linkUrl(flow, l);
    const name = l.label || (l.to ? `Open ${pageOf(flow, l.to)?.name || 'the page'}` : 'a link');
    if (!url) { out.push(issue('error', 'link-empty', `${p.name}: the link “${name}” has no address`, { pageId: p.id, linkId: l.id })); continue; }
    for (const e of templateErrors(url, flow.fields)) out.push(issue('error', 'link-bad', `${p.name}: the link “${name}” ${e}`, { pageId: p.id, linkId: l.id }));
  }
}

function timelineIssues(flow, out) {
  for (const t of flow.timelines || []) {
    if (!t.series.length) { out.push(issue('warn', 'tl-empty', `The timeline ${t.name} has no series yet`, { timelineId: t.id })); continue; }
    for (const s of t.series) {
      const what = `${t.name}: ${s.label}`;
      const src = s.source;
      if (src.type === 'page') {
        const page = pageOf(flow, src.pageId);
        if (!page || page.role !== 'input') { out.push(issue('error', 'tl-page', `${what} needs a page to clip to read its dates from`, { timelineId: t.id })); continue; }
        if (!seriesComplete(s)) out.push(issue('error', 'tl-incomplete', `${what} needs ${!src.rows ? 'the rows to read' : s.kind === 'bar' ? 'a start date' : 'a date'} on ${page.name}`, { timelineId: t.id }));
        else if (!page.draft) out.push(issue('error', 'tl-page', `${what}: ${page.name} isn’t made yet`, { timelineId: t.id, pageId: page.id }));
      } else {
        const keys = s.kind === 'bar' ? [src.start, src.end].filter(Boolean) : [src.at].filter(Boolean);
        if (!keys.length) out.push(issue('error', 'tl-incomplete', `${what} needs ${s.kind === 'bar' ? 'a start date field' : 'a date field'}`, { timelineId: t.id }));
        for (const k of keys) if (flow.fields[k]?.type !== 'date') out.push(issue('error', 'tl-field', `${what}: ${flow.fields[k]?.label || k} isn’t a date field`, { timelineId: t.id, key: k }));
      }
    }
  }
}

// ------------------------------------------------------------------ compiling and export

const uniq = (base, used) => { let id = base; for (let n = 2; used.has(id); n++) id = `${base}-${n}`; used.add(id); return id; };

/** The library files the flow becomes: fields.json, a form and a fill profile per output, a profile per input. */
export function compileFlow(flow, { identifierTypes = null } = {}) {
  const files = {};
  const section = String(flow.name || 'Flow').slice(0, 60);
  const fields = Object.fromEntries(Object.entries(flow.fields).map(([k, f]) => [k, { section, ...cleanDef(f) }]));
  files['fields.json'] = { schema: 'powerloader-fields/1', fields, ...(identifierTypes ? { identifierTypes } : {}) };
  const formIds = new Set();
  const pageIds = new Set();
  const compiled = {}; // flow page id → { formId } | { profileId }
  for (const p of flow.pages) {
    if (!p.draft || p.role === 'guide') continue;
    if (p.role === 'output') {
      // A form that came from a library keeps its id, version, rules and confirmation page.
      const id = uniq(p.formId || slug(p.name), formIds);
      const keys = keysOf(p);
      const body = exportBody(p.draft);
      const meta = p.form || {};
      const version = /^v\d+$/.test(meta.version || '') ? meta.version : 'v1';
      const rules = (meta.rules || []).filter((r) => keys.includes(r.field) && (r.before ?? r.after) !== undefined && ((r.before ?? r.after) === 'today' || keys.includes(r.before ?? r.after)));
      files[`forms/${id}.json`] = {
        schema: 'powerloader-form/1', id, name: p.name, ...(meta.short ? { short: meta.short } : {}), category: meta.category || section, version, ...(p.url ? { url: p.url } : {}), fill: `fill/${id}`,
        fields: keys.map((key) => ({ key, ...((p.required || []).includes(key) ? { required: true } : {}) })),
        ...(rules.length ? { rules } : {}), ...(meta.confirmation ? { confirmation: meta.confirmation } : {}), ...(meta.sideEffects?.length ? { sideEffects: meta.sideEffects } : {}),
      };
      files[`profiles/fill/${id}.json`] = { ...body, schema: PROFILE_SCHEMA, id: `fill/${id}`, name: p.name, version: body.version || 'v1', form: { id, version } };
      compiled[p.id] = { formId: id };
    } else {
      const body = exportBody(p.draft);
      const host = String(body.id || 'page').split('/')[0];
      const id = uniq(p.profileId || `${host}/${slug(p.name)}`, pageIds);
      // Timeline series read on this page are lists in its profile, so a clip carries their rows.
      files[`profiles/pages/${id}.json`] = { ...body, schema: PROFILE_SCHEMA, id, name: p.name, version: body.version || 'v1', fields: { ...body.fields, ...seriesFields(flow, p.id) } };
      compiled[p.id] = { profileId: id };
    }
  }
  const steps = compileSteps(flow, compiled);
  if (steps) files['steps.json'] = steps;
  const timelines = compileTimelines(flow, compiled);
  if (timelines) files['timelines.json'] = timelines;
  return { files, hosts: flowHosts(flow) };
}

// steps.json, when the flow guides the caseworker: a page to visit, or instructions or links on any page.
function compileSteps(flow, compiled) {
  const guided = flow.pages.some((p) => p.role === 'guide' || p.step?.text?.trim() || p.step?.links?.length);
  if (!guided) return null;
  const steps = [];
  for (const p of journeyOf(flow)) {
    if (p.role !== 'guide' && !compiled[p.id]) continue;
    const links = (p.step?.links || []).map((l) => ({ label: l.label.trim() || `Open ${pageOf(flow, l.to)?.name || 'the page'}`, url: linkUrl(flow, l), ...(l.to ? { to: l.to } : {}) })).filter((l) => l.url);
    steps.push({
      id: p.id, name: p.name, role: p.role, text: p.step?.text || '', links, ...compiled[p.id],
      ...(p.role === 'guide' && p.url ? { url: p.url, match: [p.match || `${p.url}*`] } : {}),
    });
  }
  return { schema: STEPS_SCHEMA, steps };
}

function compileTimelines(flow, compiled) {
  const timelines = (flow.timelines || []).map((t) => ({
    id: t.id, name: t.name,
    series: t.series.filter(seriesComplete).filter((s) => s.source.type !== 'page' || compiled[s.source.pageId]?.profileId).map((s) => ({
      id: s.id, label: s.label, kind: s.kind, colour: s.colour, ...(s.kind === 'point' ? { shape: s.shape } : { gaps: s.gaps !== false }),
      source: s.source.type === 'page' ? { profile: compiled[s.source.pageId].profileId, group: seriesKey(s) }
        : s.kind === 'bar' ? { start: s.source.start, ...(s.source.end ? { end: s.source.end } : {}) } : { at: s.source.at },
    })),
  })).filter((t) => t.series.length);
  return timelines.length ? { schema: TIMELINES_SCHEMA, timelines } : null;
}

export const flowFileName = (flow) => `${slug(flow.name || 'flow')}.flow.json`;

// Where a page came from in a library: the form's id and details, the page profile's id. Kept through export.
function pageExtras(p) {
  const out = {};
  if (p.role === 'guide' && typeof p.match === 'string') out.match = p.match.slice(0, 500);
  if (isObj(p.step)) {
    out.step = {
      text: typeof p.step.text === 'string' ? p.step.text.slice(0, 5000) : '',
      links: (Array.isArray(p.step.links) ? p.step.links : []).filter(isObj).slice(0, 12).map((l) => ({
        id: typeof l.id === 'string' ? l.id.slice(0, 40) : rid('l'), label: String(l.label || '').slice(0, 80), url: String(l.url || '').slice(0, 2000), to: String(l.to || ''),
      })),
    };
  }
  if (typeof p.formId === 'string' && /^[A-Za-z0-9][\w-]*$/.test(p.formId)) out.formId = p.formId;
  if (typeof p.profileId === 'string' && /^[\w.-]+(\/[\w.-]+)*$/.test(p.profileId)) out.profileId = p.profileId;
  if (isObj(p.form)) {
    const f = p.form;
    out.form = {
      ...(typeof f.version === 'string' ? { version: f.version } : {}), ...(typeof f.short === 'string' ? { short: f.short.slice(0, 20) } : {}),
      ...(typeof f.category === 'string' ? { category: f.category.slice(0, 60) } : {}), ...(Array.isArray(f.rules) ? { rules: structuredClone(f.rules).filter(isObj) } : {}),
      ...(isObj(f.confirmation) ? { confirmation: structuredClone(f.confirmation) } : {}),
      ...(Array.isArray(f.sideEffects) ? { sideEffects: f.sideEffects.filter((x) => typeof x === 'string') } : {}),
    };
  }
  return out;
}

/** The export file, without its hash (see contentHash in lib/hash.js). */
export function exportFlow(flow, issues = validateFlow(flow)) {
  const { files, hosts } = compileFlow(flow);
  return {
    schema: FLOW_SCHEMA, id: flow.id, name: flow.name, guidance: flow.guidance || '', hosts,
    fields: structuredClone(flow.fields), journey: journeyOf(flow).map((p) => p.id), timelines: structuredClone(flow.timelines || []),
    pages: flow.pages.map((p) => ({ id: p.id, role: p.role, name: p.name, url: p.url || '', required: [...(p.required || [])], ...pageExtras(p), ...(p.draft ? { kind: p.draft.kind, profile: structuredClone(p.draft.profile), picks: structuredClone(picksOf(p.draft)) } : {}) })),
    problems: issues.filter((i) => i.level === 'error').map((i) => i.text),
    files,
  };
}

export const exportBlocked = (issues) => issues.find((i) => i.code === 'leaks') || null;

/** Open an exported flow file. Its pages come back untested: tests are made on this computer. */
export function importFlow(doc) {
  if (!isObj(doc) || doc.schema !== FLOW_SCHEMA) throw new Error('This isn’t a Power Loader flow file');
  if (!isObj(doc.fields) || validateFieldDefs(doc.fields).length) throw new Error('The flow’s fields aren’t valid');
  if (!Array.isArray(doc.pages) || !doc.pages.length) throw new Error('The flow has no pages');
  const flow = newFlow({ name: String(doc.name || 'Imported flow').slice(0, 80), guidance: String(doc.guidance || '').slice(0, 5000) });
  flow.fields = Object.fromEntries(Object.entries(doc.fields).map(([k, f]) => [k, cleanDef(f)]));
  const ids = new Map();
  flow.pages = doc.pages.filter((p) => isObj(p) && ROLES[p.role]).map((p) => {
    const page = { id: rid('p'), role: p.role, name: String(p.name || ROLES[p.role]).slice(0, 60), url: typeof p.url === 'string' ? p.url : '', required: Array.isArray(p.required) ? p.required.filter((k) => flow.fields[k]) : [], draft: null, ...pageExtras(p) };
    if (typeof p.id === 'string') ids.set(p.id, page.id);
    if (isObj(p.profile) && p.role !== 'guide') {
      const kind = p.role === 'output' ? 'fill' : 'extract';
      page.draft = {
        id: randomDraftId(), kind, base: null, from: 'you', created: now(), updated: now(), use: false, tested: null, second: null, exported: null, conflict: null,
        profile: { ...structuredClone(p.profile), schema: PROFILE_SCHEMA, kind },
      };
      if (Array.isArray(p.picks)) page.draft.picks = structuredClone(p.picks).filter(isObj);
    }
    return page;
  });
  for (const role of NEEDED) if (!pagesOf(flow, role).length) flow.pages.push(newPage(role));
  // Page ids are new here: links, the order and timeline series follow them.
  const id = (old) => ids.get(old) || '';
  for (const p of flow.pages) for (const l of p.step?.links || []) l.to = id(l.to);
  flow.journey = (Array.isArray(doc.journey) ? doc.journey : []).map(id).filter(Boolean);
  flow.timelines = (Array.isArray(doc.timelines) ? doc.timelines : []).filter((t) => isObj(t) && Array.isArray(t.series)).slice(0, 20).map((t) => {
    const out = addTimeline(flow, String(t.name || ''));
    for (const s of t.series.filter(isObj).slice(0, 20)) {
      const src = isObj(s.source) ? s.source : {};
      const made = addSeries(flow, out.id, { label: String(s.label || ''), kind: s.kind, type: src.type === 'fields' ? 'fields' : 'page' });
      setSeries(flow, out.id, made.id, { colour: s.colour, shape: s.shape, gaps: typeof s.gaps === 'boolean' ? s.gaps : undefined, source: { ...Object.fromEntries(['rows', 'label', 'start', 'end', 'at'].map((k) => [k, typeof src[k] === 'string' ? src[k] : ''])), pageId: id(src.pageId) } });
    }
    return out;
  });
  return flow;
}

// Has the flow changed since it was exported?
// The order and timelines count only once set, so a flow exported before they existed isn't "changed since".
export const flowSnapshot = (flow) => canonical({
  name: flow.name, guidance: flow.guidance, fields: flow.fields, pages: flow.pages.map((p) => ({ ...p, draft: p.draft?.profile || null })),
  ...(flow.journey?.length ? { journey: flow.journey } : {}), ...(flow.timelines?.length ? { timelines: flow.timelines } : {}),
});
export const exportedNow = (flow) => !!(flow.exported && flow.exported.snapshot === flowSnapshot(flow));

// ------------------------------------------------------------------ from a library

// A draft of a published profile, counted as tested until it is edited: the library's maintainers tested it.
function publishedDraft(profile, commit, kind) {
  const { path, draft, ...body } = structuredClone(profile); // eslint-disable-line no-unused-vars
  return {
    id: randomDraftId(), kind, base: { id: body.id, version: body.version, commit }, from: 'library', created: now(), updated: now(),
    use: false, second: null, exported: null, conflict: null, profile: { ...body, schema: PROFILE_SCHEMA, kind },
    tested: { at: now(), url: 'library', ok: true, fields: {}, leaks: [], snapshot: canonical({ ...body, schema: PROFILE_SCHEMA, kind }), library: commit },
  };
}

/**
 * A flow from the library's forms: each form (with its fill profile) is a form to fill, every page profile
 * that reads one of their fields is a page to clip, and the fields come with their library definitions.
 * Page profiles keep only the fields the forms use.
 */
export function flowFromLibrary(lib, formIds) {
  const forms = formIds.map((id) => lib.forms[id]).filter(Boolean);
  if (!forms.length) throw new Error('Choose a form from the library');
  const flow = newFlow({ name: forms.map((f) => f.name).join(' + ').slice(0, 80) });
  flow.pages = [];
  flow.source = { commit: lib.commit, forms: forms.map((f) => `${f.id}@${f.version}`) };
  const keys = new Set(forms.flatMap((f) => f.fields.map((x) => x.key)));
  for (const k of keys) if (lib.fields[k]) flow.fields[k] = cleanDef(lib.fields[k]);
  for (const f of forms) {
    const fill = lib.fill.find((p) => p.id === f.fill) || lib.fill.find((p) => p.form?.id === f.id) || null;
    flow.pages.push({
      id: rid('p'), role: 'output', name: f.name, url: f.url || '', formId: f.id,
      form: pageExtras({ form: { version: f.version, short: f.short, category: f.category, rules: f.rules, confirmation: f.confirmation, sideEffects: f.sideEffects } }).form,
      required: f.fields.filter((x) => x.required).map((x) => x.key), draft: fill ? publishedDraft(fill, lib.commit, 'fill') : null,
    });
  }
  for (const p of lib.profiles) {
    const reads = Object.keys(p.fields || {}).filter((k) => keys.has(k));
    if (!reads.length) continue;
    const d = publishedDraft({ ...p, fields: Object.fromEntries(reads.map((k) => [k, p.fields[k]])) }, lib.commit, 'extract');
    // Fewer fields than the library's file: no longer the published profile, so it needs a test here.
    if (reads.length !== Object.keys(p.fields).length) d.tested = null;
    flow.pages.push({ id: rid('p'), role: 'input', name: p.name, url: p.urlPattern || '', profileId: p.id, required: [], draft: d });
  }
  if (!pagesOf(flow, 'input').length) flow.pages.push(newPage('input'));
  return flow;
}

// ------------------------------------------------------------------ starting a case from a flow

/**
 * Can a case start from this flow? It needs at least one form with a fill profile, and files that pass the
 * library's checks. Pages not tested on this computer don't stop it: they are listed, for a warning.
 */
export function startable(flow) {
  const { files, hosts } = compileFlow(flow);
  const lib = indexLibrary({ files }, { approvedHosts: hosts });
  const formIds = Object.keys(lib.forms);
  const untested = flow.pages.filter((p) => p.draft && !testCurrent(p.draft)).map((p) => p.name);
  const failed = flow.pages.filter((p) => p.draft && testCurrent(p.draft) && !p.draft.tested.ok).map((p) => p.name);
  const unmade = flow.pages.filter((p) => p.role !== 'guide' && (!p.draft || !keysOf(p).length)).map((p) => p.name);
  let reason = null;
  if (lib.problems.length) reason = `${lib.problems[0].path}: ${lib.problems[0].errors[0]}`;
  else if (!formIds.length) reason = 'Make a form to fill first: a case starts from the forms it fills';
  return { ok: !reason, reason, formIds, untested, failed, unmade };
}

/**
 * The flow as a stored library set, for a case to pin. Its commit names the flow and its content, so a
 * changed flow is a new set and a case keeps the version it started with. A connected library lends its
 * privacy patterns and identifier types.
 */
export function flowSet(flow, { hash, base = null, now: at = now() }) {
  const { files, hosts } = compileFlow(flow, { identifierTypes: base?.identifierTypes && Object.keys(base.identifierTypes).length ? base.identifierTypes : null });
  if (base?.privacy) files['privacy.json'] = structuredClone(base.privacy);
  return {
    commit: `flow-${flow.id.replace(/^f-/, '')}-${String(hash).slice(0, 12)}`, message: flow.name || 'Flow', syncedAt: at,
    manifest: { schema: 'powerloader-library/1', approvedHosts: [...new Set([...hosts, ...(base?.approvedHosts || [])])] }, files, flow: { id: flow.id, name: flow.name },
  };
}

export const isFlowCommit = (commit) => /^flow-/.test(String(commit || ''));

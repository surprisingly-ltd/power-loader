// Flows: what a library author makes in Power Loader, with or without a connected library. A flow is the forms
// a case fills (output pages), the pages it clips from (input pages) and the contract between them: the
// fields, defined once. It compiles to the files of a library, so a maintainer can add it as it is.
// Pure functions, no browser APIs. See docs/plans/flow-authoring.md.
//
// Flow: { schema, id, name, guidance, created, updated, fields: { key: FieldDef }, pages: [Page],
//         journey?: [pageId] (the order the caseworker takes the pages), timelines?: [Timeline] }
// Page: { id, role: 'output' | 'input' | 'guide' | 'email' | 'scan' | 'fetch', name, url, required: [key], draft: Draft | null,
//         match? (guide pages and fetch steps), step?: { text, links: [{ id, label, url, to }] },
//         choose?: { label, next: pageId } (a guide page where the caseworker chooses the case: the next page's
//         address, which has {ref} in it, gives the case reference),
//         fetch? { requests: [{ id, name, pageId, url, required, each? }], then: { to, url, open: 'ask' }, show? } (fetch
//         steps). A request with each: { pageId, list, max } fetches every link in the list field `list` that the
//         page each.pageId reads (the trigger page's own profile, a child of the step too), read with pageId.
//         parent?: fetch step id (a page to clip that a fetch step fetches: not a step of its own),
//         email? { to, cc, subject, body } (email steps), scan? { reads: [{ key, anchor, pattern }] } (scan steps),
//         annotations?: [{ id, selector, type, style, html }] (notes drawn on the page; see lib/annotations.js),
//         autoClipDelay?: ms (input pages: with auto-clip on, how long to wait after the page loads) }
//   An output page's draft is a fill draft (box → field); an input page's is an extraction draft. A guide
//   page (a case list, a search page) has no draft: it is a step on the way, with its instructions and links.
//   An email step is an email the caseworker sends from their own email app, its parts templated from the
//   case. A scan step reads a screenshot (a desktop system, a letter) with OCR on this computer: it gathers
//   its fields like a page to clip, and can read the case reference (key "ref"). A fetch step fetches pages
//   from its trigger page (url and match, as for a page to visit) when the caseworker presses its button; each
//   request's page is an ordinary page to clip with parent set, so its profile, tests and the contract are reused.
// Timeline: { id, name, series: [{ id, label, kind: 'bar' | 'point', colour, shape, gaps,
//             source: { type: 'page', pageId, rows, label, start, end, at } | { type: 'fields', start, end, at } }] }
import { canonical } from './hash.js';
import { TYPES, validateFieldDefs } from './fields.js';
import { indexLibrary } from './library.js';
import { allowed, globVerdict, isBackgroundRule } from './access.js';
import { LIMITS as NOTE_LIMITS, annotationErrors, noteVars } from './annotations.js';
import { CLIP_DELAYS, COLOURS, MAX_LIST, MAX_REQUESTS, SHAPES, STEPS_SCHEMA, TIMELINES_SCHEMA, chooseTemplateErrors, showErrors, emailErrors, fetchTemplateErrors, scanErrors, templateErrors, templateVars } from './journey.js';
import {
  editDraft, editPicks, exportBody, newFillDraft, newPageDraft, picksOf, randomDraftId, rowPicksOf, SCHEMA as PROFILE_SCHEMA, suggestPatterns,
} from './drafts.js';

export const FLOW_SCHEMA = 'powerloader-flow/1';
export const ROLES = { output: 'Form to fill', input: 'Page to clip', guide: 'Page to visit', email: 'Email to send', scan: 'Screenshot to read', fetch: 'Pages to fetch' };
// Steps that aren't a web page: nothing to bind, read or fill on a page.
export const OFF_PAGE = ['email', 'scan'];
// A flow needs a form to fill and a page to clip; pages to visit are optional. A flow that fetches a list of
// links can have no form: its results are rows (an inbox triage), and the page that reads each link is its page.
const NEEDED = ['output', 'input'];
export const isListRequest = (r) => isObj(r?.each);
export const hasListRequest = (flow) => flow.pages.some((p) => p.role === 'fetch' && requestsOf(p).some(isListRequest));
const needed = (flow, role) => role === 'input' || !hasListRequest(flow);
const now = () => new Date().toISOString();
const rid = (p) => `${p}-${randomDraftId().slice(2)}`;
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'page';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function newPage(role, n = 1) {
  return {
    id: rid('p'), role, name: `${ROLES[role]} ${n}`, url: '', required: [], draft: null, ...(role === 'guide' || role === 'fetch' ? { match: '' } : {}),
    ...(role === 'email' ? { email: { to: '', cc: '', subject: '', body: '' } } : {}), ...(role === 'scan' ? { scan: { reads: [] } } : {}),
    ...(role === 'fetch' ? { fetch: { requests: [], then: { to: '', url: '', open: 'ask' } } } : {}),
  };
}

export function newFlow({ name = '', guidance = '' } = {}) {
  return {
    schema: FLOW_SCHEMA, id: rid('f'), name: String(name).trim(), guidance: String(guidance), created: now(), updated: now(),
    fields: {}, pages: [newPage('output'), newPage('input')], journey: [], timelines: [],
  };
}

export const pagesOf = (flow, role) => flow.pages.filter((p) => p.role === role);
/** Pages of a role that are steps of their own: not the pages a fetch step fetches. */
export const stepPagesOf = (flow, role) => pagesOf(flow, role).filter((p) => !p.parent);
export const pageOf = (flow, id) => flow.pages.find((p) => p.id === id) || null;

export function addPage(flow, role) {
  const p = newPage(role, pagesOf(flow, role).length + 1);
  flow.pages.push(p);
  return p;
}

export function removePage(flow, id) {
  const p = pageOf(flow, id);
  if (!p) return false;
  if (NEEDED.includes(p.role) && needed(flow, p.role) && pagesOf(flow, p.role).length <= 1) throw new Error(`A flow needs at least one ${ROLES[p.role].toLowerCase()}`);
  flow.pages.splice(flow.pages.indexOf(p), 1);
  flow.journey = (flow.journey || []).filter((x) => x !== id);
  // A fetch step's pages go with it; a fetched page that goes takes its request with it.
  if (p.role === 'fetch') for (const r of requestsOf(p)) for (const cid of [r.pageId, r.each?.pageId]) { const child = pageOf(flow, cid); if (child) flow.pages.splice(flow.pages.indexOf(child), 1); }
  for (const q of flow.pages) if (q.role === 'fetch') q.fetch.requests = requestsOf(q).filter((r) => r.pageId !== id && r.each?.pageId !== id);
  for (const q of flow.pages) for (const l of q.step?.links || []) if (l.to === id) l.to = '';
  for (const q of flow.pages) if (q.choose?.next === id) delete q.choose;
  for (const q of flow.pages) if (q.fetch?.then?.to === id) q.fetch.then.to = '';
  for (const t of flow.timelines || []) for (const s of t.series) if (s.source?.pageId === id) s.source.pageId = '';
  return true;
}

// ------------------------------------------------------------------ the caseworker's steps

const ROLE_ORDER = { guide: 0, fetch: 0, input: 1, scan: 1, output: 2, email: 3 };

/**
 * The pages in the order the caseworker takes them: the author's order, then any page not placed yet. A page
 * a fetch step fetches isn't a step of its own.
 */
export function journeyOf(flow) {
  const byId = new Map(flow.pages.filter((p) => !p.parent).map((p) => [p.id, p]));
  const placed = [...new Set(flow.journey || [])].filter((id) => byId.has(id));
  const rest = [...byId.values()].filter((p) => !placed.includes(p.id)).sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);
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

/**
 * When the step is needed: null (always), or { field, is: 'missing' | 'present' }, field a field key or ref.
 * The caseworker's Next passes over a step that isn't needed for the case (lib/journey.js stepNeeded()).
 */
export function setStepWhen(page, when) {
  const st = stepOf(page);
  if (!when || !when.field || !['missing', 'present'].includes(when.is)) delete st.when;
  else st.when = { field: String(when.field).slice(0, 40), is: when.is };
}

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

// ------------------------------------------------------------------ choosing the case

export const CHOOSE_LABEL = 'Choose a case';
/**
 * Make a page to visit the place the caseworker chooses the case, or stop it being one (next: null). The next
 * page is the one whose address gives the reference, such as the case page at …/case-{ref}.html.
 */
export function setChoose(page, next) {
  if (page.role !== 'guide') return;
  if (!next) { delete page.choose; return; }
  page.choose = { label: String(page.choose?.label || CHOOSE_LABEL).slice(0, 80), next: String(next) };
}
/** The page a choose step takes the reference from, if it has one. */
export const choosesFrom = (flow, page) => (page?.role === 'guide' && page.choose?.next ? pageOf(flow, page.choose.next) : null);

// ------------------------------------------------------------------ fetch steps

export const requestsOf = (page) => (Array.isArray(page?.fetch?.requests) ? page.fetch.requests : []);
const fetchOf = (page) => { page.fetch = { requests: requestsOf(page), then: { to: '', url: '', open: 'ask', ...(page.fetch?.then || {}) } }; return page.fetch; };
/** A request's address: its own, or its page's link pattern. */
export const requestUrl = (flow, r) => r.url || (r.pageId ? pageAddress(pageOf(flow, r.pageId)) : '');
/** Where a fetch step goes next: its own address, or the page it opens. */
export const thenUrl = (flow, page) => page.fetch?.then?.url || (page.fetch?.then?.to ? pageAddress(pageOf(flow, page.fetch.then.to)) : '');

/**
 * A request of a fetch step, with its page: a new page to clip whose parent is the step. The author makes
 * that page's profile on the real page, as for any page to clip, then tests it as fetched.
 */
export function addRequest(flow, fetchId, { name = '' } = {}) {
  const step = pageOf(flow, fetchId);
  if (!step || step.role !== 'fetch') throw new Error('That fetch step is no longer in the flow');
  const f = fetchOf(step);
  if (f.requests.length >= MAX_REQUESTS) throw new Error(`A fetch step fetches at most ${MAX_REQUESTS} pages: split it into two steps`);
  const page = newPage('input', f.requests.length + 1);
  page.name = String(name).trim().slice(0, 60) || `Page to fetch ${f.requests.length + 1}`;
  page.parent = step.id;
  flow.pages.push(page);
  const r = { id: rid('r'), name: page.name, pageId: page.id, url: '', required: true };
  f.requests.push(r);
  return { request: r, page };
}

/**
 * A request that fetches every link in a list on the step's own page: two pages, both children of the step.
 * The list's page is the trigger page's profile, with a list field whose rows have an href; the other reads
 * each page the links go to. At most one a step; never required, as a list can be empty.
 */
export function addListRequest(flow, fetchId, { name = '', max = MAX_LIST } = {}) {
  const step = pageOf(flow, fetchId);
  if (!step || step.role !== 'fetch') throw new Error('That fetch step is no longer in the flow');
  const f = fetchOf(step);
  if (f.requests.some(isListRequest)) throw new Error('A fetch step fetches at most one list of links');
  const listPage = newPage('input');
  listPage.name = `${step.name}: the list`;
  listPage.parent = step.id;
  const page = newPage('input');
  page.name = String(name).trim().slice(0, 60) || 'Each linked page';
  page.parent = step.id;
  flow.pages.push(listPage, page);
  const r = { id: rid('r'), name: page.name, pageId: page.id, url: '', required: false, each: { pageId: listPage.id, list: '', max: Math.min(Math.max(1, Math.round(max) || MAX_LIST), MAX_LIST) } };
  f.requests.push(r);
  return { request: r, page, listPage };
}

/** What a fetch step's card lists after a run: { type, where, label, columns, mark? }, or null for none. */
export function setShow(page, show) {
  if (page.role !== 'fetch') return;
  const f = fetchOf(page);
  if (!show) { delete f.show; return; }
  f.show = cleanShow(show);
}
const cleanShow = (s) => ({
  type: String(s.type || '').slice(0, 40), label: String(s.label || '').slice(0, 80),
  where: Object.fromEntries(Object.entries(isObj(s.where) ? s.where : {}).slice(0, 8).map(([k, v]) => [String(k).slice(0, 40), String(v).slice(0, 200)])),
  columns: (Array.isArray(s.columns) ? s.columns : []).slice(0, 8).map((k) => String(k).slice(0, 40)),
  ...(isObj(s.mark) ? { mark: { row: String(s.mark.row || '').slice(0, 200), key: String(s.mark.key || '').slice(0, 40), rowKey: String(s.mark.rowKey || '').slice(0, 60), text: String(s.mark.text || '').slice(0, 40), ...(typeof s.mark.style === 'string' && s.mark.style ? { style: s.mark.style.slice(0, 200) } : {}) } } : {}),
});

/** The list fields of a page to clip whose rows each have an href: the lists a list request can fetch. */
export const linkLists = (page) => Object.entries(page?.draft?.profile?.fields || {}).filter(([, spec]) => Array.isArray(spec) && spec[1] && typeof spec[1] === 'object' && typeof spec[1].href === 'string').map(([k]) => k);

export function setRequest(flow, fetchId, requestId, change) {
  const r = requestsOf(pageOf(flow, fetchId)).find((x) => x.id === requestId);
  if (!r) return;
  if (isListRequest(r)) {
    if (typeof change.list === 'string') r.each.list = change.list.slice(0, 40);
    if (Number.isFinite(change.max)) r.each.max = Math.min(Math.max(1, Math.round(change.max)), MAX_LIST);
    r.required = false;
  }
  if (typeof change.name === 'string') { r.name = change.name.slice(0, 80); const p = pageOf(flow, r.pageId); if (p && r.name.trim()) renamePage(p, r.name); }
  if (typeof change.url === 'string') r.url = change.url.trim().slice(0, 2000);
  if (typeof change.required === 'boolean') r.required = change.required;
}

/**
 * A request as it will be sent, for the author's preview and the maintainer's review: the method, the site
 * written out, the path with each {name}, what it sends from the case and the page that reads the response.
 * { method, site, path, sends: [{ key, label }], page, data } (data: the response is read as JSON)
 */
export function requestPreview(flow, r) {
  if (isListRequest(r)) {
    const page = pageOf(flow, r.pageId);
    return {
      method: 'GET', site: '', path: '', sends: [], page: page?.name || null, data: readsJson(page), each: true,
      text: `Up to ${r.each.max} addresses taken from the links in “${r.each.list || 'a list'}” on this page, each one checked against ${page?.name || 'its page'}’s pattern and the site rules.`,
    };
  }
  const url = requestUrl(flow, r);
  const m = /^(https?:\/\/[^/?#]*)(.*)$/i.exec(url);
  return {
    method: 'GET', site: m ? m[1] : '', path: m ? m[2] : url,
    sends: templateVars(url).map((k) => ({ key: k, label: k === 'ref' ? 'Case reference' : flow.fields[k]?.label || k })),
    page: pageOf(flow, r.pageId)?.name || null,
    data: readsJson(pageOf(flow, r.pageId)),
  };
}

/** Remove a request and the page it fetches. */
export function removeRequest(flow, fetchId, requestId) {
  const step = pageOf(flow, fetchId);
  const r = requestsOf(step).find((x) => x.id === requestId);
  if (!r) return;
  step.fetch.requests = requestsOf(step).filter((x) => x.id !== requestId);
  for (const cid of [r.pageId, r.each?.pageId]) { const child = pageOf(flow, cid); if (child) flow.pages.splice(flow.pages.indexOf(child), 1); }
}

/** Where the caseworker goes once the pages are fetched: another page of the flow, or an address template. */
export function setThen(page, change) {
  const t = fetchOf(page).then;
  if (typeof change.to === 'string') t.to = change.to;
  if (typeof change.url === 'string') t.url = change.url.trim().slice(0, 2000);
  t.open = 'ask';
}

/**
 * Has this page to clip passed a test as fetched (fetched as a case would, and read with its profile), with
 * the profile unchanged since? A page that passes in the tab but not as fetched builds itself after it loads.
 */
export const fetchedNow = (draft) => !!(testCurrent(draft) && draft.tested.fetched?.ok && draft.tested.fetched.snapshot === draft.tested.snapshot);

/** Keep a test as fetched with the page's test: { at, ok, url, fields, error? }. It needs a current test on the page. */
export function recordFetchedTest(draft, test) {
  if (!testCurrent(draft)) throw new Error('Test it on the page first, then as fetched');
  draft.tested.fetched = { at: test.at || now(), ok: !!test.ok, snapshot: draft.tested.snapshot, ...(test.error ? { error: String(test.error).slice(0, 200) } : {}) };
  return draft.tested.fetched;
}

// ------------------------------------------------------------------ email and scan steps

const EMAIL_PARTS = { to: 500, cc: 500, subject: 300, body: 5000 };

/** Change an email step's templates: { to?, cc?, subject?, body? }, each text with {ref} or {fieldKey} in it. */
export function setEmail(page, change) {
  page.email = { to: '', cc: '', subject: '', body: '', ...(page.email || {}) };
  for (const [k, max] of Object.entries(EMAIL_PARTS)) if (typeof change[k] === 'string') page.email[k] = change[k].slice(0, max);
}

/** The values a scan step reads: { key, anchor, pattern }, key a field of the flow or ref. */
export const readsOf = (page) => (Array.isArray(page.scan?.reads) ? page.scan.reads : []);
const scanOf = (page) => { page.scan = { reads: readsOf(page) }; return page.scan; };

export function addRead(page, key, { anchor = '', pattern = '' } = {}) {
  const sc = scanOf(page);
  if (!key || sc.reads.some((r) => r.key === key)) return;
  sc.reads.push({ key: String(key), anchor: String(anchor).slice(0, 80), pattern: String(pattern).slice(0, 200) });
}

export function setRead(page, key, change) {
  const r = scanOf(page).reads.find((x) => x.key === key);
  if (!r) return;
  if (typeof change.anchor === 'string') r.anchor = change.anchor.slice(0, 80);
  if (typeof change.pattern === 'string') r.pattern = change.pattern.slice(0, 200);
}

export function removeRead(page, key) { const sc = scanOf(page); sc.reads = sc.reads.filter((r) => r.key !== key); }

/** The case fields a scan step gathers (not ref, which is the case's own reference). */
export const scanKeys = (page) => (page.role === 'scan' ? readsOf(page).map((r) => r.key).filter((k) => k !== 'ref') : []);

// ------------------------------------------------------------------ notes on a page

/** Pages a note can go on: the ones with an address. */
export const notable = (page) => !OFF_PAGE.includes(page?.role);
export const notesOf = (page) => (Array.isArray(page.annotations) ? page.annotations : []);

export function addNote(page, { selector = '', type = 'expanded', style = '', html = '' } = {}) {
  if (!notable(page)) throw new Error('Notes go on a page with an address');
  page.annotations = notesOf(page);
  if (page.annotations.length >= NOTE_LIMITS.perStep) throw new Error(`A page has at most ${NOTE_LIMITS.perStep} notes`);
  const note = { id: rid('n'), selector: String(selector).slice(0, NOTE_LIMITS.selector), type: type === 'compact' ? 'compact' : 'expanded', style: String(style).slice(0, NOTE_LIMITS.style), html: String(html).slice(0, NOTE_LIMITS.html) };
  page.annotations.push(note);
  return note;
}

export function setNote(page, id, change) {
  const n = notesOf(page).find((x) => x.id === id);
  if (!n) return;
  if (typeof change.selector === 'string') n.selector = change.selector.trim().slice(0, NOTE_LIMITS.selector);
  if (change.type === 'expanded' || change.type === 'compact') n.type = change.type;
  if (typeof change.style === 'string') n.style = change.style.slice(0, NOTE_LIMITS.style);
  if (typeof change.html === 'string') n.html = change.html.slice(0, NOTE_LIMITS.html);
}

/** With auto-clip on, how long to wait after a page to clip loads: one of CLIP_DELAYS, in milliseconds. */
export function setAutoClipDelay(page, ms) {
  if (page.role !== 'input') return;
  const d = CLIP_DELAYS.includes(Number(ms)) ? Number(ms) : 0;
  if (d) page.autoClipDelay = d; else delete page.autoClipDelay;
}

export function removeNote(page, id) { page.annotations = notesOf(page).filter((x) => x.id !== id); }

const cleanNotes = (list) => (Array.isArray(list) ? list : []).filter(isObj).slice(0, NOTE_LIMITS.perStep).map((n) => ({
  id: typeof n.id === 'string' && n.id ? n.id.slice(0, 40) : rid('n'), selector: String(n.selector || '').slice(0, NOTE_LIMITS.selector),
  type: n.type === 'compact' ? 'compact' : 'expanded', style: String(n.style || '').slice(0, NOTE_LIMITS.style), html: String(n.html || '').slice(0, NOTE_LIMITS.html),
}));

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
  // Whole words: "current employer" holds "rent" but isn't money.
  if (/\b(rents?|rental|income|arrears|amount|award|salary|wages?|pay|payment|balance|costs?)\b|£/.test(l)) return 'money';
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
    if (p.role === 'scan') removeRead(p, key);
    if (p.draft && picksOf(p.draft).some((x) => x.key === key)) editPicks(p.draft, (ps) => { for (let i = ps.length - 1; i >= 0; i--) if (ps[i].key === key) ps.splice(i, 1); });
  }
}

export const keysOf = (page) => (page.draft ? [...new Set(picksOf(page.draft).map((p) => p.key).filter(Boolean))] : []);
export const requiredBy = (flow, key) => pagesOf(flow, 'output').filter((p) => keysOf(p).includes(key) && (p.required || []).includes(key));
export const neededBy = (flow, key) => pagesOf(flow, 'output').filter((p) => keysOf(p).includes(key));
// A field is gathered by a page to clip that reads it, or a screenshot to read that does.
export const gatheredBy = (flow, key) => flow.pages.filter((p) => (p.role === 'input' && keysOf(p).includes(key)) || scanKeys(p).includes(key));

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
    for (const m of [p.url, ...[p.draft?.profile.match].flat(), ...requestsOf(p).map((r) => r.url)].filter(Boolean)) {
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
  if (name && !leaks && /^(Form to fill|Page to clip|Page to visit|Pages to fetch|Page to fetch) \d+$/.test(p.name)) {
    p.name = name;
    // A fetched page's request is named after it too.
    for (const q of flow.pages) for (const r of requestsOf(q)) if (r.pageId === p.id) r.name = name;
  }
  // A fetch step's trigger page is opened and recognised as a page to visit is.
  if (p.role === 'guide' || p.role === 'fetch') {
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

/**
 * Make a page a fetch step fetches read data (JSON) from an API address the author pasted, such as one from
 * the browser's network panel: a draft with format 'json', whose match and link pattern come from the address
 * with identifier-like parts as wildcards, as for a page. Its profile is made from a sample response in the
 * tree view, never on a tab (docs/plans/json-clips.md).
 */
export function bindJsonPage(flow, pageId, { url }) {
  const p = pageOf(flow, pageId);
  if (!p || p.role !== 'input') throw new Error('That page is no longer in the flow');
  let u;
  try { u = new URL(String(url || '').trim()); } catch { throw new Error('Paste the data’s full address, such as https://cases.example.gov.uk/api/clients/1042'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('The data’s address must start with https:// or http://');
  u.hash = '';
  p.url = suggestPatterns(u.href).urlPattern;
  p.draft = newPageDraft({ url: u.href, title: p.name, from: 'you' });
  p.draft.profile.name = p.name;
  p.draft.profile.format = 'json';
  return p;
}

/** Does this page read data (JSON) rather than a page? */
export const readsJson = (page) => page?.draft?.profile?.format === 'json';

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
export function validateFlow(flow, { access = null } = {}) {
  const out = [];
  if (access) accessFlowIssues(flow, access, out);
  if (!String(flow.name || '').trim()) out.push(issue('error', 'no-name', 'Give the flow a name'));
  for (const p of flow.pages) for (const e of annotationErrors(notesOf(p), flow.fields)) out.push(issue('error', 'note-bad', `${p.name}: ${e}`, { pageId: p.id }));
  const lib = flowLib(flow);
  const defErrors = validateFieldDefs(flow.fields);
  for (const e of defErrors) out.push(issue('error', 'field-def', e));
  for (const p of flow.pages) {
    const what = `${p.name}`;
    stepIssues(flow, p, out);
    if (p.role === 'guide') {
      if (!p.url) out.push(issue('warn', 'guide-unbound', `${what} has no address yet: open it on its page`, { pageId: p.id }));
      if (p.choose) {
        const next = choosesFrom(flow, p);
        if (!next) out.push(issue('error', 'choose-bad', `${CHOOSE_LABEL}: ${what} needs the page whose address gives the case reference`, { pageId: p.id }));
        else for (const e of chooseTemplateErrors(pageAddress(next))) out.push(issue('error', 'choose-bad', `${CHOOSE_LABEL}: the next page’s address ${e.replace(/^has no \{ref\} for the case reference$/, 'has no {ref}')}`, { pageId: p.id }));
      }
      continue;
    }
    if (p.role === 'email') {
      for (const e of emailErrors(p.email, flow.fields)) out.push(issue('error', 'email-bad', `${what}: the email ${e}`, { pageId: p.id }));
      if (!String(p.email?.to || '').trim()) out.push(issue('warn', 'email-no-to', `${what} has no address to send to: the caseworker chooses who it goes to in their email app`, { pageId: p.id }));
      continue;
    }
    if (p.role === 'scan') {
      for (const e of scanErrors(scanSpec(p), flow.fields)) out.push(issue('error', 'scan-bad', `${what} ${e}`, { pageId: p.id }));
      continue;
    }
    if (p.role === 'fetch') { fetchIssues(flow, p, out, access); continue; }
    if (!p.draft) { out.push(issue('error', 'unbound', `${what} isn’t made yet: open it on its page`, { pageId: p.id, ai: true })); continue; }
    const picks = picksOf(p.draft).filter((x) => x.key);
    // A page that reads rows only (a fetched message's row, an inbox's links) maps no fields, and needs none.
    if (!picks.length && !(p.role === 'input' && rowPicksOf(p.draft).length)) { out.push(issue('error', 'empty', `${what} maps no fields yet`, { pageId: p.id, ai: true })); continue; }
    const unknown = picks.filter((x) => !flow.fields[x.key]).map((x) => x.key);
    if (unknown.length) out.push(issue('error', 'unknown-field', `${what} maps ${unknown.join(', ')}, which ${unknown.length === 1 ? 'isn’t a field' : 'aren’t fields'} of this flow`, { pageId: p.id, keys: unknown }));
    const t = p.draft.tested;
    if (!t) out.push(issue('error', 'untested', `${what} hasn’t been tested ${readsJson(p) ? 'on a sample' : 'on its page'}`, { pageId: p.id }));
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

const originOf = (tpl) => /^https?:\/\/[^/?#]*/i.exec(String(tpl || ''))?.[0].toLowerCase() || '';
const sampleUrl = (tpl) => String(tpl).replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g, 'sample1');

/** A fetch step's problems: its requests, their pages and addresses, the site rules, and background reading. */
function fetchIssues(flow, p, out, access) {
  const what = p.name;
  const reqs = requestsOf(p);
  if (!p.url) out.push(issue('warn', 'fetch-no-trigger', `${what} has no page of its own yet: it’s shown in order. Open it on the page it starts from.`, { pageId: p.id }));
  if (!reqs.length) { out.push(issue('error', 'fetch-empty', `${what} fetches no pages yet: add one`, { pageId: p.id })); return; }
  const fixed = reqs.filter((r) => !isListRequest(r));
  if (fixed.length > MAX_REQUESTS) out.push(issue('error', 'fetch-too-many', `${what} fetches ${fixed.length} pages: at most ${MAX_REQUESTS}. Split it into two steps.`, { pageId: p.id }));
  if (reqs.length - fixed.length > 1) out.push(issue('error', 'fetch-too-many', `${what} fetches more than one list of links: at most one a step`, { pageId: p.id }));
  if (p.fetch?.show) for (const e of showErrors(p.fetch.show)) out.push(issue('error', 'fetch-show', `${what}: ${e}`, { pageId: p.id }));
  const hosts = flowHosts(flow);
  let offWarned = false;
  for (const r of reqs) {
    const name = `${what}: ${r.name || 'a request'}`;
    const page = pageOf(flow, r.pageId);
    if (!page || page.role !== 'input') { out.push(issue('error', 'fetch-page', `${name} has no page to read it with: make its page`, { pageId: p.id, requestId: r.id })); continue; }
    if (isListRequest(r)) { listIssues(flow, p, r, page, name, out, access); continue; }
    const url = requestUrl(flow, r);
    if (!url) { out.push(issue('error', 'fetch-address', `${name} has no address`, { pageId: p.id, requestId: r.id })); continue; }
    const errs = fetchTemplateErrors(url, flow.fields);
    for (const e of errs) out.push(issue('error', 'fetch-address', `${name}: the address ${e}`, { pageId: p.id, requestId: r.id }));
    if (errs.length) continue;
    const host = /^https?:\/\/([^/?#]+)/i.exec(url)[1].toLowerCase();
    if (!hosts.includes(host)) out.push(issue('error', 'fetch-address', `${name}: ${host} isn’t one of the flow’s systems`, { pageId: p.id, requestId: r.id }));
    if (page.draft && !globalThis.PowerLoaderExtract?.matchUrl(page.draft.profile.match, sampleUrl(url))) out.push(issue('error', 'fetch-address', `${name}: the address doesn’t match its page, ${page.name}. Edit the address.`, { pageId: p.id, requestId: r.id }));
    if (p.url && originOf(url) !== originOf(p.url)) out.push(issue('error', 'fetch-address', `${name}: the address must be on the same site as ${what}’s own page (${originOf(p.url).replace(/^https?:\/\//, '')})`, { pageId: p.id, requestId: r.id }));
    if (page.draft && testCurrent(page.draft) && page.draft.tested.ok && !fetchedNow(page.draft)) {
      out.push(issue('error', 'fetch-untested', page.draft.tested.fetched && !page.draft.tested.fetched.ok
        ? `${name}: its page didn’t read as fetched. It’s probably built after it loads, so it can’t be fetched: make it a page to clip instead.`
        : `${name}: its page hasn’t been tested as fetched`, { pageId: page.id, requestId: r.id }));
    }
    if (access) {
      const v = allowed(access, sampleUrl(url), 'fetch-get');
      if (!v.ok && isBackgroundRule(v.rule)) {
        if (!offWarned) out.push(issue('warn', 'background-off', `${what}: reading pages in the background is turned off, so this step won’t fetch its pages. The caseworker can open each page and clip it.`, { pageId: p.id, rule: v.rule }));
        offWarned = true;
      } else if (!v.ok) out.push(issue('error', 'blocked', `${name}: Power Loader can’t fetch this page: the site rules block ${url}`, { pageId: p.id, requestId: r.id, rule: v.rule }));
    }
  }
  const then = thenUrl(flow, p);
  if (then) for (const e of templateErrors(then, flow.fields)) out.push(issue('error', 'link-bad', `${what}: where it goes next ${e}`, { pageId: p.id }));
}

/** A list request's problems: its list's page and field, its maximum, and the site rules for its pages. */
function listIssues(flow, p, r, page, name, out, access) {
  const listPage = pageOf(flow, r.each.pageId);
  if (!listPage || listPage.role !== 'input' || !listPage.draft) { out.push(issue('error', 'fetch-list', `${name}: make the page with the list of links first`, { pageId: p.id, requestId: r.id })); return; }
  if (!linkLists(listPage).includes(r.each.list)) out.push(issue('error', 'fetch-list', `${name}: ${listPage.name} has no list “${r.each.list || ''}” with an href column`, { pageId: p.id, requestId: r.id }));
  if (!(Number.isInteger(r.each.max) && r.each.max >= 1 && r.each.max <= MAX_LIST)) out.push(issue('error', 'fetch-list', `${name}: a list fetches at most ${MAX_LIST} links`, { pageId: p.id, requestId: r.id }));
  if (r.required) out.push(issue('error', 'fetch-list', `${name}: a list of links can’t be required, as a list can be empty`, { pageId: p.id, requestId: r.id }));
  const first = [page.draft?.profile.match].flat()[0] || '';
  if (p.url && page.draft && originOf(first) !== originOf(p.url)) out.push(issue('error', 'fetch-address', `${name}: the pages it reads must be on the same site as ${p.name}’s own page`, { pageId: p.id, requestId: r.id }));
  if (page.draft && testCurrent(page.draft) && page.draft.tested.ok && !fetchedNow(page.draft)) out.push(issue('error', 'fetch-untested', `${name}: its page hasn’t been tested as fetched`, { pageId: page.id, requestId: r.id }));
  if (access && page.draft) {
    const sample = sampleUrl([page.draft.profile.match].flat()[0] || '').replace(/\*/g, 'sample1');
    const v = allowed(access, sample, 'fetch-get');
    if (!v.ok && isBackgroundRule(v.rule)) out.push(issue('warn', 'background-off', `${p.name}: reading pages in the background is turned off, so this step won’t fetch its pages. The caseworker can open each page and clip it.`, { pageId: p.id, rule: v.rule }));
    else if (!v.ok) out.push(issue('error', 'blocked', `${name}: Power Loader can’t fetch these pages: the site rules block them`, { pageId: p.id, requestId: r.id, rule: v.rule }));
  }
}

// What each kind of page asks of the page it's on.
const PAGE_ACTION = { output: 'fill', input: 'read', guide: 'navigate', fetch: 'navigate' };

/**
 * Pages, profiles' match patterns and links the site rules block: an error each, so a flow made or imported
 * with a page it shouldn't touch says so as soon as it opens. The flow is kept, for its author to correct.
 */
function accessFlowIssues(flow, access, out) {
  for (const p of flow.pages) {
    const action = PAGE_ACTION[p.role];
    if (action) {
      const own = [p.url, ...(p.role === 'guide' || p.role === 'fetch' ? [p.match] : [p.draft?.profile.match].flat())].filter(Boolean);
      for (const addr of [...new Set(own)]) {
        const v = globVerdict(access, addr, action);
        if (v.verdict === 'blocked') { out.push(issue('error', 'blocked', `Power Loader can’t work on ${p.name}: the site rules block ${addr}`, { pageId: p.id, rule: v.rule })); break; }
        if (v.verdict === 'some' && addr !== p.url) out.push(issue('warn', 'blocked-some', `Some pages ${p.name} matches are blocked by the site rules`, { pageId: p.id, rule: v.rule }));
      }
    }
    for (const l of p.step?.links || []) {
      const url = linkUrl(flow, l);
      if (!url || !/^https?:/i.test(url)) continue;
      const v = globVerdict(access, url, 'navigate');
      if (v.verdict === 'blocked') out.push(issue('error', 'blocked', `${p.name}: Power Loader can’t open the link “${l.label || 'a link'}”: the site rules block ${url}`, { pageId: p.id, linkId: l.id, rule: v.rule }));
    }
  }
}

// Fields a timeline or a link uses, so they aren't reported as unused.
function usedElsewhere(flow) {
  const keys = new Set();
  for (const t of flow.timelines || []) for (const s of t.series) if (s.source.type === 'fields') ['start', 'end', 'at'].forEach((k) => s.source[k] && keys.add(s.source[k]));
  for (const p of flow.pages) for (const l of p.step?.links || []) templateVars(linkUrl(flow, l)).forEach((v) => keys.add(v));
  for (const p of pagesOf(flow, 'fetch')) for (const u of [...requestsOf(p).map((r) => requestUrl(flow, r)), thenUrl(flow, p)]) templateVars(u).forEach((v) => keys.add(v));
  for (const p of pagesOf(flow, 'email')) for (const v of Object.values(p.email || {})) templateVars(v).forEach((k) => keys.add(k));
  for (const p of flow.pages) for (const n of notesOf(p)) noteVars(n).forEach((k) => keys.add(k));
  return keys;
}

function stepIssues(flow, p, out) {
  const w = p.step?.when;
  if (w) {
    const fix = { pageId: p.id, fix: 'remove-when' };
    const name = w.field === 'ref' ? 'the case reference' : flow.fields[w.field]?.label;
    if (!name) out.push(issue('error', 'when-bad', `${p.name}: it is needed only when the case ${w.is === 'missing' ? 'lacks' : 'has'} ${w.field}, which isn’t a field of this flow`, fix));
    else if (journeyOf(flow)[0]?.id === p.id) out.push(issue('error', 'when-bad', `${p.name}: the first step can’t depend on the case: nothing has been looked at yet`, fix));
    else if (choosesFrom(flow, p)) out.push(issue('error', 'when-bad', `${p.name}: the step that chooses the case is always needed`, fix));
  }
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
    if (!p.draft || !['input', 'output'].includes(p.role)) continue;
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
  files['steps.json'] = compileSteps(flow, compiled);
  const timelines = compileTimelines(flow, compiled);
  if (timelines) files['timelines.json'] = timelines;
  return { files, hosts: flowHosts(flow) };
}

// steps.json: every flow has steps, one for each page in the caseworker's order, with empty text where the
// author wrote none. A case's steps are always its flow's.
function compileSteps(flow, compiled) {
  const steps = [];
  for (const p of journeyOf(flow)) {
    if (['input', 'output'].includes(p.role) && !compiled[p.id]) continue;
    const links = (p.step?.links || []).map((l) => ({ label: l.label.trim() || `Open ${pageOf(flow, l.to)?.name || 'the page'}`, url: linkUrl(flow, l), ...(l.to ? { to: l.to } : {}) })).filter((l) => l.url);
    steps.push({
      id: p.id, name: p.name, role: p.role, text: p.step?.text || '', links, ...compiled[p.id],
      ...((p.role === 'guide' || p.role === 'fetch') && p.url ? { url: p.url, match: [p.match || `${p.url}*`] } : {}),
      ...(choosesFrom(flow, p) ? { choose: { label: p.choose.label || CHOOSE_LABEL, next: p.choose.next, url: pageAddress(choosesFrom(flow, p)) } } : {}),
      ...(p.role === 'fetch' ? { fetch: fetchSpec(flow, p, compiled) } : {}),
      ...(p.role === 'email' ? { email: emailSpec(p) } : {}), ...(p.role === 'scan' ? { scan: scanSpec(p) } : {}),
      ...(notesOf(p).length ? { annotations: structuredClone(notesOf(p)) } : {}),
      ...(p.role === 'input' && p.autoClipDelay ? { autoClipDelay: p.autoClipDelay } : {}),
      ...(p.step?.when && (p.step.when.field === 'ref' || flow.fields[p.step.when.field]) ? { when: { field: p.step.when.field, is: p.step.when.is } } : {}),
    });
  }
  return { schema: STEPS_SCHEMA, steps };
}

// A fetch step as steps.json has it: requests whose page is made, read by that page's profile, GET only.
function fetchSpec(flow, p, compiled) {
  const requests = requestsOf(p).filter((r) => compiled[r.pageId]?.profileId && (!isListRequest(r) || compiled[r.each.pageId]?.profileId)).map((r) => (isListRequest(r)
    ? { id: r.id, name: String(r.name || pageOf(flow, r.pageId)?.name || 'Pages').slice(0, 80), each: { profileId: compiled[r.each.pageId].profileId, list: r.each.list, max: r.each.max }, method: 'GET', profileId: compiled[r.pageId].profileId, required: false }
    : { id: r.id, name: String(r.name || pageOf(flow, r.pageId)?.name || 'Page').slice(0, 80), url: requestUrl(flow, r), method: 'GET', profileId: compiled[r.pageId].profileId, required: r.required !== false }));
  const then = thenUrl(flow, p);
  return { requests, ...(then ? { then: { url: then, ...(p.fetch?.then?.to ? { to: p.fetch.then.to } : {}), open: 'ask' } } : {}), ...(p.fetch?.show ? { show: cleanShow(p.fetch.show) } : {}) };
}

// An email step as steps.json has it: only the parts that are set.
const emailSpec = (p) => Object.fromEntries(Object.keys(EMAIL_PARTS).map((k) => [k, String(p.email?.[k] || '')]).filter(([k, v]) => v || k === 'to'));
// A scan step as steps.json has it: { fields: { key: { anchor?, pattern? } } }.
const scanSpec = (p) => ({
  fields: Object.fromEntries(readsOf(p).map((r) => [r.key, { ...(r.anchor?.trim() ? { anchor: r.anchor.trim() } : {}), ...(r.pattern?.trim() ? { pattern: r.pattern.trim() } : {}) }])),
});

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

// At most MAX_REQUESTS fixed requests and one list of links, in their order.
const capRequests = (list) => { let fixed = 0; let lists = 0; return list.filter((r) => (isObj(r.each) ? ++lists <= 1 : ++fixed <= MAX_REQUESTS)); };

// Where a page came from in a library: the form's id and details, the page profile's id. Kept through export.
function pageExtras(p) {
  const out = {};
  if ((p.role === 'guide' || p.role === 'fetch') && typeof p.match === 'string') out.match = p.match.slice(0, 500);
  if (p.role === 'input' && typeof p.parent === 'string' && p.parent) out.parent = p.parent.slice(0, 40);
  if (p.role === 'guide' && isObj(p.choose) && typeof p.choose.next === 'string' && p.choose.next) out.choose = { label: String(p.choose.label || CHOOSE_LABEL).slice(0, 80), next: p.choose.next.slice(0, 40) };
  if (p.role === 'fetch') {
    const f = isObj(p.fetch) ? p.fetch : {};
    const t = isObj(f.then) ? f.then : {};
    out.fetch = {
      requests: capRequests((Array.isArray(f.requests) ? f.requests : []).filter(isObj)).map((r) => ({
        id: typeof r.id === 'string' && r.id ? r.id.slice(0, 40) : rid('r'), name: String(r.name || '').slice(0, 80), pageId: String(r.pageId || '').slice(0, 40), url: String(r.url || '').slice(0, 2000),
        ...(isObj(r.each) ? { required: false, each: { pageId: String(r.each.pageId || '').slice(0, 40), list: String(r.each.list || '').slice(0, 40), max: Math.min(Math.max(1, Number.parseInt(r.each.max, 10) || MAX_LIST), MAX_LIST) } } : { required: r.required !== false }),
      })),
      then: { to: String(t.to || '').slice(0, 40), url: String(t.url || '').slice(0, 2000), open: 'ask' },
      ...(isObj(f.show) ? { show: cleanShow(f.show) } : {}),
    };
  }
  if (notable(p) && Array.isArray(p.annotations) && p.annotations.length) out.annotations = cleanNotes(p.annotations);
  if (p.role === 'input' && CLIP_DELAYS.includes(p.autoClipDelay) && p.autoClipDelay) out.autoClipDelay = p.autoClipDelay;
  if (p.role === 'email') {
    const e = isObj(p.email) ? p.email : {};
    out.email = Object.fromEntries(Object.entries(EMAIL_PARTS).map(([k, max]) => [k, typeof e[k] === 'string' ? e[k].slice(0, max) : '']));
  }
  if (p.role === 'scan') {
    const reads = Array.isArray(p.scan?.reads) ? p.scan.reads : [];
    out.scan = { reads: reads.filter((r) => isObj(r) && typeof r.key === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(r.key)).slice(0, 40).map((r) => ({ key: r.key, anchor: String(r.anchor || '').slice(0, 80), pattern: String(r.pattern || '').slice(0, 200) })) };
  }
  if (isObj(p.step)) {
    out.step = {
      ...(isObj(p.step.when) && typeof p.step.when.field === 'string' && ['missing', 'present'].includes(p.step.when.is) ? { when: { field: p.step.when.field.slice(0, 40), is: p.step.when.is } } : {}),
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

/**
 * Open an exported flow file. Its pages come back untested: tests are made on this computer. keepIds keeps
 * the file's page ids (a library's flow, and a copy of one): a case's steps are its flow's page ids, so a
 * case started from the library's flow and the copy made to change it name their steps the same way.
 */
const PAGE_ID = /^p-[\w-]{1,40}$/;
export function importFlow(doc, { keepIds = false } = {}) {
  if (!isObj(doc) || doc.schema !== FLOW_SCHEMA) throw new Error('This isn’t a Power Loader flow file');
  if (!isObj(doc.fields) || validateFieldDefs(doc.fields).length) throw new Error('The flow’s fields aren’t valid');
  if (!Array.isArray(doc.pages) || !doc.pages.length) throw new Error('The flow has no pages');
  const flow = newFlow({ name: String(doc.name || 'Imported flow').slice(0, 80), guidance: String(doc.guidance || '').slice(0, 5000) });
  flow.fields = Object.fromEntries(Object.entries(doc.fields).map(([k, f]) => [k, cleanDef(f)]));
  const ids = new Map();
  flow.pages = doc.pages.filter((p) => isObj(p) && ROLES[p.role]).map((p) => {
    const keep = keepIds && typeof p.id === 'string' && PAGE_ID.test(p.id) && ![...ids.values()].includes(p.id);
    const page = { id: keep ? p.id : rid('p'), role: p.role, name: String(p.name || ROLES[p.role]).slice(0, 60), url: typeof p.url === 'string' ? p.url : '', required: Array.isArray(p.required) ? p.required.filter((k) => flow.fields[k]) : [], draft: null, ...pageExtras(p) };
    if (typeof p.id === 'string') ids.set(p.id, page.id);
    if (isObj(p.profile) && ['input', 'output'].includes(p.role)) {
      const kind = p.role === 'output' ? 'fill' : 'extract';
      page.draft = {
        id: randomDraftId(), kind, base: null, from: 'you', created: now(), updated: now(), use: false, tested: null, second: null, exported: null, conflict: null,
        profile: { ...structuredClone(p.profile), schema: PROFILE_SCHEMA, kind },
      };
      if (Array.isArray(p.picks)) page.draft.picks = structuredClone(p.picks).filter(isObj);
    }
    return page;
  });
  for (const role of NEEDED) if (!pagesOf(flow, role).length && needed(flow, role)) flow.pages.push(newPage(role));
  // Page ids are new here: links, the order and timeline series follow them.
  const id = (old) => ids.get(old) || '';
  for (const p of flow.pages) for (const l of p.step?.links || []) l.to = id(l.to);
  // A choose step follows the page it reads the reference from, and is dropped if that page is missing.
  for (const p of flow.pages) if (p.choose) { p.choose.next = id(p.choose.next); if (!p.choose.next) delete p.choose; }
  // A fetch step's requests follow their pages; a request whose page is missing is dropped, and a page whose
  // fetch step is missing is an ordinary page to clip.
  for (const p of flow.pages) if (p.parent) p.parent = id(p.parent);
  for (const p of pagesOf(flow, 'fetch')) {
    p.fetch.requests = p.fetch.requests.map((r) => ({ ...r, pageId: id(r.pageId), ...(r.each ? { each: { ...r.each, pageId: id(r.each.pageId) } } : {}) }))
      .filter((r) => pageOf(flow, r.pageId)?.role === 'input' && (!r.each || pageOf(flow, r.each.pageId)?.role === 'input'));
    for (const r of p.fetch.requests) for (const cid of [r.pageId, r.each?.pageId].filter(Boolean)) pageOf(flow, cid).parent = p.id;
    p.fetch.then.to = id(p.fetch.then.to);
  }
  for (const p of flow.pages) if (p.parent && pageOf(flow, p.parent)?.role !== 'fetch') delete p.parent;
  for (const p of flow.pages) if (p.parent && !requestsOf(pageOf(flow, p.parent)).some((r) => r.pageId === p.id || r.each?.pageId === p.id)) delete p.parent;
  // A scan step reads only fields this flow has, and the case reference.
  for (const p of pagesOf(flow, 'scan')) p.scan.reads = p.scan.reads.filter((r) => r.key === 'ref' || flow.fields[r.key]);
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
 * Page profiles keep only the fields the forms use, and their lists (rows for the tools).
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
    // Its lists come too: rows for the tools (payments for the calculator, periods for the timeline), not fields.
    const lists = Object.keys(p.fields).filter((k) => Array.isArray(p.fields[k]) && !keys.has(k));
    const d = publishedDraft({ ...p, fields: Object.fromEntries([...reads, ...lists].map((k) => [k, p.fields[k]])) }, lib.commit, 'extract');
    // Fewer fields than the library's file: no longer the published profile, so it needs a test here.
    if (reads.length + lists.length !== Object.keys(p.fields).length) d.tested = null;
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
export function startable(flow, { access = null } = {}) {
  const { files, hosts } = compileFlow(flow);
  const lib = indexLibrary({ files }, { approvedHosts: hosts });
  const formIds = Object.keys(lib.forms);
  const untested = [
    ...flow.pages.filter((p) => p.draft && !testCurrent(p.draft)).map((p) => p.name),
    ...flow.pages.filter((p) => p.parent && p.draft && testCurrent(p.draft) && p.draft.tested.ok && !fetchedNow(p.draft)).map((p) => `${p.name} (as fetched)`),
  ];
  // The confirmation lists every fetch step and the systems it fetches from, so an imported flow is seen.
  const fetches = pagesOf(flow, 'fetch').map((p) => ({ name: p.name, hosts: [...new Set(requestsOf(p).map((r) => /^https?:\/\/([^/?#]+)/i.exec(isListRequest(r) ? ([pageOf(flow, r.pageId)?.draft?.profile.match].flat()[0] || '') : requestUrl(flow, r))?.[1]).filter(Boolean))] }));
  const failed = flow.pages.filter((p) => p.draft && testCurrent(p.draft) && !p.draft.tested.ok).map((p) => p.name);
  const unmade = flow.pages.filter((p) => ['input', 'output'].includes(p.role) && (!p.draft || !keysOf(p).length)).map((p) => p.name);
  let reason = null;
  // A flow that fetches a list of links can start a case with no form: its results are rows.
  const noForms = !formIds.length && (lib.steps || []).some((s) => s.role === 'fetch' && (s.fetch?.requests || []).some((r) => r.each));
  if (lib.problems.length) reason = `${lib.problems[0].path}: ${lib.problems[0].errors[0]}`;
  else if (!formIds.length && !noForms) reason = 'Make a form to fill first: a case starts from the forms it fills';
  // (A flow with no form has none for the rules to block: every([]) would say they all are.)
  else if (access && pagesOf(flow, 'output').some((p) => p.draft) && pagesOf(flow, 'output').filter((p) => p.draft).every((p) => [p.url, ...[p.draft.profile.match].flat()].filter(Boolean).some((a) => globVerdict(access, a, 'fill').verdict === 'blocked'))) {
    reason = 'The site rules block every form this flow fills, so Power Loader can’t fill any of them';
  }
  return { ok: !reason, reason, formIds, untested, failed, unmade, fetches, noForms };
}

/**
 * The flow as a stored library set, for a case to pin. Its commit names the flow and its content, so a
 * changed flow is a new set and a case keeps the version it started with. A connected library lends its
 * privacy patterns, identifier types and site rules (access.json).
 */
export function flowSet(flow, { hash, base = null, now: at = now() }) {
  const { files, hosts } = compileFlow(flow, { identifierTypes: base?.identifierTypes && Object.keys(base.identifierTypes).length ? base.identifierTypes : null });
  if (base?.privacy) files['privacy.json'] = structuredClone(base.privacy);
  // The library's site rules come too, so the case pins them. A flow file itself never carries rules.
  if (base?.access?.doc) files['access.json'] = structuredClone(base.access.doc);
  return {
    commit: `flow-${flow.id.replace(/^f-/, '')}-${String(hash).slice(0, 12)}`, message: flow.name || 'Flow', syncedAt: at,
    manifest: { schema: 'powerloader-library/1', approvedHosts: [...new Set([...hosts, ...(base?.approvedHosts || [])])] }, files, flow: { id: flow.id, name: flow.name },
  };
}

export const isFlowCommit = (commit) => /^flow-/.test(String(commit || ''));

// ------------------------------------------------------------------ flows a library carries

/**
 * Problems with a flow file a library carries under flows/: it must open as an import does (importFlow()),
 * and every system it works on must be one of the library's approved hosts. A library flow can do nothing an
 * imported flow can't: it is read through the same path, and site rules apply as to any flow.
 */
export function libraryFlowErrors(doc, approvedHosts = []) {
  let flow;
  try { flow = importFlow(doc); } catch (e) { return [e.message]; }
  const out = [];
  if (typeof doc.id !== 'string' || !/^[\w-]{1,60}$/.test(doc.id)) out.push('"id" must be a short name of letters, digits and hyphens');
  const approved = (h) => approvedHosts.some((a) => a.toLowerCase() === h || (a.startsWith('*.') && h.endsWith(a.slice(1).toLowerCase())));
  for (const h of flowHosts(flow)) if (!approved(h)) out.push(`works on ${h}, which isn’t on the approved systems list`);
  return out;
}

/**
 * A library's flow as a flow to start a case from or to look at: opened as an import is (its pages untested on
 * this computer), with an id of its own that names the library file, so a case from it pins a set of its own.
 */
export function libraryFlow(lib, path) {
  const entry = (lib?.flows || []).find((f) => f.path === path);
  if (!entry) throw new Error('That flow is no longer in the library');
  const flow = importFlow(structuredClone(entry.doc), { keepIds: true });
  flow.id = `f-lib-${slug(path.replace(/^flows\//, '').replace(/\.flow\.json$|\.json$/, ''))}`;
  flow.fromLibrary = { commit: lib.commit, path };
  return flow;
}

/** A copy of a library's flow to edit on this computer, saying where it came from. Its pages keep their ids. */
export function copyLibraryFlow(lib, path) {
  const entry = (lib?.flows || []).find((f) => f.path === path);
  if (!entry) throw new Error('That flow is no longer in the library');
  const flow = importFlow(structuredClone(entry.doc), { keepIds: true });
  flow.copiedFrom = { commit: lib.commit, path, name: flow.name };
  return flow;
}

/** A flow made from one of the library's pages: that page to clip, the fields it reads, and a form to make. */
export function flowFromLibraryPage(lib, profileId) {
  const p = lib.profiles.find((x) => x.id === profileId);
  if (!p) throw new Error('That page isn’t in the library');
  const flow = newFlow({ name: p.name });
  flow.pages = [newPage('output')];
  flow.source = { commit: lib.commit, pages: [`${p.id}@${p.version}`] };
  for (const k of Object.keys(p.fields || {})) if (lib.fields[k]) flow.fields[k] = cleanDef(lib.fields[k]);
  flow.pages.push({ id: rid('p'), role: 'input', name: p.name, url: p.urlPattern || '', profileId: p.id, required: [], draft: publishedDraft(p, lib.commit, 'extract') });
  return flow;
}

// ------------------------------------------------------------------ templates

const hostOfAddress = (a) => /^(?:https?|\*):\/\/([^/?#]+)/i.exec(String(a || ''))?.[1].toLowerCase() || '';

/**
 * The templates the flows use: one entry for each page a flow clips (kind 'page', including pages a fetch
 * step fetches) and each form a flow fills (kind 'form'), from the library's flows and the flows on this
 * computer. Copies are the same template when they have the same library id (profileId, formId), or, with
 * none, the same address. Pages to visit, emails and screenshots aren't templates: they belong to one step.
 * Pure: lib is the indexed library (or null), flows the flows on this computer.
 * { templates: [Template], notInFlow: [{ kind, id, name, host }] }
 *   Template { kind, id, name, host, address, version, values: [{ key, label }], required (forms), from:
 *              'library' | 'computer', tested, uses: [{ flowId, flowName, pageId, stepNumber, library }],
 *              differs, differences: [text] }
 */
export function templatesOf({ lib = null, flows = [] } = {}) {
  const all = [
    ...(lib?.flows || []).map((e) => { try { return { flow: libraryFlow(lib, e.path), library: e.path }; } catch { return null; } }).filter(Boolean),
    ...flows.map((flow) => ({ flow, library: null })),
  ];
  const byKey = new Map();
  for (const { flow, library } of all) {
    const order = journeyOf(flow).map((p) => p.id);
    for (const p of flow.pages) {
      if (!['input', 'output'].includes(p.role)) continue;
      const kind = p.role === 'output' ? 'form' : 'page';
      // A page copied from the library says so in its draft's base, when the flow doesn't name it.
      const libId = kind === 'form' ? p.formId || p.draft?.profile.form?.id : p.profileId || p.draft?.base?.id;
      const address = (kind === 'page' ? [p.draft?.profile.match].flat()[0] : '') || p.url || '';
      const id = libId || address;
      if (!id) continue;
      const key = `${kind}:${id}`;
      const fields = p.draft?.profile.fields || {};
      const values = kind === 'form'
        ? keysOf(p).map((k) => ({ key: k, label: flow.fields[k]?.label || lib?.fields?.[k]?.label || k }))
        : Object.keys(fields).filter((k) => !k.startsWith('@')).map((k) => ({ key: k, label: flow.fields[k]?.label || lib?.fields?.[k]?.label || k }));
      const step = order.indexOf(p.parent || p.id);
      const copy = {
        values, address, signature: canonical({ fields, match: p.draft?.profile.match || null, required: kind === 'form' ? [...(p.required || [])].sort() : [] }),
        tested: !!(p.draft && testCurrent(p.draft) && p.draft.tested.ok),
      };
      const use = { flowId: flow.id, flowName: flow.name || 'Untitled flow', pageId: p.id, stepNumber: step < 0 ? null : step + 1, library, copy };
      if (!byKey.has(key)) {
        const known = kind === 'form' ? lib?.forms?.[id] : lib?.profiles?.find((x) => x.id === id);
        byKey.set(key, {
          kind, id, name: known?.name || p.name, host: hostOfAddress(address || known?.urlPattern || known?.url || [known?.match].flat()[0]),
          address: address || known?.urlPattern || known?.url || '', version: known?.version || p.draft?.profile.version || '',
          values, ...(kind === 'form' ? { required: (p.required || []).length } : {}), from: known ? 'library' : 'computer', tested: false, uses: [],
        });
      }
      const t = byKey.get(key);
      t.uses.push(use);
      t.tested = t.tested || copy.tested;
    }
  }
  const templates = [...byKey.values()].map((t) => {
    // Copies that differ: which flows, and what (the values read or filled, the address).
    const sigs = new Set(t.uses.map((u) => u.copy.signature));
    const differences = [];
    if (sigs.size > 1) {
      const first = t.uses[0].copy;
      for (const u of t.uses.slice(1)) {
        const what = [];
        const a = new Set(first.values.map((v) => v.key));
        const b = new Set(u.copy.values.map((v) => v.key));
        if (a.size !== b.size || [...a].some((k) => !b.has(k))) what.push('the values it reads');
        else if (u.copy.signature !== first.signature && u.copy.address === first.address) what.push('how it reads them');
        if (u.copy.address !== first.address) what.push('its address');
        differences.push(`${u.flowName} differs from ${t.uses[0].flowName}: ${what.join(' and ') || 'its template'}`);
      }
    }
    return { ...t, differs: sigs.size > 1, differences, uses: t.uses.map(({ copy, ...u }) => u) }; // eslint-disable-line no-unused-vars
  }).sort((a, b) => a.kind.localeCompare(b.kind) || a.host.localeCompare(b.host) || a.name.localeCompare(b.name));
  const used = new Set(templates.map((t) => `${t.kind}:${t.id}`));
  const notInFlow = [
    ...(lib?.profiles || []).filter((p) => !p.fetchOnly && (p.format || 'html') === 'html' && !used.has(`page:${p.id}`)).map((p) => ({ kind: 'page', id: p.id, name: p.name, host: hostOfAddress(p.urlPattern || [p.match].flat()[0]) })),
    ...Object.values(lib?.forms || {}).filter((f) => !used.has(`form:${f.id}`)).map((f) => ({ kind: 'form', id: f.id, name: f.name, host: hostOfAddress(f.url || fillProfileUrl(lib, f)) })),
  ].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  return { templates, notInFlow };
}

const fillProfileUrl = (lib, f) => [(lib.fill || []).find((p) => p.id === f.fill || p.form?.id === f.id)?.match].flat()[0] || '';

// What a flow (or a library) tells a case beyond its fields: the steps the caseworker takes, page by page,
// with templated links to the next page, and the timelines its dates are drawn on. Both are library files,
// steps.json and timelines.json, so they are validated like any other library input. Pure functions.
//
// steps.json      { schema: 'powerloader-steps/1', steps: [Step] }, in the order the caseworker takes them
//   Step          { id, name, role: 'guide' | 'input' | 'output' | 'email' | 'scan' | 'fetch', text, links: [{ label, url, to? }],
//                   url?, match? (guide pages, and a fetch step's trigger page), profileId? (input), formId? (output),
//                   choose? { label, next, url } (guide: the caseworker chooses the case here, and the next page's
//                   address, url, a template with {ref} in it once, gives the case reference),
//                   fetch? { requests: [Request], then?: { url, to?, open: 'ask' } } (fetch),
//                   email? { to, cc?, subject, body } (email), scan? { fields: { key: { anchor?, pattern? } } } (scan),
//                   annotations? [Annotation] (notes drawn on the step's page; see lib/annotations.js),
//                   autoClipDelay? ms (input: with auto-clip on, wait this long after the page loads, for pages that load their data),
//                   when? { field, is: 'missing' | 'present' } (the step is needed only when the case lacks, or has, a
//                   value: field is a field key or ref, the case reference; Next passes over a step that isn't needed) }
//   Request       { id, name, url (a template, host fixed), method: 'GET', profileId, required }: a page fetched
//                 from the trigger page when the caseworker presses the step's button, read with its page profile.
//                 Or a list request, { id, name, each: { profileId, list, max }, method: 'GET', profileId, required:
//                 false }: the addresses are the links in the list field `list` that the trigger page's own profile
//                 (each.profileId) reads, at most max of them, each read with profileId. One a step at most.
//   Show          { type, where: { key: value }, label, columns: [key], mark? } (fetch, optional): the rows of type
//                 the step card lists after a run, those whose values equal where's, exactly.
//   Mark          { row, key, rowKey: '@attribute', text, style? }: a marker on each row of the trigger page
//                 (row, a selector) whose attribute equals a shown row's key value; fixed text, no case value.
//   A link's url is a template: {ref} is the case reference, {fieldKey} the case's value for that field.
//   An email's parts are templates too; the caseworker opens it in their email app with a mailto: link.
//   A scan step reads a screenshot or document with OCR on this computer: each field (or ref) is the text
//   after its anchor, or the first text that matches its pattern, else what follows the field's label.
// timelines.json  { schema: 'powerloader-timelines/1', timelines: [{ id, name, series: [Series] }] }
//   Series        { id, label, kind: 'bar' | 'point', colour, shape?, gaps?,
//                   source: { profile, group } (rows a page profile reads) | { start, end? } | { at } (date fields) }
import { fieldState, settled } from './case.js';
import { display } from './fields.js';
import { annotationErrors } from './annotations.js';
import { literalOrigin } from './access.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max = 200) => typeof v === 'string' && v.trim() && v.length <= max;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
export const STEPS_SCHEMA = 'powerloader-steps/1';
export const TIMELINES_SCHEMA = 'powerloader-timelines/1';
export const STEP_ROLES = ['guide', 'input', 'output', 'email', 'scan', 'fetch'];
// A fetch step's requests, at most, so a mistaken flow can't hammer a system (docs/plans/fetch-steps.md).
export const MAX_REQUESTS = 6;
// A list request's addresses, at most: one page of a list (docs/plans/system-homepages-and-inbox-triage.md, D1).
export const MAX_LIST = 25;
// How long auto-clip can wait after a page loads, for a page that fetches its data after loading.
export const CLIP_DELAYS = [0, 500, 1000, 2000, 5000];
export const MAX_CLIP_DELAY = 10000;

/** How long auto-clip waits on a page this profile reads: its step's delay, or none. */
export const autoClipDelay = (lib, profileId) => {
  const d = (lib?.steps || []).find((s) => s.role === 'input' && s.profileId === profileId)?.autoClipDelay;
  return Number.isInteger(d) ? Math.min(Math.max(d, 0), MAX_CLIP_DELAY) : 0;
};

// Colours for bars and pointers: named, so a timeline reads the same everywhere; or a #rrggbb of the author's.
export const COLOURS = {
  blue: '#1d70b8', green: '#00703c', orange: '#f47738', purple: '#4c2c92', red: '#d4351c', teal: '#28a197', pink: '#d53880', brown: '#b58840', grey: '#505a5f',
};
export const SHAPES = ['circle', 'square', 'diamond', 'triangle'];
export const colourOf = (c) => COLOURS[c] || (/^#[0-9a-f]{6}$/i.test(String(c)) ? c : COLOURS.grey);
const colourOk = (c) => c === undefined || c in COLOURS || /^#[0-9a-f]{6}$/i.test(String(c));

// ------------------------------------------------------------------ templated links

const VAR = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;
export const templateVars = (tpl) => [...new Set([...String(tpl || '').matchAll(VAR)].map((m) => m[1]))];

/**
 * Problems with a link template: not a web address, a {name} in its scheme or host (a case value could send
 * the link to any site), or a {name} that is neither ref nor a field.
 */
export function templateErrors(tpl, fields) {
  const out = [];
  if (!/^https?:\/\/[^/\s{}]+/i.test(String(tpl || '').replace(VAR, 'x'))) out.push('must be a web address (http or https)');
  else if (!literalOrigin(tpl)) out.push('must have its site written out: a {name} can go in the path or query, not in https://… before the first /');
  const unknown = templateVars(tpl).filter((v) => v !== 'ref' && !fields[v]);
  if (unknown.length) out.push(`uses ${unknown.map((v) => `{${v}}`).join(', ')}, which ${unknown.length === 1 ? 'isn’t a field' : 'aren’t fields'}`);
  return out;
}

/** Names in a text template (an email's parts) that are neither ref nor a field. */
export function textTemplateErrors(tpl, fields) {
  const unknown = templateVars(tpl).filter((v) => v !== 'ref' && !fields[v]);
  return unknown.length ? [`uses ${unknown.map((v) => `{${v}}`).join(', ')}, which ${unknown.length === 1 ? 'isn’t a field' : 'aren’t fields'}`] : [];
}

/**
 * The values a link can use: the case reference and every settled, valid case value. With text, values are
 * as a person reads them (dates as 3 Mar 2024, money with its £), for an email's words.
 */
export function caseVars(c, lib, { text = false } = {}) {
  const vars = { ref: String(c.ref || '') };
  for (const k of Object.keys(lib.fields)) {
    const st = fieldState(c, lib, k);
    if (settled(st.status) && st.valid !== false && st.value != null && st.value !== '') vars[k] = text ? display(lib.fields[k], st.value) : String(st.value);
  }
  return vars;
}

/**
 * Fill a link template. Every value is URL-encoded. { url: string | null, missing: [name] }. A template with
 * a {name} in its scheme or host gives no address, whatever the values.
 */
export function fillTemplate(tpl, vars) {
  const missing = [];
  if (templateVars(tpl).length && !literalOrigin(tpl)) return { url: null, missing: [] };
  const url = String(tpl).replace(VAR, (m, k) => {
    const v = vars[k];
    if (v == null || v === '') { missing.push(k); return m; }
    return encodeURIComponent(v);
  });
  return { url: missing.length ? null : url, missing: [...new Set(missing)] };
}

/**
 * Problems with a fetch request's address, on top of a link's: it must be a page (a / straight after the
 * site), with no user name. A value is encoded, so it can't add a /, ? or @; and a {name} can't be in the
 * scheme, host or port (templateErrors), so no value can change the site the request goes to.
 */
export function fetchTemplateErrors(tpl, fields) {
  const out = templateErrors(tpl, fields);
  if (out.length) return out;
  const m = /^https?:\/\/([^/?#]*)(.*)$/i.exec(String(tpl));
  if (m[1].includes('@')) out.push('can’t have a user name in it');
  if (!m[2].startsWith('/')) out.push('must have a / straight after the site name');
  return out;
}

// A value that is only dots is a "." or ".." path segment once filled in: the URL parser would go up a folder.
const DOTS = /^\.+$/;

/**
 * Fill a fetch request's address. Like fillTemplate(), and then: a value that is only dots is refused, and the
 * filled address must parse with the template's own origin. { url, missing, error: null | 'template' | 'dots' | 'origin' }
 */
export function fillFetchUrl(tpl, vars) {
  if (!literalOrigin(tpl)) return { url: null, missing: [], error: 'template' };
  const used = templateVars(tpl);
  if (used.some((k) => DOTS.test(String(vars[k] ?? '')))) return { url: null, missing: [], error: 'dots' };
  const f = fillTemplate(tpl, vars);
  if (!f.url) return { ...f, error: null };
  let u;
  let origin;
  try { u = new URL(f.url); origin = new URL(`${/^https?:\/\/[^/?#]*/i.exec(String(tpl))[0]}/`).origin; } catch { return { url: null, missing: [], error: 'template' }; }
  if (u.origin !== origin || u.username || u.password) return { url: null, missing: [], error: 'origin' };
  return { url: u.href, missing: [], error: null };
}

/** Fill a text template as it is (no encoding). { text, missing: [name] }; a missing name is left as {name}. */
export function fillText(tpl, vars) {
  const missing = [];
  const text = String(tpl || '').replace(VAR, (m, k) => {
    const v = vars[k];
    if (v == null || v === '') { missing.push(k); return m; }
    return String(v);
  });
  return { text, missing: [...new Set(missing)] };
}

// ------------------------------------------------------------------ the case reference from the case opened

// A case reference taken from an address: a letter or digit, then letters, digits, dots, underscores and
// hyphens, at most 40. No / in it, so the value can't run past its path segment; a reference with a / (such
// as HSG/2026/1042) can't come from an address and is typed instead.
export const REF_VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

/**
 * Problems with the address a "choose a case" step reads the reference from: a web address with its site
 * written out, {ref} exactly once in its path or query and no other {name}, and {ref} not run together with
 * letters or digits (case-{ref}.html and cases?id={ref} are fine; case{ref} or {ref}x isn't, as nothing says
 * where the reference ends).
 */
export function chooseTemplateErrors(tpl) {
  const t = String(tpl || '');
  const out = templateErrors(t, {});
  if (out.length) return out;
  const vars = [...t.matchAll(VAR)].map((m) => m[1]);
  if (!vars.includes('ref')) return ['has no {ref} for the case reference'];
  if (vars.filter((v) => v === 'ref').length > 1) out.push('has {ref} more than once');
  if (vars.some((v) => v !== 'ref')) out.push('can use only {ref}');
  if (!/^https?:\/\/[^/?#]*[/?]/i.test(t)) out.push('must have a / straight after the site name');
  const at = t.indexOf('{ref}');
  if (/[A-Za-z0-9]/.test(t[at - 1] || '') || /[A-Za-z0-9]/.test(t[at + 5] || '')) out.push('has {ref} run together with other letters or digits, so the reference’s end can’t be told');
  if (t.slice(0, at).includes('#')) out.push('has {ref} after a #, which is never sent to the site');
  return out;
}

// The part of an address a reference is compared on: no fragment, and no query unless the template has one.
const comparable = (url, withQuery) => { const u = new URL(url); return `${u.origin}${u.pathname}${withQuery ? u.search : ''}`; };
const decoded = (s) => { try { return decodeURIComponent(s); } catch { return null; } };
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The pattern a choose template becomes, for this check only: the literal parts escaped, {ref} a run of the
 * reference's characters or percent-escapes, the scheme, host and port literal. null for a bad template.
 */
export function refPattern(tpl) {
  if (chooseTemplateErrors(tpl).length) return null;
  const base = comparable(String(tpl).replace('{ref}', 'REF'), String(tpl).includes('?')).replace('REF', '{ref}');
  const [before, after] = base.split('{ref}');
  return new RegExp(`^${escapeRe(before)}((?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2}){1,120})${escapeRe(after)}$`);
}

/**
 * The case reference an address gives a "choose a case" step, or null. The value is percent-decoded and
 * trimmed, and must be a reference (REF_VALUE). As a last check, filling the template with it must give the
 * address back (without its fragment, and its query unless the template has one), so the reference always
 * opens the page it was taken from.
 */
export function refFromAddress(step, url) {
  const tpl = step?.choose?.url;
  const re = tpl && refPattern(tpl);
  if (!re) return null;
  const withQuery = String(tpl).includes('?');
  let here;
  try { here = comparable(url, withQuery); } catch { return null; }
  const m = re.exec(here);
  if (!m) return null;
  const ref = decoded(m[1])?.trim();
  if (!ref || !REF_VALUE.test(ref) || DOTS.test(ref)) return null;
  const back = fillTemplate(tpl, { ref }).url;
  let again;
  try { again = comparable(back, withQuery); } catch { return null; }
  return decoded(again) === decoded(here) ? ref : null;
}

/**
 * What arriving at an address means for the case reference: a "choose a case" step whose next page this is
 * gives a reference. With none set yet it's set ('set'); with a different one, the caseworker is warned
 * ('other'), and nothing changes. Only in the case's own window, and only where the site rules allow reading.
 * { kind: 'set' | 'other', ref, step } or null.
 */
export function refOnArrival({ c, lib, url, windowId, canRead }) {
  if (!c || !url || !canRead) return null;
  if (c.windowId != null && windowId !== c.windowId) return null;
  for (const step of lib?.steps || []) {
    if (step.role !== 'guide' || !step.choose) continue;
    const ref = refFromAddress(step, url);
    if (!ref) continue;
    if (!c.ref) return { kind: 'set', ref, step };
    if (ref !== c.ref) return { kind: 'other', ref, step };
    return null;
  }
  return null;
}

/** The flow's "choose a case" step, if it has one. */
export const chooseStep = (lib) => (lib?.steps || []).find((s) => s.role === 'guide' && s.choose) || null;

// ------------------------------------------------------------------ templated emails

export const EMAIL_LIMITS = Object.freeze({ to: 500, subject: 300, body: 5000 });
// Long mailto: links are cut short by some email apps (Outlook's limit is about 2000 characters).
export const MAILTO_SAFE = 2000;
const ADDRESS = /^[^\s@,;<>()"'\\]+@[^\s@,;<>()"'\\]+\.[^\s@,;<>()"'\\]+$/;
export const isAddress = (a) => ADDRESS.test(String(a || ''));
const addresses = (s) => String(s || '').split(/[,;]/).map((a) => a.trim()).filter(Boolean);

/**
 * An email step's email for this case: its parts filled in from the case's values, and the mailto: link that
 * opens it in the caseworker's email app. A value from a page that isn't one email address (a list, or text
 * that would add a recipient or a header) is not used: it is reported in bad, and there is no link.
 * { to: [address], cc: [address], subject, body, missing: [name], bad: [text], mailto: string | null }
 */
export function emailFor(email, vars) {
  const parts = Object.fromEntries(['to', 'cc', 'subject', 'body'].map((k) => [k, fillText(email?.[k] || '', vars)]));
  const missing = [...new Set(Object.values(parts).flatMap((p) => p.missing))];
  const to = addresses(parts.to.text);
  const cc = addresses(parts.cc.text);
  const bad = [...to, ...cc].filter((a) => !isAddress(a) && !/^\{[A-Za-z]\w*\}$/.test(a));
  // A case value is put in an address only when it is one address on its own.
  for (const k of ['to', 'cc']) {
    for (const v of templateVars(email?.[k])) if (vars[v] && !isAddress(vars[v])) bad.push(vars[v]);
  }
  const subject = parts.subject.text.replace(/[\r\n]+/g, ' ').trim();
  const body = parts.body.text.replace(/\r\n?/g, '\n');
  let mailto = null;
  if (!missing.length && !bad.length) {
    const enc = (a) => encodeURIComponent(a).replace(/%40/g, '@');
    const q = [cc.length ? `cc=${cc.map(enc).join(',')}` : '', subject ? `subject=${encodeURIComponent(subject)}` : '', body ? `body=${encodeURIComponent(body.replace(/\n/g, '\r\n'))}` : ''].filter(Boolean);
    mailto = `mailto:${to.map(enc).join(',')}${q.length ? `?${q.join('&')}` : ''}`;
  }
  return { to, cc, subject, body, missing, bad: [...new Set(bad)], mailto };
}

/** Problems with an email's templates: unknown names, an address that isn't one, too long. */
export function emailErrors(email, fields) {
  const out = [];
  for (const k of ['to', 'cc', 'subject', 'body']) {
    const v = email?.[k];
    if (v === undefined || v === '') continue;
    if (typeof v !== 'string') { out.push(`"${k}" must be text`); continue; }
    if (v.length > (EMAIL_LIMITS[k] || EMAIL_LIMITS.to)) out.push(`"${k}" must be at most ${EMAIL_LIMITS[k] || EMAIL_LIMITS.to} characters`);
    for (const e of textTemplateErrors(v, fields)) out.push(`the ${k === 'body' ? 'text' : k} ${e}`);
  }
  for (const k of ['to', 'cc']) {
    for (const a of addresses(email?.[k])) if (!isAddress(a) && !/^\{[A-Za-z]\w*\}$/.test(a)) out.push(`“${a.slice(0, 60)}” in ${k} isn’t an email address or a {field}`);
  }
  if (!String(email?.subject || '').trim() && !String(email?.body || '').trim()) out.push('needs a subject or some text');
  return out;
}

// ------------------------------------------------------------------ scan steps

export const REF_LABEL = 'Case reference';
/** The fields a scan step reads, with ref as a field, so the reader can match and validate the case reference. */
export const withRefField = (fields) => ({ ...fields, ref: { label: REF_LABEL, synonyms: ['Case ref', 'Case number', 'Case no', 'Reference', 'Our ref', 'Ref'] } });

/** Problems with a scan step's fields: { key: { anchor?, pattern? } }, key a field or ref. */
export function scanErrors(scan, fields) {
  const out = [];
  const reads = scan?.fields;
  if (!isObj(reads) || !Object.keys(reads).length) return ['needs at least one value to read'];
  if (Object.keys(reads).length > 40) out.push('reads at most 40 values');
  for (const [k, r] of Object.entries(reads)) {
    const name = k === 'ref' ? REF_LABEL : fields[k]?.label || k;
    if (k !== 'ref' && !fields[k]) { out.push(`reads ${k}, which isn’t a field`); continue; }
    if (!isObj(r)) { out.push(`${name} must be { anchor, pattern }`); continue; }
    if (r.anchor !== undefined && (typeof r.anchor !== 'string' || r.anchor.length > 80)) out.push(`${name}: the text before it must be at most 80 characters`);
    if (r.pattern !== undefined && r.pattern !== '') {
      if (typeof r.pattern !== 'string' || r.pattern.length > 200) out.push(`${name}: its shape must be at most 200 characters`);
      else { try { new RegExp(r.pattern, 'i'); } catch { out.push(`${name}: its shape isn’t a valid pattern`); } }
    }
  }
  return out;
}

// ------------------------------------------------------------------ validating the files

/** Problems with a step's condition: { field, is: 'missing' | 'present' }, one field (or ref) a step. */
export function whenErrors(when, fields = {}) {
  if (!isObj(when) || typeof when.field !== 'string' || !['missing', 'present'].includes(when.is) || Object.keys(when).some((k) => !['field', 'is'].includes(k))) return ['"when" must be { field, is: "missing" | "present" }'];
  if (when.field !== 'ref' && !fields[when.field]) return [`"when" uses ${when.field}, which isn’t a field`];
  return [];
}

export function validateSteps(doc, fields = {}) {
  if (!isObj(doc) || doc.schema !== STEPS_SCHEMA || !Array.isArray(doc.steps)) return [`steps.json must be { schema: "${STEPS_SCHEMA}", steps: [...] }`];
  const errors = [];
  const ids = new Set();
  doc.steps.forEach((s, i) => {
    const at = `steps[${i}]`;
    if (!isObj(s)) { errors.push(`${at} must be an object`); return; }
    if (!str(s.id, 80) || ids.has(s.id)) errors.push(`${at}: "id" must be a unique string`);
    ids.add(s.id);
    if (!str(s.name, 80)) errors.push(`${at}: "name" must be a non-empty string`);
    if (!STEP_ROLES.includes(s.role)) errors.push(`${at}: "role" must be guide, input, output, email, scan or fetch`);
    if (s.text !== undefined && (typeof s.text !== 'string' || s.text.length > 5000)) errors.push(`${at}: "text" must be a string of at most 5000 characters`);
    if (s.role === 'output' && !str(s.formId, 80)) errors.push(`${at}: a form step needs "formId"`);
    if (s.role === 'input' && !str(s.profileId, 120)) errors.push(`${at}: a page step needs "profileId"`);
    if (s.url !== undefined && !/^https?:\/\//.test(String(s.url))) errors.push(`${at}: "url" must be a web address`);
    if (s.role === 'email') for (const e of emailErrors(s.email, fields)) errors.push(`${at}: the email ${e}`);
    for (const e of annotationErrors(s.annotations, fields)) errors.push(`${at}: ${e}`);
    if (s.when !== undefined) for (const e of whenErrors(s.when, fields)) errors.push(`${at}: ${e}`);
    if (s.autoClipDelay !== undefined && !(Number.isInteger(s.autoClipDelay) && s.autoClipDelay >= 0 && s.autoClipDelay <= MAX_CLIP_DELAY)) errors.push(`${at}: "autoClipDelay" must be a whole number of milliseconds, at most ${MAX_CLIP_DELAY}`);
    if (s.role === 'scan') for (const e of scanErrors(s.scan, fields)) errors.push(`${at}: ${e}`);
    if (s.role === 'fetch') for (const e of fetchStepErrors(s.fetch, fields)) errors.push(`${at}: ${e}`);
    if (s.match !== undefined && !(Array.isArray(s.match) && s.match.every((m) => typeof m === 'string'))) errors.push(`${at}: "match" must be a list of URL patterns`);
    if (s.choose !== undefined) {
      const ch = s.choose;
      if (s.role !== 'guide') errors.push(`${at}: only a page to visit can be where the caseworker chooses the case`);
      else if (!isObj(ch) || !str(ch.label, 80) || !str(ch.next, 80) || typeof ch.url !== 'string') errors.push(`${at}: "choose" must be { label, next, url }`);
      else {
        if (!doc.steps.some((x) => isObj(x) && x.id === ch.next && x !== s)) errors.push(`${at}: "choose.next" must be another step’s id`);
        for (const e of chooseTemplateErrors(ch.url)) errors.push(`${at}: choose a case: the next page’s address ${e}`);
      }
    }
    if (s.links !== undefined) {
      if (!Array.isArray(s.links) || s.links.length > 12) { errors.push(`${at}: "links" must be a list of at most 12`); return; }
      s.links.forEach((l, j) => {
        if (!isObj(l) || !str(l.label, 80) || typeof l.url !== 'string') { errors.push(`${at}.links[${j}] must be { label, url }`); return; }
        for (const e of templateErrors(l.url, fields)) errors.push(`${at}.links[${j}]: the address ${e}`);
      });
    }
  });
  return errors;
}

/**
 * Problems with a fetch step's requests and where it goes next. Phase 1 builds GET only: POST is designed
 * (fetch-steps.md, Posting) but refused until a real case needs it.
 */
export const isListRequest = (r) => isObj(r?.each);
const ATTR = /^@[A-Za-z_:][-\w:.]*$/;
const KEYISH = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/** Problems with a fetch step's show (and its mark): exact matches only, so it can't do anything else. */
export function showErrors(show) {
  if (!isObj(show)) return ['"show" must be { type, where, label, columns }'];
  const out = [];
  if (!str(show.type, 40)) out.push('"show.type" must be the type of the rows to show');
  if (!isObj(show.where) || Object.keys(show.where).length > 8 || Object.entries(show.where).some(([k, v]) => !KEYISH.test(k) || typeof v !== 'string' || v.length > 200)) out.push('"show.where" must be { field: value }, exact matches only, at most 8');
  if (!str(show.label, 80)) out.push('"show.label" must be a non-empty string');
  if (!Array.isArray(show.columns) || show.columns.length > 8 || !show.columns.every((k) => KEYISH.test(String(k)))) out.push('"show.columns" must be a list of at most 8 field names');
  if (show.mark !== undefined) {
    const m = show.mark;
    if (!isObj(m)) out.push('"show.mark" must be { row, key, rowKey, text }');
    else {
      if (!str(m.row, 200)) out.push('"show.mark.row" must be a selector for the page’s rows');
      if (!KEYISH.test(String(m.key || ''))) out.push('"show.mark.key" must be a field of the shown rows');
      if (!ATTR.test(String(m.rowKey || ''))) out.push('"show.mark.rowKey" must be an attribute of the row, such as @data-id');
      if (!str(m.text, 40)) out.push('"show.mark.text" must be at most 40 characters');
      if (m.style !== undefined && typeof m.style !== 'string') out.push('"show.mark.style" must be text');
    }
  }
  return out;
}

export function fetchStepErrors(f, fields = {}) {
  if (!isObj(f) || !Array.isArray(f.requests) || !f.requests.length) return ['a fetch step needs at least one request'];
  const out = [];
  const fixed = f.requests.filter((r) => !isListRequest(r));
  if (fixed.length > MAX_REQUESTS) out.push(`a fetch step has at most ${MAX_REQUESTS} requests`);
  if (f.requests.length - fixed.length > 1) out.push('a fetch step has at most one list of links to fetch');
  if (f.show !== undefined) for (const e of showErrors(f.show)) out.push(e);
  const ids = new Set();
  f.requests.forEach((r, j) => {
    const at = `requests[${j}]`;
    if (!isObj(r)) { out.push(`${at} must be an object`); return; }
    if (!str(r.id, 80) || ids.has(r.id)) out.push(`${at}: "id" must be a unique string`);
    ids.add(r.id);
    if (!str(r.name, 80)) out.push(`${at}: "name" must be a non-empty string`);
    if (r.method !== undefined && r.method !== 'GET') out.push(`${at}: "method" must be GET (Power Loader doesn’t post forms yet)`);
    if (r.body !== undefined) out.push(`${at}: a GET request has no "body"`);
    if (!str(r.profileId, 120)) out.push(`${at}: needs the "profileId" of the page profile that reads it`);
    if (r.required !== undefined && typeof r.required !== 'boolean') out.push(`${at}: "required" must be true or false`);
    if (isListRequest(r)) {
      const e = r.each;
      if (!str(e.profileId, 120)) out.push(`${at}: "each.profileId" must be the page profile of the page with the links`);
      if (!KEYISH.test(String(e.list || ''))) out.push(`${at}: "each.list" must be the name of a list on that page`);
      if (!(Number.isInteger(e.max) && e.max >= 1 && e.max <= MAX_LIST)) out.push(`${at}: "each.max" must be a whole number from 1 to ${MAX_LIST}`);
      if (r.required === true) out.push(`${at}: a list of links can’t be required: a list can be empty`);
      if (r.url !== undefined) out.push(`${at}: a list of links takes its addresses from the page, so it has no "url"`);
      return;
    }
    if (typeof r.url !== 'string') out.push(`${at}: needs a "url"`);
    else for (const e of fetchTemplateErrors(r.url, fields)) out.push(`${at}: the address ${e}`);
  });
  if (f.then !== undefined) {
    const t = f.then;
    if (!isObj(t)) out.push('"then" must be { url, open }');
    else {
      if (t.open !== undefined && t.open !== 'ask') out.push('"then.open" must be ask (opening the next page by itself isn’t built yet)');
      if (t.url !== undefined) for (const e of templateErrors(t.url, fields)) out.push(`"then": the address ${e}`);
    }
  }
  return out;
}

export function validateTimelines(doc, fields = {}) {
  if (!isObj(doc) || doc.schema !== TIMELINES_SCHEMA || !Array.isArray(doc.timelines)) return [`timelines.json must be { schema: "${TIMELINES_SCHEMA}", timelines: [...] }`];
  const errors = [];
  const isDate = (k) => fields[k]?.type === 'date';
  doc.timelines.forEach((t, i) => {
    const at = `timelines[${i}]`;
    if (!isObj(t) || !str(t.id, 80) || !str(t.name, 80) || !Array.isArray(t.series)) { errors.push(`${at} must be { id, name, series: [...] }`); return; }
    t.series.forEach((s, j) => {
      const sat = `${at}.series[${j}]`;
      if (!isObj(s) || !str(s.id, 80) || !str(s.label, 80)) { errors.push(`${sat} must have an id and a label`); return; }
      if (!['bar', 'point'].includes(s.kind)) errors.push(`${sat}: "kind" must be bar or point`);
      if (!colourOk(s.colour)) errors.push(`${sat}: "colour" must be one of ${Object.keys(COLOURS).join(', ')} or #rrggbb`);
      if (s.shape !== undefined && !SHAPES.includes(s.shape)) errors.push(`${sat}: "shape" must be one of ${SHAPES.join(', ')}`);
      const src = s.source;
      if (!isObj(src)) { errors.push(`${sat}: "source" must be an object`); return; }
      if (src.group !== undefined) {
        if (!str(src.profile, 120) || !/^tl_[A-Za-z0-9]+$/.test(String(src.group))) errors.push(`${sat}: a page source is { profile, group: "tl_…" }`);
      } else if (s.kind === 'bar') {
        if (!isDate(src.start) || (src.end !== undefined && !isDate(src.end))) errors.push(`${sat}: "start" and "end" must be date fields`);
      } else if (!isDate(src.at)) errors.push(`${sat}: "at" must be a date field`);
    });
  });
  return errors;
}

// ------------------------------------------------------------------ steps in a case

const matchUrl = (m, url) => !!globalThis.PowerLoaderExtract?.matchUrl(m, url);

/** The step this page is, if any: a page to visit by its address, a page to clip or a form by its profile. */
export function stepForPage(lib, url) {
  if (!url) return null;
  for (const s of lib.steps || []) {
    if ((s.role === 'guide' || s.role === 'fetch') && s.match?.length && matchUrl(s.match, url)) return s;
    if (s.role === 'input') {
      const p = lib.profiles.find((x) => x.id === s.profileId);
      if (p && matchUrl(p.match, url)) return s;
    }
    if (s.role === 'output') {
      const form = lib.forms[s.formId];
      const fill = lib.fill.find((p) => p.id === form?.fill) || lib.fill.find((p) => p.form?.id === s.formId);
      if ((fill && matchUrl(fill.match, url)) || (form?.url && url.startsWith(form.url))) return s;
    }
  }
  return null;
}

/**
 * Is a step with a condition needed for this case? true, false, or null (not judged yet). A value can't be
 * called missing before the pages that give it have been looked at, so a step is judged once every step before
 * it is done or not needed; from then on afresh each time, so a value removed later brings the step back.
 * "missing" is a field with no value (a field in conflict has one: the caseworker decides it). A step without
 * a condition is always needed.
 */
export function stepNeeded(c, lib, step) {
  const w = step?.when;
  if (!w) return true;
  const steps = lib?.steps || [];
  const before = steps.slice(0, Math.max(0, steps.indexOf(step)));
  if (!before.every((x) => ['done', 'skipped'].includes(stepStatus(c, x, lib)))) return null;
  const missing = w.field === 'ref' ? !String(c.ref || '').trim() : !lib?.fields?.[w.field] || fieldState(c, lib, w.field).status === 'missing';
  return w.is === 'missing' ? missing : !missing;
}

/**
 * 'done' | 'filled' | 'todo' | 'skipped'. A page is done once clipped, a form once submitted, any step once marked
 * done: an email once it's opened in the email app, a scan once what it read is added to the case. With the
 * case's library (lib), a step whose condition says it isn't needed, and that hasn't been done, is 'skipped';
 * one the caseworker chose to do anyway (c.steps[id].wanted) is judged as any other.
 */
export function stepStatus(c, step, lib = null) {
  if (c.steps?.[step.id]?.done) return 'done';
  const own = stepStatusOwn(c, step);
  if (own === 'done' || !step.when || !lib || c.steps?.[step.id]?.wanted) return own;
  return stepNeeded(c, lib, step) === false ? 'skipped' : own;
}

function stepStatusOwn(c, step) {
  // Choosing the case is done once the case has its reference, from the case opened or typed.
  if (step.role === 'guide' && step.choose) return c.ref ? 'done' : 'todo';
  if (step.role === 'input') return c.clips.some((cl) => cl.profile?.id === step.profileId) ? 'done' : 'todo';
  if (step.role === 'output') return c.submitted?.[step.formId] ? 'done' : c.filled?.[step.formId] ? 'filled' : 'todo';
  if (step.role === 'fetch') {
    // A step with a list of links is done once a run has finished, whatever it found (the runner marks it):
    // an empty list never gives a clip.
    if ((step.fetch?.requests || []).some(isListRequest)) return 'todo';
    // Done once every required request's page is in the case, fetched or clipped by hand; with none required, all of them.
    const reqs = step.fetch?.requests || [];
    const need = reqs.some((r) => r.required !== false) ? reqs.filter((r) => r.required !== false) : reqs;
    return need.length && need.every((r) => c.clips.some((cl) => cl.profile?.id === r.profileId)) ? 'done' : 'todo';
  }
  return 'todo';
}

/** The step to show: the one this page is, else the first not done. { step, index, here } or null. */
export function currentStep(c, lib, url) {
  const steps = lib.steps || [];
  const here = stepForPage(lib, url);
  if (here) return { step: here, index: steps.indexOf(here), here: true };
  const i = steps.findIndex((s) => !['done', 'skipped'].includes(stepStatus(c, s, lib)));
  return i < 0 ? null : { step: steps[i], index: i, here: false };
}

const sameAddress = (a, b) => !!a && !!b && String(a).split('#')[0] === String(b).split('#')[0];

/**
 * The open step: the one the caseworker chose, else the one this page is, else the first not done.
 * { step, index, here, chosen } or null when every step is done and none is chosen.
 */
export function openStep(c, lib, { url, chosen = null } = {}) {
  const steps = lib.steps || [];
  const auto = currentStep(c, lib, url);
  const pick = chosen && steps.find((s) => s.id === chosen);
  if (pick && pick.id !== auto?.step.id) return { step: pick, index: steps.indexOf(pick), here: false, chosen: true };
  return auto ? { ...auto, chosen: false } : null;
}

/** Where a step's page is for this case: { url, missing } (url null when it needs a value the case lacks, or has none). */
export function stepUrl(c, lib, step, vars = caseVars(c, lib)) {
  const tpl = stepAddress(lib, step);
  return tpl ? fillTemplate(tpl, vars) : { url: null, missing: [] };
}

/** The step after this one that isn't done, or any step not done; null when there is none. */
export function nextStepAfter(c, lib, step) {
  const steps = lib.steps || [];
  const i = steps.indexOf(step);
  const open = (x) => !['done', 'skipped'].includes(stepStatus(c, x, lib));
  return steps.slice(i + 1).find(open) || steps.find((x) => open(x) && x.id !== step.id) || null;
}

/**
 * The open step's one main button, as data: always the next thing to do. A pure function of the case, the
 * library and the page in view (docs/plans/flow-steps-ux.md, step 4).
 *   info: what the page in view is to the case ({ kind: 'source' | 'form' | 'confirm' | …, profileId?, formId? })
 *   chosen: the step the caseworker opened, if any; blocked(step): its page is one the site rules block
 *   navigable(url): the site rules let Power Loader open it
 * { kind, label, stepId, url?, missing?, text?, linkIndex? } or null for no main button. kind is one of
 * 'go' (to the step's page), 'needs' (its address needs a value the case lacks: no button), 'clip', 'fill',
 * 'on-page' (the step is done on the page: no button, text says what), 'link' (a page to visit's first link),
 * 'email', 'fetch', 'next' (to the next step not done), 'finish', 'blocked' (no button).
 */
export function nextStepAction(c, lib, { url = null, info = {}, chosen = null, blocked = () => false, navigable = () => true } = {}) {
  const cur = openStep(c, lib, { url, chosen });
  const vars = caseVars(c, lib);
  if (!cur) return info?.kind === 'confirm' ? null : { kind: 'finish', label: 'Finish case', stepId: null };
  const s = cur.step;
  const st = stepStatus(c, s, lib);
  const base = { stepId: s.id };
  // A step that isn't needed counts as done for Next; opened, it has Do it anyway, an ordinary button. Its own
  // page still counts: the page in view is always the open step, and can be clipped or filled.
  if (st === 'done' || (st === 'skipped' && !cur.here)) {
    const next = nextStepAfter(c, lib, s);
    if (!next) return info?.kind === 'confirm' ? null : { kind: 'finish', label: 'Finish case', ...base };
    const at = stepUrl(c, lib, next, vars);
    return { kind: 'next', label: `Next: ${next.name}`, ...base, nextId: next.id, url: at.url && navigable(at.url) && !sameAddress(at.url, url) ? at.url : null };
  }
  if (blocked(s)) return { kind: 'blocked', label: '', ...base };
  if (cur.here) {
    if (st === 'skipped' && !['input', 'output'].includes(s.role)) {
      const next = nextStepAfter(c, lib, s);
      return next ? { kind: 'next', label: `Next: ${next.name}`, ...base, nextId: next.id, url: null } : { kind: 'finish', label: 'Finish case', ...base };
    }
    if (s.role === 'input') return info?.kind === 'source' && info.profileId === s.profileId ? { kind: 'clip', label: 'Clip this page', ...base } : null;
    if (s.role === 'output') {
      if (st === 'filled') return { kind: 'on-page', label: '', text: 'On the page: check every box, complete anything empty, then submit it yourself.', ...base };
      return info?.kind === 'form' && info.formId === s.formId ? { kind: 'fill', label: 'Fill this form', ...base } : null;
    }
    if (s.role === 'guide') return { kind: 'on-page', label: '', text: s.choose ? 'On the page: open the case you’re picking up.' : 'This step is done on the page.', ...base };
    if (s.role === 'fetch') return { kind: 'fetch', label: 'Fetch', ...base };
  }
  if (s.role === 'email') return { kind: 'email', label: 'Open in your email app', ...base };
  if (s.role === 'scan') return null;
  const own = stepUrl(c, lib, s, vars);
  if (own.url) {
    const link = (s.links || []).find((l) => sameAddress(fillTemplate(l.url, vars).url, own.url));
    return navigable(own.url) ? { kind: 'go', label: link?.label || `Go to ${s.name}`, url: own.url, ...base } : { kind: 'blocked', label: '', ...base };
  }
  if (own.missing.length) return { kind: 'needs', label: '', missing: own.missing, ...base };
  if (s.role === 'guide' && (s.links || []).length) {
    const f = fillTemplate(s.links[0].url, vars);
    if (f.url) return navigable(f.url) ? { kind: 'link', label: s.links[0].label, url: f.url, linkIndex: 0, ...base } : { kind: 'blocked', label: '', ...base };
    return { kind: 'needs', label: '', missing: f.missing, ...base };
  }
  return null;
}

export function markStep(c, id, done, at = new Date().toISOString()) {
  c.steps = { ...(c.steps || {}) };
  if (done) c.steps[id] = { done: true, at };
  else delete c.steps[id];
}

/** Do it anyway: a step that isn't needed is opened as a normal step for this case. */
export function wantStep(c, id) {
  c.steps = { ...(c.steps || {}), [id]: { wanted: true } };
}

/** Where a step's own page is, for "Open it": a page to visit's (or a fetch step's trigger) address, a form's, or a page's link pattern. */
export function stepAddress(lib, step) {
  if (step.role === 'guide' || step.role === 'fetch') return step.url || '';
  if (step.role === 'email' || step.role === 'scan') return '';
  if (step.role === 'output') return lib.forms[step.formId]?.url || '';
  return lib.profiles.find((p) => p.id === step.profileId)?.urlPattern || '';
}

// ------------------------------------------------------------------ timeline series in a case

const dateValue = (c, lib, k) => {
  if (!k || !lib.fields[k]) return null;
  const st = fieldState(c, lib, k);
  return settled(st.status) && st.valid !== false && ISO.test(String(st.value)) ? String(st.value) : null;
};

/**
 * The lanes of a defined timeline for this case: each series with its bars or pointers.
 * { id, label, kind, colour, shape, gaps, bars: [{ id, label, start, end, clipId }], points: [{ id, label, at, clipId }] }
 */
export function seriesLanes(c, lib, def) {
  return def.series.map((s) => {
    const lane = { id: s.id, label: s.label, kind: s.kind, colour: colourOf(s.colour), shape: s.shape || 'circle', gaps: s.kind === 'bar' && s.gaps !== false, bars: [], points: [] };
    const src = s.source || {};
    if (src.group) {
      for (const cl of c.clips) {
        for (const r of cl.records || []) {
          if (r.group !== src.group) continue;
          const label = String(r.label || s.label).slice(0, 80);
          if (s.kind === 'bar' && ISO.test(r.start || '')) lane.bars.push({ id: `${cl.id}:${r.id}`, label, start: r.start, end: ISO.test(r.end || '') ? r.end : null, clipId: cl.id, approx: false });
          if (s.kind === 'point' && ISO.test(r.at || '')) lane.points.push({ id: `${cl.id}:${r.id}`, label, at: r.at, clipId: cl.id });
        }
      }
    } else if (s.kind === 'bar') {
      const start = dateValue(c, lib, src.start);
      if (start) lane.bars.push({ id: `f:${s.id}`, label: s.label, start, end: dateValue(c, lib, src.end), clipId: null, approx: false });
    } else {
      const at = dateValue(c, lib, src.at);
      if (at) lane.points.push({ id: `f:${s.id}`, label: s.label, at, clipId: null });
    }
    lane.bars.sort((a, b) => a.start.localeCompare(b.start));
    lane.points.sort((a, b) => a.at.localeCompare(b.at));
    return lane;
  });
}

/** Every single date the case holds in a date field, as pointers: { id, label, at }. */
export function datePoints(c, lib) {
  return Object.entries(lib.fields).filter(([, f]) => f.type === 'date')
    .map(([k, f]) => ({ id: `f:${k}`, label: f.label, at: dateValue(c, lib, k) })).filter((p) => p.at)
    .sort((a, b) => a.at.localeCompare(b.at));
}

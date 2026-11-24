// What a flow (or a library) tells a case beyond its fields: the steps the caseworker takes, page by page,
// with templated links to the next page, and the timelines its dates are drawn on. Both are library files,
// steps.json and timelines.json, so they are validated like any other library input. Pure functions.
//
// steps.json      { schema: 'powerloader-steps/1', steps: [Step] }, in the order the caseworker takes them
//   Step          { id, name, role: 'guide' | 'input' | 'output', text, links: [{ label, url, to? }],
//                   url?, match? (guide pages), profileId? (input), formId? (output) }
//   A link's url is a template: {ref} is the case reference, {fieldKey} the case's value for that field.
// timelines.json  { schema: 'powerloader-timelines/1', timelines: [{ id, name, series: [Series] }] }
//   Series        { id, label, kind: 'bar' | 'point', colour, shape?, gaps?,
//                   source: { profile, group } (rows a page profile reads) | { start, end? } | { at } (date fields) }
import { fieldState, settled } from './case.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max = 200) => typeof v === 'string' && v.trim() && v.length <= max;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
export const STEPS_SCHEMA = 'powerloader-steps/1';
export const TIMELINES_SCHEMA = 'powerloader-timelines/1';
export const STEP_ROLES = ['guide', 'input', 'output'];

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

/** Problems with a link template: not a web address, or a {name} that is neither ref nor a field. */
export function templateErrors(tpl, fields) {
  const out = [];
  if (!/^https?:\/\/[^/\s{}]+/.test(String(tpl || '').replace(VAR, 'x'))) out.push('must be a web address (http or https)');
  const unknown = templateVars(tpl).filter((v) => v !== 'ref' && !fields[v]);
  if (unknown.length) out.push(`uses ${unknown.map((v) => `{${v}}`).join(', ')}, which ${unknown.length === 1 ? 'isn’t a field' : 'aren’t fields'}`);
  return out;
}

/** The values a link can use: the case reference and every settled, valid case value. */
export function caseVars(c, lib) {
  const vars = { ref: String(c.ref || '') };
  for (const k of Object.keys(lib.fields)) {
    const st = fieldState(c, lib, k);
    if (settled(st.status) && st.valid !== false && st.value != null && st.value !== '') vars[k] = String(st.value);
  }
  return vars;
}

/** Fill a link template. Every value is URL-encoded. { url: string | null, missing: [name] }. */
export function fillTemplate(tpl, vars) {
  const missing = [];
  const url = String(tpl).replace(VAR, (m, k) => {
    const v = vars[k];
    if (v == null || v === '') { missing.push(k); return m; }
    return encodeURIComponent(v);
  });
  return { url: missing.length ? null : url, missing: [...new Set(missing)] };
}

// ------------------------------------------------------------------ validating the files

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
    if (!STEP_ROLES.includes(s.role)) errors.push(`${at}: "role" must be guide, input or output`);
    if (s.text !== undefined && (typeof s.text !== 'string' || s.text.length > 5000)) errors.push(`${at}: "text" must be a string of at most 5000 characters`);
    if (s.role === 'output' && !str(s.formId, 80)) errors.push(`${at}: a form step needs "formId"`);
    if (s.role === 'input' && !str(s.profileId, 120)) errors.push(`${at}: a page step needs "profileId"`);
    if (s.url !== undefined && !/^https?:\/\//.test(String(s.url))) errors.push(`${at}: "url" must be a web address`);
    if (s.match !== undefined && !(Array.isArray(s.match) && s.match.every((m) => typeof m === 'string'))) errors.push(`${at}: "match" must be a list of URL patterns`);
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
    if (s.role === 'guide' && s.match?.length && matchUrl(s.match, url)) return s;
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

/** 'done' | 'filled' | 'todo'. A page is done once clipped, a form once submitted, any step once marked done. */
export function stepStatus(c, step) {
  if (c.steps?.[step.id]?.done) return 'done';
  if (step.role === 'input') return c.clips.some((cl) => cl.profile?.id === step.profileId) ? 'done' : 'todo';
  if (step.role === 'output') return c.submitted?.[step.formId] ? 'done' : c.filled?.[step.formId] ? 'filled' : 'todo';
  return 'todo';
}

/** The step to show: the one this page is, else the first not done. { step, index, here } or null. */
export function currentStep(c, lib, url) {
  const steps = lib.steps || [];
  const here = stepForPage(lib, url);
  if (here) return { step: here, index: steps.indexOf(here), here: true };
  const i = steps.findIndex((s) => stepStatus(c, s) !== 'done');
  return i < 0 ? null : { step: steps[i], index: i, here: false };
}

export function markStep(c, id, done, at = new Date().toISOString()) {
  c.steps = { ...(c.steps || {}) };
  if (done) c.steps[id] = { done: true, at };
  else delete c.steps[id];
}

/** Where a step's own page is, for "Open it": a page to visit's address, a form's, or a page's link pattern. */
export function stepAddress(lib, step) {
  if (step.role === 'guide') return step.url || '';
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

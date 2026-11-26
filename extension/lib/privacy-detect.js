// Finding personal data in a payload, all on this computer: values already in the case, the library's
// patterns (with a date-of-birth context rule), the on-device model's spans and the caseworker's own
// additions. Overlaps cover the union. Pure functions, no browser APIs.
import { CATEGORIES, DEFAULT_GROUPS, MODEL_LABELS, escapeRe, sameValue, unionCover } from './pii.js';
import { display } from './fields.js';

// Built-in patterns, used where the library's privacy.json doesn't define a category.
export const DEFAULT_PATTERNS = [
  { category: 'nino', pattern: '\\b[A-Z]{2}\\s?\\d{2}\\s?\\d{2}\\s?\\d{2}\\s?[A-D]\\b', score: 0.99 },
  { category: 'postcode', pattern: '\\b[A-Z]{1,2}\\d[A-Z\\d]?\\s?\\d[A-Z]{2}\\b', score: 0.95 },
  { category: 'phone', pattern: '(?:\\+44\\s?|\\b0)\\d{3,4}[\\s-]?\\d{3}[\\s-]?\\d{3,4}\\b', score: 0.9 },
  { category: 'email', pattern: '[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+', score: 0.99 },
  { category: 'date', pattern: '\\b(?:\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?,?\\s+\\d{4})\\b', score: 0.9, flags: 'i' },
];

// Case fields that hold personal data, by key. A library field can say otherwise with "privacy": category.
const FIELD_CATEGORY = { firstName: 'first_name', lastName: 'last_name', dob: 'date_of_birth', nino: 'nino', clientId: 'client_id', phone: 'phone', email: 'email', address: 'address', postcode: 'postcode' };
// A date right after these words is a date of birth, whether or not the case has one yet.
const DOB_CONTEXT = /(?:born|birth|d\.?o\.?b\.?)\b[^.\n]{0,14}$/i;

export function validatePrivacy(doc) {
  const errors = [];
  if (!doc) return errors;
  if (!Array.isArray(doc.patterns)) return ['privacy.json must have a "patterns" list'];
  if (doc.model !== undefined && doc.model !== null) {
    const m = doc.model;
    if (typeof m !== 'object' || (m.baseUrl != null && typeof m.baseUrl !== 'string') || (m.revision != null && typeof m.revision !== 'string')) errors.push('"model" must be { baseUrl, modelId, revision, hashes }');
    if (m.hashes != null && (typeof m.hashes !== 'object' || Object.values(m.hashes).some((x) => !/^[0-9a-f]{64}$/.test(String(x))))) errors.push('"model.hashes" must map file paths to SHA-256 hashes');
  }
  // Whether the on-device model is used: on or off, and whether the caseworker can change it.
  if (doc.use !== undefined && (doc.use === null || typeof doc.use !== 'object' || typeof doc.use.on !== 'boolean' || (doc.use.lock !== undefined && typeof doc.use.lock !== 'boolean'))) {
    errors.push('"use" must be { on: true or false, lock: true or false }');
  }
  doc.patterns.forEach((p, i) => {
    if (!CATEGORIES[p?.category]) errors.push(`patterns[${i}]: unknown category "${p?.category}"`);
    if (typeof p?.pattern !== 'string' || p.pattern.length > 300) errors.push(`patterns[${i}]: pattern must be a string of at most 300 characters`);
    else try { new RegExp(p.pattern, `g${p.flags || ''}`); } catch { errors.push(`patterns[${i}]: invalid regex`); }
    if (!(p?.score > 0 && p.score <= 1)) errors.push(`patterns[${i}]: score must be between 0 and 1`);
  });
  return errors;
}

export function patternsFor(lib) {
  const mine = lib?.privacy?.patterns || [];
  const defined = new Set(mine.map((p) => p.category));
  return [...mine, ...DEFAULT_PATTERNS.filter((p) => !defined.has(p.category))];
}

/** The case's personal values with their usual variants: formatted dates, identifiers with and without spaces, the address without its last part. */
export function knownValues(c, lib) {
  const out = [];
  if (!c) return out;
  const add = (category, v) => { const s = String(v ?? '').trim(); if (s.length > 1 && !out.some((x) => x.category === category && sameValue(x.text) === sameValue(s))) out.push({ category, text: s }); };
  const values = [...c.clips.flatMap((cl) => Object.entries(cl.values)), ...Object.entries(c.manual), ...Object.entries(c.resolved)];
  for (const [key, v] of values) {
    const category = lib.fields[key]?.privacy || FIELD_CATEGORY[key];
    if (!category || v == null || v === '') continue;
    const s = String(v);
    add(category, s);
    if (category === 'date_of_birth' && /^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const [y, m, d] = s.split('-');
      add(category, display({ type: 'date' }, s));
      add(category, `${d}/${m}/${y}`);
      add(category, `${Number(d)}/${Number(m)}/${y}`);
      add(category, new Date(`${s}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }));
    }
    if (['nino', 'postcode', 'phone'].includes(category)) add(category, s.replace(/\s+/g, ''));
    if (category === 'nino' && s.replace(/\s+/g, '').length === 9) { const n = s.replace(/\s+/g, ''); add(category, `${n.slice(0, 2)} ${n.slice(2, 4)} ${n.slice(4, 6)} ${n.slice(6, 8)} ${n.slice(8)}`); }
    if (category === 'address' && s.includes(',')) add(category, s.replace(/,[^,]*$/, '').trim());
    if (category === 'first_name' || category === 'last_name') add('person_name', s);
  }
  // Full names, so "Maria Kowalska" is found as one name as well as its parts.
  const first = values.filter(([k]) => FIELD_CATEGORY[k] === 'first_name').map(([, v]) => v);
  const last = values.filter(([k]) => FIELD_CATEGORY[k] === 'last_name').map(([, v]) => v);
  for (const f of first) for (const l of last) add('person_name', `${f} ${l}`);
  return out;
}

/**
 * All findings in a text, merged by union cover. modelSpans: from the on-device model (offsets in this text).
 * extra: [{ text, category }] the caseworker added. Each finding: { start, end, text, category, score, by }.
 */
export function detect(text, { known = [], patterns = DEFAULT_PATTERNS, modelSpans = [], extra = [] } = {}) {
  const found = [];
  const push = (m, category, score, by) => found.push({ start: m.index, end: m.index + m[0].length, category, score, by });
  for (const { category, text: v } of known) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${v.trim().split(/\s+/).map(escapeRe).join('\\s+')}(?![\\p{L}\\p{N}])`, 'giu');
    for (const m of text.matchAll(re)) push(m, category, 0.99, 'case');
  }
  for (const p of patterns) {
    const re = new RegExp(p.pattern, `g${(p.flags || '').replace('g', '')}`);
    for (const m of text.matchAll(re)) {
      if (!m[0]) continue;
      if (p.category === 'date' && DOB_CONTEXT.test(text.slice(Math.max(0, m.index - 30), m.index))) push(m, 'date_of_birth', 0.95, 'pattern');
      else push(m, p.category, p.score, 'pattern');
    }
  }
  for (const s of modelSpans) {
    const category = MODEL_LABELS[s.label] || (CATEGORIES[s.label] ? s.label : null);
    if (category) found.push({ start: s.start, end: s.end, category, score: s.score, by: 'model' });
  }
  for (const x of extra) {
    const v = String(x.text || '').trim();
    if (!v) continue;
    for (const m of text.matchAll(new RegExp(v.split(/\s+/).map(escapeRe).join('\\s+'), 'gi'))) push(m, x.category, 1, 'you');
  }
  return unionCover(text, found);
}

/**
 * Settings after policy: { groups, threshold, format, allowSendAsWritten, lockedGroups }.
 * policy: values.redaction from lib/policy.js.
 */
export function effectiveSettings(mine = {}, policy = {}) {
  const groups = { ...DEFAULT_GROUPS, ...(mine.groups || {}) };
  for (const g of policy.lockedGroups || []) groups[g] = true;
  let threshold = Number.isFinite(mine.threshold) ? mine.threshold : 0.7;
  if (Number.isFinite(policy.maxThreshold)) threshold = Math.min(threshold, policy.maxThreshold);
  return {
    groups, threshold, lockedGroups: policy.lockedGroups || [], maxThreshold: policy.maxThreshold ?? null,
    format: policy.format === 'off' ? 'off' : ['off', 'regex'].includes(mine.format) ? mine.format : 'shape', formatLocked: policy.format === 'off',
    allowSendAsWritten: policy.allowSendAsWritten !== false,
  };
}

export const findingKey = (f) => `${f.category}:${sameValue(f.text)}`;

/**
 * Decide what is redacted. Scored at or above the threshold and in a group that's on: redacted. Below it,
 * or in a group that's off: sent as written, listed so it can be ticked. over: { findingKey: true|false } are
 * the caseworker's switches; un-redacting is refused when policy doesn't allow sending as written.
 */
export function decide(findings, settings, over = {}) {
  return findings.map((f) => {
    const why = f.by === 'you' ? 'you' : !settings.groups[CATEGORIES[f.category]?.group] ? 'off' : f.score < settings.threshold ? 'low' : 'on';
    const auto = why === 'on' || why === 'you';
    const key = findingKey(f);
    let redact = key in over ? over[key] : auto;
    if (!redact && auto && !settings.allowSendAsWritten) redact = true;
    return { ...f, key, why, redact };
  });
}

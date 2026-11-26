// Matching document text to the case's fields, on this computer. Known document types use the library's
// document profiles (anchors and value patterns); anything else falls back to field labels and synonyms
// next to a value. Every value is validated before it can be added. Pure functions.
import { validateValue } from '../fields.js';
import { escapeRe } from '../pii.js';

export function validateDocumentProfile(p, fields = {}) {
  const errors = [];
  if (!p || typeof p !== 'object') return ['Document profile must be an object'];
  for (const k of ['id', 'name', 'version']) if (typeof p[k] !== 'string' || !p[k]) errors.push(`"${k}" must be a non-empty string`);
  if (!Array.isArray(p.detect) || !p.detect.length || p.detect.some((d) => typeof d !== 'string')) errors.push('"detect" must list words that identify the document');
  if (!p.fields || typeof p.fields !== 'object') errors.push('"fields" must map case fields to { anchor, pattern }');
  else for (const [key, f] of Object.entries(p.fields)) {
    if (Object.keys(fields).length && !fields[key]) errors.push(`fields.${key}: not a case field`);
    if (typeof f?.anchor !== 'string' || !f.anchor) errors.push(`fields.${key}.anchor must be text`);
    if (f?.pattern !== undefined) { try { new RegExp(f.pattern, 'i'); } catch { errors.push(`fields.${key}.pattern is not a valid regex`); } }
  }
  return errors;
}

const by = (p) => (p.step ? `step ${p.name}` : `document profile ${p.id} ${p.version}`);
const confidenceOf = (n) => (n == null ? 'high' : n >= 85 ? 'high' : n >= 60 ? 'medium' : 'low');

// Lines: [{ text, page, confidence? }]. Returns the profile whose detect words all appear, if any.
export function detectProfile(lines, profiles = []) {
  const all = lines.map((l) => l.text).join('\n').toLowerCase();
  return profiles.find((p) => p.detect.every((d) => all.includes(d.toLowerCase()))) || null;
}

function after(line, anchor) {
  const i = line.text.toLowerCase().indexOf(anchor.toLowerCase());
  return i < 0 ? null : line.text.slice(i + anchor.length).replace(/^[\s:–-]+/, '').trim();
}

/**
 * A scan step's reading as a profile matchDocument can use: always detected, with the step's anchors and
 * patterns. A field with neither falls back to its label.
 */
export const stepProfile = (step) => ({
  id: `step-${step.id}`, name: step.name, version: '', detect: [], step: true,
  fields: Object.fromEntries(Object.entries(step.scan?.fields || {}).filter(([, f]) => f?.anchor || f?.pattern).map(([k, f]) => [k, { anchor: f.anchor || '', ...(f.pattern ? { pattern: f.pattern } : {}) }])),
});

/**
 * Rows for the review: [{ key, value, raw, quote, page, confidence, ok, error, by }]. keys: the case's fields.
 */
export function matchDocument(lines, lib, keys, profiles = []) {
  const rows = [];
  const profile = detectProfile(lines, profiles);
  const push = (key, raw, line, by) => {
    if (rows.some((r) => r.key === key) || raw == null || raw === '') return;
    const check = validateValue(lib.fields[key], raw);
    rows.push({ key, raw, value: check.ok ? check.value : String(raw), quote: line.text.slice(0, 200), page: line.page ?? 1, confidence: confidenceOf(line.confidence), ok: check.ok, error: check.ok ? null : check.error, by });
  };
  if (profile) {
    for (const [key, f] of Object.entries(profile.fields)) {
      if (!keys.includes(key)) continue;
      // No anchor: the first text anywhere that has the value's shape, such as a case number.
      if (!f.anchor) {
        if (!f.pattern) continue;
        const re = new RegExp(f.pattern, 'i');
        for (const line of lines) {
          const m = re.exec(line.text);
          if (m) { push(key, m[1] ?? m[0], line, `${by(profile)} pattern`); break; }
        }
        continue;
      }
      for (let i = 0; i < lines.length; i++) {
        let rest = after(lines[i], f.anchor);
        if (rest == null) continue;
        let line = lines[i];
        if (!rest && lines[i + 1]) { rest = lines[i + 1].text; line = { ...lines[i + 1], text: `${lines[i].text} ${lines[i + 1].text}` }; }
        const m = f.pattern ? new RegExp(f.pattern, 'i').exec(rest) : null;
        push(key, f.pattern ? (m ? m[1] ?? m[0] : null) : rest, line, by(profile));
        break;
      }
    }
  }
  // Fallback: "Label: value" or "Label value" on one line, by the field's label and synonyms.
  for (const key of keys) {
    const def = lib.fields[key];
    if (!def || def.manual || rows.some((r) => r.key === key)) continue;
    const names = [def.label, ...(def.synonyms || [])];
    for (const line of lines) {
      const hit = names.find((n) => new RegExp(`(^|\\b)${escapeRe(n)}\\b`, 'i').test(line.text));
      if (!hit) continue;
      const rest = after(line, hit);
      if (rest) { push(key, rest, line, 'label'); break; }
    }
  }
  return { profile: profile ? { id: profile.id, name: profile.name, version: profile.version } : null, rows };
}

// Plain text split into lines with page numbers, for documents with a text layer.
export const textLines = (pages) => pages.flatMap((p) => p.text.split(/\n+/).map((text) => ({ text: text.trim(), page: p.n })).filter((l) => l.text));

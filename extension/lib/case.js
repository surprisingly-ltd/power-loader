// The active case: one at a time, started from one or more target forms in the library.
// Field state is derived from the clips each time, so removing evidence never leaves stale values.
// Pure functions, no browser APIs; callers persist the case through lib/storage.js.
//
// Case:
//   { schema, id, ref, createdAt, library: { commit }, forms: [{ id, version }],
//     clips: [Clip], manual: {key: value}, resolved: {key: value}, resolvedOn: {key: candidateSignature},
//     excluded: ['clipId:key'], filled: {formId: Fill}, submitted: {formId: { at, how, ref? }},
//     workings: [{ id, title, text, uses: [clipId] }], aiPeriods: [{ id, clipId, accepted, ... }],
//     notNeeded: [key], log: [Event], seq }
//   Clip: { id, source, kind: 'page'|'document'|'ai'|'fetch', profile: { id, version, draft? }, name, url, title,
//           capturedAt, revision, values: {key: value}, records: [Record], quotes: {key: text}, extra: {key: value},
//           identity?: { mismatched: [key], confirmed? }, via?: { stepId, requestId } (a page a fetch step fetched),
//           format?: 'json' (read from a JSON response; for display only, nothing else reads it) }
//   Fill: { at, items: [{ box, key, value, clips: [clipId] }], report, stale? }
import { DEFAULT_IDENTITY, checkRules, display, norm, validateValue } from './fields.js';
import { logEvent } from './activity.js';

export const SCHEMA = 1;
const STRONG_IDENTITY = ['dob', 'nino', 'clientId'];

export function randomId(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return `${prefix}-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 6)}`;
}

// noForms: a case from a flow that fills no form (an inbox triage, whose results are rows). Every case is a
// case of a flow (lib/core.js startFlowCase()).
export function newCase(lib, formIds, { ref = '', now = new Date().toISOString(), id = randomId('case'), noForms = false } = {}) {
  if (!formIds.length && !noForms) throw new Error('Choose at least one form to start a case');
  const forms = formIds.map((fid) => {
    const f = lib.forms[fid];
    if (!f) throw new Error(`Form “${fid}” isn’t in the library`);
    return { id: f.id, version: f.version };
  });
  return {
    schema: SCHEMA, id, ref: String(ref).trim(), createdAt: now, library: { commit: lib.commit }, forms,
    clips: [], manual: {}, resolved: {}, resolvedOn: {}, excluded: [], filled: {}, submitted: {},
    workings: [], aiPeriods: [], log: [], seq: 0,
  };
}

/**
 * Set the case reference once: from the address of the case the caseworker opened (from: 'address', with the
 * step that chose it) or typed (from: 'typed'). Logged as set_reference with the step's name, never the
 * reference or the address. A case that has a reference keeps it: changing it means clearing it first.
 */
export function setCaseRef(c, ref, { from = 'typed', step = null } = {}) {
  const v = String(ref || '').trim().slice(0, 80);
  if (!v) throw new Error('Type a case reference');
  if (c.ref) throw new Error(`This case already has the reference ${c.ref}`);
  c.ref = v;
  c.refFrom = { from, ...(step ? { stepId: step.id } : {}) };
  logEvent(c, 'set_reference', { detail: [from === 'address' ? 'from the case opened' : 'typed', step?.name].filter(Boolean).join(' · ') });
}

/**
 * Clear the case reference, to choose another case: only before the first clip, so nothing already in the
 * case was gathered under the wrong reference.
 */
export function clearCaseRef(c) {
  if (c.clips.length) throw new Error('This case already has clips, so its reference stays. Finish this case first to work on another.');
  c.ref = '';
  delete c.refFrom;
}

/** Can the caseworker still change the reference? Until the first clip. */
export const refChangeable = (c) => !!c?.ref && !c.clips.length;

const formOf = (lib, f) => lib.forms[f.id];
const def = (lib, key) => lib.fields[key] || { label: key };

// The case's fields, in library order: everything any target form needs.
export function caseKeys(c, lib) {
  const want = new Set(c.forms.flatMap((f) => (formOf(lib, f)?.fields || []).map((x) => x.key)));
  return Object.keys(lib.fields).filter((k) => want.has(k));
}

export const neededBy = (c, lib, key) => c.forms.filter((f) => (formOf(lib, f)?.fields || []).some((x) => x.key === key)).map((f) => f.id);
export const isRequired = (c, lib, key) => c.forms.some((f) => (formOf(lib, f)?.fields || []).some((x) => x.key === key && x.required));
export const settled = (status) => status === 'ok' || status === 'resolved' || status === 'manual';
const excluded = (c, clipId, key) => c.excluded.includes(`${clipId}:${key}`);

// Sorted normalised candidate values: a decision is tied to exactly this set.
export const candidateSignature = (cands) => cands.map((x) => x.n).sort().join('|');

/**
 * { status: 'ok' | 'resolved' | 'manual' | 'missing' | 'conflict', value, cands: [{ n, value, sources: [clipId] }],
 *   reopened?, valid, error? }. Settled values carry validity: invalid ones need fixing and are never filled.
 */
export function fieldState(c, lib, key) {
  const d = def(lib, key);
  const cands = [];
  for (const clip of c.clips) {
    if (!(key in clip.values) || excluded(c, clip.id, key)) continue;
    const v = clip.values[key];
    const n = norm(d, v);
    let cd = cands.find((x) => x.n === n);
    if (!cd) cands.push((cd = { n, value: v, sources: [] }));
    cd.sources.push(clip.id);
  }
  let st;
  if (c.manual[key] != null && c.manual[key] !== '') st = { status: 'manual', value: c.manual[key], cands };
  else if (!cands.length) st = { status: 'missing', cands };
  else if (cands.length === 1) st = { status: 'ok', value: cands[0].value, cands };
  else if (key in c.resolved) {
    // A decision stands only while the candidates are the ones decided between. New or removed evidence reopens it.
    st = c.resolvedOn[key] === candidateSignature(cands)
      ? { status: 'resolved', value: c.resolved[key], cands }
      : { status: 'conflict', cands, reopened: true, previous: c.resolved[key] };
  } else st = { status: 'conflict', cands };
  if (settled(st.status)) {
    const check = validateValue(d, st.value);
    st.valid = check.ok;
    if (check.ok) st.normalised = check.value;
    else st.error = check.error;
  }
  return st;
}

export function decide(c, lib, key, value) {
  c.resolved[key] = value;
  c.resolvedOn[key] = candidateSignature(fieldState(c, lib, key).cands);
}

export function undecide(c, key) {
  delete c.resolved[key];
  delete c.resolvedOn[key];
}

export function setManual(c, key, value) {
  if (value === null || value === undefined || String(value).trim() === '') delete c.manual[key];
  else c.manual[key] = String(value).trim();
}

// Settled, valid values by key, for rules and filling.
export function readyValues(c, lib) {
  const out = {};
  for (const key of caseKeys(c, lib)) {
    const st = fieldState(c, lib, key);
    if (settled(st.status) && st.valid) out[key] = st.normalised;
  }
  return out;
}

export function ruleProblems(c, lib, formId, today = new Date().toISOString().slice(0, 10)) {
  const f = lib.forms[formId];
  return f ? checkRules(f.rules, readyValues(c, lib), today) : [];
}

/** Per-form progress. Ready means every required field is settled and valid, rules hold and nothing conflicts. */
export function formProgress(c, lib, formId, today) {
  const f = lib.forms[formId];
  const problems = ruleProblems(c, lib, formId, today);
  const ruleKeys = new Set(problems.flatMap((p) => p.keys));
  const out = { req: 0, done: 0, conflicts: [], missing: [], invalid: [], rules: problems, ready: false };
  for (const x of f?.fields || []) {
    const st = fieldState(c, lib, x.key);
    if (st.status === 'conflict') out.conflicts.push(x.key);
    if (settled(st.status) && (!st.valid || ruleKeys.has(x.key))) out.invalid.push(x.key);
    if (!x.required) continue;
    out.req++;
    if (settled(st.status) && st.valid && !ruleKeys.has(x.key)) out.done++;
    else if (st.status === 'missing') out.missing.push(x.key);
  }
  out.ready = out.done === out.req && !out.conflicts.length && !out.invalid.length;
  return out;
}

export const conflictKeys = (c, lib) => caseKeys(c, lib).filter((k) => fieldState(c, lib, k).status === 'conflict');

// Fields with evidence or your own values that no target form needs any more (after a form was removed).
export function notNeededKeys(c, lib) {
  const keys = new Set(caseKeys(c, lib));
  const have = new Set([...c.clips.flatMap((cl) => Object.keys(cl.values)), ...Object.keys(c.manual), ...Object.keys(c.resolved)]);
  return [...have].filter((k) => lib.fields[k] && !keys.has(k));
}

// ------------------------------------------------------------------ clips

const identityKeys = (lib) => {
  const marked = Object.entries(lib.fields).filter(([, d]) => d.identity).map(([k]) => k);
  return marked.length ? marked : DEFAULT_IDENTITY;
};
const strong = (lib, key) => (lib.fields[key]?.identity === 'strong') || (!lib.fields[key]?.identity && STRONG_IDENTITY.includes(key));

/**
 * Add a clip, or replace the earlier clip of the same source. Re-clipping keeps your exclusions
 * unless the source now shows a different value. Returns a summary of what changed.
 */
export function addClip(c, lib, clip) {
  const keys = caseKeys(c, lib);
  const before = Object.fromEntries(keys.map((k) => [k, fieldState(c, lib, k)]));
  const old = c.clips.find((x) => x.source === clip.source);
  const id = old ? old.id : clip.id || randomId('clip');
  // Identity is compared with the rest of the case, not with an earlier copy of this same source.
  const others = { ...c, clips: c.clips.filter((x) => x !== old) };
  const mismatched = identityKeys(lib).filter((k) => {
    if (!(k in clip.values)) return false;
    const st = fieldState(others, lib, k);
    const known = settled(st.status) ? [st.value] : st.cands.map((x) => x.value);
    return known.length && !known.some((v) => norm(def(lib, k), v) === norm(def(lib, k), clip.values[k]));
  });
  const different = mismatched.some((k) => strong(lib, k)) || mismatched.length >= 2;
  const next = { ...clip, id, revision: old ? (old.revision || 0) + 1 : 1, ...(different ? { identity: { mismatched } } : {}) };
  if (!different) delete next.identity;
  c.clips = c.clips.filter((x) => x !== old).concat(next);
  for (const k of Object.keys(clip.values)) {
    if (!old || norm(def(lib, k), old.values[k]) !== norm(def(lib, k), clip.values[k])) c.excluded = c.excluded.filter((e) => e !== `${id}:${k}`);
  }
  const summary = { clipId: id, replaced: !!old, added: [], agreed: [], conflicts: [], extra: Object.keys(clip.extra || {}), records: (clip.records || []).length, identity: different ? mismatched : [] };
  for (const k of Object.keys(clip.values)) {
    if (!keys.includes(k)) { summary.extra.push(k); continue; }
    const st = fieldState(c, lib, k);
    if (st.status === 'conflict') summary.conflicts.push(k);
    else if (before[k].status === 'missing') summary.added.push(k);
    else summary.agreed.push(k);
  }
  return summary;
}

/**
 * Turn what a page profile read into a clip. Top-level keys that are case fields become values
 * (normalised when valid, kept as read when not, so they show as "needs fixing"). Lists of rows become
 * records for the tools; anything else is kept as extra and never used.
 */
export function clipFromExtract(lib, profile, { data, url, title }, { kind = 'page', capturedAt = new Date().toISOString(), quotes, via } = {}) {
  const values = {};
  const extra = {};
  const records = [];
  for (const [key, v] of Object.entries(data || {})) {
    if (key.startsWith('@') || v === null || v === undefined || v === '') continue;
    if (Array.isArray(v)) {
      v.filter(isRow).forEach((row, i) => records.push({ ...row, type: row['@type'] || 'row', group: key, id: `${key}-${i + 1}` }));
      continue;
    }
    if (typeof v === 'object') { extra[key] = v; continue; }
    if (!lib.fields[key]) { extra[key] = v; continue; }
    const check = validateValue(lib.fields[key], v);
    values[key] = check.ok ? check.value : String(v);
  }
  for (const r of records) delete r['@type'];
  return {
    source: `${profile.id}|${url}`, kind, profile: { id: profile.id, version: profile.version, ...(profile.draft ? { draft: profile.draft } : {}) },
    name: profile.name, url, title, capturedAt, values, records, extra, ...(quotes ? { quotes } : {}),
    ...(via ? { via: { stepId: String(via.stepId), requestId: String(via.requestId) } } : {}),
  };
}
const isRow = (r) => r !== null && typeof r === 'object' && !Array.isArray(r);

// "It's the same person": keeps the clip and stops warning about it.
export function confirmIdentity(c, clipId) {
  const clip = c.clips.find((x) => x.id === clipId);
  if (clip?.identity) clip.identity.confirmed = true;
}

export const identityWarnings = (c) => c.clips.filter((x) => x.identity && !x.identity.confirmed);

export function excludeValue(c, clipId, key) {
  if (!excluded(c, clipId, key)) c.excluded.push(`${clipId}:${key}`);
}

export function restoreValue(c, clipId, key) {
  c.excluded = c.excluded.filter((e) => e !== `${clipId}:${key}`);
}

// What removing a clip would do to the case's values.
export function clipImpact(c, lib, clipId) {
  const keys = caseKeys(c, lib);
  const after = { ...c, clips: c.clips.filter((x) => x.id !== clipId) };
  const out = { conflictsGone: [], becomeMissing: [], changed: [] };
  for (const k of keys) {
    const b = fieldState(c, lib, k);
    const a = fieldState(after, lib, k);
    if (b.status === 'conflict' && a.status !== 'conflict') out.conflictsGone.push(k);
    else if (settled(b.status) && a.status === 'missing') out.becomeMissing.push(k);
    else if (settled(b.status) && settled(a.status) && norm(def(lib, k), b.value) !== norm(def(lib, k), a.value)) out.changed.push(k);
  }
  return out;
}

// Everything that depends on a clip: what "Wrong person" clears along with it.
export function clipDependents(c, lib, clipId) {
  const clip = c.clips.find((x) => x.id === clipId);
  if (!clip) return null;
  const keys = Object.keys(clip.values);
  const d = {
    manual: keys.filter((k) => c.manual[k] != null && c.manual[k] !== ''),
    choices: keys.filter((k) => k in c.resolved && norm(def(lib, k), c.resolved[k]) === norm(def(lib, k), clip.values[k])),
    workings: c.workings.filter((w) => (w.uses || []).includes(clipId)).map((w) => w.id),
    periods: c.aiPeriods.filter((p) => p.clipId === clipId && !p.dismissed).map((p) => p.id),
    filled: Object.entries(c.filled).filter(([, f]) => (f.items || []).some((i) => (i.clips || []).includes(clipId) || keys.includes(i.key))).map(([id]) => id),
  };
  d.any = d.manual.length + d.choices.length + d.workings.length + d.periods.length + d.filled.length > 0;
  return d;
}

/**
 * Remove a clip. With clearDependents (always for "Wrong person"), also clears values you typed for its
 * fields, choices that picked its value, workings and AI periods that used it. Filled forms that used it
 * are flagged "check again" either way: their boxes may still hold its values.
 */
export function removeClip(c, lib, clipId, { clearDependents = false } = {}) {
  const deps = clipDependents(c, lib, clipId);
  if (!deps) throw new Error('That clip is no longer in the case');
  const clip = c.clips.find((x) => x.id === clipId);
  if (clearDependents) {
    deps.manual.forEach((k) => delete c.manual[k]);
    deps.choices.forEach((k) => undecide(c, k));
    c.workings = c.workings.filter((w) => !deps.workings.includes(w.id));
    c.aiPeriods.forEach((p) => { if (deps.periods.includes(p.id)) Object.assign(p, { accepted: false, dismissed: true }); });
  }
  for (const id of deps.filled) c.filled[id].stale = { reason: 'removed', at: new Date().toISOString() };
  c.clips = c.clips.filter((x) => x.id !== clipId);
  c.excluded = c.excluded.filter((e) => !e.startsWith(`${clipId}:`));
  return { clip, deps };
}

// ------------------------------------------------------------------ pages outside the flow

const bareAddress = (url) => { try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return String(url || '').split(/[?#]/)[0]; } };

/** Not needed for this flow (D16): the box asking whether the flow is incomplete isn't shown here again in this case. */
export function markNotInFlow(c, url) {
  const a = bareAddress(url);
  c.notInFlow = [...new Set([...(c.notInFlow || []), a])].slice(-200);
}

export const notInFlow = (c, url) => (c?.notInFlow || []).includes(bareAddress(url));

// ------------------------------------------------------------------ forms

// A case's forms are its flow's: they are set when it starts and don't change.

// how: 'observed' (a library confirmation profile matched the page and its reference) or 'reported' (you ticked it).
export function markSubmitted(c, formId, { how, ref, at = new Date().toISOString() }) {
  if (!c.forms.some((x) => x.id === formId)) throw new Error('That form isn’t part of this case');
  if (c.submitted[formId]?.how === 'observed' && how === 'reported') return;
  c.submitted[formId] = { at, how, ...(ref ? { ref } : {}) };
}

export function unmarkSubmitted(c, formId) {
  if (c.submitted[formId]?.how === 'reported') delete c.submitted[formId];
}

// A filled form needs checking again when it was flagged, or the case no longer holds what was put in it.
export function fillStale(c, lib, formId) {
  const f = c.filled[formId];
  if (!f) return null;
  if (f.stale) return f.stale;
  const now = readyValues(c, lib);
  const changed = (f.items || []).filter((i) => i.key && norm(def(lib, i.key), now[i.key]) !== norm(def(lib, i.key), i.value));
  return changed.length ? { reason: 'changed', keys: changed.map((i) => i.key) } : null;
}

/**
 * What one source's value is to the case, for the clip list, the Sources view and the matrix:
 * { s: 'extra' | 'excluded' | 'conflict' | 'used' | 'over', t: label, c: pill class }.
 * In a loop, pass the case's keys (a Set) and the field's state so they aren't worked out again.
 */
export function contribution(c, lib, clip, k, { keys = new Set(caseKeys(c, lib)), state } = {}) {
  if (!lib.fields[k] || !keys.has(k)) return { s: 'extra', t: 'Not needed by these forms', c: '' };
  if (c.excluded.includes(`${clip.id}:${k}`)) return { s: 'excluded', t: 'Excluded by you', c: 'warn' };
  const st = state || fieldState(c, lib, k);
  if (st.status === 'conflict') return { s: 'conflict', t: 'In conflict', c: 'bad' };
  const mine = norm(lib.fields[k], clip.values[k]);
  if (settled(st.status) && norm(lib.fields[k], st.value) === mine) {
    const agree = st.cands.find((cd) => cd.n === mine)?.sources.length > 1;
    return { s: 'used', t: st.status === 'manual' ? 'Used, you typed the same' : agree ? 'Used, sources agree' : 'Used', c: 'ok' };
  }
  return { s: 'over', t: settled(st.status) ? `Not used. Case has ${display(lib.fields[k], st.value)}` : 'Not used', c: 'warn' };
}

/**
 * What one clip's value is to the case now, for the step's list, its line and the outlines on the page:
 *   'matched'    another source agrees, and nothing was decided
 *   'new'        only this source has it
 *   'used'       the sources disagreed (or you typed one) and the case uses this source's value
 *   'overridden' the case uses another value: another source's, chosen, or one you typed
 *   'conflict'   still to decide
 *   'excluded'   you excluded it; 'extra': not a field the forms need; null: the clip doesn't have it
 * Worked out from the case as it is, so it changes as conflicts are decided, reopened or overridden.
 */
export function clipValueState(c, lib, clip, k, { keys = new Set(caseKeys(c, lib)), state } = {}) {
  if (!clip || !(k in (clip.values || {}))) return null;
  if (!lib.fields[k] || !keys.has(k)) return 'extra';
  if (excluded(c, clip.id, k)) return 'excluded';
  const st = state || fieldState(c, lib, k);
  if (st.status === 'conflict') return 'conflict';
  const d = def(lib, k);
  const mine = norm(d, clip.values[k]);
  const same = settled(st.status) && norm(d, st.value) === mine;
  if (st.status === 'resolved') return same ? 'used' : 'overridden';
  if (st.status === 'manual') return !same ? 'overridden' : st.cands.length > 1 ? 'used' : st.cands.find((cd) => cd.n === mine)?.sources.length > 1 ? 'matched' : 'new';
  return st.cands.find((cd) => cd.n === mine)?.sources.length > 1 ? 'matched' : 'new';
}

/**
 * A clip's line, worked out from the case now: { matched, new, used, overridden, conflicts, extra, records },
 * each a list of keys but records (a count). Excluded values aren't counted. Replaces addClip()'s summary
 * wherever a clip's result is shown, because that summary is only true at the moment of the clip.
 */
export function clipTally(c, lib, clip) {
  const out = { matched: [], new: [], used: [], overridden: [], conflicts: [], extra: Object.keys(clip?.extra || {}), records: (clip?.records || []).length };
  if (!clip) return out;
  const keys = new Set(caseKeys(c, lib));
  for (const k of Object.keys(clip.values || {})) {
    const s = clipValueState(c, lib, clip, k, { keys });
    if (s === 'conflict') out.conflicts.push(k);
    else if (s === 'extra') out.extra.push(k);
    else if (s && s !== 'excluded') out[s].push(k);
  }
  return out;
}

/** Tallies added together, for a step that read several pages (a fetch step's summary). */
export function addTallies(list) {
  const out = { matched: [], new: [], used: [], overridden: [], conflicts: [], extra: [], records: 0 };
  for (const t of list) {
    for (const k of ['matched', 'new', 'used', 'overridden', 'conflicts', 'extra']) out[k].push(...t[k]);
    out.records += t.records;
  }
  // A field two of the pages are in conflict over is one conflict to decide.
  out.conflicts = [...new Set(out.conflicts)];
  return out;
}

/** A result saved from a tool. uses: the clips it relied on, so removing one of them can clear it. */
export function addWorking(c, { title, text, uses = [], inputs }) {
  c.workings.push({ id: randomId('w'), title, text, uses, ...(inputs ? { inputs } : {}), at: new Date().toISOString() });
}

// ------------------------------------------------------------------ copies

export function counts(c) {
  return {
    clips: c.clips.length,
    values: c.clips.reduce((n, cl) => n + Object.keys(cl.values).length + (cl.records || []).length, 0),
    decisions: Object.keys(c.resolved).length + Object.keys(c.manual).length,
    workings: c.workings.length,
  };
}

export function caseLabel(c, lib) {
  if (!c) return '';
  if (c.ref) return c.ref;
  // A case with no form, from a flow (an inbox triage): the flow's name and the day it started.
  if (!c.forms.length && c.library?.flow?.name) {
    const d = new Date(c.createdAt);
    return `${c.library.flow.name}, ${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]}`;
  }
  const name = ['firstName', 'lastName'].map((k) => {
    if (!lib.fields[k]) return '';
    const st = fieldState(c, lib, k);
    return settled(st.status) ? st.value : st.cands[0]?.value || '';
  }).filter(Boolean).join(' ');
  return name || 'New case';
}

export function caseText(c, lib) {
  const lines = [`Case: ${caseLabel(c, lib)}`, `Forms: ${c.forms.map((f) => `${lib.forms[f.id]?.name || f.id} ${f.version}`).join(', ')}`, ''];
  let section = null;
  for (const k of caseKeys(c, lib)) {
    const d = def(lib, k);
    if ((d.section || '') !== section) { section = d.section || ''; if (section) lines.push(`== ${section} ==`); }
    const st = fieldState(c, lib, k);
    let v;
    if (settled(st.status)) v = display(d, st.value) + (st.valid ? '' : '  [NEEDS FIXING]');
    else if (st.status === 'conflict') v = `CONFLICT: ${st.cands.map((x) => display(d, x.value)).join(' / ')}`;
    else v = '(missing)';
    const urls = settled(st.status) ? st.cands.filter((x) => x.n === norm(d, st.value)).flatMap((x) => x.sources).map((id) => c.clips.find((cl) => cl.id === id)?.url).filter(Boolean) : [];
    const from = st.status === 'manual' ? '  [entered by caseworker]' : urls.length ? `  [${urls.join(', ')}]` : '';
    lines.push(`${d.label}: ${v}${from}`);
  }
  if (c.workings.length) { lines.push('', '== Workings =='); c.workings.forEach((w) => lines.push(w.text, '')); }
  return lines.join('\n');
}

export function caseJson(c, lib) {
  const fields = {};
  for (const k of caseKeys(c, lib)) {
    const st = fieldState(c, lib, k);
    fields[k] = { status: st.status, ...(settled(st.status) ? { value: st.value, valid: st.valid } : {}), ...(st.status === 'conflict' ? { candidates: st.cands.map((x) => x.value) } : {}) };
  }
  return {
    reference: c.ref || null, forms: c.forms, fields,
    sources: c.clips.map((cl) => ({ name: cl.name, url: cl.url, capturedAt: cl.capturedAt, values: cl.values })),
    workings: c.workings.map((w) => ({ title: w.title, text: w.text })),
  };
}

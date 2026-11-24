// Local profile drafts: made on this computer, used only here and only after a passing test, and
// published by exporting a file for a library maintainer. Pure functions, no browser APIs.
//
// Draft: { id, kind: 'extract' | 'fill', profile, base: { id, version, commit } | null, from: 'you' | 'ai' | 'local',
//          targets: [formId] (extract drafts: the forms the values are for, chosen first),
//          created, updated, use, tested: Test | null, second: Test | null,
//          exported: { at, hash, version } | null, conflict: { version, hash } | null }
// Test:  { at, url, ok, snapshot, fields: { key: { count, ok, error } }, leaks: [string] } (never page values)
import { canonical } from './hash.js';
import { validateValue } from './fields.js';
import { hostApproved, hostOf, validateLibraryProfile } from './library.js';

export const SCHEMA = 'powerloader-profile/1';
const nextVersion = (v) => `v${Number(String(v || 'v0').slice(1)) + 1}`;
const now = () => new Date().toISOString();
export const randomDraftId = () => `d-${Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('')}`;

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'page';
const idLike = (seg) => /\d/.test(seg) && /^[\w.~%-]+$/.test(seg);

// A match pattern and an anonymised link pattern from a page address: identifier-like path parts become wildcards.
export function suggestPatterns(url) {
  const u = new URL(url);
  const parts = u.pathname.split('/');
  // A file name keeps its words: rent-account-1042.html → rent-account-*.html, so it doesn't match every page
  // in the folder (a form among them). Any other identifier-like part is a wildcard as a whole.
  const file = (p, wild) => { const dot = p.lastIndexOf('.'); const stem = p.slice(0, dot); return /[A-Za-z]{2}/.test(stem) ? `${stem.replace(/\d+/g, wild)}${p.slice(dot)}` : `${wild}${p.slice(dot)}`; };
  const part = (p, wild) => (!idLike(p) ? p : p.includes('.') ? file(p, wild) : wild);
  const match = `${u.origin}${parts.map((p) => part(p, '*')).join('/')}${u.search ? '*' : ''}`;
  const pattern = `${u.origin}${parts.map((p) => part(p, '{ref}')).join('/')}`;
  return { match: match.endsWith('*') ? match : `${match}*`, urlPattern: pattern };
}

export function newPageDraft({ url, title, from = 'you', targets = null }) {
  const host = new URL(url).hostname.split('.')[0];
  const name = String(title || 'New page').split(/ [–|-] /)[0].trim().slice(0, 60) || 'New page';
  const { match, urlPattern } = suggestPatterns(url);
  return {
    id: randomDraftId(), kind: 'extract', base: null, from, created: now(), updated: now(), use: false, tested: null, second: null, exported: null, conflict: null,
    ...(targets ? { targets: [...targets] } : {}),
    profile: { schema: SCHEMA, id: `${host}/${slug(name)}`, kind: 'extract', name, version: 'v1', match: [match], urlPattern, fields: {} },
  };
}

// A page title often holds a value from the page ("Client NC-1042: Maria Kowalska"), which must never be in a
// profile. Rename a new draft when its name does: after its target forms, or plainly "New page".
export function nameWithout(d, values, lib) {
  if (!literalLeaks({ name: d.profile.name }, values).length) return false;
  const host = d.profile.id.split('/')[0];
  const names = (d.targets || []).map((id) => lib?.forms?.[id]?.short || id);
  d.profile.name = names.length ? `Page for ${names.join(', ')}` : 'New page';
  d.profile.id = `${host}/${slug(d.profile.name)}`;
  return true;
}

// "Make a new version": a copy of the published profile with the next version, remembering its base.
export function draftFromProfile(published, commit) {
  const { path, draft, ...profile } = structuredClone(published); // eslint-disable-line no-unused-vars
  delete profile.exported;
  return {
    id: randomDraftId(), kind: profile.kind === 'fill' ? 'fill' : 'extract', from: 'you', created: now(), updated: now(),
    use: false, tested: null, second: null, exported: null, conflict: null,
    base: { id: profile.id, version: profile.version, commit },
    profile: { ...profile, schema: SCHEMA, version: nextVersion(profile.version) },
  };
}

export function newFillDraft(form, { url, from = 'you' } = {}) {
  const { match, urlPattern } = url ? suggestPatterns(url) : { match: form.url ? `${form.url}*` : '', urlPattern: form.url || '' };
  return {
    id: randomDraftId(), kind: 'fill', base: null, from, created: now(), updated: now(), use: false, tested: null, second: null, exported: null, conflict: null,
    profile: { schema: SCHEMA, id: `fill/${form.id}`, kind: 'fill', name: form.name, version: 'v1', form: { id: form.id, version: form.version }, match: [match], urlPattern, fields: {} },
  };
}

// Any edit sets the draft back to "Not tested" and out of use.
export function editDraft(d, change) {
  change(d.profile);
  Object.assign(d, { updated: now(), tested: null, second: null, use: false });
  return d;
}

// ------------------------------------------------------------------ picks: what the editor shows
// An extraction draft's simple fields are picks: { key, selector, part, filter?, by?, score?, check? }. part
// narrows an element that holds several words with the DSL's regex filter (there is no "part" filter in the
// engine); filter is one the field's type needs (date, oneline). by/score/check say how a pick was matched
// (label, type, model, derived, you) and whether the caseworker should check it. Row lists and other
// structures from a base profile stay as they are; picking can't author them yet.
// A fill draft's picks are { box, key, by?, check? }: form box selector → case field.

export const PARTS = { all: 'Whole text', first: 'First word', last: 'Last word', postcode: 'The postcode' };
const FILTERS = new Set(['date', 'oneline', 'trim', 'number']);

export function partFilter(part) {
  if (!part || part === 'all') return '';
  if (part === 'first') return ' | regex:^(\\S+)';
  if (part === 'last') return ' | regex:(\\S+)$';
  if (part === 'postcode') return ' | regex:([A-Z]{1,2}\\d[A-Z\\d]? ?\\d[A-Z]{2})';
  const n = Number(part);
  return Number.isInteger(n) && n > 1 ? ` | regex:^(?:\\S+\\s+){${n - 1}}(\\S+)` : '';
}

export function picksOf(d) {
  if (d.picks) return d.picks;
  const fields = d.profile.fields || {};
  if (d.kind === 'fill') return Object.entries(fields).map(([box, path]) => ({ box, key: String(path).replace(/^CaseData\./, '') }));
  return Object.entries(fields).filter(([, spec]) => typeof spec === 'string').map(([key, selector]) => ({ key, selector, part: 'all' }));
}

function rebuild(d) {
  const picks = picksOf(d);
  if (d.kind === 'fill') {
    d.profile.fields = Object.fromEntries(picks.filter((p) => p.key).map((p) => [p.box, `CaseData.${p.key}`]));
    return;
  }
  const kept = Object.fromEntries(Object.entries(d.profile.fields || {}).filter(([, spec]) => typeof spec !== 'string'));
  const spec = (p) => `${p.selector}${partFilter(p.part)}${FILTERS.has(p.filter) ? ` | ${p.filter}` : ''}`;
  d.profile.fields = { ...Object.fromEntries(picks.filter((p) => p.key).map((p) => [p.key, spec(p)])), ...kept };
}

// Change the picks; the profile is rebuilt and the draft goes back to "Not tested".
export function editPicks(d, change) {
  const picks = structuredClone(picksOf(d));
  change(picks);
  d.picks = picks;
  return editDraft(d, () => rebuild(d));
}

export function togglePick(d, selector, key = '') {
  return editPicks(d, (picks) => {
    const i = picks.findIndex((p) => p.selector === selector);
    if (i >= 0) picks.splice(i, 1);
    else picks.push({ key: picks.some((p) => p.key === key) ? '' : key, selector, part: 'all' });
  });
}

// The case field a page label most likely means, by the library's field labels.
export function guessKey(lib, label) {
  const want = String(label || '').toLowerCase().replace(/[:*]+$/, '').trim();
  if (!want) return '';
  const hit = Object.entries(lib?.fields || {}).find(([k, f]) => !f.manual && (f.label.toLowerCase() === want || k.toLowerCase() === want.replace(/\s+/g, '')));
  return hit ? hit[0] : '';
}

/** Test a fill draft by a dry run: every mapped box must be exactly one control on the form page. */
export function judgeFillTest(d, probes, { url, lib, at = now() }) {
  const fields = {};
  for (const p of picksOf(d).filter((x) => x.key)) {
    const pr = probes[p.box] || { count: 0 };
    const ok = pr.count === 1 && !!lib?.fields[p.key];
    fields[p.box] = { count: pr.count, ok, error: ok ? null : !lib?.fields[p.key] ? 'Choose a case field' : pr.count ? `Matches ${pr.count} elements, not one` : 'No such box on this page' };
  }
  const ok = Object.keys(fields).length > 0 && Object.values(fields).every((f) => f.ok);
  return { at, url, ok, fields, leaks: [], snapshot: canonical(d.profile) };
}

export const testedNow = (d) => !!(d.tested?.ok && d.tested.snapshot === canonical(d.profile));
export const canUse = testedNow;

export function setUse(d, on) {
  if (on && !canUse(d)) throw new Error('Test the draft on a page first. Only a passing draft is used.');
  d.use = !!on;
}

/**
 * Judge a test of an extraction draft on a page. probes: { key: { count, value, rows? } } from the real
 * engine. Every field must match exactly one element (or at least one row for a row list) and read a
 * value that passes the field's validator. No value read on the page may appear in the profile.
 */
export function judgeTest(d, probes, { url, lib, pageValues = [], at = now() }) {
  const fields = {};
  for (const [key, p] of Object.entries(probes)) {
    let ok = true;
    let error = null;
    if (p.error) { ok = false; error = p.error; }
    else if (p.rows) { ok = p.count > 0; if (!ok) error = 'Finds no rows'; }
    else if (p.count !== 1) { ok = false; error = p.count ? `Matches ${p.count} elements, not one` : 'Matches nothing on this page'; }
    else if (p.value == null || p.value === '') { ok = false; error = 'Reads nothing'; }
    else if (lib?.fields[key]) {
      const check = validateValue(lib.fields[key], p.value);
      if (!check.ok) { ok = false; error = check.error; }
    } else if (key !== '@type') { ok = false; error = 'Choose a case field'; }
    // No page values are stored: drafts outlive the case.
    fields[key] = { count: p.count, ok, error };
  }
  const values = [...pageValues, ...Object.values(probes).flatMap((p) => (p.rows ? p.sample || [] : [p.value]))].filter((v) => v != null).map(String);
  // Reported as a count only, for the same reason.
  const leaked = literalLeaks(d.profile, values);
  const leaks = leaked.length ? [`${leaked.length} value${leaked.length === 1 ? '' : 's'} from this page`] : [];
  const ok = Object.keys(fields).length > 0 && Object.values(fields).every((f) => f.ok) && !leaks.length;
  return { at, url, ok, fields, leaks, snapshot: canonical(d.profile) };
}

export function recordTest(d, test) {
  if (d.tested?.ok && d.tested.url !== test.url && d.tested.snapshot === test.snapshot) d.second = test;
  else { d.tested = test; d.second = null; }
  if (!testedNow(d)) d.use = false;
  return d;
}

// Values longer than three characters found anywhere in the profile (selectors, match, link pattern, name),
// as whole tokens with their own capitalisation: "Kowalska" in td:contains("Kowalska") is found, while the
// value "Phone" doesn't match the selector #c-phone.
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function literalLeaks(profile, values) {
  const text = JSON.stringify(exportBody({ profile }));
  const found = new Set();
  for (const v of values) {
    const s = String(v).trim();
    if (s.length <= 3 || found.has(s)) continue;
    const inJson = JSON.stringify(s).slice(1, -1);
    if (new RegExp(`(?<![A-Za-z0-9])${reEsc(inJson)}(?![A-Za-z0-9])`).test(text)) found.add(s);
  }
  return [...found];
}

// Fields as [key, spec] for extraction drafts, or [box, CaseData path] for fill drafts.
const fieldMap = (p) => p?.fields || {};
const rowSpec = (spec) => (Array.isArray(spec) ? spec : null);

/** Compare a draft with its base: fields added, removed or remapped, and metadata changes. */
export function diffDraft(d, base) {
  if (!base) return null;
  const now_ = fieldMap(d.profile);
  const was = fieldMap(base);
  const isFill = d.kind === 'fill';
  // Extraction fields are keyed by case field; fill fields by form box. "Remapped" keeps the other side.
  const added = Object.keys(now_).filter((k) => !(k in was));
  const removed = Object.keys(was).filter((k) => !(k in now_));
  const remapped = Object.keys(now_).filter((k) => k in was && canonical(now_[k]) !== canonical(was[k]))
    .map((k) => ({ key: k, from: was[k], to: now_[k], rows: !isFill && !!(rowSpec(now_[k]) || rowSpec(was[k])) }));
  const meta = [];
  for (const k of ['name', 'match', 'urlPattern', 'when']) {
    if (canonical(d.profile[k] ?? null) !== canonical(base[k] ?? null)) meta.push({ what: k, from: base[k] ?? null, to: d.profile[k] ?? null });
  }
  return { added, removed, remapped, meta, same: !added.length && !removed.length && !remapped.length && !meta.length };
}

export function exportBody(d) {
  const p = d.profile;
  const body = {
    schema: SCHEMA, id: p.id, kind: d.kind === 'fill' ? 'fill' : 'extract', name: p.name, version: p.version,
    ...(d.base ? { basedOn: { version: d.base.version, commit: d.base.commit } } : {}),
    ...(p.form ? { form: p.form } : {}),
    match: p.match, urlPattern: p.urlPattern,
    ...(p.when ? { when: p.when } : {}),
    fields: p.fields,
  };
  return body;
}

export const exportFileName = (d) => `${d.profile.id.replace(/\//g, '--')}.${d.profile.version}.json`;
export const repoPath = (d) => (d.kind === 'fill' ? `profiles/fill/${d.profile.id.replace(/^fill\//, '')}.json` : `profiles/pages/${d.profile.id}.json`);

/**
 * Checks before export: at least one field, the engine's own validator plus library rules, a passing test
 * of exactly this content, and no case or page value anywhere in the file.
 */
export function exportChecks(d, { lib, values = [] }) {
  const body = exportBody(d);
  const n = Object.keys(body.fields || {}).filter((k) => !k.startsWith('@')).length;
  const errors = validateLibraryProfile(body, { approvedHosts: lib?.approvedHosts || [], fields: lib?.fields || {} });
  const leaks = [...literalLeaks(d.profile, values), ...(testedNow(d) ? d.tested.leaks : [])];
  const checks = [
    { ok: n > 0, text: n ? `${n} field${n === 1 ? '' : 's'} mapped` : 'No fields mapped' },
    { ok: !errors.length, text: errors.length ? `Fails validation: ${errors[0]}` : 'Passes the extraction engine’s validator and the library rules' },
    { ok: testedNow(d), text: testedNow(d) ? `Passed its test at ${new Date(d.tested.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}${d.second?.ok ? ', and on a second record' : ''}` : d.tested ? 'Changed since its last test, or the test failed' : 'Not tested yet' },
    { ok: !leaks.length, text: leaks.length ? `Contains values from pages or the case: ${leaks.slice(0, 3).join(', ')}` : 'No page or case values anywhere in the file' },
  ];
  return checks;
}

// Host check for a draft's match and link pattern against the library's approved systems.
export function draftHostsApproved(d, lib) {
  const pats = [...[d.profile.match].flat(), d.profile.urlPattern].filter(Boolean);
  return pats.every((p) => hostApproved(hostOf(p), lib?.approvedHosts || []));
}

/**
 * After a sync: a draft is retired only when the published file's content hash equals the hash it exported.
 * A different published version of the same profile, or a newer one than its base, is a conflict for the
 * caseworker to settle. Nothing is deleted silently. published: { id: { version, hash } }.
 */
export function reconcileDrafts(drafts, published) {
  const retired = [];
  const conflicts = [];
  const list = [];
  for (const d of drafts) {
    const pub = published[d.profile.id];
    if (pub && d.exported && pub.hash === d.exported.hash) { retired.push(d.profile.name); continue; }
    const newer = pub && (!d.base || pub.version !== d.base.version);
    if (newer && !(d.conflict && d.conflict.hash === pub.hash)) {
      d.conflict = { version: pub.version, hash: pub.hash, dismissed: false };
      conflicts.push(d.profile.name);
    }
    list.push(d);
  }
  return { list, retired, conflicts };
}

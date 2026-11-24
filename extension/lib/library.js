// The forms library: field definitions, forms, page and fill profiles, all from one commit of the
// library repo. Library files are untrusted input: everything is validated here before use.
// Pure functions, no browser APIs (syncing lives in lib/library-sync.js).
//
// A stored set: { commit, message, syncedAt, files: { path: parsed JSON } }
//   fields.json          { schema: 'powerloader-fields/1', fields: { key: FieldDef }, identifierTypes: { category: { shape, pattern } } }
//   forms/{id}.json      { schema: 'powerloader-form/1', id, name, short, category, version, fields: [{ key, required }],
//                          rules?, fill?, confirmation?: { match, refPattern }, sideEffects?: [string] }
//   profiles/pages/…     extraction profiles (schema powerloader-profile/1, kind extract), field keys are case field keys
//   profiles/fill/…      fill profiles (kind fill), { selector: 'CaseData.key' }
//   privacy.json         detection patterns and categories (see lib/privacy-detect.js)
//   steps.json           the steps a case takes, page by page, with templated links (lib/journey.js)
//   timelines.json       timelines: series of bars and pointers from the case's dates (lib/journey.js)
import { validateFieldDefs } from './fields.js';
import { canonical } from './hash.js';
import { validatePrivacy } from './privacy-detect.js';
import { validateDocumentProfile } from './reader/match.js';
import { validateSteps, validateTimelines } from './journey.js';

const E = () => globalThis.PowerLoaderExtract;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function hostOf(pattern) {
  const m = /^(?:https?|\*):\/\/([^/]+)/.exec(String(pattern));
  return m ? m[1].toLowerCase() : null;
}

// Approved hosts are exact names or "*.example.gov.uk" for subdomains.
export function hostApproved(host, approved = []) {
  if (!host) return false;
  return approved.some((a) => {
    a = a.toLowerCase();
    if (a === host) return true;
    if (a.startsWith('*.') && !host.includes('*')) return host.endsWith(a.slice(1));
    return false;
  });
}

const patterns = (match) => (Array.isArray(match) ? match : match ? [match] : []);

export function validateForm(form, fields) {
  const errors = [];
  if (!isObj(form)) return ['Form must be a JSON object'];
  for (const k of ['id', 'name', 'version']) if (typeof form[k] !== 'string' || !form[k].trim()) errors.push(`"${k}" must be a non-empty string`);
  if (!Array.isArray(form.fields) || !form.fields.length) errors.push('"fields" must be a non-empty list');
  else {
    form.fields.forEach((f, i) => {
      if (!isObj(f) || typeof f.key !== 'string') errors.push(`fields[${i}] must be { key, required }`);
      else if (!fields[f.key]) errors.push(`fields[${i}]: "${f.key}" isn’t defined in fields.json`);
    });
  }
  for (const [i, r] of (form.rules || []).entries()) {
    const other = r?.before ?? r?.after;
    if (!isObj(r) || !fields[r.field] || (other !== 'today' && !fields[other])) errors.push(`rules[${i}] must be { field, before | after: field or "today", message }`);
  }
  if (form.confirmation !== undefined) {
    const cf = form.confirmation;
    if (!isObj(cf) || !patterns(cf.match).length || typeof cf.refPattern !== 'string') errors.push('"confirmation" must be { match, refPattern }');
    else try { new RegExp(cf.refPattern); } catch { errors.push('"confirmation.refPattern" is not a valid regex'); }
  }
  if (form.sideEffects !== undefined && !(Array.isArray(form.sideEffects) && form.sideEffects.every((s) => typeof s === 'string'))) errors.push('"sideEffects" must be a list of descriptions');
  return errors;
}

/**
 * Validate a page or fill profile from the library or a draft. On top of the engine's own validator:
 * an id and version, approved hosts only, no clicking, and a link pattern on an approved host.
 */
export function validateLibraryProfile(profile, { approvedHosts = [], fields = {} } = {}) {
  if (!isObj(profile)) return ['Profile must be a JSON object'];
  const errors = [...E().validateProfile(profile)];
  if (!['extract', 'fill', undefined].includes(profile.kind)) errors.push('"kind" must be "extract" or "fill"');
  if (typeof profile.id !== 'string' || !profile.id.trim()) errors.push('"id" must be a non-empty string');
  if (typeof profile.version !== 'string' || !/^v\d+$/.test(profile.version)) errors.push('"version" must look like v1, v2…');
  for (const m of patterns(profile.match)) if (!hostApproved(hostOf(m), approvedHosts)) errors.push(`"match" host ${hostOf(m) || m} isn’t on the approved systems list`);
  if (profile.urlPattern !== undefined) {
    if (typeof profile.urlPattern !== 'string') errors.push('"urlPattern" must be a string');
    else if (!hostApproved(hostOf(profile.urlPattern), approvedHosts)) errors.push('"urlPattern" host isn’t on the approved systems list');
  }
  if (profile.kind === 'fill') {
    // Filling sets values only. Row creation clicks page elements, so it is refused for the first release.
    if ((profile.lists || []).some((l) => l && l.add)) errors.push('Fill profiles can’t click: remove lists[].add');
    for (const [box, path] of Object.entries(profile.fields || {})) {
      const m = /^CaseData\.([A-Za-z][A-Za-z0-9_]*)$/.exec(String(path));
      if (!m) errors.push(`fields.${box}: map to "CaseData.<field>"`);
      else if (Object.keys(fields).length && !fields[m[1]]) errors.push(`fields.${box}: "${m[1]}" isn’t defined in fields.json`);
    }
  }
  return errors;
}

const kindOfPath = (p) => (p === 'fields.json' ? 'fields' : p === 'privacy.json' ? 'privacy' : p === 'steps.json' ? 'steps' : p === 'timelines.json' ? 'timelines' : p.startsWith('forms/') ? 'form'
  : p.startsWith('profiles/pages/') ? 'page' : p.startsWith('profiles/fill/') ? 'fill' : p.startsWith('profiles/documents/') ? 'document' : 'other');

/**
 * Index a stored set. Invalid forms and profiles are skipped and reported in `problems`, so a bad file
 * never reaches clipping or filling.
 */
export function indexLibrary(set, manifest = set.manifest || {}) {
  const problems = [];
  const fieldsDoc = set.files['fields.json'];
  const fieldErrors = validateFieldDefs(fieldsDoc?.fields);
  if (fieldErrors.length) problems.push({ path: 'fields.json', errors: fieldErrors });
  const fields = fieldErrors.length ? {} : fieldsDoc.fields;
  const approvedHosts = Array.isArray(manifest.approvedHosts) ? manifest.approvedHosts : [];
  const privacyErrors = validatePrivacy(set.files['privacy.json']);
  if (privacyErrors.length) problems.push({ path: 'privacy.json', errors: privacyErrors });
  const lib = {
    commit: set.commit, message: set.message || '', syncedAt: set.syncedAt || null, approvedHosts,
    fields, identifierTypes: fieldsDoc?.identifierTypes || {}, privacy: privacyErrors.length ? null : set.files['privacy.json'] || null,
    forms: {}, profiles: [], fill: [], documents: [], steps: [], timelines: [], problems,
  };
  for (const [path, doc] of Object.entries(set.files)) {
    const kind = kindOfPath(path);
    if (kind === 'form') {
      const errors = validateForm(doc, fields);
      if (errors.length) problems.push({ path, errors });
      else lib.forms[doc.id] = doc;
    } else if (kind === 'document') {
      const errors = validateDocumentProfile(doc, fields);
      if (errors.length) problems.push({ path, errors });
      else lib.documents.push({ ...doc, path });
    } else if (kind === 'page' || kind === 'fill') {
      const errors = validateLibraryProfile(doc, { approvedHosts, fields });
      if ((kind === 'fill') !== (doc?.kind === 'fill')) errors.push(`A profile under profiles/${kind === 'fill' ? 'fill' : 'pages'}/ must have kind "${kind === 'fill' ? 'fill' : 'extract'}"`);
      if (errors.length) problems.push({ path, errors });
      else (kind === 'fill' ? lib.fill : lib.profiles).push({ ...doc, path });
    }
  }
  // Steps and timelines refer to forms and profiles, so they are checked once those are indexed.
  if (set.files['steps.json'] !== undefined) {
    const doc = set.files['steps.json'];
    const errors = validateSteps(doc, fields);
    if (!errors.length) {
      doc.steps.forEach((s, i) => {
        if (s.role === 'output' && !lib.forms[s.formId]) errors.push(`steps[${i}]: form "${s.formId}" isn’t in the library`);
        if (s.role === 'input' && !lib.profiles.some((p) => p.id === s.profileId)) errors.push(`steps[${i}]: page profile "${s.profileId}" isn’t in the library`);
        for (const m of s.match || []) if (!hostApproved(hostOf(m), approvedHosts)) errors.push(`steps[${i}]: "match" host ${hostOf(m) || m} isn’t on the approved systems list`);
      });
    }
    if (errors.length) problems.push({ path: 'steps.json', errors });
    else lib.steps = doc.steps;
  }
  if (set.files['timelines.json'] !== undefined) {
    const doc = set.files['timelines.json'];
    const errors = validateTimelines(doc, fields);
    if (!errors.length) {
      doc.timelines.forEach((t, i) => t.series.forEach((s, j) => {
        if (s.source.group && !lib.profiles.some((p) => p.id === s.source.profile)) errors.push(`timelines[${i}].series[${j}]: page profile "${s.source.profile}" isn’t in the library`);
      }));
    }
    if (errors.length) problems.push({ path: 'timelines.json', errors });
    else lib.timelines = doc.timelines;
  }
  return lib;
}

export const formList = (lib) => Object.values(lib.forms).sort((a, b) => a.name.localeCompare(b.name));

// The fill profile for a form: the form names it, or the profile names the form.
export function fillProfileFor(lib, formId) {
  const form = lib.forms[formId];
  return lib.fill.find((p) => p.id === form?.fill) || lib.fill.find((p) => p.form?.id === formId) || null;
}

// Page profiles that may read this URL, specific ones (with a `when` test) first. Drafts in use replace
// the published profile they are based on.
export function pageProfiles(lib, url, drafts = []) {
  // Only a draft that passed its test, with nothing changed since, is used.
  const inUse = drafts.filter((d) => d.use && d.kind !== 'fill' && d.tested?.ok && d.tested.snapshot === canonical(d.profile));
  const replaced = new Set(inUse.map((d) => d.base?.id).filter(Boolean));
  const list = [...inUse.map((d) => ({ ...d.profile, draft: d.id })), ...lib.profiles.filter((p) => !replaced.has(p.id))];
  const hits = list.filter((p) => E().matchUrl(p.match, url));
  return [...hits.filter((p) => p.when), ...hits.filter((p) => !p.when)];
}

// Which form a confirmation page is for, and the reference it shows, if the library knows its pattern.
export function confirmationFor(lib, url, text) {
  for (const form of Object.values(lib.forms)) {
    const cf = form.confirmation;
    if (!cf || !E().matchUrl(cf.match, url)) continue;
    const m = new RegExp(cf.refPattern).exec(`${url}\n${text || ''}`);
    if (m) return { formId: form.id, ref: m[0] };
  }
  return null;
}

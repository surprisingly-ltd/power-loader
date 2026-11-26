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
//   steps.json           the steps a case takes, page by page, with templated links (lib/journey.js). Only in
//                        the set a flow compiles to: steps belong to a flow, so a team library's own is reported
//                        as a file it shouldn't have, and not read
//   timelines.json       timelines: series of bars and pointers from the case's dates (lib/journey.js)
//   access.json          site rules, locked or delegated to the caseworker (lib/access.js)
//   flows/…              flows the library offers, in the format Flows → Export writes (lib/flows.js): listed
//                        on the Flows tab, read-only, started or copied as an imported flow is
import { validateFieldDefs } from './fields.js';
import { validatePrivacy } from './privacy-detect.js';
import { validateDocumentProfile } from './reader/match.js';
import { validateSteps, validateTimelines } from './journey.js';
import { accessOf, globVerdict, validateAccess } from './access.js';
import { isFlowCommit, libraryFlowErrors } from './flows.js';

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

// Are a profile's match and link pattern on approved hosts? A tested draft is used only when they are:
// the library's own profiles are checked when it's indexed, and a draft mustn't get round that.
export function profileHostsApproved(profile, approvedHosts = []) {
  const pats = [...patterns(profile?.match), profile?.urlPattern].filter(Boolean);
  return pats.length > 0 && pats.every((p) => hostApproved(hostOf(p), approvedHosts));
}

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

const kindOfPath = (p) => (p === 'fields.json' ? 'fields' : p === 'privacy.json' ? 'privacy' : p === 'access.json' ? 'access' : p === 'steps.json' ? 'steps' : p === 'timelines.json' ? 'timelines' : p.startsWith('forms/') ? 'form'
  : p.startsWith('flows/') ? 'flow' : p.startsWith('profiles/pages/') ? 'page' : p.startsWith('profiles/fill/') ? 'fill' : p.startsWith('profiles/documents/') ? 'document' : 'other');

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
    forms: {}, profiles: [], fill: [], documents: [], steps: [], timelines: [], flows: [], problems, access: null,
  };
  // Site rules. A bad access.json is a problem like any other, so a sync keeps the last good library.
  if (set.files['access.json'] !== undefined) {
    const errors = validateAccess(set.files['access.json']);
    if (errors.length) problems.push({ path: 'access.json', errors });
    else lib.access = { ...accessOf(set.files['access.json']), doc: set.files['access.json'] };
  }
  for (const [path, doc] of Object.entries(set.files)) {
    const kind = kindOfPath(path);
    if (kind === 'form') {
      const errors = validateForm(doc, fields);
      if (errors.length) problems.push({ path, errors });
      else lib.forms[doc.id] = doc;
    } else if (kind === 'flow') {
      const errors = libraryFlowErrors(doc, approvedHosts);
      if (errors.length) problems.push({ path, errors });
      else lib.flows.push({ path, id: doc.id, name: String(doc.name || 'Flow'), guidance: String(doc.guidance || ''), doc });
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
  // Steps belong to a flow. A team's library (a set with a commit that isn't a flow's) has no steps of its own:
  // its steps.json is reported and not read. A flow's compiled files, checked with or without a commit, are.
  const teamLibrary = !!set.commit && !isFlowCommit(set.commit) && !set.flow;
  if (teamLibrary && set.files['steps.json'] !== undefined) {
    problems.push({ path: 'steps.json', errors: ['A library doesn’t have steps of its own: steps belong to a flow, so put them in a flow under flows/. This file isn’t read.'] });
  }
  // Steps and timelines refer to forms and profiles, so they are checked once those are indexed.
  if (!teamLibrary && set.files['steps.json'] !== undefined) {
    const doc = set.files['steps.json'];
    const errors = validateSteps(doc, fields);
    if (!errors.length) {
      doc.steps.forEach((s, i) => {
        if (s.role === 'output' && !lib.forms[s.formId]) errors.push(`steps[${i}]: form "${s.formId}" isn’t in the library`);
        if (s.role === 'input' && !lib.profiles.some((p) => p.id === s.profileId)) errors.push(`steps[${i}]: page profile "${s.profileId}" isn’t in the library`);
        for (const m of s.match || []) if (!hostApproved(hostOf(m), approvedHosts)) errors.push(`steps[${i}]: "match" host ${hostOf(m) || m} isn’t on the approved systems list`);
        if (s.role === 'fetch') for (const e of fetchIndexErrors(s, lib.profiles, approvedHosts)) errors.push(`steps[${i}]: ${e}`);
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

/**
 * A fetch step's requests against the library: each reads a page profile it has, on an approved host, and
 * its address (with sample values) is one that profile matches, so a request only fetches a page its profile
 * is for. Phase 1 fetches only from the trigger page's own site.
 */
export function fetchIndexErrors(step, profiles, approvedHosts) {
  const out = [];
  const trigger = (step.match || []).map((m) => /^(https?):\/\/([^/*]+)/i.exec(m)).find(Boolean);
  for (const [j, r] of (step.fetch?.requests || []).entries()) {
    const at = `requests[${j}]`;
    const p = profiles.find((x) => x.id === r.profileId);
    if (!p) { out.push(`${at}: page profile "${r.profileId}" isn’t in the library`); continue; }
    if (r.each) {
      // A list of links: the page with the links has its profile here, and that profile has the list, with an
      // href for each row. Each address is checked against p's match when the run reads the page.
      const lp = profiles.find((x) => x.id === r.each.profileId);
      if (!lp) { out.push(`${at}: page profile "${r.each.profileId}" isn’t in the library`); continue; }
      const spec = lp.fields?.[r.each.list];
      if (!Array.isArray(spec) || !(spec[1] && typeof spec[1] === 'object' && typeof spec[1].href === 'string')) out.push(`${at}: ${lp.name || lp.id} has no list "${r.each.list}" with an href for each row`);
      if (!patterns(p.match).every((m) => hostApproved(hostOf(m), approvedHosts))) out.push(`${at}: ${p.name || p.id} reads pages that aren’t on the approved systems list`);
      continue;
    }
    const host = hostOf(r.url);
    if (!hostApproved(host, approvedHosts)) { out.push(`${at}: host ${host || r.url} isn’t on the approved systems list`); continue; }
    const sample = String(r.url).replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g, 'sample1');
    if (!E().matchUrl(p.match, sample)) out.push(`${at}: the address doesn’t match its page profile ${p.name || p.id}`);
    if (trigger && `${trigger[1]}://${trigger[2]}`.toLowerCase() !== /^https?:\/\/[^/?#]*/i.exec(r.url)?.[0].toLowerCase()) out.push(`${at}: the address must be on the same site as the step’s page`);
  }
  return out;
}

export const formList = (lib) => Object.values(lib.forms).sort((a, b) => a.name.localeCompare(b.name));

// The fill profile for a form: the form names it, or the profile names the form.
export function fillProfileFor(lib, formId) {
  const form = lib.forms[formId];
  return lib.fill.find((p) => p.id === form?.fill) || lib.fill.find((p) => p.form?.id === formId) || null;
}

// Page profiles that may read this URL, specific ones (with a `when` test) first. A case's library is its
// flow's set, so a template changed in the flow is the one used: there are no drafts beside it.
export function pageProfiles(lib, url) {
  const list = lib.profiles;
  // A profile that reads JSON is read only by fetch steps in this version, never offered for a tab: an HTML
  // page never matches it (docs/plans/json-clips.md, JSON tabs are phase 2).
  // A fetch-only profile (fetchOnly: true) is read only by the fetch step that names it, never offered for a tab:
  // on a message page opened by hand, "Inbox message" (one row for a triage) isn't a choice.
  const hits = list.filter((p) => (p.format || 'html') === 'html' && !p.fetchOnly && E().matchUrl(p.match, url));
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

/**
 * Profiles, forms and pages to visit that the site rules block, judged by their patterns' fixed start (the
 * real address is checked again when Power Loader acts). Not part of indexLibrary()'s problems: indexing is
 * cached per commit, and the caseworker's rules change without the commit changing.
 * [{ path, id, kind: 'page' | 'fill' | 'form' | 'step', level: 'error' | 'warn', text }]
 */
export function accessIssues(lib, layers) {
  const out = [];
  if (!lib) return out;
  const check = (item, globs, action) => {
    for (const g of globs) {
      const v = globVerdict(layers, g, action);
      if (v.verdict === 'blocked') { out.push({ ...item, level: 'error', text: `Power Loader can’t work on ${item.name}: the site rules block ${g}` }); return; }
      if (v.verdict === 'some') { out.push({ ...item, level: 'warn', text: `Some pages ${item.name} matches are blocked by the site rules` }); return; }
    }
  };
  for (const p of lib.profiles) check({ path: p.path, id: p.id, kind: 'page', name: p.name }, [p.urlPattern, ...patterns(p.match)].filter(Boolean), 'read');
  for (const p of lib.fill) check({ path: p.path, id: p.id, kind: 'fill', name: p.name, formId: p.form?.id }, patterns(p.match), 'fill');
  for (const f of Object.values(lib.forms)) if (f.url) check({ path: `forms/${f.id}.json`, id: f.id, kind: 'form', name: f.name, formId: f.id }, [f.url], 'fill');
  for (const s of lib.steps || []) if (s.role === 'guide' && s.url) check({ path: 'steps.json', id: s.id, kind: 'step', name: s.name }, [s.url], 'navigate');
  return out;
}

/** Forms the site rules stop Power Loader filling: { formId: text }. */
export function blockedForms(lib, layers) {
  const out = {};
  for (const i of accessIssues(lib, layers)) if (i.level === 'error' && i.formId) out[i.formId] = out[i.formId] || i.text;
  return out;
}

#!/usr/bin/env node
// Policy files: check one, explain it in plain English, and try addresses and settings against it. It imports
// the extension's own policy reader and site-rule engine (extension/lib/policy.js, lib/access.js), so what it
// says is what the extension does. See docs/organisation-builds.md and .claude/skills/policy-file/SKILL.md.
//
//   node tools/policy.mjs check <file>                         problems (exit 1) and warnings
//   node tools/policy.mjs explain <file>                       what a build with this file will and won't do
//   node tools/policy.mjs try <file> <url> [action]            what the rules decide for one address
//   node tools/policy.mjs try <file> --setting <key> <value>   whether a setting may take this value
//   node tools/policy.mjs try <file> --expect <cases.json>     run a list of expected decisions (exit 1 on a miss)
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ACTIONS, CLOSED, PAGE_ACTIONS, accessLayers, allowed as decide, describePattern, matchesAny, parsePattern, patternError, policyLayer, readUrl, ruleErrors,
} from '../extension/lib/access.js';
import {
  ALLOWED_ADDRESSES, ALLOWED_SETTINGS, POLICY_DEFAULTS, POLICY_SCHEMA, isDefaultPolicyFile, matchesAllowed, resolvePolicy,
} from '../extension/lib/policy.js';
import { DEFAULT_ASSIST_MODEL, DEFAULT_MODEL } from '../extension/lib/model-fetch.js';
import { OTHER_SWITCHES, TOOLS, TOOL_NAMES, toolState } from '../extension/lib/tools.js';
import { clearsAfter, hoursError, hoursText } from '../extension/lib/teardown.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const TOP = ['schema', 'name', 'build', 'policy'];
const BUILD_KEYS = ['id', 'updateUrl', 'hosts'];
const PUBLIC_ID = /@surprisingly\.ltd$/i;
const PUBLIC_HOST = /(^|\.)surprisingly\.ltd$/i;
// Keys that hold a secret, wherever they are in the file.
const SECRET_KEY = /^(token|apikey|api_key|key|password|secret|credential|bearer)$/i;

/** Every leaf key of POLICY_DEFAULTS, dotted. */
export function policyKeyList(defaults = POLICY_DEFAULTS, prefix = '') {
  return Object.entries(defaults).flatMap(([k, v]) => (isObj(v) ? policyKeyList(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
}

function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1));
  return d[a.length][b.length];
}
/** The nearest of these names, if it's near enough to be a typing mistake. */
export function nearest(name, names) {
  let best = null;
  for (const n of names) {
    const d = distance(name, n);
    if (!best || d < best.d) best = { n, d };
  }
  return best && best.d <= Math.max(2, Math.floor(name.length / 3)) ? best.n : null;
}
const unknown = (what, key, names) => { const n = nearest(key, names); return `${what} ${key} isn’t known${n ? `. Did you mean ${n}?` : ''}`; };

// ------------------------------------------------------------------ build.hosts

/** A Firefox match pattern's problem, or null. build.hosts takes match patterns: scheme://host/path. */
export function hostPatternError(p) {
  if (p === '<all_urls>') return null;
  if (typeof p !== 'string') return 'must be text';
  const m = /^(\*|https?):\/\/(\*|\*\.[^/*:]+|[^/*:]+)(\/.*)$/.exec(p);
  if (!m) return 'must be a match pattern such as *://*.example.gov.uk/*';
  return patternError(p);
}
const hostParsed = (p) => (p === '<all_urls>' ? { schemes: ['http', 'https'], host: null, subdomains: false } : parsePattern(p));

/** Is every address a pattern can match inside one of the host patterns? (Hosts and schemes; paths ignored.) */
export function patternCovered(pattern, hosts) {
  let a;
  try { a = parsePattern(pattern); } catch { return false; }
  return hosts.some((h) => {
    let b;
    try { b = hostParsed(h); } catch { return false; }
    if (!a.schemes.every((s) => b.schemes.includes(s))) return false;
    if (b.host === null) return true;
    if (a.host === null) return false;
    return b.subdomains ? a.host === b.host || a.host.endsWith(`.${b.host}`) : !a.subdomains && a.host === b.host;
  });
}
/** May a build with these hosts connect to this address? */
export const urlCovered = (url, hosts) => !!readUrl(url) && hosts.some((h) => h === '<all_urls>' || matchesAny([h], url));

// ------------------------------------------------------------------ reading a file

export function readPolicyFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  try { return JSON.parse(text); } catch (e) { throw new Error(`${file} isn’t valid JSON: ${e.message}`); }
}

// The address each fixed setting is checked as, when a request is sent.
const requestAddress = (setting, value) => {
  if (setting === 'gateway.baseUrl') return `${String(value).replace(/\/+$/, '')}/chat/completions`;
  if (setting === 'library.baseUrl') return String(value).replace('{ref}', 'main');
  return String(value);
};
const get = (o, dotted) => dotted.split('.').reduce((v, k) => (isObj(v) ? v[k] : undefined), o);

/**
 * Check a policy file: { errors, warnings }. forBuild: the file is meant for an organisation build (any file
 * other than the default), so build.id and updateUrl are required and secrets are refused.
 */
export function checkPolicy(doc) {
  const errors = [];
  const warnings = [];
  if (!isObj(doc)) return { errors: ['The file must be a JSON object'], warnings };
  if (doc.schema !== POLICY_SCHEMA) errors.push(`schema must be "${POLICY_SCHEMA}"`);
  for (const k of Object.keys(doc)) if (!TOP.includes(k)) errors.push(unknown('The top-level key', k, TOP));
  if (doc.name !== undefined && doc.name !== null && (typeof doc.name !== 'string' || !doc.name.trim() || doc.name.length > 80)) errors.push('name must be your organisation’s name, up to 80 characters');
  const isDefault = isDefaultPolicyFile(doc);
  const policy = doc.policy ?? {};
  if (!isObj(policy)) errors.push('policy must be an object');

  // build
  const build = doc.build ?? {};
  const hosts = Array.isArray(build.hosts) ? build.hosts : null;
  if (!isObj(build)) errors.push('build must be an object');
  else {
    for (const k of Object.keys(build)) if (!BUILD_KEYS.includes(k)) errors.push(unknown('build key', k, BUILD_KEYS));
    if (!isDefault) {
      if (!doc.name) errors.push('name is needed: Settings shows “Rules built in by” your organisation’s name');
      if (typeof build.id !== 'string' || !/^([A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\{[0-9a-fA-F-]{36}\})$/.test(build.id)) errors.push('build.id must be your own add-on id, such as powerloader@example.gov.uk');
      else if (PUBLIC_ID.test(build.id)) errors.push('build.id is Surprisingly’s: an organisation build needs its own id, under a domain you control');
      let u = null;
      try { u = new URL(build.updateUrl); } catch { errors.push('build.updateUrl must be the https address of your updates.json'); }
      if (u && u.protocol !== 'https:') errors.push('build.updateUrl must use https');
      if (u && PUBLIC_HOST.test(u.hostname)) errors.push('build.updateUrl is Surprisingly’s: an organisation build updates from your own server');
    }
    if (build.hosts !== undefined) {
      if (!hosts || !hosts.length) errors.push('build.hosts must be a list of match patterns, or left out');
      else for (const h of hosts) { const e = hostPatternError(h); if (e) errors.push(`build.hosts ${String(h).slice(0, 80)}: ${e}`); }
      if (hosts?.includes('<all_urls>')) warnings.push('build.hosts includes <all_urls>: Firefox grants every site at install. Leave build.hosts out to keep asking site by site.');
    }
  }

  // policy keys, as lib/policy.js reads them
  const known = [...policyKeyList(), ...Object.keys(POLICY_DEFAULTS)];
  const walk = (given, defaults, prefix) => {
    for (const [k, v] of Object.entries(given)) {
      const path = `${prefix}${k}`;
      if (path === 'allowed') continue;
      if (!(k in defaults)) { errors.push(unknown('The policy key', path, known)); continue; }
      const d = defaults[k];
      if (isObj(d)) { if (isObj(v)) walk(v, d, `${path}.`); else errors.push(`${path} must be an object`); continue; }
      const type = (x) => (Array.isArray(x) ? 'array' : x === null ? 'null' : typeof x);
      if (d !== null && v !== null && type(v) !== type(d)) errors.push(`${path} must be ${type(d) === 'array' ? 'a list' : `a ${type(d)}`}`);
    }
  };
  if (isObj(policy)) walk(policy, POLICY_DEFAULTS, '');

  // no secrets
  const secrets = [];
  const scan = (o, prefix) => {
    if (Array.isArray(o)) o.forEach((v, i) => scan(v, `${prefix}[${i}]`));
    else if (isObj(o)) for (const [k, v] of Object.entries(o)) { if (SECRET_KEY.test(k) && v !== null && v !== '') secrets.push(`${prefix}${k}`); scan(v, `${prefix}${k}.`); }
    else if (typeof o === 'string' && /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]*:[^/@\s]*@/i.test(o)) secrets.push(`${prefix.replace(/\.$/, '')} (an address with a password in it)`);
  };
  scan(doc, '');
  for (const s of secrets) errors.push(`${s} looks like a secret. A built-in policy file can’t hold one: anyone with the package can read it. A private library is read with the caseworker’s own sign-in (library.auth "cookies").`);

  // values Power Loader checks on its own terms
  const lib = policy.library || {};
  if (lib.auth !== undefined && !['none', 'token', 'cookies'].includes(lib.auth)) errors.push('library.auth must be none, token or cookies');
  if (lib.auth === 'token') errors.push('library.auth "token" needs a token, which a built-in policy file can’t hold. Use "cookies" for a private library.');
  for (const [k, v] of Object.entries(isObj(policy.tools) ? policy.tools : {})) {
    if (TOOL_NAMES.includes(k) && v !== null && typeof v !== 'boolean') errors.push(`tools.${k} must be true or false`);
  }
  const ws = policy.workstation || {};
  for (const k of ['clearCaseAfterHours', 'clearCaseMaxHours']) {
    const v = ws[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'number' || v < 0 || (v > 0 && v < 0.5) || Math.round(v * 2) !== v * 2) errors.push(`workstation.${k} must be a number of hours in halves, such as 4 or 0.5${k === 'clearCaseAfterHours' ? ', or 0 for never' : ''}`);
    else if (k === 'clearCaseMaxHours' && v === 0) errors.push('workstation.clearCaseMaxHours must be at least 0.5: leave it out for no limit');
  }
  if (typeof ws.clearCaseAfterHours === 'number' && typeof ws.clearCaseMaxHours === 'number' && (ws.clearCaseAfterHours === 0 || ws.clearCaseAfterHours > ws.clearCaseMaxHours)) {
    warnings.push(`workstation.clearCaseAfterHours (${ws.clearCaseAfterHours || 'never'}) is above workstation.clearCaseMaxHours (${ws.clearCaseMaxHours}). The fixed value wins, so the maximum does nothing.`);
  }
  if (typeof ws.clearCaseAfterHours === 'number' && ws.clearCaseAfterHours > 9) warnings.push(`workstation.clearCaseAfterHours is ${ws.clearCaseAfterHours} hours. Most organisations will want no more than 9 hours, and many will want less.`);
  if (lib.syncMinutes !== undefined && lib.syncMinutes !== null && (!Number.isInteger(lib.syncMinutes) || lib.syncMinutes < 0)) errors.push('library.syncMinutes must be a whole number of minutes, 0 for off');
  else if (lib.syncMinutes > 0 && lib.syncMinutes < 15) warnings.push('library.syncMinutes is under 15: Power Loader syncs every 15 minutes at most');
  for (const setting of ALLOWED_ADDRESSES) {
    const v = get(policy, setting);
    if (v === undefined || v === null) continue;
    try {
      const u = new URL(requestAddress(setting, v));
      if (u.protocol !== 'https:') errors.push(`${setting} must use https`);
    } catch { errors.push(`${setting} isn’t a full address`); }
  }

  // site rules
  if (isObj(policy.siteAccess)) {
    const layer = policyLayer(policy.siteAccess);
    if (layer.broken) errors.push(`siteAccess: ${layer.broken} can’t be read, so Power Loader would work nowhere`);
    (Array.isArray(policy.siteAccess.rules) ? policy.siteAccess.rules : []).forEach((r, i) => {
      for (const e of ruleErrors({ id: `rule-${i + 1}`, ...r })) errors.push(`siteAccess.rules[${i}] ${e}`);
    });
    for (const k of ['allow', 'deny']) for (const p of [policy.siteAccess[k] ?? []].flat()) { const e = patternError(p); if (e) errors.push(`siteAccess.${k} ${String(p).slice(0, 80)}: ${e}`); }
  }

  // allowed
  const allowedDoc = policy.allowed;
  if (allowedDoc !== undefined && allowedDoc !== null) {
    if (!isObj(allowedDoc)) errors.push('allowed must map a setting to a list of patterns');
    else for (const [setting, list] of Object.entries(allowedDoc)) {
      if (!ALLOWED_SETTINGS.includes(setting)) { errors.push(unknown('allowed setting', setting, ALLOWED_SETTINGS)); continue; }
      if (!Array.isArray(list) || !list.length || !list.every((p) => typeof p === 'string' && p.trim())) { errors.push(`allowed.${setting} must be a list of ${setting === 'gateway.model' ? 'model names' : 'patterns'}`); continue; }
      if (setting === 'gateway.model') continue;
      for (const p of list) {
        const e = patternError(p);
        if (e) { errors.push(`allowed.${setting} ${p.slice(0, 80)}: ${e}`); continue; }
        if (!p.startsWith('https://') && !/^\w+:\/\/(localhost|127\.0\.0\.1)/.test(p)) warnings.push(`allowed.${setting} ${p}: Power Loader only uses https here, so http addresses never match`);
        if (/huggingface\.co/.test(p) && setting.endsWith('.baseUrl')) warnings.push(`allowed.${setting} ${p}: Hugging Face redirects model files to its CDN, which this pattern must also cover. A mirror (filesUrl) avoids it.`);
      }
      const fixed = get(policy, setting);
      if (fixed !== undefined && fixed !== null && !matchesAllowed(setting, list, setting === 'gateway.model' ? fixed : requestAddress(setting, fixed))) {
        errors.push(`${setting} is fixed to a value its own allowed patterns refuse`);
      }
    }
  }

  // build.hosts covers everything the policy fixes or allows
  if (hosts && !errors.some((e) => e.startsWith('build.hosts'))) {
    for (const setting of ALLOWED_ADDRESSES) {
      const v = get(policy, setting);
      if (v !== undefined && v !== null && !urlCovered(requestAddress(setting, v), hosts)) errors.push(`${setting} is outside build.hosts, so the build couldn’t connect to it`);
      for (const p of (isObj(allowedDoc) && Array.isArray(allowedDoc[setting]) ? allowedDoc[setting] : [])) {
        if (!patternError(p) && !patternCovered(p, hosts)) errors.push(`allowed.${setting} ${p} reaches outside build.hosts`);
      }
    }
    const resolved = resolvePolicy(doc);
    const v = resolved.values;
    const open = (model) => !v[model].filesUrl && !v[model].baseUrl && !(v.allowed && (v.allowed[`${model}.filesUrl`] || v.allowed[`${model}.baseUrl`]));
    if (v.privacyModel.use !== false && open('privacyModel') && !urlCovered(DEFAULT_MODEL.baseUrl, hosts)) {
      warnings.push('The privacy model downloads from huggingface.co by default, which build.hosts doesn’t cover. Set privacyModel.filesUrl to your own mirror, or privacyModel.use to false.');
    }
    if (v.assistModel.enabled !== false && open('assistModel') && !v.privacyModel.baseUrl && !urlCovered(DEFAULT_ASSIST_MODEL.baseUrl, hosts)) {
      warnings.push('The profile assistant downloads from huggingface.co by default, which build.hosts doesn’t cover. Set assistModel.filesUrl to your own mirror, or assistModel.enabled to false.');
    }
    // Wider than the site rules: Power Loader may connect there but works on none of it.
    const pageAllows = policyLayer(policy.siteAccess || {}).rules.filter((r) => r.effect === 'allow' && (!r.actions || r.actions.some((a) => PAGE_ACTIONS.includes(a))));
    if (pageAllows.length) {
      // Power Loader's own infrastructure (library, gateway, models) is outside the site rules: it may connect there.
      const origin = (a) => { try { const u = new URL(a); return `${u.protocol}//${u.hostname}/*`; } catch { return null; } };
      const infra = ALLOWED_ADDRESSES.flatMap((s) => [origin(requestAddress(s, get(policy, s) ?? '')), ...(isObj(allowedDoc) && Array.isArray(allowedDoc[s]) ? allowedDoc[s] : [])]).filter(Boolean);
      const within = [...pageAllows.map((r) => r.pattern), ...infra].filter((p) => !patternError(p));
      for (const h of hosts) {
        if (h !== '<all_urls>' && !within.some((p) => patternCovered(h, [p]))) warnings.push(`build.hosts ${h} is wider than what the site rules let Power Loader work on. It may connect there (Firefox grants it), but it works only where the rules allow.`);
      }
    }
  }
  return { errors, warnings };
}

// ------------------------------------------------------------------ explain

const lower = (t) => t.charAt(0).toLowerCase() + t.slice(1);
const list = (items) => (items.length ? items.map((i) => `  - ${i}`).join('\n') : '  - nothing');
const fixedOrAllowed = (v, locked, setting, what) => {
  const a = v.allowed?.[setting];
  if (locked.has(setting)) return `${what} is fixed to ${get(v, setting)}.`;
  if (a) return `${what}: the caseworker may choose any address matching ${a.join(' or ')}.`;
  return `${what}: the caseworker chooses it.`;
};

/** What a build with this file will and won't do, in plain English, for the organisation's security team. */
export function explainPolicy(doc) {
  const p = resolvePolicy(doc);
  const { values: v, locked } = p;
  const hosts = Array.isArray(doc.build?.hosts) ? doc.build.hosts : null;
  const out = [];
  if (!p.builtIn) {
    out.push('This is the default file. It sets nothing: the build behaves as the public Power Loader does, and reads managed storage (Firefox policies.json) for any rules.');
    return out.join('\n');
  }
  out.push(`Power Loader, with rules built in by ${p.builtIn.name}.`);
  out.push(`Add-on id ${doc.build?.id || '(missing)'}; updates from ${doc.build?.updateUrl || '(missing)'}.`);
  out.push('Firefox policies.json (managed storage) is ignored. To change these rules, ship a new version.');
  out.push('');
  out.push('May connect to (enforced by Firefox):');
  if (hosts) {
    out.push(list(hosts.map((h) => (h === '<all_urls>' ? 'every site' : describePattern(h)))));
    out.push('  Firefox grants these when the extension is installed, so it never asks site by site. Nothing outside them can be granted, and the extension’s own pages can’t connect outside them.');
  } else out.push('  - any site, each granted only when the caseworker allows it in Firefox’s own prompt.');
  out.push('');
  out.push('Works on (the site rules, checked by Power Loader itself):');
  const layer = policyLayer(v.siteAccess);
  const allows = layer.rules.filter((r) => r.effect === 'allow');
  const denies = layer.rules.filter((r) => r.effect === 'deny');
  const acts = (r) => (r.actions ? ` (${r.actions.join(', ')})` : '');
  out.push(allows.length ? list(allows.map((r) => `only ${lower(describePattern(r.pattern))}${acts(r)}`)) : '  - any page the library’s and the caseworker’s rules allow');
  if (denies.length) out.push(list(denies.map((r) => `never ${lower(describePattern(r.pattern))}${acts(r)}`)));
  const postOpen = allows.some((r) => r.actions?.includes('fetch-post'));
  const postDenied = denies.some((r) => !r.actions || r.actions.includes('fetch-post'));
  out.push(`  Background POST requests (fetch steps): ${postDenied ? 'never.' : postOpen ? 'only where an allow rule names fetch-post.' : 'only where a library rule names fetch-post.'}`);
  if (v.siteAccess.backgroundReading === false) out.push('  Reading pages in the background: off, and locked.');
  if (v.siteAccess.lockLibraryRules) out.push('  Every rule in the library’s access.json is locked.');
  out.push('  It reads a page only when the page is in the active flow, or while the caseworker builds a flow.');
  out.push('');
  out.push('Remote AI:');
  if (v.gateway.enabled === false) out.push('  - off, and locked off. Nothing is sent to a remote AI.');
  else {
    out.push(`  - ${fixedOrAllowed(v, locked, 'gateway.baseUrl', 'The endpoint')}`);
    const models = v.allowed?.['gateway.model'];
    out.push(`  - ${locked.has('gateway.model') ? `The model is fixed to ${v.gateway.model}.` : models ? `The model may be ${models.join(' or ')}.` : 'The caseworker chooses the model.'}`);
    out.push('  - Each caseworker still enters a key and agrees to what is sent. Nothing is sent until they check a preview with personal data replaced.');
  }
  out.push('');
  out.push('Forms library:');
  out.push(`  - ${fixedOrAllowed(v, locked, 'library.baseUrl', 'The address')}`);
  out.push(`  - Read ${v.library.auth === 'cookies' ? 'with the caseworker’s own sign-in (cookies)' : 'without signing in'}.`);
  out.push(`  - ${v.library.syncMinutes ? `Syncs at start and every ${v.library.syncMinutes} minutes.` : 'Syncs at start and when the sidebar opens; the timed sync is off.'}`);
  if (v.library.pinCommit) out.push(`  - Pinned to commit ${v.library.pinCommit}.`);
  out.push('');
  out.push('On-device models:');
  if (v.privacyModel.use === false) out.push('  - The privacy model is off, and locked off.');
  else out.push(`  - Privacy model: ${v.privacyModel.filesUrl ? `from ${v.privacyModel.filesUrl}` : v.privacyModel.baseUrl ? `from ${v.privacyModel.baseUrl}` : v.allowed?.['privacyModel.filesUrl'] || v.allowed?.['privacyModel.baseUrl'] ? `from an address matching ${[...(v.allowed['privacyModel.filesUrl'] || []), ...(v.allowed['privacyModel.baseUrl'] || [])].join(' or ')}` : 'from Hugging Face, unless the caseworker or library names a mirror'}. Every file is checked against its pinned hash.`);
  out.push(`  - Profile assistant: ${v.assistModel.enabled === false ? 'off.' : v.assistModel.filesUrl ? `from ${v.assistModel.filesUrl}.` : 'follows the privacy model’s server, or Hugging Face.'}`);
  out.push('');
  out.push('Tools:');
  out.push(list(TOOL_NAMES.map((t) => {
    const s = toolState(p, {}, t);
    return `${TOOLS[t].label}: ${s.locked ? (s.on ? 'on, and caseworkers can’t turn it off' : 'off, and caseworkers can’t turn it on') : 'on, unless the caseworker turns it off'}.`;
  })));
  out.push(`  Switched elsewhere: ${OTHER_SWITCHES.map((o) => o.label).join('; ')}.`);
  out.push(`  ${captureLine(doc, p)}`);
  out.push('');
  out.push('Case data:');
  out.push(`  - ${locked.has('workstation.clearCaseOnClose') ? (v.workstation.clearCaseOnClose ? 'The open case is deleted when Firefox closes. Caseworkers can’t turn this off.' : 'The open case is kept when Firefox closes. Caseworkers can’t change this.') : 'The open case is deleted when Firefox closes, unless the caseworker turns that off in Settings.'}`);
  const after = clearsAfter(p, {});
  out.push(`  - ${after.locked ? (after.hours ? `It is also deleted after ${hoursText(after.hours)} without use. Caseworkers can’t change this.` : 'It is never deleted for being left without use. Caseworkers can’t change this.')
    : after.max ? `It is also deleted after ${hoursText(after.hours)} without use, unless the caseworker chooses a shorter time; they can’t choose more than ${hoursText(after.max)}, or never.`
      : `It is also deleted after ${hoursText(after.hours)} without use, unless the caseworker changes that in Settings, to any time or never.`}`);
  const shown = new Set(['gateway.baseUrl', 'gateway.model', 'gateway.enabled', 'library.baseUrl', 'library.auth', 'library.syncMinutes', 'library.pinCommit', 'workstation.clearCaseOnClose', 'workstation.clearCaseAfterHours', 'workstation.clearCaseMaxHours', 'privacyModel.filesUrl', 'privacyModel.baseUrl', 'privacyModel.use', 'assistModel.enabled', 'assistModel.filesUrl', 'siteAccess.allow', 'siteAccess.deny', 'siteAccess.rules', 'siteAccess.backgroundReading', 'siteAccess.lockLibraryRules', ...TOOL_NAMES.map((t) => `tools.${t}`)]);
  const others = [...locked].filter((k) => !shown.has(k)).sort();
  if (others.length) { out.push(''); out.push('Also set, and locked:'); out.push(list(others.map((k) => `${k}: ${JSON.stringify(get(v, k))}`))); }
  out.push('');
  out.push('What the build doesn’t promise:');
  out.push(list([
    'The site rules are checked by Power Loader’s own code. They guard against mistaken and poisoned flows, not against a determined caseworker.',
    'Fetch steps run in the page’s own tab and only fetch from that page’s site, so the connect limit doesn’t cover them; the site rules and the host permission do.',
    'Someone allowed to install other add-ons could install the public Power Loader. Stopping that is the job of Firefox’s browser policy.',
    'Anyone with the package can read this file, so it holds no secrets.',
  ]));
  return out.join('\n');
}

// ------------------------------------------------------------------ try

/** The policy layer's decision for an address: [{ action, ok, by, hosts }]. Library and caseworker rules can only narrow it. */
export function tryAddress(doc, url, actions = ACTIONS) {
  const policy = resolvePolicy(doc);
  const layers = accessLayers({ policy });
  const hosts = Array.isArray(doc.build?.hosts) ? doc.build.hosts : null;
  const covered = hosts ? urlCovered(url, hosts) : true;
  return actions.map((action) => {
    const v = decide(layers, url, action);
    const by = v.broken ? 'a policy rule that can’t be read' : v.rule?.id ? `rule ${v.rule.id}` : v.rule ? 'no allow rule matches' : CLOSED.has(action) && !v.ok ? 'fetch-post needs an allow rule that names it' : null;
    return { action, ok: v.ok && covered, rules: v.ok, hosts: covered, by };
  });
}

/** What the build can capture, and why its permission is there. */
export function captureLine(doc, policy = resolvePolicy(doc)) {
  const hosts = Array.isArray(doc.build?.hosts) ? doc.build.hosts : null;
  const lockedOff = (t) => toolState(policy, {}, t).locked && !toolState(policy, {}, t).on;
  if (lockedOff('capture') || lockedOff('reader')) return `Selecting a region of the screen is off (${lockedOff('capture') ? 'tools.capture' : 'tools.reader'} is false): the build has no permission to capture the screen.`;
  if (!hosts) return 'Selecting a region of the screen asks Firefox for permission for every site (<all_urls>) the first time it is used, as the public build does. The site rules’ capture action decides which pages.';
  if (hosts.includes('<all_urls>')) return 'Selecting a region of the screen uses the <all_urls> permission in build.hosts. The site rules’ capture action decides which pages.';
  return 'Selecting a region of the screen uses Firefox’s activeTab permission: Firefox lets Power Loader capture a tab only when the caseworker chooses “Select a region with Power Loader” on the page’s right-click menu or presses its shortcut (Alt+Shift+R), and only that tab, until it moves to another page. It grants no lasting access to any site. While it lasts, Firefox would also let Power Loader run on that tab; Power Loader uses it only to draw the box and capture it, and the site rules’ capture action decides which pages.';
}

/** May a setting take this value? { ok, why }. */
export function trySetting(doc, setting, value) {
  const policy = resolvePolicy(doc);
  if (setting === 'workstation.clearCaseAfterHours') {
    const fixed = clearsAfter(policy, {});
    if (fixed.locked) return Number(value) === fixed.hours ? { ok: true, why: 'it is the fixed value' } : { ok: false, why: `it is fixed to ${fixed.hours ? hoursText(fixed.hours) : 'never'}` };
    const err = hoursError(policy, value);
    return err ? { ok: false, why: err.charAt(0).toLowerCase() + err.slice(1) } : { ok: true, why: 'the caseworker may choose it' };
  }
  if (!ALLOWED_SETTINGS.includes(setting)) return { ok: false, why: unknown('setting', setting, ALLOWED_SETTINGS) };
  if (setting.startsWith('gateway.') && policy.values.gateway.enabled === false) return { ok: false, why: 'the remote AI is turned off' };
  if (policy.locked.has(setting)) {
    const fixed = get(policy.values, setting);
    return fixed === value ? { ok: true, why: 'it is the fixed value' } : { ok: false, why: `it is fixed to ${fixed}` };
  }
  const list = policy.values.allowed?.[setting];
  const address = setting === 'gateway.model' ? value : requestAddress(setting, value);
  if (list && !matchesAllowed(setting, list, address)) return { ok: false, why: `it matches none of ${list.join(', ')}` };
  const hosts = Array.isArray(doc.build?.hosts) ? doc.build.hosts : null;
  if (setting !== 'gateway.model' && hosts && !urlCovered(address, hosts)) return { ok: false, why: 'it is outside build.hosts' };
  return { ok: true, why: list ? 'it matches an allowed pattern' : 'the policy doesn’t constrain it' };
}

/**
 * Run expectations: [{ url, action, allowed }] and [{ setting, value, allowed }]. Resolves the misses, each with
 * what was expected and what the rules decided.
 */
export function runExpectations(doc, cases) {
  if (!Array.isArray(cases)) throw new Error('The expectations must be a list');
  const misses = [];
  for (const c of cases) {
    if (c.tool) {
      const on = toolState(resolvePolicy(doc), {}, c.tool).on;
      if (!TOOL_NAMES.includes(c.tool)) misses.push({ case: c, got: null, why: `${c.tool} isn’t a tool` });
      else if (on !== c.on) misses.push({ case: c, got: on, why: on ? 'on' : 'off' });
    } else if (c.setting) {
      const r = trySetting(doc, c.setting, c.value);
      if (r.ok !== c.allowed) misses.push({ case: c, got: r.ok, why: r.why });
    } else {
      if (!ACTIONS.includes(c.action)) { misses.push({ case: c, got: null, why: `${c.action} isn’t an action` }); continue; }
      const [r] = tryAddress(doc, c.url, [c.action]);
      if (r.ok !== c.allowed) misses.push({ case: c, got: r.ok, why: r.ok ? 'allowed' : !r.hosts ? 'outside build.hosts' : r.by });
    }
  }
  return misses;
}

// ------------------------------------------------------------------ command line

function main(argv) {
  const [cmd, file, ...rest] = argv;
  const usage = 'Usage: node tools/policy.mjs check|explain <file> | try <file> <url> [action] | try <file> --setting <key> <value> | try <file> --expect <cases.json>';
  if (!cmd || !file || !['check', 'explain', 'try'].includes(cmd)) { console.error(usage); return 2; }
  const doc = readPolicyFile(file);
  if (cmd === 'check') {
    const { errors, warnings } = checkPolicy(doc);
    for (const e of errors) console.log(`✗ ${e}`);
    for (const w of warnings) console.log(`! ${w}`);
    console.log(errors.length ? `${file}: ${errors.length} problem${errors.length === 1 ? '' : 's'}.` : `${file}: no problems${warnings.length ? `, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : ''}.`);
    return errors.length ? 1 : 0;
  }
  if (cmd === 'explain') { console.log(explainPolicy(doc)); return 0; }
  if (rest[0] === '--setting') {
    const [, setting, value] = rest;
    const r = trySetting(doc, setting, value);
    console.log(`${setting} = ${value}: ${r.ok ? 'allowed' : 'refused'}, because ${r.why}.`);
    return 0;
  }
  if (rest[0] === '--expect') {
    const cases = JSON.parse(fs.readFileSync(rest[1], 'utf8'));
    const misses = runExpectations(doc, cases);
    for (const m of misses) console.log(m.case.tool ? `✗ tool ${m.case.tool}: expected ${m.case.on ? 'on' : 'off'}, got ${m.why}` : `✗ ${m.case.setting ? `${m.case.setting} = ${m.case.value}` : `${m.case.action} ${m.case.url}`}: expected ${m.case.allowed ? 'allowed' : 'refused'}, got ${m.got ? 'allowed' : 'refused'} (${m.why})`);
    console.log(`${cases.length - misses.length}/${cases.length} expectations hold.`);
    return misses.length ? 1 : 0;
  }
  const [url, action] = rest;
  if (!url) { console.error(usage); return 2; }
  if (action && !ACTIONS.includes(action)) { console.error(`${action} isn’t an action: ${ACTIONS.join(', ')}`); return 2; }
  for (const r of tryAddress(doc, url, action ? [action] : ACTIONS)) {
    console.log(`${r.ok ? '✓' : '✗'} ${r.action.padEnd(10)} ${r.ok ? 'allowed' : `refused: ${!r.hosts ? 'outside build.hosts (may connect to)' : r.by}`}`);
  }
  console.log('These are the organisation’s rules. The library’s and the caseworker’s rules can only narrow them.');
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) process.exitCode = main(process.argv.slice(2));

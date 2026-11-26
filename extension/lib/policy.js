// The organisation's policy. It comes from one of two places, never both:
//   - the policy file built into the package (extension/policy.json). The repo's own file sets nothing; an
//     organisation build swaps in its own (tools/build-ext.mjs --policy, docs/organisation-builds.md).
//   - managed storage (Firefox policies.json, "3rdparty" → "Extensions" → this id), read only when the built-in
//     file is the default. An organisation build ignores it: its guardrails change by shipping a new version.
// Firefox reads managed storage at startup, so a policy change needs a browser restart.
// Values set by policy are locked: the interface shows them but can't change them.
/* global browser */
import builtInFile from '../policy.json' with { type: 'json' };
import { matchesAny } from './access.js';

export const POLICY_SCHEMA = 'powerloader-policy/1';

// Every key Power Loader reads from policy, with its default. PLACEHOLDER values are for the product owner to set.
export const POLICY_DEFAULTS = Object.freeze({
  library: Object.freeze({
    baseUrl: null, // e.g. "https://git.example.gov.uk/casework/powerloader-library/-/raw/{ref}/" (PLACEHOLDER)
    branch: 'main',
    pinCommit: null, // set during an incident to hold everyone on a known-good commit
    auth: 'none', // 'none' | 'token' | 'cookies' (PLACEHOLDER: decide with the enterprise git host)
    token: null, // read token when auth is 'token'; only ever from managed storage, never in a policy file
    syncMinutes: 60, // the timed sync: every this many minutes, lowest 15, 0 for off
  }),
  // enabled false turns the remote AI off and locks it off.
  gateway: Object.freeze({ baseUrl: null, model: null, enabled: true }),
  privacyModel: Object.freeze({
    // filesUrl: the folder that holds the model's files (config.json, onnx/…), on any web server. baseUrl: a server
    // in Hugging Face's layout ({model}/resolve/{revision}/). Both null: Hugging Face, or the caseworker's own
    // address. Set either to lock everyone to one place; filesUrl wins if both are set.
    // revision null: the extension's pinned default revision and hashes (lib/model-fetch.js DEFAULT_MODEL).
    // use true or false sets and locks whether the model is used at all; null leaves it to the library's
    // privacy.json and the caseworker (default: lib/model-fetch.js PRIVACY_MODEL_DEFAULT, on).
    // required (default true) holds AI requests until the model is ready, while it's used; set explicitly,
    // it also locks the model on.
    filesUrl: null, baseUrl: null, modelId: 'openai/privacy-filter', revision: null, hashes: null, required: true, use: null,
  }),
  assistModel: Object.freeze({
    // The on-device model that helps make profiles. enabled false switches it off for everyone (the rules
    // still match). revision null: lib/model-fetch.js DEFAULT_ASSIST_MODEL. baseUrl null: the privacy model's server,
    // when that's in Hugging Face's layout (a folder holds only one model's files). filesUrl: its own folder.
    enabled: true, filesUrl: null, baseUrl: null, modelId: null, revision: null, dtype: null, hashes: null, promptSuffix: null, prefill: null,
  }),
  redaction: Object.freeze({
    maxThreshold: null, lockedGroups: [], allowSendAsWritten: true, format: null, blockImages: false,
  }),
  activityLog: Object.freeze({ retentionDays: 90, coarseTimestamps: false, notes: true }),
  // clearCaseOnClose: the open case is deleted when Firefox closes. clearCaseAfterHours: it is deleted after this
  // many hours without use (in half hours, lowest 0.5; 0: never). Both on by default in every build; the
  // caseworker can change them in Settings unless the organisation sets them, which locks them.
  // clearCaseMaxHours: instead of fixing the time, the most the caseworker may choose (never is then refused),
  // as redaction.maxThreshold caps the threshold. A fixed clearCaseAfterHours wins over it. See lib/teardown.js.
  workstation: Object.freeze({ idleConfirmMinutes: 120, clearCaseOnClose: true, clearCaseAfterHours: 24, clearCaseMaxHours: null }),
  // Site rules above the library's and the caseworker's (lib/access.js): allow and deny are lists of
  // patterns, rules a list of full rules. lockLibraryRules makes every rule in the library's access.json locked.
  // backgroundReading true or false sets and locks "Read pages in the background" (fetch steps); null leaves
  // it to the library and the caseworker (default: access.js BACKGROUND_READING_DEFAULT).
  siteAccess: Object.freeze({ allow: null, deny: null, rules: null, lockLibraryRules: false, backgroundReading: null }),
  // A switch for each tool (lib/tools.js): true or false sets and locks it; null leaves it to the caseworker (on).
  tools: Object.freeze({ capture: null, reader: null, calculator: null, timeline: null, notes: null }),
  // Only from a built-in policy file: { setting: [pattern] }. The caseworker may choose any value that matches
  // one. Addresses take site-rule patterns (lib/access.js parsePattern); gateway.model takes model names, with *
  // as a wildcard. Checked against the address each request is sent to, when it is sent.
  allowed: null,
});

// The settings `allowed` can constrain.
export const ALLOWED_ADDRESSES = ['gateway.baseUrl', 'library.baseUrl', 'privacyModel.filesUrl', 'privacyModel.baseUrl', 'assistModel.filesUrl', 'assistModel.baseUrl'];
export const ALLOWED_SETTINGS = [...ALLOWED_ADDRESSES, 'gateway.model'];
export const ALLOWED_LABELS = {
  'gateway.baseUrl': 'the remote AI', 'gateway.model': 'the remote AI', 'library.baseUrl': 'the forms library',
  'privacyModel.filesUrl': 'the privacy model', 'privacyModel.baseUrl': 'the privacy model',
  'assistModel.filesUrl': 'the profile assistant', 'assistModel.baseUrl': 'the profile assistant',
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const SYNC_MIN = 15;

let builtIn = builtInFile;
let cache = null;

/** For tests and tools/policy.mjs: read another file as the built-in one (null: the packaged file). */
export function useBuiltInPolicy(file) { builtIn = file ?? builtInFile; cache = null; }

/** Is this the repo's default file, which sets nothing? Then managed storage is read, as on the public build. */
export function isDefaultPolicyFile(file) {
  return !!file && !file.name && !file.build && !(isObj(file.policy) && Object.keys(file.policy).length);
}

function merge(defaults, managed, prefix, locked) {
  const out = {};
  for (const [k, v] of Object.entries(defaults)) {
    const path = prefix ? `${prefix}.${k}` : k;
    const given = managed?.[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = merge(v, given, path, locked);
    else if (given !== undefined && given !== null) { out[k] = given; locked.add(path); }
    else out[k] = v;
  }
  return out;
}

// allowed: each known setting to a list of strings. Anything malformed allows nothing, so a mistake narrows.
function readAllowed(given) {
  if (given === undefined || given === null) return null;
  const out = {};
  for (const key of ALLOWED_SETTINGS) {
    const list = isObj(given) ? given[key] : [];
    if (list === undefined) continue;
    out[key] = Array.isArray(list) ? list.filter((v) => typeof v === 'string') : [];
  }
  return out;
}

/**
 * The policy from a built-in file and managed storage, as getPolicy() gives it. Pure, so tools/policy.mjs reads
 * a file exactly as the extension does. managed is ignored unless the file is the default.
 */
export function resolvePolicy(file, managed = {}) {
  const fromFile = !isDefaultPolicyFile(file);
  const given = fromFile ? (isObj(file?.policy) ? file.policy : {}) : (isObj(managed) ? managed : {});
  const locked = new Set();
  const values = merge(POLICY_DEFAULTS, { ...given, allowed: undefined }, '', locked);
  values.allowed = fromFile ? readAllowed(given.allowed) : null; // never from managed storage
  const s = Number(values.library.syncMinutes);
  values.library.syncMinutes = !Number.isFinite(s) || s < 0 ? POLICY_DEFAULTS.library.syncMinutes : s === 0 ? 0 : Math.max(SYNC_MIN, s);
  return {
    values, locked, managed: !fromFile && locked.size > 0,
    // The built-in file, by the name Settings shows ("Rules built in by …"); null on the public build.
    builtIn: fromFile ? { name: typeof file?.name === 'string' && file.name.trim() ? file.name.trim() : 'your organisation' } : null,
    managedIgnored: fromFile && isObj(managed) && Object.keys(managed).length > 0,
  };
}

/** { values, locked: Set of dotted keys set by policy, managed: boolean, builtIn: { name } | null, managedIgnored } */
export async function getPolicy({ fresh = false } = {}) {
  if (cache && !fresh) return cache;
  let managed = {};
  try {
    managed = (await browser.storage.managed.get(null)) || {};
  } catch {
    managed = {}; // No policy for this extension: everything is the caseworker's to set.
  }
  cache = resolvePolicy(builtIn, managed);
  return cache;
}

// Which policy keys are set, never their values: safe for diagnostics. allowed.<setting> for each constraint.
export async function policyKeysSet() {
  const p = await getPolicy();
  return [...p.locked, ...Object.keys(p.values.allowed || {}).map((k) => `allowed.${k}`)].sort();
}

// ------------------------------------------------------------------ allowed

/** The patterns (or model names) the organisation allows for a setting, or null when it doesn't constrain it. */
export function allowedFor(policy, setting) {
  const a = policy?.values?.allowed;
  return a && Array.isArray(a[setting]) ? a[setting] : null;
}

const nameMatches = (glob, name) => new RegExp(`^${String(glob).split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(String(name));

/** Does a value match one of these? Addresses by site-rule pattern, model names by name with * as a wildcard. */
export function matchesAllowed(setting, list, value) {
  if (setting === 'gateway.model') return list.some((g) => nameMatches(g, value));
  return matchesAny(list, value);
}

export class NotAllowed extends Error {
  constructor(setting, value) {
    super(setting === 'gateway.model'
      ? `Your organisation doesn’t allow the model “${String(value).slice(0, 80)}”.`
      : `Your organisation doesn’t allow this address for ${ALLOWED_LABELS[setting] || setting}.`);
    this.name = 'NotAllowed';
    this.setting = setting;
  }
}

/** Throws NotAllowed when the organisation constrains this setting and the value matches none of its patterns. */
export function checkAllowed(policy, setting, value) {
  const list = allowedFor(policy, setting);
  if (list && !matchesAllowed(setting, list, value)) throw new NotAllowed(setting, value);
}

export { modelAllowed } from './model-fetch.js';

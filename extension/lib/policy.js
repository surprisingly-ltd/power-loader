// Enterprise policy from storage.managed (Firefox policies.json, "3rdparty" → "Extensions" → this id).
// Firefox reads managed storage at startup, so a policy change needs a browser restart.
// Values set by policy are locked: the interface shows them but can't change them.
/* global browser */

// Every key Power Loader reads from policy, with its default. PLACEHOLDER values are for the product owner to set.
export const POLICY_DEFAULTS = Object.freeze({
  library: Object.freeze({
    baseUrl: null, // e.g. "https://git.example.gov.uk/casework/powerloader-library/-/raw/{ref}/" (PLACEHOLDER)
    branch: 'main',
    pinCommit: null, // set during an incident to hold everyone on a known-good commit
    auth: 'none', // 'none' | 'token' | 'cookies' (PLACEHOLDER: decide with the enterprise git host)
    token: null, // read token when auth is 'token'; only ever from policy
  }),
  gateway: Object.freeze({ baseUrl: null, model: null }),
  privacyModel: Object.freeze({
    // baseUrl null: Hugging Face, or the caseworker's own address. Set it to lock everyone to one server.
    // revision null: the extension's pinned default revision and hashes (lib/model-fetch.js DEFAULT_MODEL).
    baseUrl: null, modelId: 'openai/privacy-filter', revision: null, hashes: null, required: true,
  }),
  assistModel: Object.freeze({
    // The on-device model that helps make profiles. enabled false switches it off for everyone (the rules
    // still match). revision null: lib/model-fetch.js DEFAULT_ASSIST_MODEL. baseUrl null: the privacy model's server.
    enabled: true, baseUrl: null, modelId: null, revision: null, dtype: null, hashes: null, promptSuffix: null, prefill: null,
  }),
  redaction: Object.freeze({
    maxThreshold: null, lockedGroups: [], allowSendAsWritten: true, format: null, blockImages: false,
  }),
  activityLog: Object.freeze({ retentionDays: 90, coarseTimestamps: false, notes: true }),
  workstation: Object.freeze({ idleConfirmMinutes: 120 }),
});

let cache = null;

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

/** { values, locked: Set of dotted keys set by policy, managed: boolean } */
export async function getPolicy({ fresh = false } = {}) {
  if (cache && !fresh) return cache;
  let managed = {};
  try {
    managed = (await browser.storage.managed.get(null)) || {};
  } catch {
    managed = {}; // No policy for this extension: everything is the caseworker's to set.
  }
  const locked = new Set();
  cache = { values: merge(POLICY_DEFAULTS, managed, '', locked), locked, managed: locked.size > 0 };
  return cache;
}

// Which policy keys are set, never their values: safe for diagnostics.
export async function policyKeysSet() {
  return [...(await getPolicy()).locked].sort();
}

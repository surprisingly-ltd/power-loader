/* global browser */
import { mutateStorage } from '../storage.js';
import { checkAllowed, getPolicy } from '../policy.js';

export const AI_DEFAULTS = Object.freeze({
  baseUrl: '', model: 'fast', auth: 'bearer', maxIterations: 3,
  maxHtmlChars: 120000, requestTimeoutMs: 120000, operationDeadlineMs: 300000,
});
// The caseworker's acknowledgement, by the date of its wording: a change of wording asks again.
export const AI_ACK = '2026-11-24';
export const AI_ACK_TEXT = 'I understand that the contents of the anonymised page, and anything else I approve in the preview, will be sent to this remote AI; that the anonymisation might not be perfect, so personal data could still be sent; and that before turning this on I must make sure it complies with the relevant laws and my organisation’s policies.';
export const aiAcknowledged = (settings) => settings?.aiConsent === AI_ACK;
export const CREDENTIAL_KEY = 'aiCredential'; // Deliberately outside storage.js KEYS.
const pickAI = (ai = {}) => Object.fromEntries(Object.entries(AI_DEFAULTS).map(([k, v]) => [k, ai[k] ?? v]));

export function normalizeBaseUrl(value) {
  const url = new URL(String(value).trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, ''));
  if (url.username || url.password || url.search || url.hash) throw new Error('Endpoint must not contain credentials, query parameters or a fragment');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Use HTTPS for remote endpoints or HTTP on loopback');
  }
  return url.href.replace(/\/+$/, '');
}

export function validateAI(input) {
  const ai = pickAI(input);
  ai.baseUrl = normalizeBaseUrl(ai.baseUrl);
  ai.model = String(ai.model).trim();
  if (!ai.model) throw new Error('Enter a model identifier');
  if (!['bearer', 'none'].includes(ai.auth)) throw new Error('Choose bearer authentication or no key');
  for (const [key, min, max] of [
    ['maxIterations', 1, 6], ['maxHtmlChars', 1000, 500000],
    ['requestTimeoutMs', 100, 300000], ['operationDeadlineMs', 100, 900000],
  ]) {
    ai[key] = Number(ai[key]);
    if (!Number.isInteger(ai[key]) || ai[key] < min || ai[key] > max) throw new Error(`${key} must be between ${min} and ${max}`);
  }
  return ai;
}

export function migrateSettings(settings = {}) {
  // An old custom serverUrl is not an inference URL. Never copy it or secrets.
  const { ai, ...rest } = settings;
  delete rest.serverUrl;
  delete rest.apiKey;
  return { ...rest, schemaVersion: 1, clipMode: settings.clipMode || 'manual', ai: pickAI(ai) };
}

export async function getSettings() {
  return mutateStorage(({ settings = {} }) => {
    const migrated = migrateSettings(settings);
    return { result: migrated, ...(JSON.stringify(settings) === JSON.stringify(migrated) ? {} : { patch: { settings: migrated } }) };
  });
}

export async function saveSettings(patch) {
  return mutateStorage(({ settings = {} }) => {
    const current = migrateSettings(settings);
    const next = migrateSettings({ ...current, ...patch, ai: { ...current.ai, ...patch.ai } });
    if (patch.ai) next.ai = validateAI(next.ai);
    return { patch: { settings: next }, result: next };
  });
}

export async function getCredential(baseUrl) {
  const session = (await browser.storage.session.get(CREDENTIAL_KEY))[CREDENTIAL_KEY];
  const saved = (await browser.storage.local.get(CREDENTIAL_KEY))[CREDENTIAL_KEY];
  const credential = session || saved;
  return credential?.baseUrl === baseUrl ? { key: credential.key, remembered: !session } : null;
}

export async function forgetCredential() {
  const outcomes = await Promise.allSettled([
    browser.storage.session.remove(CREDENTIAL_KEY), browser.storage.local.remove(CREDENTIAL_KEY),
  ]);
  if (outcomes.some((r) => r.status === 'rejected')) throw new Error('Could not fully forget the key; retry before continuing');
}

export async function saveCredential(baseUrl, key, remember = false) {
  const credential = { baseUrl: normalizeBaseUrl(baseUrl), key: String(key).trim() };
  if (!credential.key) throw new Error('Enter an API key');
  // Never broadcast secrets through runtime.sendMessage. Remove the previous
  // mode first so a failure cannot claim session-only while a disk copy remains.
  await forgetCredential();
  const area = remember ? browser.storage.local : browser.storage.session;
  try { await area.set({ [CREDENTIAL_KEY]: credential }); }
  catch { throw new Error('Could not store the key; enter it again'); }
}

/**
 * The saved connection with what policy locks laid over it. Policy is applied on every request, not only
 * when Settings is saved: an endpoint saved before the organisation set gateway.baseUrl is never used.
 */
export function withPolicy(ai, policy) {
  const g = policy?.values?.gateway || {};
  const locked = (k) => (policy?.locked instanceof Set ? policy.locked.has(k) : Array.isArray(policy?.locked) && policy.locked.includes(k));
  return { ...ai, ...(locked('gateway.baseUrl') && g.baseUrl ? { baseUrl: g.baseUrl } : {}), ...(locked('gateway.model') && g.model ? { model: g.model } : {}) };
}

export async function connectionConfig() {
  const settings = await getSettings();
  if (!aiAcknowledged(settings)) throw new Error('Review and enable the remote AI in Settings');
  const policy = await getPolicy();
  if (!aiAllowed(policy)) throw new Error(AI_OFF_TEXT);
  const config = validateAI(withPolicy(settings.ai, policy));
  // A built-in policy file may constrain the address and model by pattern: checked here, on every request.
  checkAllowed(policy, 'gateway.baseUrl', `${config.baseUrl}/chat/completions`);
  checkAllowed(policy, 'gateway.model', config.model);
  if (!(await browser.permissions.contains({ origins: [endpointPattern(config.baseUrl)] }))) {
    throw new Error('Allow access to the AI endpoint in Settings');
  }
  const credential = await getCredential(config.baseUrl);
  if (config.auth === 'bearer' && !credential) throw new Error('Enter an API key in Settings');
  return { ...config, apiKey: config.auth === 'bearer' ? credential.key : '' };
}

export function endpointPattern(baseUrl) {
  const url = new URL(normalizeBaseUrl(baseUrl));
  return `${url.protocol}//${url.hostname}/*`; // Firefox patterns have no port.
}

export async function backupData() {
  const keys = ['settings', 'profiles', 'profileSettings', 'cases', 'activeCaseId'];
  const data = await browser.storage.local.get(keys);
  return { ...data, settings: migrateSettings(data.settings) };
}

// The organisation can turn the remote AI off (policy gateway.enabled false), which also locks it off.
export const aiAllowed = (policy) => policy?.values?.gateway?.enabled !== false;
export const AI_OFF_TEXT = 'Your organisation has turned off the remote AI';
/** The settings as the interface reads them: with the remote AI turned off by the organisation, it isn't agreed to. */
export const settingsUnderPolicy = (settings, policy) => (aiAllowed(policy) || !settings ? settings : { ...settings, aiConsent: null });
// ✦ actions are offered once the gateway is set up and the caseworker has agreed to send what they approve,
// unless the organisation has turned the remote AI off (pass the policy where it's at hand).
export const aiReady = (settings, policy = null) => !!(aiAcknowledged(settings) && settings?.ai?.baseUrl && aiAllowed(policy));

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { complete } from '../../extension/lib/ai/client.js';
import { approve, prepare } from '../../extension/lib/ai/boundary.js';
import { effectiveSettings } from '../../extension/lib/privacy-detect.js';
import { AI_DEFAULTS, CREDENTIAL_KEY, normalizeBaseUrl, migrateSettings, getCredential, saveCredential, forgetCredential, backupData } from '../../extension/lib/ai/settings.js';
const config = { ...AI_DEFAULTS, baseUrl: 'https://example.test/prefix/v1', apiKey: 'secret-test' };
const messages = [{ role: 'user', content: 'hello' }];
// Synthetic text with nothing to redact, approved through the real boundary.
const payload = approve(prepare({ purpose: 'test', parts: [{ id: 't', kind: 'text', text: 'hello' }], compose: (sent) => [{ role: 'user', content: sent.t }] },
  { known: [], patterns: [], settings: effectiveSettings(), model: { ready: true, required: false } }));
const response = (content = 'OK', finish_reason = 'stop') => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason }] }));
let local, session, failRemove, failSet, runtimeMessages;
const area = (state, name) => ({
  get: async (keys) => structuredClone(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in state).map((k) => [k, state[k]]))),
  set: async (patch) => { if (failSet === name) throw new Error('Disk error secret-test'); Object.assign(state, structuredClone(patch)); },
  remove: async (key) => { if (failRemove === name) throw new Error('Failure secret-test'); delete state[key]; },
});
beforeEach(() => {
  local = {}; session = {}; failRemove = null; failSet = null; runtimeMessages = [];
  globalThis.browser = { storage: { local: area(local, 'local'), session: area(session, 'session') }, runtime: { sendMessage: (m) => { runtimeMessages.push(m); } } };
});

test('client preserves prefix, sends minimal authenticated request and rejects redirects', async () => {
  let request;
  const out = await complete(payload, config, { fetchFn: async (url, init) => { request = { url, ...init }; return response(); } });
  assert.equal(out, 'OK');
  assert.equal(request.url, 'https://example.test/prefix/v1/chat/completions');
  assert.equal(request.headers.Authorization, 'Bearer secret-test');
  assert.deepEqual(JSON.parse(request.body), { model: 'fast', messages, stream: false });
  assert.equal(request.redirect, 'error'); assert.equal(request.credentials, 'omit');
});

test('normalization preserves base paths and rejects unsafe endpoint values', () => {
  assert.equal(normalizeBaseUrl('http://localhost:30200/v1/chat/completions/'), 'http://localhost:30200/v1');
  for (const url of ['http://remote.example/v1', 'https://u:p@example.test/v1', 'https://example.test/v1?api_key=x']) assert.throws(() => normalizeBaseUrl(url));
});

test('no-auth endpoints omit the Authorization header', async () => {
  await complete(payload, { ...config, auth: 'none' }, { fetchFn: async (_, init) => { assert.equal(init.headers.Authorization, undefined); return response(); } });
});

test('authentication, throttling and server errors are readable without echoing secrets', async () => {
  for (const status of [401, 403, 404, 429, 502]) {
    await assert.rejects(complete(payload, config, { fetchFn: async () => new Response('secret-test ' + JSON.stringify(messages), { status }) }), (error) => {
      assert.equal(error.message.includes('secret-test'), false);
      assert.equal(!!error.retryable, status === 429 || status >= 500); return true;
    });
  }
});

test('invalid, refused, length-truncated, missing and oversized responses are distinct failures', async () => {
  for (const [result, pattern] of [
    [new Response('not-json'), /valid JSON/],
    [new Response(JSON.stringify({ choices: [{ message: { refusal: 'no' } }] })), /declined/],
    [response('partial', 'length'), /cut short/], [response(null), /no text/], [response('x'.repeat(100001)), /too large/],
  ]) await assert.rejects(complete(payload, config, { fetchFn: async () => result }), pattern);
});

test('request timeout and cancellation abort even a noncooperating fetch', async () => {
  await assert.rejects(complete(payload, { ...config, requestTimeoutMs: 100 }, { fetchFn: () => new Promise(() => {}) }), { name: 'TimeoutError' });
  const c = new AbortController();
  const pending = complete(payload, config, { signal: c.signal, fetchFn: () => new Promise(() => {}) });
  c.abort(); await assert.rejects(pending, { name: 'AbortError' });
});

test('session credentials survive module/background recreation, stay endpoint-bound and never use runtime messages', async () => {
  await saveCredential(config.baseUrl, 'secret-test', false);
  assert.equal(local[CREDENTIAL_KEY], undefined);
  assert.equal((await getCredential(config.baseUrl)).key, 'secret-test');
  const reloaded = await import('../../extension/lib/ai/settings.js?reloaded');
  assert.equal((await reloaded.getCredential(config.baseUrl)).key, 'secret-test');
  assert.equal(await getCredential('https://other.test/v1'), null);
  assert.deepEqual(runtimeMessages, []);
});

test('changing persistence removes previous saved copies and forgetting clears both areas', async () => {
  await saveCredential(config.baseUrl, 'secret-test', true);
  assert.ok(local[CREDENTIAL_KEY]); assert.equal(session[CREDENTIAL_KEY], undefined);
  await saveCredential(config.baseUrl, 'new-key', false);
  assert.equal(local[CREDENTIAL_KEY], undefined);
  assert.equal((await getCredential(config.baseUrl)).remembered, false);
  await forgetCredential(); assert.equal(await getCredential(config.baseUrl), null);
});

test('partial failures are reported and do not claim persistence changes succeeded', async () => {
  await saveCredential(config.baseUrl, 'secret-test', true);
  failRemove = 'local';
  await assert.rejects(saveCredential(config.baseUrl, 'new-key', false), /fully forget/);
  assert.equal(local[CREDENTIAL_KEY].key, 'secret-test'); assert.equal(session[CREDENTIAL_KEY], undefined);
  failRemove = null; failSet = 'session';
  await assert.rejects(saveCredential(config.baseUrl, 'new-key', false), /Could not store/);
  assert.equal(local[CREDENTIAL_KEY], undefined);
});

test('migration drops custom serverUrl without guessing an inference endpoint and safe backups omit keys', async () => {
  local.settings = { serverUrl: 'http://old-custom-server', clipMode: 'auto' };
  local.cases = { a: { id: 'a', records: [] } }; local.profiles = { p: { name: 'Profile' } };
  await saveCredential(config.baseUrl, 'secret-test', true);
  const migrated = migrateSettings(local.settings);
  assert.equal(migrated.ai.baseUrl, ''); assert.equal(migrated.clipMode, 'auto'); assert.equal(migrated.serverUrl, undefined);
  const backup = await backupData();
  assert.deepEqual(backup.cases, local.cases); assert.deepEqual(backup.profiles, local.profiles);
  assert.equal(JSON.stringify(backup).includes('secret-test'), false);
  assert.equal(backup[CREDENTIAL_KEY], undefined);
});

test('a gateway address or model locked by policy is used on every request, whatever was saved before', async () => {
  const { withPolicy } = await import('../../extension/lib/ai/settings.js');
  const saved = { baseUrl: 'https://old-gateway.example/v1', model: 'fast', auth: 'bearer' };
  const policy = { values: { gateway: { baseUrl: 'https://gateway.council.example/v1', model: 'internal' } }, locked: new Set(['gateway.baseUrl', 'gateway.model']) };
  assert.deepEqual(withPolicy(saved, policy), { baseUrl: 'https://gateway.council.example/v1', model: 'internal', auth: 'bearer' });
  assert.deepEqual(withPolicy(saved, { values: { gateway: {} }, locked: new Set() }), saved, 'no policy: the caseworker’s own');
});

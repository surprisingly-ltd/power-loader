// A built-in policy file's `allowed` patterns and gateway.enabled, at each place a request is sent: the AI
// connection, every library file and every model file. A value saved before the rule existed is never used.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { manifest } from './helpers/library.js';
import { readFileSync } from 'node:fs';
import { getPolicy, useBuiltInPolicy } from '../../extension/lib/policy.js';
import { AI_ACK, aiReady, connectionConfig } from '../../extension/lib/ai/settings.js';
import { fetchLibrary, libraryConfig } from '../../extension/lib/library-sync.js';
import { DEFAULT_MODEL, modelSource, testModelServer, verifyingFetch } from '../../extension/lib/model-fetch.js';

const org = (policy) => ({ schema: 'powerloader-policy/1', name: 'Example Council', build: { id: 'powerloader@example.gov.uk' }, policy });
const demo = (path) => readFileSync(new URL(`../../demo/library/${path}`, import.meta.url));

function browserWith(local) {
  const session = { aiCredential: { baseUrl: local.settings?.ai?.baseUrl, key: 'k' } };
  const area = (d) => ({ get: async (keys) => structuredClone(Object.fromEntries((keys == null ? Object.keys(d) : [keys].flat()).filter((k) => k in d).map((k) => [k, d[k]]))), set: async (p) => Object.assign(d, structuredClone(p)), remove: async () => {} });
  globalThis.browser = {
    storage: { local: area(local), session: area(session), managed: { get: async () => ({}) } },
    permissions: { contains: async () => true },
    runtime: { id: 'x', onMessage: { addListener() {} }, sendMessage: async () => true },
  };
}
// Saved before the organisation's rule existed.
const savedAI = (baseUrl, model = 'fast') => ({ settings: { schemaVersion: 1, clipMode: 'manual', aiConsent: AI_ACK, ai: { baseUrl, model, auth: 'bearer', maxIterations: 3, maxHtmlChars: 120000, requestTimeoutMs: 120000, operationDeadlineMs: 300000 } } });

afterEach(async () => { useBuiltInPolicy(null); delete globalThis.browser; });

test('the AI connection: an endpoint or model saved before the rule is refused', async () => {
  useBuiltInPolicy(org({ allowed: { 'gateway.baseUrl': ['https://*.example.gov.uk/*'], 'gateway.model': ['fast', 'gpt-*'] } }));
  browserWith(savedAI('https://ai.elsewhere.example/v1'));
  await getPolicy({ fresh: true });
  await assert.rejects(connectionConfig(), /Your organisation doesn’t allow this address for the remote AI/);
  browserWith(savedAI('https://ai.example.gov.uk/v1', 'expensive'));
  await assert.rejects(connectionConfig(), /doesn’t allow the model “expensive”/);
  browserWith(savedAI('https://ai.example.gov.uk/v1', 'gpt-5'));
  const ok = await connectionConfig();
  assert.equal(ok.baseUrl, 'https://ai.example.gov.uk/v1');
});

test('gateway.enabled false turns the remote AI off, whatever was saved', async () => {
  useBuiltInPolicy(org({ gateway: { enabled: false } }));
  browserWith(savedAI('https://ai.example.gov.uk/v1'));
  const policy = await getPolicy({ fresh: true });
  await assert.rejects(connectionConfig(), /Your organisation has turned off the remote AI/);
  const { settings } = savedAI('https://ai.example.gov.uk/v1');
  assert.equal(aiReady(settings), true);
  assert.equal(aiReady(settings, policy), false);
});

test('the library: every file address is checked, a saved address outside the pattern is refused', async () => {
  useBuiltInPolicy(org({ allowed: { 'library.baseUrl': ['https://gitlab.example.gov.uk/casework/*'] } }));
  browserWith({ settings: { library: { baseUrl: 'https://gitlab.example.gov.uk/other-team/lib/-/raw/{ref}/' } } });
  await getPolicy({ fresh: true });
  const requests = [];
  const fetchFn = async (url) => {
    requests.push(url);
    const path = /\/raw\/[^/]+\/(.+)$/.exec(new URL(url).pathname)[1];
    const body = path === 'library.json' ? Buffer.from(JSON.stringify(manifest)) : demo(path);
    return { ok: true, status: 200, url, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
  };
  const cfg = await libraryConfig();
  assert.deepEqual(cfg.allowed, ['https://gitlab.example.gov.uk/casework/*']);
  await assert.rejects(fetchLibrary(cfg, { fetchFn }), /doesn’t allow this address for the forms library/);
  assert.equal(requests.length, 0, 'nothing was requested');
  const set = await fetchLibrary({ ...cfg, baseUrl: 'https://gitlab.example.gov.uk/casework/team-a/-/raw/{ref}/' }, { fetchFn });
  assert.equal(set.commit, manifest.commit);
  assert.ok(requests.every((u) => u.startsWith('https://gitlab.example.gov.uk/casework/team-a/')));
});

test('the model: a file outside the pattern, or a redirect outside it, is refused', async () => {
  const policy = { values: { privacyModel: { modelId: 'openai/privacy-filter' }, allowed: { 'privacyModel.filesUrl': ['https://models.example.gov.uk/*'] } } };
  // Saved by the caseworker before the rule: Hugging Face.
  const source = modelSource(policy, null, {});
  assert.deepEqual(source.allowed, ['https://models.example.gov.uk/*']);
  const url = `${DEFAULT_MODEL.baseUrl}${DEFAULT_MODEL.modelId}/resolve/${DEFAULT_MODEL.revision}/config.json`;
  let asked = 0;
  const serve = (finalUrl) => async () => { asked++; return Object.assign(new Response('{}'), {}, finalUrl ? { url: finalUrl } : {}); };
  await assert.rejects(verifyingFetch(source, serve())(url), (e) => e.reason === 'blocked' && /organisation doesn’t allow/.test(e.message));
  assert.equal(asked, 0);
  const mirror = modelSource(policy, null, { privacy: { modelFilesUrl: 'https://models.example.gov.uk/pf/' } });
  const redirected = async (u) => { const r = new Response('{}'); Object.defineProperty(r, 'url', { value: 'https://cdn.elsewhere.example/x' }); return r; };
  await assert.rejects(verifyingFetch({ ...mirror, hashes: null }, redirected)('https://models.example.gov.uk/pf/config.json'), /redirected to cdn\.elsewhere\.example/);
  const probe = await testModelServer(source, serve());
  assert.ok(probe.files.every((f) => f.status === 'blocked'));
});

test('without allowed, nothing changes', async () => {
  browserWith({ settings: { library: { baseUrl: 'https://git.example/lib/' } } });
  await getPolicy({ fresh: true });
  assert.equal((await libraryConfig()).allowed, null);
  assert.equal(modelSource({ values: { privacyModel: {} } }, null, {}).allowed, null);
});

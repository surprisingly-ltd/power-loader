// The policy reader: the built-in policy file, managed storage only on the default build, and `allowed`.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  POLICY_DEFAULTS, NotAllowed, checkAllowed, getPolicy, isDefaultPolicyFile, matchesAllowed, modelAllowed, policyKeysSet, resolvePolicy, useBuiltInPolicy,
} from '../../extension/lib/policy.js';

const shipped = JSON.parse(readFileSync(new URL('../../extension/policy.json', import.meta.url), 'utf8'));
const org = (policy = {}, extra = {}) => ({ schema: 'powerloader-policy/1', name: 'Example Council', build: { id: 'powerloader@example.gov.uk' }, policy, ...extra });
const withManaged = (managed) => { globalThis.browser = { storage: { managed: { get: async () => structuredClone(managed) } } }; };

afterEach(() => { useBuiltInPolicy(null); delete globalThis.browser; });

test('the shipped policy file is the default: it sets nothing', () => {
  assert.equal(shipped.schema, 'powerloader-policy/1');
  assert.ok(isDefaultPolicyFile(shipped));
  assert.ok(!isDefaultPolicyFile(org()));
  assert.ok(!isDefaultPolicyFile({ ...shipped, name: 'Example Council' }));
});

test('on the default build, managed storage is read and locks what it sets', async () => {
  withManaged({ gateway: { baseUrl: 'https://ai.example.gov.uk/v1' }, library: { syncMinutes: 5 } });
  const p = await getPolicy({ fresh: true });
  assert.equal(p.builtIn, null);
  assert.equal(p.managed, true);
  assert.deepEqual([...p.locked].sort(), ['gateway.baseUrl', 'library.syncMinutes']);
  assert.equal(p.values.library.syncMinutes, 15, 'raised to the lowest');
  assert.equal(p.values.gateway.enabled, true);
  assert.equal(p.values.workstation.clearCaseOnClose, true);
});

test('managed storage can’t set allowed', async () => {
  withManaged({ allowed: { 'library.baseUrl': ['https://*'] } });
  const p = await getPolicy({ fresh: true });
  assert.equal(p.values.allowed, null);
  assert.ok(!p.locked.has('allowed'));
});

test('an organisation build ignores managed storage, and says so', async () => {
  useBuiltInPolicy(org({ gateway: { enabled: false } }));
  withManaged({ gateway: { baseUrl: 'https://elsewhere.example/v1' } });
  const p = await getPolicy({ fresh: true });
  assert.deepEqual(p.builtIn, { name: 'Example Council' });
  assert.equal(p.managed, false);
  assert.equal(p.managedIgnored, true);
  assert.equal(p.values.gateway.baseUrl, null);
  assert.equal(p.values.gateway.enabled, false);
  assert.deepEqual([...p.locked], ['gateway.enabled']);
});

test('an organisation build with no managed storage, and its keys for diagnostics', async () => {
  useBuiltInPolicy(org({ library: { syncMinutes: 0 }, workstation: { clearCaseOnClose: false }, allowed: { 'library.baseUrl': ['https://gitlab.example.gov.uk/casework/*'] } }));
  globalThis.browser = { storage: { managed: { get: async () => { throw new Error('Managed storage manifest not found'); } } } };
  const p = await getPolicy({ fresh: true });
  assert.equal(p.managedIgnored, false);
  assert.equal(p.values.library.syncMinutes, 0, '0 is off');
  assert.equal(p.values.workstation.clearCaseOnClose, false);
  assert.deepEqual(await policyKeysSet(), ['allowed.library.baseUrl', 'library.syncMinutes', 'workstation.clearCaseOnClose']);
});

test('allowed: a malformed list allows nothing; an unknown setting is dropped', () => {
  const p = resolvePolicy(org({ allowed: { 'gateway.baseUrl': 'https://ai.example.gov.uk/*', 'library.baseUrl': [42, 'https://git.example.gov.uk/*'], 'library.branch': ['x'] } }));
  assert.deepEqual(p.values.allowed, { 'gateway.baseUrl': [], 'library.baseUrl': ['https://git.example.gov.uk/*'] });
  assert.throws(() => checkAllowed(p, 'gateway.baseUrl', 'https://ai.example.gov.uk/v1/chat/completions'), NotAllowed);
  const all = resolvePolicy(org({ allowed: 'everything' }));
  assert.ok(Object.values(all.values.allowed).every((l) => l.length === 0));
});

test('allowed: addresses use the site-rule patterns, models use names with *', () => {
  const p = resolvePolicy(org({ allowed: { 'library.baseUrl': ['https://gitlab.example.gov.uk/casework/*'], 'gateway.model': ['fast', 'gpt-*'], 'privacyModel.filesUrl': ['https://models.example.gov.uk/*'] } }));
  assert.doesNotThrow(() => checkAllowed(p, 'library.baseUrl', 'https://gitlab.example.gov.uk/casework/team-a/-/raw/abc/library.json'));
  assert.throws(() => checkAllowed(p, 'library.baseUrl', 'https://gitlab.example.gov.uk/other/library.json'), /doesn’t allow this address for the forms library/);
  assert.throws(() => checkAllowed(p, 'library.baseUrl', 'http://gitlab.example.gov.uk/casework/x'), NotAllowed);
  assert.doesNotThrow(() => checkAllowed(p, 'gateway.model', 'gpt-5'));
  assert.throws(() => checkAllowed(p, 'gateway.model', 'expensive'), /doesn’t allow the model/);
  assert.doesNotThrow(() => checkAllowed(p, 'gateway.baseUrl', 'https://anywhere.example/v1'), 'not constrained');
  assert.deepEqual(modelAllowed(p, 'privacyModel'), ['https://models.example.gov.uk/*']);
  assert.equal(modelAllowed(p, 'assistModel'), null);
  assert.ok(!matchesAllowed('library.baseUrl', ['not a pattern'], 'https://x.example/'));
});

test('every new key has a default', () => {
  assert.equal(POLICY_DEFAULTS.gateway.enabled, true);
  assert.equal(POLICY_DEFAULTS.library.syncMinutes, 60);
  assert.equal(POLICY_DEFAULTS.workstation.clearCaseOnClose, true);
  assert.equal(POLICY_DEFAULTS.allowed, null);
});

// What an organisation build shows: whose rules are built in, the patterns beside a box, a value outside them
// refused, the remote AI off, "doesn't work on this site", and diagnostics that name the policy, never values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { resolvePolicy } from '../../extension/lib/policy.js';
import { canBeGranted, captureByActiveTab, captureImpossible, fixedHosts, NOT_HERE } from '../../extension/lib/build-hosts.js';
import { diagnosticsReport } from '../../extension/lib/diagnostics.js';

const dom = new JSDOM('<!doctype html><body></body>', { url: 'moz-extension://x/sidebar/sidebar.html' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node });
const { allowedNote, policyCard, refuseOutside } = await import('../../extension/sidebar/org-policy.js');
const { aiSettingsCard } = await import('../../extension/sidebar/ai-settings.js');

const org = (policy) => resolvePolicy({ schema: 'powerloader-policy/1', name: 'Example Council', build: { id: 'powerloader@example.gov.uk' }, policy });
const publicManifest = { optional_host_permissions: ['<all_urls>'] };
const orgManifest = { host_permissions: ['https://*.example.gov.uk/*'] };

test('which sites a build can ever be granted', () => {
  assert.equal(fixedHosts(publicManifest), null);
  assert.equal(fixedHosts({ version: '1' }), null, 'a manifest with no host lists is the public one');
  assert.deepEqual(fixedHosts(orgManifest), ['https://*.example.gov.uk/*']);
  assert.ok(canBeGranted('https://records.example.gov.uk/x', orgManifest));
  assert.ok(!canBeGranted('https://records.elsewhere.example/x', orgManifest));
  assert.ok(canBeGranted('https://records.elsewhere.example/x', publicManifest));
  assert.match(NOT_HERE, /Your organisation’s version of Power Loader doesn’t work on this site/);
});

test('Settings: rules built in, the keys set and those constrained by pattern, never their values', () => {
  const policy = org({ gateway: { model: 'fast' }, allowed: { 'library.baseUrl': ['https://gitlab.example.gov.uk/casework/*'] } });
  const card = policyCard({ data: { policy } });
  assert.match(card.querySelector('h2').textContent, /Rules built in by Example Council/);
  assert.match(card.textContent, /gateway\.model/);
  assert.match(card.textContent, /library\.baseUrl/);
  assert.ok(!card.textContent.includes('fast'));
  assert.equal(policyCard({ data: { policy: resolvePolicy({ schema: 'powerloader-policy/1', name: null, policy: {} }) } }), null);
  assert.match(allowedNote(['https://gitlab.example.gov.uk/casework/*']).textContent, /Your organisation allows https:\/\/gitlab\.example\.gov\.uk\/casework\/\*/);
  assert.equal(allowedNote(null), null);
  assert.throws(() => refuseOutside(policy, 'library.baseUrl', 'https://gitlab.example.gov.uk/finance/lib/'), /doesn’t allow this address\. It allows https:\/\/gitlab\.example\.gov\.uk\/casework\/\*/);
  assert.doesNotThrow(() => refuseOutside(policy, 'library.baseUrl', 'https://gitlab.example.gov.uk/casework/a/-/raw/main/'));
});

test('the remote AI card: off by the organisation, or the patterns beside its boxes', () => {
  const off = aiSettingsCard({ data: { policy: org({ gateway: { enabled: false } }), settings: {} }, act: {} });
  assert.match(off.textContent, /Your organisation has turned off the remote AI/);
  assert.equal(off.querySelector('input'), null);
  const by = aiSettingsCard({ data: { policy: org({ allowed: { 'gateway.baseUrl': ['https://ai.example.gov.uk/*'], 'gateway.model': ['gpt-*'] } }), settings: {} }, act: {} });
  assert.ok(by.querySelector('[data-key=ai-allowed-url]').textContent.includes('https://ai.example.gov.uk/*'));
  assert.match(by.querySelector('[data-key=ai-allowed-model]').textContent, /gpt-\*/);
});

test('diagnostics name the built-in policy and that managed storage was ignored', () => {
  const report = diagnosticsReport({ policy: { builtIn: { name: 'Example Council' }, managed: false, managedIgnored: true, id: 'powerloader@example.gov.uk' }, policyKeys: ['allowed.library.baseUrl', 'gateway.enabled'] });
  assert.match(report, /Policy: built in by Example Council \(powerloader@example\.gov\.uk\); managed storage is set and ignored/);
  assert.match(report, /Policy keys set: allowed\.library\.baseUrl, gateway\.enabled/);
  assert.match(diagnosticsReport({ policy: { builtIn: null, managed: true } }), /Policy: managed storage/);
});

test('capture on a build with fixed hosts goes through activeTab; with the tool off, there is none', async () => {
  assert.equal(captureByActiveTab({ host_permissions: ['https://*.example.gov.uk/*'], permissions: ['activeTab'] }), true);
  assert.equal(captureImpossible({ host_permissions: ['https://*.example.gov.uk/*'], permissions: [] }), true);
  assert.equal(captureByActiveTab(publicManifest), false);
  assert.equal(captureImpossible(publicManifest), false);
  const { dataUrlBlob } = await import('../../extension/sidebar/tools/reader-ui.js');
  const blob = dataUrlBlob('data:image/png;base64,iVBORw0KGgo=');
  assert.equal(blob.type, 'image/png');
  assert.equal(blob.size, 8);
});

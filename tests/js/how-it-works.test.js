// /how-it-works: its samples go through the extension's own validators, its worked examples are decided by
// lib/access.js, and its policy table has a row for every key in lib/policy.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  EXAMPLE_ROWS, EXAMPLE_RULES, EXTENSION_ID, POLICY_KEY_NOTES, SCOPED_ROWS, howItWorksValues, policyKeys, sampleAccess, samplePolicy, scopedLayers,
} from '../../tools/how-it-works.mjs';
import { allowed, accessOf, validateAccess } from '../../extension/lib/access.js';
import { POLICY_DEFAULTS, getPolicy } from '../../extension/lib/policy.js';
import { libraryUrl } from '../../extension/lib/library-sync.js';
import { normalizeBaseUrl } from '../../extension/lib/ai/settings.js';
import { normalizeModelUrl } from '../../extension/lib/model-fetch.js';

test('the sample access.json passes validateAccess() and has locked, delegated and background parts', () => {
  const doc = sampleAccess();
  assert.deepEqual(validateAccess(doc), []);
  const a = accessOf(doc);
  assert.ok(a.locked.length >= 2);
  assert.ok(a.delegated.length >= 1);
  assert.deepEqual(a.background, { on: true, lock: false });
});

test('the sample policies.json is read by the policy reader, every key known and locked', async () => {
  const { doc, settings } = samplePolicy();
  assert.ok(doc.policies['3rdparty'].Extensions[EXTENSION_ID]);
  const given = [];
  const walk = (o, prefix) => Object.entries(o).forEach(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? walk(v, `${prefix}${k}.`) : given.push(`${prefix}${k}`)));
  walk(settings, '');
  const keys = new Set(policyKeys().map(([k]) => k));
  for (const k of given) assert.ok(keys.has(k), `${k} is a policy key`);
  globalThis.browser = { storage: { managed: { get: async () => structuredClone(settings) } } };
  try {
    const policy = await getPolicy({ fresh: true });
    assert.deepEqual([...policy.locked].sort(), given.sort());
    assert.equal(policy.values.library.baseUrl, settings.library.baseUrl);
  } finally {
    delete globalThis.browser;
    await getPolicy({ fresh: true }).catch(() => {});
  }
  assert.ok(libraryUrl(settings.library.baseUrl, 'main', 'library.json').startsWith('https://git.council.example/'));
  assert.equal(normalizeBaseUrl(settings.gateway.baseUrl), settings.gateway.baseUrl);
  assert.equal(normalizeModelUrl(settings.privacyModel.filesUrl), settings.privacyModel.filesUrl);
});

test('a sample that doesn’t validate fails the build', () => {
  assert.ok(validateAccess({ ...sampleAccess(), deny: { rules: [{ id: 'x', pattern: 'https://*bad' }] } }).length);
});

test('the worked examples say what lib/access.js decides', () => {
  for (const r of EXAMPLE_ROWS) assert.equal(allowed(EXAMPLE_RULES, r.url, 'read').ok, r.ok, r.url);
  const layers = scopedLayers();
  for (const r of SCOPED_ROWS) assert.equal(allowed(layers, r.url, r.action).ok, r.ok, `${r.url} ${r.action}`);
});

test('the page lists every policy key in lib/policy.js, and no other', () => {
  const keys = policyKeys().map(([k]) => k);
  assert.ok(keys.includes('siteAccess.backgroundReading') && keys.includes('library.pinCommit'));
  assert.deepEqual(Object.keys(POLICY_KEY_NOTES).sort(), [...keys].sort());
  const table = howItWorksValues().HIW_POLICY_KEYS;
  for (const k of keys) assert.ok(table.includes(`<code>${k}</code>`), k);
  assert.equal(Object.keys(POLICY_DEFAULTS).length, new Set(keys.map((k) => k.split('.')[0])).size);
});

test('the page uses every generated part, and no real organisation’s host', () => {
  const html = fs.readFileSync(new URL('../../site/how-it-works.html', import.meta.url), 'utf8');
  for (const k of Object.keys(howItWorksValues())) assert.ok(html.includes(`{{${k}}}`), k);
  const hosts = [...html.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]);
  for (const h of hosts) assert.match(h, /\.example$/, h);
  assert.match(html, /You don’t need to read this to use Power Loader/);
});

// The readiness page and diagnostics: specific fixes, and a report that never holds case data, links or keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import '../../extension/lib/extract.js';
import { registerStorageWriter } from '../../extension/lib/storage.js';
import { demoSet, demoLibrary, extractDemo, manifest } from './helpers/library.js';
import { addClip, clipFromExtract, newCase } from '../../extension/lib/case.js';
import { logEvent, withNote } from '../../extension/lib/activity.js';
import { libraryAt } from '../../extension/lib/core.js';
import { collectFacts, diagnosticsReport } from '../../extension/lib/diagnostics.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const dom = new JSDOM(read('extension/ready/ready.html'), { url: 'moz-extension://x/ready/ready.html', pretendToBeVisual: true });
const { window } = dom;
const doc = window.document;
Object.assign(globalThis, { window, document: doc, Node: window.Node, location: window.location });
globalThis.CSS = { escape: (s) => String(s).replace(/[^\w-]/g, (c) => `\\${c}`) };
const lib = demoLibrary();
const set = demoSet();
const c = newCase(lib, ['hsr']);
{ const { profile, res } = extractDemo(lib, 'client-1042.html', 'cm/client-record'); addClip(c, lib, clipFromExtract(lib, profile, res)); }
logEvent(c, 'visit_page', { page: { type: 'cm/client-record@v3', pattern: 'p', url: 'http://localhost:8787/demo/client-1042.html' } });
c.log[0] = withNote(c.log[0], 'Maria was upset');
const local = {
  case: c,
  library: { current: set.commit, sets: { [set.commit]: set }, lastSync: { ok: false, at: '2026-10-19T09:00:00Z', error: 'Couldn’t reach http://secret-host.example/lib' } },
  settings: { library: { baseUrl: 'http://localhost:8787/demo/library/' } },
};
const session = { aiCredential: { baseUrl: 'https://gw.invalid/v1', key: 'sk-test-key' }, gatewayStatus: { ok: false, status: 401, at: 't' }, modelStatus: { state: 'failed', reason: 'hash', message: 'https://models.example/hf/x/config.json doesn’t match' }, capabilityFailures: { 'library-sync': 2 } };
const area = (d) => ({
  get: async (keys) => structuredClone(Object.fromEntries([keys].flat().filter((k) => k in d).map((k) => [k, d[k]]))),
  set: async (patch) => Object.assign(d, structuredClone(patch)),
  remove: async () => {},
});
let listener;
globalThis.browser = {
  storage: { local: area(local), session: area(session), managed: { get: async () => { throw new Error('Managed storage manifest not found'); } } },
  runtime: { id: 'x', getURL: (p) => p, getManifest: () => ({ version: '0.7.0' }), getBrowserInfo: async () => ({ name: 'Firefox', version: '128.0' }), onMessage: { addListener: (fn) => { listener = fn; } }, sendMessage: async (m) => listener(m, { id: 'x' }) },
  permissions: { contains: async ({ origins }) => !origins.includes('<all_urls>') },
};
Object.defineProperty(window.navigator, 'storage', { value: { estimate: async () => ({ quota: 5e9, usage: 1e8 }) } });
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.fetch = async (url) => {
  const path = String(url).replace('http://localhost:8787/demo/library/', '');
  return new Response(path === 'library.json' ? JSON.stringify(manifest) : read(`demo/library/${path}`));
};
registerStorageWriter();
await import('../../extension/ready/ready.js');
const tick = () => new Promise((r) => setTimeout(r, 5));
const until = async (fn, what) => { for (let i = 0; i < 300; i++) { const v = fn(); if (v) return v; await tick(); } throw new Error(`${what}: ${doc.body.textContent.slice(0, 400)}`); };

test('diagnostics never include page links, case values, notes or keys', async () => {
  const report = diagnosticsReport(await collectFacts({ libraryAt, policyKeysSet: async () => ['library.baseUrl'] }));
  for (const leak of ['Maria', 'Kowalska', 'QQ', 'client-1042', 'upset', 'sk-test-key', 'secret-host', 'models.example', 'http']) assert.ok(!report.includes(leak), `report holds ${leak}`);
  assert.match(report, /Firefox 128\.0/);
  assert.match(report, /Policy keys set: library\.baseUrl/);
  assert.match(report, new RegExp(`commit ${set.commit}`));
  assert.match(report, /Privacy model: failed \(hash\)/);
  assert.match(report, /Gateway: failed, HTTP 401/);
  assert.match(report, /library-sync ×2/);
});

test('the readiness page runs every check and gives a specific fix for each failure', async () => {
  const run = [...doc.querySelectorAll('button')].find((b) => b.textContent === 'Run the checks');
  run.click();
  await until(() => /Checks finished/.test(doc.getElementById('announce').textContent), 'checks');
  const card = (title) => [...doc.querySelectorAll('li.card')].find((li) => li.querySelector('h2').textContent === title);
  assert.match(card('Managed configuration loaded').textContent, /! Check.*No managed policy found/);
  assert.match(card('Forms library reachable and valid').textContent, new RegExp(`✓ Pass.*Commit ${set.commit}`));
  assert.match(card('AI gateway reachable with the key').textContent, /! Check.*Not set up/);
  assert.match(card('WebGPU adapter').textContent, /✕ Fail.*To fix:/);
  assert.match(card('Privacy model downloaded, started and test-scanned').textContent, /✕ Fail.*To fix:/);
  assert.match(card('Free storage').textContent, /✓ Pass/);
  assert.match(card('Capture permission').textContent, /! Check/);
  assert.match(doc.body.textContent, /Checked by a person before rollout/);
  assert.match(doc.body.textContent, /huggingface\.co and its download CDN by default/);
});

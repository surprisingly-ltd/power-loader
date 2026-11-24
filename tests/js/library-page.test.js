// The Library page in jsdom: lists, a new version, test-before-use, checked export and conflicts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import '../../extension/lib/extract.js';
import { registerStorageWriter } from '../../extension/lib/storage.js';
import { demoSet, demoLibrary } from './helpers/library.js';
import { judgeTest, recordTest } from '../../extension/lib/drafts.js';
import { contentHash } from '../../extension/lib/hash.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const dom = new JSDOM(read('extension/library/library.html'), { url: 'https://extension.invalid/library/library.html', pretendToBeVisual: true });
const { window } = dom;
const doc = window.document;
Object.assign(globalThis, { window, document: doc, DOMParser: window.DOMParser, Node: window.Node, location: window.location });
globalThis.CSS = { escape: (s) => String(s).replace(/[^\w-]/g, (c) => `\\${c}`) };
const set = demoSet();
const local = { library: { current: set.commit, sets: { [set.commit]: set }, lastSync: { at: '2026-10-19T09:12:00Z', ok: true } }, settings: { library: { baseUrl: 'http://localhost:8787/demo/library/' } } };
const listeners = [];
const area = (data) => ({
  get: async (keys) => structuredClone(Object.fromEntries([keys].flat().filter((k) => k in data).map((k) => [k, data[k]]))),
  set: async (patch) => { Object.assign(data, structuredClone(patch)); queueMicrotask(() => listeners.forEach((fn) => fn(Object.fromEntries(Object.keys(patch).map((k) => [k, {}])), 'local'))); },
  remove: async () => {},
});
const downloads = [];
let runtimeListener;
globalThis.browser = {
  storage: { local: area(local), session: area({}), onChanged: { addListener: (fn) => listeners.push(fn) } },
  runtime: { id: 'x', getURL: (p) => p, getManifest: () => ({ version: '0.7.0' }), onMessage: { addListener: (fn) => { runtimeListener = fn; } }, sendMessage: async (m) => runtimeListener(m, { id: 'x' }) },
  tabs: { get: async () => { throw new Error('gone'); }, getCurrent: async () => ({ id: 9 }) },
  downloads: { download: async (o) => { downloads.push(o); return 1; } },
  sidebarAction: { open: async () => {} },
};
globalThis.URL.createObjectURL = () => 'blob:x';
globalThis.URL.revokeObjectURL = () => {};
registerStorageWriter();
await import('../../extension/library/library.js');

const tick = () => new Promise((r) => setTimeout(r, 5));
const until = async (fn, what) => { for (let i = 0; i < 200; i++) { const v = fn(); if (v) return v; await tick(); } throw new Error(`${what} did not settle: ${doc.body.textContent.slice(0, 500)}`); };
const button = (label, root = doc) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === label);

test('the library lists page profiles, fill profiles, forms and drafts as tabs', async () => {
  await until(() => doc.querySelector('[role=tab]'), 'tabs');
  assert.deepEqual([...doc.querySelectorAll('[role=tab]')].map((t) => t.textContent), ['Page profiles (4)', 'Fill profiles (2)', 'Forms (3)', 'Your drafts (0)']);
  assert.match(doc.body.textContent, /http:\/\/localhost:8787\/demo\/client-\{clientId\}\.html/);
});

test('a published profile shows its fields and history, and makes a new version as a draft that is not in use', async () => {
  button('Client record').click();
  await until(() => button('Make a new version'), 'detail');
  assert.match(doc.body.textContent, /Read preferred language/);
  assert.match(doc.body.textContent, /table\.details label\(First name\)/);
  button('Make a new version').click();
  await until(() => /Client record v4/.test(doc.querySelector('h2')?.textContent || ''), 'draft detail');
  assert.equal(local.profileDrafts.length, 1);
  assert.deepEqual(local.profileDrafts[0].base, { id: 'cm/client-record', version: 'v3', commit: set.commit });
  const use = doc.querySelector('[data-key=use-here]');
  assert.equal(use.disabled, true, 'not usable until tested');
  assert.match(doc.body.textContent, /Not tested/);
});

test('export is blocked until the draft passes its checks, then saves a hashed file', async () => {
  button('Export').click();
  let dlg = await until(() => doc.querySelector('[role=dialog]'), 'export dialog');
  assert.match(dlg.textContent, /✕ Failed Not tested yet/);
  assert.equal(button('Export', dlg), undefined);
  button('Close', dlg).click();
  // Test it on the demo page with the real engine, as the sidebar would.
  const lib = demoLibrary();
  const d = local.profileDrafts[0];
  const page = new JSDOM(read('demo/client-1042.html'), { url: 'http://localhost:8787/demo/client-1042.html' }).window.document;
  const probes = Object.fromEntries(Object.entries(d.profile.fields).map(([k, s]) => [k, globalThis.PowerLoaderExtract.probe(page, s)]));
  recordTest(d, judgeTest(d, probes, { url: 'http://localhost:8787/demo/client-1042.html', lib }));
  await browser.storage.local.set({ profileDrafts: [d] });
  await until(() => !doc.querySelector('[data-key=use-here]').disabled, 'usable');
  button('Export').click();
  dlg = await until(() => doc.querySelector('[role=dialog]'), 'export dialog');
  assert.equal([...dlg.querySelectorAll('.checks li')].filter((li) => /Passed/.test(li.textContent)).length, 4);
  assert.match(dlg.textContent, /profiles\/pages\/cm\/client-record\.json/);
  button('Export', dlg).click();
  await until(() => local.profileDrafts[0].exported, 'exported');
  assert.equal(downloads[0].filename, 'cm--client-record.v4.json');
  const { exportBody } = await import('../../extension/lib/drafts.js');
  assert.equal(local.profileDrafts[0].exported.hash, await contentHash(exportBody(local.profileDrafts[0])));
});

test('a differing published version asks before anything is deleted', async () => {
  const d = local.profileDrafts[0];
  d.conflict = { version: 'v4', hash: 'other', dismissed: false };
  await browser.storage.local.set({ profileDrafts: [d] });
  const alert = await until(() => doc.querySelector('[role=alert]'), 'conflict');
  assert.match(alert.textContent, /v4 was published, but it isn’t the same as your draft/);
  assert.ok(button('Use published', alert) && button('Compare', alert));
  button('Keep using my draft', alert).click();
  await until(() => local.profileDrafts[0].conflict.dismissed, 'kept');
  assert.equal(local.profileDrafts.length, 1);
});

test('a form without a fill profile offers to make one', async () => {
  button('Back to the list').click();
  await until(() => doc.querySelector('[role=tab]'));
  [...doc.querySelectorAll('[role=tab]')].find((t) => t.textContent.startsWith('Forms')).click();
  await until(() => button('Make a fill profile'), 'forms tab');
  assert.match(doc.body.textContent, /Leaving the NI number box looks the claimant up/);
  button('Make a fill profile').click();
  await until(() => local.profileDrafts.length === 2, 'fill draft');
  assert.equal(local.profileDrafts[1].kind, 'fill');
  assert.deepEqual(local.profileDrafts[1].profile.form, { id: 'coc', version: 'v6' });
});

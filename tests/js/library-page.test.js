// The Library page in jsdom: the library's templates and forms, read-only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import '../../extension/lib/extract.js';
import { registerStorageWriter } from '../../extension/lib/storage.js';
import { demoSet } from './helpers/library.js';

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

test('the library lists its page templates, fill templates and forms as tabs, read-only', async () => {
  await until(() => doc.querySelector('[role=tab]'), 'tabs');
  assert.deepEqual([...doc.querySelectorAll('[role=tab]')].map((t) => t.textContent), ['Page templates (13)', 'Fill templates (3)', 'Forms (4)']);
  assert.match(doc.body.textContent, /http:\/\/localhost:8787\/demo\/client-\{clientId\}\.html/);
  assert.match(doc.body.textContent, /switch to Build, open the flow/, 'templates are changed in a flow');
  assert.doesNotMatch(doc.body.textContent, /draft/i);
});

test('a published template shows its fields and history, and offers no way to change it here', async () => {
  button('Client record').click();
  await until(() => button('Back to the list'), 'detail');
  assert.match(doc.body.textContent, /Read preferred language/);
  assert.match(doc.body.textContent, /table\.details label\(First name\)/);
  assert.equal(button('Make a new version'), undefined);
  button('Back to the list').click();
  await until(() => button('Client record'), 'list again');
});

test('a form without a fill template says it is made in a flow', async () => {
  [...doc.querySelectorAll('[role=tab]')].find((t) => /^Forms/.test(t.textContent)).click();
  await until(() => /Change of circumstances/.test(doc.body.textContent), 'forms');
  assert.match(doc.body.textContent, /None yet: it is made in a flow that fills this form/);
  assert.equal(doc.querySelector('[data-key^="make-fill-"]'), null);
});

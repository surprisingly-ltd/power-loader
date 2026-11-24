import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { registerStorageWriter } from '../../extension/lib/storage.js';
import { demoSet, demoLibrary } from './helpers/library.js';
import { newCase } from '../../extension/lib/case.js';
import { archiveLog, logEvent } from '../../extension/lib/activity.js';
import { visitEvent } from '../../extension/lib/visits.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const dom = new JSDOM(read('extension/log/log.html'), { url: 'moz-extension://x/log/log.html', pretendToBeVisual: true });
const { window } = dom;
const doc = window.document;
Object.assign(globalThis, { window, document: doc, Node: window.Node, location: window.location });
globalThis.CSS = { escape: (s) => String(s).replace(/[^\w-]/g, (c) => `\\${c}`) };
const lib = demoLibrary();
const set = demoSet();
const old = newCase(lib, ['dhp']);
logEvent(old, 'visit_page', visitEvent(old, lib, { url: 'http://localhost:8787/demo/rent-account-1042.html' }), { at: '2026-10-18T09:00:00Z' });
logEvent(old, 'clip_page', { page: { type: 'harbour-homes/rent-account@v1' }, detail: '11 items' });
const open = newCase(lib, ['hsr']);
logEvent(open, 'visit_page', visitEvent(open, lib, { url: 'http://localhost:8787/demo/client-1042.html' }));
const local = { library: { current: set.commit, sets: { [set.commit]: set } }, case: open, processLog: [archiveLog(old, 'finished')] };
const listeners = [];
const area = (d) => ({
  get: async (keys) => structuredClone(Object.fromEntries([keys].flat().filter((k) => k in d).map((k) => [k, d[k]]))),
  set: async (patch) => { Object.assign(d, structuredClone(patch)); queueMicrotask(() => listeners.forEach((fn) => fn(Object.fromEntries(Object.keys(patch).map((k) => [k, {}])), 'local'))); },
  remove: async () => {},
});
const saved = [];
let listener;
globalThis.browser = {
  storage: { local: area(local), session: area({}), onChanged: { addListener: (fn) => listeners.push(fn) } },
  runtime: { id: 'x', getURL: (p) => p, onMessage: { addListener: (fn) => { listener = fn; } }, sendMessage: async (m) => listener(m, { id: 'x' }) },
  downloads: { download: async (o) => { saved.push(o); return 1; } },
};
globalThis.URL.createObjectURL = (blob) => { saved.blob = blob; return 'blob:x'; };
globalThis.URL.revokeObjectURL = () => {};
registerStorageWriter();
await import('../../extension/log/log.js');
const tick = () => new Promise((r) => setTimeout(r, 5));
const until = async (fn, what) => { for (let i = 0; i < 200; i++) { const v = fn(); if (v) return v; await tick(); } throw new Error(`${what}: ${doc.body.textContent.slice(0, 300)}`); };
const button = (label, root = doc) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === label);

test('the log page lists open and kept events with patterns, "Until next", and filters', async () => {
  await until(() => doc.querySelector('table'), 'table');
  assert.match(doc.body.textContent, /3 events from 2 cases/);
  assert.match(doc.body.textContent, /client-\{clientId\}\.html/);
  assert.doesNotMatch(doc.body.textContent, /client-1042/);
  assert.match(doc.querySelector('thead').textContent, /Until next/);
  const sel = doc.querySelector('[data-key=actF]');
  sel.value = 'clip_page';
  sel.dispatchEvent(new window.Event('change'));
  await until(() => /1 item shown/.test(doc.body.textContent), 'filtered');
  sel.value = '';
  sel.dispatchEvent(new window.Event('change'));
});

test('a note is kept locally and left out of a download unless chosen', async () => {
  button('Add note').click();
  const box = await until(() => doc.querySelector('textarea[id^=note-]'), 'note box');
  assert.match(doc.body.textContent, /Don’t write client details/);
  box.value = 'Slow page today';
  box.dispatchEvent(new window.Event('input'));
  button('Save').click();
  await until(() => local.processLog[0].events.some((e) => e.note === 'Slow page today'), 'note saved');
  button('Download CSV').click();
  const dlg = await until(() => doc.querySelector('[role=dialog]'), 'download dialog');
  assert.doesNotMatch(dlg.querySelector('pre').textContent, /Slow page today/);
  dlg.querySelector('input[type=checkbox]').click();
  await until(() => /Slow page today/.test(doc.querySelector('[role=dialog] pre').textContent), 'notes included');
  button('Save file', doc.querySelector('[role=dialog]')).click();
  await until(() => saved.length, 'saved');
  assert.match(saved[0].filename, /^power-loader-activity-\d{4}-\d{2}-\d{2}\.csv$/);
});

test('selected items are removed after confirming, from kept and open logs alike', async () => {
  for (const key of [...doc.querySelectorAll('input[data-key^=sel-]')].map((b) => b.dataset.key)) { doc.querySelector(`[data-key="${key}"]`).click(); await tick(); }
  await until(() => button('Remove 3 items'), 'remove');
  button('Remove 3 items').click();
  const dlg = await until(() => doc.querySelector('[role=dialog]'), 'confirm');
  button('Remove 3 items', dlg).click();
  await until(() => !local.processLog[0].events.length && !local.case.log.length, 'removed');
  assert.equal(local.processLog[0].partial, true);
  assert.equal(local.case.purged, 1);
});

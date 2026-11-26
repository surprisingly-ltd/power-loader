// The Templates tab, in Build: every page and form the flows use, grouped by system, with the flows that use
// each; links both ways between a flow's page and its template; Not in a flow, with Make a flow from it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import '../../extension/lib/extract.js';
import { demoSet } from './helpers/library.js';
import { indexLibrary } from '../../extension/lib/library.js';
import { registerStorageWriter } from '../../extension/lib/storage.js';

const set = demoSet();
// The demo library without its Change of circumstances flow: that form is then in no flow.
delete set.files['flows/change-of-circumstances.flow.json'];
set.manifest = { ...set.manifest, files: set.manifest.files.filter((f) => f.path !== 'flows/change-of-circumstances.flow.json') };
const lib = indexLibrary(set);

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const dom = new JSDOM(read('extension/sidebar/sidebar.html'), { url: 'https://extension.invalid/sidebar/sidebar.html', pretendToBeVisual: true });
const { window } = dom;
const doc = window.document;
Object.assign(globalThis, { window, document: doc, DOMParser: window.DOMParser, Node: window.Node });
globalThis.CSS = window.CSS?.escape ? window.CSS : { escape: (s) => String(s).replace(/[^\w-]/g, (ch) => `\\${ch}`) };
const events = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, removeListener() {} });
const changed = events();
const local = { library: { current: set.commit, sets: { [set.commit]: set } }, settings: { welcomed: '2026-11-24T09:00:00.000Z', mode: 'build' }, flows: [] };
const session = {};
const area = (data, name) => ({
  get: async (keys) => structuredClone(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in data).map((k) => [k, data[k]]))),
  set: async (patch) => {
    const changes = Object.fromEntries(Object.keys(patch).map((k) => [k, { oldValue: data[k], newValue: structuredClone(patch[k]) }]));
    Object.assign(data, structuredClone(patch));
    queueMicrotask(() => changed.listeners.forEach((fn) => fn(changes, name)));
  },
  remove: async (keys) => { for (const k of [keys].flat()) delete data[k]; },
  clear: async () => { for (const k of Object.keys(data)) delete data[k]; },
});
const page = { id: 1, windowId: 1, active: true, url: 'http://localhost:8787/demo/index.html', title: 'Demo' };
const runtime = events();
globalThis.browser = {
  storage: { local: area(local, 'local'), session: area(session, 'session'), onChanged: changed },
  runtime: { id: 'extension', getURL: (p) => p, getManifest: () => ({ version: 'test' }), onMessage: runtime, sendMessage: async () => undefined },
  windows: { getCurrent: async () => ({ id: 1 }) },
  permissions: { contains: async () => true, request: async () => true, onAdded: events() },
  scripting: { executeScript: async () => [] },
  tabs: { query: async () => [page], get: async () => page, onUpdated: events(), onActivated: events(), update: async () => {}, sendMessage: async (id, msg) => (msg.type === 'powerloader:ping' ? true : msg.type === 'powerloader:applies' ? msg.profiles.map(() => false) : null) },
};
globalThis.fetch = async (url) => new Response(read(`extension/${url}`));
globalThis.Worker = class { postMessage() {} terminate() {} };
registerStorageWriter();
await import('../../extension/sidebar/sidebar.js');

const tick = () => new Promise((r) => setTimeout(r, 5));
const until = async (fn, what = 'UI') => { for (let i = 0; i < 300; i++) { const v = fn(); if (v) return v; await tick(); } throw new Error(`${what} did not settle: ${doc.body.textContent.slice(0, 600)}`); };
const byKey = (k) => doc.querySelector(`[data-key="${k}"]`);
const tab = (name) => (name === 'Flows' ? byKey('mode-build') : [...doc.querySelectorAll('[role=tab]')].find((t) => t.textContent === name)).click();
const tabNamed = (name) => [...doc.querySelectorAll('[role=tab]')].find((t) => t.textContent === name);

test('the Templates tab lists the pages and forms the flows use, by system, each with its flows', async () => {
  (await until(() => tabNamed('Templates'), 'Build tabs')).click();
  await until(() => /Pages · /.test(doc.body.textContent), 'templates');
  assert.match(doc.body.textContent, /Forms · 3/);
  assert.match(doc.body.textContent, /localhost:8787/, 'grouped by system');
  const cs = byKey('tpl-page_cm_case');
  assert.ok(cs, 'the case page');
  assert.match(cs.textContent, /Used in .*Step 2 of Rent support review \(library\)/);
  assert.match(cs.textContent, /Step 2 of Rent support review \(messages as data\) \(library\)/);
  // Not in a flow: the library's form and pages no flow uses, never started on their own.
  const loose = byKey('tpl-loose');
  assert.match(loose.textContent, /Change of circumstances/);
  assert.match(loose.textContent, /Case notes/);
  // Search over names and systems.
  const box = byKey('tpl-search');
  box.value = 'tenancy';
  box.dispatchEvent(new window.Event('input', { bubbles: true }));
  await until(() => !byKey('tpl-page_cm_case'), 'filtered');
  assert.ok(byKey('tpl-page_harbour-homes_tenancy'));
  box.value = '';
  box.dispatchEvent(new window.Event('input', { bubbles: true }));
  await until(() => byKey('tpl-page_cm_case'), 'all again');
});

test('one template, opened: its address, what it reads, its flows, and a flow’s link opens the flow at the page', async () => {
  byKey('tpl-open-page_cm_case').click();
  const d = await until(() => byKey('tpl-detail'), 'detail');
  assert.match(d.textContent, /Client ID/);
  assert.match(byKey('tpl-uses').textContent, /Step 2 of Rent support review/);
  assert.equal(byKey('tpl-go'), null, 'an address with a wildcard isn’t opened');
  // A library flow's step opens its read-only view on the Flows tab.
  byKey('tpl-uses').querySelector('button').click();
  await until(() => tabNamed('Flows').getAttribute('aria-selected') === 'true' && doc.querySelector('[data-key^="fl-lib-detail-"]'), 'the flow, opened');
});

test('a flow on this computer: its page’s Template link opens the template, and the template’s link opens the page', async () => {
  byKey(`fl-lib-copy-f-lib-rent-support-review`).click();
  await until(() => local.flows.length === 1 && byKey('fl-try'), 'copied and open');
  const copy = local.flows[0];
  const caseP = copy.pages.find((p) => p.profileId === 'cm/case');
  byKey(`fl-tpl-${caseP.id}`).click();
  const d = await until(() => tabNamed('Templates').getAttribute('aria-selected') === 'true' && byKey('tpl-detail'), 'template');
  assert.match(d.textContent, /Case/);
  const mine = [...byKey('tpl-uses').querySelectorAll('button')].find((b) => /Rent support review$/.test(b.textContent.trim()) && !/library/.test(b.textContent));
  mine.click();
  await until(() => byKey('fl-step-of') && byKey('fl-page-name')?.value === caseP.name, 'the flow at that page');
  assert.match(byKey('fl-step-of').textContent, /Step 2 of Rent support review/);
  byKey('fl-tpl').click();
  await until(() => byKey('tpl-detail'), 'and back to the template');
  byKey('tpl-back').click();
});

test('Make a flow from it: a form no flow uses becomes a flow on this computer', async () => {
  (await until(() => byKey('tpl-make-form_coc'), 'not in a flow')).click();
  await until(() => local.flows.length === 2, 'made');
  const made = local.flows[1];
  assert.equal(made.name, 'Change of circumstances');
  assert.ok(made.pages.some((p) => p.role === 'output' && p.formId === 'coc'));
  await until(() => tabNamed('Flows').getAttribute('aria-selected') === 'true' && byKey('fl-try'), 'opened in Build');
  tabNamed('Templates').click();
  await until(() => byKey('tpl-form_coc') && !byKey('tpl-make-form_coc'), 'now in a flow');
  // A case page can be made into a flow too.
  byKey('tpl-make-page_cm_case-notes').click();
  await until(() => local.flows.length === 3, 'made from a page');
  assert.ok(local.flows[2].pages.some((p) => p.role === 'input' && p.profileId === 'cm/case-notes'));
});

// The Inbox triage in the sidebar, from the demo library's own flow: no form and no reference, the card on the
// team inbox says how many messages a press will fetch (the page's links, read on arrival), a press fetches
// them from the tab (scripting.executeScript stubbed with the generated pages), the open urgent referrals are
// listed on the card and marked on the page. jsdom, the real storage writer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import '../../extension/lib/extract.js';
import { demoSet } from './helpers/library.js';
import { indexLibrary } from '../../extension/lib/library.js';
import { libraryFlow } from '../../extension/lib/flows.js';
import { registerStorageWriter } from '../../extension/lib/storage.js';
import { REFERRALS, buildData, buildFiles } from '../../tools/build-demo-systems.mjs';

const set = demoSet();
const lib = indexLibrary(set);
const files = buildFiles(buildData());
const B = 'http://localhost:8787/demo/';
const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const dom = new JSDOM(read('extension/sidebar/sidebar.html'), { url: 'https://extension.invalid/sidebar/sidebar.html', pretendToBeVisual: true });
const { window } = dom;
const doc = window.document;
Object.assign(globalThis, { window, document: doc, DOMParser: window.DOMParser, Node: window.Node });
globalThis.CSS = window.CSS?.escape ? window.CSS : { escape: (s) => String(s).replace(/[^\w-]/g, (ch) => `\\${ch}`) };
const events = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, removeListener() {} });
const changed = events();
const local = { library: { current: set.commit, sets: { [set.commit]: set } }, settings: { welcomed: '2026-11-24T09:00:00.000Z' }, flows: [] };
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
let page = { id: 1, windowId: 1, active: true, url: `${B}index.html`, title: 'Demo' };
const pageDoc = (url) => new JSDOM(files[url.slice(B.length).split(/[?#]/)[0]] || '<html><body></body></html>', { url }).window.document;
const E = globalThis.PowerLoaderExtract;
const fetched = [];
const annotated = [];
const tabsActivated = events();
globalThis.browser = {
  storage: { local: area(local, 'local'), session: area(session, 'session'), onChanged: changed },
  runtime: { id: 'extension', getURL: (p) => p, getManifest: () => ({ version: 'test' }), onMessage: events(), sendMessage: async () => undefined },
  windows: { getCurrent: async () => ({ id: 1 }) },
  permissions: { contains: async () => true, request: async () => true, onAdded: events() },
  scripting: {
    executeScript: async ({ func, args }) => {
      if (func?.name !== 'fetchInPage') return [];
      const { url, atUrl } = args[0];
      if (atUrl !== page.url) return [{ result: { error: 'moved' } }];
      fetched.push(url);
      const rel = url.slice(B.length);
      return [{ result: rel in files ? { status: 200, type: 'basic', redirected: false, url, contentType: 'text/html', bytes: new TextEncoder().encode(files[rel]) } : { status: 404, type: 'basic', url, contentType: 'text/html' } }];
    },
  },
  tabs: {
    query: async () => [page], get: async () => page, onUpdated: events(), onActivated: tabsActivated, update: async (id, { url }) => { page = { ...page, url }; },
    sendMessage: async (id, msg) => {
      const d = pageDoc(page.url);
      if (msg.type === 'powerloader:ping') return true;
      if (msg.type === 'powerloader:applies') return msg.profiles.map((p) => E.profileApplies(p, page.url, d));
      if (msg.type === 'powerloader:extract') return { ...E.extract(d, msg.profile, { baseUrl: page.url }), url: page.url, title: d.title };
      if (msg.type === 'powerloader:annotate') { annotated.push(msg.notes); return { shown: msg.notes.map((n) => n.id), missing: [] }; }
      if (msg.type === 'powerloader:pageText') return { text: d.body.textContent, url: page.url, title: d.title };
      if (msg.type === 'powerloader:values') return [];
      return null;
    },
  },
};
globalThis.fetch = async (url) => new Response(read(`extension/${url}`));
globalThis.Worker = class { postMessage() {} terminate() {} };
registerStorageWriter();
await import('../../extension/sidebar/sidebar.js');

const tick = () => new Promise((r) => setTimeout(r, 5));
const until = async (fn, what = 'UI') => { for (let i = 0; i < 400; i++) { const v = fn(); if (v) return v; await tick(); } throw new Error(`${what} did not settle: ${doc.body.textContent.slice(0, 800)}`); };
const byKey = (k) => doc.querySelector(`[data-key="${k}"]`);
const go = async (file) => { page = { ...page, url: `${B}${file}` }; tabsActivated.listeners.forEach((fn) => fn({ windowId: 1, tabId: 1 })); await tick(); await tick(); };
const triage = libraryFlow(lib, 'flows/inbox-triage.flow.json');

test('the inbox triage: Fetch 25 messages, the 4 open urgent referrals listed and marked, no form, a label of its own', async () => {
  (await until(() => byKey(`start-flow-${triage.id}`), 'the library flow')).click();
  const dlg = await until(() => doc.querySelector('[role=dialog]'), 'start confirmation');
  [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Start case').click();
  await until(() => local.case, 'case started');
  assert.deepEqual(local.case.forms, []);
  assert.equal(local.case.ref, '');
  assert.match(local.case.log[0].detail, /flow · no form/);
  await go('messages/index.html');
  const run = await until(() => byKey('fetch-run')?.textContent === 'Fetch 25 messages' && byKey('fetch-run'), 'the count on the button');
  assert.equal(fetched.length, 0, 'nothing is fetched until the press');
  assert.match(byKey('fetch-state-' + triage.pages.find((p) => p.role === 'fetch').fetch.requests[0].id).textContent, /25 links on this page/);
  assert.ok(!byKey('fp-rsr') && !doc.querySelector('.fp'), 'no form, no progress');
  run.click();
  const title = await until(() => byKey('fetch-show-title'), 'the matches');
  assert.equal(fetched.length, 25);
  assert.ok(fetched.every((u) => u.startsWith(`${B}messages/message/`)));
  assert.equal(title.textContent, `Open urgent referrals: ${REFERRALS.page1.urgentOpen}`);
  assert.match(byKey('fetch-show-others').textContent, /^Read 25 of 25 messages\. 21 others weren’t open urgent referrals\.$/);
  assert.equal(doc.querySelectorAll('[data-key^="fetch-match-open-"]').length, 4);
  assert.equal(byKey('fetch-match-open-0').textContent, 'Open the message');
  // One group in the clip list, not 25 lines; and the markers on the page.
  assert.match(byKey(`clip-group-${triage.pages.find((p) => p.role === 'fetch').fetch.requests[0].id}`).textContent, /25 messages fetched by Team inbox/);
  const marks = await until(() => annotated.findLast((n) => n.some((x) => x.type === 'marker')), 'markers drawn');
  assert.equal(marks.filter((x) => x.type === 'marker').length, 4);
  assert.ok(marks.every((x) => x.nodes.join('') === 'Urgent, open'));
  assert.match(doc.body.textContent, /Inbox triage, \d{1,2} [A-Z][a-z]{2}/, 'the case is labelled with the flow and the day');
});

// A fetch step in the sidebar: the start confirmation lists it, the Steps card fetches its page from the
// trigger tab (scripting.executeScript stubbed with the demo pages), shows what it added and where it came
// from, and says in words when background reading is off. jsdom, the real storage writer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import '../../extension/lib/extract.js';
import { registerStorageWriter } from '../../extension/lib/storage.js';
import {
  addField, addPage, addRequest, bindPage, flowLib, mapPick, newFlow, pagesOf, recordFetchedTest, removePage, setRequest, setThen,
} from '../../extension/lib/flows.js';
import { judgeFillTest, judgeTest, recordTest } from '../../extension/lib/drafts.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const dom = new JSDOM(read('extension/sidebar/sidebar.html'), { url: 'https://extension.invalid/sidebar/sidebar.html', pretendToBeVisual: true });
const { window } = dom;
const doc = window.document;
Object.assign(globalThis, { window, document: doc, DOMParser: window.DOMParser, Node: window.Node });
globalThis.CSS = window.CSS?.escape ? window.CSS : { escape: (s) => String(s).replace(/[^\w-]/g, (c) => `\\${c}`) };
const events = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, removeListener() {} });
const changed = events();
const base = 'http://localhost:8787/demo/';
const E = globalThis.PowerLoaderExtract;
const pageDoc = (url) => new JSDOM(read(`demo/${url.split('/demo/')[1]}`), { url }).window.document;

// The flow: a fetch step on the case list fetches the client record, then the caseworker goes to the form.
function makeFlow() {
  const flow = newFlow({ name: 'Client check' });
  const out = pagesOf(flow, 'output')[0];
  const unused = pagesOf(flow, 'input')[0];
  bindPage(flow, out.id, { url: `${base}dhp.html`, title: 'Discretionary housing payment' });
  const last = addField(flow, { label: 'Last name' });
  mapPick(out, last, '#d-lastname');
  const step = addPage(flow, 'fetch');
  bindPage(flow, step.id, { url: `${base}cases.html`, title: 'Cases' });
  step.name = 'Start case';
  const { request, page } = addRequest(flow, step.id, { name: 'Client details' });
  bindPage(flow, page.id, { url: `${base}client-1042.html`, title: 'Client' });
  mapPick(page, last, 'table.details label(Last name)');
  setRequest(flow, step.id, request.id, { url: `${base}client-{ref}.html` });
  setThen(step, { to: out.id });
  removePage(flow, unused.id);
  const lib = flowLib(flow);
  const dhp = pageDoc(`${base}dhp.html`);
  recordTest(out.draft, judgeFillTest(out.draft, Object.fromEntries(Object.keys(out.draft.profile.fields).map((b) => [b, E.probe(dhp, b)])), { url: `${base}dhp.html`, lib }));
  const client = pageDoc(`${base}client-1042.html`);
  recordTest(page.draft, judgeTest(page.draft, Object.fromEntries(Object.entries(page.draft.profile.fields).map(([k, s]) => [k, E.probe(client, s)])), { url: `${base}client-1042.html`, lib }));
  recordFetchedTest(page.draft, { ok: true });
  return flow;
}

const local = { settings: { welcomed: '2026-11-24T09:00:00.000Z' }, flows: [makeFlow()] };
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
let page = { id: 1, windowId: 1, active: true, url: `${base}index.html`, title: 'Demo' };
const runtime = events(), tabsUpdated = events(), tabsActivated = events();
// What the trigger tab is asked to run, and what the demo system answers.
const scripts = [];
let answer = null; // a page to answer with instead of the demo page: one built after it loads
globalThis.browser = {
  storage: { local: area(local, 'local'), session: area(session, 'session'), onChanged: changed },
  runtime: {
    id: 'extension', getURL: (p) => p, getManifest: () => ({ version: 'test' }), onMessage: runtime,
    sendMessage: async (msg) => { const out = await Promise.all(runtime.listeners.map((fn) => fn(msg, { id: 'extension' }))); return out.find((x) => x !== undefined); },
  },
  windows: { getCurrent: async () => ({ id: 1 }) },
  permissions: { contains: async () => true, request: async () => true, onAdded: events() },
  scripting: {
    executeScript: async ({ target, world, func, args }) => {
      scripts.push({ target, world, name: func?.name, args });
      if (func?.name !== 'fetchInPage') return [];
      const { url, atUrl } = args[0];
      if (atUrl !== page.url) return [{ result: { error: 'moved' } }];
      const html = answer ?? read(`demo/${url.split('/demo/')[1]}`);
      return [{ result: { status: 200, type: 'basic', redirected: false, url, contentType: 'text/html', bytes: new TextEncoder().encode(html) } }];
    },
  },
  tabs: {
    query: async () => [page], get: async () => page, onUpdated: tabsUpdated, onActivated: tabsActivated,
    update: async (id, { url }) => { page = { ...page, url }; },
    sendMessage: async (id, msg) => {
      const d = pageDoc(page.url);
      if (msg.type === 'powerloader:ping') return true;
      if (msg.type === 'powerloader:applies') return msg.profiles.map((p) => E.profileApplies(p, page.url, d));
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
const until = async (fn, what = 'UI') => { for (let i = 0; i < 200; i++) { const v = fn(); if (v) return v; await tick(); } throw new Error(`${what} did not settle: ${doc.body.textContent.slice(0, 800)}`); };
const byKey = (k) => doc.querySelector(`[data-key="${k}"]`);
const button = (label) => [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
const go = async (file) => {
  page = { ...page, url: `${base}${file}` };
  tabsActivated.listeners.forEach((fn) => fn({ windowId: 1, tabId: 1 }));
  await tick(); await tick();
};
const type = (el, value, ev = 'change') => { el.value = value; el.dispatchEvent(new window.Event(ev, { bubbles: true })); };
const flow = local.flows[0];

test('starting a case lists the fetch step and the system it fetches from', async () => {
  (await until(() => byKey(`start-flow-${flow.id}`), 'flow start card')).click();
  const dlg = await until(() => doc.querySelector('[role=dialog]'), 'start confirmation');
  assert.match(dlg.textContent, /Start case fetches pages in the background from localhost:8787 when you press its button/);
  [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Start case').click();
  await until(() => local.case, 'case started');
});

test('the Steps card fetches the page from the trigger tab and shows what it added', async () => {
  await go('client-1042.html');
  // Not on its page: the step's main button goes there, and the fetch waits until it's on it.
  const goThere = await until(() => byKey('step-open'), 'the way to the step’s page');
  assert.equal(goThere.textContent, 'Go to Start case');
  assert.equal(byKey('fetch-step'), null);
  await go('cases.html');
  await until(() => /you’re on it now/.test(doc.body.textContent) && byKey('fetch-run'), 'on the trigger page');
  assert.equal(byKey('fetch-run').disabled, true, 'the address needs the case reference');
  assert.match(byKey('step-needs').textContent, /To go on, Power Loader needs the Case reference/);
  type(byKey('step-var-ref'), '1042', 'input');
  byKey('step-var-ref-use').click();
  await until(() => local.case.ref === '1042' && byKey('fetch-run') && !byKey('fetch-run').disabled, 'ready to fetch');
  assert.equal(byKey('fetch-run').textContent, 'Fetch 1 page');
  byKey('fetch-run').click();
  await until(() => local.case.clips.length === 1 && byKey('fetch-summary'), 'fetched');
  const sent = scripts.find((s) => s.name === 'fetchInPage');
  assert.equal(sent.world, 'ISOLATED', 'way B: the content script’s world');
  assert.deepEqual(sent.target, { tabId: 1, frameIds: [0] });
  assert.equal(sent.args[0].url, `${base}client-1042.html`);
  assert.equal(sent.args[0].atUrl, `${base}cases.html`);
  const clip = local.case.clips[0];
  assert.equal(clip.kind, 'fetch');
  assert.equal(clip.values.lastName, 'Kowalska');
  assert.match(byKey('fetch-summary').textContent, /^Fetched 1 page: 1 value added\./);
  assert.match(byKey(`fetch-state-${flow.pages.find((p) => p.role === 'fetch').fetch.requests[0].id}`).textContent, /1 value/);
  assert.ok(byKey(`fetched-${clip.id}`) && /fetched by Start case/.test(byKey(`fetched-${clip.id}`).textContent), 'the clip says where it came from');
  // Done: the step's one main button goes on to the next step, and the fetch step's own way on isn't repeated.
  assert.match(byKey('step-next').textContent, /^Next: Discretionary housing payment/);
  assert.equal(byKey('fetch-then'), null);
  assert.equal(doc.querySelectorAll('[data-key="step-body"] .primary').length, 1);
  assert.ok(local.case.log.some((e) => e.activity === 'fetch_page'));
});

test('with background reading off, the step says so and the caseworker opens each page to clip it', async () => {
  [...doc.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Settings').click();
  const box = await until(() => byKey('sa-background-on'), 'the switch');
  assert.equal(box.checked, true, 'on by default');
  assert.match(byKey('sa-background').textContent, /Read pages in the background \(pages you’re not on\)/);
  box.checked = false;
  box.dispatchEvent(new window.Event('change', { bubbles: true }));
  await until(() => local.settings.siteAccess?.backgroundReading === false, 'saved');
  [...doc.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Case').click();
  const off = await until(() => byKey('fetch-off'), 'off notice');
  assert.match(off.textContent, /You’ve turned off reading pages in the background in Settings.*open each page and clip it yourself/);
  assert.equal(byKey('fetch-run').disabled, true);
  const before = scripts.length;
  byKey('fetch-run').click();
  await tick();
  assert.equal(scripts.length, before, 'nothing is fetched');
});

test('the editor previews each request and tests its page as fetched, from this tab, with sample values', async () => {
  const { updateFlow } = await import('../../extension/lib/core.js');
  const step = flow.pages.find((p) => p.role === 'fetch');
  const r = step.fetch.requests[0];
  // Start from a page not yet tested as fetched, with background reading back on (testing as fetched honours it too).
  await updateFlow(flow.id, (f) => { delete f.pages.find((p) => p.id === r.pageId).draft.tested.fetched; });
  await browser.storage.local.set({ settings: { ...local.settings, siteAccess: { ...local.settings.siteAccess, backgroundReading: true } } });
  doc.querySelector('[data-key="mode-build"]').click();
  (await until(() => byKey(`fl-open-${flow.id}`), 'flows list')).click();
  await until(() => /6\. Pages to fetch/.test(doc.body.textContent), 'overview');
  assert.ok(/has?n’t been tested as fetched/.test(doc.body.textContent), 'the check says so');
  byKey(`fl-page-${step.id}`).click();
  const preview = await until(() => byKey(`fl-rq-${r.id}-preview`), 'request preview');
  assert.match(preview.textContent, /^GET http:\/\/localhost:8787\/demo\/client-\{ref\}\.html/);
  assert.match(preview.textContent, /Sends: Case reference, from the case, in the address · Read with Client details/);
  byKey(`fl-rq-${r.id}-page`).click();
  const card = await until(() => byKey('fl-fetched'), 'test as fetched');
  assert.match(card.textContent, /Not tested as fetched/);
  await go('index.html');
  type(await until(() => byKey('fl-sample-ref'), 'sample box'), '1042', 'input');
  byKey('fl-test-fetched').click();
  await until(() => local.flows[0].pages.find((p) => p.id === r.pageId).draft.tested.fetched?.ok, 'passed as fetched');
  assert.equal(scripts.filter((x) => x.name === 'fetchInPage').at(-1).args[0].url, `${base}client-1042.html`);
  const kept = local.flows[0].pages.find((p) => p.id === r.pageId).draft.tested.fetched;
  assert.deepEqual(Object.keys(kept).sort(), ['at', 'ok', 'snapshot'], 'only whether it passed is kept, never the sample or what was read');
  await until(() => /✓ Tested as fetched/.test(byKey('fl-fetched').textContent), 'shown');
  // A page that builds itself after it loads reads nothing as fetched: the editor says so.
  answer = '<!DOCTYPE html><title>Client</title><div id="app"></div>';
  byKey('fl-test-fetched').click();
  await until(() => /built after it loads, so it can’t be fetched/.test(byKey('fl-fetched')?.textContent || ''), 'built after it loads');
  assert.equal(local.flows[0].pages.find((p) => p.id === r.pageId).draft.tested.fetched.ok, false);
  answer = null;
  // From a page on another site, nothing is fetched.
  const before = scripts.length;
  page = { ...page, url: 'https://elsewhere.example/' };
  tabsActivated.listeners.forEach((fn) => fn({ windowId: 1, tabId: 1 }));
  await tick(); await tick();
  (await until(() => byKey('fl-test-fetched'), 'button')).click();
  await until(() => /Go to a page on localhost:8787 first/.test(byKey('fl-fetched-result')?.textContent || ''), 'another site');
  assert.equal(scripts.filter((x) => x.name === 'fetchInPage').length, scripts.slice(0, before).filter((x) => x.name === 'fetchInPage').length);
  // Back to the step, and another page to fetch: it opens in the page editor, to be made on its page.
  byKey('fl-back').click();
  (await until(() => byKey('fl-rq-add'), 'step editor')).click();
  await until(() => local.flows[0].pages.find((p) => p.role === 'fetch').fetch.requests.length === 2, 'request added');
  await until(() => /Page to fetch/.test(doc.querySelector('.ctx-head')?.textContent || '') && /fetches this page without showing it/.test(doc.body.textContent), 'its page editor');
});

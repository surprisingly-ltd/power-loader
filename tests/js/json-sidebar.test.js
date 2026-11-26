// Authoring a page that reads data (JSON) in the sidebar, then using it: a fetch step's request is made to read
// an API address, a sample is fetched from the trigger tab (scripting.executeScript stubbed), values are picked
// in the tree view, the test on the sample is the test as fetched, and a case fetches it into a clip whose
// quotes show in the clip view. jsdom, the real storage writer. docs/plans/json-clips.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import '../../extension/lib/extract.js';
import { registerStorageWriter } from '../../extension/lib/storage.js';
import { addField, addPage, addRequest, bindPage, flowLib, mapPick, newFlow, pagesOf, removePage, setThen } from '../../extension/lib/flows.js';
import { judgeFillTest, recordTest } from '../../extension/lib/drafts.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const dom = new JSDOM(read('extension/sidebar/sidebar.html'), { url: 'https://extension.invalid/sidebar/sidebar.html', pretendToBeVisual: true });
const { window } = dom;
const doc = window.document;
Object.assign(globalThis, { window, document: doc, DOMParser: window.DOMParser, Node: window.Node });
globalThis.CSS = window.CSS?.escape ? window.CSS : { escape: (s) => String(s).replace(/[^\w-]/g, (c) => `\\${c}`) };
const events = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, removeListener() {} });
const changed = events();
const base = 'http://localhost:8787/demo/';
const API = `${base}api/clients/`;
const E = globalThis.PowerLoaderExtract;
const pageDoc = (url) => new JSDOM(read(`demo/${url.split('/demo/')[1]}`), { url }).window.document;

// The flow: a fetch step on the case list fetches the client's data, then the caseworker goes to the form.
function makeFlow() {
  const flow = newFlow({ name: 'Client check' });
  const out = pagesOf(flow, 'output')[0];
  bindPage(flow, out.id, { url: `${base}dhp.html`, title: 'Discretionary housing payment' });
  mapPick(out, addField(flow, { label: 'Last name' }), '#d-last');
  mapPick(out, addField(flow, { label: 'Date of birth', type: 'date' }), '#d-dob');
  const step = addPage(flow, 'fetch');
  bindPage(flow, step.id, { url: `${base}cases.html`, title: 'Cases' });
  step.name = 'Start case';
  addRequest(flow, step.id, { name: 'Client data' });
  setThen(step, { to: out.id });
  removePage(flow, pagesOf(flow, 'input')[0].id);
  const dhp = pageDoc(`${base}dhp.html`);
  recordTest(out.draft, judgeFillTest(out.draft, Object.fromEntries(Object.keys(out.draft.profile.fields).map((b) => [b, E.probe(dhp, b)])), { url: `${base}dhp.html`, lib: flowLib(flow) }));
  return flow;
}

const record = (id) => JSON.stringify({
  clientId: `NC-${id}`, person: { lastName: id === '1042' ? 'Kowalska' : 'Nowak', dateOfBirth: id === '1042' ? '1986-07-14' : '1979-03-02', 'first name': 'Maria' },
  payments: [{ paidOn: '2026-10-01', amount: 412.5 }, { paidOn: '2026-11-01', amount: 400 }],
  accounts: { 'RA-10421': { status: 'Open' } },
});

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
const scripts = [];
globalThis.browser = {
  storage: { local: area(local, 'local'), session: area(session, 'session'), onChanged: changed },
  runtime: {
    id: 'extension', getURL: (p) => p, getManifest: () => ({ version: 'test' }), onMessage: runtime,
    sendMessage: async (msg) => { const out = await Promise.all(runtime.listeners.map((fn) => fn(msg, { id: 'extension' }))); return out.find((x) => x !== undefined); },
  },
  windows: { getCurrent: async () => ({ id: 1 }) },
  permissions: { contains: async () => true, request: async () => true, onAdded: events() },
  scripting: {
    executeScript: async ({ func, args }) => {
      scripts.push({ name: func?.name, args });
      if (func?.name !== 'fetchInPage') return [];
      const { url, atUrl, accept } = args[0];
      if (atUrl !== page.url) return [{ result: { error: 'moved' } }];
      if (!url.startsWith(API) || accept !== 'application/json') return [{ result: { status: 406, url, contentType: 'text/html' } }];
      return [{ result: { status: 200, type: 'basic', redirected: false, url, contentType: 'application/json', bytes: new TextEncoder().encode(record(url.slice(API.length))) } }];
    },
  },
  tabs: {
    query: async () => [page], get: async () => page, onUpdated: tabsUpdated, onActivated: tabsActivated,
    update: async (id, { url }) => { page = { ...page, url }; },
    sendMessage: async (id, msg) => {
      if (msg.type === 'powerloader:ping') return true;
      const d = pageDoc(page.url);
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
// Tree keys hold paths such as .accounts.["RA-10421"], so they're compared, not put in a selector.
const byKey = (k) => [...doc.querySelectorAll('[data-key]')].find((el) => el.getAttribute('data-key') === k) || null;
const go = async (file) => {
  page = { ...page, url: `${base}${file}` };
  tabsActivated.listeners.forEach((fn) => fn({ windowId: 1, tabId: 1 }));
  await tick(); await tick();
};
const type = (el, value, ev = 'change') => { el.value = value; el.dispatchEvent(new window.Event(ev, { bubbles: true })); };
const flow = () => local.flows[0];
const jsonPage = () => flow().pages.find((p) => p.parent);
const fieldKey = (label) => Object.entries(flow().fields).find(([, f]) => f.label === label)[0];

test('a fetched page is made to read data: a sample, picks in the tree, and the test on it is the test as fetched', async () => {
  (await until(() => doc.querySelector('[data-key="mode-build"]'), 'mode switch')).click();
  (await until(() => byKey(`fl-open-${flow().id}`), 'flows list')).click();
  const step = flow().pages.find((p) => p.role === 'fetch');
  (await until(() => byKey(`fl-page-${step.id}`), 'overview')).click();
  (await until(() => byKey(`fl-rq-${step.fetch.requests[0].id}-page`), 'step editor')).click();
  // Not made yet: it can read data from an address pasted from the network panel.
  type(await until(() => byKey('fl-json-url'), 'the JSON choice'), `${API}1042`);
  byKey('fl-json-bind').click();
  await until(() => byKey('fl-json'), 'the data editor');
  assert.equal(jsonPage().draft.profile.format, 'json');
  assert.deepEqual(jsonPage().draft.profile.match, [`${API}*`]);
  assert.equal(jsonPage().url, `${API}{ref}`, 'the identifier is a {name}, never kept');
  byKey('fl-back').click();
  const preview = await until(() => byKey(`fl-rq-${step.fetch.requests[0].id}-preview`), 'request preview');
  assert.match(preview.textContent, /Reads data \(JSON\) with Client data$/);
  byKey(`fl-rq-${step.fetch.requests[0].id}-page`).click();
  await until(() => byKey('fl-json'), 'the data editor again');
  // The sample is fetched from the trigger tab, as a case fetches it.
  await go('cases.html');
  type(await until(() => byKey('fl-sample-ref'), 'sample box'), '1042', 'input');
  byKey('fl-json-fetch').click();
  await until(() => byKey('jt-tree'), 'the tree');
  const sent = scripts.filter((s) => s.name === 'fetchInPage').at(-1).args[0];
  assert.equal(sent.url, `${API}1042`);
  assert.equal(sent.accept, 'application/json');
  assert.equal(sent.atUrl, `${base}cases.html`);
  // Pick the date of birth: the selector is the anchored path, with the field's filter.
  byKey('jt-.person.dateOfBirth').click();
  await until(() => byKey('fl-json-pick'), 'pick card');
  assert.match(byKey('fl-json-pick').textContent, /Selected \.person\.dateOfBirth/);
  assert.equal(byKey('fl-json-field').value, fieldKey('Date of birth'), 'guessed from the key, humanised');
  byKey('fl-json-use').click();
  await until(() => jsonPage().draft.profile.fields[fieldKey('Date of birth')], 'dob picked');
  assert.equal(jsonPage().draft.profile.fields[fieldKey('Date of birth')], ":root > [key='person'] > [key='dateOfBirth'] | date");
  // And the last name.
  (await until(() => byKey('jt-.person.lastName'), 'tree again')).click();
  type(await until(() => byKey('fl-json-field'), 'field select'), fieldKey('Last name'));
  byKey('fl-json-use').click();
  await until(() => jsonPage().draft.profile.fields[fieldKey('Last name')], 'last name picked');
  // A value inside a list of objects: every item, as rows.
  (await until(() => byKey('jt-fold-.payments[1]'), 'payments')).click();
  (await until(() => byKey('jt-.payments[1].amount'), 'a payment')).click();
  await until(() => byKey('fl-json-rows'), 'rows option');
  assert.match(byKey('fl-json-pick').textContent, /picks item 2 by position/);
  byKey('fl-json-rows').click();
  await until(() => jsonPage().draft.profile.fields.payments, 'rows picked');
  assert.deepEqual(jsonPage().draft.profile.fields.payments, [":root > [key='payments'] > *", { amount: ":scope > [key='amount']" }]);
  // A key that looks like data is never written into a selector.
  (await until(() => byKey('jt-fold-.accounts.["RA-10421"]'), 'map open')).click();
  (await until(() => byKey('jt-.accounts.["RA-10421"].status'), 'map value')).click();
  await until(() => /looks like data/.test(byKey('fl-json-pick')?.textContent || ''), 'data-like key');
  assert.equal(byKey('fl-json-use'), null);
  // The picks show as paths; the test on the sample passes and counts as the test as fetched.
  assert.match(byKey('fl-json-picks').textContent, /\.person\.dateOfBirth/);
  byKey('fl-json-test').click();
  await until(() => jsonPage().draft.tested?.ok, 'tested');
  const d = jsonPage().draft;
  assert.equal(d.tested.fetched.ok, true);
  assert.deepEqual(d.tested.leaks, []);
  assert.equal(d.tested.fields.payments.count, 2);
  assert.ok(!JSON.stringify(d).includes('Kowalska') && !JSON.stringify(d).includes('1986-07-14'), 'no sample value is kept in the draft');
  await until(() => !/hasn’t been tested/.test(doc.body.textContent), 'checks clear');
  // Another record: a new sample, kept as the second test.
  type(byKey('fl-sample-ref'), '2077', 'input');
  byKey('fl-json-fetch').click();
  await until(() => jsonPage().draft.second?.ok, 'second record');
  assert.equal(scripts.filter((s) => s.name === 'fetchInPage').at(-1).args[0].url, `${API}2077`);
});

test('a case fetches the data into a clip whose quotes show in the clip view', async () => {
  byKey('fl-back').click();
  await tick();
  doc.querySelector('[data-key="mode-casework"]').click();
  (await until(() => byKey(`start-flow-${flow().id}`), 'flow start card')).click();
  const dlg = await until(() => doc.querySelector('[role=dialog]'), 'start confirmation');
  [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Start case').click();
  await until(() => local.case, 'case started');
  await go('cases.html');
  type(await until(() => byKey('step-var-ref'), 'reference box'), '1042', 'input');
  byKey('step-var-ref-use').click();
  await until(() => byKey('fetch-run') && !byKey('fetch-run').disabled, 'ready to fetch');
  byKey('fetch-run').click();
  await until(() => local.case.clips.length === 1, 'fetched');
  const clip = local.case.clips[0];
  assert.equal(clip.format, 'json');
  assert.equal(clip.values[fieldKey('Last name')], 'Kowalska');
  assert.equal(clip.quotes[fieldKey('Date of birth')], '.person.dateOfBirth: "1986-07-14"');
  assert.equal(clip.records.length, 2);
  await until(() => byKey(`fetched-${clip.id}`), 'the clip');
  assert.match(byKey(`fetched-${clip.id}`).textContent, /data fetched by Start case/);
  byKey(`view-${clip.id}`).click();
  const q = await until(() => byKey(`quote-${clip.id}-${fieldKey('Date of birth')}`), 'quote');
  assert.equal(q.textContent, '.person.dateOfBirth: "1986-07-14"');
  assert.equal(q.localName, 'q');
});

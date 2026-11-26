// The case reference from the case the caseworker opens: a flow's "Choose a case" step (a page to visit with
// choose) reads it from the next page's address. The pure parts (refPattern, refFromAddress, refOnArrival,
// setCaseRef, the flow's compile, export and import), then the sidebar with the demo's rent support review flow,
// against the generated Case Manager pages. jsdom, the real storage writer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import '../../extension/lib/extract.js';
import { REF_VALUE, chooseTemplateErrors, refFromAddress, refOnArrival, refPattern, stepStatus, validateSteps } from '../../extension/lib/journey.js';
import { addClip, clearCaseRef, clipFromExtract, newCase, refChangeable, setCaseRef } from '../../extension/lib/case.js';
import { compileFlow, exportFlow, importFlow, pagesOf, validateFlow } from '../../extension/lib/flows.js';
import { registerStorageWriter } from '../../extension/lib/storage.js';
import { demoLibrary } from './helpers/library.js';
import { DEMO_FLOWS, makeDemoFlow } from '../../tools/build-demo-flows.mjs';

const B = 'http://localhost:8787/demo/';
const step = (url) => ({ id: 's1', name: 'Choose a case', role: 'guide', choose: { label: 'Choose a case', next: 's2', url } });
const CASE = step(`${B}cm/case-{ref}.html`);

test('refPattern and refFromAddress: the reference from the case page’s address, and nothing from anything else', () => {
  assert.ok(refPattern(CASE.choose.url) instanceof RegExp);
  assert.equal(refFromAddress(CASE, `${B}cm/case-1042.html`), '1042');
  assert.equal(refFromAddress(CASE, `${B}cm/case-1042.html?tab=notes#client`), '1042', 'the query and fragment aren’t part of it');
  assert.equal(refFromAddress(CASE, `${B}cm/case-%31%30%34%32.html`), '1042', 'percent-encoded, decoded');
  assert.equal(refFromAddress(CASE, `${B}cm/case-AB_12.3-x.html`), 'AB_12.3-x');
  const q = step('https://cm.example.gov.uk/cases?id={ref}');
  assert.equal(refFromAddress(q, 'https://cm.example.gov.uk/cases?id=CM-58213'), 'CM-58213', 'a query value');
  assert.equal(refFromAddress(q, 'https://cm.example.gov.uk/cases?id=CM-58213&x=1'), null, 'the query is the template’s');
  for (const url of [
    'http://elsewhere.example/demo/cm/case-1042.html', // another host
    'http://localhost:9999/demo/cm/case-1042.html', // another port
    `${B}cm/notes-1042.html`, // another path
    `${B}cm/case-1042/x.html`, // a value that runs into the next segment
    `${B}cm/case-10%2F42.html`, // a / once decoded
    `${B}cm/case-...html`, // dots only
    `${B}cm/case-${'1'.repeat(41)}.html`, // over 40 characters
    `${B}cm/case-10%2042.html`, // a space
    `${B}cm/case-.html`, // nothing
    'not an address',
  ]) assert.equal(refFromAddress(CASE, url), null, url);
  assert.ok(REF_VALUE.test('1'.repeat(40)) && !REF_VALUE.test('1'.repeat(41)));
});

test('validateSteps: a choose template needs {ref} exactly once, nothing else, not run together, and the next step', () => {
  const doc = (url, extra = {}) => ({ schema: 'powerloader-steps/1', steps: [{ ...step(url), ...extra }, { id: 's2', name: 'Case', role: 'input', profileId: 'cm/case' }] });
  assert.deepEqual(validateSteps(doc(`${B}cm/case-{ref}.html`)), []);
  assert.deepEqual(validateSteps(doc('https://cm.example.gov.uk/cases?id={ref}')), []);
  assert.deepEqual(validateSteps(doc(`${B}cm/cases/{ref}`)), []);
  for (const [url, why] of [[`${B}cm/queue.html`, /no \{ref\}/], [`${B}cm/{ref}-{ref}.html`, /more than once/], [`${B}cm/case{ref}.html`, /run together/], [`${B}cm/{ref}x.html`, /run together/], ['https://{ref}.example/', /site written out/], [`${B}cm/x.html#{ref}`, /after a #/]]) {
    assert.match(validateSteps(doc(url)).join(' '), why, url);
  }
  assert.match(validateSteps({ schema: 'powerloader-steps/1', steps: [step(`${B}cm/case-{ref}.html`)] }).join(' '), /another step’s id/);
  assert.match(validateSteps(doc(`${B}cm/case-{ref}.html`, { role: 'output', formId: 'rsr' })).join(' '), /only a page to visit/);
  assert.deepEqual(chooseTemplateErrors(`${B}cm/case-{ref}.html`), []);
});

const lib = demoLibrary();
const caseDoc = (no) => { const url = `${B}cm/case-${no}.html`; return { url, doc: new JSDOM(readFileSync(new URL(`../../demo/cm/case-${no}.html`, import.meta.url), 'utf8'), { url }).window.document }; };
const clipCase = (c, no) => {
  const { url, doc } = caseDoc(no);
  const p = lib.profiles.find((x) => x.id === 'cm/case');
  return addClip(c, lib, clipFromExtract(lib, p, { ...globalThis.PowerLoaderExtract.extract(doc, p, { baseUrl: url }), url, title: doc.title }));
};

test('arriving at a case page sets the reference once, logs it without the address, and marks the step done', () => {
  const steps = [{ ...CASE, links: [], text: '' }, { id: 's2', name: 'Case', role: 'input', profileId: 'cm/case', links: [] }];
  const flowLib = { ...lib, steps };
  const c = newCase(lib, ['rsr']);
  c.windowId = 7;
  assert.equal(stepStatus(c, steps[0]), 'todo');
  const at = (url, o = {}) => refOnArrival({ c, lib: flowLib, url, windowId: 7, canRead: true, ...o });
  assert.equal(at(`${B}cm/queue.html`), null);
  // Another window, or a page the site rules don't let Power Loader read: nothing.
  assert.equal(at(`${B}cm/case-1042.html`, { windowId: 8 }), null);
  assert.equal(at(`${B}cm/case-1042.html`, { canRead: false }), null);
  const got = at(`${B}cm/case-1042.html`);
  assert.deepEqual([got.kind, got.ref, got.step.id], ['set', '1042', 's1']);
  setCaseRef(c, got.ref, { from: 'address', step: got.step });
  assert.equal(c.ref, '1042');
  assert.equal(stepStatus(c, steps[0]), 'done');
  const e = c.log.at(-1);
  assert.equal(e.activity, 'set_reference');
  assert.doesNotMatch(JSON.stringify(e), /1042|localhost|cm\/case/, 'neither the reference nor the address is logged');
  assert.match(e.detail, /Choose a case/);
  // The same case again: nothing. Another case: a warning, and the reference stays.
  assert.equal(at(`${B}cm/case-1042.html`), null);
  assert.deepEqual([at(`${B}cm/case-1043.html`).kind, at(`${B}cm/case-1043.html`).ref], ['other', '1043']);
  assert.throws(() => setCaseRef(c, '1043'), /already has the reference/);
  // Change works before the first clip, and isn't offered after it.
  assert.equal(refChangeable(c), true);
  clearCaseRef(c);
  assert.equal(c.ref, '');
  assert.equal(stepStatus(c, steps[0]), 'todo');
  setCaseRef(c, '1043', { from: 'address', step: steps[0] });
  clipCase(c, 1043);
  assert.equal(refChangeable(c), false);
  assert.throws(() => clearCaseRef(c), /already has clips/);
  // A reference typed at the start counts as chosen.
  const typed = newCase(lib, ['rsr'], { ref: 'HSG/2026/1042' });
  assert.equal(stepStatus(typed, steps[0]), 'done');
});

test('the flow: compile writes choose with the next page’s address, and export and import keep it, remapped', () => {
  const flow = makeDemoFlow(lib, DEMO_FLOWS.find((f) => f.name === 'Rent support review'));
  const queue = pagesOf(flow, 'guide')[0];
  const casePage = pagesOf(flow, 'input').find((p) => p.profileId === 'cm/case');
  assert.equal(queue.name, 'Choose a case');
  assert.deepEqual(queue.choose, { label: 'Choose a case', next: casePage.id });
  const [first] = compileFlow(flow).files['steps.json'].steps;
  assert.deepEqual(first.choose, { label: 'Choose a case', next: casePage.id, url: `${B}cm/case-{ref}.html` });
  assert.doesNotMatch(first.text, /type its case number/i);
  assert.deepEqual(first.links.map((l) => l.label), ['Go to the work queue', 'Read the team’s procedure']);
  const back = importFlow(JSON.parse(JSON.stringify(exportFlow(flow))));
  const q2 = pagesOf(back, 'guide')[0];
  const c2 = pagesOf(back, 'input').find((p) => p.profileId === 'cm/case');
  assert.notEqual(c2.id, casePage.id);
  assert.equal(q2.choose.next, c2.id, 'choose.next follows the page to its new id');
  // A next page with no {ref} in its address is a problem for the author.
  c2.url = `${B}cm/queue.html`;
  assert.ok(validateFlow(back).some((i) => i.code === 'choose-bad' && /Choose a case: the next page’s address has no \{ref\}/.test(i.text)));
  // The page it chose from removed: no choose left behind.
  const doc = JSON.parse(JSON.stringify(exportFlow(flow)));
  doc.pages = doc.pages.filter((p) => p.id !== casePage.id);
  assert.equal(pagesOf(importFlow(doc), 'guide')[0].choose, undefined);
});

// ------------------------------------------------------------------ in the sidebar

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const dom = new JSDOM(read('extension/sidebar/sidebar.html'), { url: 'https://extension.invalid/sidebar/sidebar.html', pretendToBeVisual: true });
const { window } = dom;
const doc = window.document;
Object.assign(globalThis, { window, document: doc, DOMParser: window.DOMParser, Node: window.Node });
globalThis.CSS = window.CSS?.escape ? window.CSS : { escape: (s) => String(s).replace(/[^\w-]/g, (ch) => `\\${ch}`) };
const events = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, removeListener() {} });
const changed = events();
const E = globalThis.PowerLoaderExtract;
const pageDoc = (url) => new JSDOM(read(`demo/${url.split('/demo/')[1].split(/[?#]/)[0]}`), { url }).window.document;
const local = { settings: { welcomed: '2026-11-24T09:00:00.000Z' }, flows: [makeDemoFlow(lib, DEMO_FLOWS.find((f) => f.name === 'Rent support review'))] };
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
const runtime = events(), tabsUpdated = events(), tabsActivated = events();
globalThis.browser = {
  storage: { local: area(local, 'local'), session: area(session, 'session'), onChanged: changed },
  runtime: {
    id: 'extension', getURL: (p) => p, getManifest: () => ({ version: 'test' }), onMessage: runtime,
    sendMessage: async (msg) => { const out = await Promise.all(runtime.listeners.map((fn) => fn(msg, { id: 'extension' }))); return out.find((x) => x !== undefined); },
  },
  windows: { getCurrent: async () => ({ id: 1 }) },
  permissions: { contains: async () => true, request: async () => true, onAdded: events() },
  scripting: { executeScript: async () => [] },
  tabs: {
    query: async () => [page], get: async () => page, onUpdated: tabsUpdated, onActivated: tabsActivated,
    update: async (id, { url }) => { page = { ...page, url }; },
    sendMessage: async (id, msg) => {
      const d = pageDoc(page.url);
      if (msg.type === 'powerloader:ping') return true;
      if (msg.type === 'powerloader:applies') return msg.profiles.map((p) => E.profileApplies(p, page.url, d));
      if (msg.type === 'powerloader:extract') return { ...E.extract(d, msg.profile, { baseUrl: page.url }), url: page.url, title: d.title };
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
const until = async (fn, what = 'UI') => { for (let i = 0; i < 300; i++) { const v = fn(); if (v) return v; await tick(); } throw new Error(`${what} did not settle: ${doc.body.textContent.slice(0, 800)}`); };
const byKey = (k) => doc.querySelector(`[data-key="${k}"]`);
const go = async (file) => {
  page = { ...page, url: `${B}${file}` };
  tabsActivated.listeners.forEach((fn) => fn({ windowId: 1, tabId: 1 }));
  await tick(); await tick();
};
const flow = local.flows[0];

test('in the sidebar: no reference to type, the case page sets it, Change, then another case only warns', async () => {
  const card = await until(() => byKey(`start-flow-${flow.id}`), 'flow start card');
  assert.ok(byKey(`flow-ref-${flow.id}`), 'a reference can still be typed, under Type a case reference');
  assert.equal(byKey(`flow-ref-${flow.id}`).open, false, 'collapsed');
  card.click();
  const dlg = await until(() => doc.querySelector('[role=dialog]'), 'start confirmation');
  [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Start case').click();
  await until(() => local.case, 'case started');
  assert.equal(local.case.ref, '');
  await go('cm/queue.html');
  await until(() => /Choose a case/.test(doc.body.textContent) && byKey('step-on-page'), 'the first step');
  assert.match(byKey('step-on-page').textContent, /On the page: open the case you’re picking up/);
  assert.equal(byKey('step-open'), null, 'the work queue is the page in view, so it isn’t offered again');
  assert.equal(doc.querySelectorAll('[data-key="step-body"] .primary').length, 0, 'the step is done on the page: no main button');
  assert.equal(byKey('step-done'), null, 'choosing is done by opening a case, not a button');
  assert.ok(byKey('choose-type'), 'or by typing it');
  await go('cm/case-1042.html');
  await until(() => local.case.ref === '1042', 'reference set from the address');
  // The note is in the step that chose the case: open it to see it.
  byKey(`step-go-${flow.pages.find((p) => p.choose).id}`).click();
  const note = await until(() => byKey('ref-set'), 'the note');
  assert.match(note.textContent, /Case reference set to 1042, from the case you opened/);
  assert.ok(local.case.log.some((e) => e.activity === 'set_reference'));
  // Change: cleared, and this page doesn't set it again until the tab moves on.
  byKey('ref-change').click();
  await until(() => local.case.ref === '', 'cleared');
  await go('cm/case-1042.html');
  assert.equal(local.case.ref, '');
  await go('cm/case-1043.html');
  await until(() => local.case.ref === '1043', 'set to the case opened');
  byKey('clip').click();
  await until(() => local.case.clips.length === 1, 'clipped');
  await until(() => !byKey('ref-set'), 'Change isn’t offered once there is a clip');
  await go('cm/case-1044.html');
  const warn = await until(() => byKey('ref-other'), 'the warning');
  assert.match(warn.textContent, /This is case 1044, not this case \(1043\)/);
  assert.ok(byKey('ref-finish'));
  assert.equal(byKey('clip'), null, 'another case’s page isn’t offered for clipping');
  assert.equal(local.case.ref, '1043');
});

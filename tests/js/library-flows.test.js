// Flows a library carries (flows/… in its manifest): validated when it is indexed, listed on the Flows tab and
// the start screen under "From your library", read-only there, started as an imported flow is, and copied to
// this computer to edit. The demo library carries the demo flows, from the same definitions as the downloads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import '../../extension/lib/extract.js';
import { demoSet } from './helpers/library.js';
import { indexLibrary } from '../../extension/lib/library.js';
import { libraryFlow, pagesOf, startable } from '../../extension/lib/flows.js';
import { registerStorageWriter } from '../../extension/lib/storage.js';
import { DEMO_FLOWS } from '../../tools/build-demo-flows.mjs';
import { demoLibraryFlows } from '../../tools/build-demo-library.mjs';

const set = demoSet();
const lib = indexLibrary(set);

test('the demo library carries the demo flows, valid, the same as a fresh build, with nothing it can’t open', async () => {
  assert.deepEqual(lib.problems, []);
  assert.deepEqual(lib.flows.map((f) => f.name).sort(), DEMO_FLOWS.map((f) => f.name).sort());
  const fresh = await demoLibraryFlows();
  for (const [rel, text] of Object.entries(fresh)) assert.deepEqual(set.files[rel], JSON.parse(text), `${rel} is current`);
  for (const f of lib.flows) {
    const flow = libraryFlow(lib, f.path);
    assert.match(flow.id, /^f-lib-/);
    assert.ok(flow.pages.every((p) => !p.draft || p.draft.tested === null), 'pages come back untested, as for an import');
    // Change of circumstances is unfinished on purpose: the library has no fill profile for its form yet.
    if (f.name === 'Change of circumstances') assert.match(startable(flow).reason, /Make a form to fill first/);
    else assert.equal(startable(flow).ok, true, f.name);
  }
  assert.equal(pagesOf(libraryFlow(lib, 'flows/inbox-triage.flow.json'), 'output').length, 0);
});

test('a bad flow file is a library problem for its path; one on a system the library doesn’t approve is too', () => {
  const doc = structuredClone(set.files['flows/rent-support-review.flow.json']);
  const bad = indexLibrary({ ...set, files: { ...set.files, 'flows/broken.flow.json': { schema: 'nope' }, 'flows/elsewhere.flow.json': JSON.parse(JSON.stringify(doc).replaceAll('http://localhost:8787', 'https://cm.elsewhere.example')) } });
  assert.match(bad.problems.find((p) => p.path === 'flows/broken.flow.json').errors[0], /isn’t a Power Loader flow file/);
  assert.match(bad.problems.find((p) => p.path === 'flows/elsewhere.flow.json').errors.join(' '), /cm\.elsewhere\.example, which isn’t on the approved systems list/);
  assert.equal(bad.flows.length, lib.flows.length, 'only the good ones are listed');
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
const rsr = libraryFlow(lib, 'flows/rent-support-review.flow.json');

test('the start screen and the Flows tab list the library’s flows, labelled, beside the ones on this computer', async () => {
  const list = await until(() => byKey('flows-rest'), 'start screen list');
  assert.match(doc.body.textContent, /Flows · 6star the ones you work, and they come first/);
  assert.equal(list.querySelectorAll('.fcard').length, 6);
  assert.match(byKey(`flow-card-${rsr.id}`).textContent, /from your library/);
  assert.match(byKey('flow-cant-f-lib-change-of-circumstances').textContent, /Can’t start yet: Make a form to fill first/);
  tab('Flows');
  const group = await until(() => byKey('fl-library-flows'), 'library group');
  assert.equal(group.querySelectorAll('.fcard').length, 6);
  assert.match(doc.body.textContent, /From your librarycommit [0-9a-f]+ · read-only/);
  assert.match(doc.body.textContent, /On this computeryours to edit/);
  assert.match(doc.body.textContent, /No flows on this computer yet\./, 'the empty text stays for the second group');
  // Read-only: it can be looked at, started or copied, never edited or deleted in place.
  const card = byKey(`fl-lib-${rsr.id}`);
  const labels = [...card.querySelectorAll('button')].map((b) => b.textContent);
  assert.deepEqual(labels, ['Look at it', 'Make a copy to edit', 'Try it']);
  byKey(`fl-lib-view-${rsr.id}`).click();
  const detail = await until(() => byKey(`fl-lib-detail-${rsr.id}`), 'detail');
  assert.match(detail.textContent, /^1\. Choose a case\. Go to the work queue/);
  assert.match(detail.textContent, /Ask the client for a missing reference · Email to send/);
});

test('copying a library flow makes a flow on this computer that says where it came from', async () => {
  byKey(`fl-lib-copy-${rsr.id}`).click();
  await until(() => local.flows.length === 1, 'copied');
  const copy = local.flows[0];
  assert.equal(copy.name, 'Rent support review');
  assert.deepEqual(copy.copiedFrom, { commit: set.commit, path: 'flows/rent-support-review.flow.json', name: 'Rent support review' });
  assert.notEqual(copy.id, rsr.id);
  assert.ok(lib.flows.some((f) => f.path === 'flows/rent-support-review.flow.json'), 'the library’s flow isn’t changed');
  byKey('fl-back-list')?.click();
  await until(() => byKey(`fl-copied-${copy.id}`), 'the copy says so');
  assert.match(byKey(`fl-copied-${copy.id}`).textContent, /Copied from your library/);
});

test('a case starts from a library flow through the same path as any flow, pinning a set of its own', async () => {
  // Try it: from Build to Casework, with a case of the flow.
  byKey('fl-back-list')?.click();
  (await until(() => byKey(`fl-lib-try-${rsr.id}`), 'library flow card')).click();
  const dlg = await until(() => doc.querySelector('[role=dialog]'), 'start confirmation');
  assert.match(dlg.textContent, /haven’t been tested on this computer/, 'its pages are listed as untested, as for an import');
  [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Start case').click();
  await until(() => local.case, 'case started');
  assert.equal(local.case.library.flow.name, 'Rent support review');
  assert.deepEqual(local.case.library.flow.fromLibrary, { commit: set.commit, path: 'flows/rent-support-review.flow.json' });
  assert.match(local.case.library.commit, /^flow-lib-rent-support-review-/);
  assert.ok(local.library.sets[local.case.library.commit], 'pinned like any flow set');
  assert.ok(local.library.sets[set.commit], 'the library itself stays');
  await until(() => doc.querySelector('.sb-head.mode-casework'), 'Casework');
});

test('in a case of a library flow, Add this page to the flow copies the flow, opens Build, and the new step goes after the open one', async () => {
  // The case of the library's rent support review is open, in Casework; the copy made earlier is set aside.
  local.flows = [];
  await browser.storage.local.set({ flows: [] });
  page.url = 'http://localhost:8787/demo/index.html';
  const box = await until(() => byKey('flow-incomplete-copy') && byKey('flow-incomplete'), 'the box');
  assert.match(box.textContent, /This flow is from your library, so a copy is made on this computer for you to change/);
  const open = doc.querySelector('[aria-current="step"]').getAttribute('data-key').replace('step-go-', '');
  byKey('flow-incomplete-add').click();
  await until(() => local.flows.length === 1 && doc.querySelector('.sb-head.mode-build'), 'copied, in Build');
  const copy = local.flows[0];
  assert.equal(copy.copiedFrom.path, 'flows/rent-support-review.flow.json');
  assert.ok(copy.pages.some((p) => p.id === open), 'the copy keeps the library flow’s page ids, which are the case’s step ids');
  const card = await until(() => byKey('fl-add-here'), 'Add this page');
  assert.match(card.textContent, /It goes after Choose a case/);
  assert.ok(byKey('fl-add-sometimes'), 'Only needed sometimes');
  byKey('fl-add-here-guide').click();
  await until(() => (local.flows[0].journey || []).length > 0 && local.flows[0].pages.length === copy.pages.length + 1, 'added');
  const j = local.flows[0].journey;
  const made = local.flows[0].pages.find((p) => !copy.pages.some((q) => q.id === p.id));
  assert.equal(j[j.indexOf(open) + 1], made.id, 'after the step that was open');
  // The case can take the changed flow, from Build or from Casework, when asked.
  await until(() => byKey('fl-use-changed') || byKey('fl-step-of'), 'the page editor');
  byKey('mode-casework').click();
  const line = await until(() => byKey('flow-changed'), 'the line on the steps card');
  assert.match(line.textContent, /This flow has been changed on this computer since the case started/);
  const clips = local.case.clips.length;
  byKey('flow-use-changed').click();
  await until(() => local.case.library.flow.id === local.flows[0].id, 'the case uses the changed flow');
  assert.equal(local.case.clips.length, clips);
  assert.ok(local.case.log.some((e) => e.activity === 'update_flow' && e.detail === 'Rent support review'));
  await until(() => !byKey('flow-changed'), 'no longer offered');
  assert.ok(byKey(`step-go-${made.id}`), 'the new step is in the case’s list');
});

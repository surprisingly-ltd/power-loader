// The full case page in jsdom, and the background routes that open it and return to where the caseworker was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import '../../extension/lib/extract.js';
import { registerStorageWriter } from '../../extension/lib/storage.js';
import { demoSet, demoLibrary, extractDemo } from './helpers/library.js';
import { addClip, clipFromExtract, newCase } from '../../extension/lib/case.js';
import { registerPageRoutes, OPEN_PAGE } from '../../extension/lib/pages.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const dom = new JSDOM(read('extension/case/case.html'), { url: 'moz-extension://x/case/case.html?field=phone', pretendToBeVisual: true });
const { window } = dom;
const doc = window.document;
Object.assign(globalThis, { window, document: doc, DOMParser: window.DOMParser, Node: window.Node, location: window.location, history: { replaceState() {} } }); // jsdom refuses replaceState on moz-extension: addresses
globalThis.CSS = { escape: (s) => String(s).replace(/[^\w-]/g, (c) => `\\${c}`) };
const set = demoSet();
const lib = demoLibrary();
const c = newCase(lib, ['hsr', 'dhp'], { ref: 'CM-1' });
for (const [p, id] of [['client-1042.html', 'cm/client-record'], ['rent-account-1042.html', 'harbour-homes/rent-account']]) {
  const { profile, res } = extractDemo(lib, p, id);
  addClip(c, lib, clipFromExtract(lib, profile, res));
}
const local = { library: { current: set.commit, sets: { [set.commit]: set } }, case: c };
const session = { fullPage: { kind: 'case', from: { tabId: 4, windowId: 1, url: 'http://localhost:8787/demo/client-1042.html', scroll: { x: 0, y: 420 }, focus: 'frow-phone' } } };
const changed = [];
const area = (d, name) => ({
  get: async (keys) => structuredClone(Object.fromEntries([keys].flat().filter((k) => k in d).map((k) => [k, d[k]]))),
  set: async (patch) => { Object.assign(d, structuredClone(patch)); queueMicrotask(() => changed.forEach((fn) => fn(Object.fromEntries(Object.keys(patch).map((k) => [k, { newValue: patch[k] }])), name))); },
  remove: async (keys) => { for (const k of [keys].flat()) delete d[k]; },
});
const calls = [];
let tabExists = true;
const runtimeListeners = [];
globalThis.browser = {
  storage: { local: area(local, 'local'), session: area(session, 'session'), onChanged: { addListener: (fn) => changed.push(fn) } },
  runtime: {
    id: 'x', getURL: (p) => `moz-extension://x/${p}`, getManifest: () => ({ version: 't' }),
    onMessage: { addListener: (fn) => runtimeListeners.push(fn) },
    sendMessage: async (m) => { for (const fn of runtimeListeners) { const r = fn(m, { id: 'x' }); if (r !== undefined) return r; } return undefined; },
  },
  sidebarAction: { open: async () => calls.push('sidebar open'), close: async () => calls.push('sidebar close') },
  tabs: {
    get: async (id) => { if (!tabExists) throw new Error('no tab'); return { id }; },
    getCurrent: async () => ({ id: 9 }),
    update: async (id, p) => calls.push(`activate ${id} ${JSON.stringify(p)}`),
    remove: async (id) => calls.push(`close ${id}`),
    create: async (p) => calls.push(`create ${p.url}`),
  },
  windows: { update: async (id) => calls.push(`focus window ${id}`) },
};
registerStorageWriter();
const asked = [];
registerPageRoutes({ ask: async (tabId, msg) => { asked.push([tabId, msg]); return msg.type === 'powerloader:scroll' ? { x: 0, y: 99 } : true; } });
await import('../../extension/case/case.js');

const tick = () => new Promise((r) => setTimeout(r, 5));
const until = async (fn, what) => { for (let i = 0; i < 200; i++) { const v = fn(); if (v) return v; await tick(); } throw new Error(`${what} did not settle: ${doc.body.textContent.slice(0, 400)}`); };
const button = (label, root = doc) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === label);

test('the page opens on the field it was opened for, with the prototype’s views as tabs', async () => {
  await until(() => doc.querySelector('[role=tab]'), 'tabs');
  // A tab's label is its first text node; the conflict count is a separate badge.
  assert.deepEqual([...doc.querySelectorAll('[role=tab]')].map((t) => t.firstChild.textContent.replace(/\d+$/, 'n')), ['Fields', 'Sources · n', 'Matrix', 'Activity · n', 'Calculator', 'Timeline']);
  assert.equal(doc.querySelector('[role=tab] .badge')?.textContent, '1');
  const row = doc.querySelector('[data-key="fr-phone"]');
  assert.equal(row.getAttribute('aria-expanded'), 'true');
  assert.equal(doc.activeElement, row);
  assert.match(doc.body.textContent, /Conflict/);
  await until(() => local.case.log.some((e) => e.activity === 'open_full_case_view'), 'logged');
});

test('deciding a conflict here updates the case; unsaved typing survives a re-render', async () => {
  button('Use this value').click();
  await until(() => local.case.resolved.phone, 'decided');
  doc.querySelector('[data-key="fr-reason"]').click();
  const box = await until(() => doc.querySelector('[data-key="cp-reason-own"]'), 'reason box');
  box.focus();
  box.value = 'Half-typed';
  box.dispatchEvent(new window.Event('input', { bubbles: true }));
  await browser.storage.local.set({ case: { ...local.case } });
  await tick(); await tick();
  const again = doc.querySelector('[data-key="cp-reason-own"]');
  assert.equal(again.value, 'Half-typed');
  assert.equal(doc.activeElement, again);
});

test('the Sources view excludes and restores a source value', async () => {
  [...doc.querySelectorAll('[role=tab]')].find((t) => t.textContent.startsWith('Sources')).click();
  const card = await until(() => [...doc.querySelectorAll('[data-key^="src-"]')].find((b) => /Rent account/.test(b.textContent)), 'source list');
  card.click();
  await until(() => doc.querySelector('[data-key="sx-landlord"]'), 'sources');
  doc.querySelector('[data-key="sx-landlord"]').click();
  await until(() => local.case.excluded.some((e) => e.endsWith(':landlord')), 'excluded');
  await until(() => doc.querySelector('[data-key="sx-landlord"]')?.textContent === 'Restore', 'restore button');
  doc.querySelector('[data-key="sx-landlord"]').click();
  await until(() => !local.case.excluded.length, 'restored');
});

test('Back to the sidebar restores the tab, window and scroll, focuses the control, and closes the page', async () => {
  button('Back to the sidebar').click();
  await until(() => calls.includes('close 9'), 'returned');
  assert.equal(calls[0], 'sidebar open', 'the sidebar opens first, inside the click');
  assert.ok(calls.includes('activate 4 {"active":true}'));
  assert.ok(calls.includes('focus window 1'));
  assert.deepEqual(asked.at(-1), [4, { type: 'powerloader:scrollTo', x: 0, y: 420 }]);
  assert.equal(session.returnFocus, 'frow-phone');
  assert.equal(session.fullPage, undefined);
});

test('if the tab the caseworker came from was closed, the page says so', async () => {
  session.fullPage = { kind: 'case', from: { tabId: 5, windowId: 1 } };
  tabExists = false;
  button('Back to the sidebar').click();
  await until(() => /The tab you came from was closed/.test(doc.getElementById('announce').textContent), 'message');
});

test('opening a page remembers the scroll position and opens the extension page', async () => {
  await browser.runtime.sendMessage({ type: OPEN_PAGE, kind: 'case', from: { tabId: 7, windowId: 2, url: 'u', focus: 'open-full' }, params: { field: 'dob' } });
  assert.deepEqual(session.fullPage.from, { tabId: 7, windowId: 2, url: 'u', focus: 'open-full', scroll: { x: 0, y: 99 } });
  assert.ok(calls.includes('create moz-extension://x/case/case.html?field=dob'));
});

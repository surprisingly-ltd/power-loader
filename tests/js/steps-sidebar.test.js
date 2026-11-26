// The steps list and the open step in the sidebar (sidebar/steps.js), in jsdom: the rent support review, worked
// from its first step, with exactly one main button in the open step at each point, and what it says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import '../../extension/lib/extract.js';
import { registerStorageWriter } from '../../extension/lib/storage.js';
import { demoLibrary } from './helpers/library.js';
import { DEMO_FLOWS, makeDemoFlow } from '../../tools/build-demo-flows.mjs';

const lib = demoLibrary();
const B = 'http://localhost:8787/demo/';
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
const sent = [];
let gatherFails = false;
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
      sent.push({ type: msg.type, url: page.url });
      const d = pageDoc(page.url);
      if (msg.type === 'powerloader:showValues') return { found: Object.keys(msg.fields).filter((k) => typeof msg.fields[k] !== 'string' || E.locate(d, E.locatorOf(msg.fields[k])).length), shownIn: 0 };
      if (msg.type === 'powerloader:gatherValues') { if (gatherFails) throw new Error('gone'); return { toLeft: true, items: Object.keys(msg.fields).map((key) => ({ key, at: 0, y: null })) }; }
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
const until = async (fn, what = 'UI') => { for (let i = 0; i < 300; i++) { const v = fn(); if (v) return v; await tick(); } throw new Error(`${what} did not settle: ${doc.body.textContent.slice(0, 900)}`); };
const byKey = (k) => doc.querySelector(`[data-key="${k}"]`);
const go = async (file) => {
  page = { ...page, url: `${B}${file}` };
  tabsActivated.listeners.forEach((fn) => fn({ windowId: 1, tabId: 1 }));
  await tick(); await tick();
};
const flow = local.flows[0];
const stepId = (name) => flow.pages.find((p) => p.name === name).id;
// The open step's main buttons: there is exactly one, or none where the step is done on the page.
const mains = () => [...doc.querySelectorAll('[data-key="step-body"] .primary')];
const main = async (words, what) => {
  const b = await until(() => mains().length === 1 && words.test(mains()[0].textContent.trim()) && mains()[0], what);
  assert.equal(mains().length, 1, `one main button: ${what}`);
  return b;
};
const recognised = () => [...doc.querySelectorAll('.ctx-head')].some((x) => /Recognised/.test(x.textContent));

test('the steps are always listed, numbered, and the first step’s main button goes to its page', async () => {
  (await until(() => byKey(`start-flow-${flow.id}`), 'start card')).click();
  const dlg = await until(() => doc.querySelector('[role=dialog]'), 'confirmation');
  [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Start case').click();
  await until(() => local.case, 'case');
  const rail = await until(() => byKey('steps-rail'), 'steps list');
  assert.equal(rail.tagName, 'OL');
  assert.equal(rail.querySelectorAll(':scope > li').length, 8, 'every step, always');
  assert.equal(byKey('steps-all'), null, 'no All steps: the list is always there');
  assert.equal(byKey('steps-count').textContent, '0 of 8 steps done');
  const first = byKey(`step-go-${stepId('Choose a case')}`);
  assert.equal(first.getAttribute('aria-current'), 'step');
  assert.equal(first.getAttribute('aria-expanded'), 'true');
  assert.match(first.textContent, /Step 1: Choose a case, to do/);
  const b = await main(/^Go to the work queue$/, 'go to the queue');
  assert.equal(b.getAttribute('data-key'), 'step-open');
});

test('a step done on the page offers no button; a page to clip has Clip this page in its step, not a second card', async () => {
  await go('cm/queue.html');
  await until(() => byKey('step-on-page'), 'on the page');
  assert.match(byKey('step-on-page').textContent, /On the page: open the case you’re picking up/);
  assert.equal(mains().length, 0);
  await go('cm/case-1001.html');
  await until(() => local.case.ref === '1001', 'reference from the address');
  await main(/^Clip this page$/, 'clip');
  assert.equal(recognised(), false, 'no Recognised card on a step’s page');
  // The values the page gives: listed in the step before the clip, and outlined on the page.
  const rows = await until(() => byKey('gather-values'), 'the values');
  assert.match(byKey('clip-block').textContent, /This page gives \d+ values/);
  assert.ok(byKey('gv-lastName').classList.contains('wait'));
  await until(() => sent.some((m) => m.type === 'powerloader:showValues' && m.url.endsWith('case-1001.html')), 'outlined on the page');
  assert.ok(rows.querySelectorAll('li').length >= 9);
  assert.equal(byKey(`step-go-${stepId('Case')}`).getAttribute('aria-current'), 'step');
});

test('after the clip, Next is the one main button, and it goes to that step', async () => {
  mains()[0].click();
  await until(() => local.case.clips.length === 1, 'clipped');
  // After the clip each row has its value, shown as the sidebar shows values everywhere.
  await until(() => byKey('gv-lastName')?.classList.contains('got'), 'the rows have their values');
  assert.match(byKey('gv-clientId').textContent, /NC-\d+/);
  assert.match(byKey('gv-dob').textContent, /\d{1,2} [A-Z][a-z]{2} \d{4}/, 'a date as a person reads it');
  // Case 1001 has a tenancy reference, so the email asking for one isn't needed: Next passes over it.
  const next = await main(/^Next: Harbour Homes tenancy/, 'next');
  assert.equal(next.getAttribute('data-key'), 'step-next');
  assert.equal(byKey('steps-count').textContent, '2 of 8 steps done · 1 not needed');
  const ask = stepId('Ask the client for a missing reference');
  assert.match(byKey(`step-go-${ask}`).closest('li').textContent, /Not needed/);
  // Opened, it says why, and Do it anyway opens it as a normal step for this case.
  byKey(`step-go-${ask}`).click();
  const why = await until(() => byKey('step-not-needed'), 'why');
  assert.match(why.textContent, /Only when the case has no Tenancy reference\. This case has one\./);
  assert.ok(!byKey('step-anyway').classList.contains('primary'), 'an ordinary button');
  byKey('step-anyway').click();
  await until(() => local.case.steps?.[ask]?.wanted, 'wanted');
  assert.ok(local.case.log.some((e) => e.activity === 'reopen_step'));
  await main(/^Open in your email app$/, 'the email, as a normal step');
  // Choosing the open step again closes it, and the open step is the one for this page.
  byKey(`step-go-${ask}`).click();
  await until(() => byKey(`step-go-${stepId('Case')}`).getAttribute('aria-current') === 'step', 'back to this page’s step');
});

test('any step can be opened to look at, and a step whose address is known has an arrow to it', async () => {
  const tenancy = stepId('Harbour Homes tenancy');
  assert.ok(byKey(`step-jump-${tenancy}`), 'the tenancy’s address is known from the case');
  byKey(`step-go-${tenancy}`).click();
  await main(/^(Go to|Open the rent account)/, 'the tenancy, opened');
  byKey(`step-jump-${tenancy}`)?.click();
  byKey(`step-go-${tenancy}`).click();
  await until(() => byKey(`step-go-${stepId('Case')}`).getAttribute('aria-current') === 'step', 'closed again');
});

test('a recognised page that isn’t a step’s keeps its own card', async () => {
  const clientId = local.case.clips[0].values.clientId;
  await go(`messages/message/${clientId}-1.html`);
  await until(() => recognised(), 'Recognised card');
});

test('outlining is part of reading: a page where annotate is blocked is outlined, one where reading is blocked is sent nothing', async () => {
  const saved = structuredClone(local.settings);
  const rules = (r) => browser.storage.local.set({ settings: { ...saved, siteAccess: { rules: [r] } } });
  const { tenancyRef, clientId } = local.case.clips[0].values;
  await rules({ id: 'mine-a', effect: 'deny', pattern: 'http://localhost:8787/demo/harbour/*', actions: ['annotate'] });
  const n = sent.length;
  await go(`harbour/tenancy-${tenancyRef}.html`);
  await until(() => sent.slice(n).some((m) => m.type === 'powerloader:showValues' && m.url.includes('/harbour/')), 'outlined with annotate blocked');
  await rules({ id: 'mine-r', effect: 'deny', pattern: 'http://localhost:8787/demo/biv/*' });
  await go(`biv/income-${clientId}.html`);
  await until(() => /Power Loader doesn’t work on this page/.test(doc.body.textContent), 'blocked');
  await tick(); await tick();
  assert.ok(!sent.some((m) => m.url.includes('/biv/') && /Values?$/.test(m.type)), 'nothing sent to a page that may not be read');
  await browser.storage.local.set({ settings: saved });
  await go('cm/case-1001.html');
});

test('a clip ends with every row holding its value, whether or not the page answers', async () => {
  const { tenancyRef } = local.case.clips[0].values;
  gatherFails = true;
  await go(`harbour/tenancy-${tenancyRef}.html`);
  (await main(/^Clip this page$/, 'clip the tenancy')).click();
  await until(() => local.case.clips.length === 2, 'clipped');
  await until(() => [...doc.querySelectorAll('[data-gather]')].every((el) => !el.classList.contains('flying') && !el.classList.contains('wait')), 'rows settled');
  assert.ok(byKey('gv-tenancyRef').classList.contains('got'));
  gatherFails = false;
});

test('auto-clip outlines the values before it clips, and clips nothing if the page is left meanwhile', async () => {
  const { clientId } = local.case.clips[0].values;
  await browser.storage.local.set({ settings: { ...local.settings, autoClip: true } });
  await tick();
  // Less motion (jsdom has no matchMedia): no wait, but the outlines are still asked for first.
  const n = sent.length;
  await go(`biv/income-${clientId}.html`);
  await until(() => local.case.clips.length === 3, 'clipped automatically');
  const mine = sent.slice(n).filter((m) => m.url.includes('/biv/')).map((m) => m.type);
  assert.ok(mine.indexOf('powerloader:showValues') >= 0 && mine.indexOf('powerloader:showValues') < mine.indexOf('powerloader:extract'), mine.join(', '));
  // With motion, it waits for the outlines to be seen: leaving during the wait clips nothing.
  window.matchMedia = () => ({ matches: false });
  const clips = local.case.clips.length;
  const ref = local.case.clips[0].values.clientId;
  await go(`messages/message/${ref}-2.html`);
  await go('index.html');
  for (let i = 0; i < 80; i++) await tick();
  assert.equal(local.case.clips.length, clips, 'left before the clip');
  delete window.matchMedia;
  await browser.storage.local.set({ settings: { ...local.settings, autoClip: false } });
});

test('on a page that isn’t one of the flow’s steps, Casework asks whether the flow is incomplete', async () => {
  // A Case Manager page the flow doesn't have, and the demo's index (another site the rules allow).
  for (const file of ['cm/notes-1001.html', 'index.html']) {
    await go(file);
    const box = await until(() => byKey('flow-incomplete'), `the box on ${file}`);
    assert.match(box.textContent, /Is this flow incomplete\? This page isn’t one of its steps/);
    assert.ok(box.classList.contains('notice') && !box.classList.contains('warn'), 'information, not a warning');
    assert.ok(byKey('steps-rail').compareDocumentPosition(box) & 4, 'under the steps list');
    assert.equal(byKey('flow-incomplete-copy'), null, 'a flow on this computer isn’t copied');
  }
  // Not on a page the rules block.
  const saved = structuredClone(local.settings);
  await browser.storage.local.set({ settings: { ...saved, siteAccess: { rules: [{ id: 'mine-n', effect: 'deny', pattern: 'http://localhost:8787/demo/cm/notes-*' }] } } });
  await go('cm/notes-1001.html');
  await until(() => /Power Loader doesn’t work on this page/.test(doc.body.textContent), 'blocked');
  assert.equal(byKey('flow-incomplete'), null);
  await browser.storage.local.set({ settings: saved });
  // Not needed for this flow: put away for that page until the case ends.
  await go('index.html');
  (await until(() => byKey('flow-incomplete-no'), 'the box')).click();
  await until(() => local.case.notInFlow?.includes('http://localhost:8787/demo/index.html') && !byKey('flow-incomplete'), 'put away');
  await go('cm/notes-1001.html');
  await until(() => byKey('flow-incomplete'), 'still asked on another page');
  await go('index.html?x=1');
  await tick(); await tick();
  assert.equal(byKey('flow-incomplete'), null, 'the address without its query');
});

test('a page that is one of the flow’s steps is never asked about, a page to go through included', async () => {
  // The work queue (a page to go through, which Power Loader doesn't recognise as a template) and a fetch
  // step's trigger page are steps of the flow, as the pages it clips are.
  const ref = local.case.clips.find((cl) => cl.values.clientId)?.values.clientId || 'NC-5347';
  for (const file of ['cm/queue.html', `messages/client/${ref}.html`]) {
    await go(file);
    await until(() => byKey('steps-rail'), `the steps on ${file}`);
    for (let i = 0; i < 10; i++) await tick();
    assert.equal(byKey('flow-incomplete'), null, `not asked on ${file}`);
  }
  // A page that isn't one: still asked.
  await go('cm/notes-1001.html');
  await until(() => byKey('flow-incomplete'), 'asked on a page outside the flow');
});

test('with every step done: Finish case', async () => {
  const { updateCase } = await import('../../extension/lib/core.js');
  const { markStep } = await import('../../extension/lib/journey.js');
  await go('index.html');
  await updateCase(local.case.id, (c) => { for (const p of flow.pages) markStep(c, p.id, true); c.submitted.rsr = { how: 'reported', at: 'now' }; });
  const fin = await until(() => byKey('steps-finish'), 'finish');
  assert.equal(fin.textContent, 'Finish case');
  assert.ok(fin.classList.contains('primary'));
  assert.equal(byKey('step-body'), null, 'no step is open');
});

test('for a client with no tenancy reference, Next after the case page is the email asking for one', async () => {
  await browser.storage.local.set({ case: null });
  await until(() => byKey(`start-flow-${flow.id}`), 'start screen');
  byKey(`start-flow-${flow.id}`).click();
  const dlg = await until(() => doc.querySelector('[role=dialog]'), 'confirmation');
  [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Start case').click();
  await until(() => local.case && !local.case.clips.length, 'a new case');
  await go('cm/queue.html');
  await go('cm/case-1009.html');
  await until(() => local.case.ref === '1009', 'reference');
  (await main(/^Clip this page$/, 'clip')).click();
  await until(() => local.case.clips.length === 1, 'clipped');
  await main(/^Next: Ask the client for a missing reference/, 'the email is needed');
  assert.equal(byKey('steps-count').textContent, '2 of 8 steps done');
});

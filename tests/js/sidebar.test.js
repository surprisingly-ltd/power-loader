// The sidebar journeys in jsdom, against the real storage writer and real extraction on the demo pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import '../../extension/lib/extract.js';
import { registerStorageWriter } from '../../extension/lib/storage.js';
import { demoSet, startDemoFlow } from './helpers/library.js';
import { agentOnDom } from './helpers/agent.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const dom = new JSDOM(read('extension/sidebar/sidebar.html'), { url: 'https://extension.invalid/sidebar/sidebar.html', pretendToBeVisual: true });
const { window } = dom;
const doc = window.document;
Object.assign(globalThis, { window, document: doc, DOMParser: window.DOMParser, CSS: window.CSS || { escape: (s) => String(s).replace(/[^\w-]/g, (c) => `\\${c}`) }, Node: window.Node });
if (!globalThis.CSS.escape) globalThis.CSS.escape = (s) => String(s).replace(/[^\w-]/g, (c) => `\\${c}`);
const events = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });
const changed = events();
const set = demoSet();
const local = { library: { current: set.commit, sets: { [set.commit]: set } }, starred: ['hsr'], settings: { welcomed: '2026-11-24T09:00:00.000Z' } };
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
const pageDocs = new Map();
const pageDoc = (url) => {
  if (!pageDocs.has(url)) pageDocs.set(url, new JSDOM(read(`demo/${url.split('/demo/')[1]}`), { url }).window.document);
  return pageDocs.get(url);
};
const fills = [];
// Roughly a browser's innerText, which the agent sends: jsdom's textContent runs a label into its value.
const innerText = (el) => { const c = el.cloneNode(true); for (const b of c.querySelectorAll('p, div, li, dt, dd, td, th, tr, h1, h2, h3, h4, br')) b.append('\n'); return c.textContent.replace(/[ \t]*\n\s*/g, '\n'); };
// Picking runs the real in-page agent on its own copy of the page.
const agents = new Map();
const agentFor = (url) => {
  if (!agents.has(url)) agents.set(url, agentOnDom(new JSDOM(read(`demo/${url.split('/demo/')[1]}`), { url, runScripts: 'outside-only' })));
  return agents.get(url);
};
let page = { id: 1, windowId: 1, active: true, url: 'http://localhost:8787/demo/client-1042.html', title: 'Client' };
const holds = []; // conflicts' values held on their pages
const runtime = events(), tabsUpdated = events(), tabsActivated = events();
const E = globalThis.PowerLoaderExtract;
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
    sendMessage: async (id, msg) => {
      const d = pageDoc(page.url);
      if (msg.type === 'powerloader:ping') return true;
      if (msg.type === 'powerloader:applies') return msg.profiles.map((p) => E.profileApplies(p, page.url, d));
      if (msg.type === 'powerloader:extract') return { ...E.extract(d, msg.profile, { baseUrl: page.url }), url: page.url, title: d.title };
      if (msg.type === 'powerloader:pageText') return { text: innerText(d.body), url: page.url, title: d.title };
      if (msg.type === 'powerloader:probe') return Object.fromEntries(Object.entries(msg.profile.fields).map(([k, s]) => [k, E.probe(d, s)]));
      if (/^powerloader:(pick|override)/.test(msg.type) || msg.type === 'powerloader:labels') return agentFor(page.url).ask(msg);
      // Outlining and holding a value run the real lib/gather.js on the page's copy.
      if (msg.type === 'powerloader:pointValue' && msg.hold) { holds.push({ url: page.url, key: msg.key }); return agentFor(page.url).ask(msg); }
      if (msg.type === 'powerloader:showValues') return agentFor(page.url).ask(msg);
      if (msg.type === 'powerloader:values') return [];
      if (msg.type === 'powerloader:capture') return { url: page.url, title: d.title, documentId: 'doc-1', html: `<!DOCTYPE html>\n${d.documentElement.outerHTML}` };
      if (msg.type === 'powerloader:describeForm') {
        const controls = [...d.querySelectorAll('input:not([type=hidden]), textarea, select')].map((el) => ({ selector: `#${el.id}`, label: d.querySelector(`label[for="${el.id}"]`)?.textContent || el.id }));
        return { url: page.url, documentId: 'doc-1', controls, groups: [] };
      }
      if (msg.type === 'powerloader:fill') {
        fills.push(msg);
        return { filled: msg.plan.items.map((i) => { d.querySelector(i.target).value = i.value; return { target: i.target, label: i.target }; }), failed: [] };
      }
      return null;
    },
  },
};
// The gateway: prompts are packaged files; completions answer with the placeholders they were sent.
const gatewayCalls = [];
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith('http')) return new Response(read(`extension/${url}`));
  const body = JSON.parse(init.body);
  gatewayCalls.push(body);
  // ✦ a profile for a page: one field in the targets, one outside them, one that isn't a field.
  if (/You suggest Power Loader page profiles/.test(body.messages[0].content)) {
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ name: 'Demo index', fields: { landlord: '#library-address', contactPref: 'h1', bogus: 'h1' } }) } }] }));
  }
  const sent = body.messages[1].content;
  const name = (/<redacted:first_name\|ref:[a-z0-9]+\.\d+/.exec(sent) || /<redacted:person_name\|ref:[a-z0-9]+\.\d+/.exec(sent))?.[0];
  const phone = /<redacted:phone\|ref:[a-z0-9]+\.\d+/.exec(sent)?.[0];
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ values: { firstName: { value: `${name}>`, quote: phone ? `number for ${name}>: ${phone}>` : `the client is ${name}>` }, arrears: { value: '1,245.60', quote: 'Arrears are £1,245.60' } } }) } }] }));
};
// jsdom has no Worker: run the calculator's worker body in the test's own thread.
const { solve } = await import('../../extension/lib/calc.js');
globalThis.Worker = class {
  constructor(url) { this.url = String(url); }
  postMessage(d) {
    // The profile assistant: like a computer without WebGPU.
    if (this.url.includes('assist/worker.js')) { setTimeout(() => this.onmessage({ data: { id: d.id, type: 'error', reason: 'webgpu', message: 'This browser doesn’t offer WebGPU to extensions, which the model needs' } }), 0); return; }
    setTimeout(() => { try { this.onmessage({ data: { ok: true, result: solve(d.chosen, d.target, d.opts) } }); } catch (e) { this.onmessage({ data: { ok: false, message: e.message } }); } }, 0);
  }

  terminate() {}
};
registerStorageWriter();
await import('../../extension/sidebar/sidebar.js');

const tick = () => new Promise((r) => setTimeout(r, 5));
const until = async (fn, what = 'UI') => { for (let i = 0; i < 200; i++) { const v = fn(); if (v) return v; await tick(); } throw new Error(`${what} did not settle: ${doc.body.textContent.slice(0, 600)}`); };
const buttons = () => [...doc.querySelectorAll('button')];
const button = (label) => buttons().find((b) => b.textContent.trim() === label);
const buttonLike = (re) => buttons().find((b) => re.test(b.textContent.trim()));
const go = async (file) => {
  page = { ...page, url: `http://localhost:8787/demo/${file}` };
  tabsActivated.listeners.forEach((fn) => fn({ windowId: 1, tabId: 1 }));
  await tick(); await tick();
};
const key = (el, k) => el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true }));

test('tabs are real tabs with panels and arrow keys', async () => {
  await until(() => button('Start'), 'start view');
  const tabs = [...doc.querySelectorAll('[role=tab]')];
  assert.deepEqual(tabs.map((t) => t.textContent), ['Case', 'Tools', 'Privacy', 'Settings']);
  assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
  const panel = doc.getElementById(tabs[0].getAttribute('aria-controls'));
  assert.equal(panel.getAttribute('role'), 'tabpanel');
  tabs[0].focus();
  key(tabs[0], 'ArrowRight');
  await until(() => doc.querySelector('[role=tab][aria-selected=true]')?.textContent === 'Tools');
  assert.equal(doc.activeElement.textContent, 'Tools', 'focus follows the selected tab');
  key(doc.activeElement, 'ArrowLeft');
  await until(() => button('Start'));
});

const DHP = 'f-lib-discretionary-housing-payment';
// Casework never offers to build: no control for making a template or a flow, on any demo page.
const DEMO_PAGES = ['index.html', 'client-1042.html', 'rent-account-1042.html', 'employment-1042.html', 'case-notes-1042.html', 'dhp.html', 'referral.html', 'cases.html', 'cm/case-1001.html', 'cm/queue.html', 'rent-review.html', 'messages/index.html'];
const noBuildingIn = async (where) => {
  for (const file of DEMO_PAGES) {
    await go(file);
    await tick(); await tick();
    const found = [...doc.querySelectorAll('[data-key^="make-"], [data-key^="fl-"], [data-key^="ai-form"]')].map((el) => el.dataset.key);
    assert.deepEqual(found, [], `${where}, on ${file}`);
  }
};

test('two modes, Casework and Build: their own tabs, kept when the sidebar opens again, and no policy hides Build', async () => {
  assert.ok(doc.querySelector('.sb-head.mode-casework'), 'Casework by default');
  assert.equal(doc.querySelector('[data-key="mode-casework"]').getAttribute('aria-pressed'), 'true');
  doc.querySelector('[data-key="mode-build"]').click();
  await until(() => doc.querySelector('.sb-head.mode-build'), 'Build');
  assert.deepEqual([...doc.querySelectorAll('[role=tab]')].map((t) => t.textContent), ['Flows', 'Templates', 'Privacy', 'Settings']);
  await until(() => local.settings.mode === 'build', 'kept in the settings');
  // Opened again (the settings read again): still Build.
  await browser.storage.local.set({ settings: { ...local.settings } });
  await tick(); await tick();
  assert.ok(doc.querySelector('.sb-head.mode-build'));
  // Every policy value set: the switch is still there.
  const { getPolicy } = await import('../../extension/lib/policy.js');
  const p = await getPolicy();
  const saved = structuredClone(p.values);
  for (const v of Object.values(p.values)) if (v && typeof v === 'object') for (const k of Object.keys(v)) if (typeof v[k] === 'boolean') v[k] = !v[k];
  await browser.storage.local.set({ starred: [...(local.starred || [])] });
  await tick(); await tick();
  assert.ok(doc.querySelector('[data-key="mode-build"]') && doc.querySelector('[data-key="mode-casework"]'), 'no policy removes the switch');
  Object.assign(p.values, saved);
  doc.querySelector('[data-key="mode-casework"]').click();
  await until(() => doc.querySelector('.sb-head.mode-casework') && local.settings.mode === 'casework', 'Casework again');
  assert.deepEqual([...doc.querySelectorAll('[role=tab]')].map((t) => t.textContent), ['Case', 'Tools', 'Privacy', 'Settings']);
  await noBuildingIn('Casework, with no case');
  await go('client-1042.html');
});
// Start a demo flow from the start screen: its pages are untested on this computer, so it asks first.
const startFlow = async (id) => {
  (await until(() => doc.querySelector(`[data-key="start-flow-${id}"]`), `start ${id}`)).click();
  const dlg = await until(() => doc.querySelector('[role=dialog]'), 'start confirmation');
  [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Start case').click();
  await until(() => local.case, 'case started');
};

test('the start screen lists flows and nothing else; a starred flow comes first and stays starred', async () => {
  await until(() => doc.querySelector('[data-key="flows-rest"]'), 'flows');
  for (const k of ['case-ref', 'form-search', 'form-cat', 'start-sel']) assert.equal(doc.querySelector(`[data-key="${k}"]`), null, `no ${k}`);
  assert.equal(doc.querySelectorAll('input[type=checkbox][aria-label^="Select"]').length, 0, 'no forms to tick');
  assert.doesNotMatch(doc.body.textContent, /All forms/);
  // The star on a form from before is dropped: stars are on flows, and that one has no flow.
  await until(() => local.starred.length === 0, 'old star dropped');
  doc.querySelector(`[data-key="star-${DHP}"]`).click();
  await until(() => doc.querySelector(`[data-key="flows-starred"] [data-key="flow-card-${DHP}"]`), 'starred first');
  assert.deepEqual(local.starred, ['flows/discretionary-housing-payment.flow.json'], 'a library flow is starred by its path');
  assert.match(doc.body.textContent, /★ Your flows/);
  // Reopened (the storage read again): still starred, still first.
  await browser.storage.local.set({ settings: { ...local.settings } });
  await tick(); await tick();
  assert.equal(doc.querySelector('[data-key="flows-starred"] .fcard').getAttribute('data-key'), `flow-card-${DHP}`);
  assert.equal(doc.querySelector(`[data-key="star-${DHP}"]`).getAttribute('aria-pressed'), 'true');
  await startFlow(DHP);
  assert.deepEqual(local.case.forms.map((f) => f.id), ['dhp']);
  assert.equal(local.case.library.flow.name, 'Discretionary housing payment');
  await until(() => button('Clip this page'), 'case view');
});

test('clipping agrees, conflicts, and a decision settles the conflict', async () => {
  button('Clip this page').click();
  await until(() => local.case?.clips.length === 1);
  await until(() => /Clipped at/.test(doc.body.textContent));
  await go('rent-account-1042.html');
  (await until(() => button('Clip this page'), 'rent account')).click();
  await until(() => local.case?.clips.length === 2);
  await go('employment-1042.html');
  (await until(() => button('Clip this page'), 'employment')).click();
  await until(() => /1 conflict to decide/.test(doc.body.textContent), 'conflict');
  assert.match(doc.body.textContent, /Kowalski/);
  // The clip's line, worked out from the case now: the conflict is named, and its name goes to its card.
  const line = await until(() => doc.querySelector('[data-key="clip-tally"]'), 'the clip’s line');
  assert.match(line.textContent.replace(/\s+/g, ' '), /⚠ 1 conflict: Last name/);
  // The value in the step's list is orange, with ⚠ and the word, which goes to the card too.
  const row = doc.querySelector('[data-gather="lastName"]');
  assert.ok(row.classList.contains('conflict'));
  assert.equal(row.querySelector('.gv-mark').textContent, '⚠');
  assert.equal(row.querySelector('[data-key="gv-cf-lastName"]').textContent, 'Conflict');
  const card = doc.getElementById('cf-card-lastName');
  assert.ok(card && card.getAttribute('tabindex') === '-1', 'the card can take focus');
  line.querySelector('[data-key="clip-tally-cf-lastName"]').click();
  assert.equal(doc.activeElement, card, 'the card has focus');
  assert.ok(card.classList.contains('ring'), 'and is ringed for a moment');
  // Each source on the card goes back to its page: this one is the page in view, so nothing navigates and the
  // value is held there; the client record's opens in this tab (the navigate check), then holds its value.
  const here = local.case.clips.find((x) => x.url === page.url);
  card.querySelector(`[data-key="cf-lastName-src-${here.id}"]`).click();
  await until(() => holds.some((x) => x.url === here.url && x.key === 'lastName'), 'held on this page');
  const first = local.case.clips[0];
  const opened = [];
  browser.tabs.update = async (id, { url }) => { opened.push(url); page = { ...page, url, status: 'complete' }; tabsUpdated.listeners.forEach((fn) => fn(id, { status: 'complete', url }, page)); };
  doc.querySelector(`[data-key="cf-lastName-src-${first.id}"]`).click();
  await until(() => opened.length, 'navigated');
  assert.deepEqual(opened, [first.url]);
  await until(() => holds.some((x) => x.url === first.url && x.key === 'lastName'), 'held on the page it came from');
  assert.equal(doc.querySelector('[data-key="follow-not-here"]'), null, 'the value is there');
  // A value the page doesn't have now: the sidebar says what it read, and when.
  const { act } = await import('../../extension/sidebar/sidebar.js');
  await act.followSource({ url: first.url, key: 'notAField', value: 'Kowalska', at: '14:05' });
  const note = await until(() => doc.querySelector('[data-key="follow-not-here"]'), 'not on this page now');
  assert.match(note.textContent, /notAField isn’t on this page now\. It read Kowalska at 14:05\./);
  delete browser.tabs.update;
  await go('employment-1042.html');
  await until(() => doc.getElementById('conflicts'), 'back on the employment record');
  const conflicts = doc.getElementById('conflicts');
  [...conflicts.querySelectorAll('button')].find((b) => b.textContent === 'Use this').click();
  await until(() => !doc.getElementById('conflicts'));
  // Decided for the first page's value: this page's is overridden, and the line says so.
  await until(() => /1 overridden/.test(doc.querySelector('[data-key="clip-tally"]')?.textContent || ''), 'the line after deciding');
  assert.doesNotMatch(doc.querySelector('[data-key="clip-tally"]').textContent, /conflict/);
  assert.ok(local.case.resolved.lastName);
  assert.ok(local.case.log.some((e) => e.activity === 'resolve_conflict' && e.detail === 'Last name'));
  await noBuildingIn('Casework, in a case');
});

test('another person’s record warns first, and Undo clears its dependents', async () => {
  await go('client-2077.html');
  await until(() => button('Clip this page'));
  button('Clip this page').click();
  const warning = await until(() => doc.querySelector('.idwarn[role=alert]'), 'identity warning');
  assert.match(warning.textContent, /This may be a different person/);
  assert.equal(doc.querySelector('[role=tabpanel]').firstElementChild, warning, 'the warning comes before anything else');
  [...warning.querySelectorAll('button')].find((b) => b.textContent === 'Undo this clip').click();
  const dlg = await until(() => doc.querySelector('[role=dialog]'), 'remove dialog');
  assert.equal(doc.getElementById('app').inert, true, 'the page behind the dialog is inert');
  assert.ok(dlg.contains(doc.activeElement), 'focus moved into the dialog');
  assert.equal(dlg.querySelector('input[value="Wrong person"]').checked, true);
  assert.equal(dlg.querySelector('input[value="page"]').checked, true, 'wrong person purges the page from the log');
  [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Remove clip').click();
  await until(() => local.case.clips.length === 3);
  assert.equal(doc.getElementById('app').inert, false);
  assert.ok(!local.case.log.some((e) => e.url?.includes('client-2077')), 'nothing about the other person stays in the log');
});

test('a typed value is validated, and re-rendering keeps focus and unsaved typing', async () => {
  await go('client-1042.html');
  await until(() => button('Clip again'));
  const row = await until(() => doc.querySelector('[data-key="frow-reason"]'));
  assert.equal(row.getAttribute('aria-expanded'), 'false');
  row.click();
  const box = await until(() => doc.querySelector('[data-key="man-reason"]'));
  assert.equal(doc.querySelector('[data-key="frow-reason"]').getAttribute('aria-expanded'), 'true');
  box.focus();
  box.value = 'Arrears after sickness';
  box.dispatchEvent(new window.Event('input', { bubbles: true }));
  // A change from elsewhere re-renders the sidebar while someone is typing.
  await browser.storage.local.set({ starred: [...local.starred] });
  await tick(); await tick();
  const again = doc.querySelector('[data-key="man-reason"]');
  assert.equal(again.value, 'Arrears after sickness');
  assert.equal(doc.activeElement, again);
  doc.querySelector('[data-key="frow-monthlyRent"]').click();
  const rent = await until(() => doc.querySelector('[data-key="man-monthlyRent"]'));
  rent.value = 'seven hundred';
  rent.dispatchEvent(new window.Event('input', { bubbles: true }));
  doc.querySelector('[data-key="man-monthlyRent-save"]').click();
  const err = await until(() => doc.getElementById('man-monthlyRent-err'));
  assert.match(err.textContent, /Needs fixing: Not an amount of money/);
  assert.equal(doc.querySelector('[data-key="man-monthlyRent"]').getAttribute('aria-describedby'), 'man-monthlyRent-err');
  assert.match(doc.body.textContent, /need fixing/);
});

test('Finish asks for confirmation, closes with Esc, and its teardown leaves a receipt that names no one', async () => {
  const finish = button('Finish case');
  finish.focus();
  finish.click();
  let dlg = await until(() => doc.querySelector('[role=dialog]'));
  assert.match(dlg.textContent, /Not filled/);
  key(dlg, 'Escape');
  await until(() => !doc.querySelector('[role=dialog]'));
  assert.equal(doc.activeElement?.textContent, 'Finish case', 'focus returns to the opener');
  button('Finish case').click();
  dlg = await until(() => doc.querySelector('[role=dialog]'));
  const go2 = [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Finish and delete data');
  assert.equal(go2.disabled, true);
  dlg.querySelector('input[type=checkbox]').click();
  await until(() => ![...doc.querySelectorAll('[role=dialog] button')].find((b) => b.textContent === 'Finish and delete data').disabled);
  [...doc.querySelectorAll('[role=dialog] button')].find((b) => b.textContent === 'Finish and delete data').click();
  await until(() => /Case finished/.test(doc.body.textContent), 'receipt');
  assert.equal(local.case, null);
  assert.match(doc.body.textContent, /3 clips/);
  assert.doesNotMatch(doc.body.textContent, /Maria|Kowalska/);
  assert.equal(local.processLog.length, 1);
  assert.doesNotMatch(JSON.stringify(local.processLog), /Kowalska|07700|QQ/);
});

test('filling shows the plan first, fills values only, keeps a text report, and flags check again', async () => {
  await go('dhp.html');
  await startFlow(DHP);
  assert.equal(local.case.forms[0].id, 'dhp');
  for (const p of ['client-1042.html', 'rent-account-1042.html', 'employment-1042.html']) {
    await go(p);
    (await until(() => button('Clip this page'), `clip ${p}`)).click();
    await until(() => local.case.clips.some((x) => x.url.endsWith(p)), `clipped ${p}`);
  }
  const cf = doc.getElementById('conflicts');
  [...cf.querySelectorAll('button')].find((b) => b.textContent === 'Use this').click();
  await until(() => local.case.resolved.lastName, 'decided');
  await go('dhp.html');
  (await until(() => button('Fill this form'), 'fill button')).click();
  const dlg = await until(() => doc.querySelector('[role=dialog]'), 'plan');
  assert.equal(fills.length, 0, 'nothing touches the page before confirming');
  assert.match(dlg.textContent, /looks the claimant up/);
  assert.match(dlg.textContent, /Left empty/);
  assert.match(dlg.textContent, /Why is help needed\?: Missing/);
  const go2 = [...dlg.querySelectorAll('button')].find((b) => /^Fill \d+ boxes$/.test(b.textContent));
  go2.click();
  await until(() => local.case.filled.dhp, 'filled');
  assert.equal(fills.length, 1);
  assert.ok(!fills[0].plan.items.some((i) => i.target === '#d-reason'));
  assert.equal(fills[0].url, 'http://localhost:8787/demo/dhp.html');
  await until(() => /filled/.test(doc.body.textContent) && button('Fill again'), 'report');
  assert.match(doc.body.textContent, /Power Loader never submits/);
  assert.ok(local.case.log.some((e) => e.activity === 'fill_form'));
  // Remove the rent account clip: the form was filled from it.
  const rent = local.case.clips.find((x) => x.name === 'Rent account');
  doc.querySelector(`[data-key="remove-${rent.id}"]`).click();
  const rm = await until(() => doc.querySelector('[role=dialog]'), 'remove dialog');
  assert.match(rm.textContent, /will be marked “check again”/);
  [...rm.querySelectorAll('button')].find((b) => b.textContent === 'Remove clip').click();
  await until(() => /Check again/.test(doc.body.textContent), 'check again');
});

test('✦ Extract with AI is blocked while the required model isn’t ready, then sends only the redacted text', async () => {
  Object.assign(local.settings ||= {}, { schemaVersion: 1, aiConsent: '2026-11-24', ai: { baseUrl: 'https://gateway.invalid/v1', model: 'fast', auth: 'bearer', maxIterations: 3, maxHtmlChars: 120000, requestTimeoutMs: 120000, operationDeadlineMs: 300000 } });
  session.aiCredential = { baseUrl: 'https://gateway.invalid/v1', key: 'test-key' };
  await browser.storage.local.set({ settings: local.settings });
  // The client record, clipped already: a recognised page can be read with the AI.
  await go('client-1042.html');
  const ai = await until(() => buttonLike(/Read this page with AI/), 'ai button');
  ai.click();
  let dlg = await until(() => doc.querySelector('[role=dialog]'), 'preview');
  assert.match(dlg.textContent, /Check what will be sent/);
  assert.match(dlg.textContent, /privacy model isn’t ready, and your organisation requires it/);
  const send = () => [...doc.querySelectorAll('[role=dialog] button')].find((b) => /✦ Send/.test(b.textContent));
  assert.equal(send().disabled, true);
  assert.equal(gatewayCalls.length, 0);
  [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click();
  await until(() => !doc.querySelector('[role=dialog]'));
  // Policy defaults require the model; relax that for the rest of the journey, as an organisation could.
  const policy = await import('../../extension/lib/policy.js');
  (await policy.getPolicy()).values.privacyModel.required = false;
  (await until(() => { const b = buttonLike(/Read this page with AI/); return b && !b.disabled && b; }, 'ai button again')).click();
  dlg = await until(() => doc.querySelector('[role=dialog]'), 'preview again');
  assert.match(dlg.textContent, /values? redacted/);
  send().click();
  const result = await until(() => [...doc.querySelectorAll('[role=dialog] h2')].find((x) => /Answer from the AI/.test(x.textContent)), 'answer');
  const sent = JSON.stringify(gatewayCalls[0]);
  assert.ok(!/07700 900123|Kowalska/.test(sent), 'personal data stayed on this computer');
  const box = result.closest('[role=dialog]');
  assert.match(box.textContent, /First name.*Maria/);
  [...box.querySelectorAll('button')].find((b) => /^Add \d to case$/.test(b.textContent)).click();
  await until(() => local.case.clips.some((x) => x.kind === 'ai'), 'ai clip');
  const clip = local.case.clips.find((x) => x.kind === 'ai');
  assert.equal(clip.values.arrears, '1245.60');
  assert.equal(clip.values.firstName, 'Maria');
  assert.equal(clip.quotes.firstName, 'the client is Maria', 'the quote is restored exactly as written');
  const log = local.case.log.map((e) => e.activity);
  assert.ok(log.includes('send_to_ai') && log.includes('ai_extract_page'));
  assert.ok(!JSON.stringify(local.case.log).includes('07700'));
});

test('the remote AI asks for an acknowledgement, in the words the caseworker agrees to', async () => {
  // Settings: the acknowledgement is required, in the words the caseworker agrees to.
  [...doc.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Settings').click();
  const consent = await until(() => doc.querySelector('[data-key="ai-consent"]'), 'acknowledgement');
  const words = consent.closest('label').textContent;
  assert.match(words, /contents of the anonymised page/);
  assert.match(words, /anonymisation might not be perfect/);
  assert.match(words, /complies with the relevant laws and my organisation’s policies/);
  assert.equal(consent.checked, true, 'already acknowledged in this wording');
  assert.match(doc.body.textContent, /✦ Remote AI/);
  // An acknowledgement of older wording doesn't count.
  const { aiReady } = await import('../../extension/lib/ai/settings.js');
  assert.equal(aiReady({ aiConsent: true, ai: { baseUrl: 'https://gateway.invalid/v1' } }), false);
  [...doc.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Case').click();
});

test('the calculator finds the arrears payments, marks results stale when inputs change, and saves workings', async () => {
  await go('rent-account-1042.html');
  (await until(() => button('Clip this page'), 'clip rent')).click();
  await until(() => local.case.clips.some((x) => x.name === 'Rent account'), 'rent clipped');
  [...doc.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Tools').click();
  const target = await until(() => doc.querySelector('[data-key=calc-target]'), 'calculator');
  assert.equal(target.value, '1245.60', 'the arrears figure from the case is the default target');
  doc.querySelector('[data-key=calc-run]').click();
  await until(() => /\d+ combinations? found/.test(doc.body.textContent) && /target £1,245\.60/.test(doc.body.textContent), 'results');
  assert.ok(local.case.log.some((e) => e.activity === 'use_calculator' && /combinations found/.test(e.detail)));
  // Change an input: the result is stale and can't be saved until searched again.
  const k = doc.querySelector('[data-key=calc-k]');
  k.value = '2';
  k.dispatchEvent(new window.Event('change'));
  await until(() => /Inputs changed\. These results are for an earlier search/.test(doc.body.textContent), 'stale');
  assert.equal(doc.querySelector('[data-key=calc-save]'), null, 'stale results can’t be saved');
  k.value = '4';
  k.dispatchEvent(new window.Event('change'));
  await until(() => doc.querySelector('[data-key=calc-save]'), 'fresh again');
  doc.querySelector('[data-key=calc-save]').click();
  await until(() => local.case.workings.length === 1, 'saved working');
  assert.ok(local.case.workings[0].uses.length >= 1, 'workings record the clips they used');
  [...doc.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Timeline').click();
  await until(() => /Including gaps/.test(doc.body.textContent) && /Gap 1/.test(doc.body.textContent), 'timeline');
  assert.ok(doc.querySelector('svg[role=img]'));
  doc.querySelector('[data-key=tl-save]').click();
  await until(() => local.case.workings.length === 2 && local.case.log.some((e) => e.activity === 'save_timeline'), 'timeline saved');
});

test('the privacy model comes from Hugging Face unless the caseworker or policy sets another server', async () => {
  [...doc.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Privacy').click();
  (await until(() => doc.querySelector('[data-key=px-src-mirror]'), 'model server choice')).click();
  const input = await until(() => doc.querySelector('[data-key=px-model-url]'), 'model server field');
  assert.match(doc.body.textContent, /Model server \(Hugging Face, the default\): https:\/\/huggingface\.co\//);
  assert.match(doc.body.textContent, /every file is checked against its expected hash/);
  const type = (v) => { const el = doc.querySelector('[data-key=px-model-url]'); el.value = v; el.dispatchEvent(new window.Event('input', { bubbles: true })); };
  type('http://models.example/hf');
  doc.querySelector('[data-key=px-model-save]').click();
  await until(() => /must start with https/.test(doc.getElementById('px-model-url-error')?.textContent), 'error shown');
  assert.equal(local.settings?.privacy?.modelUrl, undefined);
  type('https://models.example/hf');
  doc.querySelector('[data-key=px-model-save]').click();
  await until(() => local.settings?.privacy?.modelUrl === 'https://models.example/hf/', 'saved');
  await until(() => /Model server \(your setting\): https:\/\/models\.example\/hf\//.test(doc.body.textContent), 'shown');
  (await until(() => doc.querySelector('[data-key=px-src-hf]'), 'reset')).click();
  await until(() => local.settings.privacy.modelUrl === null, 'back to default');
  await until(() => /Hugging Face, the default/.test(doc.body.textContent), 'default shown');
  assert.ok(input);
  // Policy sets the address: it is shown locked, and the field goes.
  const { getPolicy } = await import('../../extension/lib/policy.js');
  const pm = (await getPolicy()).values.privacyModel;
  pm.baseUrl = 'https://mirror.example/hf/';
  [...doc.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Settings').click();
  [...doc.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Privacy').click();
  await until(() => /🔒 set by your organisation\): https:\/\/mirror\.example\/hf\//.test(doc.body.textContent), 'locked');
  assert.equal(doc.querySelector('[data-key=px-model-url]'), null);
  pm.baseUrl = null;
});

test('a folder with the model’s files is saved, and Test connection says what it found and what is missing', async () => {
  [...doc.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Privacy').click();
  (await until(() => doc.querySelector('[data-key=px-src-folder]'), 'folder choice')).click();
  await until(() => /Folder address/.test(doc.body.textContent) && /onnx\/model_q4\.onnx_data/.test(doc.body.textContent), 'folder field and its files');
  const type = (v) => { const el = doc.querySelector('[data-key=px-model-url]'); el.value = v; el.dispatchEvent(new window.Event('input', { bubbles: true })); };
  const real = globalThis.fetch;
  const asked = [];
  // The folder has every file but the weights' data file.
  globalThis.fetch = async (url, init) => {
    asked.push([String(url), init?.headers?.Range]);
    if (!String(url).startsWith('https://models.example/pf/') || String(url).endsWith('.onnx_data')) return new Response('', { status: 404 });
    return new Response('x', { status: 206, headers: { 'content-range': 'bytes 0-0/2048' } });
  };
  try {
    type('https://models.example/pf');
    doc.querySelector('[data-key=px-model-test]').click();
    const report = await until(() => doc.querySelector('[data-key=px-model-report]'), 'report');
    assert.match(report.textContent, /Found 4 of the 5 files the model needs\. Missing: onnx\/model_q4\.onnx_data/);
    assert.match(report.textContent, /config\.json ✓ · 2 KB/);
    assert.match(report.textContent, /onnx\/model_q4\.onnx_data ✗ not found \(HTTP 404\)/);
    assert.ok(asked.every(([u, range]) => u.startsWith('https://models.example/pf/') && range === 'bytes=0-0'), 'only the first byte of each file, only from the folder');
    assert.ok(!local.settings?.privacy?.modelFilesUrl, 'testing doesn’t save');
    // The address typed is really a Hugging Face mirror: the test says so and offers to switch.
    globalThis.fetch = async (url) => new Response('x', { status: /\/resolve\//.test(String(url)) ? 200 : 404 });
    type('https://models.example/hf');
    doc.querySelector('[data-key=px-model-test]').click();
    await until(() => /at Hugging Face’s paths under it/.test(doc.querySelector('[data-key=px-model-report]')?.textContent), 'hint');
    doc.querySelector('[data-key=px-model-switch]').click();
    await until(() => /Connected\. Found all 5 files/.test(doc.querySelector('[data-key=px-model-report]')?.textContent) && /Mirror address/.test(doc.body.textContent), 'switched and passed');
    (await until(() => doc.querySelector('[data-key=px-src-folder]'), 'folder choice')).click();
    type('https://models.example/pf');
    doc.querySelector('[data-key=px-model-save]').click();
    await until(() => local.settings?.privacy?.modelFilesUrl === 'https://models.example/pf/' && local.settings.privacy.modelUrl === null, 'saved as a folder');
    await until(() => /Model folder \(your setting\): https:\/\/models\.example\/pf\//.test(doc.body.textContent), 'shown');
  } finally {
    globalThis.fetch = real;
  }
  (await until(() => doc.querySelector('[data-key=px-src-hf]'), 'reset')).click();
  await until(() => local.settings.privacy.modelFilesUrl === null && /Hugging Face, the default/.test(doc.body.textContent), 'back to default');
});

test('settings set by policy are listed and shown locked', async () => {
  const { getPolicy } = await import('../../extension/lib/policy.js');
  const p = await getPolicy();
  p.locked.add('library.baseUrl');
  p.values.library.baseUrl = 'http://localhost:8787/demo/library/';
  // A storage change makes the sidebar read the policy again.
  await browser.storage.local.set({ starred: [...local.starred] });
  [...doc.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Settings').click();
  await until(() => /Set by your organisation/.test(doc.body.textContent), 'policy card');
  assert.match(doc.body.textContent, /library\.baseUrl/);
  assert.match(doc.body.textContent, /takes effect after Firefox restarts/);
  await until(() => doc.querySelector('[data-key=lib-url]')?.disabled, 'locked address');
  assert.ok(button('Check Power Loader is ready') && button('Copy diagnostics') && button('Back up settings and flows'));
});

test('site rules: a blocked page gets one card and no Allow button or auto-clip; links and clips are refused and logged without the address', async () => {
  const core = await import('../../extension/lib/core.js');
  const { act } = await import('../../extension/sidebar/sidebar.js');
  if (!local.case) await startDemoFlow('Discretionary housing payment');
  const saved = structuredClone(local.settings);
  const rules = (pattern) => browser.storage.local.set({ settings: { ...saved, autoClip: true, siteAccess: { rules: [{ id: 'mine-c', effect: 'deny', pattern }] } } });
  await rules('http://localhost:8787/demo/client-*');
  [...doc.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Case').click();
  const clips = local.case.clips.length;
  await go('client-2077.html');
  await until(() => /Power Loader doesn’t work on this page/.test(doc.body.textContent), 'blocked card');
  assert.match(doc.body.textContent, /The site rules in your Settings block reading and filling here\. You can still use the page yourself\./);
  assert.equal(buttonLike(/^Allow on/), undefined);
  assert.equal(button('Clip this page'), undefined);
  await tick(); await tick();
  assert.equal(local.case.clips.length, clips, 'auto-clip never starts on a blocked page');
  // A link to a blocked address isn't opened, and the attempt is logged with no address or pattern.
  const opened = [];
  browser.tabs.update = async (id, { url }) => { opened.push(url); };
  assert.equal(await act.openUrl('http://localhost:8787/demo/client-1042.html'), false);
  assert.deepEqual(opened, []);
  let ev = await until(() => local.case.log.findLast((e) => e.activity === 'blocked_action'), 'logged');
  assert.deepEqual([ev.page_type, ev.url_pattern, ev.detail, 'url' in ev], ['blocked', '(link not kept)', 'navigate · your rule', false]);
  assert.ok(!JSON.stringify(ev).includes('client-'), 'neither the address nor the pattern');
  // A clip started anyway (an old button, a stale view) is refused at the choke point and logged once.
  const lib = core.libraryAt(local.library, local.library.current);
  const profile = lib.profiles.find((p) => E.matchUrl(p.match, page.url));
  await act.clip(profile);
  await act.clip(profile);
  assert.equal(local.case.clips.length, clips);
  const reads = local.case.log.filter((e) => e.activity === 'blocked_action' && e.detail === 'read · your rule');
  assert.equal(reads.length, 1, 'repeated attempts on the same page are logged once');
  // A rule that blocks the whole site: Power Loader never asks Firefox for it.
  const asked = [];
  const request = browser.permissions.request;
  browser.permissions.request = async (o) => { asked.push(o); return true; };
  await rules('http://localhost*');
  await go('rent-account-1042.html');
  await until(() => /Power Loader doesn’t work on this page/.test(doc.body.textContent), 'blocked card for the site');
  await act.requestAccess();
  assert.deepEqual(asked, []);
  // An allowed page on the same system still works once the rule is narrower.
  await rules('http://localhost:8787/demo/client-*');
  await go('rent-account-1042.html');
  await until(() => !/Power Loader doesn’t work on this page/.test(doc.body.textContent), 'works again');
  // Settings lists the rule as the caseworker's own, and Try an address says what it blocks.
  [...doc.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Settings').click();
  const row = await until(() => doc.querySelector('[data-key="sa-own-deny"] [data-source=mine]'), 'own rule listed');
  assert.match(row.textContent, /http:\/\/localhost:8787\/demo\/client-\*.*Yours.*localhost, port 8787, pages \/demo\/client-\* \(http only\)/);
  // The only locked rules are the demo library's: background fetching only from the messages service.
  assert.deepEqual([...doc.querySelectorAll('[data-key^="sa-locked-"]')].map((e) => e.dataset.key), ['sa-locked-allow'], 'nothing else locked is set here');
  assert.match(doc.querySelector('[data-key="sa-locked-allow"]').textContent, /demo\/messages\/message\/\*/);
  const tryBox = doc.querySelector('[data-key=sa-try]');
  tryBox.value = 'http://localhost:8787/demo/client-1042.html';
  tryBox.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.match((await until(() => doc.querySelector('[data-key=sa-try-result]'), 'try')).textContent, /doesn’t work here: blocked by your rule http:\/\/localhost:8787\/demo\/client-\*/);
  const add = doc.querySelector('[data-key=sa-add-deny]');
  add.value = 'https://cm.*.example/';
  add.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.match((await until(() => doc.querySelector('[data-key=sa-add-deny-reads]'), 'reads')).textContent, /can’t read this: \* can only start a host/);
  assert.equal(doc.querySelector('[data-key=sa-add-deny-btn]').disabled, true);
  browser.permissions.request = request;
  delete browser.tabs.update;
  await browser.storage.local.set({ settings: saved });
});

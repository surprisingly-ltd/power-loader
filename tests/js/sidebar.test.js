// The sidebar journeys in jsdom, against the real storage writer and real extraction on the demo pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import '../../extension/lib/extract.js';
import { registerStorageWriter } from '../../extension/lib/storage.js';
import { demoSet } from './helpers/library.js';
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
// Picking runs the real in-page agent on its own copy of the page.
const agents = new Map();
const agentFor = (url) => {
  if (!agents.has(url)) agents.set(url, agentOnDom(new JSDOM(read(`demo/${url.split('/demo/')[1]}`), { url, runScripts: 'outside-only' })));
  return agents.get(url);
};
let page = { id: 1, windowId: 1, active: true, url: 'http://localhost:8787/demo/client-1042.html', title: 'Client' };
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
    query: async () => [page], onUpdated: tabsUpdated, onActivated: tabsActivated,
    sendMessage: async (id, msg) => {
      const d = pageDoc(page.url);
      if (msg.type === 'powerloader:ping') return true;
      if (msg.type === 'powerloader:applies') return msg.profiles.map((p) => E.profileApplies(p, page.url, d));
      if (msg.type === 'powerloader:extract') return { ...E.extract(d, msg.profile, { baseUrl: page.url }), url: page.url, title: d.title };
      if (msg.type === 'powerloader:pageText') return { text: d.body.textContent, url: page.url, title: d.title };
      if (msg.type === 'powerloader:probe') return Object.fromEntries(Object.entries(msg.profile.fields).map(([k, s]) => [k, E.probe(d, s)]));
      if (/^powerloader:(pick|override)/.test(msg.type) || msg.type === 'powerloader:labels') return agentFor(page.url).ask(msg);
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
  const name = /<redacted:(?:first_name|person_name)\|ref:[a-z0-9]+\.\d+/.exec(sent)?.[0];
  const phone = /<redacted:phone\|ref:[a-z0-9]+\.\d+/.exec(sent)?.[0];
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ values: { firstName: { value: `${name}>`, quote: `number for ${name}>: ${phone}>` }, arrears: { value: '1,245.60', quote: 'Arrears are £1,245.60' } } }) } }] }));
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
const deleteDraftNow = async (id) => { const { deleteDraft } = await import('../../extension/lib/core.js'); await deleteDraft(id); button('Done')?.click(); await tick(); };
const key = (el, k) => el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true }));

test('tabs are real tabs with panels and arrow keys', async () => {
  await until(() => button('Start'), 'start view');
  const tabs = [...doc.querySelectorAll('[role=tab]')];
  assert.deepEqual(tabs.map((t) => t.textContent), ['Case', 'Tools', 'Privacy', 'Flows', 'Settings']);
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

test('ticking several forms disables single-form Start and names the forms', async () => {
  const boxes = () => [...doc.querySelectorAll('input[type=checkbox][aria-label^="Select"]')];
  boxes().find((b) => b.getAttribute('aria-label') === 'Select Housing support referral').click();
  await tick();
  boxes().find((b) => b.getAttribute('aria-label') === 'Select Discretionary housing payment').click();
  await until(() => button('Start')?.disabled);
  const start = await until(() => buttonLike(/^Start case: /));
  assert.match(start.textContent, /HSR/);
  assert.match(start.textContent, /DHP/);
  start.click();
  await until(() => button('Clip this page'), 'case view');
  assert.ok(local.case.forms.map((f) => f.id).sort().join() === 'dhp,hsr');
  assert.match(doc.body.textContent, /Housing support referral v4/);
});

test('clipping agrees, conflicts, and a decision settles the conflict', async () => {
  button('Clip this page').click();
  await until(() => local.case?.clips.length === 1);
  await until(() => /Clipped at/.test(doc.body.textContent));
  await go('rent-account-1042.html');
  await until(() => button('Clip this page'));
  button('Clip this page').click();
  await until(() => /1 conflict to decide/.test(doc.body.textContent), 'conflict');
  assert.match(doc.body.textContent, /07700 900123/);
  const conflicts = doc.getElementById('conflicts');
  [...conflicts.querySelectorAll('button')].find((b) => b.textContent === 'Use this').click();
  await until(() => !doc.getElementById('conflicts'));
  assert.equal(local.case.resolved.phone, '07700 900123');
  assert.ok(local.case.log.some((e) => e.activity === 'resolve_conflict' && e.detail === 'Telephone'));
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
  await until(() => local.case.clips.length === 2);
  assert.equal(doc.getElementById('app').inert, false);
  assert.ok(!local.case.log.some((e) => e.url?.includes('client-2077')), 'nothing about the other person stays in the log');
});

test('a typed value is validated, and re-rendering keeps focus and unsaved typing', async () => {
  await go('client-1042.html');
  await until(() => button('Clip again'));
  const row = await until(() => doc.querySelector('[data-key="frow-riskLevel"]'));
  assert.equal(row.getAttribute('aria-expanded'), 'false');
  row.click();
  await until(() => doc.querySelector('[data-key="frow-riskLevel"]').getAttribute('aria-expanded') === 'true');
  doc.querySelector('[data-key="man-riskLevel-High"]').click();
  await until(() => local.case.manual.riskLevel === 'High');
  doc.querySelector('[data-key="frow-tenancyStart"]')?.click();
  doc.querySelector('[data-key="frow-reason"]').click();
  const box = await until(() => doc.querySelector('[data-key="man-reason"]'));
  box.focus();
  box.value = 'Arrears after sickness';
  box.dispatchEvent(new window.Event('input', { bubbles: true }));
  // A change from elsewhere re-renders the sidebar while someone is typing.
  await browser.storage.local.set({ starred: ['hsr', 'dhp'] });
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
  assert.match(doc.body.textContent, /2 clips/);
  assert.doesNotMatch(doc.body.textContent, /Maria|Kowalska/);
  assert.equal(local.processLog.length, 1);
  assert.doesNotMatch(JSON.stringify(local.processLog), /Kowalska|07700|QQ/);
});

test('a page no profile reads gets a profile made for its target form: matched, dragged, picked and tested', async () => {
  await go('index.html');
  (await until(() => button('Make a profile for this page'), 'make profile')).click();
  // Target first: only forms with a fill profile can be chosen; the others say to map them first.
  await until(() => button('Find the values'), 'target chooser');
  assert.match(doc.body.textContent, /Profiles start from the target/);
  assert.equal(doc.querySelector('[data-key="ps-t-coc"]').disabled, true);
  assert.match(doc.body.textContent, /Change of circumstances · map that form first/);
  assert.equal(button('Find the values').disabled, true);
  const dhp = doc.querySelector('[data-key="ps-t-dhp"]');
  dhp.click();
  await until(() => !button('Find the values').disabled, 'target ticked');
  button('Find the values').click();
  await until(() => /Editing draft v1/.test(doc.body.textContent), 'editor');
  assert.deepEqual(local.profileDrafts[0].targets, ['dhp']);
  assert.match(doc.body.textContent, /Gathering for: Discretionary housing payment/);
  // Every target field is a drop zone; the page is outlined by the real agent.
  await until(() => doc.querySelector('[data-field="landlord"]'), 'drop zones');
  assert.equal(doc.querySelectorAll('.ed-row.drop').length, 13, 'DHP fields, less the one you fill in yourself');
  assert.ok(agentFor(page.url).doc.querySelectorAll('[data-powerloader-pick]').length > 0);
  assert.ok(local.profileDrafts[0].assisted);
  // jsdom has no WebGPU, so the model reports itself unavailable and the rules' answer stands.
  await until(() => /On-device model unavailable/.test(doc.body.textContent), 'model status');
  // A value dragged from the page: the agent names it, and the drop puts it in the field.
  await Promise.all(runtime.listeners.map((fn) => fn({ type: 'powerloader:dragPick', selector: 'h1', value: 'Power Loader demo pages', label: null }, { tab: { id: 1 } })));
  const zone = doc.querySelector('[data-field="landlord"]');
  zone.dispatchEvent(new window.Event('dragover', { bubbles: true, cancelable: true }));
  assert.ok(zone.classList.contains('over'));
  zone.dispatchEvent(new window.Event('drop', { bubbles: true, cancelable: true }));
  await until(() => local.profileDrafts[0].profile.fields.landlord === 'h1', 'dropped');
  await until(() => agentFor(page.url).doc.querySelector('h1').getAttribute('data-powerloader-field') === 'Landlord', 'badge on the page');
  // A value clicked on the page is selected and waits for its field.
  await Promise.all(runtime.listeners.map((fn) => fn({ type: 'powerloader:picked', selector: 'h1', value: 'Power Loader demo pages', label: null }, { tab: { id: 1 } })));
  const sel = await until(() => doc.getElementById('ed-sel-key'), 'selection bar');
  assert.match(doc.body.textContent, /Selected on the page: ‘Power Loader demo pages’/);
  sel.value = 'currentEmployer';
  button('Use for this field').click();
  await until(() => local.profileDrafts[0].profile.fields.currentEmployer === 'h1', 'assigned');
  assert.equal(local.profileDrafts[0].picks.find((p) => p.key === 'currentEmployer').by, 'you');
  // "Not this" takes it out again.
  doc.querySelector(`[data-key="ed-${local.profileDrafts[0].id}-currentEmployer-rm"]`).click();
  await until(() => !local.profileDrafts[0].profile.fields.currentEmployer, 'removed');
  button('Test and use on this computer').click();
  await until(() => local.profileDrafts[0].use, 'in use');
  assert.match(doc.body.textContent, /In use on this computer/);
  button('Done').click();
  await until(() => !/Editing draft/.test(doc.body.textContent), 'editor closed');
  assert.equal(agentFor(page.url).doc.querySelectorAll('[data-powerloader-pick]').length, 0, 'the page is left as it was');
});

test('filling shows the plan first, fills values only, keeps a text report, and flags check again', async () => {
  await go('dhp.html');
  const start = await until(() => doc.querySelector('[data-key="start-dhp"]'), 'start DHP');
  start.click();
  await until(() => local.case && local.case.forms[0].id === 'dhp', 'case');
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
  await go('case-notes-1042.html');
  (await until(() => button('Clip this page'), 'clip notes')).click();
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
  assert.ok(!/07700 900456|Kowalska/.test(sent), 'personal data stayed on this computer');
  const box = result.closest('[role=dialog]');
  assert.match(box.textContent, /First name.*Maria/);
  [...box.querySelectorAll('button')].find((b) => /^Add \d to case$/.test(b.textContent)).click();
  await until(() => local.case.clips.some((x) => x.kind === 'ai'), 'ai clip');
  const clip = local.case.clips.find((x) => x.kind === 'ai');
  assert.equal(clip.values.arrears, '1245.60');
  assert.equal(clip.values.firstName, 'Maria');
  assert.equal(clip.quotes.firstName, 'number for Maria: 07700 900456', 'the quote is restored exactly as written');
  const log = local.case.log.map((e) => e.activity);
  assert.ok(log.includes('send_to_ai') && log.includes('ai_extract_page'));
  assert.ok(!JSON.stringify(local.case.log).includes('07700'));
});

test('the remote AI asks for an acknowledgement, then gives a profile for the targets instead of the on-device model', async () => {
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
  // The earlier journey's draft is in use on this page; start without it.
  for (const x of [...local.profileDrafts]) await deleteDraftNow(x.id);
  await go('index.html');
  (await until(() => button('Make a profile for this page'), 'make profile')).click();
  // The open case's forms are ticked already.
  assert.equal((await until(() => doc.querySelector('[data-key="ps-t-dhp"]'), 'targets')).checked, true);
  button('Find the values').click();
  await until(() => /The remote AI is turned on, so the on-device model isn’t used/.test(doc.body.textContent), 'remote in place of local');
  const d0 = local.profileDrafts.at(-1);
  // A value the caseworker placed themselves is kept whatever the AI says.
  await Promise.all(runtime.listeners.map((fn) => fn({ type: 'powerloader:picked', selector: 'h1', value: 'Power Loader demo pages', label: null }, { tab: { id: 1 } })));
  (await until(() => doc.getElementById('ed-sel-key'), 'selection')).value = 'currentEmployer';
  button('Use for this field').click();
  await until(() => local.profileDrafts.at(-1).profile.fields.currentEmployer === 'h1', 'mine');
  const calls = gatewayCalls.length;
  (await until(() => doc.querySelector(`[data-key="ed-remote-${d0.id}"]`), 'remote button')).click();
  const dlg = await until(() => doc.querySelector('[role=dialog]'), 'preview');
  assert.match(dlg.textContent, /Check what will be sent/);
  [...dlg.querySelectorAll('button')].find((b) => /✦ Send/.test(b.textContent)).click();
  await until(() => local.profileDrafts.at(-1).profile.fields.landlord === '#library-address', 'AI profile applied');
  const sent = gatewayCalls[calls].messages[1].content;
  assert.match(sent, /Target forms: Discretionary housing payment/);
  assert.match(sent, /"key":"landlord"/);
  assert.doesNotMatch(sent, /"key":"contactPref"/, 'only the target form’s fields are sent');
  const d = local.profileDrafts.at(-1);
  assert.equal(d.profile.fields.contactPref, undefined, 'a field outside the targets is dropped');
  assert.equal(d.profile.fields.currentEmployer, 'h1', 'the caseworker’s own pick stays');
  assert.deepEqual([d.picks.find((p) => p.key === 'landlord').by, d.picks.find((p) => p.key === 'landlord').check], ['ai', true]);
  assert.match(doc.body.textContent, /Check this · suggested by the remote ai/);
  await deleteDraftNow(d.id);
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
  (await until(() => doc.querySelector('[data-key=px-src-other]'), 'model server choice')).click();
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

test('settings set by policy are listed and shown locked', async () => {
  const { getPolicy } = await import('../../extension/lib/policy.js');
  const p = await getPolicy();
  p.locked.add('library.baseUrl');
  p.values.library.baseUrl = 'http://localhost:8787/demo/library/';
  await browser.storage.local.set({ starred: ['hsr', 'dhp'] });
  [...doc.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Settings').click();
  await until(() => /Set by your organisation/.test(doc.body.textContent), 'policy card');
  assert.match(doc.body.textContent, /library\.baseUrl/);
  assert.match(doc.body.textContent, /takes effect after Firefox restarts/);
  await until(() => doc.querySelector('[data-key=lib-url]')?.disabled, 'locked address');
  assert.ok(button('Check Power Loader is ready') && button('Copy diagnostics') && button('Back up settings, drafts and flows'));
});

// Authoring a flow in the sidebar with no library connected: the form by hand, the page with the remote AI,
// then checked and exported. jsdom, the real storage writer, the real in-page agent on the demo pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import '../../extension/lib/extract.js';
import { registerStorageWriter } from '../../extension/lib/storage.js';
import { agentOnDom } from './helpers/agent.js';
import { indexLibrary } from '../../extension/lib/library.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const dom = new JSDOM(read('extension/sidebar/sidebar.html'), { url: 'https://extension.invalid/sidebar/sidebar.html', pretendToBeVisual: true });
const { window } = dom;
const doc = window.document;
Object.assign(globalThis, { window, document: doc, DOMParser: window.DOMParser, Node: window.Node });
globalThis.CSS = window.CSS?.escape ? window.CSS : { escape: (s) => String(s).replace(/[^\w-]/g, (c) => `\\${c}`) };
const events = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, removeListener() {} });
const changed = events();
const local = {};
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
const agents = new Map();
const agentFor = (url) => {
  if (!agents.has(url)) agents.set(url, agentOnDom(new JSDOM(read(`demo/${url.split('/demo/')[1]}`), { url, runScripts: 'outside-only' })));
  return agents.get(url);
};
let page = { id: 1, windowId: 1, active: true, url: 'http://localhost:8787/demo/index.html', title: 'Power Loader demo pages' };
const runtime = events(), tabsUpdated = events(), tabsActivated = events();
const E = globalThis.PowerLoaderExtract;
const saved = [];
let allowed = true;
let requests = 0;
const blobs = new Map();
URL.createObjectURL = (blob) => { const u = `blob:test/${blobs.size}`; blobs.set(u, blob); return u; };
URL.revokeObjectURL = () => {};
globalThis.browser = {
  storage: { local: area(local, 'local'), session: area(session, 'session'), onChanged: changed },
  runtime: {
    id: 'extension', getURL: (p) => p, getManifest: () => ({ version: 'test' }), onMessage: runtime,
    sendMessage: async (msg) => { const out = await Promise.all(runtime.listeners.map((fn) => fn(msg, { id: 'extension' }))); return out.find((x) => x !== undefined); },
  },
  windows: { getCurrent: async () => ({ id: 1 }) },
  permissions: { contains: async () => allowed, request: async () => { requests++; allowed = true; return true; }, onAdded: events() },
  scripting: { executeScript: async () => [] },
  downloads: { download: async ({ url, filename }) => { saved.push({ filename, text: await blobs.get(url).text() }); return saved.length; }, onChanged: events() },
  tabs: {
    query: async () => [page], onUpdated: tabsUpdated, onActivated: tabsActivated,
    update: async (id, { url }) => { page = { ...page, url }; },
    sendMessage: async (id, msg) => {
      const d = pageDoc(page.url);
      if (msg.type === 'powerloader:ping') return true;
      if (msg.type === 'powerloader:applies') return msg.profiles.map((p) => E.profileApplies(p, page.url, d));
      if (msg.type === 'powerloader:extract') return { ...E.extract(d, msg.profile, { baseUrl: page.url }), url: page.url, title: d.title };
      if (msg.type === 'powerloader:pageText') return { text: d.body.textContent, url: page.url, title: d.title };
      if (msg.type === 'powerloader:probe') return Object.fromEntries(Object.entries(msg.profile.fields).map(([k, s]) => [k, E.probe(d, s)]));
      if (/^powerloader:(pick|override)/.test(msg.type) || msg.type === 'powerloader:labels') return agentFor(page.url).ask(msg);
      if (msg.type === 'powerloader:values') return [...d.querySelectorAll('dd, td, h1')].map((el) => el.textContent.trim());
      if (msg.type === 'powerloader:capture') return { url: page.url, title: d.title, documentId: 'doc-1', html: `<!DOCTYPE html>\n${d.documentElement.outerHTML}` };
      if (msg.type === 'powerloader:describeForm') {
        const controls = [...d.querySelectorAll('input:not([type=hidden]), textarea, select')].map((el) => ({ selector: `#${el.id}`, label: d.querySelector(`label[for="${el.id}"]`)?.textContent.trim() || el.id, tag: el.localName }));
        return { url: page.url, documentId: 'doc-1', controls, groups: [], buttons: [] };
      }
      return null;
    },
  },
};
// The gateway: the page profile request answers with selectors for the flow's fields, and one that isn't one.
const gatewayCalls = [];
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith('http')) return new Response(read(`extension/${url}`));
  const body = JSON.parse(init.body);
  gatewayCalls.push(body);
  const reply = { name: 'Rent account', fields: { landlord: 'dl label(Landlord)', rentArrears: 'dl label(Arrears) | number', rentPerMonth: 'dl label(Monthly rent) | number', bogus: 'h1' } };
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(reply) } }] }));
};
globalThis.Worker = class { postMessage() {} terminate() {} };
registerStorageWriter();
await import('../../extension/sidebar/sidebar.js');

const tick = () => new Promise((r) => setTimeout(r, 5));
const until = async (fn, what = 'UI') => { for (let i = 0; i < 200; i++) { const v = fn(); if (v) return v; await tick(); } throw new Error(`${what} did not settle: ${doc.body.textContent.slice(0, 800)}`); };
const button = (label) => [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
const byKey = (k) => doc.querySelector(`[data-key="${k}"]`);
const go = async (file) => {
  page = { ...page, url: `http://localhost:8787/demo/${file}`, title: pageDoc(`http://localhost:8787/demo/${file}`).title };
  tabsActivated.listeners.forEach((fn) => fn({ windowId: 1, tabId: 1 }));
  await tick(); await tick();
};
const type = (el, value, ev = 'change') => { el.value = value; el.dispatchEvent(new window.Event(ev, { bubbles: true })); };
const pick = (selector, extra = {}) => Promise.all(runtime.listeners.map((fn) => fn({ type: 'powerloader:picked', selector, ...extra }, { tab: { id: 1 } })));
const flow = () => local.flows[0];
const out = () => flow().pages.find((p) => p.role === 'output');
const inp = () => flow().pages.find((p) => p.role === 'input');

test('with no library, a flow is authored: the form by hand, the page with the AI, then checked and exported', async () => {
  // The first open starts on Settings, with what to set up and the privacy model's download right there.
  await until(() => /Welcome to Power Loader/.test(doc.body.textContent), 'welcome');
  assert.equal(doc.querySelector('[role=tab][aria-selected=true]').textContent, 'Settings');
  assert.ok(byKey('set-model-load') && /Download and test the model/.test(byKey('set-model-load').textContent));
  assert.ok(local.settings.welcomed, 'only the first time');
  // The Privacy tab works with no library.
  [...doc.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Privacy').click();
  await until(() => /What to redact/.test(doc.body.textContent) && /Built-in patterns/.test(doc.body.textContent), 'privacy tab');
  [...doc.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Settings').click();
  (await until(() => byKey('welcome-done'), 'welcome again')).click();
  // No library: the start screen offers to connect one, or to make a flow.
  await until(() => /Or make a flow/.test(doc.body.textContent), 'start screen');
  assert.match(doc.body.textContent, /Connect your team’s forms library/);
  byKey('start-new-flow').click();
  const name = await until(() => byKey('fl-name'), 'new flow');
  assert.equal(doc.querySelector('[role=tab][aria-selected=true]').textContent, 'Flows');
  // Typed, then straight to Edit without leaving the box: the guidance is saved and still there on return.
  const guidance = 'Fill the DHP form. The landlord and arrears come from the Harbour Homes rent account. The caseworker writes the reason.';
  type(name, 'Rent arrears help', 'input');
  type(byKey('fl-guidance'), guidance, 'input');
  assert.equal(button(`Edit`)?.textContent, 'Edit');
  byKey(`fl-page-${out().id}`).click();
  await until(() => /Which form does this flow fill\?/.test(doc.body.textContent), 'page editor');
  assert.equal(flow().guidance, guidance);
  assert.equal(flow().name, 'Rent arrears help');
  byKey('fl-back').click();
  await until(() => byKey('fl-guidance')?.value === guidance, 'guidance shown again');
  assert.equal(byKey('fl-name').value, 'Rent arrears help');
  assert.match(doc.body.textContent, /1\. Forms to fill/);
  assert.match(doc.body.textContent, /Form to fill 1 isn’t made yet/);

  // The form to fill first: the sidebar says where to go, then the page is used.
  byKey(`fl-page-${out().id}`).click();
  // Not configured yet: use the page in this tab, or paste an address.
  await until(() => byKey('fl-bind') && /Use the current form/.test(byKey('fl-bind').textContent), 'choice');
  assert.match(doc.body.textContent, /This tab: Power Loader demo pages · localhost:8787/);
  assert.match(doc.body.textContent, /Or paste the form’s address/);
  // A pasted address is kept and opened in this tab, which then is the current page.
  byKey('fl-goto-url').value = 'http://localhost:8787/demo/dhp.html';
  byKey('fl-goto').click();
  await until(() => page.url.endsWith('/dhp.html') && out().url === 'http://localhost:8787/demo/dhp.html', 'navigated');
  await go('dhp.html');
  await until(() => /This tab: New DHP application/.test(doc.body.textContent), 'current page shown');
  byKey('fl-bind').click();
  await until(() => out().draft?.kind === 'fill', 'bound');
  assert.equal(out().name, pageDoc(page.url).title.split(/ [–|-] /)[0].trim(), 'named after the form');
  assert.equal(out().url, 'http://localhost:8787/demo/dhp.html');
  // No AI configured: the line and the button itself lead to where it's turned on, and the manual tool is there.
  assert.match(doc.body.textContent, /The ✦ Remote AI is off\. Turn it on in Settings, or make it by hand/);
  byKey('fl-ai').click();
  await until(() => doc.querySelector('[role=tab][aria-selected=true]').textContent === 'Settings', 'sent to Settings');
  assert.ok(doc.getElementById('ai-setup'));
  [...doc.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Flows').click();
  await until(() => byKey('fl-manual'), 'back to the page');
  byKey('fl-manual').click();
  const add = await until(() => byKey('fl-add'), 'typeahead');
  // Every box on the form is outlined, empty or not.
  const agentDoc = agentFor(page.url).doc;
  await until(() => agentDoc.querySelectorAll('[data-powerloader-pick]').length === agentDoc.querySelectorAll('input:not([type=hidden]), select, textarea').length, 'boxes outlined');
  assert.ok([...doc.querySelectorAll('#fl-add-list option')].some((o) => o.value === 'Landlord'), 'the form’s labels are offered');
  // A name the form itself uses maps its box straight away.
  add.value = 'Landlord';
  byKey('fl-add-go').click();
  await until(() => out().draft.profile.fields['#d-landlord'] === 'CaseData.landlord', 'mapped from the form’s label');
  // A new name waits for its box.
  byKey('fl-add').value = 'Rent arrears';
  byKey('fl-add-go').click();
  await until(() => /Now click the box for Rent arrears/.test(doc.body.textContent), 'waiting for its box');
  await pick('#d-arrears', { label: 'Arrears (£)', value: '' });
  await until(() => out().draft.profile.fields['#d-arrears'] === 'CaseData.rentArrears', 'mapped');
  assert.equal(flow().fields.rentArrears.type, 'money');
  // Or click a box first, then name its field.
  await pick('#d-rent', { label: 'Monthly rent (£)', value: '' });
  await until(() => /Selected on the page/.test(doc.body.textContent), 'selection');
  byKey('fl-add').value = 'Rent per month';
  byKey('fl-add-go').click();
  await until(() => out().draft.profile.fields['#d-rent'] === 'CaseData.rentPerMonth', 'mapped by selection');
  // A label from the form maps its own box straight away; the caseworker types this one.
  byKey('fl-add').value = 'Why is help needed';
  byKey('fl-add-go').click();
  await until(() => out().draft.profile.fields['#d-reason'], 'mapped from the form’s label');
  const key = out().draft.profile.fields['#d-reason'].replace('CaseData.', '');
  (await until(() => byKey(`fl-r-${key}-manual`), 'typed checkbox')).click();
  await until(() => flow().fields[key].manual, 'typed by the caseworker');
  await until(() => agentDoc.querySelector('#d-landlord').getAttribute('data-powerloader-field') === 'Landlord', 'badge on the page');
  byKey('fl-test').click();
  await until(() => out().draft.tested?.ok, 'tested');
  // Validated at each stage: nothing gathers the form's fields yet.
  byKey('fl-page-done').click();
  await until(() => /No page gathers Landlord, which a form requires/.test(doc.body.textContent), 'missing source');
  assert.ok(button('The caseworker types it'), 'each problem offers its fixes');
  assert.equal(agentDoc.querySelectorAll('[data-powerloader-pick]').length, 0, 'the form is left as it was');

  // The page to clip, with the remote AI.
  Object.assign(local.settings ||= {}, { schemaVersion: 1, aiConsent: '2026-11-24', ai: { baseUrl: 'https://gateway.invalid/v1', model: 'fast', auth: 'bearer', maxIterations: 3, maxHtmlChars: 120000, requestTimeoutMs: 120000, operationDeadlineMs: 300000 } });
  session.aiCredential = { baseUrl: 'https://gateway.invalid/v1', key: 'test-key' };
  (await (await import('../../extension/lib/policy.js')).getPolicy()).values.privacyModel.required = false;
  await browser.storage.local.set({ settings: local.settings });
  byKey(`fl-page-${inp().id}`).click();
  // A site Power Loader may not read yet: the same button asks Firefox first, then uses the page.
  allowed = false;
  await go('rent-account-1042.html');
  await until(() => /Firefox asks you to allow Power Loader on this site first/.test(doc.body.textContent), 'permission note');
  (await until(() => { const b = byKey('fl-bind'); return b && /Use the current page/.test(b.textContent) && /This tab: Tenancy/.test(doc.body.textContent) && b; }, 'use this page')).click();
  await until(() => inp().draft?.kind === 'extract', 'bound');
  assert.equal(requests, 1, 'asked once, in the click');
  assert.doesNotMatch(inp().name, /Kowalska/, 'never named after the person on the page');
  (await until(() => { const b = byKey('fl-ai'); return b && !b.disabled && /Generate the extraction profile with AI/.test(b.textContent) && b; }, 'ai button')).click();
  const dlg = await until(() => doc.querySelector('[role=dialog]'), 'preview');
  assert.match(dlg.textContent, /Flow guidance/);
  [...dlg.querySelectorAll('button')].find((b) => /✦ Send/.test(b.textContent)).click();
  await until(() => inp().draft.profile.fields.landlord === 'dl label(Landlord)', 'AI profile applied');
  const sent = gatewayCalls[0].messages[1].content;
  assert.match(sent, /^Guidance from the flow's author:\nFill the DHP form/);
  assert.match(sent, /"key":"landlord"/);
  assert.doesNotMatch(sent, new RegExp(`"key":"${key}"`), 'a field the caseworker types isn’t looked for');
  assert.doesNotMatch(JSON.stringify(gatewayCalls[0]), /Kowalska/, 'personal data stayed on this computer');
  assert.equal(inp().draft.profile.fields.bogus, undefined);
  assert.match(doc.body.textContent, /Check this · suggested by the AI/);
  byKey('fl-test').click();
  await until(() => inp().draft.tested?.ok, 'page tested');
  byKey('fl-page-done').click();
  await until(() => byKey('fl-export') && /✓ Ready to export/.test(doc.body.textContent), 'ready');

  // Export: one file with the flow and the library files it becomes.
  byKey('fl-export').click();
  await until(() => saved.length && flow().exported, 'exported');
  assert.equal(saved[0].filename, 'rent-arrears-help.flow.json');
  const file = JSON.parse(saved[0].text);
  assert.equal(file.schema, 'powerloader-flow/1');
  assert.match(file.exported.contentHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(indexLibrary({ files: file.files }, { approvedHosts: file.hosts }).problems, []);
  assert.doesNotMatch(saved[0].text, /Kowalska/);
  byKey('fl-done').click();
  await until(() => byKey('fl-new') && /✓ Exported/.test(doc.body.textContent), 'list');
  // Edited again from the list, the saved guidance is shown.
  byKey(`fl-open-${flow().id}`).click();
  await until(() => byKey('fl-guidance')?.value.startsWith('Fill the DHP form'), 'guidance from storage');
  byKey('fl-done').click();
  await until(() => byKey('fl-new'), 'list again');
});

test('the flow guides the caseworker: a page to visit, steps with templated links, and a timeline of payments', async () => {
  byKey(`fl-open-${flow().id}`).click();
  (await until(() => byKey('fl-add-guide'), 'pages to visit')).click();
  const guide = () => flow().pages.find((p) => p.role === 'guide');
  await until(() => guide(), 'page to visit added');
  assert.match(doc.body.textContent, /3\. Pages to visit/);
  (await until(() => byKey(`fl-page-${guide().id}`), 'edit it')).click();
  await go('cases.html');
  (await until(() => { const b = byKey('fl-bind'); return b && /Use the current page/.test(b.textContent) && b; }, 'use this page')).click();
  await until(() => guide().url === 'http://localhost:8787/demo/cases.html', 'bound');
  assert.equal(guide().draft, null, 'nothing is read on a page to visit');
  // Its heading is text on the page, so it isn't used as the name: the author names it.
  assert.equal(guide().name, 'Page to visit 1');
  type(byKey('fl-page-name'), 'My cases');
  await until(() => guide().name === 'My cases', 'renamed');
  type(await until(() => byKey(`fl-step-${guide().id}`), 'instructions'), 'Pick up the oldest case marked New. Type its client number as the case reference.');
  await until(() => /oldest case/.test(guide().step?.text || ''), 'instructions saved');
  byKey('fl-ln-add').click();
  await until(() => guide().step.links.length === 1, 'link added');
  const link = guide().step.links[0];
  assert.equal(link.to, inp().id, 'a new link opens the next step');
  type(byKey(`fl-ln-${link.id}-url`), 'http://localhost:8787/demo/rent-account-{nope}.html');
  await until(() => /uses \{nope\}, which isn’t a field/.test(doc.body.textContent), 'bad name reported');
  type(byKey(`fl-ln-${link.id}-url`), 'http://localhost:8787/demo/rent-account-{ref}.html');
  type(byKey(`fl-ln-${link.id}-label`), 'Open the rent account');
  await until(() => guide().step.links[0].label === 'Open the rent account' && !/which isn’t a field/.test(doc.body.textContent), 'link saved');
  byKey('fl-page-done').click();
  await until(() => /The caseworker’s steps/.test(doc.body.textContent) && /1\. My cases/.test(doc.body.textContent), 'steps in order');
  assert.ok(byKey('fl-steps-ai'), 'the AI can write the steps from the guidance');

  // A timeline: pointers for the payments on the rent account, read from its table's rows.
  byKey('fl-tl-add').click();
  await until(() => byKey('fl-tl-name'), 'timeline editor');
  type(byKey('fl-tl-name'), 'Payments');
  byKey('fl-s-add-point').click();
  const series = () => flow().timelines[0].series[0];
  await until(() => series(), 'series added');
  const sid = `fl-s-${series().id}`;
  type(byKey(`${sid}-name`), 'Payments');
  type(byKey(`${sid}-rows`), '#payments tbody tr');
  type(byKey(`${sid}-label`), 'td:nth-of-type(2)');
  type(byKey(`${sid}-at`), 'td:nth-of-type(1)');
  type(byKey(`${sid}-shape`), 'square');
  await until(() => series().source.at === 'td:nth-of-type(1)' && series().shape === 'square', 'series saved');
  assert.equal(series().source.pageId, inp().id, 'the page to clip is chosen for you');
  await go('rent-account-1042.html');
  (await until(() => { const b = byKey(`${sid}-test`); return b && b; }, 'test button')).click();
  await until(() => /✓ 11 dated rows/.test(doc.body.textContent) && /Tenant payment: 2026-01-06/.test(doc.body.textContent), 'tested on the page');
  assert.ok(!JSON.stringify(flow()).includes('2026-01-06'), 'nothing from the page is kept in the flow');
  byKey('fl-tl-done').click();
  await until(() => /✓ Ready to export/.test(doc.body.textContent) && /✓ 1 series/.test(doc.body.textContent), 'ready, with its timeline');
  byKey('fl-done').click();
  await until(() => byKey('fl-new'), 'list again');
});

test('a case starts from the flow with no library: clipping its page, then filling its form', async () => {
  byKey(`fl-start-${flow().id}`).click();
  await until(() => local.case, 'case started');
  assert.equal(doc.querySelector('[role=tab][aria-selected=true]').textContent, 'Case');
  assert.match(local.case.library.commit, /^flow-/);
  assert.deepEqual(local.case.library.flow, { id: flow().id, name: 'Rent arrears help' });
  assert.ok(local.library.sets[local.case.library.commit], 'the flow is stored as the set the case pins');
  assert.equal(local.library.current, undefined, 'and no library is connected');
  // The page to clip is recognised by the flow's profile.
  await go('rent-account-1042.html');
  (await until(() => button('Clip this page'), 'clip button')).click();
  await until(() => local.case.clips.length === 1, 'clipped');
  assert.equal(local.case.clips[0].values.landlord, 'Harbour Homes Ltd');
  assert.equal(local.case.clips[0].values.rentArrears, '1245.60');
  // The form to fill is recognised too.
  await go('dhp.html');
  await until(() => button('Fill this form'), 'fill');
  // A changed flow doesn't change the open case: it keeps the version it started with.
  const commit = local.case.library.commit;
  const { updateFlow } = await import('../../extension/lib/core.js');
  await updateFlow(flow().id, (f) => { f.name = 'Renamed'; });
  assert.equal(local.case.library.commit, commit);
  assert.ok(local.library.sets[local.case.library.commit]);
  // While a case is open, another can't start from a flow.
  doc.querySelector('[role=tab]:nth-child(4)').click();
  await until(() => byKey(`fl-start-${flow().id}`), 'flows list');
  assert.equal(byKey(`fl-start-${flow().id}`).disabled, true);
});

test('the case shows its steps: the link waits for the case reference, then opens the next page; the timeline is the flow’s', async () => {
  [...doc.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Case').click();
  await go('cases.html');
  await until(() => /Steps · /.test(doc.body.textContent) && /oldest case marked New/.test(doc.body.textContent), 'steps card');
  assert.match(doc.body.textContent, /you’re on it now/);
  const open = byKey('step-link-0');
  assert.equal(open.textContent, 'Open the rent account');
  assert.equal(open.disabled, true, 'it needs the case reference');
  assert.match(doc.body.textContent, /A link needs Case reference/);
  type(byKey('step-var-ref'), '1042', 'input');
  byKey('step-var-ref-use').click();
  await until(() => local.case.ref === '1042' && byKey('step-link-0') && !byKey('step-link-0').disabled, 'reference saved');
  byKey('step-link-0').click();
  await until(() => page.url === 'http://localhost:8787/demo/rent-account-1042.html', 'opened the next page');
  await until(() => local.case.steps?.[flow().pages.find((p) => p.role === 'guide').id]?.done, 'following the link completes the page to visit');
  assert.ok(local.case.log.some((e) => e.activity === 'follow_step_link'));
  // The Tools tab's timeline offers the flow's own, with the payments clipped from the rent account.
  [...doc.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Tools').click();
  [...(await until(() => doc.querySelectorAll('[role=tab]').length > 4 && doc.querySelectorAll('[role=tab]'), 'tools'))].find((t) => t.textContent === 'Timeline').click();
  const show = await until(() => byKey('tl-show'), 'show choice');
  assert.match(show.value, /^def:/, 'the flow’s timeline is shown first');
  assert.deepEqual([...show.querySelectorAll('option')].map((o) => o.textContent), ['Payments', 'Only the ticked dates', 'All dates in the case']);
  await until(() => doc.querySelectorAll('svg.tl-svg rect[width="11"]').length === 11, 'eleven square pointers');
  assert.match(doc.body.textContent, /6 Jan 2026 · Payments: Tenant payment/);
  type(show, 'all');
  await until(() => /Every period and date in the case/.test(doc.body.textContent), 'all dates');
});

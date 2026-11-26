// Two kinds of step that aren't a web page: an email written from the case and opened in the caseworker's
// email app (a mailto: link), and a screenshot read with OCR on this computer for the values a step names,
// the case reference among them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import '../../extension/lib/extract.js';
import { demoLibrary, demoSet } from './helpers/library.js';
import { addClip, newCase, setManual } from '../../extension/lib/case.js';
import { indexLibrary } from '../../extension/lib/library.js';
import {
  addField, addPage, addRead, compileFlow, contract, exportFlow, importFlow, newFlow, pagesOf, removeField, setEmail, setRead, validateFlow,
} from '../../extension/lib/flows.js';
import { emailErrors, emailFor, markStep, scanErrors, stepStatus, validateSteps, withRefField } from '../../extension/lib/journey.js';
import { matchDocument, stepProfile } from '../../extension/lib/reader/match.js';

const { window } = new JSDOM('<!DOCTYPE html><body></body>', { url: 'https://extension.invalid/sidebar/sidebar.html' });
Object.assign(globalThis, { window, document: window.document, Node: window.Node });
globalThis.browser = { runtime: { getURL: (p) => p } };
const { rd, stepReader } = await import('../../extension/sidebar/tools/reader-ui.js');
const codes = (issues) => issues.map((i) => i.code);
const lines = (text) => text.split('\n').map((t) => ({ text: t, page: 1, confidence: 92 }));

test('an email is filled in from the case, encoded into a mailto: link, and refuses a value that would add a recipient', () => {
  const vars = { ref: 'CM-104233', lastName: 'Kowalska & Sons?', landlordEmail: 'lettings@harbour.example', dob: '3 Mar 1980' };
  const e = emailFor({ to: '{landlordEmail}, housing@council.example', cc: '', subject: 'Case {ref}:\n{lastName}', body: 'Dear landlord,\nTenant born {dob}.' }, vars);
  assert.deepEqual(e.to, ['lettings@harbour.example', 'housing@council.example']);
  assert.equal(e.subject, 'Case CM-104233: Kowalska & Sons?', 'a subject is one line');
  assert.equal(e.mailto, 'mailto:lettings@harbour.example,housing@council.example?subject=Case%20CM-104233%3A%20Kowalska%20%26%20Sons%3F&body=Dear%20landlord%2C%0D%0ATenant%20born%203%20Mar%201980.');
  // Values are encoded, so text from a page can't add a header such as bcc.
  assert.doesNotMatch(e.mailto, /&bcc|\?bcc/);
  const missing = emailFor({ to: '{landlordEmail}', subject: 'Re {ref}' }, { ref: '' });
  assert.equal(missing.mailto, null);
  assert.deepEqual(missing.missing.sort(), ['landlordEmail', 'ref']);
  for (const v of ['a@b.example, evil@x.example', 'a@b.example?bcc=evil@x.example', 'not an address']) {
    const bad = emailFor({ to: '{landlordEmail}', subject: 'x' }, { landlordEmail: v });
    assert.equal(bad.mailto, null, v);
    assert.ok(bad.bad.length, v);
  }
  assert.deepEqual(emailErrors({ to: 'bob, {nope}', subject: '' }, {}), ['the to uses {nope}, which isn’t a field', '“bob” in to isn’t an email address or a {field}', 'needs a subject or some text']);
});

test('a screenshot step finds each value after its anchor, or by its shape anywhere, else by the field’s label; the case reference too', () => {
  const lib = demoLibrary();
  const step = { id: 'shot', name: 'CaseWorks header', role: 'scan', scan: { fields: { ref: { pattern: '\\b(CM-\\d{6})\\b' }, arrears: { anchor: 'Balance owed' }, postcode: {} } } };
  const text = 'CaseWorks 4.2   File  Edit  View\nOpen case CM-104233 (priority)\nBalance owed: £1,245.60\nPostcode SW1A 1AA\nCM-999999 linked';
  const out = matchDocument(lines(text), { ...lib, fields: withRefField(lib.fields) }, Object.keys(step.scan.fields), [stepProfile(step)]);
  const by = Object.fromEntries(out.rows.map((r) => [r.key, r]));
  assert.equal(by.ref.value, 'CM-104233', 'the first text with its shape, and only the bracketed part');
  assert.equal(by.arrears.value, '1245.60');
  assert.equal(by.postcode.value, 'SW1A 1AA', 'no anchor or shape: found next to its label');
  assert.match(by.ref.by, /^step CaseWorks header/);
  assert.equal(by.postcode.by, 'label');
  assert.deepEqual(scanErrors({ fields: {} }, lib.fields), ['needs at least one value to read']);
  assert.deepEqual(scanErrors({ fields: { ref: { pattern: '(' }, nope: {} } }, lib.fields), ['Case reference: its shape isn’t a valid pattern', 'reads nope, which isn’t a field']);
});

test('in a flow, a screenshot gathers its fields, an email uses them, and both compile to steps.json, export and import', () => {
  const flow = newFlow({ name: 'Arrears' });
  const out = pagesOf(flow, 'output')[0];
  const ref = addField(flow, { label: 'Landlord email', type: 'email' });
  const caseNo = addField(flow, { label: 'Tenancy number' });
  out.required = [caseNo];
  const shot = addPage(flow, 'scan');
  const mail = addPage(flow, 'email');
  assert.equal(shot.name, 'Screenshot to read 1');
  assert.ok(codes(validateFlow(flow)).includes('scan-bad'), 'a screenshot that reads nothing is a problem');
  assert.ok(codes(validateFlow(flow)).includes('email-bad'), 'an empty email is a problem');
  addRead(shot, 'ref', { pattern: 'CM-\\d{6}' });
  addRead(shot, caseNo, { anchor: 'Tenancy no' });
  addRead(shot, caseNo); // once only
  setRead(shot, caseNo, { anchor: 'Tenancy no.' });
  assert.deepEqual(contract(flow).find((r) => r.key === caseNo).gathered, [shot.id], 'the screenshot gathers it');
  setEmail(mail, { to: '{landlordEmail}', subject: 'Tenancy {tenancyNumber} ({ref})', body: 'Dear landlord,\n{unknownThing}' });
  assert.ok(validateFlow(flow).some((i) => i.code === 'email-bad' && /unknownThing/.test(i.text)));
  setEmail(mail, { body: 'Dear landlord, about tenancy {tenancyNumber}.' });
  const issues = validateFlow(flow).filter((i) => i.pageId === shot.id || i.pageId === mail.id);
  assert.deepEqual(issues, []);
  assert.ok(!validateFlow(flow).some((i) => i.key === ref && i.code === 'unused'), 'a field the email uses isn’t unused');
  const { files } = compileFlow(flow);
  const steps = files['steps.json'].steps;
  const s = steps.find((x) => x.id === shot.id);
  const m = steps.find((x) => x.id === mail.id);
  assert.deepEqual(s.scan, { fields: { ref: { pattern: 'CM-\\d{6}' }, tenancyNumber: { anchor: 'Tenancy no.' } } });
  assert.deepEqual(m.email, { to: '{landlordEmail}', subject: 'Tenancy {tenancyNumber} ({ref})', body: 'Dear landlord, about tenancy {tenancyNumber}.' });
  assert.ok(steps.indexOf(s) < steps.indexOf(m), 'a screenshot comes before the forms, an email after them');
  assert.deepEqual(validateSteps(files['steps.json'], files['fields.json'].fields), []);
  const back = importFlow(JSON.parse(JSON.stringify(exportFlow(flow))));
  assert.deepEqual(pagesOf(back, 'scan')[0].scan, shot.scan);
  assert.deepEqual(pagesOf(back, 'email')[0].email, mail.email);
  removeField(flow, caseNo);
  assert.deepEqual(shot.scan.reads.map((r) => r.key), ['ref'], 'a removed field is no longer read');
});

test('a flow’s email and scan steps are untrusted: bad ones are reported', () => {
  const set = { ...demoSet(), flow: { id: 'f-x', name: 'Imported' } };
  set.files['steps.json'] = { schema: 'powerloader-steps/1', steps: [
    { id: 'm', name: 'Email', role: 'email', text: '', email: { to: '{nope}', subject: 'x' } },
    { id: 's', name: 'Shot', role: 'scan', text: '', scan: { fields: { ref: { pattern: '[' } } } },
  ] };
  const lib = indexLibrary(set, { approvedHosts: ['localhost:8787'] });
  const errs = lib.problems.find((p) => p.path === 'steps.json')?.errors || [];
  assert.ok(errs.some((e) => /the email the to uses \{nope\}/.test(e)), errs.join('\n'));
  assert.ok(errs.some((e) => /its shape isn’t a valid pattern/.test(e)), errs.join('\n'));
});

test('on the Case tab a screenshot step checks what it read, sets the case reference, adds values as a clip and is done', async () => {
  const lib = demoLibrary();
  const step = { id: 'shot', name: 'CaseWorks header', role: 'scan', text: '', links: [], scan: { fields: { ref: { pattern: 'CM-\\d{6}' }, arrears: { anchor: 'Balance owed' } } } };
  lib.steps = [step];
  const c = newCase(lib, ['dhp']);
  const context = { data: { case: c, settings: {} }, lib, ui: { page: { url: 'about:blank' } }, act: { render: () => {}, update: async (fn) => fn(c, lib) } };
  const render = () => { document.body.replaceChildren(stepReader(context, step)); return document.body; };
  assert.ok(render().querySelector('[data-key=st-rd-zone]'), 'a place to paste the screenshot');
  // Another step's (or the Tools reader's) result isn't shown here.
  rd.result = { stepId: null, name: 'other.png', how: 'paste', pages: [{ n: 1, how: 'ocr' }], rows: [], text: 'x', chosen: new Set() };
  assert.doesNotMatch(render().textContent, /other\.png/);
  rd.result = {
    stepId: 'shot', stepName: step.name, name: 'Pasted picture', how: 'paste', kind: 'image', size: 10, pages: [{ n: 1, how: 'ocr' }], text: 'Open case CM-104233\nBalance owed: £1,245.60',
    rows: [
      { key: 'ref', raw: 'CM-104233', value: 'CM-104233', quote: 'Open case CM-104233', page: 1, confidence: 'high', ok: true, by: 'step' },
      { key: 'arrears', raw: '£1,245.60', value: '1245.60', quote: 'Balance owed: £1,245.60', page: 1, confidence: 'high', ok: true, by: 'step' },
    ],
    chosen: new Set(['ref', 'arrears']),
  };
  const body = render();
  assert.match(body.textContent, /Case reference/);
  assert.match(body.textContent, /read for CaseWorks header/);
  body.querySelector('[data-key=rd-add]').click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(c.ref, 'CM-104233');
  assert.equal(c.clips.length, 1);
  assert.deepEqual(c.clips[0].values, { arrears: '1245.60' }, 'the reference is the case’s own, not a clipped field');
  assert.equal(stepStatus(c, step), 'done');
  assert.ok(c.log.some((e) => e.activity === 'read_pasted_image' && !/CM-104233/.test(e.detail)), 'the log says what was done, not the values');
  assert.ok(c.log.some((e) => e.activity === 'complete_step'));
  rd.result = null;
});

test('on the Case tab an email step shows the email written from the case and a link that opens the email app', async () => {
  const { renderCaseTab } = await import('../../extension/sidebar/caseview.js');
  const { caseVars } = await import('../../extension/lib/journey.js');
  const lib = demoLibrary();
  const step = { id: 'mail', name: 'Tell the landlord', role: 'email', text: 'Attach the award letter.', links: [], email: { to: '{email}', subject: 'Case {ref}: {lastName}', body: 'Born {dob}.' } };
  lib.steps = [step];
  const c = newCase(lib, ['dhp']);
  c.ref = 'CM-1';
  setManual(c, 'lastName', 'Kowalska');
  addClip(c, lib, { source: 'x', kind: 'page', profile: { id: 'p', version: 'v1' }, name: 'x', url: '', title: 'x', capturedAt: new Date().toISOString(), values: { dob: '1980-03-03' }, quotes: {}, records: [], extra: {} });
  assert.equal(emailFor(step.email, caseVars(c, lib, { text: true })).body, 'Born 3 Mar 1980.', 'dates are written as a person reads them');
  const context = { data: { case: c, settings: {}, lib }, lib, ui: { view: {}, page: { url: 'about:blank' }, info: null }, act: { render: () => {}, refresh: () => {}, openUrl: () => {}, update: async (fn) => { fn(c, lib); } } };
  const render = () => { document.body.replaceChildren(...[renderCaseTab(context)].flat(Infinity).filter(Boolean)); return document.body; };
  let body = render();
  assert.match(body.textContent, /Email to send/);
  assert.match(body.textContent, /Case CM-1: Kowalska/);
  assert.equal(body.querySelector('[data-key=step-email-open]').disabled, true, 'it needs the email address');
  assert.match(body.textContent, /The email needs the Email/);
  assert.ok(body.querySelector('[data-key=step-var-email]'), 'which can be typed here');
  setManual(c, 'email', 'maria@example.org');
  body = render();
  const open = body.querySelector('a[data-key=step-email-open]');
  assert.equal(open.getAttribute('href'), 'mailto:maria@example.org?subject=Case%20CM-1%3A%20Kowalska&body=Born%203%20Mar%201980.');
  // jsdom can't follow a mailto: link; the email app is the browser's to open.
  document.addEventListener('click', (e) => e.preventDefault(), { once: true });
  open.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(stepStatus(c, step), 'done', 'opening it in the email app completes the step');
  assert.ok(c.log.some((e) => e.activity === 'open_email' && e.detail === 'Tell the landlord'));
  assert.ok(!JSON.stringify(c.log).includes('maria@'), 'the log has no values');
  markStep(c, 'mail', false);
  assert.equal(stepStatus(c, step), 'todo');
});

test('the Flows tab lists screenshots and emails, and their editors write the step', async () => {
  const local = {};
  globalThis.browser = {
    runtime: { id: 'extension', getURL: (p) => p, getManifest: () => ({ version: 'test' }), sendMessage: async () => {}, onMessage: { addListener() {} } },
    storage: {
      session: { get: async () => ({}), set: async () => {} },
      local: {
        get: async (keys) => structuredClone(Object.fromEntries([keys].flat().filter((k) => k in local).map((k) => [k, local[k]]))),
        set: async (patch) => { Object.assign(local, structuredClone(patch)); },
        clear: async () => { for (const k of Object.keys(local)) delete local[k]; },
      },
    },
  };
  const { registerStorageWriter } = await import('../../extension/lib/storage.js');
  registerStorageWriter();
  const { renderFlows, flowUi } = await import('../../extension/sidebar/flows.js');
  const flow = newFlow({ name: 'Arrears' });
  addField(flow, { label: 'Landlord email', type: 'email' });
  const shot = addPage(flow, 'scan');
  const mail = addPage(flow, 'email');
  local.flows = [flow];
  const context = () => ({ data: { flows: local.flows, settings: {}, lib: null }, lib: null, ui: { page: { url: 'about:blank' }, tab: 'flows' }, act: { render: () => {}, refresh: () => {} } });
  const render = () => { document.body.replaceChildren(...[renderFlows(context())].flat(Infinity).filter(Boolean)); return document.body; };
  const byKey = (k) => document.querySelector(`[data-key="${k}"]`);
  const change = (el, v) => { el.value = v; el.dispatchEvent(new window.Event('change', { bubbles: true })); };
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const pageNow = (id) => local.flows[0].pages.find((p) => p.id === id);
  Object.assign(flowUi, { open: flow.id, page: null });
  let body = render();
  assert.match(body.textContent, /4\. Screenshots to read/);
  assert.match(body.textContent, /5\. Emails to send/);
  assert.match(body.textContent, /Reads nothing yet/);
  assert.ok(byKey('fl-add-scan') && byKey('fl-add-email'));
  // The screenshot's editor: add the case reference and give it a shape.
  Object.assign(flowUi, { page: shot.id });
  body = render();
  assert.match(body.textContent, /It reads nothing yet/);
  assert.deepEqual([...byKey('fl-rd-add').querySelectorAll('option')].map((o) => o.textContent), ['+ Add a value to read…', 'Case reference', 'Landlord email']);
  change(byKey('fl-rd-add'), 'ref');
  await settle();
  assert.deepEqual(pageNow(shot.id).scan.reads.map((r) => r.key), ['ref']);
  render();
  change(byKey('fl-rd-ref-pattern'), 'CM-\\d{6}');
  await settle();
  assert.deepEqual(pageNow(shot.id).scan.reads, [{ key: 'ref', anchor: '', pattern: 'CM-\\d{6}' }]);
  // The email's editor.
  Object.assign(flowUi, { page: mail.id });
  body = render();
  assert.match(body.textContent, /Power Loader doesn’t send it/);
  change(byKey(`fl-em-${mail.id}-subject`), 'Case {ref}');
  await settle();
  assert.equal(pageNow(mail.id).email.subject, 'Case {ref}');
  render();
  change(byKey('fl-em-ins'), 'landlordEmail');
  await settle();
  assert.equal(pageNow(mail.id).email.body, '{landlordEmail}', 'a value is put in the text');
  Object.assign(flowUi, { page: null });
  assert.match(render().textContent, /Subject: Case \{ref\}/);
  Object.assign(flowUi, { open: null });
});

test('a page to clip can wait before auto-clip, for a page that loads its data: compiled, exported and checked', async () => {
  const { setAutoClipDelay, bindPage } = await import('../../extension/lib/flows.js');
  const { autoClipDelay } = await import('../../extension/lib/journey.js');
  const flow = newFlow({ name: 'Slow pages' });
  const inp = pagesOf(flow, 'input')[0];
  bindPage(flow, inp.id, { url: 'http://localhost:8787/demo/rent-account-1042.html', title: 'Rent account' });
  inp.draft.profile.fields = { landlord: '#tenancy label(Landlord)' };
  setAutoClipDelay(inp, 1000);
  assert.equal(inp.autoClipDelay, 1000);
  setAutoClipDelay(inp, 1234);
  assert.equal(inp.autoClipDelay, undefined, 'only the offered waits');
  setAutoClipDelay(inp, 2000);
  const { files } = compileFlow(flow);
  const step = files['steps.json'].steps.find((s) => s.id === inp.id);
  assert.equal(step.autoClipDelay, 2000, 'a wait alone makes steps.json');
  assert.equal(autoClipDelay({ steps: files['steps.json'].steps }, step.profileId), 2000);
  assert.equal(autoClipDelay({ steps: [] }, step.profileId), 0, 'no step: clipped as soon as it loads');
  assert.equal(pagesOf(importFlow(JSON.parse(JSON.stringify(exportFlow(flow)))), 'input')[0].autoClipDelay, 2000);
  assert.ok(validateSteps({ schema: 'powerloader-steps/1', steps: [{ ...step, autoClipDelay: 60000 }] }).some((e) => /autoClipDelay/.test(e)));
});

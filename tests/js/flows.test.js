// Flows: authoring the forms a case fills and the pages it clips from, with no library, on the demo pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import '../../extension/lib/extract.js';
import {
  addField, addPage, applyFormAnswer, applyPageAnswer, bindPage, compileFlow, contract, exportBlocked, exportFlow, fieldKey, flowLib, flowReady,
  guessType, importFlow, mapPick, newFlow, pageOf, pagesOf, removeField, removePage, setField, validateFlow,
} from '../../extension/lib/flows.js';
import { judgeFillTest, judgeTest, recordTest, testedNow } from '../../extension/lib/drafts.js';
import { indexLibrary } from '../../extension/lib/library.js';
import { buildRequest, runTask } from '../../extension/lib/ai/tasks.js';
import { registerPresenter } from '../../extension/lib/ai/boundary.js';
import { effectiveSettings } from '../../extension/lib/privacy-detect.js';

const E = globalThis.PowerLoaderExtract;
const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const base = 'http://localhost:8787/demo/';
const pageDoc = (file) => new JSDOM(read(`demo/${file}`), { url: base + file }).window.document;
globalThis.browser = { runtime: { getURL: (p) => p } };
globalThis.fetch = async (p) => new Response(read(`extension/${p}`));
const codes = (issues) => issues.map((i) => i.code);

// The DHP form's boxes, as the agent describes them.
const dhp = pageDoc('dhp.html');
const boxes = [...dhp.querySelectorAll('input:not([type=hidden]), textarea, select')].map((el) => ({ selector: `#${el.id}`, label: dhp.querySelector(`label[for="${el.id}"]`)?.textContent.trim(), tag: el.localName }));
const fillProbe = (doc, draft) => Object.fromEntries(Object.entries(draft.profile.fields).map(([box]) => [box, E.probe(doc, box)]));
const pageProbe = (doc, draft) => Object.fromEntries(Object.entries(draft.profile.fields).map(([k, s]) => [k, E.probe(doc, s)]));

const files = {};
function rentFlow() {
  const flow = newFlow({ name: 'Rent arrears help', guidance: 'Fill the DHP form with the landlord and arrears from the rent account.' });
  const out = pagesOf(flow, 'output')[0];
  const inp = pagesOf(flow, 'input')[0];
  bindPage(flow, out.id, { url: `${base}dhp.html?x=1`, title: 'Discretionary housing payment' });
  bindPage(flow, inp.id, { url: `${base}rent-account-1042.html`, title: 'Maria Kowalska: rent account', values: ['Maria Kowalska'] });
  Object.assign(files, { [out.id]: 'dhp.html', [inp.id]: 'rent-account-1042.html' });
  const landlord = addField(flow, { label: 'Landlord' });
  const arrears = addField(flow, { label: 'Rent arrears', type: 'money' });
  const reason = addField(flow, { label: 'Reason', manual: true });
  mapPick(out, landlord, '#d-landlord');
  mapPick(out, arrears, '#d-arrears');
  mapPick(out, reason, '#d-reason');
  mapPick(inp, landlord, 'dl label(Landlord)');
  mapPick(inp, arrears, 'dl label(Arrears)', { filter: 'number' });
  return { flow, out, inp };
}

function testAll(flow) {
  const lib = flowLib(flow);
  for (const p of flow.pages) {
    const file = files[p.id];
    const doc = pageDoc(file);
    const t = p.role === 'output' ? judgeFillTest(p.draft, fillProbe(doc, p.draft), { url: base + file, lib }) : judgeTest(p.draft, pageProbe(doc, p.draft), { url: base + file, lib, pageValues: ['Maria Kowalska', 'Harbour Homes Ltd'] });
    recordTest(p.draft, t);
  }
}

test('a new flow has one form to fill and one page to clip, and keeps at least one of each', () => {
  const flow = newFlow();
  assert.deepEqual(flow.pages.map((p) => p.role), ['output', 'input']);
  assert.throws(() => removePage(flow, flow.pages[0].id), /at least one form to fill/);
  const more = addPage(flow, 'input');
  assert.equal(more.name, 'Page to clip 2');
  assert.ok(removePage(flow, more.id));
  assert.deepEqual(codes(validateFlow(flow)), ['no-name', 'unbound', 'unbound']);
});

test('field keys and types come from the name, and a field is defined once', () => {
  assert.equal(fieldKey('Date of birth'), 'dateOfBirth');
  assert.equal(fieldKey('Date of birth', { dateOfBirth: {} }), 'dateOfBirth2');
  assert.equal(fieldKey('2nd line'), 'f2ndLine');
  assert.deepEqual(['Date of birth', 'NI number', 'Monthly rent (£)', 'Postcode', 'Landlord'].map(guessType), ['date', 'nino', 'money', 'postcode', 'text']);
  const flow = newFlow();
  const a = addField(flow, { label: 'Landlord' });
  assert.equal(addField(flow, { label: 'landlord' }), a, 'the same label is the same field');
  assert.throws(() => addField(flow, { label: ' ' }), /needs a name/);
});

test('binding a page records its address and never names it after a person', () => {
  const { flow, out, inp } = rentFlow();
  assert.equal(out.url, `${base}dhp.html`, 'the query is dropped');
  assert.equal(out.name, 'Discretionary housing payment');
  assert.equal(out.draft.kind, 'fill');
  assert.equal(inp.name, 'Page to clip 1', 'the title held a value from the page');
  assert.equal(inp.draft.kind, 'extract');
  assert.equal(inp.url, `${base}rent-account-{ref}.html`, 'the link pattern hides the record');
  assert.ok(!E.matchUrl(inp.draft.profile.match, `${base}dhp.html`), 'the form isn’t taken for a page to clip');
  assert.ok(E.matchUrl(inp.draft.profile.match, `${base}rent-account-2077.html`));
  assert.deepEqual(out.required, ['landlord', 'rentArrears', 'reason'], 'a form’s fields start required');
  assert.ok(flow.fields.reason.manual);
});

test('a flow is checked at each stage: untested pages, ungathered fields, then ready; it compiles to a valid library', () => {
  const { flow, out, inp } = rentFlow();
  let issues = validateFlow(flow);
  assert.deepEqual(codes(issues), ['untested', 'untested']);
  testAll(flow);
  assert.ok(testedNow(out.draft) && testedNow(inp.draft));
  issues = validateFlow(flow);
  assert.deepEqual(issues, []);
  assert.ok(flowReady(issues));
  // A required field no page gathers is an error that the AI can help with; the caseworker typing it fixes it too.
  const nino = addField(flow, { label: 'NI number', type: 'nino' });
  mapPick(out, nino, '#d-nino');
  testAll(flow);
  issues = validateFlow(flow);
  const missing = issues.find((i) => i.code === 'not-gathered');
  assert.equal(missing.level, 'error');
  assert.deepEqual(missing.keys, [nino]);
  assert.ok(missing.ai);
  setField(flow, nino, { manual: true });
  assert.deepEqual(validateFlow(flow), []);
  // A page that reads something no form uses gets a warning.
  const tenancy = addField(flow, { label: 'Tenancy type' });
  mapPick(inp, tenancy, 'dl label(Tenancy type)');
  testAll(flow);
  assert.deepEqual(codes(validateFlow(flow)), ['not-used']);
  removeField(flow, tenancy);
  assert.equal(inp.draft.profile.fields.tenancyType, undefined);
  // The compiled files are a library set the library's own checks accept.
  const { files, hosts } = compileFlow(flow);
  assert.deepEqual(hosts, ['localhost:8787']);
  const lib = indexLibrary({ files }, { approvedHosts: hosts });
  assert.deepEqual(lib.problems, []);
  const form = lib.forms['discretionary-housing-payment'];
  assert.deepEqual(form.fields, [{ key: 'landlord', required: true }, { key: 'rentArrears', required: true }, { key: 'reason', required: true }, { key: nino, required: true }]);
  assert.equal(form.fill, 'fill/discretionary-housing-payment');
  assert.equal(lib.fill[0].fields['#d-arrears'], 'CaseData.rentArrears');
  assert.equal(lib.profiles[0].fields.rentArrears, 'dl label(Arrears) | number');
  assert.equal(lib.fields.rentArrears.section, 'Rent arrears help');
  // The extracted value passes the field's validator, as a clip would.
  assert.equal(E.extract(pageDoc('rent-account-1042.html'), lib.profiles[0], { baseUrl: `${base}rent-account-1042.html` }).data.landlord, 'Harbour Homes Ltd');
});

test('a failing field and a profile holding page values are errors; a leak blocks export', () => {
  const { flow, inp } = rentFlow();
  mapPick(inp, 'landlord', 'dd:contains("Harbour Homes Ltd")');
  testAll(flow);
  const issues = validateFlow(flow);
  assert.ok(issues.some((i) => i.code === 'leaks'));
  assert.ok(exportBlocked(issues));
  mapPick(inp, 'landlord', '#nothing-here');
  testAll(flow);
  const broken = validateFlow(flow).find((i) => i.code === 'broken');
  assert.deepEqual([broken.key, broken.ai], ['landlord', true]);
  assert.match(broken.text, /Matches nothing on this page/);
});

test('export and import: the file carries the flow and its library files, and pages come back untested', () => {
  const { flow } = rentFlow();
  testAll(flow);
  const body = exportFlow(flow);
  assert.equal(body.schema, 'powerloader-flow/1');
  assert.deepEqual(Object.keys(body.files).sort(), ['fields.json', 'forms/discretionary-housing-payment.json', 'profiles/fill/discretionary-housing-payment.json', 'profiles/pages/localhost/page-to-clip-1.json']);
  assert.deepEqual(body.problems, []);
  assert.doesNotMatch(JSON.stringify(body), /Kowalska/);
  const back = importFlow(JSON.parse(JSON.stringify(body)));
  assert.notEqual(back.id, flow.id);
  assert.equal(back.name, 'Rent arrears help');
  assert.deepEqual(Object.keys(back.fields), Object.keys(flow.fields));
  assert.deepEqual(back.pages.map((p) => p.draft.profile.fields), flow.pages.map((p) => p.draft.profile.fields));
  assert.deepEqual(codes(validateFlow(back)), ['untested', 'untested']);
  assert.throws(() => importFlow({ schema: 'powerloader-profile/1' }), /isn’t a Power Loader flow file/);
});

test('the AI’s answers: form fields join the contract, own picks stay, unknown boxes are dropped', () => {
  const { flow, out, inp } = rentFlow();
  const r = applyFormAnswer(flow, out.id, { fields: [
    { box: '#d-landlord', key: 'landlordName', label: 'Landlord', type: 'text' }, // the author mapped it already
    { box: '#d-dob', key: 'dob', label: 'Date of birth', type: 'date' },
    { box: '#d-postcode', key: 'post', label: 'rent arrears' }, // same label as a field the flow has
    { box: '#invented', key: 'x', label: 'Invented' },
    { box: '#d-uc', key: 'uc', label: 'Universal Credit', typed: true, required: false },
  ] }, boxes);
  assert.equal(r.added, 2, 'Date of birth and Universal Credit');
  assert.deepEqual(r.dropped, ['#d-landlord', '#invented']);
  const picks = out.draft.picks;
  assert.equal(picks.find((p) => p.box === '#d-landlord').by, 'you');
  assert.deepEqual(picks.find((p) => p.box === '#d-dob'), { box: '#d-dob', key: 'dob', by: 'ai', check: true });
  assert.equal(picks.find((p) => p.box === '#d-postcode').key, 'rentArrears');
  assert.ok(flow.fields.uc.manual);
  assert.ok(!out.required.includes('uc'));
  applyPageAnswer(inp, { landlord: 'h1', dob: 'dl label(Date of birth)' }, { only: ['dob'] });
  assert.equal(inp.draft.profile.fields.landlord, 'dl label(Landlord)', 'the author’s pick stays');
  assert.equal(inp.draft.profile.fields.dob, 'dl label(Date of birth)');
  assert.ok(contract(flow).find((c) => c.key === 'dob').gathered.length);
});

test('✦ for a form to fill sends the guidance and the boxes, never typed values, and keeps only real boxes', async () => {
  registerPresenter(async () => true);
  const flow = newFlow({ name: 'Test', guidance: 'Collect the landlord and the arrears.' });
  addField(flow, { label: 'Landlord' });
  const lib = flowLib(flow);
  const form = { controls: boxes.map((b) => ({ ...b, current: 'typed by the caseworker' })), groups: [] };
  const context = { known: [], patterns: [], settings: effectiveSettings(), identifierTypes: {}, model: { ready: true, required: false } };
  const calls = [];
  const completeFn = async (payload) => { calls.push(payload); return JSON.stringify({ name: 'DHP', fields: [
    { box: '#d-landlord', key: 'landlord', label: 'Landlord', type: 'text', required: true },
    { box: '#d-arrears', key: 'arrears', label: 'Arrears', type: 'money' },
    { box: '#nope', key: 'x', label: 'X' },
    { box: '#d-first', key: 'firstName', label: `<redacted:first_name|ref:${payload.ns}.1>` },
  ] }); };
  const out = await runTask('flowForm', { form, title: 'DHP', url: `${base}dhp.html`, guidance: flow.guidance }, { lib, context: () => context, config: {}, completeFn });
  const sent = calls[0].messages[1].content;
  assert.match(sent, /^Guidance from the flow's author:\nCollect the landlord and the arrears\./);
  assert.match(sent, /"key":"landlord"/);
  assert.doesNotMatch(JSON.stringify(calls[0].messages), /typed by the caseworker/);
  assert.match(calls[0].messages[0].content, /You help an author build a Power Loader flow/);
  assert.deepEqual(out.fields.map((f) => f.box), ['#d-landlord', '#d-arrears']);
  assert.deepEqual(out.dropped, ['#nope', '#d-first']);
  assert.equal(out.fields[1].type, 'money');
  // The page profile request carries the guidance as its own part, so it is previewed and redacted too.
  const req = buildRequest('profile', { html: '<p>x</p>', url: `${base}rent-account-1042.html`, title: 'Rent', document: new JSDOM('').window.document, keys: ['landlord'], guidance: flow.guidance }, { lib, system: '' });
  assert.equal(req.parts[0].id, 'guidance');
});

test('a flow from a library form copies its fill profile and the pages that read its fields, counted as tested', async () => {
  const { demoLibrary } = await import('./helpers/library.js');
  const lib = demoLibrary();
  const { flowFromLibrary, startable, flowSet } = await import('../../extension/lib/flows.js');
  const flow = flowFromLibrary(lib, ['dhp']);
  assert.equal(flow.name, 'Discretionary housing payment');
  const [form] = pagesOf(flow, 'output');
  assert.deepEqual([form.formId, form.form.version, form.url], ['dhp', 'v2', lib.forms.dhp.url]);
  assert.ok(form.required.includes('nino') && !form.required.includes('tenancyStart'));
  assert.deepEqual(pagesOf(flow, 'input').map((p) => p.profileId).sort(), ['biv/employment', 'cm/client-record', 'harbour-homes/rent-account']);
  // The client record reads more than DHP needs, so its copy keeps only DHP's fields and needs a test here.
  const client = pagesOf(flow, 'input').find((p) => p.profileId === 'cm/client-record');
  assert.equal(client.draft.profile.fields.email, undefined);
  assert.equal(client.draft.tested, null);
  assert.ok(flow.fields.nino.identity === 'strong' && flow.fields.nino.accepts.includes('nino'), 'library definitions are kept');
  assert.ok(flow.fields.reason.manual);
  // Its files are a valid library with the form as published; a case can start from it.
  const can = startable(flow);
  assert.ok(can.ok, can.reason);
  assert.deepEqual(can.formIds, ['dhp']);
  assert.deepEqual(can.untested.sort(), ['Client record', 'Employment and income', 'Rent account']);
  assert.ok(testedNow(form.draft), 'the published fill profile counts as tested until it is changed');
  const set = flowSet(flow, { hash: 'abc123', base: lib });
  assert.match(set.commit, /^flow-[0-9a-f]+-abc123$/);
  const flowLibrary = indexLibrary(set);
  assert.deepEqual(flowLibrary.problems, []);
  assert.equal(flowLibrary.forms.dhp.version, 'v2');
  assert.deepEqual(flowLibrary.forms.dhp.confirmation, lib.forms.dhp.confirmation);
  assert.equal(flowLibrary.fill[0].fields['#d-nino'], 'CaseData.nino');
  assert.ok(flowLibrary.privacy, 'the library’s privacy patterns come along');
  assert.deepEqual([...new Set(validateFlow(flow).filter((i) => i.level === 'error').map((i) => i.code))], ['untested']);
  // A new flow with nothing made can't start a case.
  assert.match(startable(newFlow({ name: 'x' })).reason, /Make a form to fill first/);
});

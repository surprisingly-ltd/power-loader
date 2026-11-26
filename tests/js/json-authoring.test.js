// Authoring a profile that reads JSON, without the sidebar: what clicking a value in the tree can pick
// (lib/json-dom.js pickFor()) and that it probes correctly, rows picks (lib/drafts.js), the leak check with
// every value and data-like key in the sample, and a JSON page through bindJsonPage(), compile, export and import.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import '../../extension/lib/extract.js';
import '../../extension/lib/json-dom.js';
import { addRowField, editDraft, judgeTest, newPageDraft, removeRowField, rowPicksOf, togglePick } from '../../extension/lib/drafts.js';
import { judgeDocument, probeFields, responseValues } from '../../extension/lib/fetch-steps.js';
import { addField, addPage, addRequest, bindJsonPage, compileFlow, exportFlow, importFlow, mapPick, newFlow, readsJson, validateFlow } from '../../extension/lib/flows.js';

const J = globalThis.PowerLoaderJson;
const E = globalThis.PowerLoaderExtract;
const documentSource = new JSDOM('').window.document;
const parse = (text) => J.jsonToDocument(text, { documentSource }).doc;
const URL_ = 'https://cm.example.gov.uk/api/clients/1042';
const lib = { fields: { dob: { label: 'Date of birth', type: 'date' }, lastName: { label: 'Last name' }, nino: { label: 'NI number', type: 'nino' }, address2: { label: 'Address line 2' } } };

const sample = parse(JSON.stringify({
  clientId: 'NC-1042',
  person: { lastName: 'Kowalska', dateOfBirth: '1986-07-14', 'first name': 'Maria', nino: 'QQ 12 34 56 C', address2: 'Mill Lane', notes: null, flags: { vulnerable: true } },
  payments: [{ paidOn: '2026-10-01', amount: 412.5 }, { paidOn: '2026-11-01', amount: 400 }],
  accounts: { 'RA-10421': { status: 'Open' }, 'RA-10422': { status: 'Closed' } },
  byMonth: { january: { amount: 1 }, february: { amount: 2 }, march: { amount: 3 } },
  'jane@example.org': 'owner',
  facts: [{ name: 'Status', value: 'Open' }],
}));
const el = (path) => [...sample.getElementsByTagName('*')].find((x) => J.pathOf(x) === path);
const draft = () => { const d = newPageDraft({ url: URL_, title: 'Client data' }); d.profile.format = 'json'; return d; };

test('the tree picker’s selector probes the value it was clicked on, exactly once', () => {
  for (const path of ['.clientId', '.person.dateOfBirth', '.person.["first name"]', '.payments[1].amount', '.facts[0].value']) {
    const pick = J.pickFor(el(path));
    assert.ok(pick.single, path);
    const p = J.probeJson(sample, pick.single);
    assert.equal(p.count, 1, path);
    assert.equal(p.value, el(path).textContent, path);
    assert.equal(J.selectorToPath(pick.single), path, 'shown back as the same path');
  }
  assert.equal(J.pickFor(el('.person.dateOfBirth')).rows, null, 'not in a list');
});

test('inside a list of objects: just this one by position, or every item as rows', () => {
  const pick = J.pickFor(el('.payments[1].amount'));
  assert.equal(pick.single, ":root > [key='payments'] > [index='1'] > [key='amount']");
  assert.deepEqual(pick.rows, { group: 'payments', rows: ":root > [key='payments'] > *", field: 'amount', item: ":scope > [key='amount']", position: 1 });
  const d = draft();
  assert.equal(addRowField(d, pick.rows), 'payments');
  addRowField(d, J.pickFor(el('.payments[0].paidOn')).rows);
  assert.deepEqual(d.profile.fields.payments, [":root > [key='payments'] > *", { amount: ":scope > [key='amount']", paidOn: ":scope > [key='paidOn']" }]);
  assert.deepEqual(E.extract(sample, d.profile).data.payments, [{ amount: '412.5', paidOn: '2026-10-01' }, { amount: '400', paidOn: '2026-11-01' }]);
  assert.deepEqual(rowPicksOf(d), [{ group: 'payments', rows: ":root > [key='payments'] > *", items: { amount: ":scope > [key='amount']", paidOn: ":scope > [key='paidOn']" } }]);
  // Picks and rows live side by side: a pick doesn't drop the rows, and the rows don't take a pick's key.
  togglePick(d, ":root > [key='clientId']", 'payments');
  assert.ok(Array.isArray(d.profile.fields.payments));
  assert.equal(addRowField(d, J.pickFor(el('.byMonth.january.amount')).rows), 'byMonth');
  removeRowField(d, 'payments', 'amount');
  removeRowField(d, 'payments', 'paidOn');
  assert.equal(d.profile.fields.payments, undefined, 'the list goes with its last field');
  assert.throws(() => addRowField(d, { ...pick.rows, field: '2nd' }), /letters and digits/);
});

test('a key that looks like data is never written into a selector; an object can’t be a value', () => {
  const inMap = J.pickFor(el('.accounts.["RA-10421"].status'));
  assert.equal(inMap.single, null);
  assert.match(inMap.why, /looks like data/);
  assert.deepEqual(inMap.rows, { group: 'accounts', rows: ":root > [key='accounts'] > *", field: 'status', item: ":scope > [key='status']", position: null });
  assert.deepEqual(E.extract(sample, { fields: { a: [inMap.rows.rows, { id: '@key', status: inMap.rows.item }] } }).data.a, [{ id: 'RA-10421', status: 'Open' }, { id: 'RA-10422', status: 'Closed' }]);
  const personal = J.pickFor(el('.["jane@example.org"]'), { isPersonal: (k) => k.includes('@') });
  assert.equal(personal.single, null);
  assert.equal(J.pickFor(el('.person')).why, 'Pick a value inside it');
  assert.equal(J.probeJson(sample, ":root > [key='person']").error, 'Pick a value inside it');
});

test('the leak check: every value in the sample and every data-like key; ordinary keys are structure', () => {
  const ok = draft();
  ok.profile.fields = { dob: ":root > [key='person'] > [key='dateOfBirth'] | date", lastName: ":root > [key='person'] > [key='lastName']", address2: ":root > [key='person'] > [key='address2']" };
  const t = judgeDocument(ok, sample, { url: URL_, lib });
  assert.deepEqual(t.leaks, [], 'dateOfBirth and address2 are keys, not values');
  assert.equal(t.ok, true);
  // A data-like key in a hand-edited selector is a leak, by the identifier rule, the map rule and detect().
  for (const sel of [":root > [key='accounts'] > [key='RA-10421'] > [key='status']", ":root > [key='byMonth'] > [key='february'] > [key='amount']", ":root > [key='jane@example.org']"]) {
    const d = draft();
    d.profile.fields = { lastName: sel };
    assert.equal(judgeDocument(d, sample, { url: URL_, lib }).leaks.length, 1, sel);
  }
  // A value from anywhere in the sample, not only what the profile reads: here in the profile's name.
  const named = draft();
  editDraft(named, (p) => { p.name = 'Maria'; p.fields = { lastName: ":root > [key='person'] > [key='lastName']" }; });
  assert.equal(judgeDocument(named, sample, { url: URL_, lib }).leaks.length, 1);
  const values = responseValues(sample, ok.profile, lib);
  for (const v of ['Maria', 'QQ 12 34 56 C', 'RA-10421', 'jane@example.org', '412.5']) assert.ok(values.includes(v), v);
  for (const v of ['dateOfBirth', 'address2', 'person', 'true']) assert.ok(!values.includes(v), v);
  assert.deepEqual(responseValues(sample, { format: 'html' }, lib), [], 'HTML is checked as before');
});

test('the test on a sample: a field on an object, a null value, two matches, and a validator', () => {
  const d = draft();
  const doc = parse('{"person":{"dateOfBirth":"not a date","x":1,"x":2},"notes":null,"lastName":"Kowalska"}');
  d.profile.fields = { dob: ":root > [key='person'] > [key='dateOfBirth'] | date", lastName: ":root > [key='person']", address2: ":root > [key='notes']", nino: ":root > [key='person'] > [key='x']" };
  const t = judgeTest(d, probeFields(doc, d.profile, URL_), { url: URL_, lib });
  assert.equal(t.fields.lastName.error, 'Pick a value inside it');
  assert.equal(t.fields.address2.error, 'Reads nothing');
  assert.equal(t.fields.nino.error, 'Matches 2 elements, not one');
  assert.equal(t.fields.dob.ok, false);
  assert.equal(t.ok, false);
});

test('a page that reads data: bound to a pasted address, checked, compiled, exported and imported with its format', () => {
  const flow = newFlow({ name: 'Client data' });
  const step = addPage(flow, 'fetch');
  const { page } = addRequest(flow, step.id, { name: 'Client data' });
  bindJsonPage(flow, page.id, { url: `${URL_}#x` });
  assert.ok(readsJson(page));
  assert.equal(page.url, 'https://cm.example.gov.uk/api/clients/{ref}');
  assert.deepEqual(page.draft.profile.match, ['https://cm.example.gov.uk/api/clients/*']);
  assert.throws(() => bindJsonPage(flow, page.id, { url: 'not an address' }), /full address/);
  const key = addField(flow, { label: 'Date of birth', type: 'date' });
  mapPick(page, key, ":root > [key='person'] > [key='dateOfBirth']", { filter: 'date' });
  assert.ok(validateFlow(flow).some((i) => i.code === 'untested' && /hasn’t been tested on a sample/.test(i.text)));
  const files = compileFlow(flow).files;
  const profile = Object.entries(files).find(([p]) => p.startsWith('profiles/pages/'))[1];
  assert.equal(profile.format, 'json');
  assert.deepEqual(E.validateProfile(profile), []);
  const back = importFlow(JSON.parse(JSON.stringify(exportFlow(flow))));
  assert.equal(back.pages.find((p) => p.parent).draft.profile.format, 'json');
});

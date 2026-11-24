// The profile assistant: rules that match page values to target fields, the model's prompt and answer
// handling, and the in-page side (candidates, drag, selection, the override tool).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { agentOn, agentOnDom } from './helpers/agent.js';
import { demoLibrary } from './helpers/library.js';
import { evalAll } from '../tools/assist-eval.mjs';
import { buildItemPrompt, categorise, joinValues, matchFields, mergeModel, readItemAnswer, scorePair, targetFields } from '../../extension/lib/assist.js';
import { refineWithModel } from '../../extension/lib/assist-client.js';
import { detect, patternsFor } from '../../extension/lib/privacy-detect.js';
import { assistSource, DEFAULT_ASSIST_MODEL } from '../../extension/lib/model-fetch.js';

const lib = demoLibrary();

test('the rules match the demo library’s own profiles on every demo page and form', async () => {
  for (const r of await evalAll()) {
    assert.equal(r.wrong, 0, `${r.page}: ${JSON.stringify(r.rows.filter((x) => !x.ok && !x.missing))}`);
    assert.equal(r.correct, r.total, `${r.page}: missing ${r.rows.filter((x) => x.missing).map((x) => x.key).join(', ')}`);
    assert.deepEqual(r.extra, [], `${r.page}: matched fields the library doesn’t read`);
  }
});

// A page worded differently from the demo, with the traps a real system has: a household table with dates of
// birth, a payments table, a name with no label, and an "Opened" date.
const OTHER = `<!doctype html><body><main>
  <h1 id="who">Jan Nowak</h1>
  <section id="person"><h2>About the customer</h2>
    <p><b>Forename:</b> Jan</p><p><b>Family name:</b> Nowak</p>
    <p><b>D.O.B.:</b> 3 March 1979</p><p><b>National insurance:</b> AB 12 34 56 D</p>
    <p><b>Mobile:</b> 07700 900777</p><p><b>E-mail:</b> jan@example.org</p>
    <p><b>Opened:</b> 01/02/2025</p></section>
  <table id="family"><thead><tr><th>Name</th><th>Date of birth</th></tr></thead>
    <tbody><tr><td>Ewa Nowak</td><td>01/01/1980</td></tr><tr><td>Ola Nowak</td><td>02/02/2012</td></tr></tbody></table>
  <table id="pay"><thead><tr><th>Date</th><th>Amount</th></tr></thead>
    <tbody><tr><td>01/03/2026</td><td>£10.00</td></tr><tr><td>01/04/2026</td><td>£12.00</td></tr></tbody></table>
</main></body>`;

async function candidatesOf(html) {
  const a = agentOnDom(new JSDOM(html, { url: 'https://cm.example.org/people/9', runScripts: 'outside-only' }));
  const { candidates } = await a.ask({ type: 'powerloader:pickStart', selected: [] });
  const { text, at } = joinValues(candidates);
  return { a, cands: categorise(candidates, detect(text, { patterns: patternsFor(lib) }), at) };
}

test('other wording: aliases, bold labels, and no matches from repeating rows or a bare date', async () => {
  const { cands } = await candidatesOf(OTHER);
  const { matches } = matchFields(cands, targetFields(lib, ['hsr', 'dhp']));
  const got = Object.fromEntries(matches.map((m) => [m.key, cands.find((c) => c.id === m.id).value]));
  assert.equal(got.firstName, 'Jan');
  assert.equal(got.lastName, 'Nowak');
  assert.equal(got.dob, '3 March 1979');
  assert.equal(got.nino, 'AB 12 34 56 D');
  assert.equal(got.phone, '07700 900777');
  assert.equal(got.email, 'jan@example.org');
  assert.equal(got.tenancyStart, undefined, 'an "Opened" date is not a tenancy start');
  for (const m of matches) assert.ok(!cands.find((c) => c.id === m.id).repeat, `${m.key} came from a repeating row`);
});

test('a full name with no first and last name fields nearby gives both, marked for checking', async () => {
  const { cands } = await candidatesOf('<!doctype html><body><dl><dt>Tenant</dt><dd>Maria Kowalska</dd><dt>Postcode</dt><dd>NS1 4AB</dd></dl></body>');
  const { matches } = matchFields(cands, targetFields(lib, ['dhp']));
  const first = matches.find((m) => m.key === 'firstName');
  assert.deepEqual([first.part, first.by, first.check], ['first', 'derived', true]);
  assert.equal(matches.find((m) => m.key === 'lastName').part, 'last');
});

test('a value that fails a field’s validator scores low however it is labelled', () => {
  const f = { key: 'nino', ...lib.fields.nino };
  assert.ok(scorePair({ label: 'NI number', value: 'not known' }, f).score < 0.6);
  assert.ok(scorePair({ label: 'NI number', value: 'QQ 12 34 56 C', category: 'nino' }, f).score > 1);
});

test('the model is asked about one value at a time, and its answer is read back as a field or nothing', () => {
  const fields = targetFields(lib, ['dhp']);
  const [msg] = buildItemPrompt({ id: 'c3', label: 'Surname', value: 'Nowak', section: 'About' }, fields, { suffix: ' /no_think' });
  assert.match(msg.content, /A web page shows: "Surname": "Nowak" under "About"/);
  assert.match(msg.content, /Last name; .*none\./);
  assert.match(msg.content, / \/no_think$/);
  assert.equal(readItemAnswer('Last name', fields), 'lastName');
  assert.equal(readItemAnswer('Weekly income', fields), 'weeklyIncome');
  assert.equal(readItemAnswer('<think></think>\n"Landlord".', fields), 'landlord');
  assert.equal(readItemAnswer('none', fields), null);
  assert.equal(readItemAnswer('Here is a breakdown of the fields', fields), null);
  assert.equal(readItemAnswer('Amount owed', fields), null, 'an echo of the label is not a field');
});

test('the model can fill a gap or confirm a match, but never overrides a confident rule or the validator', () => {
  const fields = [{ key: 'lastName', ...lib.fields.lastName }, { key: 'nino', ...lib.fields.nino }, { key: 'landlord', ...lib.fields.landlord }];
  const cands = [
    { id: 'c1', selector: 'label(Surname)', label: 'Surname', value: 'Nowak' },
    { id: 'c2', selector: '#x', label: 'Ref', value: 'hello' },
    { id: 'c3', selector: '#owner', label: 'Owner', value: 'Harbour Homes Ltd' },
  ];
  const rule = matchFields(cands, fields);
  assert.deepEqual(rule.matches.map((m) => m.key), ['lastName']);
  const out = mergeModel(rule, { c1: 'lastName', c2: 'nino', c3: 'landlord' }, cands, fields);
  assert.equal(out.agreed, 1);
  assert.equal(out.matches.find((m) => m.key === 'lastName').by, 'model');
  assert.equal(out.matches.find((m) => m.key === 'nino'), undefined, '"hello" is not an NI number');
  const ll = out.matches.find((m) => m.key === 'landlord');
  assert.deepEqual([ll.selector, ll.by, ll.check], ['#owner', 'model', true]);
  // A confident rule match stays when the model disagrees.
  const keep = mergeModel(rule, { c3: 'lastName' }, cands, fields);
  assert.equal(keep.matches.find((m) => m.key === 'lastName').selector, 'label(Surname)');
});

test('refining asks about each labelled value and merges the answers', async () => {
  const fields = targetFields(lib, ['dhp']);
  const cands = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, selector: `#v${i}`, label: i === 3 ? 'Owner' : `Thing ${i}`, value: i === 3 ? 'Harbour Homes Ltd' : `v${i}` }));
  const calls = [];
  const out = await refineWithModel(matchFields(cands, fields), cands, fields, async (messages) => { calls.push(messages); return /"Owner"/.test(messages[0].content) ? 'Landlord' : 'none'; });
  assert.equal(calls.length, 5);
  const ll = out.matches.find((m) => m.key === 'landlord');
  assert.deepEqual([ll.selector, ll.by, ll.check], ['#v3', 'model', true]);
});

test('the assistant model is pinned and hash-checked, and policy or the caseworker can switch it off', () => {
  const s = assistSource({ values: {} }, {});
  assert.equal(s.modelId, 'onnx-community/gemma-3-1b-it-ONNX');
  assert.equal(s.prefill, true);
  assert.equal(s.revision, DEFAULT_ASSIST_MODEL.revision);
  assert.ok(Object.values(s.hashes).every((h) => /^[0-9a-f]{64}$/.test(h)));
  assert.ok(s.hashes['onnx/model_q4f16.onnx_data']);
  assert.equal(s.enabled, true);
  assert.equal(assistSource({ values: {} }, { assist: { model: false } }).enabled, false);
  const off = assistSource({ values: { assistModel: { enabled: false } } }, {});
  assert.deepEqual([off.enabled, off.locked], [false, true]);
  assert.equal(assistSource({ values: { privacyModel: { baseUrl: 'https://mirror.example/hf/' } } }, {}).baseUrl, 'https://mirror.example/hf/');
});

// ------------------------------------------------------------------ in the page

test('candidates carry their label, section and path, and repeating rows are marked', async () => {
  const a = agentOn('client-1042.html');
  const { candidates } = await a.ask({ type: 'powerloader:pickStart', selected: [] });
  const by = Object.fromEntries(candidates.map((c) => [c.value, c]));
  assert.deepEqual([by.Maria.label, by.Maria.section, by.Maria.repeat], ['First name', 'Personal details', false]);
  assert.equal(by['07700 900123'].label, 'Telephone');
  assert.equal(by['NC-1042'].label, 'Client ID');
  assert.deepEqual([by['02/11/1984'].label, by['02/11/1984'].repeat], ['Date of birth', true]);
  assert.match(by.Maria.path, /tr\[2\]\/td$/);
  assert.ok(candidates.every((c, i) => c.id === `c${i}`));
});

test('values are draggable, matched ones carry their field’s name, and the selection is marked', async () => {
  const a = agentOn('client-1042.html');
  await a.ask({ type: 'powerloader:pickStart', selected: ['label(First name)'], fields: { 'label(First name)': 'First name' } });
  const maria = [...a.doc.querySelectorAll('[data-powerloader-pick]')].find((el) => el.textContent === 'Maria');
  assert.equal(maria.getAttribute('draggable'), 'true');
  assert.equal(maria.getAttribute('data-powerloader-field'), 'First name');
  assert.equal(maria.getAttribute('data-powerloader-pick'), 'on');
  // Form boxes aren't made draggable: dragging in a box selects its text.
  assert.equal(a.doc.getElementById('c-phone').getAttribute('draggable'), null);
  await a.ask({ type: 'powerloader:pickSelected', selected: [], fields: {}, current: 'label(First name)' });
  assert.equal(maria.getAttribute('data-powerloader-pick'), 'sel');
  assert.equal(maria.getAttribute('data-powerloader-field'), null);
  // An untrusted drag (from a page script) sends nothing.
  maria.dispatchEvent(new a.w.Event('dragstart', { bubbles: true }));
  assert.equal(a.sent.length, 0);
  await a.ask({ type: 'powerloader:pickStop' });
  assert.equal(maria.getAttribute('draggable'), null);
  assert.equal(a.doc.querySelectorAll('[data-powerloader-field]').length, 0);
});

test('the override tool shows its outline and hint, and stopping it resolves with nothing', async () => {
  const a = agentOn('client-1042.html');
  await a.ask({ type: 'powerloader:pickStart', selected: [] });
  const pending = a.ask({ type: 'powerloader:overrideStart' });
  assert.equal(a.doc.querySelectorAll('[data-powerloader-ui="override"]').length, 2);
  // Synthetic clicks don't choose anything.
  a.doc.querySelector('h1').dispatchEvent(new a.w.MouseEvent('click', { bubbles: true }));
  await a.ask({ type: 'powerloader:overrideStop' });
  assert.equal(await pending, null);
  assert.equal(a.doc.querySelectorAll('[data-powerloader-ui]').length, 0);
  assert.equal(await a.ask({ type: 'powerloader:pickStop' }), true);
});

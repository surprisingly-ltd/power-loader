import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { JSDOM, ResourceLoader } from 'jsdom';
import '../../extension/lib/extract.js';
import { parseReply, runTask, buildRequest } from '../../extension/lib/ai/tasks.js';
import { parseSnapshot, cleanHtml } from '../../extension/lib/ai/snapshot.js';
import { registerPresenter } from '../../extension/lib/ai/boundary.js';
import { requestSize, IMAGE_COST } from '../../extension/lib/ai/client.js';
import { effectiveSettings, knownValues, patternsFor } from '../../extension/lib/privacy-detect.js';
import { demoLibrary, extractDemo } from './helpers/library.js';
import { addClip, clipFromExtract, newCase } from '../../extension/lib/case.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const json = (p) => JSON.parse(read(p));
const document = new JSDOM('').window.document;
const url = 'http://localhost:8787/demo/referral.html';
globalThis.browser = { runtime: { getURL: (p) => p } };
globalThis.fetch = async (p) => new Response(read(`extension/${p}`));
const lib = demoLibrary();
const c = newCase(lib, ['hsr', 'dhp']);
{ const { profile, res } = extractDemo(lib, 'client-1042.html', 'cm/client-record'); addClip(c, lib, clipFromExtract(lib, profile, res)); }
const context = { known: knownValues(c, lib), patterns: patternsFor(lib), settings: effectiveSettings(), identifierTypes: lib.identifierTypes, model: { ready: true, required: true } };
let shown;
registerPresenter(async (state, { review }) => { shown = review(state); return true; });
const scripted = (...replies) => {
  const calls = [];
  const fn = async (payload) => { calls.push(payload); const r = replies[calls.length - 1]; if (r instanceof Error) throw r; return r; };
  fn.calls = calls;
  return fn;
};

test('historical reference fixtures remain frozen', () => {
  for (const [p, hash] of Object.entries(json('fixtures/reference-hashes.json'))) assert.equal(createHash('sha256').update(read(`fixtures/${p}`)).digest('hex'), hash, p);
});

test('replies are parsed tolerantly but reserved keys are refused', () => {
  assert.deepEqual(parseReply('Here it is:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.throws(() => parseReply('no json'), /no JSON/);
  assert.throws(() => parseReply('{"__proto__":{"x":1}}'), /Reserved/);
});

test('Extract with AI: the text is redacted, the answer restored strictly and validated locally', async () => {
  const text = 'Harbour Homes phoned. Arrears are £1,245.60. They gave a new mobile number for Maria Kowalska: 07700 900456. Landlord is Harbour Homes Ltd.';
  const complete = scripted(null);
  // A fake model that copies the placeholders it was sent, as the instructions ask.
  const answer = (payload) => {
    const sentText = payload.messages[1].content;
    const tok = (cat) => (new RegExp(`<redacted:${cat}\\|ref:[a-z0-9]+\\.\\d+`).exec(sentText)[0] + '>');
    return JSON.stringify({ values: {
      phone: { value: tok('phone'), quote: `a new mobile number for ${tok('person_name')}: ${tok('phone')}` },
      firstName: { value: tok('phone') },
      arrears: { value: '£1,245.60', quote: 'Arrears are £1,245.60' },
      landlord: { value: 'Harbour Homes Ltd', quote: 'Landlord is Harbour Homes Ltd' },
      notAField: { value: 'x' },
    } });
  };
  const fn = async (payload) => { complete.calls.push(payload); return answer(payload); };
  const out = await runTask('extract', { text, title: 'Case notes', url: 'http://localhost:8787/demo/case-notes-1042.html', keys: ['phone', 'firstName', 'arrears', 'landlord'] }, { lib, context: () => context, config: {}, completeFn: fn });
  const sent = JSON.stringify(complete.calls[0].messages);
  assert.ok(!/Maria|Kowalska|07700/.test(sent));
  assert.ok(!sent.includes('1042'), 'the page address is sent as a shape only');
  assert.equal(shown.counts.redacted, 2);
  const by = Object.fromEntries(out.rows.map((r) => [r.key, r]));
  assert.equal(by.phone.value, '07700 900456');
  assert.equal(by.phone.quote, 'a new mobile number for Maria Kowalska: 07700 900456');
  assert.equal(by.firstName.ok, false, 'a phone placeholder can’t fill a name');
  assert.equal(by.firstName.value, '');
  assert.equal(by.arrears.value, '1245.60');
  assert.equal(by.notAField, undefined);
});

test('Map this form with AI sends labels and options, never typed values, and keeps only given boxes', async () => {
  const form = { ...json('fixtures/referral-form.json'), url };
  form.controls[0].current = 'typed by the caseworker';
  const fn = scripted(JSON.stringify({ fields: { '#firstName': 'firstName', '#lastName': 'lastName', '#invented': 'dob', '#email': 'notAField' } }));
  const out = await runTask('form', { form, title: 'Referral', url }, { lib, context: () => context, config: {}, completeFn: fn });
  assert.ok(!JSON.stringify(fn.calls[0].messages).includes('typed by the caseworker'));
  assert.deepEqual(out.fields, { '#firstName': 'firstName', '#lastName': 'lastName' });
  assert.deepEqual(out.dropped.sort(), ['#email', '#invented']);
});

test('Map a form for a fill draft: only the target form’s fields are sent, and only those come back', async () => {
  const form = { ...json('fixtures/referral-form.json'), url };
  const fn = scripted(JSON.stringify({ fields: { '#firstName': 'firstName', '#lastName': 'landlord' } }));
  const out = await runTask('form', { form, title: 'Referral', url, keys: ['firstName', 'lastName'], targets: ['Housing support referral'] }, { lib, context: () => context, config: {}, completeFn: fn });
  const sent = fn.calls[0].messages[1].content;
  assert.match(sent, /^Target forms: Housing support referral/);
  assert.match(sent, /"key":"lastName"/);
  assert.doesNotMatch(sent, /"key":"landlord"/);
  assert.deepEqual(out.fields, { '#firstName': 'firstName' });
  assert.deepEqual(out.dropped, ['#lastName']);
});

test('Suggest a profile: selectors holding a placeholder are dropped, and the rest is tried on the full page', async () => {
  const html = read('demo/client-1042.html');
  const fn = async (payload) => JSON.stringify({ name: 'Client', fields: {
    firstName: 'table.details label(First name)', lastName: `td:contains("<redacted:last_name|ref:${payload.ns}.2>")`, nino: 'table.details label(NI number)', bogus: 'h1',
  } });
  const out = await runTask('profile', { html, url: 'http://localhost:8787/demo/client-1042.html', title: 'Client', document }, { lib, context: () => context, config: {}, completeFn: fn });
  assert.deepEqual(Object.keys(out.fields), ['firstName', 'nino']);
  assert.deepEqual(out.dropped.sort(), ['bogus', 'lastName']);
  assert.equal(out.sample.firstName, 'Maria');
});

const tokenIn = (payload, cat) => `${new RegExp(`<redacted:${cat}\\|ref:[a-z0-9]+\\.\\d+`).exec(JSON.stringify(payload.messages).replace(/\\"/g, '"'))[0]}>`;
const notes = [
  { clipId: 'c1', date: '2026-09-12', text: 'Maria Kowalska called. She was off sick from Royal Mail from mid-January to the end of March 2025.' },
  { clipId: 'c1', date: '2026-10-02', text: 'Harbour Homes gave a new mobile number for Maria Kowalska: 07700 900456.' },
];

test('✦ Ask about amounts: notes are redacted, the answer is restored, and only listed amounts come back', async () => {
  const amounts = [{ id: 'r:p1', label: 'Tenant payment', date: '2026-01-06', amount: 725, source: 'Rent account' }, { id: 'r:p2', label: 'UC housing element', date: '2026-04-02', amount: 480.2, source: 'Rent account' }];
  const calls = [];
  const fn = async (payload) => { calls.push(payload); return JSON.stringify({ answer: `${tokenIn(payload, 'person_name')} paid £725.00 and UC paid £480.20.`, items: [1, 2, 7, 'x'] }); };
  const out = await runTask('calc', { question: 'Which payments make up the arrears?', amounts, notes }, { lib, context: () => context, config: {}, completeFn: fn });
  assert.ok(!/Kowalska|07700/.test(JSON.stringify(calls[0].messages)), 'names and numbers in the notes are redacted');
  assert.equal(out.answer, 'Maria Kowalska paid £725.00 and UC paid £480.20.');
  assert.deepEqual(out.items, ['r:p1', 'r:p2'], 'unknown amount numbers are dropped');
});

test('✦ Find periods: dates are checked, words restored strictly, and bad periods dropped', async () => {
  const fn = async (payload) => JSON.stringify({ periods: [
    { label: 'Off sick on SSP', category: 'Sickness', start: '2025-01-15', end: '2025-03-31', approx: true, note: 1, quote: `${tokenIn(payload, 'person_name')} called. She was off sick`, why: 'Mid-January read as 15 January.' },
    { label: 'Backwards', category: 'Employment', start: '2025-05-01', end: '2025-04-01', note: 1, quote: 'x' },
    { label: 'No such note', category: 'Benefit', start: '2025-01-01', end: null, note: 9, quote: 'x' },
    { label: '<redacted:person_name|ref:zzzzzz.1>', category: 'Other', start: '2024-01-01', end: null, note: 2, quote: 'x' },
    { label: 'Weird category', category: 'Holiday', start: '2024-06-01', end: '2024-06-14', note: 2, quote: 'Harbour Homes gave' },
  ] });
  const out = await runTask('tlFind', { notes }, { lib, context: () => context, config: {}, completeFn: fn });
  assert.deepEqual(out.periods.map((p) => p.label), ['Off sick on SSP', 'Weird category']);
  assert.equal(out.periods[0].quote, 'Maria Kowalska called. She was off sick');
  assert.equal(out.periods[0].approx, true);
  assert.equal(out.periods[0].clipId, 'c1');
  assert.equal(out.periods[1].cat, 'Other');
});

test('✦ Explain the timeline: an explanation with a foreign placeholder is withheld', async () => {
  const good = await runTask('tlExplain', { summary: 'Gap 1: 1 Jan 2022 to 28 Feb 2022, 59 days', notes }, { lib, context: () => context, config: {}, completeFn: async (payload) => JSON.stringify({ explanation: `${tokenIn(payload, 'person_name')} lived on savings.` }) });
  assert.equal(good.explanation, 'Maria Kowalska lived on savings.');
  const bad = await runTask('tlExplain', { summary: 'Gap 1', notes }, { lib, context: () => context, config: {}, completeFn: async () => JSON.stringify({ explanation: 'It was <redacted:person_name|ref:abcdef.1>.' }) });
  assert.equal(bad.explanation, '');
  assert.ok(bad.problems.length);
});

test('transport retries resend the same approved payload; cancelling the preview sends nothing', async () => {
  const busy = Object.assign(new Error('Rate limited'), { retryable: true });
  const fn = scripted(busy, '{"values":{}}');
  await runTask('extract', { text: 'Nothing personal here.', title: 't', url, keys: ['landlord'] }, { lib, context: () => context, config: {}, completeFn: fn });
  assert.equal(fn.calls.length, 2);
  assert.equal(fn.calls[0], fn.calls[1]);
  registerPresenter(async () => false);
  const none = scripted('{}');
  assert.equal(await runTask('extract', { text: 'x', title: 't', url, keys: ['landlord'] }, { lib, context: () => context, config: {}, completeFn: none }), null);
  assert.equal(none.calls.length, 0);
  registerPresenter(async (state, { review }) => { shown = review(state); return true; });
});

test('the request budget counts text parts and a fixed cost per image', () => {
  assert.equal(requestSize([{ role: 'user', content: 'abc' }, { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image_url', image_url: { url: 'data:...' } }] }]), 3 + 5 + IMAGE_COST);
  assert.throws(() => buildRequest('nope', {}, { lib, system: '' }), /Unknown AI action/);
});

test('capture round-trips live controls and evaluation/cleaning is inert', () => {
  let requests = 0;
  class BlockedResources extends ResourceLoader { fetch() { requests++; return null; } }
  const dom = new JSDOM('<input id="i" value="old"><textarea>x</textarea><select><option>A</option><option>B</option></select><input type="checkbox"><input type="password" value="secret"><input type="hidden" value="token">', { url, runScripts: 'outside-only', resources: new BlockedResources() });
  const d = dom.window.document;
  d.querySelector('#i').value = 'live'; d.querySelector('textarea').value = 'live text'; d.querySelector('select').selectedIndex = 1; d.querySelector('[type=checkbox]').checked = true;
  dom.window.eval(read('extension/lib/capture.js'));
  const captured = dom.window.PowerLoaderCapture();
  const doc = parseSnapshot(captured.html + '<script>globalThis.executed=true</script><img src="https://evil.example/x"><iframe src="https://evil.example/y"></iframe>', d);
  assert.equal(doc.querySelector('#i').value, 'live');
  assert.equal(doc.querySelector('textarea').value, 'live text');
  assert.equal(doc.querySelector('select').value, 'B');
  assert.equal(doc.querySelector('[type=checkbox]').checked, true);
  assert.equal(doc.querySelector('script'), null);
  assert.equal(dom.window.executed, undefined);
  const cleaned = cleanHtml(doc, 120000);
  assert.equal(cleaned.html.includes('secret'), false); assert.equal(cleaned.html.includes('token'), false);
  assert.equal(cleaned.html.includes('evil.example'), false, 'sources keep only their path shape');
  assert.equal(requests, 0);
  assert.equal(cleanHtml(doc, 10).truncated, true);
});

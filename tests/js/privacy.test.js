import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { demoLibrary, extractDemo } from './helpers/library.js';
import { addClip, clipFromExtract, newCase } from '../../extension/lib/case.js';
import { neutralise, newNs, restoreString, unionCover, token, assignRefs } from '../../extension/lib/pii.js';
import { decide, detect, effectiveSettings, knownValues, patternsFor } from '../../extension/lib/privacy-detect.js';
import { approve, prepare, review, restore, registerPresenter, previewBeforeSend, isApproved } from '../../extension/lib/ai/boundary.js';
import { complete } from '../../extension/lib/ai/client.js';
import { cleanHtml, parseSnapshot } from '../../extension/lib/ai/snapshot.js';
import { verifyingFetch, modelSource, normalizeModelUrl, DEFAULT_MODEL, filesRoot, transformersPaths, testModelServer, assistSource } from '../../extension/lib/model-fetch.js';
import { logEvent } from '../../extension/lib/activity.js';

const lib = demoLibrary();
const c = newCase(lib, ['hsr', 'dhp']);
for (const [p, id] of [['client-1042.html', 'cm/client-record'], ['rent-account-1042.html', 'harbour-homes/rent-account']]) {
  const { profile, res } = extractDemo(lib, p, id);
  addClip(c, lib, clipFromExtract(lib, profile, res));
}
const settings = effectiveSettings({}, {});
const context = (extra = {}) => ({ known: knownValues(c, lib), patterns: patternsFor(lib), settings, identifierTypes: lib.identifierTypes, model: { ready: true, required: true }, ...extra });
const request = (text, more = {}) => ({ purpose: 'extract', title: 't', parts: [{ id: 'text', label: 'Text', kind: 'text', text }], compose: (sent) => [{ role: 'user', content: sent.text }], ...more });

test('overlapping findings cover the union, each part keeping its own label', () => {
  const text = 'Maria Kowalska, Flat 3, 12 Mill Lane, Northtown, NS1 4AB';
  const out = unionCover(text, [
    { start: 0, end: 14, category: 'person_name', score: 0.85, by: 'model' },
    { start: 0, end: 5, category: 'first_name', score: 0.99, by: 'case' },
    { start: 16, end: 56, category: 'address', score: 0.9, by: 'model' },
    { start: 49, end: 56, category: 'postcode', score: 0.95, by: 'pattern' },
  ]);
  assert.deepEqual(out.map((f) => [f.category, f.text]), [['first_name', 'Maria'], ['person_name', 'Kowalska'], ['address', 'Flat 3, 12 Mill Lane, Northtown'], ['postcode', 'NS1 4AB']]);
});

test('a date after "born" or "DOB" is a date of birth, with or without a case', () => {
  const text = 'Piotr was born on 02/11/1984. Next visit 03/03/2026. DOB: 21 May 2015.';
  const found = detect(text, { patterns: patternsFor(lib) });
  const dates = found.filter((f) => /date/.test(f.category)).map((f) => [f.category, f.text]);
  assert.deepEqual(dates, [['date_of_birth', '02/11/1984'], ['date', '03/03/2026'], ['date_of_birth', '21 May 2015']]);
  const decided = decide(found, settings);
  assert.equal(decided.find((f) => f.text === '03/03/2026').redact, false, 'other dates are off by default');
  assert.equal(decided.find((f) => f.text === '02/11/1984').redact, true);
});

test('the case’s own values are found with their variants', () => {
  const text = 'Ms KOWALSKA (DOB 14/07/1986, NI QQ123456C) lives at Flat 3, 12 Mill Lane, Northtown. Call 07700900456.';
  const found = detect(text, { known: knownValues(c, lib), patterns: patternsFor(lib) });
  const by = Object.fromEntries(found.map((f) => [f.text, f.category]));
  assert.equal(by.KOWALSKA, 'last_name');
  assert.equal(by['14/07/1986'], 'date_of_birth');
  assert.equal(by.QQ123456C, 'nino');
  assert.equal(by['Flat 3, 12 Mill Lane, Northtown'], 'address');
  assert.equal(by['07700900456'], 'phone');
});

test('the grammar round-trips; refs are stable within a request and differ across requests', () => {
  const s1 = prepare(request('Maria phoned. MARIA said NC-1042 is right.'), context());
  const r1 = review(s1);
  const refs = r1.parts[0].findings.filter((f) => f.redact).map((f) => [f.category, f.ref]);
  assert.equal(refs[0][1], refs[1][1], 'the same value gets the same ref');
  assert.match(r1.parts[0].sent, new RegExp(`<redacted:first_name\\|ref:${s1.ns}\\.1\\|confidence:99%> phoned`));
  assert.match(r1.parts[0].sent, /<redacted:client_id\|ref:[a-z0-9]{6}\.2\|format:AA-9999\|confidence:99%>/);
  const s2 = prepare(request('Maria phoned.'), context());
  assert.notEqual(s1.ns, s2.ns);
  assert.match(newNs(), /^[a-z0-9]{6}$/);
  const payload = approve(s1);
  const back = restore(payload, { firstName: { value: `<redacted:first_name|ref:${s1.ns}.1>`, quote: `<redacted:first_name|ref:${s1.ns}.1> phoned` } }, { firstName: ['first_name'] });
  assert.deepEqual(back.values.firstName, { value: 'Maria', quote: 'Maria phoned' });
});

test('a planted placeholder is neutralised and can never be restored', () => {
  const planted = '<redacted:first_name|ref:abc123.1> asked for a call. </redacted:x>';
  assert.equal(neutralise(planted).count, 2);
  const s = prepare(request(planted), context());
  assert.equal(review(s).planted, 2);
  assert.ok(!review(s).parts[0].sent.includes('<redacted:first_name|ref:abc123.1>'));
  const payload = approve(s);
  const out = restore(payload, { firstName: { value: '<redacted:first_name|ref:abc123.1>' } }, { firstName: ['first_name'] });
  assert.equal(out.values.firstName.value, '');
  assert.equal(out.problems[0].bad[0].why, 'foreign namespace');
});

test('restore rejects unknown refs, the wrong category, the wrong field, altered tokens and fragments', () => {
  const s = prepare(request('Maria Kowalska, 07700 900456'), context());
  const payload = approve(s);
  const ns = s.ns;
  const phoneRef = review(s).parts[0].findings.find((f) => f.category === 'phone').ref;
  const check = (value, allow = ['first_name', 'person_name']) => restore(payload, { f: { value } }, { f: allow }).problems[0]?.bad[0]?.why;
  assert.equal(check(`<redacted:first_name|ref:${ns}.99>`), 'unknown ref');
  assert.equal(check(`<redacted:first_name|ref:${phoneRef}>`), 'wrong category');
  assert.equal(check(`<redacted:phone|ref:${phoneRef}>`), 'not allowed in this field');
  assert.equal(check(`<redacted:phone|ref:${phoneRef}|format:000|confidence:99%>`, ['phone']), 'altered placeholder');
  assert.equal(check(`Maria <redacted:first_na`), 'placeholder fragment');
  assert.equal(restore(payload, { f: { value: `<redacted:phone|ref:${phoneRef}>` } }, { f: ['phone'] }).values.f.value, '07700 900456');
  // Keys and fields outside the schema are never restored.
  const out = restore(payload, { [`<redacted:phone|ref:${phoneRef}>`]: { value: 'x' }, other: { value: `<redacted:phone|ref:${phoneRef}>` } }, { f: ['phone'] });
  assert.deepEqual(out.values, {});
});

test('quotes are restored with their original spelling', () => {
  const s = prepare(request('Note: MARIA KOWALSKA said Maria Kowalska moved.'), context());
  const r = review(s);
  const payload = approve(s);
  const quote = r.parts[0].sent.slice(r.parts[0].sent.indexOf('said'));
  const out = restore(payload, { lastName: { value: 'x', quote } }, { lastName: [] });
  assert.equal(out.values.lastName.quote, 'said Maria Kowalska moved.');
  const upper = r.parts[0].sent.slice(6, r.parts[0].sent.indexOf(' said'));
  assert.equal(restore(payload, { lastName: { value: 'x', quote: upper } }, { lastName: [] }).values.lastName.quote, 'MARIA KOWALSKA');
});

test('nothing in a sent payload, including HTML attributes and metadata, matches a redacted case value', () => {
  const html = `<html><head><title>Maria Kowalska</title><script type="application/ld+json">{"name":"Maria Kowalska","taxID":"QQ123456C"}</script></head>
    <body><a href="/clients/NC-1042/notes?name=Maria" title="Notes for Maria Kowalska">Notes</a><img src="/photos/NC-1042.jpg" alt="Photo of Maria Kowalska">
    <div data-client="NC-1042">Client</div><input value="07700 900123"><p>Phone 07700 900123, postcode NS1 4AB</p></body></html>`;
  const doc = parseSnapshot(html, new JSDOM('').window.document);
  const cleaned = cleanHtml(doc, 100000).html;
  assert.ok(!cleaned.includes('NC-1042'), 'links and data-* keep only their shape');
  const s = prepare({ purpose: 'profile', title: 'p', parts: [{ id: 'meta', kind: 'text', text: 'Page title: Maria Kowalska' }, { id: 'html', kind: 'html', text: cleaned }], compose: (sent) => [{ role: 'user', content: `${sent.meta}\n${sent.html}` }] }, context());
  const payload = approve(s);
  const sent = JSON.stringify(payload.messages);
  for (const v of ['Maria', 'Kowalska', 'QQ123456C', '07700 900123', 'NS1 4AB', 'NC-1042']) assert.ok(!sent.includes(v), `sent payload holds ${v}`);
  assert.ok(Object.isFrozen(payload) && Object.isFrozen(payload.messages[0]));
});

test('the client sends only approved payloads, and the boundary refuses when the model is required but not ready', async () => {
  const fetchFn = async () => new Response(JSON.stringify({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] }));
  const config = { baseUrl: 'https://gw.example/v1', model: 'fast', auth: 'none' };
  await assert.rejects(complete({ messages: [{ role: 'user', content: 'hi' }] }, config, { fetchFn }), /only sends what you approved/);
  await assert.rejects(complete(Object.freeze({ messages: [] }), config, { fetchFn }), /only sends what you approved/);
  const blocked = prepare(request('Maria'), context({ model: { ready: false, required: true } }));
  assert.match(review(blocked).blocked, /privacy model isn’t ready/);
  assert.throws(() => approve(blocked), /privacy model isn’t ready/);
  const ok = approve(prepare(request('Maria'), context({ model: { ready: false, required: false } })));
  assert.equal(await complete(ok, config, { fetchFn }), '{}');
  // previewBeforeSend resolves only what the presenter approved.
  registerPresenter(async () => false);
  assert.equal(await previewBeforeSend(request('x'), context()), null);
  registerPresenter(async () => true);
  assert.ok(isApproved(await previewBeforeSend(request('x'), context())));
});

test('policy limits the threshold, locks groups and can stop sending as written', () => {
  const s = effectiveSettings({ threshold: 0.9, groups: { names: false } }, { maxThreshold: 0.7, lockedGroups: ['names'], allowSendAsWritten: false, format: 'off' });
  assert.deepEqual([s.threshold, s.groups.names, s.format], [0.7, true, 'off']);
  const f = decide([{ start: 0, end: 5, text: 'Maria', category: 'first_name', score: 0.99, by: 'case' }], s, { 'first_name:maria': false });
  assert.equal(f[0].redact, true, 'un-ticking is refused');
  const refs = assignRefs([{ ...f[0] }], 'abc123');
  assert.equal(token({ ...f[0], ref: 'abc123.1' }, {}), '<redacted:first_name|ref:abc123.1|confidence:99%>');
  assert.equal(refs.get('abc123.1').values[0], 'Maria');
  assert.equal(restoreString('<redacted:first_name|ref:abc123.1>', { ns: 'abc123', refs }).value, 'Maria');
});

test('model files load only from the model server, and a changed file is refused', async () => {
  const body = new TextEncoder().encode('{"model":"config"}');
  const good = createHash('sha256').update(body).digest('hex');
  const source = { baseUrl: 'https://models.example/hf/', modelId: 'openai/privacy-filter', revision: 'abc', hashes: { 'config.json': good } };
  const serve = (bytes, status = 200) => async () => new Response(bytes, { status });
  const url = 'https://models.example/hf/openai/privacy-filter/resolve/abc/config.json';
  assert.equal(await (await verifyingFetch(source, serve(body))(url)).text(), '{"model":"config"}');
  await assert.rejects((await verifyingFetch(source, serve(new TextEncoder().encode('{"changed":1}')))(url)).text(), /doesn’t match its expected hash/);
  await assert.rejects(verifyingFetch(source, serve(body))('https://huggingface.co/openai/privacy-filter/resolve/abc/config.json'), (e) => e.reason === 'blocked');
  await assert.rejects(verifyingFetch(source, serve(body, 403))(url), (e) => e.reason === 'denied');
  await assert.rejects(verifyingFetch(source, serve(body))(url.replace('config.json', 'tokenizer.json')), /No expected hash/);
  // Transformers.js asks for config files at "main": they are fetched at the pinned revision and checked.
  const asked = [];
  const record = async (u) => { asked.push(u); return new Response(body); };
  assert.equal(await (await verifyingFetch(source, record)(url.replace('/abc/', '/main/'))).text(), '{"model":"config"}');
  assert.equal(asked[0], url);
});

test('the model address comes from policy, then the caseworker, then the library, then Hugging Face; the pin stays', () => {
  const none = { values: { privacyModel: { modelId: 'openai/privacy-filter', revision: null, baseUrl: null } } };
  const def = modelSource(none, null, {});
  assert.deepEqual([def.baseUrl, def.from, def.locked, def.revision, def.hashes], [DEFAULT_MODEL.baseUrl, 'default', false, DEFAULT_MODEL.revision, DEFAULT_MODEL.hashes]);
  assert.equal(Object.keys(def.hashes).length, 5);
  const libModel = { privacy: { model: { baseUrl: 'https://lib.example/m', revision: 'r2', hashes: { 'config.json': 'x' } } } };
  const fromLib = modelSource(none, libModel, {});
  assert.deepEqual([fromLib.baseUrl, fromLib.from, fromLib.revision], ['https://lib.example/m/', 'library', 'r2']);
  const yours = modelSource(none, null, { privacy: { modelUrl: 'https://mine.example/hf/' } });
  assert.deepEqual([yours.baseUrl, yours.from, yours.revision, yours.hashes], ['https://mine.example/hf/', 'you', DEFAULT_MODEL.revision, DEFAULT_MODEL.hashes], 'a mirror you choose is still checked against the default hashes');
  const policy = modelSource({ values: { privacyModel: { baseUrl: 'https://m.example/x', revision: 'r1', required: true } } }, libModel, { privacy: { modelUrl: 'https://mine.example/hf/' } });
  assert.deepEqual([policy.baseUrl, policy.from, policy.locked, policy.revision], ['https://m.example/x/', 'policy', true, 'r1']);
});

test('a folder address serves the files from the folder itself, and nothing outside it', async () => {
  const body = new TextEncoder().encode('{"model":"config"}');
  const good = createHash('sha256').update(body).digest('hex');
  const source = { layout: 'folder', filesUrl: 'https://models.example/pf/', modelId: 'openai/privacy-filter', revision: 'abc', hashes: { 'config.json': good } };
  assert.equal(filesRoot(source), 'https://models.example/pf/');
  assert.deepEqual(transformersPaths(source), { remoteHost: 'https://models.example/pf/', remotePathTemplate: '.' });
  assert.equal(filesRoot({ baseUrl: 'https://huggingface.co/', modelId: 'm/x', revision: 'r' }), 'https://huggingface.co/m/x/resolve/r/');
  const asked = [];
  const record = async (u) => { asked.push(u); return new Response(body); };
  // Transformers.js joins host, '.' and the file name: the request goes to the folder's file, and is checked.
  assert.equal(await (await verifyingFetch(source, record)('https://models.example/pf/./config.json')).text(), '{"model":"config"}');
  assert.equal(asked[0], 'https://models.example/pf/config.json');
  await assert.rejects(verifyingFetch(source, record)('https://models.example/other/config.json'), (e) => e.reason === 'blocked');
  await assert.rejects(verifyingFetch(source, record)('https://models.example/pf/tokenizer.json'), /No expected hash/);
});

test('a folder from policy, the caseworker or the library wins over a mirror in the same place; the assistant follows only a mirror', () => {
  const none = { values: { privacyModel: {} } };
  const mine = modelSource(none, null, { privacy: { modelFilesUrl: 'https://mine.example/pf' } });
  assert.deepEqual([mine.layout, mine.filesUrl, mine.baseUrl, mine.from, mine.revision], ['folder', 'https://mine.example/pf/', null, 'you', DEFAULT_MODEL.revision]);
  const lib = modelSource(none, { privacy: { model: { filesUrl: 'https://lib.example/pf/', baseUrl: 'https://lib.example/hf/' } } }, {});
  assert.deepEqual([lib.layout, lib.filesUrl, lib.from], ['folder', 'https://lib.example/pf/', 'library']);
  const pol = modelSource({ values: { privacyModel: { filesUrl: 'https://org.example/pf/' } } }, null, { privacy: { modelUrl: 'https://mine.example/hf/' } });
  assert.deepEqual([pol.layout, pol.filesUrl, pol.from, pol.locked], ['folder', 'https://org.example/pf/', 'policy', true]);
  assert.equal(modelSource(none, null, { privacy: { modelUrl: 'https://mine.example/hf/' } }).layout, 'hub', 'an address saved before folders existed is still a mirror');
  assert.equal(assistSource({ values: { privacyModel: { filesUrl: 'https://org.example/pf/' } } }, {}).baseUrl, 'https://huggingface.co/');
  assert.equal(assistSource({ values: {} }, { privacy: { modelFilesUrl: 'https://mine.example/pf/' } }).baseUrl, 'https://huggingface.co/');
  assert.equal(assistSource({ values: { privacyModel: { baseUrl: 'https://org.example/hf/' } } }, {}).baseUrl, 'https://org.example/hf/');
  const own = assistSource({ values: { assistModel: { filesUrl: 'https://org.example/gemma' } } }, {});
  assert.deepEqual([own.layout, own.filesUrl], ['folder', 'https://org.example/gemma/']);
});

test('Test connection asks for one byte of each expected file and reports what it found', async () => {
  const source = { layout: 'folder', filesUrl: 'https://models.example/pf/', ...DEFAULT_MODEL, baseUrl: null };
  const asked = [];
  const all = await testModelServer(source, async (u, init) => { asked.push([u, init.headers.Range, init.credentials]); return new Response('x', { status: 206, headers: { 'content-range': 'bytes 0-0/1000' } }); });
  assert.deepEqual([all.found, all.expected, all.url, all.hint], [5, 5, 'https://models.example/pf/', null]);
  assert.deepEqual(asked.map(([u]) => u).sort(), Object.keys(DEFAULT_MODEL.hashes).map((f) => `https://models.example/pf/${f}`).sort());
  assert.ok(asked.every(([, r, c]) => r === 'bytes=0-0' && c === 'omit'));
  assert.ok(all.files.every((f) => f.status === 'found' && f.size === 1000));
  const denied = await testModelServer(source, async () => new Response('', { status: 401 }));
  assert.ok(denied.files.every((f) => f.status === 'denied' && f.http === 401));
  const down = await testModelServer(source, async () => { throw new TypeError('NetworkError'); });
  assert.ok(down.files.every((f) => f.status === 'unreachable'));
  // Nothing in the folder, but the files are at Hugging Face's paths under it: the hint says so.
  const hub = await testModelServer(source, async (u) => new Response('', { status: u.includes('/resolve/') ? 200 : 404 }));
  assert.deepEqual([hub.found, hub.hint], [0, 'hub']);
  const mirror = { ...DEFAULT_MODEL, baseUrl: 'https://models.example/pf/' };
  const folder = await testModelServer(mirror, async (u) => new Response('', { status: u.includes('/resolve/') ? 404 : 200 }));
  assert.deepEqual([folder.found, folder.hint], [0, 'folder']);
});

test('a model server address must be https, or http on this computer, with nothing hidden in it', () => {
  assert.equal(normalizeModelUrl(' https://models.example/hf '), 'https://models.example/hf/');
  assert.equal(normalizeModelUrl('http://localhost:8787/models'), 'http://localhost:8787/models/');
  assert.throws(() => normalizeModelUrl('http://models.example/'), /must start with https/);
  assert.throws(() => normalizeModelUrl('https://user:pw@models.example/'), /credentials/);
  assert.throws(() => normalizeModelUrl('https://models.example/?token=1'), /query/);
  assert.throws(() => normalizeModelUrl('models.example'), /full address/);
});

test('the log records a send to AI without text, tokens or values', () => {
  const cs = newCase(lib, ['hsr']);
  const payload = approve(prepare(request('Maria Kowalska 07700 900456'), context()));
  logEvent(cs, 'send_to_ai', { detail: `extract · ${payload.chars} characters · ${payload.redacted} values redacted` });
  const text = JSON.stringify(cs.log);
  assert.ok(!/Maria|Kowalska|07700|redacted:/.test(text));
  assert.match(text, /2 values redacted/);
});

// From the earlier PII prototype: the model's grouped output has decoded text and no offsets.
test('locate finds model entities in reading order, and chunkText covers the text with offsets', async () => {
  const { chunkText, locate } = await import('../../extension/lib/pii.js');
  const text = 'Client Jane Okafor\nDOB 14/03/1987, call 07700  900123. Jane Okafor moved.';
  const groups = [
    { entity_group: 'private_person', score: 0.99, word: ' Jane Okafor' }, { entity_group: 'private_date', score: 0.98, word: '14/03/1987' },
    { entity_group: 'private_phone', score: 0.97, word: '07700 900123' }, { entity_group: 'private_person', score: 0.96, word: ' Jane Okafor' },
  ];
  const spans = locate(text, groups, 100);
  assert.deepEqual(spans.map((s) => text.slice(s.start - 100, s.end - 100)), ['Jane Okafor', '14/03/1987', '07700  900123', 'Jane Okafor']);
  assert.ok(spans[3].start > spans[0].start, 'the repeated name is the second occurrence');
  assert.deepEqual(locate('nothing here', [{ entity_group: 'secret', score: 1, word: 'sk-abc' }]), []);
  const long = Array.from({ length: 50 }, (_, i) => `Line ${i} with some words in it`).join('\n');
  const chunks = chunkText(long, 200);
  assert.equal(chunks.map((c) => c.text).join(''), long);
  for (const c of chunks) assert.equal(long.slice(c.offset, c.offset + c.text.length), c.text);
  // Model findings join the others, with the model's label mapped to a placeholder category.
  const found = detect(text, { modelSpans: locate(text, groups) });
  assert.deepEqual(found.filter((f) => f.by === 'model').map((f) => f.category), ['person_name', 'date', 'phone', 'person_name']);
});

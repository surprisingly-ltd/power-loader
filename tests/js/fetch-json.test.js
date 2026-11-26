// A fetch step that reads JSON (docs/plans/json-clips.md), with fetch stubbed: the Accept header, the
// Content-Type check, refusals that never make a clip, and a JSON clip through addClip() exactly as an HTML clip
// goes: quotes, the identity check, and a conflict with the same page clipped as HTML. Logged without keys,
// paths or values. Also format in the profile, the library and export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import '../../extension/lib/extract.js';
import { demoLibrary } from './helpers/library.js';
import { addClip, clipFromExtract, fieldState, identityWarnings, newCase } from '../../extension/lib/case.js';
import { accessLayers } from '../../extension/lib/access.js';
import { archiveLog } from '../../extension/lib/activity.js';
import { pageProfiles, validateLibraryProfile } from '../../extension/lib/library.js';
import { diffDraft, exportBody } from '../../extension/lib/drafts.js';
import { FORMATS, runFetchStep, runSummary } from '../../extension/lib/fetch-steps.js';

const { window } = new JSDOM('<!DOCTYPE html><body></body>', { url: 'https://extension.invalid/sidebar/sidebar.html' });
const { DOMParser } = window;
const E = globalThis.PowerLoaderExtract;
const base = 'http://localhost:8787/demo/';
const TRIGGER = `${base}cases.html`;
const API = `${base}api/clients/`;
const bytes = (text) => new TextEncoder().encode(text);

const jsonProfile = {
  schema: 'powerloader-profile/1', id: 'cm/client-api', kind: 'extract', format: 'json', name: 'Client details (data)', version: 'v1',
  match: [`${API}*`], urlPattern: `${API}{clientId}`, when: ":root > [key='clientId']",
  fields: {
    clientId: ":root > [key='clientId']",
    firstName: ":root > [key='person'] > [key='firstName']",
    lastName: ":root > [key='person'] > [key='lastName']",
    dob: ":root > [key='person'] > [key='dateOfBirth'] | date",
    nino: ":root > [key='person'] > [key='nino']",
    postcode: ":root > [key='contact'] > [key='postcode']",
    payments: [":root > [key='payments'] > *", { '@type': 'Payment', date: ":scope > [key='paidOn'] | date", amount: ":scope > [key='amount'] | number" }],
  },
};

// The client record as the system's API sends it: the same person as demo/client-1042.html, another postcode.
const client = (over = {}) => JSON.stringify({
  clientId: 'NC-1042', person: { firstName: 'Maria', lastName: 'Kowalska', dateOfBirth: '1986-07-14T00:00:00Z', nino: 'QQ 12 34 56 C', ...over },
  contact: { postcode: 'NS1 5ZZ' }, payments: [{ paidOn: '2026-10-01', amount: 412.50 }, { paidOn: '2026-11-01', amount: 412.50 }],
});

const step = {
  id: 'p-start', name: 'Start case', role: 'fetch', text: '', links: [], url: TRIGGER, match: [`${TRIGGER}*`],
  fetch: { requests: [{ id: 'r1', name: 'Client details', url: `${API}{ref}`, method: 'GET', profileId: 'cm/client-api', required: true }] },
};

function setup({ answer = { status: 200, contentType: 'application/json; charset=utf-8', bytes: bytes(client()) } } = {}) {
  const demo = demoLibrary();
  const lib = { ...demo, profiles: [...demo.profiles, jsonProfile], steps: [step] };
  const c = newCase(lib, ['dhp'], { ref: '1042' });
  const sent = [];
  const t = {
    lib, c, sent,
    run: (over = {}) => runFetchStep({
      step, lib, c, tabUrl: TRIGGER, access: async () => accessLayers({ hosts: ['localhost:8787'] }), DOMParser,
      fetchPage: async (url, o) => { sent.push({ url, ...o }); return { url, type: 'basic', redirected: false, ...(typeof answer === 'function' ? answer() : answer) }; },
      update: async (fn) => fn(c, lib), ...over,
    }),
  };
  return t;
}

const clipHtml = (t) => {
  const url = `${base}client-1042.html`;
  const doc = new JSDOM(readFileSync(new URL('../../demo/client-1042.html', import.meta.url), 'utf8'), { url }).window.document;
  const profile = t.lib.profiles.find((p) => p.id === 'cm/client-record');
  return addClip(t.c, t.lib, clipFromExtract(t.lib, profile, { ...E.extract(doc, profile, { baseUrl: url }), url, title: doc.title }));
};

test('the profile says it reads JSON: validated, carried by the library and export, never offered for a tab', () => {
  assert.deepEqual(E.validateProfile(jsonProfile), []);
  assert.deepEqual(E.validateProfile({ ...jsonProfile, format: 'xml' }), ['"format" must be "html" or "json"']);
  assert.deepEqual(validateLibraryProfile(jsonProfile, { approvedHosts: ['localhost:8787'] }), []);
  const d = { kind: 'extract', profile: jsonProfile };
  assert.equal(exportBody(d).format, 'json');
  assert.equal('format' in exportBody({ kind: 'extract', profile: { ...jsonProfile, format: undefined } }), false, 'an HTML profile’s file is as it always was');
  assert.deepEqual(diffDraft({ kind: 'extract', profile: { ...jsonProfile, format: 'html' } }, jsonProfile).meta.map((m) => m.what), ['format']);
  const lib = { ...demoLibrary(), profiles: [jsonProfile] };
  assert.deepEqual(pageProfiles(lib, `${API}1042`), [], 'JSON tabs are phase 2');
});

test('a JSON fetch step: Accept application/json, a clip with quotes, records, and the HTML clip’s conflict', async () => {
  const t = setup();
  const html = clipHtml(t);
  assert.equal(html.added.includes('postcode'), true);
  const out = await t.run();
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].url, `${API}1042`);
  assert.equal(t.sent[0].accept, 'application/json', 'one fixed header');
  assert.equal(t.sent[0].atUrl, TRIGGER);
  assert.equal(out.states.r1.state, 'done');
  const clip = t.c.clips.find((cl) => cl.profile.id === 'cm/client-api');
  assert.equal(clip.kind, 'fetch');
  assert.equal(clip.format, 'json');
  assert.equal(clip.title, 'Client details (data)', 'JSON has no <title>: the profile’s name');
  assert.equal(clip.source, `cm/client-api|${API}1042`);
  assert.equal(clip.values.dob, '1986-07-14');
  assert.equal(clip.values.lastName, 'Kowalska');
  assert.equal(clip.quotes.dob, '.person.dateOfBirth: "1986-07-14T00:00:00Z"', 'the value as sent, before normalising');
  assert.equal(clip.quotes.postcode, '.contact.postcode: "NS1 5ZZ"');
  assert.deepEqual(Object.keys(clip.quotes).sort(), Object.keys(clip.values).sort(), 'a quote per value, none for rows');
  assert.deepEqual(clip.records.map((r) => [r.type, r.group, r.id, r.date, r.amount]), [['Payment', 'payments', 'payments-1', '2026-10-01', 412.5], ['Payment', 'payments', 'payments-2', '2026-11-01', 412.5]]);
  // Downstream of addClip() it's an ordinary clip: agreement on the person, a conflict on the postcode, no identity warning.
  assert.deepEqual(out.states.r1.summary.conflicts, ['postcode']);
  assert.ok(out.states.r1.summary.agreed.includes('lastName') && out.states.r1.summary.agreed.includes('dob'));
  assert.equal(fieldState(t.c, t.lib, 'postcode').status, 'conflict');
  assert.equal(fieldState(t.c, t.lib, 'dob').status, 'ok');
  assert.deepEqual(identityWarnings(t.c), []);
  assert.equal(html.identity.length, 0);
  assert.match(runSummary(out), /^Fetched 1 page: \d+ values? added, 1 conflict\.$/);
  // Fetching again replaces it.
  await t.run();
  assert.equal(t.c.clips.filter((cl) => cl.profile.id === 'cm/client-api').length, 1);
  assert.equal(t.c.clips.find((cl) => cl.profile.id === 'cm/client-api').revision, 2);
  // Logged as JSON with a count, never a key, a path or a value.
  const logged = t.c.log.filter((e) => e.activity === 'fetch_page');
  assert.match(logged[0].detail, /^Start case · Client details · json · \d+ items$/);
  const kept = JSON.stringify(archiveLog(t.c, 'finished'));
  for (const secret of ['Kowalska', 'dateOfBirth', '.person', 'NS1 5ZZ', 'api/clients/1042']) assert.ok(!kept.includes(secret), secret);
});

test('the identity check runs on a JSON clip unchanged: a response about someone else warns first', async () => {
  const t = setup({ answer: { status: 200, contentType: 'application/json', bytes: bytes(client({ firstName: 'Tomasz', dateOfBirth: '1979-03-02', nino: 'QQ 98 76 54 A' })) } });
  clipHtml(t);
  const out = await t.run();
  const clip = t.c.clips.find((cl) => cl.profile.id === 'cm/client-api');
  assert.ok(clip.identity?.mismatched.includes('dob'));
  assert.deepEqual(out.identity, [clip.id]);
  assert.match(runSummary(out), /This may be a different person/);
});

test('Content-Type decides: each row of the plan, and a refusal never makes a clip', async () => {
  const cases = [
    [{ status: 200, contentType: 'text/html', bytes: bytes('<p>{}</p>') }, 'notdata', /^Client details sent a page, not data: check the address$/, 'not data'],
    [{ status: 200, contentType: 'text/plain', bytes: bytes(client()) }, 'notdata', /not data/, 'not data'],
    [{ status: 200, contentType: '', bytes: bytes(client()) }, 'notdata', /not data/, 'not data'],
    [{ status: 200, contentType: 'application/octet-stream', bytes: bytes(client()) }, 'notdata', /not data/, 'not data'],
    [{ status: 200, contentType: 'text/javascript', bytes: bytes(`cb(${client()})`) }, 'script', /^This is a script, not data$/, 'script'],
    [{ status: 200, contentType: 'application/problem+json', bytes: bytes('{"title":"Not found","clientId":"x"}') }, 'problem', /^The system returned an error$/, 'error'],
    [{ status: 404, contentType: 'application/problem+json' }, 'status', /^The system returned an error \(404\)$/, 'error 404'],
    [{ status: 200, contentType: 'application/json', tooLarge: true }, 'size', /too large/, 'too large'],
    [{ status: 200, contentType: 'application/json', bytes: bytes('{"clientId":"NC-1042",}') }, 'json', /^This isn’t data Power Loader can read$/, 'not data'],
    [{ status: 200, contentType: 'application/json', bytes: bytes(`${'['.repeat(70)}${']'.repeat(70)}`) }, 'json', /^Client details is nested too deeply to read \(over 64 levels\)$/, 'too deep'],
    [{ status: 200, contentType: 'application/json', bytes: bytes(`{"clientId":"NC-1042","n":[${Array(50001).fill(1)}]}`) }, 'json', /^Client details is too large to read \(over 50,000 values\)\. Ask for less/, 'too large'],
    [{ status: 200, contentType: 'application/json', bytes: new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]) }, 'json', /text encoding/, 'encoding'],
    [{ status: 200, contentType: 'application/json', bytes: bytes('{"tenancy":{}}') }, 'when', /isn’t the one its profile reads/, 'not its page'],
  ];
  for (const [res, code, text, log] of cases) {
    const t = setup({ answer: res });
    const out = await t.run();
    assert.equal(out.states.r1.code, code, `${res.contentType} ${code}`);
    assert.match(out.states.r1.text, text);
    assert.deepEqual(t.c.clips, [], 'nothing is added');
    assert.equal(t.c.log.filter((e) => e.activity === 'fetch_page').at(-1).detail, `Start case · Client details · json · ${log}`);
  }
  // The JSON media types that are read.
  for (const type of ['application/json', 'text/json', 'application/hal+json', 'application/vnd.api+json; charset=utf-8']) {
    const t = setup({ answer: { status: 200, contentType: type, bytes: bytes(client()) } });
    assert.equal((await t.run()).states.r1.state, 'done', type);
  }
  // And one behind an XSSI prefix.
  const t = setup({ answer: { status: 200, contentType: 'application/json', bytes: bytes(`)]}'\n${client()}`) } });
  assert.equal((await t.run()).states.r1.state, 'done');
});

test('a repeated key is read (the first) and flagged on the step card and in the log', async () => {
  const t = setup({ answer: { status: 200, contentType: 'application/json', bytes: bytes('{"clientId":"NC-1042","clientId":"NC-9999","person":{"lastName":"Kowalska"}}') } });
  const out = await t.run();
  assert.equal(out.states.r1.state, 'done');
  assert.equal(out.states.r1.warning, 'This response has a repeated key: check the profile');
  assert.equal(t.c.clips[0].values.clientId, 'NC-1042');
  assert.match(t.c.log.find((e) => e.activity === 'fetch_page').detail, / · duplicate key$/);
  assert.ok(!t.c.log.find((e) => e.activity === 'fetch_page').detail.includes('clientId'));
});

test('the JSON reader never parses markup and never runs the response', () => {
  const { doc } = FORMATS.json.read(bytes('{"x":"<script>globalThis.ran=1</script>"}'), { contentType: 'application/json', DOMParser });
  assert.equal(doc.querySelector('script'), null);
  assert.equal(globalThis.ran, undefined);
  assert.equal(doc.defaultView, null);
});

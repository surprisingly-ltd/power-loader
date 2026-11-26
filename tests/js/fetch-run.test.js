// Running a fetch step (lib/fetch-steps.js) against the demo pages, with fetch stubbed: what is refused before
// anything is sent, what a response must be, cancelling and teardown, and the clips and log it leaves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import '../../extension/lib/extract.js';
import { demoLibrary } from './helpers/library.js';
import { addClip, clipFromExtract, identityWarnings, newCase } from '../../extension/lib/case.js';
import { accessLayers } from '../../extension/lib/access.js';
import { archiveLog } from '../../extension/lib/activity.js';
import { FETCH_LIMITS, abortInPage, fetchInPage, planRun, runFetchStep, runSummary } from '../../extension/lib/fetch-steps.js';

const { window } = new JSDOM('<!DOCTYPE html><body></body>', { url: 'https://extension.invalid/sidebar/sidebar.html' });
const { DOMParser } = window;
const E = globalThis.PowerLoaderExtract;
const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url));
const base = 'http://localhost:8787/demo/';
const TRIGGER = `${base}cases.html`;
const bytes = (text) => new TextEncoder().encode(text);

const step = {
  id: 'p-start', name: 'Start case', role: 'fetch', text: '', links: [], url: TRIGGER, match: [`${TRIGGER}*`],
  fetch: { requests: [
    { id: 'r1', name: 'Client details', url: `${base}client-{ref}.html`, method: 'GET', profileId: 'cm/client-record', required: true },
    { id: 'r2', name: 'Rent account', url: `${base}rent-account-{ref}.html`, method: 'GET', profileId: 'harbour-homes/rent-account', required: true },
  ] },
};

function setup({ ref = '1042', layers = accessLayers({ hosts: ['localhost:8787'] }), pages = {} } = {}) {
  const lib = { ...demoLibrary(), steps: [step] };
  const c = newCase(lib, ['dhp'], { ref });
  const sent = [];
  const page = (file) => ({ status: 200, type: 'basic', redirected: false, contentType: 'text/html; charset=utf-8', bytes: read(`demo/${file}`) });
  const responses = { [`${base}client-1042.html`]: page('client-1042.html'), [`${base}rent-account-1042.html`]: page('rent-account-1042.html'), [`${base}client-2077.html`]: page('client-2077.html'), ...pages };
  const state = { ended: false, layers };
  const ctx = {
    lib, c, sent, state,
    fetchPage: async (url, o) => { sent.push({ url, ...o }); const r = responses[url]; return typeof r === 'function' ? r(o) : r ? { url, ...r } : { status: 404, contentType: 'text/html', url }; },
    update: async (fn) => { if (state.ended) throw Object.assign(new Error('That case has ended'), { name: 'CaseEnded' }); return fn(c, lib); },
    access: async () => state.layers,
  };
  ctx.run = (over = {}) => runFetchStep({ step, lib, c, tabUrl: TRIGGER, access: ctx.access, fetchPage: ctx.fetchPage, update: ctx.update, DOMParser, ...over });
  return ctx;
}

test('a run fetches each page from the trigger tab, GET only, and adds it as a clip with its provenance', async () => {
  const t = setup();
  const progress = [];
  const out = await t.run({ onProgress: (s) => progress.push(s) });
  assert.equal(out.problem, null);
  assert.deepEqual(t.sent.map((s) => s.url).sort(), [`${base}client-1042.html`, `${base}rent-account-1042.html`]);
  for (const s of t.sent) {
    assert.equal(s.atUrl, TRIGGER, 'made from the trigger page, which must still be there');
    assert.equal(s.accept, 'text/html,application/xhtml+xml');
    assert.equal(s.maxBytes, FETCH_LIMITS.maxBytes);
  }
  assert.deepEqual(Object.values(out.states).map((s) => s.state), ['done', 'done']);
  assert.ok(progress.some((s) => Object.values(s).some((x) => x.state === 'fetching')));
  const clip = t.c.clips.find((cl) => cl.profile.id === 'cm/client-record');
  assert.equal(clip.kind, 'fetch');
  assert.deepEqual(clip.via, { stepId: 'p-start', requestId: 'r1' });
  assert.equal(clip.url, `${base}client-1042.html`);
  assert.equal(clip.source, `cm/client-record|${base}client-1042.html`, 'the same source as clipping that page');
  assert.equal(clip.values.lastName, 'Kowalska');
  assert.ok(out.added > 0);
  assert.match(runSummary(out), /^Fetched 2 pages: \d+ values added\.$/);
  // Logged: one fetch_page per request with the profile's pattern, and the step completed. No values.
  const fetched = t.c.log.filter((e) => e.activity === 'fetch_page');
  assert.equal(fetched.length, 2);
  assert.equal(fetched.find((e) => e.clip === clip.id).url_pattern, 'http://localhost:8787/demo/client-{clientId}.html');
  assert.match(fetched[0].detail, /^Start case · (Client details|Rent account) · \d+ items$/);
  assert.ok(t.c.log.some((e) => e.activity === 'complete_step' && e.detail === 'Start case'));
  const kept = JSON.stringify(archiveLog(t.c, 'finished'));
  assert.ok(!kept.includes('client-1042.html'), 'the archived log keeps patterns, never the address');
  assert.ok(!kept.includes('Kowalska'), 'or a value');
});

test('a run tells the page what it is reading as it goes, and each clip keeps the text around its values', async () => {
  const t = setup();
  const events = [];
  await t.run({ onShow: (e) => { events.push(e); if (e.op === 'read') throw new Error('drawing failed'); } });
  assert.deepEqual(events.filter((e) => e.op === 'open').map((e) => e.item.key).sort(), ['r1', 'r2']);
  const read = events.filter((e) => e.op === 'read');
  assert.equal(read.length, 2, 'a drawing that fails is never the run’s failure');
  const v = read.find((e) => e.item.key === 'r1').view;
  assert.ok(v.lines.length && v.marks.some((m) => m.key === 'lastName'));
  // Excerpts: short, only for what the clip holds, and as text.
  const clip = t.c.clips.find((cl) => cl.profile.id === 'cm/client-record');
  assert.ok(clip.excerpts && Object.keys(clip.excerpts).every((k) => k in clip.values || clip.records.some((r) => r.group === k)));
  const ex = clip.excerpts.lastName;
  assert.equal(ex.lines[ex.marks[0].line].text.slice(ex.marks[0].start, ex.marks[0].end), 'Kowalska');
  assert.ok(JSON.stringify(clip.excerpts).length < 20 * 1024);
  assert.doesNotMatch(JSON.stringify(clip.excerpts), /<[a-z]/i, 'no markup');
  assert.ok(!t.c.log.some((e) => JSON.stringify(e).includes('Kowalska')), 'nothing read is in the log');
});

test('fetching again replaces the clip, and a fetched clip and a clipped one of the same page are one source', async () => {
  const t = setup();
  await t.run();
  const n = t.c.clips.length;
  await t.run();
  assert.equal(t.c.clips.length, n, 'replaced, not duplicated');
  assert.equal(t.c.clips.find((cl) => cl.profile.id === 'cm/client-record').revision, 2);
  // Clipping the page by hand replaces the fetched clip too.
  const profile = t.lib.profiles.find((p) => p.id === 'cm/client-record');
  const doc = new JSDOM(read('demo/client-1042.html'), { url: `${base}client-1042.html` }).window.document;
  addClip(t.c, t.lib, clipFromExtract(t.lib, profile, { ...E.extract(doc, profile, { baseUrl: doc.URL }), url: doc.URL, title: doc.title }));
  assert.equal(t.c.clips.length, n);
});

test('the identity check runs on a fetched clip unchanged: a page about someone else warns first', async () => {
  // The address is filled from the case, but the system answers with another client's page.
  const other = { status: 200, contentType: 'text/html', bytes: read('demo/client-2077.html') };
  const t2 = setup({ pages: { [`${base}client-1042.html`]: other } });
  Object.assign(t2.c.manual, { lastName: 'Kowalska', dob: '1986-07-14' });
  const out = await t2.run();
  const clip = t2.c.clips.find((cl) => cl.profile.id === 'cm/client-record');
  assert.ok(clip.identity?.mismatched.length, 'flagged as maybe a different person');
  assert.deepEqual(identityWarnings(t2.c).map((x) => x.id), [clip.id]);
  assert.deepEqual(out.identity, [clip.id]);
  assert.match(runSummary(out), /This may be a different person/);
});

test('any redirect fails the request, and nothing is read from it', async () => {
  for (const res of [{ status: 0, type: 'opaqueredirect' }, { status: 302 }, { status: 200, redirected: true, contentType: 'text/html', bytes: bytes('<title>Sign in</title>') }]) {
    const t = setup({ pages: { [`${base}client-1042.html`]: res } });
    const out = await t.run();
    assert.equal(out.states.r1.state, 'failed');
    assert.equal(out.states.r1.code, 'redirect');
    assert.match(out.states.r1.text, /^Client details moved to another address, probably a sign-in page/);
    assert.ok(!t.c.clips.some((cl) => cl.profile.id === 'cm/client-record'));
    assert.ok(t.c.log.some((e) => e.activity === 'fetch_page' && e.detail === 'Start case · Client details · redirect'));
  }
  // A response from another address than asked for, on the same site, is a redirect too.
  const t = setup({ pages: { [`${base}client-1042.html`]: { status: 200, contentType: 'text/html', url: `${base}cases.html`, bytes: read('demo/cases.html') } } });
  assert.equal((await t.run()).states.r1.code, 'redirect');
});

test('a sign-in, an error, a page that isn’t HTML, one too large, and one that never answers', async () => {
  const cases = [
    [{ status: 401 }, 'signin', /sign in again/],
    [{ status: 403 }, 'signin', /sign in again/],
    [{ status: 500 }, 'status', /error \(500\)/],
    [{ status: 200, contentType: 'application/json', bytes: bytes('{}') }, 'type', /isn’t a page/],
    [{ status: 200, contentType: 'text/html', tooLarge: true }, 'size', /too large/],
    [{ error: 'timeout' }, 'timeout', /too long/],
    [{ status: 200, contentType: 'text/html', bytes: bytes('<p>no header</p>') }, 'when', /isn’t the one its profile reads/],
  ];
  for (const [res, code, text] of cases) {
    const t = setup({ pages: { [`${base}client-1042.html`]: res } });
    const out = await t.run();
    assert.equal(out.states.r1.code, code, code);
    assert.match(out.states.r1.text, text);
    assert.equal(out.states.r2.state, 'done', 'the other request still runs');
  }
});

test('refused before anything is sent: not on the trigger page, another site, a value in the host, the cap', async () => {
  const t = setup();
  assert.equal((await t.run({ tabUrl: `${base}client-1042.html` })).problem, 'not-here');
  assert.deepEqual(t.sent, []);
  // A step whose request names another site, or puts a value in the host, is refused per request.
  const lib = { ...t.lib };
  const planned = (url) => planRun({ step: { ...step, fetch: { requests: [{ ...step.fetch.requests[0], url }] } }, lib, c: t.c, layers: t.state.layers, tabUrl: TRIGGER }).items[0].problem;
  assert.equal(planned('http://127.0.0.1:8787/demo/client-{ref}.html'), 'trigger');
  assert.equal(planned('http://{ref}/demo/client.html'), 'template');
  assert.equal(planned(`${base}rent-account-{ref}.html`), 'profile', 'an address that isn’t the page its profile reads');
  t.c.ref = '..';
  assert.equal(planned(`${base}{ref}/client-1042.html`), 'dots', 'a value that is only dots would go up a folder');
  assert.equal(planned(`${base}client-{ref}.html`), 'dots', 'so it’s refused wherever it goes');
  t.c.ref = '';
  assert.equal(planned(`${base}client-{ref}.html`), 'missing');
  // At most 60 requests a case in 10 minutes.
  const t2 = setup();
  for (let i = 0; i < 59; i++) t2.c.log.push({ activity: 'fetch_page', timestamp: new Date().toISOString() });
  assert.equal((await t2.run()).problem, 'cap');
  assert.deepEqual(t2.sent, []);
});

test('a denied address and background reading off are never requested, and say so', async () => {
  const deny = accessLayers({ hosts: ['localhost:8787'], settings: { siteAccess: { rules: [{ id: 'm1', effect: 'deny', pattern: 'http://localhost:8787/demo/client-*', actions: ['fetch-get'] }] } } });
  const t = setup({ layers: deny });
  const out = await t.run();
  assert.equal(out.states.r1.code, 'blocked');
  assert.equal(out.states.r1.text, 'Blocked by the site rules');
  assert.deepEqual(t.sent.map((s) => s.url), [`${base}rent-account-1042.html`]);
  assert.ok(t.c.log.some((e) => e.activity === 'blocked_action' && e.detail === 'fetch-get · your rule'));
  const off = setup({ layers: accessLayers({ hosts: ['localhost:8787'], settings: { siteAccess: { backgroundReading: false } } }) });
  const o2 = await off.run();
  assert.deepEqual(Object.values(o2.states).map((s) => s.code), ['off', 'off']);
  assert.deepEqual(off.sent, []);
  assert.deepEqual(off.c.clips, []);
  // An unapproved host is refused by the approved-hosts layer.
  const elsewhere = setup({ layers: accessLayers({ hosts: ['cm.example.gov.uk'] }) });
  assert.deepEqual(Object.values((await elsewhere.run()).states).map((s) => s.code), ['blocked', 'blocked']);
  assert.deepEqual(elsewhere.sent, []);
});

test('a rules change between pressing the button and a request is respected', async () => {
  const t = setup();
  const strict = accessLayers({ hosts: ['localhost:8787'], settings: { siteAccess: { backgroundReading: false } } });
  let calls = 0;
  t.access = async () => (++calls === 1 ? t.state.layers : strict);
  const out = await t.run({ access: t.access });
  assert.deepEqual(Object.values(out.states).map((s) => s.code), ['off', 'off']);
  assert.deepEqual(t.sent, []);
});

test('Stop aborts the run, and a run reports what it got before it stopped', async () => {
  const t = setup({ pages: { [`${base}rent-account-1042.html`]: () => new Promise(() => {}) } });
  const stop = new AbortController();
  const running = t.run({ signal: stop.signal, onProgress: (s) => { if (s.r1?.state === 'done') stop.abort(); } });
  const out = await running;
  assert.equal(out.stopped, true);
  assert.equal(out.states.r1.state, 'done');
  assert.equal(out.states.r2.code, 'stopped');
  assert.ok(t.sent.find((s) => s.url.includes('rent-account')).signal.aborted, 'the request in the tab is aborted too');
  assert.match(runSummary(out), /^Fetched 1 page: \d+ values added\. 1 page couldn’t be fetched, stopped\.$/);
});

test('teardown: once the case has ended, a late result is dropped and the rest of the run stops', async () => {
  let release;
  const late = new Promise((r) => { release = r; });
  const t = setup({ pages: { [`${base}client-1042.html`]: () => late.then(() => ({ status: 200, contentType: 'text/html', url: `${base}client-1042.html`, bytes: read('demo/client-1042.html') })) } });
  const running = t.run();
  await new Promise((r) => setTimeout(r, 10));
  t.state.ended = true; // CASE_ENDED: updateCase() now throws CaseEnded
  release();
  const out = await running;
  assert.equal(out.ended, true);
  assert.equal(out.states.r1.code, 'ended');
  assert.deepEqual(t.c.clips.filter((cl) => cl.profile.id === 'cm/client-record'), [], 'no clip after the end');
  assert.ok(!t.c.log.some((e) => e.activity === 'fetch_page' && /Client details/.test(e.detail)), 'and no log event for it');
});

test('fetchInPage: GET, same-origin credentials, no redirects, a byte cap, and only from the page it was checked on', async () => {
  const calls = [];
  const origin = { fetch: globalThis.fetch, location: globalThis.location };
  globalThis.location = new URL(TRIGGER);
  const respond = (body, init) => new Response(body, init);
  globalThis.fetch = async (url, o) => { calls.push({ url, ...o }); return typeof globalThis.nextResponse === 'function' ? globalThis.nextResponse(o) : respond('<title>x</title>', { headers: { 'content-type': 'text/html' } }); };
  try {
    const req = { url: `${base}client-1042.html`, atUrl: TRIGGER, accept: 'text/html', timeoutMs: 1000, maxBytes: 100, id: 'a' };
    const ok = await fetchInPage(req);
    assert.equal(ok.status, 200);
    assert.equal(new TextDecoder().decode(ok.bytes), '<title>x</title>');
    assert.deepEqual({ method: calls[0].method, credentials: calls[0].credentials, redirect: calls[0].redirect, cache: calls[0].cache, accept: calls[0].headers.Accept }, { method: 'GET', credentials: 'same-origin', redirect: 'manual', cache: 'no-store', accept: 'text/html' });
    assert.deepEqual(await fetchInPage({ ...req, atUrl: `${base}other.html` }), { error: 'moved' }, 'the tab moved on since the check');
    assert.deepEqual(await fetchInPage({ ...req, url: 'https://evil.example/x' }), { error: 'origin' }, 'another site');
    assert.equal(calls.length, 1, 'neither was sent');
    globalThis.nextResponse = () => respond('x'.repeat(500), { headers: { 'content-type': 'text/html' } });
    assert.equal((await fetchInPage(req)).tooLarge, true);
    globalThis.nextResponse = () => respond('secret', { status: 500, headers: { 'content-type': 'text/html' } });
    assert.equal((await fetchInPage(req)).bytes, undefined, 'an error page is never read');
    // Stop: abortInPage() aborts the request in the tab.
    globalThis.nextResponse = (o) => new Promise((_, reject) => o.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    const pending = fetchInPage({ ...req, id: 'b' });
    abortInPage('b');
    assert.deepEqual(await pending, { error: 'stopped' });
    const slow = fetchInPage({ ...req, id: 'c', timeoutMs: 5 });
    assert.deepEqual(await slow, { error: 'timeout' });
  } finally {
    globalThis.fetch = origin.fetch;
    if (origin.location === undefined) delete globalThis.location; else globalThis.location = origin.location;
    delete globalThis.nextResponse;
  }
});

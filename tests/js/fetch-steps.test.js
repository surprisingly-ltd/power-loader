// Fetch steps: pages read in the background from the trigger page, nested under a step. The step model
// (templates, compile, validate, index, export and import) here; the runner in fetch-run.test.js.
// docs/plans/fetch-steps.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import '../../extension/lib/extract.js';
import {
  addField, addPage, addRequest, bindPage, compileFlow, contract, exportFlow, fetchedNow, flowLib, importFlow, journeyOf, mapPick, newFlow, pageOf, pagesOf,
  recordFetchedTest, removePage, removeRequest, requestUrl, setRequest, setThen, startable, validateFlow,
} from '../../extension/lib/flows.js';
import { judgeTest, recordTest } from '../../extension/lib/drafts.js';
import { fetchStepErrors, fetchTemplateErrors, fillFetchUrl, stepAddress, stepForPage, stepStatus, validateSteps } from '../../extension/lib/journey.js';
import { indexLibrary } from '../../extension/lib/library.js';
import { accessLayers } from '../../extension/lib/access.js';
import { canonical } from '../../extension/lib/hash.js';

const E = globalThis.PowerLoaderExtract;
const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const base = 'http://localhost:8787/demo/';
const pageDoc = (file) => new JSDOM(read(`demo/${file}`), { url: base + file }).window.document;
const probe = (doc, draft) => Object.fromEntries(Object.entries(draft.profile.fields).map(([k, s]) => [k, E.probe(doc, s)]));
const codes = (issues) => issues.map((i) => i.code);
const fields = { clientId: { label: 'Client ID' }, lastName: { label: 'Last name' } };

/** A flow whose fetch step, started on the case list, fetches the client record. */
export function fetchFlow() {
  const flow = newFlow({ name: 'Client check' });
  const out = pagesOf(flow, 'output')[0];
  bindPage(flow, out.id, { url: `${base}dhp.html`, title: 'Discretionary housing payment' });
  const last = addField(flow, { label: 'Last name' });
  const dob = addField(flow, { label: 'Date of birth', type: 'date' });
  const clientId = addField(flow, { label: 'Client ID' });
  mapPick(out, last, '#d-lastname');
  mapPick(out, dob, '#d-dob');
  const unused = pagesOf(flow, 'input')[0];
  const step = addPage(flow, 'fetch');
  bindPage(flow, step.id, { url: `${base}cases.html`, title: 'Cases' });
  const { request, page } = addRequest(flow, step.id, { name: 'Client details' });
  bindPage(flow, page.id, { url: `${base}client-1042.html`, title: 'Maria Kowalska – client', values: ['Maria Kowalska'] });
  mapPick(page, last, 'table.details label(Last name)');
  mapPick(page, dob, 'table.details label(Date of birth)');
  mapPick(page, clientId, '#client-header label(Client ID)');
  setRequest(flow, step.id, request.id, { url: `${base}client-{ref}.html` });
  // The new flow's empty page to clip isn't needed: the fetched page gathers the values.
  removePage(flow, unused.id);
  return { flow, out, step, request, page };
}

function testPages(flow, { fetched = true } = {}) {
  const lib = flowLib(flow);
  for (const p of flow.pages.filter((x) => x.draft && x.role === 'input')) {
    const file = 'client-1042.html';
    recordTest(p.draft, judgeTest(p.draft, probe(pageDoc(file), p.draft), { url: base + file, lib, pageValues: ['Maria Kowalska'] }));
    if (fetched) recordFetchedTest(p.draft, { ok: true });
  }
  for (const p of pagesOf(flow, 'output')) p.draft.tested = { at: 'x', url: `${base}dhp.html`, ok: true, fields: {}, leaks: [], snapshot: canonical(p.draft.profile) };
}

test('a request address keeps its site literal, refuses dot segments, and must still fit once filled', () => {
  assert.deepEqual(fetchTemplateErrors('https://cm.example.gov.uk/clients/{clientId}', fields), []);
  assert.ok(fetchTemplateErrors('https://{host}/clients/1', fields).some((e) => /site written out/.test(e)), 'a value in the host');
  assert.ok(fetchTemplateErrors('https://cm.example{clientId}/x', fields).some((e) => /site written out/.test(e)), 'a value straight after the host');
  assert.ok(fetchTemplateErrors('https://cm.example.gov.uk:{clientId}/x', fields).some((e) => /site written out/.test(e)), 'a value in the port');
  assert.deepEqual(fetchTemplateErrors('https://cm.example.gov.uk?id={clientId}', fields), ['must have a / straight after the site name']);
  assert.deepEqual(fetchTemplateErrors('https://me@cm.example.gov.uk/x', fields), ['can’t have a user name in it']);
  assert.deepEqual(fetchTemplateErrors('https://cm.example.gov.uk/{nope}', fields), ['uses {nope}, which isn’t a field']);
  // Filling: values are encoded, so a / ? # or @ in one stays in its segment.
  assert.deepEqual(fillFetchUrl('https://cm.example.gov.uk/clients/{clientId}', { clientId: 'a/../../admin?x#y' }), { url: 'https://cm.example.gov.uk/clients/a%2F..%2F..%2Fadmin%3Fx%23y', missing: [], error: null });
  for (const v of ['..', '.', '...']) assert.equal(fillFetchUrl('https://cm.example.gov.uk/clients/{clientId}/details', { clientId: v }).error, 'dots', v);
  assert.equal(fillFetchUrl('https://{x}/clients/1', { x: 'evil.example' }).error, 'template');
  assert.equal(fillFetchUrl('https://cm.example{x}/', { x: '.evil.example' }).error, 'template');
  assert.deepEqual(fillFetchUrl('https://cm.example.gov.uk/clients/{clientId}', {}), { url: null, missing: ['clientId'], error: null });
});

test('steps.json checks a fetch step: requests, GET only, their addresses, at most 6, and where it goes next', () => {
  const r = (over = {}) => ({ id: 'r1', name: 'Client', url: 'https://cm.example.gov.uk/clients/{clientId}', method: 'GET', profileId: 'cm/client', required: true, ...over });
  assert.deepEqual(fetchStepErrors({ requests: [r()], then: { url: 'https://cm.example.gov.uk/decide/{ref}', open: 'ask' } }, fields), []);
  assert.deepEqual(fetchStepErrors({ requests: [] }, fields), ['a fetch step needs at least one request']);
  assert.deepEqual(fetchStepErrors({ requests: [r({ method: 'POST', body: { a: '{ref}' } })] }, fields), ['requests[0]: "method" must be GET (Power Loader doesn’t post forms yet)', 'requests[0]: a GET request has no "body"']);
  assert.ok(fetchStepErrors({ requests: [r({ url: 'https://{h}/x' })] }, fields)[0].startsWith('requests[0]: the address must have its site written out'));
  assert.deepEqual(fetchStepErrors({ requests: Array.from({ length: 7 }, (_, i) => r({ id: `r${i}` })) }, fields), ['a fetch step has at most 6 requests']);
  assert.deepEqual(fetchStepErrors({ requests: [r()], then: { open: 'auto' } }, fields), ['"then.open" must be ask (opening the next page by itself isn’t built yet)']);
  const doc = { schema: 'powerloader-steps/1', steps: [{ id: 's', name: 'Start', role: 'fetch', text: '', links: [], fetch: { requests: [r({ profileId: '' })] } }] };
  assert.deepEqual(validateSteps(doc, fields), ['steps[0]: requests[0]: needs the "profileId" of the page profile that reads it']);
});

test('a request’s page is a page to clip under its step: not a step of its own, but it gathers its fields', () => {
  const { flow, step, request, page } = fetchFlow();
  assert.equal(page.parent, step.id);
  assert.equal(page.name, 'Client details', 'the page’s title held a value, so it keeps the request’s name');
  assert.ok(!journeyOf(flow).some((p) => p.id === page.id), 'not a step of its own');
  assert.ok(journeyOf(flow).some((p) => p.id === step.id));
  assert.deepEqual(contract(flow).find((r) => r.key === 'lastName').gathered, [page.id], 'still gathers its fields');
  assert.equal(requestUrl(flow, request), `${base}client-{ref}.html`);
  assert.equal(addRequest(flow, step.id).page.parent, step.id);
  for (let i = 0; i < 4; i++) addRequest(flow, step.id);
  assert.throws(() => addRequest(flow, step.id), /at most 6 pages/);
  // Removing a request takes its page; removing the step takes them all.
  const extra = step.fetch.requests[1];
  removeRequest(flow, step.id, extra.id);
  assert.equal(pageOf(flow, extra.pageId), null);
  removePage(flow, step.id);
  assert.equal(pageOf(flow, page.id), null);
});

test('validateFlow: the rows for a fetch step, and a page that hasn’t been tested as fetched', () => {
  const empty = newFlow({ name: 'x' });
  const s = addPage(empty, 'fetch');
  assert.ok(codes(validateFlow(empty)).includes('fetch-empty'));
  assert.ok(codes(validateFlow(empty)).includes('fetch-no-trigger'));
  assert.equal(validateFlow(empty).find((i) => i.code === 'fetch-no-trigger').level, 'warn');
  addRequest(empty, s.id);
  assert.ok(codes(validateFlow(empty)).includes('fetch-address'), 'no address yet');

  const { flow, step, request, page } = fetchFlow();
  testPages(flow, { fetched: false });
  const untested = validateFlow(flow).find((i) => i.code === 'fetch-untested');
  assert.equal(untested.level, 'error');
  assert.equal(untested.pageId, page.id);
  recordFetchedTest(page.draft, { ok: false });
  assert.match(validateFlow(flow).find((i) => i.code === 'fetch-untested').text, /built after it loads.*make it a page to clip instead/);
  recordFetchedTest(page.draft, { ok: true });
  assert.ok(fetchedNow(page.draft));
  assert.deepEqual(codes(validateFlow(flow).filter((i) => i.level === 'error')), []);
  // A retest on the page with the same profile keeps the test as fetched; an edit drops both.
  recordTest(page.draft, { ...page.draft.tested, fetched: undefined, url: page.draft.tested.url });
  assert.ok(fetchedNow(page.draft));

  // Addresses: a value in the host, another site, one that doesn't match its page.
  for (const [url, re] of [
    ['http://{ref}/client.html', /site written out/],
    ['http://127.0.0.1:8787/demo/client-{ref}.html', /isn’t one of the flow’s systems|same site/],
    [`${base}rent-account-{ref}.html`, /doesn’t match its page/],
  ]) {
    setRequest(flow, step.id, request.id, { url });
    assert.ok(validateFlow(flow).some((i) => i.code === 'fetch-address' && i.level === 'error' && re.test(i.text)), url);
  }
  setRequest(flow, step.id, request.id, { url: `${base}client-{ref}.html` });
  // The site rules block it: an error. Background reading off: a warning, once, not an error.
  const deny = accessLayers({ settings: { siteAccess: { rules: [{ id: 'm', effect: 'deny', pattern: 'http://localhost:8787/demo/client-*', actions: ['fetch-get'] }] } } });
  assert.ok(validateFlow(flow, { access: deny }).some((i) => i.code === 'blocked' && i.level === 'error' && i.requestId === request.id));
  const off = validateFlow(flow, { access: accessLayers({ settings: { siteAccess: { backgroundReading: false } } }) });
  assert.deepEqual(off.filter((i) => i.code === 'background-off').map((i) => i.level), ['warn']);
  assert.ok(!off.some((i) => i.level === 'error'), 'the flow is still fine to export and start');
});

test('compiling: the step with its trigger and requests, its pages as page profiles, checked by indexLibrary', () => {
  const { flow, step, page } = fetchFlow();
  setThen(step, { to: pagesOf(flow, 'output')[0].id });
  testPages(flow);
  const { files, hosts } = compileFlow(flow);
  const s = files['steps.json'].steps.find((x) => x.id === step.id);
  const profileId = Object.values(files).find((f) => f.name === page.name && f.kind === 'extract').id;
  assert.deepEqual(s.fetch, {
    requests: [{ id: step.fetch.requests[0].id, name: page.name, url: `${base}client-{ref}.html`, method: 'GET', profileId, required: true }],
    then: { url: `${base}dhp.html`, to: pagesOf(flow, 'output')[0].id, open: 'ask' },
  });
  assert.equal(s.url, `${base}cases.html`);
  assert.deepEqual(s.match, [`${base}cases.html*`]);
  assert.ok(!files['steps.json'].steps.some((x) => x.id === page.id), 'its page isn’t a step');
  const lib = indexLibrary({ files }, { approvedHosts: hosts });
  assert.deepEqual(lib.problems, []);
  assert.equal(stepForPage(lib, `${base}cases.html`).id, step.id, 'found by its trigger page');
  assert.equal(stepAddress(lib, s), `${base}cases.html`);
  // indexLibrary refuses a request for a profile it hasn't got, an unapproved host, or another site.
  const bad = structuredClone(files);
  const bs = bad['steps.json'].steps.find((x) => x.id === step.id);
  bs.fetch.requests.push({ ...bs.fetch.requests[0], id: 'r2', profileId: 'nope/page' }, { ...bs.fetch.requests[0], id: 'r3', url: 'https://evil.example/client-{ref}.html' });
  const errs = indexLibrary({ files: bad }, { approvedHosts: hosts }).problems.find((p) => p.path === 'steps.json').errors;
  assert.ok(errs.some((e) => /page profile "nope\/page" isn’t in the library/.test(e)));
  assert.ok(errs.some((e) => /host evil.example isn’t on the approved systems list/.test(e)));
  bs.fetch.requests.splice(1);
  bs.match = ['http://127.0.0.1:8787/demo/cases.html*'];
  const errs2 = indexLibrary({ files: bad }, { approvedHosts: [...hosts, '127.0.0.1:8787'] }).problems.find((p) => p.path === 'steps.json').errors;
  assert.ok(errs2.some((e) => /same site as the step’s page/.test(e)));
});

test('stepStatus: done once every required request’s page is in the case, fetched or clipped by hand', () => {
  const step = { id: 's', role: 'fetch', fetch: { requests: [{ id: 'a', profileId: 'cm/a', required: true }, { id: 'b', profileId: 'cm/b', required: false }] } };
  const c = { clips: [] };
  assert.equal(stepStatus(c, step), 'todo');
  c.clips.push({ profile: { id: 'cm/a' } });
  assert.equal(stepStatus(c, step), 'done', 'the optional one isn’t needed');
  const none = { id: 't', role: 'fetch', fetch: { requests: [{ id: 'a', profileId: 'cm/a', required: false }, { id: 'b', profileId: 'cm/b', required: false }] } };
  assert.equal(stepStatus(c, none), 'todo', 'with none required, all of them');
});

test('export and import: requests follow their new page ids, a missing page drops its request, pages come back untested', () => {
  const { flow, step, page } = fetchFlow();
  setThen(step, { to: pagesOf(flow, 'output')[0].id });
  testPages(flow);
  const file = JSON.parse(JSON.stringify(exportFlow(flow)));
  assert.ok(file.hosts.includes('localhost:8787'));
  const exported = file.pages.find((p) => p.id === step.id);
  assert.equal(exported.fetch.requests[0].pageId, page.id);
  assert.equal(file.pages.find((p) => p.id === page.id).parent, step.id);
  const back = importFlow(file);
  const s2 = pagesOf(back, 'fetch')[0];
  const child = pageOf(back, s2.fetch.requests[0].pageId);
  assert.notEqual(child.id, page.id, 'new ids');
  assert.equal(child.parent, s2.id);
  assert.equal(s2.fetch.then.to, pagesOf(back, 'output')[0].id);
  assert.equal(child.draft.tested, null, 'untested here, so it can’t run until tested on this computer');
  assert.ok(validateFlow(back).some((i) => i.code === 'untested' && i.pageId === child.id));
  // A request whose page isn't in the file is dropped; a page whose step is missing is an ordinary page to clip.
  const planted = structuredClone(file);
  planted.pages.find((p) => p.id === step.id).fetch.requests.push({ id: 'x', name: 'Elsewhere', pageId: 'p-missing', url: 'https://evil.example/{ref}', required: true });
  planted.pages.push({ ...planted.pages.find((p) => p.id === page.id), id: 'p-orphan', parent: 'p-nowhere' });
  const b2 = importFlow(planted);
  assert.equal(pagesOf(b2, 'fetch')[0].fetch.requests.length, 1);
  assert.equal(b2.pages.filter((p) => p.parent).length, 1, 'the orphan isn’t anyone’s page to fetch');
  // At most 6 requests come in from a file.
  const many = structuredClone(file);
  const ms = many.pages.find((p) => p.id === step.id);
  ms.fetch.requests = Array.from({ length: 9 }, (_, i) => ({ ...ms.fetch.requests[0], id: `r${i}` }));
  assert.ok(importFlow(many).pages.find((p) => p.role === 'fetch').fetch.requests.length <= 6);
});

test('the start confirmation lists each fetch step and its systems, and pages not tested as fetched', () => {
  const { flow, step, page } = fetchFlow();
  testPages(flow, { fetched: false });
  const can = startable(flow);
  assert.deepEqual(can.fetches, [{ name: step.name, hosts: ['localhost:8787'] }]);
  assert.ok(can.untested.includes(`${page.name} (as fetched)`));
});

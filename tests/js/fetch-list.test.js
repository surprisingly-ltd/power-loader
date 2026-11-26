// A fetch step that fetches every link in a list on its page (lib/fetch-steps.js planList(), runFetchStep()),
// with fetch stubbed against the generated demo systems: the team inbox's 25 messages, read as rows, the step's
// show picking the open urgent referrals, the caps, stopping and teardown, and a flow with no form to fill.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import '../../extension/lib/extract.js';
import { demoLibrary } from './helpers/library.js';
import { newCase } from '../../extension/lib/case.js';
import { accessLayers } from '../../extension/lib/access.js';
import { archiveLog } from '../../extension/lib/activity.js';
import { FETCH_LIMITS, listAddresses, planList, planRun, runFetchStep, runSummary, shownRows } from '../../extension/lib/fetch-steps.js';
import { stepStatus, validateSteps } from '../../extension/lib/journey.js';
import { addListRequest, addPage, exportFlow, importFlow, newFlow, pagesOf, removePage, requestsOf, setRequest, setShow, startable, validateFlow } from '../../extension/lib/flows.js';
import { REFERRALS, buildData, buildFiles, buildReferrals } from '../../tools/build-demo-systems.mjs';

const { window } = new JSDOM('<!DOCTYPE html><body></body>', { url: 'https://extension.invalid/sidebar/sidebar.html' });
const { DOMParser } = window;
const E = globalThis.PowerLoaderExtract;
const B = 'http://localhost:8787/demo/';
const INBOX = `${B}messages/index.html`;
const cases = buildData();
const referrals = buildReferrals(cases);
const files = buildFiles(cases, referrals);

// The two profiles the demo library has for this (demo/library/profiles/pages/messages/), inline here so the
// runner is tested on its own.
const inbox = {
  schema: 'powerloader-profile/1', id: 'test/inbox', kind: 'extract', name: 'Team inbox', version: 'v1',
  match: [`${B}messages/index*`], urlPattern: `${B}messages/index.html`, when: '#inbox',
  fields: { items: ['#inbox tbody tr', { '@type': 'inboxItem', href: 'a @href | abs', messageId: '@data-message' }] },
};
const inboxMessage = {
  schema: 'powerloader-profile/1', id: 'test/inbox-message', kind: 'extract', name: 'Inbox message', version: 'v1',
  match: [`${B}messages/message/*`], urlPattern: `${B}messages/message/{messageId}.html`, when: '#message',
  // The row is the page's main, not #message: the #referral section is beside #message, not in it.
  fields: { item: ['main', { '@type': 'inboxItem', messageId: '#message label(Message ID)', type: '#message label(Type)', client: '#message label(Client ID)', from: '#message label(From)', received: '#message label(Received) | date', urgency: '#referral label(Urgency)', status: '#referral label(Referral status)', reason: '#referral label(Reason)', respondBy: '#referral label(Respond by) | date' }] },
};
const SHOW = { type: 'inboxItem', where: { urgency: 'Urgent', status: 'Open' }, label: 'Open urgent referrals', columns: ['client', 'reason', 'respondBy'] };
const step = {
  id: 'p-inbox', name: 'Team inbox', role: 'fetch', text: '', links: [], url: INBOX, match: [`${B}messages/index*`],
  fetch: { requests: [{ id: 'r1', name: 'Messages', each: { profileId: 'test/inbox', list: 'items', max: 25 }, method: 'GET', profileId: 'test/inbox-message', required: false }], show: SHOW },
};
const base = demoLibrary();
const lib = { ...base, profiles: [...base.profiles, inbox, inboxMessage], steps: [step] };
const layers = () => accessLayers({ currentLib: base, hosts: ['localhost:8787'] });
const hrefsOn = (rel = 'messages/index.html') => {
  const url = `${B}${rel}`;
  const doc = new JSDOM(files[rel], { url }).window.document;
  return E.extract(doc, inbox, { baseUrl: url }).data.items.map((r) => r.href);
};
const served = (url) => {
  const rel = url.slice(B.length);
  if (!(rel in files)) return { url, status: 404, type: 'basic', redirected: false, contentType: 'text/html' };
  return { url, status: 200, type: 'basic', redirected: false, contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(files[rel]) };
};

function setup() {
  const c = newCase(lib, [], { noForms: true });
  const sent = [];
  const state = { ended: false, inFlight: 0, most: 0, delay: 0 };
  const t = {
    c, sent, state,
    fetchPage: async (url, o) => {
      sent.push(url);
      state.inFlight++; state.most = Math.max(state.most, state.inFlight);
      await new Promise((r) => setTimeout(r, state.delay));
      state.inFlight--;
      if (o.signal?.aborted) return { error: 'stopped' };
      return served(url);
    },
    update: async (fn) => { if (state.ended) throw Object.assign(new Error('That case has ended'), { name: 'CaseEnded' }); return fn(c, lib); },
  };
  t.run = (over = {}) => runFetchStep({ step, lib, c, tabUrl: INBOX, access: async () => layers(), fetchPage: t.fetchPage, update: t.update, DOMParser, lists: { r1: hrefsOn() }, ...over });
  return t;
}

test('the inbox’s links: a bare @data-message reads the row’s own attribute, and | abs resolves each href', () => {
  const doc = new JSDOM(files['messages/index.html'], { url: INBOX }).window.document;
  const rows = E.extract(doc, inbox, { baseUrl: INBOX }).data.items;
  assert.equal(rows.length, 25);
  assert.deepEqual(rows.map((r) => r.messageId), [...doc.querySelectorAll('#inbox tbody tr')].map((tr) => tr.dataset.message));
  assert.ok(rows.every((r) => r.href.startsWith(`${B}messages/message/`)));
});

test('a list request expands to the page’s links, in order, deduplicated and capped; bad addresses are refused unsent', () => {
  const page = `${B}messages/index.html`;
  assert.deepEqual(listAddresses(['message/a.html', 'message/a.html#x', 'message/b.html', '', 7, 'message/c.html'], page, 2), [`${B}messages/message/a.html`, `${B}messages/message/b.html`]);
  assert.equal(listAddresses(Array.from({ length: 40 }, (_, i) => `message/m${i}.html`), page, 99).length, FETCH_LIMITS.perList, 'never more than 25');
  const deny = accessLayers({ currentLib: base, hosts: ['localhost:8787'], settings: { siteAccess: { rules: [{ id: 'x', effect: 'deny', pattern: `${B}messages/message/NC-*`, actions: ['fetch-get'] }] } } });
  const items = planList({ request: step.fetch.requests[0], lib, layers: deny, tabUrl: page, hrefs: ['http://elsewhere.example/demo/messages/message/x.html', 'client/NC-1234.html', 'message/NC-1234-1.html', 'message/MSG-123456.html'] });
  assert.deepEqual(items.map((i) => i.problem), ['trigger', 'profile', 'blocked', null]);
  // The library's own rule allows fetching only messages: a list pointed elsewhere is refused by it.
  const elsewhere = planList({ request: { ...step.fetch.requests[0], profileId: 'cm/case' }, lib, layers: layers(), tabUrl: page, hrefs: ['../cm/case-1001.html'] });
  assert.equal(elsewhere[0].problem, 'blocked');
  // A list that couldn't be read is one refusal, not an empty list.
  assert.equal(planList({ request: step.fetch.requests[0], lib, layers: layers(), tabUrl: page, hrefs: null })[0].problem, 'list');
});

test('the triage run: 25 messages as rows, no case values, show picks exactly the 4 planned referrals', async () => {
  const t = setup();
  t.state.delay = 2;
  const out = await t.run();
  assert.equal(out.problem, null);
  assert.equal(t.sent.length, 25);
  assert.ok(t.state.most <= FETCH_LIMITS.parallel && t.state.most === 4, `at most 4 at a time (${t.state.most})`);
  assert.equal(t.c.clips.length, 25);
  assert.ok(t.c.clips.every((cl) => cl.kind === 'fetch' && !Object.keys(cl.values).length && cl.records.length === 1));
  assert.deepEqual(out.identity, []);
  assert.equal(runSummary(out, step), 'Read 25 of 25 messages.');
  const got = shownRows(t.c, step);
  const want = referrals.filter((r) => r.referral?.urgency === 'Urgent' && r.referral.status === 'Open' && files['messages/index.html'].includes(`data-message="${r.id}"`)).map((r) => r.id).sort();
  assert.equal(want.length, REFERRALS.page1.urgentOpen);
  assert.deepEqual(got.matches.map((m) => m.row.messageId).sort(), want);
  assert.deepEqual([got.read, got.others], [25, 21]);
  assert.ok(got.matches.every((m) => /^\d{4}-\d{2}-\d{2}$/.test(m.row.respondBy) && m.row.reason));
  assert.equal(stepStatus(t.c, step), 'done', 'the runner marks the step done');
  // Each page is logged with the profile's pattern, never the address or a value.
  const logged = t.c.log.filter((e) => e.activity === 'fetch_page');
  assert.equal(logged.length, 25);
  assert.ok(logged.every((e) => e.url_pattern === inboxMessage.urlPattern && !/MSG-|NC-|localhost/.test(e.detail)));
  assert.doesNotMatch(JSON.stringify(archiveLog(t.c, 'finished')), /MSG-\d|NC-\d/, 'the kept log has patterns, never an address');
  // Again: the clips are replaced, not added to.
  await t.run();
  assert.equal(t.c.clips.length, 25);
  // A message that has dropped off the page loses its clip.
  const fewer = hrefsOn().slice(1);
  // (Ten minutes later: two full runs are as many as the case's cap allows at once.)
  await t.run({ lists: { r1: fewer }, now: Date.now() + FETCH_LIMITS.windowMs + 1000 });
  assert.equal(t.c.clips.length, 24);
  assert.ok(!t.c.clips.some((cl) => cl.url === hrefsOn()[0]));
});

test('an empty list marks the step done; a list that couldn’t be read doesn’t', async () => {
  const t = setup();
  const out = await t.run({ lists: { r1: [] } });
  assert.equal(out.problem, null);
  assert.deepEqual(t.sent, []);
  assert.equal(stepStatus(t.c, step), 'done');
  const u = setup();
  await u.run({ lists: {} });
  assert.equal(stepStatus(u.c, step), 'todo');
});

test('two full runs fit under the case’s cap; a third inside 10 minutes is refused before any request', async () => {
  const t = setup();
  await t.run();
  await t.run();
  assert.equal(t.sent.length, 50);
  const third = await t.run();
  assert.equal(third.problem, 'cap');
  assert.equal(t.sent.length, 50);
  assert.equal(planRun({ step, lib, c: t.c, layers: layers(), tabUrl: INBOX, lists: { r1: hrefsOn() }, now: Date.now() + FETCH_LIMITS.windowMs + 1000 }).problem, null, 'after 10 minutes it can run again');
});

test('Stop part way leaves the step not done and offers the rest; teardown drops a late result', async () => {
  const t = setup();
  t.state.delay = 5;
  const ctl = new AbortController();
  const running = t.run({ signal: ctl.signal });
  setTimeout(() => ctl.abort(), 8);
  const out = await running;
  assert.equal(out.stopped, true);
  assert.ok(t.c.clips.length < 25);
  assert.equal(stepStatus(t.c, step), 'todo');
  const rest = planRun({ step, lib, c: t.c, layers: layers(), tabUrl: INBOX, lists: { r1: hrefsOn() }, rest: true });
  assert.equal(rest.items.length, 25 - t.c.clips.length, 'Fetch the rest fetches only what isn’t in the case');
  // Teardown: CASE_ENDED makes the next update throw CaseEnded, and the rest of the run is dropped.
  const u = setup();
  u.state.delay = 2;
  setTimeout(() => { u.state.ended = true; }, 3);
  const ended = await u.run();
  assert.equal(ended.ended, true);
  assert.ok(u.c.clips.length < 25);
  assert.equal(stepStatus(u.c, step), 'todo');
});

test('validateSteps: a list over 25, required, a second list, or a show that isn’t exact matches is refused', () => {
  const doc = (f) => ({ schema: 'powerloader-steps/1', steps: [{ ...step, fetch: { ...step.fetch, ...f } }] });
  assert.deepEqual(validateSteps(doc({})), []);
  const req = step.fetch.requests[0];
  assert.match(validateSteps(doc({ requests: [{ ...req, each: { ...req.each, max: 26 } }] })).join(' '), /from 1 to 25/);
  assert.match(validateSteps(doc({ requests: [{ ...req, required: true }] })).join(' '), /can’t be required/);
  assert.match(validateSteps(doc({ requests: [req, { ...req, id: 'r2' }] })).join(' '), /at most one list/);
  assert.match(validateSteps(doc({ show: { ...SHOW, where: { urgency: { $ne: 'Routine' } } } })).join(' '), /exact matches only/);
  assert.match(validateSteps(doc({ requests: [{ ...req, url: `${B}x` }] })).join(' '), /has no "url"/);
});

// A flow made in the editor: a fetch step on the inbox, its list's page and the page each link opens.
const draftOf = (profile) => ({ id: `d-${profile.id.replace(/\W/g, '')}`, kind: 'extract', base: null, from: 'you', profile: structuredClone(profile), tested: null });
function triageFlow() {
  const flow = newFlow({ name: 'Inbox triage' });
  const s = addPage(flow, 'fetch');
  Object.assign(s, { name: 'Team inbox', url: INBOX, match: `${B}messages/index*` });
  const { request, page, listPage } = addListRequest(flow, s.id, { name: 'Messages', max: 25 });
  listPage.draft = draftOf(inbox);
  page.draft = draftOf(inboxMessage);
  setRequest(flow, s.id, request.id, { list: 'items' });
  setShow(s, SHOW);
  for (const p of [...pagesOf(flow, 'output'), ...pagesOf(flow, 'input').filter((x) => !x.parent)]) removePage(flow, p.id);
  flow.journey = [s.id];
  return flow;
}

test('a flow with a list request and no form starts a case with no forms; a flow with neither is refused', () => {
  const flow = triageFlow();
  assert.equal(pagesOf(flow, 'output').length, 0);
  const errors = validateFlow(flow).filter((i) => i.level === 'error' && !/tested/.test(i.text));
  assert.deepEqual(errors.map((i) => i.text), []);
  const can = startable(flow);
  assert.deepEqual([can.ok, can.noForms, can.formIds], [true, true, []]);
  assert.equal(startable(flow, { access: layers() }).ok, true, 'no form isn’t “every form blocked by the site rules”');
  assert.deepEqual(can.fetches, [{ name: 'Team inbox', hosts: ['localhost:8787'] }]);
  const c = newCase({ forms: {}, commit: 'x' }, [], { noForms: true });
  assert.deepEqual(c.forms, []);
  assert.throws(() => newCase(lib, []), /at least one form/, 'a case of a flow with a form still needs one');
  const none = newFlow({ name: 'Nothing' });
  removePage(none, pagesOf(none, 'output')[0].id === undefined ? '' : 'none');
  assert.throws(() => removePage(none, pagesOf(none, 'output')[0].id), /at least one form to fill/);
  none.pages = none.pages.filter((p) => p.role !== 'output');
  assert.equal(startable(none).ok, false);
});

test('export and import keep the list request, its two pages and the show, remapped', () => {
  const flow = triageFlow();
  const back = importFlow(JSON.parse(JSON.stringify(exportFlow(flow))));
  assert.equal(pagesOf(back, 'output').length, 0, 'no empty form is added on import');
  const s = pagesOf(back, 'fetch')[0];
  const [r] = requestsOf(s);
  assert.ok(r.each && r.required === false);
  const list = back.pages.find((p) => p.id === r.each.pageId);
  const child = back.pages.find((p) => p.id === r.pageId);
  assert.ok(list && child && list.parent === s.id && child.parent === s.id, 'each.pageId follows its page');
  assert.notEqual(r.each.pageId, requestsOf(pagesOf(flow, 'fetch')[0])[0].each.pageId);
  assert.deepEqual(s.fetch.show, SHOW);
});

test('markers: only on the inbox rows a run picked, with the flow’s fixed text; none when the rules block notes', async () => {
  const { markersForPage } = await import('../../extension/lib/annotations.js');
  const { agentOnDom } = await import('./helpers/agent.js');
  const { checkAccess, messageActions } = await import('../../extension/lib/core.js');
  const t = setup();
  await t.run();
  const mark = { row: '#inbox tbody tr', key: 'messageId', rowKey: '@data-message', text: 'Urgent, open' };
  const got = shownRows(t.c, step);
  const notes = markersForPage(mark, got.matches);
  assert.equal(notes.length, 4);
  assert.ok(notes.every((n) => n.type === 'marker' && n.nodes.join('') === 'Urgent, open'));
  assert.deepEqual(markersForPage({ ...mark, rowKey: 'data message' }, got.matches), [], 'an attribute that isn’t one gives none');
  assert.equal(markersForPage(mark, Array.from({ length: 30 }, (_, i) => ({ row: { messageId: `MSG-${i}` } }))).length, 20, 'at most 20');
  // In the page: the agent draws each in the first cell of the row whose data-message matches, and nowhere else.
  const a = agentOnDom(new JSDOM(files['messages/index.html'], { url: INBOX, runScripts: 'outside-only' }));
  const out = await a.ask({ type: 'powerloader:annotate', notes });
  assert.equal(out.shown.length, 4);
  const marked = [...a.doc.querySelectorAll('#inbox tbody tr')].filter((tr) => tr.querySelector('powerloader-note')).map((tr) => tr.dataset.message).sort();
  assert.deepEqual(marked, got.matches.map((m) => m.row.messageId).sort());
  assert.ok([...a.doc.querySelectorAll('powerloader-note')].every((n) => n.parentElement.localName === 'td'));
  assert.doesNotMatch(a.doc.body.innerHTML.replace(/data-message="[^"]*"/g, ''), /Urgent, open/, 'the text is in a closed shadow root, not the page’s own markup');
  // Cleared when the case ends (and so the page's watcher stops).
  await a.ask({ type: 'powerloader:clearNotes' });
  assert.equal(a.doc.querySelectorAll('powerloader-note').length, 0);
  a.w.close();
  // A page the site rules block for notes gets none: the message is checked as annotate before it is sent.
  assert.deepEqual(messageActions('powerloader:annotate'), ['annotate']);
  const noNotes = accessLayers({ hosts: ['localhost:8787'], settings: { siteAccess: { rules: [{ id: 'n', effect: 'deny', pattern: `${B}messages/*`, actions: ['annotate'] }] } } });
  assert.throws(() => checkAccess(noNotes, INBOX, messageActions('powerloader:annotate')), (e) => e.name === 'Blocked');
});

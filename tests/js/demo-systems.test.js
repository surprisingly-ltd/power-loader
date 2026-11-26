// The demo's synthetic casework systems (tools/build-demo-systems.mjs): generated from a fixed seed, read by the
// demo library's profiles, the messages read by a fetch step (with fetch stubbed against the generated files)
// and as JSON, the library's site rule that lets only the messages service be fetched, done-marking kept in
// the browser only, and the demo flow that ties them together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import '../../extension/lib/extract.js';
import '../../extension/lib/json-dom.js';
import { demoLibrary } from './helpers/library.js';
import { addClip, clipFromExtract, fieldState, newCase } from '../../extension/lib/case.js';
import { accessLayers, allowed } from '../../extension/lib/access.js';
import { planRun, runFetchStep, runSummary } from '../../extension/lib/fetch-steps.js';
import { exportFlow, importFlow, pagesOf, requestsOf, validateFlow } from '../../extension/lib/flows.js';
import { CASE_COUNT, FIRST_CASE, MESSAGES_PER_CLIENT, PAGE_SIZE, QUIRKS, REFERRALS, SEED, buildData, buildReferrals, trainingExamples, buildFiles, demoRoot, digest, ensureSystems, fictionProblems, inboxRows } from '../../tools/build-demo-systems.mjs';
import { casesDigest, readSample } from '../../tools/record-demo-values.mjs';
import { DEMO_FLOWS, makeDemoFlow } from '../../tools/build-demo-flows.mjs';
import { serveDemo } from '../../tools/serve-demo.mjs';
import { buildManifest, root as libraryRoot } from '../../tools/build-demo-library.mjs';
import { indexLibrary, pageProfiles } from '../../extension/lib/library.js';
import { caseVars, emailFor, markStep, stepStatus } from '../../extension/lib/journey.js';

const E = globalThis.PowerLoaderExtract;
const J = globalThis.PowerLoaderJson;
const B = 'http://localhost:8787/demo/';
const cases = buildData();
const referrals = buildReferrals(cases);
const files = buildFiles(cases, referrals);
const lib = demoLibrary();
const { DOMParser } = new JSDOM('').window;
const caseOf = (no) => cases.find((c) => c.no === no);
const profile = (id) => lib.profiles.find((p) => p.id === id);

function read(rel, profileId) {
  const url = `${B}${rel}`;
  const doc = new JSDOM(files[rel], { url }).window.document;
  const p = profile(profileId);
  assert.ok(E.profileApplies(p, url, doc), `${profileId} applies to ${rel}`);
  return { ...E.extract(doc, p, { baseUrl: url }), url, title: doc.title, profile: p };
}
const clip = (c, rel, profileId) => { const r = read(rel, profileId); return addClip(c, lib, clipFromExtract(lib, r.profile, r)); };
const value = (c, key) => fieldState(c, lib, key).value;
// Money is kept as text in the case ("93.07").
const money = (c, key) => (value(c, key) == null ? undefined : Number(value(c, key)));
const withChange = (kind) => cases.filter((c) => c.change?.kind === kind && !Object.values(QUIRKS).flat().includes(c.no));

test('the generator is deterministic: the same seed gives the same files, another seed other people', () => {
  assert.equal(digest(buildFiles(buildData())), digest(files));
  assert.notEqual(digest(buildFiles(buildData(SEED + 1))), digest(files));
  assert.equal(cases.length, CASE_COUNT);
  assert.deepEqual(cases.map((c) => c.no), Array.from({ length: CASE_COUNT }, (_, i) => FIRST_CASE + i));
  // 4 queue pages and Case Manager's home; the intranet's two pages; 4 pages each of income records, tenancies and clients; the team
  // inbox's pages; per case a case and notes page, an income record, a rent account, a messages overview
  // and its data, and six messages; and a page per referral and enquiry.
  const lists = Math.ceil(CASE_COUNT / PAGE_SIZE);
  const inboxPages = Math.ceil(inboxRows(cases).length / PAGE_SIZE);
  assert.equal(Object.keys(files).length, 4 + 1 + 2 + 3 * lists + inboxPages + CASE_COUNT * (6 + MESSAGES_PER_CLIENT) + REFERRALS.count + REFERRALS.enquiries);
  assert.equal(new Set(cases.map((c) => c.clientId)).size, CASE_COUNT);
  assert.ok(withChange('income').length > 20 && withChange('moving').length > 3 && cases.some((c) => !c.change), 'changes vary');
});

test('the data is fictional: QQ NI numbers, drama-range phones, example emails, NS postcodes, no outside links', () => {
  assert.deepEqual(fictionProblems(cases, files), []);
  for (const c of cases) {
    assert.match(c.person.nino, /^QQ\d{6}[A-D]$/);
    assert.match(c.person.phone, /^07700 900\d{3}$/);
    assert.match(c.person.email, /@example\.(org|com)$/);
    assert.match(c.person.address.postcode, /^NS\d \d[A-Z]{2}$/);
  }
  for (const [rel, text] of Object.entries(files)) if (rel.endsWith('.html')) assert.match(text, /<head>/, `${rel}: build-site adds noindex after <head>`);
});

test('the existing cases, records, tenancies and messages are as they were: the recorded values and the whole data', () => {
  const recorded = JSON.parse(readFileSync(new URL('./fixtures/demo-values.json', import.meta.url), 'utf8'));
  assert.equal(casesDigest(cases), recorded.casesDigest, 'buildData() gives the same 100 cases as before');
  const now = readSample(files, cases, lib);
  assert.deepEqual(Object.keys(now), Object.keys(recorded.pages));
  for (const rel of Object.keys(recorded.pages)) assert.deepEqual(now[rel], recorded.pages[rel], rel);
});

const hrefs = (text) => [...text.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)].map((m) => m[1].replaceAll('&amp;', '&'));

test('each system has a homepage, and every link on every generated page goes to a page that exists', () => {
  for (const sys of ['cm', 'biv', 'harbour', 'messages', 'intranet']) {
    assert.ok(`${sys}/index.html` in files, `${sys} has a homepage`);
    for (const [rel, text] of Object.entries(files)) {
      if (!rel.startsWith(`${sys}/`) || !rel.endsWith('.html')) continue;
      const header = text.slice(text.indexOf('<header'), text.indexOf('</header>'));
      const links = hrefs(header);
      assert.equal(new URL(links[0], `${B}${rel}`).href, `${B}${sys}/index.html`, `${rel}: the system name goes home`);
      assert.equal(new URL(links[1], `${B}${rel}`).href, `${B}${sys}/index.html`, `${rel}: the first nav item is the homepage`);
    }
  }
  assert.ok('cm/queue.html' in files, 'the work queue keeps its address');
  for (const [rel, text] of Object.entries(files)) {
    if (!rel.endsWith('.html')) continue;
    for (const href of hrefs(text)) {
      assert.notEqual(href, '#', `${rel} has a dead link`);
      const u = new URL(href, `${B}${rel}`);
      assert.ok(u.href.startsWith(B), `${rel}: ${href} stays on the demo`);
      const target = decodeURIComponent(u.pathname.slice(new URL(B).pathname.length));
      assert.ok(target in files || existsSync(path.join(demoRoot, target)), `${rel}: ${href} goes to a page that exists`);
    }
  }
  // The client messages page's breadcrumb goes to the list of clients, which counts each client's messages.
  const c = caseOf(1001);
  assert.match(files[`messages/client/${c.clientId}.html`], /<a href="\.\.\/clients\.html">Clients<\/a>/);
  const listed = Object.entries(files).filter(([k]) => /^messages\/clients(-\d)?\.html$/.test(k)).map(([, v]) => v).join('');
  assert.equal((listed.match(/href="client\/NC-\d+\.html"/g) || []).length, CASE_COUNT);
  // Every income record and tenancy is listed once on its system's home pages.
  const all = (re) => Object.entries(files).filter(([k]) => re.test(k)).map(([, v]) => v).join('');
  assert.equal((all(/^biv\/index(-\d)?\.html$/).match(/href="income-NC-\d+\.html"/g) || []).length, CASE_COUNT);
  assert.equal((all(/^harbour\/index(-\d)?\.html$/).match(/href="tenancy-HH-\d+\.html"/g) || []).length, CASE_COUNT);
});

const kindOf = new Map(referrals.map((r) => [r.id, r]));
const isUrgentOpen = (r) => r?.referral?.urgency === 'Urgent' && r.referral.status === 'Open';

test('referrals: 40 across 32 clients in the planned mix, and 20 enquiries that look the same in the inbox', () => {
  const refs = referrals.filter((r) => r.kind === 'referral');
  const enquiries = referrals.filter((r) => r.kind === 'enquiry');
  assert.equal(refs.length, REFERRALS.count);
  assert.equal(enquiries.length, REFERRALS.enquiries);
  assert.equal(new Set(refs.map((r) => r.clientId)).size, REFERRALS.clients);
  const mix = (u, open) => refs.filter((r) => r.referral.urgency === u && (r.referral.status === 'Open') === open).length;
  assert.deepEqual([mix('Urgent', true), mix('Urgent', false), mix('Routine', true), mix('Routine', false)], [12, 6, 10, 12]);
  // No two messages share an ID, and the existing ones keep theirs.
  const ids = [...cases.flatMap((c) => c.messages.map((m) => m.id)), ...referrals.map((r) => r.id)];
  assert.equal(new Set(ids).size, ids.length);
  // The subject, sender and type don't say which is a referral, and the type is one existing messages use.
  const types = new Set(cases.flatMap((c) => c.messages.map((m) => m.type)));
  for (const r of referrals) {
    assert.equal(r.subject, 'Referral received');
    assert.ok(types.has(r.type), r.type);
    const page = files[`messages/message/${r.id}.html`];
    assert.equal(/id="referral"/.test(page), r.kind === 'referral', `${r.id}: only a referral has the #referral section`);
  }
  // Urgent ones must be answered in 2 working days, routine ones in 10.
  for (const r of refs) assert.ok(r.referral.respondBy > r.received.slice(0, 10));
});

test('the team inbox: page 1 has exactly 4 urgent open referrals, 2 urgent decoys, 2 routine open ones and the enquiries', () => {
  const rows = inboxRows(cases, referrals);
  const doc = new JSDOM(files['messages/index.html'], { url: `${B}messages/index.html` }).window.document;
  const trs = [...doc.querySelectorAll('#inbox tbody tr')];
  assert.equal(trs.length, PAGE_SIZE);
  assert.deepEqual(trs.map((tr) => tr.dataset.message), rows.slice(0, PAGE_SIZE).map((r) => r.id));
  const on1 = trs.map((tr) => kindOf.get(tr.dataset.message));
  assert.equal(on1.filter(isUrgentOpen).length, 4);
  assert.equal(on1.filter((r) => r?.referral?.urgency === 'Urgent' && r.referral.status !== 'Open').length, 2);
  assert.equal(on1.filter((r) => r?.referral?.urgency === 'Routine' && r.referral.status === 'Open').length, 2);
  assert.ok(on1.filter((r) => r?.kind === 'enquiry').length >= 3);
  // The named cases' urgent referrals are among them, due a day or two after the demo's today.
  const named = REFERRALS.urgentOnPage1.map((u) => caseOf(u.case).clientId);
  assert.deepEqual(named.filter((id) => on1.some((r) => isUrgentOpen(r) && r.clientId === id)), named);
  for (const r of on1.filter(isUrgentOpen)) assert.ok(['2026-11-26', '2026-11-27'].includes(r.referral.respondBy), r.referral.respondBy);
  // In the list, a referral's row and address look like an enquiry's: the same subject, type and kind of link.
  const cells = (tr) => [...tr.cells].map((td) => td.textContent);
  for (const tr of trs.filter((t) => kindOf.has(t.dataset.message))) {
    const [, , , subject, type] = cells(tr);
    assert.deepEqual([subject, type], ['Referral received', 'Email']);
    assert.match(tr.querySelector('a').getAttribute('href'), /^message\/MSG-\d{6}\.html$/);
  }
  for (const tr of trs.filter((t) => !kindOf.has(t.dataset.message))) assert.match(tr.querySelector('a').getAttribute('href'), /^message\/NC-\d+-\d\.html$/);
  assert.match(doc.querySelector('#team-inbox p').textContent, /Open a message to see what it is and whether anyone has picked it up/);
  // Every page of the inbox, newest first, back 28 days.
  const pages = Object.keys(files).filter((k) => /^messages\/index(-\d+)?\.html$/.test(k));
  assert.equal(pages.length, Math.ceil(rows.length / PAGE_SIZE));
  assert.ok(rows.every((r) => r.received >= '2026-10-28'));
});

test('a client with referrals has a second table, and their JSON a referrals array; the six messages are as they were', () => {
  const r = referrals.find((x) => x.kind === 'referral');
  const page = files[`messages/client/${r.clientId}.html`];
  const doc = new JSDOM(page, { url: `${B}messages/client/${r.clientId}.html` }).window.document;
  assert.equal(doc.querySelectorAll('#messages tbody tr').length, MESSAGES_PER_CLIENT);
  const other = [...doc.querySelectorAll('#other-messages tbody tr')];
  assert.ok(other.some((tr) => tr.querySelector('a').getAttribute('href') === `../message/${r.id}.html`));
  assert.ok(other.every((tr) => !/Urgent|Routine|Open|Accepted|Closed/.test(tr.textContent)), 'the table gives nothing away');
  const json = JSON.parse(files[`messages/api/${r.clientId}.json`]);
  assert.ok(json.referrals.some((x) => x.id === r.id && x.urgency === r.referral.urgency && x.referralStatus === r.referral.status));
  assert.equal(json.messages.length, MESSAGES_PER_CLIENT);
  const plain = cases.find((c) => !referrals.some((x) => x.clientId === c.clientId));
  assert.doesNotMatch(files[`messages/client/${plain.clientId}.html`], /From other organisations/);
  // Nothing has attachments yet, so no page draws the section.
  assert.ok(Object.values(files).every((t) => !/id="attachments"/.test(t)));
  assert.ok(cases.every((c) => c.messages.every((m) => Array.isArray(m.attachments) && !m.attachments.length)));
});

test('the intranet’s rent support review procedure: the council’s own words, every branch with a real example', () => {
  const rel = 'intranet/rent-support-review.html';
  assert.ok(rel in files && 'intranet/index.html' in files);
  const text = files[rel];
  const doc = new JSDOM(text, { url: `${B}${rel}` }).window.document;
  assert.doesNotMatch(text, /<script/i, 'no script: details and anchors need none');
  assert.doesNotMatch(text, /Power Loader|\bclip|\bfetch|extension/i, 'it belongs to the council, not to Power Loader');
  // Every in-page link goes to an id on the page; the other links were checked with every page above.
  for (const a of doc.querySelectorAll('a[href^="#"]')) assert.ok(doc.getElementById(a.getAttribute('href').slice(1)), a.getAttribute('href'));
  assert.ok(doc.querySelectorAll('section.step').length >= 10);
  assert.ok(doc.querySelector('#decisions tbody tr'), 'a decision summary near the top');
  assert.ok(doc.querySelector('#checklist li') && /Started at/.test(doc.getElementById('checklist').textContent));
  // Linked from Case Manager's home and from every case page.
  assert.match(files['cm/index.html'], /href="\.\.\/intranet\/index\.html">Procedures</);
  assert.match(files['cm/case-1042.html'] ?? files['cm/case-1001.html'], /href="\.\.\/intranet\/rent-support-review\.html"/);
  // Each training example has what its part is about, checked again from the data.
  const quirk = {
    'A different address': (c) => QUIRKS.address.includes(c.no),
    'A different spelling': (c) => QUIRKS.spelling.includes(c.no),
    'What it looks like': (c) => QUIRKS.otherPerson.includes(c.no),
    'When this happens': (c) => QUIRKS.noTenancyRef.includes(c.no),
    'A change of income': (c) => c.change?.kind === 'income',
    'A move': (c) => c.change?.kind === 'moving',
    'No change reported': (c) => !c.change,
    'Arrears or none': (c) => c.tenancy.arrears > 0,
    'Urgent referrals in the team inbox': (c) => referrals.some((r) => isUrgentOpen(r) && r.clientId === c.clientId),
  };
  const seen = new Set();
  for (const d of doc.querySelectorAll('details')) {
    const summary = d.querySelector('summary').textContent;
    const nos = [...d.querySelectorAll('a[href^="../cm/case-"]')].map((a) => Number(a.getAttribute('href').match(/case-(\d+)/)[1]));
    if (!nos.length) continue;
    assert.ok(quirk[summary], `a check for “${summary}”`);
    for (const no of nos) assert.ok(quirk[summary](caseOf(no)), `case ${no} has “${summary}”`);
    seen.add(summary);
  }
  assert.deepEqual([...seen].sort(), Object.keys(quirk).sort(), 'every planned quirk and branch has its part');
  assert.equal(trainingExamples(cases).otherPerson, QUIRKS.otherPerson[0]);
  // The email to a client without a reference is the template the demo flow sends.
  assert.match(doc.getElementById('ask-for-reference').textContent, /Harbour Homes tenancy reference/);
});

test('Case Manager’s home offers the next case and the oldest five not done, from this browser’s marks', () => {
  const script = readFileSync(new URL('../../demo/assets/casework.js', import.meta.url), 'utf8');
  const dom = new JSDOM(files['cm/index.html'], { url: `${B}cm/index.html`, runScripts: 'outside-only' });
  dom.window.localStorage.setItem('powerloader-demo-done', JSON.stringify({ 1001: '2026-11-25', 1003: '2026-11-25' }));
  dom.window.eval(script);
  const d = dom.window.document;
  assert.match(d.getElementById('next-case').textContent, /HSG\/2026\/1002/);
  assert.deepEqual([...d.querySelectorAll('#oldest-cases tr[data-case]')].filter((tr) => !tr.hidden).map((tr) => tr.dataset.case), ['1002', '1004', '1005', '1006', '1007']);
  const statusTotal = [...d.querySelectorAll('#by-status td.num')].reduce((n, td) => n + Number(td.textContent), 0);
  assert.equal(statusTotal, CASE_COUNT);
});

test('each profile reads the generated pages of several cases', () => {
  for (const c of [caseOf(1001), caseOf(1002), caseOf(1050), caseOf(1100)]) {
    const p = c.person;
    const cm = read(`cm/case-${c.no}.html`, 'cm/case').data;
    assert.deepEqual([cm.clientId, cm.firstName, cm.lastName, cm.tenancyRef, cm.postcode, cm.landlord], [c.clientId, p.firstName, p.lastName, c.tenancy.ref, p.address.postcode, 'Harbour Homes Ltd']);
    assert.equal(cm.dob, p.dob);
    const hh = read(`harbour/tenancy-${c.tenancy.ref}.html`, 'harbour-homes/tenancy').data;
    assert.deepEqual([hh.tenancyRef, hh.monthlyRent, hh.arrears, hh.tenancyStart], [c.tenancy.ref, c.tenancy.rent, c.tenancy.arrears, c.tenancy.start]);
    assert.equal(hh.payments.length, c.tenancy.payments.length);
    const biv = read(`biv/income-${c.clientId}.html`, 'biv/income').data;
    assert.deepEqual([biv.clientId, biv.weeklyIncome, biv.dob], [c.clientId, c.income.weekly, c.biv.dob]);
    assert.equal(biv.periods.length, c.income.periods.length);
    const notes = read(`cm/notes-${c.no}.html`, 'cm/notes').data;
    assert.equal(notes.notes.length, c.notes.length);
  }
  // A message with the change has its fields; the others have none.
  const c = withChange('income')[0];
  const at = c.messages.find((m) => m.form?.name === 'Tell us about a change');
  const got = read(`messages/message/${c.clientId}-${at.n}.html`, 'messages/message').data;
  assert.deepEqual([got.clientId, got.changeEffectiveDate, got.newWeeklyIncome], [c.clientId, c.change.effective, c.change.weekly]);
  const other = c.messages.find((m) => m !== at);
  const none = read(`messages/message/${c.clientId}-${other.n}.html`, 'messages/message').data;
  assert.equal(none.clientId, c.clientId);
  assert.ok(!none.changeEffectiveDate && !none.newWeeklyIncome && !none.tenancyEndDate);
});

test('the planned quirks show as a conflict, a different spelling and a different person', () => {
  const start = (no) => { const c = newCase(lib, ['rsr'], { ref: String(no) }); clip(c, `cm/case-${no}.html`, 'cm/case'); return c; };
  const clean = start(1001);
  const s = clip(clean, `harbour/tenancy-${caseOf(1001).tenancy.ref}.html`, 'harbour-homes/tenancy');
  assert.deepEqual([s.conflicts, s.identity], [[], []]);
  assert.deepEqual(clip(clean, `biv/income-${caseOf(1001).clientId}.html`, 'biv/income').identity, []);
  const moved = start(QUIRKS.address[0]);
  assert.deepEqual(clip(moved, `harbour/tenancy-${caseOf(QUIRKS.address[0]).tenancy.ref}.html`, 'harbour-homes/tenancy').conflicts.sort(), ['address', 'postcode']);
  const spelt = start(QUIRKS.spelling[0]);
  const sp = clip(spelt, `biv/income-${caseOf(QUIRKS.spelling[0]).clientId}.html`, 'biv/income');
  assert.deepEqual([sp.conflicts, sp.identity], [['lastName'], []], 'one weak mismatch is a conflict, not another person');
  const other = start(QUIRKS.otherPerson[0]);
  const op = clip(other, `biv/income-${caseOf(QUIRKS.otherPerson[0]).clientId}.html`, 'biv/income');
  assert.ok(op.identity.includes('nino') && op.identity.includes('dob'), 'a reused reference: this may be a different person');
});

// The fetch step from the client's messages, as the demo flow has it, against the library's own site rules.
const fetchStep = (clientIdTemplate = '{clientId}', target = (n) => `messages/message/${clientIdTemplate}-${n}.html`, profileId = 'messages/message') => ({
  id: 'p-messages', name: 'Customer messages', role: 'fetch', text: '', links: [], url: `${B}messages/client/{clientId}.html`, match: [`${B}messages/client/*`],
  fetch: { requests: Array.from({ length: MESSAGES_PER_CLIENT }, (_, i) => ({ id: `r${i + 1}`, name: `Message ${i + 1}`, url: `${B}${target(i + 1)}`, method: 'GET', profileId, required: true })) },
});
const layers = () => accessLayers({ currentLib: lib, hosts: ['localhost:8787'] });
const served = (url) => {
  const rel = url.slice(B.length);
  if (!(rel in files)) return { url, status: 404, type: 'basic', redirected: false, contentType: 'text/html' };
  return { url, status: 200, type: 'basic', redirected: false, contentType: rel.endsWith('.json') ? 'application/json' : 'text/html; charset=utf-8', bytes: new TextEncoder().encode(files[rel]) };
};

test('the fetch step reads all six messages and clips the change only from the message that has it', async () => {
  for (const c of [withChange('income')[0], withChange('income')[5], withChange('moving')[0], cases.find((x) => !x.change)]) {
    const kase = newCase(lib, ['rsr'], { ref: String(c.no) });
    clip(kase, `cm/case-${c.no}.html`, 'cm/case');
    const step = fetchStep();
    const sent = [];
    const tabUrl = `${B}messages/client/${c.clientId}.html`;
    const out = await runFetchStep({
      step, lib: { ...lib, steps: [step] }, c: kase, tabUrl, access: async () => layers(), DOMParser,
      fetchPage: async (url, o) => { sent.push({ url, accept: o.accept }); return served(url); }, update: async (fn) => fn(kase, lib),
    });
    assert.equal(sent.length, MESSAGES_PER_CLIENT);
    assert.ok(sent.every((s) => s.url.startsWith(`${B}messages/message/${c.clientId}-`)));
    assert.ok(Object.values(out.states).every((s) => s.state === 'done'), runSummary(out));
    assert.deepEqual(out.identity, []);
    assert.equal(out.conflicts, 0);
    const fetched = kase.clips.filter((x) => x.kind === 'fetch');
    assert.equal(fetched.length, MESSAGES_PER_CLIENT);
    const withValues = fetched.filter((x) => 'changeEffectiveDate' in x.values);
    assert.equal(withValues.length, c.change ? 1 : 0, `case ${c.no}`);
    assert.equal(value(kase, 'changeEffectiveDate'), c.change?.effective);
    assert.equal(money(kase, 'newWeeklyIncome'), c.change?.kind === 'income' ? c.change.weekly : undefined);
    assert.equal(value(kase, 'tenancyEndDate'), c.change?.kind === 'moving' ? c.change.tenancyEnd : undefined);
  }
});

test('the messages as JSON: parsed by json-dom.js, read by the data profile to the same values', async () => {
  for (const c of [withChange('income')[1], withChange('moving')[1], cases.find((x) => !x.change)]) {
    const rel = `messages/api/${c.clientId}.json`;
    const doc = J.readJson(new TextEncoder().encode(files[rel]), { contentType: 'application/json', documentSource: new DOMParser().parseFromString('', 'text/html') }).doc;
    const p = profile('messages/messages-data');
    assert.equal(p.format, 'json');
    assert.ok(E.profileApplies(p, `${B}${rel}`, doc));
    const got = E.extract(doc, p, { baseUrl: `${B}${rel}` }).data;
    assert.equal(got.clientId, c.clientId);
    assert.equal(got.messages.length, MESSAGES_PER_CLIENT);
    assert.equal(got.changeEffectiveDate ?? undefined, c.change?.effective);
    assert.equal(got.newWeeklyIncome ?? undefined, c.change?.kind === 'income' ? c.change.weekly : undefined);
    assert.equal(got.tenancyEndDate ?? undefined, c.change?.kind === 'moving' ? c.change.tenancyEnd : undefined);
  }
  // And as a one-request fetch step.
  const c = withChange('income')[2];
  const kase = newCase(lib, ['rsr'], { ref: String(c.no) });
  clip(kase, `cm/case-${c.no}.html`, 'cm/case');
  const step = { ...fetchStep(), fetch: { requests: [{ id: 'r1', name: 'Messages (data)', url: `${B}messages/api/{clientId}.json`, method: 'GET', profileId: 'messages/messages-data', required: true }] } };
  const out = await runFetchStep({ step, lib, c: kase, tabUrl: `${B}messages/client/${c.clientId}.html`, access: async () => layers(), DOMParser, fetchPage: async (url) => served(url), update: async (fn) => fn(kase, lib) });
  assert.equal(out.states.r1.state, 'done', runSummary(out));
  assert.equal(money(kase, 'newWeeklyIncome'), c.change.weekly);
});

test('the demo library lets fetch steps read only the messages service; everything else on the demo still works', async () => {
  assert.equal(lib.access.locked.length, 2);
  assert.ok(lib.access.locked.every((r) => r.effect === 'allow' && r.actions.join() === 'fetch-get' && r.note));
  const L = layers();
  const c = caseOf(1001);
  for (const rel of [`messages/message/${c.clientId}-1.html`, `messages/api/${c.clientId}.json`]) {
    assert.equal(allowed(L, `${B}${rel}`, 'fetch-get').ok, true, rel);
    assert.equal(allowed(L, `${B}${rel}`, 'fetch-post').ok, false, 'fetch-post stays closed');
  }
  for (const rel of [`biv/income-${c.clientId}.html`, `cm/case-${c.no}.html`, `harbour/tenancy-${c.tenancy.ref}.html`, `messages/client/${c.clientId}.html`, 'client-1042.html', 'employment-1042.html']) {
    const v = allowed(L, `${B}${rel}`, 'fetch-get');
    assert.deepEqual([v.ok, v.rule?.layer], [false, 'library'], `${rel}: refused by the library's rule`);
    for (const action of ['navigate', 'read', 'fill', 'annotate', 'capture']) assert.equal(allowed(L, `${B}${rel}`, action).ok, true, `${rel}: ${action}`);
  }
  assert.equal(allowed(L, `${B}rent-review.html`, 'fill').ok, true);
  // A fetch step pointed at another system is refused before anything is sent.
  const elsewhere = fetchStep('{clientId}', () => 'biv/income-{clientId}.html', 'biv/income');
  elsewhere.fetch.requests = elsewhere.fetch.requests.slice(0, 1);
  const kase = newCase(lib, ['rsr'], { ref: '1001' });
  clip(kase, 'cm/case-1001.html', 'cm/case');
  const tabUrl = `${B}messages/client/${c.clientId}.html`;
  assert.equal(planRun({ step: elsewhere, lib, c: kase, layers: L, tabUrl }).items[0].problem, 'blocked');
  assert.equal(planRun({ step: fetchStep(), lib, c: kase, layers: L, tabUrl }).items.every((i) => !i.problem), true);
  const sent = [];
  const out = await runFetchStep({ step: elsewhere, lib, c: kase, tabUrl, access: async () => L, DOMParser, fetchPage: async (url) => { sent.push(url); return served(url); }, update: async (fn) => fn(kase, lib) });
  assert.deepEqual(sent, []);
  assert.equal(out.states.r1.code, 'blocked');
});

test('done-marking is client-side only: the pages are static, the script keeps it in localStorage', () => {
  const script = readFileSync(new URL('../../demo/assets/casework.js', import.meta.url), 'utf8');
  assert.doesNotMatch(script, /fetch\(|XMLHttpRequest|sendBeacon|document\.cookie|WebSocket|\.submit\(/);
  for (const [rel, text] of Object.entries(files)) {
    assert.doesNotMatch(text, /tag done|<form[^>]*method="post"/i, `${rel} carries no done state and posts nothing`);
    if (/<script/.test(text)) assert.ok(rel.startsWith('cm/queue') || rel.startsWith('cm/case-') || rel === 'cm/index.html' || rel.startsWith('harbour/tenancy-'), `${rel} has a script`);
  }
  const open = (rel, storage = {}) => {
    const dom = new JSDOM(files[rel], { url: `${B}${rel}`, runScripts: 'outside-only' });
    for (const [k, v] of Object.entries(storage)) dom.window.localStorage.setItem(k, v);
    dom.window.eval(script);
    return dom.window;
  };
  const store = (w) => Object.fromEntries(Object.keys(w.localStorage).map((k) => [k, w.localStorage.getItem(k)]));
  // The queue offers the first case; the case page marks it done; the queue then shows it done and offers the next.
  let w = open('cm/queue.html');
  assert.match(w.document.getElementById('next-case').textContent, /HSG\/2026\/1001/);
  w = open('cm/case-1001.html');
  w.document.getElementById('mark-done').click();
  assert.match(w.document.getElementById('done-message').textContent, /Next case: HSG\/2026\/1002/);
  assert.match(w.document.querySelector('#case-header .status').textContent, /Done/);
  const kept = store(w);
  assert.deepEqual(Object.keys(JSON.parse(kept['powerloader-demo-done'])), ['1001']);
  w = open('cm/queue.html', kept);
  assert.match(w.document.querySelector('tr[data-case="1001"] .status').textContent, /Done/);
  assert.match(w.document.getElementById('next-case').textContent, /HSG\/2026\/1002/);
  // The record itself didn't change: the case page still reads the same values.
  assert.equal(read('cm/case-1001.html', 'cm/case').data.clientId, caseOf(1001).clientId);
  // Reset the demo clears this browser's marks.
  const dom = new JSDOM(files['cm/queue.html'], { url: `${B}cm/queue.html?reset`, runScripts: 'outside-only' });
  for (const [k, v] of Object.entries(kept)) dom.window.localStorage.setItem(k, v);
  dom.window.eval(script);
  assert.equal(dom.window.localStorage.getItem('powerloader-demo-done'), null);
  assert.doesNotMatch(dom.window.document.querySelector('tr[data-case="1001"] .status').textContent, /Done/);
});

test('the rent support review flow: the queue, the case, a fetch step on the messages, the form and an email', () => {
  const spec = DEMO_FLOWS.find((f) => f.name === 'Rent support review');
  const flow = makeDemoFlow(lib, spec);
  const issues = validateFlow(flow);
  assert.deepEqual(issues.filter((i) => i.level === 'error' && !/hasn’t been tested/.test(i.text)).map((i) => i.text), []);
  const [step] = pagesOf(flow, 'fetch');
  assert.equal(requestsOf(step).length, MESSAGES_PER_CLIENT);
  assert.equal(step.annotations.length, 1);
  assert.deepEqual(flow.journey.map((id) => flow.pages.find((p) => p.id === id).role), ['guide', 'input', 'email', 'input', 'input', 'fetch', 'output', 'email']);
  assert.match(step.step.text, /all six messages, 4 at a time/);
  const body = exportFlow(flow, issues);
  assert.deepEqual(body.hosts, ['localhost:8787']);
  const back = importFlow(JSON.parse(JSON.stringify(body)));
  assert.equal(requestsOf(pagesOf(back, 'fetch')[0]).length, MESSAGES_PER_CLIENT);
  const data = makeDemoFlow(lib, DEMO_FLOWS.find((f) => f.fetch === 'data'));
  assert.deepEqual(requestsOf(pagesOf(data, 'fetch')[0]).map((r) => r.url), [`${B}messages/api/{clientId}.json`]);
  // The older flows keep exactly the pages they had.
  assert.deepEqual(pagesOf(makeDemoFlow(lib, DEMO_FLOWS[0]), 'input').map((p) => p.profileId).sort(), ['biv/employment', 'cm/client-record', 'harbour-homes/rent-account']);
});

test('the demo server serves the generated pages, and the messages data as application/json', async () => {
  await ensureSystems();
  const get = async (url) => { const res = { writeHead(s, h) { this.status = s; this.headers = h; }, end(b) { this.body = b; } }; await serveDemo({ url, method: 'GET' }, res); return res; };
  const c = caseOf(1001);
  const json = await get(`/demo/messages/api/${c.clientId}.json`);
  assert.equal(json.status, 200);
  assert.equal(json.headers['Content-Type'], 'application/json');
  assert.equal(JSON.parse(json.body.toString()).clientId, c.clientId);
  const page = await get('/demo/cm/queue.html');
  assert.equal(page.status, 200);
  assert.match(page.headers['Content-Type'], /^text\/html/);
});

test('the library’s inbox profiles: 25 links from page 1, a row from each message, and a referral clipped by hand', () => {
  const items = read('messages/index.html', 'messages/inbox').data.items;
  assert.equal(items.length, PAGE_SIZE);
  assert.ok(items.every((r) => r.href.startsWith(`${B}messages/message/`) && /^MSG-\d{6}$/.test(r.messageId)));
  const ref = referrals.find((r) => isUrgentOpen(r));
  const [row] = read(`messages/message/${ref.id}.html`, 'messages/inbox-message').data.item;
  assert.deepEqual([row.messageId, row.urgency, row.status, row.client, row.respondBy, row.reason], [ref.id, 'Urgent', 'Open', ref.clientId, ref.referral.respondBy, ref.referral.reason]);
  const c = caseOf(1001);
  const [plain] = read(`messages/message/${c.clientId}-1.html`, 'messages/inbox-message').data.item;
  assert.deepEqual([plain.client, plain.urgency, plain.status], [c.clientId, null, null]);
  // By hand, within the client's case: the referral's fields, and the identity check finds the same person.
  const owner = cases.find((x) => x.clientId === ref.clientId);
  const kase = newCase(lib, ['rsr'], { ref: String(owner.no) });
  clip(kase, `cm/case-${owner.no}.html`, 'cm/case');
  const got = read(`messages/message/${ref.id}.html`, 'messages/referral').data;
  assert.deepEqual([got.clientId, got.firstName, got.lastName, got.dob, got.referralUrgency, got.referralRespondBy], [owner.clientId, owner.person.firstName, owner.person.lastName, owner.person.dob, 'Urgent', ref.referral.respondBy]);
  assert.deepEqual(clip(kase, `messages/message/${ref.id}.html`, 'messages/referral').identity, []);
});

test('on a message page opened by hand the sidebar offers Customer message or Referral, never Inbox message', () => {
  const offered = (rel) => {
    const url = `${B}${rel}`;
    const doc = new JSDOM(files[rel], { url }).window.document;
    // As lib/core.js profilesForTab(): the library's candidates, narrowed by each one's when; the first is offered.
    return pageProfiles(lib, url).filter((p) => E.profileApplies(p, url, doc)).map((p) => p.id);
  };
  const ref = referrals.find((r) => r.kind === 'referral');
  const enq = referrals.find((r) => r.kind === 'enquiry');
  assert.deepEqual(offered(`messages/message/${ref.id}.html`), ['messages/referral']);
  assert.deepEqual(offered(`messages/message/${enq.id}.html`), ['messages/message']);
  assert.deepEqual(offered(`messages/message/${caseOf(1001).clientId}-1.html`), ['messages/message']);
  assert.deepEqual(offered('messages/index.html'), [], 'the inbox’s list of links is for the fetch step only');
  assert.ok(profile('messages/inbox-message').fetchOnly && profile('messages/inbox').fetchOnly);
});

test('the inbox triage flow: no form, the team inbox’s list fetched as rows, the open urgent referrals shown and marked', () => {
  const flow = makeDemoFlow(lib, DEMO_FLOWS.find((f) => f.name === 'Inbox triage'));
  assert.equal(pagesOf(flow, 'output').length, 0);
  assert.deepEqual(validateFlow(flow).filter((i) => i.level === 'error' && !/tested/.test(i.text)).map((i) => i.text), []);
  const [step] = pagesOf(flow, 'fetch');
  const [r] = requestsOf(step);
  assert.deepEqual([r.each.list, r.each.max, r.required], ['items', 25, false]);
  assert.deepEqual(step.fetch.show.where, { urgency: 'Urgent', status: 'Open' });
  assert.equal(step.fetch.show.mark.text, 'Urgent, open');
  const back = importFlow(JSON.parse(JSON.stringify(exportFlow(flow, validateFlow(flow)))));
  assert.equal(pagesOf(back, 'output').length, 0);
  assert.equal(requestsOf(pagesOf(back, 'fetch')[0])[0].each.list, 'items');
});

test('the rent support review emails the client for a missing reference, from the case, quicker than writing it', () => {
  const flow = makeDemoFlow(lib, DEMO_FLOWS.find((f) => f.name === 'Rent support review'));
  const ask = pagesOf(flow, 'email').find((p) => /missing reference/.test(p.name));
  assert.ok(ask, 'an email step to the client');
  assert.equal(ask.email.to, '{email}');
  // Only for a case with no tenancy reference: a condition, so Next passes over it, not a sentence to skip it.
  assert.deepEqual(ask.step.when, { field: 'tenancyRef', is: 'missing' });
  assert.doesNotMatch(ask.step.text, /skip this step/);
  for (const no of QUIRKS.noTenancyRef) assert.doesNotMatch(files[`cm/case-${no}.html`], /Landlord reference/, `case ${no} has no tenancy reference`);
  assert.ok(pagesOf(flow, 'email').some((p) => p.name === 'Tell the income team'), 'the income team’s email stays');
  // Filled from a case: to the client's own address, with their name and the case reference.
  const c = caseOf(1042);
  const kase = newCase(lib, ['rsr'], { ref: '1042' });
  clip(kase, 'cm/case-1042.html', 'cm/case');
  const flowLibrary = { ...lib, fields: { ...lib.fields, ...flow.fields } };
  const e = emailFor(ask.email, caseVars(kase, flowLibrary, { text: true }));
  assert.deepEqual(e.to, [c.person.email]);
  assert.match(e.body, new RegExp(`^Dear ${c.person.firstName} ${c.person.lastName},`));
  assert.match(e.body, /quoting case 1042/);
  assert.ok(e.mailto?.startsWith(`mailto:${c.person.email}?subject=`));
  // An email step not opened is to do, and Sent another way, or not needed marks it done: it never blocks the case.
  const step = { id: ask.id, role: 'email' };
  assert.equal(stepStatus(kase, step), 'todo');
  markStep(kase, ask.id, true);
  assert.equal(stepStatus(kase, step), 'done');
});

test('the rent support review’s instructions start with choosing the case, then cover every step in order, each with text', () => {
  for (const spec of DEMO_FLOWS.filter((f) => f.steps)) {
    const flow = makeDemoFlow(lib, spec);
    const steps = flow.journey.map((id) => flow.pages.find((p) => p.id === id));
    for (const p of steps) assert.ok(p.step?.text?.trim(), `${spec.name}: ${p.name} has its own text`);
    const lines = flow.guidance.split('\n');
    if (spec.steps === 'casework') {
      assert.ok(lines[0].startsWith(`1. Choose a case. Go to the work queue at ${B}cm/queue.html and open the case you want to work on`), lines[0]);
      assert.equal(steps[0].step.links[0].url, `${B}cm/queue.html`, 'the first step carries the real link');
    }
    steps.forEach((p, i) => assert.ok(lines[i]?.startsWith(`${i + 1}. ${p.name}.`), `${spec.name}: line ${i + 1} is ${p.name}`));
    assert.doesNotMatch(flow.guidance, /A demo flow made from/);
  }
});

test('hosted: the library moved to the site keeps its fetch rule, and the manifest’s hashes are of the moved files', async () => {
  // As tools/build-site.mjs copies it: every library file with localhost:8787 replaced, then the manifest rebuilt.
  const SITE = 'https://powerloader.surprisingly.ltd';
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pl-demo-lib-'));
  const copy = (rel) => {
    for (const e of readdirSync(path.join(libraryRoot, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) { mkdirSync(path.join(dir, r), { recursive: true }); copy(r); }
      else writeFileSync(path.join(dir, r), readFileSync(path.join(libraryRoot, r), 'utf8').replaceAll('http://localhost:8787', SITE));
    }
  };
  copy('');
  const manifest = await buildManifest({ dir, approvedHosts: [new URL(SITE).host] });
  const filesIn = Object.fromEntries(manifest.files.map((f) => [f.path, JSON.parse(readFileSync(path.join(dir, f.path), 'utf8'))]));
  const hosted = indexLibrary({ commit: manifest.commit, files: filesIn }, manifest);
  assert.deepEqual(hosted.problems, []);
  assert.ok(hosted.access.locked.every((r) => r.pattern.startsWith(`${SITE}/demo/messages/`)));
  const L = accessLayers({ currentLib: hosted, hosts: [new URL(SITE).host] });
  assert.equal(allowed(L, `${SITE}/demo/messages/message/NC-5347-1.html`, 'fetch-get').ok, true);
  assert.equal(allowed(L, `${SITE}/demo/biv/income-NC-5347.html`, 'fetch-get').ok, false);
  assert.equal(allowed(L, `${SITE}/demo/biv/income-NC-5347.html`, 'read').ok, true);
});

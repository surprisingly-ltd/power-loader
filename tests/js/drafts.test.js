import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { demoLibrary } from './helpers/library.js';
import {
  canUse, diffDraft, draftFromProfile, editPicks, exportBody, exportChecks, exportFileName, guessKey, judgeFillTest, judgeTest,
  literalLeaks, newFillDraft, newPageDraft, picksOf, reconcileDrafts, recordTest, repoPath, setUse, suggestPatterns, togglePick,
} from '../../extension/lib/drafts.js';
import { contentHash } from '../../extension/lib/hash.js';

const lib = demoLibrary();
const E = globalThis.PowerLoaderExtract;
const page = (f) => new JSDOM(readFileSync(new URL(`../../demo/${f}`, import.meta.url), 'utf8'), { url: `http://localhost:8787/demo/${f}` }).window.document;
const probe = (doc, d) => Object.fromEntries(Object.entries(d.profile.fields).map(([k, s]) => [k, E.probe(doc, s)]));

test('a new page draft has anonymised patterns and starts "Not tested"', () => {
  assert.deepEqual(suggestPatterns('https://cm.example.gov.uk/clients/C-1042/notes'), { match: 'https://cm.example.gov.uk/clients/*/notes*', urlPattern: 'https://cm.example.gov.uk/clients/{ref}/notes' });
  const d = newPageDraft({ url: 'http://localhost:8787/demo/rent-account-1042.html', title: 'Tenancy HH-20931 – Harbour Homes' });
  assert.equal(d.profile.match[0], 'http://localhost:8787/demo/rent-account-*.html*', 'not every page in the folder');
  assert.equal(d.profile.urlPattern, 'http://localhost:8787/demo/rent-account-{ref}.html');
  assert.equal(suggestPatterns('https://cm.example.gov.uk/docs/20931.pdf').urlPattern, 'https://cm.example.gov.uk/docs/{ref}.pdf');
  assert.equal(d.tested, null);
  assert.throws(() => setUse(d, true), /Test the draft/);
});

test('picking builds DSL selectors with regex parts, and any edit resets the test', () => {
  const d = newPageDraft({ url: 'http://localhost:8787/demo/rent-account-1042.html', title: 'Rent' });
  togglePick(d, 'dd.tenant', guessKey(lib, 'First name'));
  togglePick(d, '#tenancy label(Monthly rent)', guessKey(lib, 'Monthly rent'));
  editPicks(d, (p) => { p.push({ key: 'lastName', selector: 'dd.tenant', part: 'last' }); p[0].part = 'first'; });
  assert.deepEqual(d.profile.fields, { firstName: 'dd.tenant | regex:^(\\S+)', monthlyRent: '#tenancy label(Monthly rent)', lastName: 'dd.tenant | regex:(\\S+)$' });
  assert.equal(E.validateProfile(d.profile).length, 0);
  const doc = page('rent-account-1042.html');
  const t = judgeTest(d, probe(doc, d), { url: 'u1', lib, pageValues: ['Maria Kowalska'] });
  assert.equal(t.ok, true, JSON.stringify(t));
  assert.ok(!JSON.stringify(t).includes('Maria'), 'tests keep no page values');
  recordTest(d, t);
  setUse(d, true);
  assert.equal(canUse(d), true);
  togglePick(d, 'dd.tenant');
  assert.equal(d.tested, null);
  assert.equal(d.use, false);
});

test('a test fails on ambiguous, empty or invalid fields and on literal values', () => {
  const d = newPageDraft({ url: 'http://localhost:8787/demo/rent-account-1042.html', title: 'Rent' });
  editPicks(d, (p) => p.push({ key: 'monthlyRent', selector: 'td', part: 'all' }, { key: 'dob', selector: '#tenancy label(Landlord)', part: 'all' }, { key: 'phone', selector: 'label(Nope)', part: 'all' }));
  const t = judgeTest(d, probe(page('rent-account-1042.html'), d), { url: 'u', lib });
  assert.equal(t.ok, false);
  assert.match(t.fields.monthlyRent.error, /Matches 33 elements/);
  assert.equal(t.fields.dob.error, 'Not a date');
  assert.equal(t.fields.phone.error, 'Matches nothing on this page');
  const leaky = newPageDraft({ url: 'http://localhost:8787/demo/x.html', title: 'X' });
  editPicks(leaky, (p) => p.push({ key: 'lastName', selector: 'td:contains("Kowalska")', part: 'all' }));
  assert.deepEqual(literalLeaks(leaky.profile, ['Kowalska', 'Phone']), ['Kowalska']);
  const lt = judgeTest(leaky, { lastName: { count: 1, value: 'Kowalska' } }, { url: 'u', lib });
  assert.deepEqual(lt.leaks, ['1 value from this page']);
  assert.equal(lt.ok, false);
});

test('a second passing record is kept alongside the first', () => {
  const d = draftFromProfile(lib.profiles.find((p) => p.id === 'cm/client-record'), lib.commit);
  const t1 = judgeTest(d, probe(page('client-1042.html'), d), { url: 'http://localhost:8787/demo/client-1042.html', lib });
  recordTest(d, t1);
  const t2 = judgeTest(d, probe(page('client-2077.html'), d), { url: 'http://localhost:8787/demo/client-2077.html', lib });
  assert.equal(t2.fields.phone.ok, false, 'client 2077 has no phone: this is what a second record catches');
  recordTest(d, t2);
  assert.equal(d.tested.url, 'http://localhost:8787/demo/client-1042.html');
  assert.equal(d.second.ok, false);
});

test('a new version records its base, and the diff covers fields and metadata', () => {
  const base = lib.profiles.find((p) => p.id === 'harbour-homes/rent-account');
  const d = draftFromProfile(base, lib.commit);
  assert.deepEqual(d.base, { id: base.id, version: 'v1', commit: lib.commit });
  assert.equal(d.profile.version, 'v2');
  editPicks(d, (p) => { p.splice(p.findIndex((x) => x.key === 'phone'), 1); p.find((x) => x.key === 'landlord').selector = '#tenancy dd:nth-of-type(4)'; p.push({ key: 'tenancyType', selector: 'h1', part: 'all' }); });
  d.profile.urlPattern = 'http://localhost:8787/demo/rent-{tenancyRef}.html';
  d.profile.fields.payments = ['#payments tr', base.fields.payments[1]];
  const x = diffDraft(d, base);
  assert.deepEqual(x.removed, ['phone']);
  assert.deepEqual(x.remapped.map((r) => r.key).sort(), ['landlord', 'payments', 'tenancyType']);
  assert.equal(x.remapped.find((r) => r.key === 'payments').rows, true);
  assert.deepEqual(x.meta.map((m) => m.what), ['urlPattern']);
});

test('the export matches the DSL and the documented format, and is blocked until every check passes', async () => {
  const base = lib.profiles.find((p) => p.id === 'cm/client-record');
  const d = draftFromProfile(base, lib.commit);
  let checks = exportChecks(d, { lib, values: [] });
  assert.equal(checks[2].ok, false, 'not tested');
  recordTest(d, judgeTest(d, probe(page('client-1042.html'), d), { url: 'u', lib }));
  checks = exportChecks(d, { lib, values: ['Maria'] });
  assert.ok(checks.every((c) => c.ok), JSON.stringify(checks));
  const body = exportBody(d);
  assert.deepEqual(Object.keys(body), ['schema', 'id', 'kind', 'name', 'version', 'basedOn', 'match', 'urlPattern', 'when', 'fields']);
  assert.deepEqual(body.basedOn, { version: 'v3', commit: lib.commit });
  assert.equal(exportFileName(d), 'cm--client-record.v4.json');
  assert.equal(repoPath(d), 'profiles/pages/cm/client-record.json');
  editPicks(d, (p) => { p[0].selector = 'h1:contains("Maria")'; });
  checks = exportChecks(d, { lib, values: ['Maria'] });
  assert.equal(checks[3].ok, false);
  assert.equal(await contentHash({ ...body, exported: { contentHash: 'x' } }), await contentHash(body), 'the exported block is not hashed');
});

test('fill drafts are tested by a dry run of their boxes', () => {
  const d = newFillDraft(lib.forms.dhp, { url: 'http://localhost:8787/demo/dhp.html' });
  editPicks(d, (p) => p.push({ box: '#d-first', key: 'firstName' }, { box: '#d-last', key: 'lastName' }, { box: 'input', key: 'dob' }));
  assert.deepEqual(d.profile.fields, { '#d-first': 'CaseData.firstName', '#d-last': 'CaseData.lastName', input: 'CaseData.dob' });
  const doc = page('dhp.html');
  const probes = Object.fromEntries(picksOf(d).map((p) => [p.box, E.probe(doc, p.box)]));
  const t = judgeFillTest(d, probes, { url: 'u', lib });
  assert.equal(t.fields['#d-first'].ok, true);
  assert.match(t.fields.input.error, /Matches \d+ elements/);
  assert.equal(t.ok, false);
});

test('after a sync a draft is retired only if the published hash equals its exported hash', () => {
  const mk = (id, extra) => ({ ...newPageDraft({ url: 'http://localhost:8787/demo/a.html', title: id }), ...extra, profile: { id, name: id, version: 'v4' } });
  const drafts = [
    mk('same', { exported: { hash: 'h1' }, base: { version: 'v3' } }),
    mk('changed', { exported: { hash: 'h2' }, base: { version: 'v3' } }),
    mk('untouched', { base: { version: 'v3' } }),
  ];
  const out = reconcileDrafts(drafts, { same: { version: 'v4', hash: 'h1' }, changed: { version: 'v4', hash: 'other' }, untouched: { version: 'v3', hash: 'x' } });
  assert.deepEqual(out.retired, ['same']);
  assert.deepEqual(out.conflicts, ['changed']);
  assert.deepEqual(out.list.map((d) => d.profile.id), ['changed', 'untouched']);
  assert.equal(out.list[1].conflict, null);
  // Keeping my draft is remembered for that published version.
  out.list[0].conflict.dismissed = true;
  assert.deepEqual(reconcileDrafts(out.list, { changed: { version: 'v4', hash: 'other' } }).conflicts, []);
});

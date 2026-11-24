import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { demoSet, demoLibrary } from './helpers/library.js';
import { buildManifest } from '../../tools/build-demo-library.mjs';
import { confirmationFor, fillProfileFor, hostApproved, indexLibrary, pageProfiles, validateLibraryProfile } from '../../extension/lib/library.js';

test('the demo library manifest lists every file with its current hash', async () => {
  const built = await buildManifest();
  assert.deepEqual(JSON.parse(readFileSync(new URL('../../demo/library/library.json', import.meta.url), 'utf8')), built);
});

test('the demo library is valid and complete', () => {
  const lib = demoLibrary();
  assert.deepEqual(lib.problems, []);
  assert.deepEqual(Object.keys(lib.forms).sort(), ['coc', 'dhp', 'hsr']);
  assert.equal(fillProfileFor(lib, 'hsr').id, 'fill/housing-referral');
  assert.equal(fillProfileFor(lib, 'coc'), null);
});

test('library profiles are untrusted: bad hosts, clicking and broken forms are skipped and reported', () => {
  const set = demoSet();
  const files = structuredClone(set.files);
  files['profiles/pages/evil.json'] = { ...files['profiles/pages/cm/client-record.json'], id: 'evil', match: ['https://attacker.example/*'] };
  files['profiles/fill/click.json'] = { ...files['profiles/fill/dhp.json'], id: 'click', lists: [{ source: 'CaseData.x', rows: 'tr', add: 'button[type=submit]', fields: { input: '.a' } }] };
  files['profiles/fill/path.json'] = { ...files['profiles/fill/dhp.json'], id: 'path', fields: { '#x': 'Person.name' } };
  files['forms/broken.json'] = { schema: 'powerloader-form/1', id: 'broken', name: 'Broken', version: 'v1', fields: [{ key: 'notAField' }] };
  files['profiles/pages/bad-regex.json'] = { ...files['profiles/pages/cm/client-record.json'], id: 'bad', fields: { firstName: 'h1 | regex:(' } };
  const lib = indexLibrary({ ...set, files });
  const by = Object.fromEntries(lib.problems.map((p) => [p.path, p.errors.join(' ')]));
  assert.match(by['profiles/pages/evil.json'], /attacker\.example isn’t on the approved systems list/);
  assert.match(by['profiles/fill/click.json'], /can’t click/);
  assert.match(by['profiles/fill/path.json'], /CaseData/);
  assert.match(by['forms/broken.json'], /notAField/);
  assert.match(by['profiles/pages/bad-regex.json'], /invalid regex/);
  assert.ok(!lib.profiles.some((p) => ['evil', 'bad'].includes(p.id)));
  assert.ok(!lib.forms.broken);
});

test('approved hosts match exactly or by subdomain wildcard', () => {
  assert.ok(hostApproved('cm.northshire.gov.uk', ['*.northshire.gov.uk']));
  assert.ok(!hostApproved('northshire.gov.uk.attacker.example', ['*.northshire.gov.uk']));
  assert.ok(!hostApproved(null, ['x']));
  assert.deepEqual(validateLibraryProfile({ kind: 'fill', name: 'x', id: 'x', version: 'v1', match: ['http://localhost:8787/*'], fields: { a: 'CaseData.b' } }, { approvedHosts: ['localhost:8787'] }), []);
});

test('pages are matched to profiles, specific ones first, and confirmations to forms', () => {
  const lib = demoLibrary();
  assert.deepEqual(pageProfiles(lib, 'http://localhost:8787/demo/client-1042.html').map((p) => p.id), ['cm/client-record']);
  assert.deepEqual(pageProfiles(lib, 'http://localhost:8787/demo/index.html'), []);
  assert.deepEqual(confirmationFor(lib, 'http://localhost:8787/demo/dhp-submitted.html?ref=DHP-20417', 'Your reference is DHP-20417'), { formId: 'dhp', ref: 'DHP-20417' });
  assert.equal(confirmationFor(lib, 'http://localhost:8787/demo/dhp-submitted.html', 'No reference here'), null);
});

test('a tested draft in use replaces the published profile it is based on, and only while unchanged', async () => {
  const { draftFromProfile, judgeTest, recordTest, setUse, editDraft } = await import('../../extension/lib/drafts.js');
  const lib = demoLibrary();
  const d = draftFromProfile(lib.profiles.find((p) => p.id === 'cm/client-record'), lib.commit);
  const url = 'http://localhost:8787/demo/client-1042.html';
  assert.equal(pageProfiles(lib, url, [d])[0].draft, undefined);
  recordTest(d, judgeTest(d, Object.fromEntries(Object.keys(d.profile.fields).map((k) => [k, { count: 1, value: k === 'dob' ? '1986-07-14' : k === 'nino' ? 'QQ123456C' : k === 'phone' ? '07700 900123' : k === 'email' ? 'a@b.cd' : k === 'postcode' ? 'NS1 4AB' : k === 'contactPref' ? 'Phone' : 'x' }])), { url, lib }));
  setUse(d, true);
  assert.equal(pageProfiles(lib, url, [d])[0].draft, d.id);
  assert.equal(pageProfiles(lib, url, [d]).length, 1);
  editDraft(d, (p) => { p.name = 'Changed'; });
  d.use = true; // even if something left it switched on
  assert.equal(pageProfiles(lib, url, [d])[0].draft, undefined);
});

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
  assert.deepEqual(Object.keys(lib.forms).sort(), ['coc', 'dhp', 'hsr', 'rsr']);
  assert.equal(fillProfileFor(lib, 'rsr').id, 'fill/rent-review');
  assert.equal(fillProfileFor(lib, 'hsr').id, 'fill/housing-referral');
  assert.equal(fillProfileFor(lib, 'coc'), null);
});

test('a library’s own steps.json is reported as a file it shouldn’t have, and not read: steps belong to a flow', () => {
  const set = demoSet();
  const step = { id: 'g', name: 'Queue', role: 'guide', text: '', url: 'http://localhost:8787/demo/cases.html', match: ['http://localhost:8787/demo/cases.html*'] };
  const lib = indexLibrary({ ...set, files: { ...set.files, 'steps.json': { schema: 'powerloader-steps/1', steps: [step] } } });
  assert.match(lib.problems.find((p) => p.path === 'steps.json').errors[0], /A library doesn’t have steps of its own: steps belong to a flow/);
  assert.deepEqual(lib.steps, []);
  // The set a flow compiles to keeps its steps: that is how a case's steps are stored.
  const flowLib = indexLibrary({ ...set, commit: 'flow-abc-123', flow: { id: 'f-abc', name: 'Queue' }, files: { ...set.files, 'steps.json': { schema: 'powerloader-steps/1', steps: [step] } } });
  assert.equal(flowLib.problems.find((p) => p.path === 'steps.json'), undefined);
  assert.deepEqual(flowLib.steps.map((s) => s.id), ['g']);
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


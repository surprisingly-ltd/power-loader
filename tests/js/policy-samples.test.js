// policies/samples: every sample passes the checker and its expectations, so none goes stale when the rule
// engine changes. Each has a .md beside it, uses example.gov.uk only, and holds no secrets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkPolicy, runExpectations } from '../../tools/policy.mjs';
import { resolvePolicy } from '../../extension/lib/policy.js';
import { accessLayers, allowed } from '../../extension/lib/access.js';

const dir = new URL('../../policies/samples/', import.meta.url);
const names = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.expect.json')).map((f) => f.slice(0, -5)).sort();
const read = (f) => JSON.parse(fs.readFileSync(new URL(f, dir), 'utf8'));

test('the six samples are there', () => {
  assert.deepEqual(names, ['endpoints-by-pattern', 'fetch-one-domain', 'fixed-endpoints', 'locked-down', 'no-post', 'no-remote-ai']);
});

for (const name of names) {
  test(`${name}: passes the checker, and its expectations hold`, () => {
    const doc = read(`${name}.json`);
    assert.deepEqual(checkPolicy(doc).errors, []);
    assert.ok(fs.existsSync(new URL(`${name}.md`, dir)), `${name}.md says what it does`);
    const cases = read(`${name}.expect.json`);
    assert.ok(cases.length >= 2);
    assert.deepEqual(runExpectations(doc, cases), []);
    const text = JSON.stringify(doc);
    for (const [, host] of text.matchAll(/:\/\/(?:\*\.)?([^/:"*]+)/g)) assert.ok(host === '*' || /(^|\.)example\.gov\.uk$/.test(host), `${name} uses ${host}`);
    for (const id of [doc.build.id]) assert.match(id, /@example\.gov\.uk$/);
  });
}

test('fetch-one-domain: a layer with allow rules for an action must match; for other actions it has no opinion', () => {
  const layers = accessLayers({ policy: resolvePolicy(read('fetch-one-domain.json')) });
  assert.equal(allowed(layers, 'https://elsewhere.example.com/', 'fetch-get').ok, false);
  assert.equal(allowed(layers, 'https://elsewhere.example.com/', 'read').ok, true);
  assert.equal(allowed(layers, 'https://records.example.gov.uk/', 'fetch-get').ok, true);
});

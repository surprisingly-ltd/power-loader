// Runs fixtures/json-cases.json: a JSON response, as raw text, through lib/json-dom.js jsonToDocument() and then
// the same extract() and profileApplies() that read HTML. fixtures/dsl-cases.json and its hash stay frozen;
// this file is JSON's own conformance suite (docs/plans/json-clips.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import '../../extension/lib/extract.js';
import '../../extension/lib/json-dom.js';

const { extract, profileApplies } = globalThis.PowerLoaderExtract;
const { jsonToDocument } = globalThis.PowerLoaderJson;
const root = new URL('../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root));
const documentSource = new JSDOM('').window.document;

for (const c of JSON.parse(read('fixtures/json-cases.json'))) {
  test(`json: ${c.name}`, () => {
    const { doc } = jsonToDocument(c.json, { documentSource });
    const out = extract(doc, { fields: c.fields }, { baseUrl: c.url });
    assert.deepEqual(out.data, c.expected);
    if (c.when) assert.equal(profileApplies({ match: [`${new URL(c.url).origin}/*`], when: c.when }, c.url, doc), c.applies);
  });
}

test('the HTML conformance cases are unchanged, byte for byte', () => {
  const hashes = JSON.parse(read('fixtures/reference-hashes.json'));
  assert.equal(createHash('sha256').update(read('fixtures/dsl-cases.json')).digest('hex'), hashes['dsl-cases.json']);
});

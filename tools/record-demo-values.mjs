// Records the values the demo library's existing profiles read from a sample of the generated cases, into
// tests/js/fixtures/demo-values.json. The test (demo-systems.test.js) reads the same pages again and compares, so a
// change to the generator can't quietly change a case, a record, a tenancy or a message the demo, the README or
// the site names. Run it only on purpose, when the existing data is meant to change.
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import '../extension/lib/extract.js';
import '../extension/lib/json-dom.js';
import { demoLibrary } from '../tests/js/helpers/library.js';
import { buildData, buildFiles, MESSAGES_PER_CLIENT } from './build-demo-systems.mjs';

export const SAMPLE = [1001, 1002, 1003, 1005, 1007, 1018, 1042, 1047, 1050, 1063, 1077, 1088, 1100];
const B = 'http://localhost:8787/demo/';

/** { 'cm/case-1001.html': { profileId, data }, … } for the sample, read with the library's profiles. */
export function readSample(files, cases, lib = demoLibrary()) {
  const { DOMParser } = new JSDOM('').window;
  const E = globalThis.PowerLoaderExtract;
  const J = globalThis.PowerLoaderJson;
  const out = {};
  const read = (rel, profileId) => {
    const url = `${B}${rel}`;
    const p = lib.profiles.find((x) => x.id === profileId);
    const doc = rel.endsWith('.json')
      ? J.readJson(new TextEncoder().encode(files[rel]), { contentType: 'application/json', documentSource: new DOMParser().parseFromString('', 'text/html') }).doc
      : new JSDOM(files[rel], { url }).window.document;
    out[rel] = { profileId, data: E.extract(doc, p, { baseUrl: url }).data };
  };
  for (const no of SAMPLE) {
    const c = cases.find((x) => x.no === no);
    read(`cm/case-${no}.html`, 'cm/case');
    read(`cm/notes-${no}.html`, 'cm/notes');
    read(`biv/income-${c.clientId}.html`, 'biv/income');
    read(`harbour/tenancy-${c.tenancy.ref}.html`, 'harbour-homes/tenancy');
    for (let n = 1; n <= MESSAGES_PER_CLIENT; n++) read(`messages/message/${c.clientId}-${n}.html`, 'messages/message');
    read(`messages/api/${c.clientId}.json`, 'messages/messages-data');
  }
  return JSON.parse(JSON.stringify(out));
}

/**
 * A hash of every case as the generator holds it, so the 100 cases, their records, tenancies and messages are
 * checked whole, not only the sample. Fields added later that are empty for every existing record (a message's
 * `attachments: []`) are left out, so preparing for them doesn't count as a change.
 */
export const casesDigest = (cases) => createHash('sha256')
  .update(JSON.stringify(cases, (k, v) => (k === 'attachments' && Array.isArray(v) && !v.length ? undefined : v)))
  .digest('hex');

if (process.argv[1]?.endsWith('record-demo-values.mjs')) {
  const cases = buildData();
  mkdirSync(new URL('../tests/js/fixtures/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../tests/js/fixtures/demo-values.json', import.meta.url), `${JSON.stringify({ casesDigest: casesDigest(cases), pages: readSample(buildFiles(cases), cases) }, null, 1)}\n`);
  process.stdout.write('Recorded tests/js/fixtures/demo-values.json\n');
}

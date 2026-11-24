// Writes CANDIDATES only. The historical Python reference is not an oracle that
// the JS engine may replace automatically. Review semantic diffs before adoption.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import '../../extension/lib/extract.js';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const json = (p) => JSON.parse(readFileSync(path.join(repo, p), 'utf8'));
const index = process.argv.indexOf('--output');
if (index < 0 || !process.argv[index + 1]) throw new Error('Choose a candidate directory with --output <directory>');
const output = path.resolve(process.argv[index + 1]);
if (output === path.join(repo, 'fixtures/expected')) throw new Error('Write candidates elsewhere; historical fixtures require a reviewed diff');
mkdirSync(output, { recursive: true });
const name = (s) => s.replace(/ /g, '-').replace(/[()]/g, '') + '.json';
for (const c of json('fixtures/pages.json')) {
  const doc = new JSDOM(readFileSync(path.resolve(repo, 'fixtures', c.page), 'utf8'), { url: c.url }).window.document;
  const out = globalThis.PowerLoaderExtract.extract(doc, json(`extension/templates/${c.template}.json`), { baseUrl: c.url });
  writeFileSync(path.join(output, name(c.name)), JSON.stringify(out.data, null, 2) + '\n');
}
for (const c of json('fixtures/fill-pages.json')) {
  const plan = globalThis.PowerLoaderExtract.resolveFill(json(`extension/templates/${c.template}.json`), c.records);
  writeFileSync(path.join(output, name('fill ' + c.name)), JSON.stringify({ fields: plan.fields, lists: plan.lists }, null, 2) + '\n');
}
process.stdout.write(`Candidates written to ${output}. Review semantic diffs before changing frozen references.\n`);

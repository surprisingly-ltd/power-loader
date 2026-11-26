// What a fetch step read, as text (lib/fetch-view.js): a page's readable text and JSON with one key to a line,
// where each value is in it, the windows drawn in the box on a page, and the excerpts a clip keeps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import '../../extension/lib/extract.js';
import { demoLibrary } from './helpers/library.js';
import { VIEW_LIMITS, boxLines, excerptsOf, textView, validExcerpts } from '../../extension/lib/fetch-view.js';

const { window } = new JSDOM('<!DOCTYPE html><body></body>');
const J = globalThis.PowerLoaderJson;
const lib = demoLibrary();

test('a page is its readable text, one block a line, and each value is found on its line', () => {
  const html = readFileSync(new URL('../../demo/cm/case-1001.html', import.meta.url), 'utf8');
  const doc = new window.DOMParser().parseFromString(html, 'text/html');
  const profile = lib.profiles.find((p) => p.id === 'cm/case');
  const v = textView(doc, profile);
  assert.equal(v.format, 'html');
  assert.ok(v.lines.length > 10);
  assert.ok(!v.lines.some((l) => /<|function\s*\(/.test(l)), 'text, never markup or script');
  const last = v.marks.find((m) => m.key === 'lastName');
  assert.equal(v.lines[last.line], 'Last name   Harrison', 'a table row, its cells side by side');
  assert.equal(v.lines[last.line].slice(last.start, last.end), 'Harrison');
});

test('JSON is laid out one key to a line, and a value deep in a large response is found where it sits', () => {
  const big = { meta: { count: 600 }, items: Array.from({ length: 600 }, (_, i) => ({ id: `M-${i}`, text: `Message ${i}` })), person: { name: 'Sophie Harrison', income: 412.5 } };
  const { doc } = J.jsonToDocument(JSON.stringify(big), { documentSource: window.document });
  const profile = { format: 'json', fields: { lastName: ":root > [key='person'] > [key='name']", weeklyIncome: ":root > [key='person'] > [key='income'] | number", rows: [":root > [key='items'] > *", { id: ":scope > [key='id']" }] } };
  const v = textView(doc, profile);
  const name = v.marks.find((m) => m.key === 'lastName');
  assert.equal(v.lines[name.line].trim(), '"name": "Sophie Harrison",');
  assert.equal(v.lines[name.line].slice(name.start, name.end), '"Sophie Harrison"');
  assert.ok(name.line > 1800, 'deep in the response');
  assert.equal(v.marks.filter((m) => m.key === 'rows').length, VIEW_LIMITS.marksPerField);
  // The box gets windows around each value, not 2,400 lines.
  const box = boxLines(v);
  assert.ok(box.rows.length <= VIEW_LIMITS.boxLines + 10);
  assert.ok(box.rows.some((r) => r.gap));
  const m = box.marks.find((x) => x.key === 'lastName');
  assert.match(box.rows[m.line].text, /Sophie Harrison/);
  // The clip keeps only the text around each value it holds.
  const ex = excerptsOf(v, ['lastName', 'weeklyIncome']);
  assert.deepEqual(Object.keys(ex).sort(), ['lastName', 'weeklyIncome']);
  assert.ok(ex.lastName.lines.length <= VIEW_LIMITS.around * 2 + 1);
  assert.ok(JSON.stringify(ex).length < 2000, 'a few lines, not the response');
  assert.doesNotMatch(JSON.stringify(ex), /Message 3/);
  const em = ex.lastName.marks[0];
  assert.equal(ex.lastName.lines[em.line].text.slice(em.start, em.end), '"Sophie Harrison"');
  assert.deepEqual(validExcerpts(ex), ex);
  assert.deepEqual(validExcerpts({ a: { lines: 'x' } }), {});
});

test('an excerpt is at most 500 characters a value and 20 KB a clip', () => {
  const long = 'x'.repeat(3000);
  const obj = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, `${long}${i}`]));
  const { doc } = J.jsonToDocument(JSON.stringify(obj), { documentSource: window.document });
  const fields = Object.fromEntries(Object.keys(obj).map((k) => [k, `:root > [key='${k}']`]));
  const v = textView(doc, { format: 'json', fields });
  const ex = excerptsOf(v, Object.keys(obj));
  for (const e of Object.values(ex)) assert.ok(e.lines.reduce((n, l) => n + l.text.length, 0) <= VIEW_LIMITS.excerptChars);
  assert.ok(Object.values(ex).reduce((n, e) => n + e.lines.reduce((k, l) => k + l.text.length, 0), 0) <= VIEW_LIMITS.clipChars);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { demoLibrary, extractDemo } from './helpers/library.js';
import { addClip, clipFromExtract, newCase } from '../../extension/lib/case.js';
import { amounts, inputSignature, solve, workingText } from '../../extension/lib/calc.js';
import { approxDuration, periods, summaryText, timeline } from '../../extension/lib/timeline.js';
import { matchDocument, textLines } from '../../extension/lib/reader/match.js';
import { openPdf, pdfText } from '../../extension/lib/reader/pdf.js';

const lib = demoLibrary();
const c = newCase(lib, ['hsr', 'dhp']);
for (const [p, id] of [['client-1042.html', 'cm/client-record'], ['rent-account-1042.html', 'harbour-homes/rent-account'], ['employment-1042.html', 'biv/employment']]) {
  const { profile, res } = extractDemo(lib, p, id);
  addClip(c, lib, clipFromExtract(lib, profile, res));
}

test('the calculator finds which payments make the arrears, exactly in pence, within stated limits', () => {
  const all = amounts(c, lib);
  const tx = all.filter((a) => a.kind === 'transaction');
  assert.equal(tx.length, 11);
  const values = all.filter((a) => a.kind === 'value');
  assert.deepEqual(values.map((v) => [v.label, v.frequency]).sort(), [['Monthly rent', 'monthly'], ['Weekly income', 'weekly']]);
  const r = solve(tx, 1245.6, { maxK: 3 });
  assert.ok(r.list.length >= 1);
  assert.ok(r.list.every((x) => Math.abs(x.total - 1245.6) < 1e-9 && x.items.length <= 3));
  assert.equal(r.truncated, false);
  assert.deepEqual(r.limits, { maxK: 3, tol: 0, results: 50 });
  assert.match(workingText(r.list[0], 1245.6), /Total: £1245\.60/);
  assert.throws(() => solve([{ id: 'x', amount: -10 }], 5), /Adjustments aren’t supported yet/);
  assert.throws(() => solve(tx, 0), /Enter the figure/);
  // A big search stops at its limits and says so.
  const many = Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, label: 'x', amount: 1 + (i % 7) * 0.01 }));
  assert.equal(solve(many, 3.03, { maxK: 6 }).truncated, true);
});

test('a calculator result is stale when any input changes', () => {
  const tx = amounts(c, lib).filter((a) => a.kind === 'transaction');
  const sig = inputSignature({ target: 1245.6, chosen: tx, maxK: 4, tol: 0 });
  assert.equal(inputSignature({ target: '1245.60', chosen: [...tx].reverse(), maxK: 4, tol: 0 }), sig);
  assert.notEqual(inputSignature({ target: 1245.6, chosen: tx.slice(1), maxK: 4, tol: 0 }), sig);
  assert.notEqual(inputSignature({ target: 1245.61, chosen: tx, maxK: 4, tol: 0 }), sig);
});

test('the timeline totals are exact: short gaps are counted and stated, and days are the primary figure', () => {
  const list = periods(c);
  assert.equal(list.length, 6);
  const m = timeline(list, { today: '2026-10-19', minGap: 7 });
  assert.equal(m.from, '2016-09-05');
  assert.equal(m.to, '2026-10-19');
  assert.equal(m.span, m.covered + m.gapDays, 'every day is either covered or in a gap');
  assert.deepEqual(m.gaps.map((g) => [g.start, g.end, g.days, g.ignored]), [['2019-05-01', '2019-05-01', 1, true], ['2021-12-25', '2022-02-28', 66, false], ['2023-11-01', '2023-11-05', 5, true]]);
  assert.deepEqual(m.ignored, { count: 2, days: 6 });
  assert.equal(m.shownGapDays, 66);
  assert.equal(m.longest.days, 66);
  const text = summaryText(m);
  assert.match(text, /Not covered: 72 days in 3 gaps/);
  assert.match(text, /2 gaps shorter than the minimum \(6 days in all\) are counted but not listed/);
  assert.match(text, /Gap 1: 25 Dec 2021 to 28 Feb 2022, 66 days \(about 2 months\)/);
  assert.equal(approxDuration(400), 'about 1 year 1 month');
});

test('single-day periods count, and approximate periods stay out of exact totals', () => {
  const one = timeline([{ id: 'a', label: 'A', start: '2026-01-05', end: '2026-01-05' }], { today: '2026-10-19' });
  assert.equal(one.span, 1);
  assert.equal(one.covered, 1);
  const approx = { id: 'b', label: 'Off sick (about)', start: '2025-01-15', end: '2025-03-31', approx: true };
  const m = timeline([{ id: 'a', label: 'Work', start: '2025-01-01', end: '2025-12-31' }, approx], { today: '2026-10-19' });
  assert.equal(m.approx.length, 1);
  assert.match(summaryText(m), /1 period has approximate dates and is not in these totals/);
});

test('a known document type is read with its library profile, and misread values can’t pass', () => {
  const { lines } = JSON.parse(readFileSync(new URL('../../fixtures/documents/tenancy-ocr.json', import.meta.url), 'utf8'));
  const out = matchDocument(lines, lib, ['landlord', 'tenancyType', 'tenancyStart', 'monthlyRent', 'address'], lib.documents);
  assert.equal(out.profile.id, 'documents/tenancy-agreement');
  const by = Object.fromEntries(out.rows.map((r) => [r.key, r]));
  assert.equal(by.landlord.value, 'HARBOUR HOMES LIMITED');
  assert.equal(by.tenancyType.value, 'Assured shorthold tenancy');
  assert.equal(by.tenancyStart.value, '2021-06-01');
  assert.equal(by.tenancyStart.page, 2);
  assert.equal(by.tenancyStart.quote, 'The tenancy is commencing on 1 June 2021');
  assert.equal(by.monthlyRent, undefined, 'the OCR misread “£7Z5.00” matches nothing');
  assert.equal(matchDocument([{ text: 'Monthly rent: £7Z5.00', page: 1, confidence: 40 }], lib, ['monthlyRent']).rows[0].ok, false);
  assert.equal(matchDocument([{ text: 'Monthly rent: £725.00', page: 1, confidence: 40 }], lib, ['monthlyRent']).rows[0].confidence, 'low');
});

// A one-page PDF with a text layer, written by hand so the test needs no fixture binary.
function makePdf(lines, { scan = false } = {}) {
  const content = scan ? '' : `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((l) => `(${l.replace(/[()\\]/g, (ch) => `\\${ch}`)}) Tj T*`).join(' ')} ET`;
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => { const at = pdf.length; pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

test('pdf.js reads the text layer page by page, and a page with no text is a scan', async () => {
  const doc = await openPdf(pdfjs, makePdf(['Payslip for week ending 27 Sep 2026', 'Employee: MARIA KOWALSKA', 'NI number QQ123456C', 'Employer: Royal Mail Group Ltd', 'Gross pay 312.40']));
  const pages = await pdfText(doc);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].scan, false);
  const out = matchDocument(textLines(pages), lib, ['firstName', 'lastName', 'nino', 'currentEmployer', 'weeklyIncome'], lib.documents);
  assert.equal(out.profile.id, 'documents/payslip');
  const by = Object.fromEntries(out.rows.map((r) => [r.key, r.value]));
  assert.deepEqual(by, { firstName: 'MARIA', lastName: 'KOWALSKA', nino: 'QQ123456C', currentEmployer: 'Royal Mail Group Ltd', weeklyIncome: '312.40' });
  const blank = await pdfText(await openPdf(pdfjs, makePdf([], { scan: true })));
  assert.equal(blank[0].scan, true);
  await assert.rejects(openPdf(pdfjs, new TextEncoder().encode('%PDF-1.4 broken')), (e) => e.reason === 'corrupt');
  await assert.rejects(openPdf({ getDocument: () => ({ promise: Promise.reject(Object.assign(new Error('pw'), { name: 'PasswordException' })) }) }, new Uint8Array(4)), (e) => e.reason === 'password');
  await assert.rejects(pdfText({ numPages: 40 }), (e) => e.reason === 'too-many-pages' && e.numPages === 40);
});

test('explicit PDF ranges cannot bypass the page budget or read invalid pages', async () => {
  const visited = [];
  const doc = { numPages: 30, getPage: async (n) => {
    visited.push(n);
    return { getTextContent: async () => ({ items: [{ str: `Synthetic page ${n}` }] }) };
  } };
  for (const pages of [[1, 21], [0, 1], [5, 4], [1.5, 3], [1, 31]]) {
    await assert.rejects(pdfText(doc, { pages }), (e) => ['page-range', 'too-many-pages'].includes(e.reason));
    assert.deepEqual(visited, [], 'Refuse before loading any PDF page');
  }
  const pages = await pdfText(doc, { pages: [11, 30] });
  assert.equal(pages.length, 20);
  assert.equal(visited[0], 11);
  assert.equal(visited.at(-1), 30);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoLibrary } from './helpers/library.js';
import { newCase } from '../../extension/lib/case.js';
import { NOT_KEPT, allRows, applyRetention, archiveLog, coarsen, exportRows, logEvent, noteKept, removeKept, toCsv, withNote } from '../../extension/lib/activity.js';
import { pageInfo, visitEvent } from '../../extension/lib/visits.js';

const lib = demoLibrary();
const base = 'http://localhost:8787/demo/';

test('only approved systems are logged, and a link is kept only as its library pattern', () => {
  assert.deepEqual(pageInfo(lib, `${base}client-1042.html`), { type: 'cm/client-record@v3', pattern: 'http://localhost:8787/demo/client-{clientId}.html' });
  assert.deepEqual(pageInfo(lib, `${base}dhp.html`), { type: 'form:dhp@v2', pattern: 'http://localhost:8787/demo/dhp.html' });
  assert.deepEqual(pageInfo(lib, `${base}dhp-submitted.html?ref=DHP-20417`), { type: 'confirm:dhp@v2', pattern: NOT_KEPT });
  assert.deepEqual(pageInfo(lib, `${base}index.html`), { type: 'approved-host', pattern: NOT_KEPT }, 'an approved host with no profile never keeps its address');
  assert.equal(pageInfo(lib, 'https://news.example/story/1042'), null, 'other browsing is not recorded at all');
  assert.equal(pageInfo(lib, 'about:blank'), null);
  // A recognised page whose profile has no pattern fails closed.
  const noPattern = { ...lib, profiles: lib.profiles.map((p) => (p.id === 'cm/client-record' ? { ...p, urlPattern: undefined } : p)) };
  assert.equal(pageInfo(noPattern, `${base}client-1042.html`).pattern, NOT_KEPT);
});

test('every identifier in a logged link is replaced by its placeholder', () => {
  const c = newCase(lib, ['hsr']);
  for (const page of ['client-1042.html', 'rent-account-1042.html', 'employment-1042.html', 'case-notes-1042.html']) logEvent(c, 'visit_page', visitEvent(c, lib, { url: `${base}${page}` }));
  const kept = archiveLog(c, 'finished');
  assert.equal(kept.events.length, 4);
  for (const e of kept.events) {
    assert.ok(!e.url_pattern.includes('1042'), e.url_pattern);
    assert.ok(!('url' in e), 'real links are dropped when the case ends');
  }
});

test('reloads, hash changes and other windows don’t add visits; switching back to a case tab adds one', () => {
  const c = newCase(lib, ['hsr']);
  const visit = (url, reason) => { const ev = visitEvent(c, lib, { url, reason }); if (ev) logEvent(c, 'visit_page', ev); return !!ev; };
  assert.equal(visit(`${base}client-1042.html`), true);
  assert.equal(visit(`${base}client-1042.html`), false, 'reload');
  assert.equal(visit(`${base}client-1042.html#contact`), false, 'same-page hash change');
  assert.equal(visit(`${base}rent-account-1042.html`), true);
  assert.equal(visit(`${base}client-1042.html`, 'switch'), true, 'back to a tab that belongs to the case');
  assert.equal(visit(`${base}employment-1042.html`, 'switch'), false, 'a tab that never belonged to the case');
  assert.equal(c.log.at(-1).detail, 'Switched to tab');
});

test('downloads use patterns, leave notes out unless chosen, and escape CSV', () => {
  const c = newCase(lib, ['hsr']);
  logEvent(c, 'visit_page', visitEvent(c, lib, { url: `${base}client-1042.html` }));
  c.log[0] = withNote(c.log[0], 'Client said "call back", see notes');
  const rows = allRows(c, []);
  const plain = exportRows(rows);
  assert.ok(!('note' in plain[0]));
  assert.ok(!JSON.stringify(plain).includes('client-1042'));
  const withNotes = exportRows(rows, { notes: true });
  assert.equal(withNotes[0].note, 'Client said "call back", see notes');
  assert.match(toCsv(withNotes), /"Client said ""call back"", see notes"/);
  assert.deepEqual(Object.keys(plain[0]).slice(0, 7), ['schema', 'seq', 'case_id', 'activity', 'timestamp', 'page_type', 'url_pattern']);
  assert.equal(coarsen('2026-10-19T11:57:08.123Z', true), '2026-10-19T11:57:00Z');
});

test('removing kept items marks the trace partial; retention deletes old kept logs', () => {
  const c = newCase(lib, ['hsr']);
  logEvent(c, 'visit_page', { page: { type: 'x' } });
  logEvent(c, 'clip_page', { page: { type: 'x' } });
  const kept = [archiveLog(c, 'finished', '2026-10-19T10:00:00Z')];
  const after = removeKept(kept, [c.log[1].id]);
  assert.equal(after[0].events.length, 1);
  assert.equal(after[0].partial, true);
  assert.equal(noteKept(after, c.log[0].id, 'checked')[0].events[0].note, 'checked');
  const old = { ...kept[0], ended: '2026-01-01T00:00:00Z' };
  assert.deepEqual(applyRetention([old, kept[0]], 90, Date.parse('2026-10-19T12:00:00Z')), [kept[0]]);
});

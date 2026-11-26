// Clear on close: a case left open when Firefox closed is deleted at the next start, through the same teardown
// as Discard, with a receipt that counts what went. The organisation can lock it either way.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { demoSet, startDemoFlow } from './helpers/library.js';
import { updateCase } from '../../extension/lib/core.js';
import { CASE_ENDED, clearCaseAtStart, clearExpiredCase, clearsAfter, clearsOnClose } from '../../extension/lib/teardown.js';
import { addClip } from '../../extension/lib/case.js';
import { getPolicy, useBuiltInPolicy } from '../../extension/lib/policy.js';

let state, session, listener, messages;
const set = demoSet();
globalThis.browser = {
  storage: {
    local: {
      get: async (keys) => structuredClone(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((key) => key in state).map((key) => [key, state[key]]))),
      set: async (patch) => { Object.assign(state, structuredClone(patch)); },
    },
    session: { remove: async (keys) => { for (const k of keys) delete session[k]; } },
    managed: { get: async () => ({}) },
  },
  runtime: {
    id: 'test-extension', getURL: (path) => path,
    onMessage: { addListener: (fn) => { listener = fn; } },
    sendMessage: async (message) => (message.type === CASE_ENDED ? (messages.push(message), undefined) : listener(structuredClone(message), { id: 'test-extension' })),
  },
};
const source = readFileSync(new URL('../../extension/lib/storage.js', import.meta.url), 'utf8');
(await import(`data:text/javascript,${encodeURIComponent(source)}#background`)).registerStorageWriter();

const clip = (values) => ({ source: 'p|u', kind: 'page', profile: { id: 'p', version: 'v1' }, name: 'Page', url: 'https://cm.example/clients/C-1', values, records: [], extra: {} });
const org = (policy) => ({ schema: 'powerloader-policy/1', name: 'Example Council', build: { id: 'powerloader@example.gov.uk' }, policy });

beforeEach(async () => {
  state = { library: { current: set.commit, sets: { [set.commit]: set } } };
  session = { caseDrafts: { x: 'typed' }, readerResult: { text: 'read' }, aiCredential: { key: 'kept' } };
  messages = [];
  await getPolicy({ fresh: true });
});
afterEach(async () => { useBuiltInPolicy(null); await getPolicy({ fresh: true }); });

test('on by default: the case left open is deleted at the next start, with a receipt and a log entry', async () => {
  const c = await startDemoFlow('Housing support referral');
  await updateCase(c.id, (cs, lib) => addClip(cs, lib, clip({ firstName: 'Maria', lastName: 'Kowalska' })));
  const receipt = await clearCaseAtStart();
  assert.equal(receipt.outcome, 'closed');
  assert.deepEqual(receipt.counts, { clips: 1, values: 2, decisions: 0, workings: 0 });
  assert.equal(state.case, null);
  assert.equal(state.receipt.outcome, 'closed');
  assert.deepEqual(Object.keys(session), ['aiCredential'], 'unsaved typing and reader results went too');
  const [kept] = state.processLog;
  assert.equal(kept.outcome, 'closed');
  assert.equal(kept.events.at(-1).activity, 'close_case');
  assert.ok(!JSON.stringify(state).includes('Maria'));
  assert.deepEqual(messages, [{ type: CASE_ENDED, caseId: c.id }]);
});

test('what a fetch step kept of a response is case data: in no log, and deleted with the case', async () => {
  const { endCase } = await import('../../extension/lib/teardown.js');
  const { applyFetched } = await import('../../extension/lib/fetch-steps.js');
  const c = await startDemoFlow('Housing support referral');
  const excerpt = { lines: [{ n: 4, text: '  "weeklyIncome": 93.07,  EXCERPT-MARKER' }], marks: [{ line: 0, start: 18, end: 23 }] };
  await updateCase(c.id, (cs, lib) => applyFetched(cs, lib, {
    step: { id: 's1', name: 'Customer messages' }, request: { id: 'r1', name: 'Messages' },
    profile: { id: 'p', version: 'v1', name: 'Messages (data)', urlPattern: 'https://msg.example/api/{clientId}' },
    read: { data: { firstName: 'Maria' }, url: 'https://msg.example/api/C-1', title: 'Messages', excerpts: { firstName: excerpt, notKept: excerpt } },
  }));
  const stored = state.case.clips[0];
  assert.deepEqual(Object.keys(stored.excerpts), ['firstName'], 'only for a value the clip holds');
  assert.ok(!JSON.stringify(state.case.log).includes('EXCERPT-MARKER'), 'never in the activity log');
  await endCase(c.id, 'discarded');
  assert.equal(state.case, null);
  assert.ok(!JSON.stringify(state).includes('EXCERPT-MARKER'), 'nothing of the response left behind');
  assert.ok(!JSON.stringify(session).includes('EXCERPT-MARKER'));
});

test('turned off by the caseworker, the case is kept; nothing open, nothing happens', async () => {
  assert.equal(await clearCaseAtStart(), null);
  const c = await startDemoFlow('Housing support referral');
  state.settings = { clearCaseOnClose: false };
  assert.equal(await clearCaseAtStart(), null);
  assert.equal(state.case.id, c.id);
});

test('an interrupted Finish is left to the teardown that recovers it', async () => {
  const c = await startDemoFlow('Housing support referral');
  state.teardown = { caseId: c.id, outcome: 'finished', startedAt: 'earlier' };
  assert.equal(await clearCaseAtStart(), null);
  assert.equal(state.teardown.outcome, 'finished');
});

test('set by the organisation, either way, it is locked', async () => {
  useBuiltInPolicy(org({ workstation: { clearCaseOnClose: true } }));
  const on = await getPolicy({ fresh: true });
  assert.deepEqual(clearsOnClose(on, { clearCaseOnClose: false }), { on: true, locked: true });
  const c = await startDemoFlow('Housing support referral');
  state.settings = { clearCaseOnClose: false };
  assert.equal((await clearCaseAtStart()).outcome, 'closed');
  assert.equal(state.case, null, c.id);
  useBuiltInPolicy(org({ workstation: { clearCaseOnClose: false } }));
  assert.deepEqual(clearsOnClose(await getPolicy({ fresh: true }), { clearCaseOnClose: true }), { on: false, locked: true });
  assert.deepEqual(clearsOnClose(null, {}), { on: true, locked: false });
});

test('the standing line, the question before closing, and the receipt', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'moz-extension://x/sidebar/sidebar.html' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node });
  try {
    const { CLOSE_NOTE, closeNote, closedReceipt, expiryNotice, guardClose, unsubmitted } = await import('../../extension/sidebar/close-warning.js');
    const c = { clips: [{ values: { a: 1 }, records: [] }], resolved: {}, manual: {}, workings: [], forms: [{ id: 'f' }], submitted: {} };
    assert.equal(closeNote({ case: c, policy: null, settings: {} }).textContent, 'This case is deleted when you close Firefox, or after 24 hours without use.');
    assert.equal(closeNote({ case: c, policy: null, settings: { clearCaseAfterHours: 0 } }).textContent, CLOSE_NOTE);
    assert.equal(closeNote({ case: c, policy: null, settings: { clearCaseOnClose: false } }).textContent, 'This case is deleted after 24 hours without use.');
    assert.equal(closeNote({ case: c, policy: null, settings: { clearCaseOnClose: false, clearCaseAfterHours: 8 } }).textContent, 'This case is deleted after 8 hours without use.');
    assert.equal(closeNote({ case: c, policy: null, settings: { clearCaseOnClose: false, clearCaseAfterHours: 0 } }), null);
    assert.equal(closeNote({ case: null }), null);
    assert.equal(unsubmitted(c), true);
    assert.equal(unsubmitted({ ...c, submitted: { f: { at: 't' } } }), false);
    assert.equal(unsubmitted({ ...c, clips: [] }), false);
    let data = { case: c, policy: null, settings: {} };
    guardClose(() => data);
    const ask = () => { const e = new dom.window.Event('beforeunload', { cancelable: true }); dom.window.dispatchEvent(e); return e.defaultPrevented; };
    assert.equal(ask(), true);
    data = { ...data, settings: { clearCaseOnClose: false } };
    assert.equal(ask(), false);
    data = { case: c, policy: null, settings: {} };
    document.body.click();
    assert.equal(ask(), false, 'Power Loader’s own move to a full page isn’t asked about');
    const text = closedReceipt({ outcome: 'closed', at: '2026-11-26T09:00:00Z', counts: { clips: 2, values: 14, decisions: 0, workings: 0 } }).map((n) => n.textContent).join(' ');
    assert.match(text, /Firefox was closed with a case open\. It was deleted: 14 values, 2 pages\. Nothing was sent anywhere\./);
    const expired = closedReceipt({ outcome: 'expired', at: '2026-11-26T09:00:00Z', counts: { clips: 1, values: 3, decisions: 0, workings: 0 } }, 24).map((n) => n.textContent).join(' ');
    assert.match(expired, /left open for more than 24 hours without use\. It was deleted: 3 values, 1 page\. Nothing was sent anywhere\./);
    assert.match(closedReceipt({ outcome: 'expired', hours: 4, at: 't', counts: null }).map((n) => n.textContent).join(' '), /left open for more than 4 hours without use/);
    // The last hour: said, with a way to keep working.
    const now = Date.parse('2026-11-27T08:30:00Z');
    let kept = 0;
    const soon = expiryNotice({ case: { ...c, touchedAt: '2026-11-26T09:00:00Z' }, policy: null, settings: {} }, () => { kept++; }, now);
    assert.match(soon.textContent, /deleted after 24 hours without use\..*goes in about 30 minutes\. Anything you do in it keeps it/);
    soon.querySelector('[data-key=expiry-keep]').click();
    assert.equal(kept, 1);
    assert.equal(expiryNotice({ case: { ...c, touchedAt: '2026-11-27T07:00:00Z' }, policy: null, settings: {} }, () => {}, now), null);
    assert.equal(expiryNotice({ case: { ...c, touchedAt: '2026-11-26T09:00:00Z' }, policy: null, settings: { clearCaseAfterHours: 0 } }, () => {}, now), null);
    // A short time warns a sixth of it before: 10 minutes on a 1 hour limit, never longer than the limit.
    const hourCase = { ...c, touchedAt: '2026-11-27T07:45:00Z' };
    assert.equal(expiryNotice({ case: hourCase, policy: null, settings: { clearCaseAfterHours: 1 } }, () => {}, Date.parse('2026-11-27T08:30:00Z')), null, '15 minutes left: not yet');
    assert.match(expiryNotice({ case: hourCase, policy: null, settings: { clearCaseAfterHours: 1 } }, () => {}, Date.parse('2026-11-27T08:37:00Z')).textContent, /after 1 hour without use.*about 8 minutes/);
    assert.equal(closeNote({ case: c, policy: null, settings: { clearCaseAfterHours: 0.5 } }).textContent, 'This case is deleted when you close Firefox, or after 30 minutes without use.');
  } finally { delete globalThis.window; delete globalThis.document; delete globalThis.Node; }
});

test('a case left without use for longer than clearCaseAfterHours is deleted, with its own outcome', async () => {
  const c = await startDemoFlow('Housing support referral');
  await updateCase(c.id, (cs, lib) => addClip(cs, lib, clip({ firstName: 'Maria' })));
  const used = Date.parse(state.case.touchedAt);
  assert.equal(await clearExpiredCase(used + 23 * 3600_000), null, 'not yet');
  assert.equal(state.case.id, c.id);
  state.settings = { clearCaseAfterHours: 0 };
  assert.equal(await clearExpiredCase(used + 100 * 3600_000), null, '0 is never');
  state.settings = {};
  const receipt = await clearExpiredCase(used + 25 * 3600_000);
  assert.equal(receipt.outcome, 'expired');
  assert.equal(state.case, null);
  assert.equal(state.processLog.at(-1).outcome, 'expired');
  assert.equal(state.processLog.at(-1).events.at(-1).activity, 'expire_case');
  assert.ok(!JSON.stringify(state).includes('Maria'));
});

test('clearCaseAfterHours: 24 by default, in half hours, the caseworker’s to change; a fixed value or a maximum', async () => {
  const { hoursError, cleanHours } = await import('../../extension/lib/teardown.js');
  assert.deepEqual(clearsAfter(null, {}), { hours: 24, locked: false, max: null });
  assert.deepEqual(clearsAfter(null, { clearCaseAfterHours: 8 }), { hours: 8, locked: false, max: null });
  assert.deepEqual(clearsAfter(null, { clearCaseAfterHours: 0.3 }), { hours: 0.5, locked: false, max: null }, 'lowest half an hour');
  assert.equal(cleanHours(2.3), 2.5);
  // Fixed: locked, whatever the caseworker chose.
  useBuiltInPolicy(org({ workstation: { clearCaseAfterHours: 4 } }));
  const fixed = await getPolicy({ fresh: true });
  assert.deepEqual(clearsAfter(fixed, { clearCaseAfterHours: 0 }), { hours: 4, locked: true, max: null });
  assert.match(hoursError(fixed, 2), /organisation has set this/);
  // A maximum: lower choices stand, higher ones and never are held at it, and refused in Settings.
  useBuiltInPolicy(org({ workstation: { clearCaseMaxHours: 9 } }));
  const capped = await getPolicy({ fresh: true });
  assert.deepEqual(clearsAfter(capped, {}), { hours: 9, locked: false, max: 9 }, 'the default 24 is held at the maximum');
  assert.deepEqual(clearsAfter(capped, { clearCaseAfterHours: 4 }), { hours: 4, locked: false, max: 9 });
  assert.deepEqual(clearsAfter(capped, { clearCaseAfterHours: 12 }), { hours: 9, locked: false, max: 9 });
  assert.deepEqual(clearsAfter(capped, { clearCaseAfterHours: 0 }), { hours: 9, locked: false, max: 9 });
  assert.equal(hoursError(capped, 4), null);
  assert.match(hoursError(capped, 12), /allows 9 hours at most/);
  assert.match(hoursError(capped, 0), /“never” can’t be chosen/);
  // Both: the fixed value wins.
  useBuiltInPolicy(org({ workstation: { clearCaseAfterHours: 2, clearCaseMaxHours: 9 } }));
  assert.equal(clearsAfter(await getPolicy({ fresh: true }), { clearCaseAfterHours: 8 }).hours, 2);
});

test('the checker: halves only, and a fixed time above the maximum is warned about', async () => {
  const { checkPolicy } = await import('../../tools/policy.mjs');
  const doc = (ws) => ({ schema: 'powerloader-policy/1', name: 'Example Council', build: { id: 'powerloader@example.gov.uk', updateUrl: 'https://addons.example.gov.uk/u.json' }, policy: { workstation: ws } });
  assert.ok(checkPolicy(doc({ clearCaseAfterHours: 0.3 })).errors.some((e) => /in halves/.test(e)));
  assert.ok(checkPolicy(doc({ clearCaseMaxHours: 0 })).errors.some((e) => /at least 0\.5/.test(e)));
  assert.ok(checkPolicy(doc({ clearCaseAfterHours: 8, clearCaseMaxHours: 4 })).warnings.some((w) => /above workstation\.clearCaseMaxHours/.test(w)));
  assert.ok(checkPolicy(doc({ clearCaseAfterHours: 24 })).warnings.some((w) => /Most organisations will want no more than 9 hours/.test(w)));
  assert.deepEqual(checkPolicy(doc({ clearCaseAfterHours: 4 })), { errors: [], warnings: [] });
});

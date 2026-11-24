import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { demoSet } from './helpers/library.js';
import { startCase, updateCase, getCase } from '../../extension/lib/core.js';
import { endCase, completeTeardown, CASE_ENDED } from '../../extension/lib/teardown.js';
import { addClip, setManual } from '../../extension/lib/case.js';

let state, session, failWrite, failSessionDelete, commits, messages;
let listener;
const set = demoSet();
globalThis.browser = {
  storage: {
    local: {
      get: async (keys) => structuredClone(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((key) => key in state).map((key) => [key, state[key]]))),
      set: async (patch) => {
        if (failWrite) { failWrite = false; throw new Error('Disk full'); }
        Object.assign(state, structuredClone(patch));
      },
      clear: async () => { state = {}; },
    },
    session: { remove: async (keys) => {
      if (failSessionDelete) { failSessionDelete = false; throw new Error('Session storage unavailable'); }
      for (const k of keys) delete session[k];
    } },
  },
  runtime: {
    id: 'test-extension', getURL: (path) => path,
    onMessage: { addListener: (fn) => { listener = fn; } },
    sendMessage: async (message) => {
      if (message.type === CASE_ENDED) { messages.push(message); return undefined; }
      commits++;
      return listener(structuredClone(message), { id: 'test-extension' });
    },
  },
};
// The writer runs in a distinct module instance, as in the background; core.js talks to it by message.
const source = readFileSync(new URL('../../extension/lib/storage.js', import.meta.url), 'utf8');
const background = await import(`data:text/javascript,${encodeURIComponent(source)}#background`);
background.registerStorageWriter();
const secondClient = await import(`data:text/javascript,${encodeURIComponent(source)}#sidebar-2`);

beforeEach(() => {
  state = { library: { current: set.commit, sets: { [set.commit]: set } } };
  session = { fullPage: { tabId: 1 }, caseDrafts: { 'man-reason': 'typed' }, aiCredential: { key: 'kept' } };
  failWrite = false;
  failSessionDelete = false;
  commits = 0;
  messages = [];
});

const clip = (values, source = 'p|u') => ({ source, kind: 'page', profile: { id: 'p', version: 'v1' }, name: 'Page', url: 'https://cm.example/clients/C-1', values, records: [], extra: {} });

test('a case needs the library, and only one case is open at a time', async () => {
  await assert.rejects(startCase([]), /at least one form/);
  const c = await startCase(['hsr'], { ref: 'CM-1' });
  assert.equal(state.case.id, c.id);
  assert.equal(state.case.log[0].activity, 'start_case');
  await assert.rejects(startCase(['dhp']), /one case at a time/);
  state = {};
  await assert.rejects(startCase(['hsr']), /Connect the forms library/);
});

test('overlapping updates from two contexts both land', async () => {
  const c = await startCase(['hsr']);
  await Promise.all([
    updateCase(c.id, (cs, lib) => addClip(cs, lib, clip({ firstName: 'Maria' }))),
    secondClient.mutateStorage(({ case: cs }) => { cs.manual.reason = 'From another context'; return { patch: { case: cs } }; }, ['case']),
    updateCase(c.id, (cs) => setManual(cs, 'riskLevel', 'High')),
  ]);
  assert.equal(state.case.clips.length, 1);
  assert.equal(state.case.manual.reason, 'From another context');
  assert.equal(state.case.manual.riskLevel, 'High');
  assert.ok(commits > 3, 'stale clients retried their mutations');
});

test('a result that arrives after Finish is dropped, not written into storage', async () => {
  const c = await startCase(['hsr']);
  await updateCase(c.id, (cs, lib) => addClip(cs, lib, clip({ firstName: 'Maria' })));
  const receipt = await endCase(c.id, 'finished');
  assert.deepEqual(receipt.counts, { clips: 1, values: 1, decisions: 0, workings: 0 });
  await assert.rejects(updateCase(c.id, (cs, lib) => addClip(cs, lib, clip({ lastName: 'Late' }))), { name: 'CaseEnded' });
  assert.equal(state.case, null);
  assert.equal(await getCase(), null);
  assert.deepEqual(messages, [{ type: CASE_ENDED, caseId: c.id }]);
});

test('teardown archives the log without values or real links, and clears case view state', async () => {
  const c = await startCase(['hsr'], { page: { type: 'cm/client-record@v3', pattern: 'https://cm.example/clients/{clientId}', url: 'https://cm.example/clients/C-1042' } });
  await updateCase(c.id, (cs, lib) => addClip(cs, lib, clip({ firstName: 'Maria', nino: 'QQ123456C' })));
  await endCase(c.id, 'discarded');
  const [kept] = state.processLog;
  assert.equal(kept.outcome, 'discarded');
  assert.equal(kept.case_id, c.id);
  const text = JSON.stringify(kept);
  for (const leak of ['Maria', 'QQ123456C', 'C-1042', 'CM-']) assert.ok(!text.includes(leak), `log holds ${leak}`);
  assert.deepEqual(kept.events.map((e) => e.activity), ['start_case', 'visit_page', 'discard_case']);
  assert.equal(kept.events[1].url_pattern, 'https://cm.example/clients/{clientId}');
  assert.deepEqual(Object.keys(session), ['aiCredential']);
  assert.equal(state.teardown, null);
  assert.equal(state.receipt.outcome, 'discarded');
  assert.ok(!JSON.stringify(state.receipt).includes('Maria'));
});

test('a teardown interrupted by a closed browser completes at the next start', async () => {
  const c = await startCase(['hsr']);
  state.teardown = { caseId: c.id, outcome: 'finished', startedAt: 'earlier' };
  assert.equal(await getCase(), null, 'a case being deleted is never offered again');
  await assert.rejects(updateCase(c.id, () => {}), { name: 'CaseEnded' });
  const receipt = await completeTeardown();
  assert.equal(receipt.outcome, 'finished');
  assert.equal(state.case, null);
  assert.equal(state.processLog.length, 1);
  assert.equal(state.teardown, null);
  assert.equal(await completeTeardown(), null);
});

test('a failed commit leaves the case as it was, and later commits still run', async () => {
  const c = await startCase(['hsr']);
  failWrite = true;
  await assert.rejects(updateCase(c.id, (cs) => setManual(cs, 'reason', 'lost')), /Disk full/);
  assert.equal(state.case.manual.reason, undefined);
  await updateCase(c.id, (cs) => setManual(cs, 'reason', 'kept'));
  assert.equal(state.case.manual.reason, 'kept');
});

test('failed transient-data deletion remains recoverable and does not duplicate the archived log', async () => {
  const c = await startCase(['hsr']);
  failSessionDelete = true;
  await assert.rejects(endCase(c.id, 'discarded'), /Session storage unavailable/);
  assert.equal(state.case, null);
  assert.ok(state.teardown, 'Keep checkpoint until all case data has been deleted');
  assert.equal(state.processLog.length, 1);
  const receipt = await completeTeardown();
  assert.equal(receipt.outcome, 'discarded');
  assert.equal(state.processLog.length, 1, 'Recovery must not archive twice');
  assert.equal(state.teardown, null);
  assert.deepEqual(Object.keys(session), ['aiCredential']);
});

test('wiping storage is serialised behind the writer', async () => {
  await startCase(['hsr']);
  await secondClient.wipeStorage();
  assert.deepEqual(Object.keys(state), ['storageRevision']);
});

test('the writer refuses unknown keys and senders', async () => {
  await assert.rejects(secondClient.mutateStorage(() => ({ patch: { evil: 1 } }), ['case']), /Invalid storage mutation/);
  await assert.rejects(listener({ type: 'powerloader:storage-commit', revision: 0, patch: {} }, { id: 'other' }), /Invalid storage sender/);
});

test('full extension tabs may commit, while web content scripts cannot', async () => {
  browser.runtime.getURL = (path) => `moz-extension://powerloader/${path}`;
  const message = { type: 'powerloader:storage-commit', revision: 0, patch: { starred: ['dhp'] } };
  for (const url of ['https://cm.example/client', 'https://evil.example/moz-extension://powerloader/', 'moz-extension://powerloader.evil/case/case.html', undefined]) {
    await assert.rejects(listener(message, { id: browser.runtime.id, tab: { id: 3 }, url }), /Invalid storage sender/);
  }
  assert.equal(await listener(message, { id: browser.runtime.id, tab: { id: 4 }, url: 'moz-extension://powerloader/case/case.html' }), true);
  assert.deepEqual(state.starred, ['dhp']);
});

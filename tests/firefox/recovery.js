import { config, test, assert, equal, until, state, control, journal } from './harness.js';
import { startCase, getLibrary, updateCase } from '../../lib/core.js';
import { addClip } from '../../lib/case.js';
import { syncLibrary } from '../../lib/library-sync.js';
import { endCase, CASE_SESSION_KEYS } from '../../lib/teardown.js';

const marker = 'SYNTHETIC-RESTART-PRIVATE';
export async function seedRecovery() {
  const old = await state();
  assert(!old.case, 'Previous test case finished');
  await startCase(['dhp'], { ref: marker });
  const active = (await state()).case;
  const lib = await getLibrary();
  await updateCase(active.id, (c) => addClip(c, lib, {
    id: 'restart-synthetic', name: 'Synthetic restart evidence', kind: 'document', values: { firstName: marker }, records: [], capturedAt: new Date().toISOString(), url: `${config.base}/demo/client-PRIVATE.html`, profile: { id: 'qa', version: 'v1' }, quotes: {},
  }));
  await browser.storage.session.set(Object.fromEntries(CASE_SESSION_KEYS.map((key) => [key, { text: marker }])));
  const c = (await state()).case;
  const priorLogs = old.processLog?.length || 0;
  await browser.storage.local.set({ qaRecovery: { commit: old.library.current, logCount: priorLogs + 1, caseId: c.id } });
  if (config.phase === 'main') {
    // Fault injection at the durable checkpoint created by endCase(), before archival.
    await browser.storage.local.set({ teardown: { caseId: c.id, outcome: 'discarded', startedAt: new Date().toISOString() } });
    // Stop while a real library update is waiting for a file response. It must not replace current.
    await control({ library: 'hang' });
    const count = (await journal()).filter((entry) => entry.path.startsWith('/demo/library/') && !entry.path.endsWith('library.json')).length;
    void syncLibrary().catch(() => {});
    await until(async () => (await journal()).filter((entry) => entry.path.startsWith('/demo/library/') && !entry.path.endsWith('library.json')).length > count, 'library file download suspended');
  } else {
    // Fault injection after archival committed but before teardown's final marker was cleared.
    const receipt = await endCase(c.id, 'discarded');
    await browser.storage.local.set({ teardown: { caseId: c.id, outcome: 'discarded', startedAt: receipt.at, receipt } });
  }
}
export async function recovery() {
  await test('Browser restart completes interrupted deletion without duplicate logs', async () => {
    const expected = (await state()).qaRecovery;
    assert(expected, 'Recovery checkpoint survived a real Firefox restart');
    const stored = await until(async () => {
      const current = await state();
      return current.case === null && current.teardown === null && current.receipt ? current : null;
    }, 'original background startup recovery');
    equal(stored.processLog.length, expected.logCount, 'Exactly one retained log per ended case');
    equal(stored.receipt.outcome, 'discarded', 'Recovery receipt preserved');
    assert(!JSON.stringify({ case: stored.case, receipt: stored.receipt, logs: stored.processLog }).includes(marker), 'Case marker absent from case/receipt/retained logs');
    const session = await browser.storage.session.get(CASE_SESSION_KEYS);
    equal(Object.keys(session), [], 'Transient view data cleared');
    equal(stored.library.current, expected.commit, 'Interrupted update retained the known-good library');
    assert(stored.library.sets[expected.commit], 'Verified library files survived');
    assert(stored.settings.library.baseUrl, 'Settings survived recovery');
  });
}

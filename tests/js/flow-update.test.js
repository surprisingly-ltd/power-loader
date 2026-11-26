// updateCaseFlow() (lib/core.js): the open case takes a flow changed since it started, only when asked (D17).
// Clips, decisions, values typed and steps done are kept; a step that's gone drops out; a flow that has lost a
// form the case filled is refused, and so is a case that has ended. Logged with the flow's name only.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import '../../extension/lib/extract.js';
import { demoSet, demoLibrary } from './helpers/library.js';
import { changedFlowFor, startFlowCase, updateCase, updateCaseFlow } from '../../extension/lib/core.js';
import { markStep } from '../../extension/lib/journey.js';
import { pagesOf, removePage } from '../../extension/lib/flows.js';
import { DEMO_FLOWS, makeDemoFlow } from '../../tools/build-demo-flows.mjs';

let state;
let listener;
globalThis.browser = {
  storage: { local: {
    get: async (keys) => structuredClone(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in state).map((k) => [k, state[k]]))),
    set: async (patch) => { Object.assign(state, structuredClone(patch)); },
  }, session: { remove: async () => {} } },
  runtime: { id: 'x', getURL: (p) => p, onMessage: { addListener: (fn) => { listener = fn; } }, sendMessage: async (m) => listener(structuredClone(m), { id: 'x' }) },
};
const source = readFileSync(new URL('../../extension/lib/storage.js', import.meta.url), 'utf8');
(await import(`data:text/javascript,${encodeURIComponent(source)}#background`)).registerStorageWriter();

const set = demoSet();
const lib = demoLibrary();
const review = () => makeDemoFlow(lib, DEMO_FLOWS.find((f) => f.name === 'Rent support review'));
let flow;
beforeEach(() => {
  flow = review();
  state = { library: { current: set.commit, sets: { [set.commit]: set } }, flows: [flow] };
});
const change = async (fn) => {
  const f = state.flows[0];
  fn(f);
  f.updated = new Date(Date.now() + 1000).toISOString();
  state.flows = [f];
};

test('the case takes the changed flow: clips, decisions and done steps kept, a removed step dropped, logged by name', async () => {
  const c = await startFlowCase(flow.id, { ref: '1001' });
  const caseStep = pagesOf(flow, 'input').find((p) => p.profileId === 'cm/case');
  const email = pagesOf(flow, 'email').find((p) => p.name === 'Tell the income team');
  await updateCase(c.id, (cs) => {
    cs.clips.push({ id: 'k1', source: 'cm/case|u', kind: 'page', profile: { id: 'cm/case', version: 'v1' }, name: 'Case', url: 'u', values: { lastName: 'Kowalska' }, records: [], extra: {}, capturedAt: 'now' });
    cs.resolved.lastName = 'Kowalska';
    cs.manual.reason = 'typed';
    markStep(cs, caseStep.id, true);
    markStep(cs, email.id, true);
  });
  assert.equal(changedFlowFor(state.case, state.flows, state.library.sets[state.case.library.commit]), null, 'unchanged: nothing offered');
  await change((f) => removePage(f, email.id));
  assert.equal(changedFlowFor(state.case, state.flows, state.library.sets[state.case.library.commit])?.id, flow.id, 'changed: offered');
  const before = state.case.library.commit;
  await updateCaseFlow(c.id, flow.id);
  const after = state.case;
  assert.notEqual(after.library.commit, before, 'a new set');
  assert.ok(state.library.sets[after.library.commit] && !state.library.sets[before], 'the old flow set goes, the new one is pinned');
  assert.ok(state.library.sets[set.commit], 'the library stays');
  assert.deepEqual(after.clips.map((x) => x.id), ['k1']);
  assert.equal(after.resolved.lastName, 'Kowalska');
  assert.equal(after.manual.reason, 'typed');
  assert.equal(after.ref, '1001');
  assert.ok(after.steps[caseStep.id]?.done, 'a step done stays done');
  assert.equal(after.steps[email.id], undefined, 'a step that no longer exists drops out');
  const ev = after.log.find((e) => e.activity === 'update_flow');
  assert.equal(ev.detail, 'Rent support review');
  assert.doesNotMatch(JSON.stringify(ev), /Tell the income team|cm\/case|steps/, 'never its contents');
});

test('a flow that has lost a form the case filled is refused; so is a case that has ended', async () => {
  const c = await startFlowCase(flow.id, { ref: '1001' });
  await updateCase(c.id, (cs) => { cs.filled.rsr = { at: 'now', items: [] }; });
  await change((f) => { const out = pagesOf(f, 'output')[0]; f.pages.splice(f.pages.indexOf(out), 1); });
  await assert.rejects(updateCaseFlow(c.id, flow.id), /no longer has rsr, which this case has filled|Make a form to fill first/);
  assert.equal(state.case.library.commit, c.library.commit, 'the case is unchanged');
  state.flows = [review()];
  state.flows[0].id = flow.id;
  delete state.case;
  await assert.rejects(updateCaseFlow(c.id, flow.id), /That case has ended/);
});

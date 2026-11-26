// The on-device privacy model is used by default. Policy, the library or the caseworker can switch it off;
// policy and the library can lock their choice. Off, nothing is scanned or required, and the preview says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRIVACY_MODEL_DEFAULT, modelSource, modelUse } from '../../extension/lib/model-fetch.js';
import { validatePrivacy } from '../../extension/lib/privacy-detect.js';
import { prepare, review } from '../../extension/lib/ai/boundary.js';
import { effectiveSettings } from '../../extension/lib/privacy-detect.js';

const policy = (privacyModel, locked = []) => ({ values: { privacyModel: { required: true, use: null, ...privacyModel } }, locked: new Set(locked) });
const lib = (use) => ({ privacy: { patterns: [], ...(use ? { use } : {}) } });
const mine = (useModel) => ({ privacy: { useModel } });

test('on by default; the caseworker can turn it off; the library sets a default or locks it; policy locks it', () => {
  assert.equal(PRIVACY_MODEL_DEFAULT, true);
  assert.deepEqual(modelUse(policy({}), null, {}), { on: true, locked: false, from: 'default' });
  assert.deepEqual(modelUse(policy({}), null, mine(false)), { on: false, locked: false, from: 'you' });
  assert.deepEqual(modelUse(policy({}), lib({ on: false }), {}), { on: false, locked: false, from: 'library' });
  assert.deepEqual(modelUse(policy({}), lib({ on: false }), mine(true)), { on: true, locked: false, from: 'you' }, 'a library default the caseworker can change');
  assert.deepEqual(modelUse(policy({}), lib({ on: false, lock: true }), mine(true)), { on: false, locked: true, from: 'library' });
  assert.deepEqual(modelUse(policy({ use: false }, ['privacyModel.use']), lib({ on: true, lock: true }), mine(true)), { on: false, locked: true, from: 'policy' });
  assert.deepEqual(modelUse(policy({ required: true }, ['privacyModel.required']), lib({ on: false, lock: true }), mine(false)), { on: true, locked: true, from: 'policy' }, 'an organisation that requires it keeps it on');
  // The default required: true isn't the organisation's choice: it doesn't lock the model on.
  assert.equal(modelUse(policy({}), null, mine(false)).on, false);
});

test('off, the model isn’t required before sending; the library’s use setting is validated', () => {
  assert.equal(modelSource(policy({}), null, mine(false)).required, false);
  assert.equal(modelSource(policy({}), null, {}).required, true);
  assert.deepEqual(validatePrivacy({ patterns: [], use: { on: false, lock: true } }), []);
  assert.deepEqual(validatePrivacy({ patterns: [], use: { on: 'no' } }), ['"use" must be { on: true or false, lock: true or false }']);
});

test('the preview with the model off still redacts case values, isn’t blocked, and knows the model is off', () => {
  const context = { known: [{ category: 'person_name', text: 'Maria Kowalska' }], patterns: [], modelSpans: {}, settings: effectiveSettings({}, {}), identifierTypes: {}, model: { ready: false, required: false, off: true, offBy: 'you' } };
  const state = prepare({ purpose: 'test', parts: [{ id: 'p', label: 'Page', text: 'Tenant Maria Kowalska owes rent.' }], compose: (t) => [{ role: 'user', content: t.p }] }, context);
  const r = review(state);
  assert.equal(r.blocked, null);
  assert.ok(!r.parts[0].sent.includes('Kowalska'), 'the case’s own values are still redacted');
  assert.equal(state.context.model.off, true);
});

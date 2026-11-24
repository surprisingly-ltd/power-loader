import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoLibrary, extractDemo } from './helpers/library.js';
import {
  addClip, addForm, caseKeys, caseText, clipDependents, clipFromExtract, clipImpact, conflictKeys, decide, excludeValue,
  fieldState, fillStale, formProgress, identityWarnings, markSubmitted, neededBy, newCase, notNeededKeys, removeClip,
  removeForm, setManual, unmarkSubmitted,
} from '../../extension/lib/case.js';
import { validateValue, checkRules } from '../../extension/lib/fields.js';

const lib = demoLibrary();
const clip = (page, profileId) => {
  const { profile, res } = extractDemo(lib, page, profileId);
  return clipFromExtract(lib, profile, res, { capturedAt: '2026-10-19T10:00:00Z' });
};
const maria = () => clip('client-1042.html', 'cm/client-record');
const rent = () => clip('rent-account-1042.html', 'harbour-homes/rent-account');
const employment = () => clip('employment-1042.html', 'biv/employment');
const david = () => clip('client-2077.html', 'cm/client-record');

test('a case starts only from library forms and pins their versions', () => {
  assert.throws(() => newCase(lib, []), /at least one form/);
  assert.throws(() => newCase(lib, ['nope']), /isn’t in the library/);
  const c = newCase(lib, ['hsr', 'dhp'], { ref: ' CM-1 ' });
  assert.deepEqual(c.forms, [{ id: 'hsr', version: 'v4' }, { id: 'dhp', version: 'v2' }]);
  assert.equal(c.library.commit, lib.commit);
  assert.equal(c.ref, 'CM-1');
  assert.match(c.id, /^case-[0-9a-f]{6}$/);
  assert.ok(caseKeys(c, lib).includes('landlord') && caseKeys(c, lib).includes('phone'));
  assert.deepEqual(neededBy(c, lib, 'phone'), ['hsr']);
  assert.deepEqual(neededBy(c, lib, 'firstName'), ['hsr', 'dhp']);
});

test('clips agree across formats and disagreements become conflicts', () => {
  const c = newCase(lib, ['hsr', 'dhp']);
  const first = addClip(c, lib, maria());
  assert.ok(first.added.includes('firstName'));
  const second = addClip(c, lib, rent());
  assert.deepEqual(second.conflicts, ['phone']);
  assert.ok(second.agreed.includes('postcode') && second.agreed.includes('address'));
  assert.equal(second.records, 11);
  assert.equal(fieldState(c, lib, 'monthlyRent').value, '725.00');
  assert.deepEqual(conflictKeys(c, lib), ['phone']);
});

test('a decision reopens when the candidates it chose between change', () => {
  const c = newCase(lib, ['hsr']);
  addClip(c, lib, maria());
  addClip(c, lib, rent());
  decide(c, lib, 'phone', '07700 900456');
  assert.equal(fieldState(c, lib, 'phone').status, 'resolved');
  const third = { ...maria(), source: 'manual-note', values: { phone: '07700 900999' } };
  addClip(c, lib, third);
  const st = fieldState(c, lib, 'phone');
  assert.equal(st.status, 'conflict');
  assert.equal(st.reopened, true);
  assert.equal(st.previous, '07700 900456');
});

test('re-clipping keeps exclusions unless the value changed', () => {
  const c = newCase(lib, ['hsr']);
  const { clipId } = addClip(c, lib, maria());
  excludeValue(c, clipId, 'email');
  excludeValue(c, clipId, 'phone');
  const again = maria();
  again.values.phone = '07700 111111';
  addClip(c, lib, again);
  assert.equal(c.clips.length, 1);
  assert.equal(c.clips[0].revision, 2);
  assert.deepEqual(c.excluded, [`${clipId}:email`]);
});

test('identity check flags another person, but not a name spelt differently', () => {
  const c = newCase(lib, ['hsr', 'dhp']);
  addClip(c, lib, maria());
  const emp = addClip(c, lib, employment());
  assert.deepEqual(emp.identity, []);
  const other = addClip(c, lib, david());
  assert.ok(other.identity.includes('dob') && other.identity.includes('nino'));
  assert.equal(identityWarnings(c).length, 1);
});

test('ready to fill needs valid values and library rules, not just presence', () => {
  const c = newCase(lib, ['dhp']);
  addClip(c, lib, maria());
  addClip(c, lib, rent());
  addClip(c, lib, employment());
  setManual(c, 'reason', 'Arrears after sickness');
  decide(c, lib, 'lastName', 'Kowalska');
  let p = formProgress(c, lib, 'dhp', '2026-10-19');
  assert.equal(p.ready, true, JSON.stringify(p));
  setManual(c, 'monthlyRent', 'seven hundred');
  p = formProgress(c, lib, 'dhp', '2026-10-19');
  assert.equal(p.ready, false);
  assert.deepEqual(p.invalid, ['monthlyRent']);
  assert.equal(fieldState(c, lib, 'monthlyRent').error, 'Not an amount of money');
  setManual(c, 'monthlyRent', '');
  setManual(c, 'tenancyStart', '2027-01-01');
  p = formProgress(c, lib, 'dhp', '2026-10-19');
  assert.deepEqual(p.rules.map((r) => r.message), ['The tenancy start must be before today']);
  assert.equal(p.ready, false);
});

test('"Wrong person" removal clears everything that depends on the clip and flags fills', () => {
  const c = newCase(lib, ['hsr']);
  addClip(c, lib, maria());
  const { clipId } = addClip(c, lib, david());
  decide(c, lib, 'firstName', 'David');
  setManual(c, 'nino', 'QQ987654A');
  c.workings.push({ id: 'w1', title: 'Arrears', text: '…', uses: [clipId] });
  c.aiPeriods.push({ id: 'p1', clipId, accepted: true });
  c.filled.hsr = { at: 'now', items: [{ box: '#firstName', key: 'firstName', value: 'David', clips: [clipId] }] };
  const deps = clipDependents(c, lib, clipId);
  assert.deepEqual(deps.choices, ['firstName']);
  assert.deepEqual(deps.manual, ['nino']);
  assert.deepEqual(deps.workings, ['w1']);
  assert.deepEqual(deps.filled, ['hsr']);
  assert.ok(clipImpact(c, lib, clipId).conflictsGone.includes('dob'));
  removeClip(c, lib, clipId, { clearDependents: true });
  assert.equal(c.manual.nino, undefined);
  assert.equal(c.resolved.firstName, undefined);
  assert.equal(c.workings.length, 0);
  assert.equal(c.aiPeriods[0].dismissed, true);
  assert.equal(c.filled.hsr.stale.reason, 'removed');
  assert.equal(fieldState(c, lib, 'firstName').value, 'Maria');
  assert.deepEqual(conflictKeys(c, lib), []);
});

test('a fill is stale when the case no longer holds what was filled', () => {
  const c = newCase(lib, ['hsr']);
  addClip(c, lib, maria());
  c.filled.hsr = { at: 'now', items: [{ box: '#phone', key: 'phone', value: '07700 900123', clips: [] }] };
  assert.equal(fillStale(c, lib, 'hsr'), null);
  setManual(c, 'phone', '07700 900456');
  assert.deepEqual(fillStale(c, lib, 'hsr'), { reason: 'changed', keys: ['phone'] });
});

test('removing a target form keeps evidence only it needed, marked not needed', () => {
  const c = newCase(lib, ['hsr', 'dhp']);
  addClip(c, lib, rent());
  assert.throws(() => removeForm({ ...c, forms: [c.forms[0]] }, 'hsr'), /at least one form/);
  removeForm(c, 'dhp');
  assert.ok(notNeededKeys(c, lib).includes('landlord'));
  addForm(c, lib, 'dhp');
  assert.deepEqual(notNeededKeys(c, lib), ['tenancyType']);
});

test('observed submissions are not downgraded to reported', () => {
  const c = newCase(lib, ['hsr', 'dhp']);
  markSubmitted(c, 'dhp', { how: 'observed', ref: 'DHP-20417', at: 't1' });
  markSubmitted(c, 'dhp', { how: 'reported', at: 't2' });
  assert.deepEqual(c.submitted.dhp, { at: 't1', how: 'observed', ref: 'DHP-20417' });
  unmarkSubmitted(c, 'dhp');
  assert.ok(c.submitted.dhp);
  markSubmitted(c, 'hsr', { how: 'reported', at: 't3' });
  unmarkSubmitted(c, 'hsr');
  assert.equal(c.submitted.hsr, undefined);
});

test('case text shows conflicts and sources', () => {
  const c = newCase(lib, ['hsr']);
  addClip(c, lib, maria());
  addClip(c, lib, rent());
  const text = caseText(c, lib);
  assert.match(text, /Telephone: CONFLICT: 07700 900123 \/ 07700 900456/);
  assert.match(text, /First name: Maria {2}\[http:\/\/localhost:8787\/demo\/client-1042\.html, http:\/\/localhost:8787\/demo\/rent-account-1042\.html\]/);
});

test('field validators and rules', () => {
  const v = (type, value, extra = {}) => validateValue({ type, ...extra }, value);
  assert.deepEqual(v('date', '14/07/1986'), { ok: true, value: '1986-07-14' });
  assert.equal(v('date', '31/02/2026').ok, false);
  assert.deepEqual(v('money', '£1,245.6'), { ok: true, value: '1245.60' });
  assert.equal(v('nino', 'QQ 12 34 56 C').ok, true);
  assert.equal(v('nino', 'QQ 12 34 56').ok, false);
  assert.deepEqual(v('postcode', 'ns14ab'), { ok: true, value: 'NS1 4AB' });
  assert.equal(v('phone', '07700 900123').ok, true);
  assert.deepEqual(validateValue({ options: ['Low', 'High'] }, 'high'), { ok: true, value: 'High' });
  assert.equal(validateValue({ options: ['Low', 'High'] }, 'Medium').ok, false);
  assert.deepEqual(checkRules([{ field: 'a', before: 'b', message: 'A first' }], { a: '2026-02-01', b: '2026-01-01' }, '2026-10-19'), [{ field: 'a', keys: ['a', 'b'], message: 'A first' }]);
  assert.deepEqual(checkRules([{ field: 'a', before: 'b' }], { a: '2026-02-01' }, '2026-10-19'), []);
});

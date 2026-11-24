import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoLibrary, extractDemo } from './helpers/library.js';
import { addClip, clipFromExtract, decide, newCase, removeClip, setManual, fillStale } from '../../extension/lib/case.js';
import { approvedItems, buildFillPlan, fillProfileForCase, fillRecord } from '../../extension/lib/fill.js';
import { agentOn } from './helpers/agent.js';

const lib = demoLibrary();
const clip = (page, id) => { const { profile, res } = extractDemo(lib, page, id); return clipFromExtract(lib, profile, res); };

function dhpCase() {
  const c = newCase(lib, ['dhp']);
  addClip(c, lib, clip('client-1042.html', 'cm/client-record'));
  addClip(c, lib, clip('rent-account-1042.html', 'harbour-homes/rent-account'));
  addClip(c, lib, clip('employment-1042.html', 'biv/employment'));
  return c;
}

test('the plan fills settled valid values and lists everything it leaves empty, with reasons', () => {
  const c = dhpCase();
  setManual(c, 'weeklyIncome', 'lots');
  const profile = fillProfileForCase(lib, 'dhp');
  const plan = buildFillPlan(c, lib, 'dhp', profile, [{ selector: '#d-first', label: 'First name' }, { selector: '#extra', label: 'Something else' }]);
  const by = Object.fromEntries(plan.rows.map((r) => [r.key, r]));
  assert.equal(by.firstName.status, 'fill');
  assert.equal(by.firstName.label, 'First name');
  assert.deepEqual(by.firstName.sources, ['Client record', 'Rent account']);
  assert.equal(by.lastName.status, 'conflict');
  assert.equal(by.reason.status, 'missing');
  assert.equal(by.weeklyIncome.status, 'invalid');
  assert.equal(by.monthlyRent.value, '725.00');
  assert.equal(by.dob.value, '1986-07-14');
  assert.deepEqual(plan.unmatched, [{ target: '#extra', label: 'Something else' }]);
  assert.match(plan.sideEffects[0], /looks the claimant up/);
  const items = approvedItems(plan);
  assert.ok(items.every((i) => plan.rows.find((r) => r.target === i.target).status === 'fill'));
  assert.ok(!items.some((i) => i.target === '#d-last'));
});

test('filling sets values only: it clicks nothing, and refuses buttons and ambiguous boxes', async () => {
  const c = dhpCase();
  decide(c, lib, 'lastName', 'Kowalska');
  const plan = buildFillPlan(c, lib, 'dhp', fillProfileForCase(lib, 'dhp'));
  const a = agentOn('dhp.html', { scripts: true });
  let clicks = 0;
  a.doc.addEventListener('click', () => clicks++, true);
  let submitted = 0;
  a.doc.getElementById('dhp').addEventListener('submit', () => submitted++);
  const report = await a.ask({ type: 'powerloader:fill', url: 'http://localhost:8787/demo/dhp.html', plan: { items: [...approvedItems(plan), { target: 'button[type=submit]', value: 'x' }, { target: 'input', value: 'x' }] } });
  assert.equal(clicks, 0);
  assert.equal(submitted, 0);
  assert.equal(a.doc.getElementById('d-last').value, 'Kowalska');
  assert.equal(a.doc.getElementById('d-dob').value, '1986-07-14');
  assert.equal(a.doc.getElementById('d-rent').value, '725.00');
  assert.equal(a.doc.getElementById('d-lookup').textContent, 'Claimant found', 'page side effects run, as the library entry warns');
  assert.deepEqual(report.failed.map((f) => f.reason), ['Not a box Power Loader can fill', '13 boxes match']);
  const record = fillRecord(plan, report);
  assert.equal(record.report.filled.length, report.filled.length);
  assert.ok(record.report.skipped.some((s) => s.label === 'Reason for application'));
  await assert.rejects(a.ask({ type: 'powerloader:fill', url: 'http://localhost:8787/demo/other.html', plan: { items: [] } }), /page changed/);
});

test('removing evidence after a fill flags the form to check again', () => {
  const c = dhpCase();
  decide(c, lib, 'lastName', 'Kowalska');
  const plan = buildFillPlan(c, lib, 'dhp', fillProfileForCase(lib, 'dhp'));
  c.filled.dhp = fillRecord(plan, { filled: approvedItems(plan).map((i) => ({ target: i.target })), failed: [] });
  assert.equal(fillStale(c, lib, 'dhp'), null);
  const rent = c.clips.find((x) => x.name === 'Rent account');
  removeClip(c, lib, rent.id);
  assert.equal(fillStale(c, lib, 'dhp').reason, 'removed');
});

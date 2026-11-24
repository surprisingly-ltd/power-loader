// The in-page agent on the demo pages: pick-mode selectors, label lists and probes.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { agentOn } from './helpers/agent.js';

test('pick mode offers readable values with selectors that use labels and structure, not values', async () => {
  const a = agentOn('client-1042.html');
  const { candidates } = await a.ask({ type: 'powerloader:pickStart', selected: [] });
  const by = Object.fromEntries(candidates.map((c) => [c.value, c.selector]));
  assert.equal(by.Maria, 'label(First name)');
  assert.equal(by['QQ 12 34 56 C'], 'label(NI number)');
  assert.equal(by['07700 900123'], '#c-phone');
  assert.match(by['Maria Kowalska'], /h1/);
  for (const c of candidates) assert.ok(!c.selector.includes(c.value) || c.value.length < 4, `selector ${c.selector} contains its value`);
  const probe = await a.ask({ type: 'powerloader:probe', profile: { fields: { firstName: by.Maria, nino: by['QQ 12 34 56 C'] } } });
  assert.deepEqual(probe.firstName, { count: 1, value: 'Maria' });
  assert.equal(a.doc.querySelectorAll('[data-powerloader-pick]').length, candidates.length);
  // Synthetic clicks from page scripts are not trusted, so they can't pick anything.
  a.doc.querySelector('[data-powerloader-pick]').dispatchEvent(new a.w.MouseEvent('click', { bubbles: true }));
  assert.equal(a.sent.length, 0);
  await a.ask({ type: 'powerloader:pickStop' });
  assert.equal(a.doc.querySelectorAll('[data-powerloader-pick]').length, 0);
  assert.equal(a.doc.getElementById('powerloader-pick-style'), null);
});

test('labels on the page can be added without a pointer', async () => {
  const a = agentOn('rent-account-1042.html');
  const labels = await a.ask({ type: 'powerloader:labels' });
  const by = Object.fromEntries(labels.map((l) => [l.label, l]));
  assert.deepEqual(by['Monthly rent'], { label: 'Monthly rent', selector: '#tenancy label(Monthly rent)', value: '£725.00' });
  const { candidates } = await a.ask({ type: 'powerloader:pickStart', selected: ['#tenancy label(Arrears)'] });
  assert.ok(candidates.some((c) => c.selector === '#tenancy label(Arrears)' && c.value === '£1,245.60'));
  assert.equal(a.doc.querySelector('[data-powerloader-pick="on"]').textContent, '£1,245.60');
});

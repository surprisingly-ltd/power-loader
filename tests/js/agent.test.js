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

// Site rules (docs/plans/site-access-lists.md): ask() checks the tab's address and sends it as atUrl. The agent
// refuses when the page has moved on since, so a pushState or redirect between the check and the act fails safe.
test('every message that reads, fills, draws or captures refuses when the address changed after the check', async () => {
  const a = agentOn('client-1042.html');
  const checked = a.w.location.href;
  const profile = { fields: { firstName: 'label(First name)' } };
  const msgs = [
    { type: 'powerloader:applies', profiles: [profile] }, { type: 'powerloader:extract', profile }, { type: 'powerloader:capture' },
    { type: 'powerloader:describeForm' }, { type: 'powerloader:probe', profile }, { type: 'powerloader:values' }, { type: 'powerloader:labels' },
    { type: 'powerloader:pageText' }, { type: 'powerloader:highlightPII', text: '', spans: [] }, { type: 'powerloader:pickStart', selected: [] },
    { type: 'powerloader:pickSelected', selected: [] }, { type: 'powerloader:overrideStart' }, { type: 'powerloader:annotate', notes: [] },
    { type: 'powerloader:pickTarget' }, { type: 'powerloader:selectRegion' }, { type: 'powerloader:fill', plan: { items: [] } },
  ];
  // Checked here, and still here (a fragment doesn't count): answered.
  const ok = await a.ask({ type: 'powerloader:extract', profile, atUrl: `${checked}#top` });
  assert.equal(ok.data.firstName, 'Maria');
  // The page moves on with pushState (a single-page app), as a page script could between check and read.
  a.w.history.pushState({}, '', '/demo/finance/ledger.html');
  for (const m of msgs) await assert.rejects(a.ask({ ...m, atUrl: checked }), /The page changed: try again/, m.type);
  // Messages that need no check still work.
  assert.deepEqual(await a.ask({ type: 'powerloader:scroll' }), { x: 0, y: 0 });
});

test('notes drawn for an address are taken away when a single-page app moves to another one', async () => {
  const a = agentOn('rent-account-1042.html');
  const notes = [{ id: 'n1', selector: '#payments', type: 'expanded', style: '', nodes: ['Check the payments'] }];
  const out = await a.ask({ type: 'powerloader:annotate', notes, atUrl: a.w.location.href });
  assert.deepEqual(out.shown, ['n1']);
  assert.equal(a.doc.querySelectorAll('powerloader-note').length, 1);
  a.w.history.pushState({}, '', '/demo/finance/ledger.html');
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(a.doc.querySelectorAll('powerloader-note').length, 0);
});

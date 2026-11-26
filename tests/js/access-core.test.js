// The choke points in lib/core.js: every message to the in-page agent is checked against the site rules (policy
// and the caseworker's own here) for the tab's address, sent with the address it was checked for, and never
// injected where everything is blocked; a clip is checked again for the address the agent read; host
// permissions for wholly blocked origins are removed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const tabs = { 1: { id: 1, url: 'https://cm.casework.example/cases/1042' }, 2: { id: 2, url: 'https://finance.casework.example/ledger' }, 3: { id: 3, url: 'https://hr.casework.example/people/7' } };
const local = { settings: { siteAccess: { rules: [{ id: 'mine-hr', effect: 'deny', pattern: 'https://hr.casework.example/people/*', actions: ['annotate', 'fill'] }] } } };
const sent = [];
const injected = [];
const agents = new Set();
let extractUrl = null;
let granted = ['https://cm.casework.example/*', 'https://finance.casework.example/*', 'https://git.casework.example/*', '<all_urls>'];
const removed = [];
globalThis.browser = {
  storage: {
    local: { get: async (keys) => Object.fromEntries([keys].flat().filter((k) => k in local).map((k) => [k, structuredClone(local[k])])) },
    // Policy: IT blocks the finance system for everyone.
    managed: { get: async () => ({ siteAccess: { deny: ['https://finance.casework.example*', 'https://git.casework.example*'] } }) },
  },
  tabs: {
    get: async (id) => structuredClone(tabs[id]),
    sendMessage: async (id, msg) => {
      if (msg.type === 'powerloader:ping') { if (!agents.has(id)) throw new Error('no agent'); return true; }
      sent.push({ id, ...msg });
      if (msg.type === 'powerloader:extract') return { data: {}, url: extractUrl || tabs[id].url, title: 'x' };
      return true;
    },
  },
  scripting: { executeScript: async ({ target }) => { injected.push(target.tabId); agents.add(target.tabId); return []; } },
  permissions: { getAll: async () => ({ origins: [...granted] }), remove: async ({ origins }) => { removed.push(...origins); granted = granted.filter((o) => !origins.includes(o)); return true; } },
};
const { ask, clipTab, pruneBlockedOrigins, messageActions } = await import('../../extension/lib/core.js');

test('ask() checks the tab’s address for what the message does, and sends the address it checked', async () => {
  await ask(1, { type: 'powerloader:extract', profile: {} });
  assert.equal(sent.at(-1).atUrl, tabs[1].url);
  assert.deepEqual(injected, [1]);
  // Policy blocks finance: nothing is injected or sent, whatever the message reads.
  for (const type of ['extract', 'pageText', 'capture', 'describeForm', 'labels', 'pickStart', 'highlightPII', 'fill', 'annotate', 'selectRegion', 'somethingNew']) {
    await assert.rejects(ask(2, { type: `powerloader:${type}` }), (e) => e.name === 'Blocked' && e.rule.layer === 'policy', type);
  }
  // Not even a message that needs no check gets an agent into a page where everything is blocked.
  await assert.rejects(ask(2, { type: 'powerloader:scroll' }), { name: 'Blocked' });
  assert.deepEqual(injected, [1]);
  assert.ok(sent.every((m) => m.id !== 2));
  // The caseworker's rule blocks notes and filling on hr's people pages; reading still works.
  await assert.rejects(ask(3, { type: 'powerloader:annotate', notes: [] }), (e) => e.name === 'Blocked' && e.action === 'annotate' && e.rule.layer === 'mine');
  await assert.rejects(ask(3, { type: 'powerloader:pickTarget' }), (e) => e.action === 'annotate');
  await assert.rejects(ask(3, { type: 'powerloader:fill', plan: { items: [] } }), (e) => e.action === 'fill');
  await ask(3, { type: 'powerloader:pageText' });
  assert.equal(sent.at(-1).atUrl, tabs[3].url);
  // Messages that only scroll or take Power Loader's own marks away aren't checked, and carry no address.
  await ask(1, { type: 'powerloader:clearNotes' });
  assert.equal(sent.at(-1).atUrl, undefined);
  assert.deepEqual(messageActions('powerloader:selectRegion'), ['capture']);
  assert.deepEqual(messageActions('powerloader:pickTarget'), ['read', 'annotate']);
});

test('a clip is checked before reading and again for the address the agent read', async () => {
  await assert.rejects(clipTab('case-1', { id: 2 }, { id: 'p' }), { name: 'Blocked' });
  // The page redirected to finance between the check and the read: the clip is refused, nothing is kept.
  extractUrl = 'https://finance.casework.example/ledger';
  await assert.rejects(clipTab('case-1', { id: 1 }, { id: 'p' }), (e) => e.name === 'Blocked' && e.action === 'read');
  extractUrl = null;
});

test('host permissions for origins the rules block entirely are removed; Power Loader’s own are kept', async () => {
  const drop = await pruneBlockedOrigins({ keep: ['https://git.casework.example/*'] });
  assert.deepEqual(drop, ['https://finance.casework.example/*']);
  assert.deepEqual(granted, ['https://cm.casework.example/*', 'https://git.casework.example/*', '<all_urls>']);
});

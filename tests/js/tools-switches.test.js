// A switch for each tool: policy tools.<name> sets and locks it, unset it's the caseworker's, on by default.
// Off, the tool isn't offered, and its action is refused where it is carried out.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { getPolicy, resolvePolicy, useBuiltInPolicy } from '../../extension/lib/policy.js';
import { OTHER_SWITCHES, TOOL_NAMES, assertTool, setTool, toolState } from '../../extension/lib/tools.js';

const dom = new JSDOM('<!doctype html><body></body>', { url: 'moz-extension://x/sidebar/sidebar.html' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node, HTMLElement: dom.window.HTMLElement });
const org = (policy) => ({ schema: 'powerloader-policy/1', name: 'Example Council', build: { id: 'powerloader@example.gov.uk' }, policy });
let local = {};
let sent = 0;
globalThis.browser = {
  storage: { local: { get: async (k) => structuredClone(Object.fromEntries([k].flat().filter((x) => x in local).map((x) => [x, local[x]]))) }, managed: { get: async () => ({}) } },
  runtime: { id: 'x', getURL: (p) => p, getManifest: () => ({ version: 't' }), sendMessage: async () => { sent++; return {}; } },
  tabs: { sendMessage: async () => { sent++; return { shown: [] }; } },
  scripting: { executeScript: async () => { sent++; return [{ result: true }]; } },
};
afterEach(async () => { useBuiltInPolicy(null); local = {}; sent = 0; await getPolicy({ fresh: true }); });

test('the tools, and the switches that already exist listed with them', () => {
  assert.deepEqual(TOOL_NAMES, ['capture', 'reader', 'calculator', 'timeline', 'notes']);
  assert.deepEqual(OTHER_SWITCHES.map((o) => o.key), ['gateway.enabled', 'siteAccess.backgroundReading', 'assistModel.enabled', 'privacyModel.use']);
});

test('on by default; the caseworker’s to switch; set by policy, locked either way', () => {
  assert.deepEqual(toolState(null, {}, 'capture'), { on: true, locked: false });
  assert.deepEqual(toolState(null, setTool({}, 'capture', false), 'capture'), { on: false, locked: false });
  const off = resolvePolicy(org({ tools: { capture: false, timeline: true } }));
  assert.deepEqual(toolState(off, setTool({}, 'capture', true), 'capture'), { on: false, locked: true });
  assert.deepEqual(toolState(off, setTool({}, 'timeline', false), 'timeline'), { on: true, locked: true });
  assert.deepEqual(setTool({ tools: { reader: false } }, 'notes', false), { tools: { reader: false, notes: false } });
});

test('off, the action is refused where it is carried out: reading policy and settings now', async () => {
  await assert.doesNotReject(assertTool('reader'));
  local.settings = { tools: { reader: false } };
  await assert.rejects(assertTool('reader'), /Reader is turned off\. You can turn it on in Settings/);
  useBuiltInPolicy(org({ tools: { notes: false } }));
  await getPolicy({ fresh: true });
  await assert.rejects(assertTool('notes'), /Your organisation has turned off notes on pages/);
  const { annotateTab } = await import('../../extension/lib/core.js');
  await assert.rejects(annotateTab(1, [{ id: 'n', text: 'x' }]), { name: 'ToolOff' });
  assert.equal(sent, 0, 'nothing was sent to the page');
});

test('off, it isn’t offered: the Tools tab, the reader, a scan step and Settings', async () => {
  const { renderTools, toolBlock } = await import('../../extension/sidebar/tools/tools.js');
  const { readerBlock, stepReader } = await import('../../extension/sidebar/tools/reader-ui.js');
  const policy = resolvePolicy(org({ tools: { calculator: false, capture: false } }));
  const context = (settings = {}) => ({ data: { case: { clips: [], log: [], resolved: {}, manual: {}, workings: [], forms: [] }, policy, settings }, ui: { page: { url: 'https://records.example.gov.uk/' }, info: { access: true, blocked: {} } }, act: { render() {}, setTab() {} }, lib: { fields: {} } });
  const tabs = [renderTools(context())].flat().map((n) => n.textContent).join(' ');
  assert.ok(!/Calculator/.test(tabs) && /Timeline/.test(tabs) && /Reader/.test(tabs));
  assert.match(toolBlock(context(), 'calc').textContent, /Calculator is turned off by your organisation/);
  const reader = readerBlock(context()).flat().filter(Boolean);
  assert.ok(!reader.some((n) => n.querySelector?.('[data-key=rd-region]') || n.getAttribute?.('data-key') === 'rd-region'), 'no ⬚ Select a region');
  assert.ok(reader.some((n) => n.querySelector?.('[data-key=rd-choose]')), 'the reader itself is on');
  assert.match(readerBlock(context({ tools: { reader: false } })).textContent, /Reader is turned off\./);
  assert.match(stepReader(context({ tools: { reader: false } }), { id: 's', name: 'Scan' }).textContent, /Reader is turned off/);
  {
    const { renderSettings } = await import('../../extension/sidebar/settings.js');
    const root = document.createElement('div');
    root.append(...renderSettings({ data: { policy, settings: {}, access: [] }, ui: {}, act: { refresh() {} } }).flat().filter(Boolean));
    const cap = root.querySelector('[data-key=tool-capture]');
    assert.equal(cap.checked, false);
    assert.equal(cap.disabled, true, 'locked by the organisation');
    assert.equal(root.querySelector('[data-key=tool-reader]').disabled, false);
    assert.match(root.querySelector('[data-key=tools-card]').textContent, /✦ Remote AI.*Switched in Settings → ✦ Remote AI/s);
  }
});

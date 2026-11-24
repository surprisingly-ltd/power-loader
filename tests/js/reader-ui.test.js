// The reader in the sidebar: the choice to send a picture as it is (or not, when policy blocks it), and the
// text it read shown, copied or kept in the case even when no field matches it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { demoLibrary } from './helpers/library.js';
import { newCase } from '../../extension/lib/case.js';
import { caseNotes, tools } from '../../extension/sidebar/tools/tools.js';

const { window } = new JSDOM('<!DOCTYPE html><body></body>', { url: 'https://extension.invalid/sidebar/sidebar.html' });
Object.assign(globalThis, { window, document: window.document, Node: window.Node });
globalThis.browser = { runtime: { getURL: (p) => p } };
const { readerBlock, rd } = await import('../../extension/sidebar/tools/reader-ui.js');

const lib = demoLibrary();
const settings = { schemaVersion: 1, aiConsent: '2026-11-24', ai: { baseUrl: 'https://gateway.invalid/v1', model: 'fast' } };
const render = (context) => { document.body.replaceChildren(...[readerBlock(context)].flat(Infinity).filter(Boolean)); return document.body; };
const contextFor = (c, { policy = {} } = {}) => ({
  data: { case: c, settings, policy: { values: { redaction: policy } } }, lib, ui: { page: { url: 'about:blank' } },
  act: { render: () => {}, update: async (fn) => fn(c, lib), setTab: () => {} },
});

test('✦ Enhanced offers to send the picture itself, said plainly, unless policy blocks pictures', () => {
  const c = newCase(lib, ['dhp']);
  tools.mode.reader = 'enhanced';
  let body = render(contextFor(c));
  assert.ok(body.querySelector('[data-key=rd-send-text]').checked, 'reading here first is the default');
  assert.match(body.textContent, /Send the picture itself/);
  assert.match(body.textContent, /The picture can’t be redacted/);
  rd.send = 'image';
  body = render(contextFor(c));
  assert.match(body.textContent, /Sends the picture as it is/);
  body = render(contextFor(c, { policy: { blockImages: true } }));
  assert.equal(body.querySelector('[data-key=rd-send-image]'), null);
  assert.match(body.textContent, /doesn’t allow pictures to be sent/);
  assert.ok(body.querySelector('[data-key=rd-send-text]').checked);
  rd.send = 'text';
  tools.mode.reader = 'standard';
});

test('text that matches no field is shown, and can be kept in the case as a note the ✦ tools read', async () => {
  const c = newCase(lib, ['dhp']);
  rd.result = { name: 'letter.pdf', how: 'file', kind: 'pdf', size: 1200, pages: [{ n: 1, how: 'ocr' }], rows: [], text: 'Dear Sir\nI moved out on 3 March 2026.', chosen: new Set() };
  const body = render(contextFor(c));
  assert.doesNotMatch(body.textContent, /No form fields found/);
  assert.match(body.textContent, /Text read/);
  assert.match(body.querySelector('[data-key=rd-text]').textContent, /moved out on 3 March 2026/);
  assert.ok(body.querySelector('[data-key=rd-copy]'));
  body.querySelector('[data-key=rd-keep]').click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(c.clips.length, 1);
  assert.deepEqual(Object.keys(c.clips[0].values), [], 'no values are made up from it');
  assert.equal(caseNotes(c)[0].text, 'Dear Sir\nI moved out on 3 March 2026.');
  assert.equal(c.log.at(-1).activity, 'read_document');
  assert.doesNotMatch(c.log.at(-1).detail, /March/, 'the log says what was done, not what it said');
  assert.match(render(contextFor(c)).textContent, /✓ Kept in the case/);
  rd.result = null;
});

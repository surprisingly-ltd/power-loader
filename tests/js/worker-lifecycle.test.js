import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { loadModel, scanText, cancelScans, stopWorker } from '../../extension/lib/privacy-client.js';

const workers = [];
globalThis.browser = { storage: { session: { set: async () => {}, get: async () => ({}) } } };
globalThis.Worker = class {
  constructor() { this.messages = []; workers.push(this); }
  postMessage(message) {
    this.messages.push(message);
    // A running inference kernel may complete after cancellation was requested.
    if (message.type === 'load') queueMicrotask(() => this.onmessage?.({ data: { id: message.id, type: 'done', result: { device: 'webgpu', ms: 1 } } }));
    if (message.type === 'scan') setTimeout(() => this.onmessage?.({ data: { id: message.id, type: 'done', result: { spans: [] } } }), 15);
  }
  terminate() { this.terminated = true; }
};
beforeEach(async () => {
  stopWorker(); workers.length = 0;
  await loadModel({ baseUrl: 'https://model.invalid/', revision: 'synthetic' });
});

test('a pre-aborted scan is rejected without sending text to the model worker', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(scanText('synthetic secret', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(workers[0].messages.filter((message) => message.type === 'scan').length, 0);
});

test('cancelling active inference rejects the caller and discards late model results', async () => {
  const controller = new AbortController();
  const pending = scanText('synthetic secret', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(workers[0].messages.filter((message) => message.type === 'cancel').length, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  // A late completion must not break the next case's scan.
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(await scanText('next synthetic case'), []);
});

test('successful scans release their abort listeners', async () => {
  const controller = new AbortController();
  await scanText('synthetic text', { signal: controller.signal });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('ending the worker rejects outstanding scans and releases listeners', async () => {
  const controller = new AbortController();
  const pending = scanText('synthetic secret', { signal: controller.signal });
  stopWorker();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(workers[0].terminated, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('ending a case cancels all scans while keeping the model usable for the next case', async () => {
  const controllers = [new AbortController(), new AbortController()];
  const pending = controllers.map((controller) => scanText('synthetic case data', { signal: controller.signal }));
  cancelScans();
  for (const scan of pending) await assert.rejects(scan, { name: 'AbortError' });
  for (const controller of controllers) assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.notEqual(workers[0].terminated, true);
  assert.deepEqual(await scanText('next synthetic case'), []);
});

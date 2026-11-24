// The page's handle on the privacy model worker. One worker per page: closing the sidebar ends it, and
// the next load reads the files back from the extension's cache (a warm reload).
// State: not-loaded | downloading { loaded, total } | starting | testing | ready { ms, at, device } | failed { reason, message }
/* global browser */
import { recordFailure } from './diagnostics.js';

let worker = null;
let nextId = 1;
const pending = new Map();
const listeners = new Set();
export const model = { state: 'not-loaded' };

function set(patch) {
  Object.keys(model).forEach((k) => delete model[k]);
  Object.assign(model, patch);
  listeners.forEach((fn) => fn(model));
  // Other pages (readiness check, diagnostics) read the state; it holds no case data.
  void browser.storage.session?.set({ modelStatus: { ...model, checkedAt: new Date().toISOString() } }).catch(() => {});
}

export const onModelChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const modelReady = () => model.state === 'ready';

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('../privacy/worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const p = pending.get(data.id);
    if (!p) return;
    if (data.type === 'progress') { p.onProgress?.(data); return; }
    pending.delete(data.id);
    p.cleanup();
    if (data.type === 'done') p.resolve(data.result);
    else p.reject(Object.assign(new Error(data.message), { name: data.name || 'Error', reason: data.reason }));
  };
  worker.onerror = (e) => {
    const err = Object.assign(new Error(e.message || 'The privacy model worker failed to start'), { reason: 'load' });
    for (const p of pending.values()) { p.cleanup(); p.reject(err); }
    pending.clear();
    worker = null;
  };
  return worker;
}

function call(msg, { onProgress, signal } = {}) {
  signal?.throwIfAborted();
  const id = nextId++;
  const w = ensureWorker();
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', cancel);
    const cancel = () => {
      if (!pending.delete(id)) return;
      cleanup();
      try { w.postMessage({ type: 'cancel', cancels: id }); } catch { /* The worker may already have stopped. */ }
      reject(signal.reason || new DOMException('Cancelled', 'AbortError'));
    };
    pending.set(id, { resolve, reject, onProgress, scan: msg.type === 'scan', cleanup });
    signal?.addEventListener('abort', cancel, { once: true });
    try { w.postMessage({ ...msg, id }); }
    catch (error) { pending.delete(id); cleanup(); reject(error); }
  });
}

/** Load and test the model from its source ({ baseUrl, modelId, revision, hashes }). */
export async function loadModel(source) {
  if (!source?.baseUrl || !source.revision || /PLACEHOLDER/.test(source.revision)) {
    set({ state: 'failed', reason: 'config', message: 'No model server address and pinned revision are set yet' });
    return model;
  }
  set({ state: 'starting' });
  try {
    const r = await call({ type: 'load', source }, {
      onProgress: (p) => {
        if (p.phase === 'download') set({ state: 'downloading', loaded: p.loaded, total: p.total });
        else if (p.phase === 'test') set({ state: 'testing' });
      },
    });
    set({ state: 'ready', ...r });
  } catch (e) {
    set({ state: 'failed', reason: e.reason || 'load', message: e.message });
    void recordFailure(`model-${e.reason || 'load'}`);
  }
  return model;
}

/** Spans in text: [{ start, end, label, score, text }]. Empty when the model isn't ready. */
export async function scanText(text, { signal } = {}) {
  if (!modelReady() || !text) return [];
  const r = await call({ type: 'scan', text }, { signal });
  return r.spans;
}

export async function clearModelCache() {
  await call({ type: 'clearCache' }).catch(() => {});
  set({ state: 'not-loaded' });
}

// Teardown: scans in progress for an ended case are cancelled; the loaded model stays for the next case.
export function cancelScans() {
  for (const [id, p] of pending) {
    if (!p.scan) continue;
    worker?.postMessage({ type: 'cancel', cancels: id });
    pending.delete(id);
    p.cleanup();
    p.reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
  }
}

// Ending the worker altogether (Delete all Power Loader data).
export function stopWorker() {
  if (!worker) return;
  worker.terminate();
  worker = null;
  for (const p of pending.values()) { p.cleanup(); p.reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' })); }
  pending.clear();
  if (model.state !== 'ready') set({ state: 'not-loaded' });
  else set({ state: 'not-loaded', note: 'Stopped when the case ended; it reloads from the cache.' });
}

export function describeModel(m = model) {
  if (m.state === 'ready') return `Ready · ${m.device === 'webgpu' ? 'WebGPU' : m.device} · test scan ${(m.ms / 1000).toFixed(1)} s at ${new Date(m.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
  if (m.state === 'downloading') return `Downloading ${Math.round((m.loaded || 0) / 1e6)} of ${Math.round((m.total || 0) / 1e6)} MB`;
  if (m.state === 'starting') return 'Starting on WebGPU…';
  if (m.state === 'testing') return 'Running the test scan…';
  if (m.state === 'failed') {
    const why = { blocked: 'Blocked', denied: 'Refused (401/403)', hash: 'Wrong hash', webgpu: 'No WebGPU adapter', disk: 'Out of disk space', test: 'Test scan failed', config: 'Not set up', unreachable: 'Can’t reach the server' }[m.reason] || 'Failed';
    return `${why}: ${m.message}`;
  }
  return 'Not loaded';
}

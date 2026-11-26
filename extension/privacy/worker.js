// Runs OpenAI Privacy Filter on this computer with Transformers.js, off the page's main thread. The model
// comes only from the chosen model server (Hugging Face by default), at a pinned revision, and each file is
// checked against its expected SHA-256 as it downloads. "Ready" means it loaded on WebGPU and passed a test scan.
// Protocol: { id, type: 'load' | 'scan' | 'cancel' | 'clearCache', ... } in; { id, type: 'progress' | 'done' | 'error', ... } out.
import { env, pipeline } from '../vendor/transformers.min.js';
import { chunkText, locate } from '../lib/pii.js';
import { failure, filesRoot, transformersPaths, verifyingFetch } from '../lib/model-fetch.js';

env.allowLocalModels = false;
// ONNX Runtime's WebGPU backend still loads its WASM runtime; serve it from the extension.
// Outside Chrome the WASM cache re-imports the loader from a blob: URL, which the extension
// CSP (script-src 'self') blocks, so import it straight from the extension instead.
env.useWasmCache = false;
env.backends.onnx.wasm.wasmPaths = {
  mjs: new URL('../vendor/ort-wasm-simd-threaded.asyncify.mjs', import.meta.url).href,
  wasm: new URL('../vendor/ort-wasm-simd-threaded.asyncify.wasm', import.meta.url).href,
};
const CACHE = 'transformers-cache';
// A fixed sample with known findings: the test scan must find a name and an address in it.
const SAMPLE = 'Maria Kowalska lives at Flat 3, 12 Mill Lane, Northtown.';

let classifier = null;
let loaded = null; // the source the classifier came from
let loading = null;
const cancelled = new Set();

async function checkWebGPU() {
  // Every quantized export of this model needs WebGPU kernels; the unquantized model is too large for WASM.
  if (!globalThis.navigator?.gpu) throw failure('webgpu', 'This browser doesn’t offer WebGPU to extensions, which the model needs');
  const adapter = await navigator.gpu.requestAdapter().catch(() => null);
  if (!adapter) throw failure('webgpu', 'WebGPU is available but found no usable graphics adapter');
  return adapter.info ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture } : {};
}

const sameSource = (a, b) => a && b && filesRoot(a) === filesRoot(b) && a.modelId === b.modelId && a.revision === b.revision;

// Changing the address or revision starts afresh, and the old cached files are deleted.
async function dropOtherCache(source) {
  const keep = filesRoot(source);
  const cache = await caches.open(CACHE).catch(() => null);
  if (!cache) return;
  for (const req of await cache.keys()) if (!req.url.startsWith(keep)) await cache.delete(req);
}

function load(id, source) {
  if (!(source?.baseUrl || source?.filesUrl) || !source.revision) return Promise.reject(failure('config', 'Set the model server address and revision first'));
  if (classifier && sameSource(loaded, source)) return Promise.resolve(loaded.result);
  if (loading && sameSource(loading.source, source)) return loading.promise;
  classifier = null;
  const promise = (async () => {
    const gpu = await checkWebGPU();
    Object.assign(env, transformersPaths(source));
    env.fetch = verifyingFetch(source);
    await dropOtherCache(source);
    const files = {};
    const progress_callback = (p) => {
      if (p.status !== 'progress' || !p.total) return;
      files[p.file] = { loaded: p.loaded, total: p.total };
      const all = Object.values(files);
      postMessage({ id, type: 'progress', phase: 'download', loaded: all.reduce((n, f) => n + f.loaded, 0), total: all.reduce((n, f) => n + f.total, 0) });
    };
    let pipe;
    try {
      pipe = await pipeline('token-classification', source.modelId, { device: 'webgpu', dtype: 'q4', revision: source.revision, progress_callback });
    } catch (e) {
      if (e.reason) throw e;
      if (e.name === 'QuotaExceededError' || /quota|disk/i.test(e.message)) throw failure('disk', 'Not enough disk space for the model');
      throw failure('load', `The model didn’t start: ${e.message}`);
    }
    postMessage({ id, type: 'progress', phase: 'test' });
    const t0 = performance.now();
    const spans = locate(SAMPLE, await pipe(SAMPLE, { aggregation_strategy: 'simple' }));
    const ms = Math.round(performance.now() - t0);
    if (!spans.some((s) => s.label === 'private_person') || !spans.some((s) => s.label === 'private_address')) throw failure('test', 'The test scan didn’t find the name and address it should');
    classifier = pipe;
    const result = { device: 'webgpu', gpu, ms, at: new Date().toISOString(), revision: source.revision };
    loaded = { ...source, result };
    return result;
  })();
  loading = { source, promise };
  promise.finally(() => { if (loading?.promise === promise) loading = null; }).catch(() => {});
  return promise;
}

async function scan(id, text) {
  if (!classifier) throw failure('not-loaded', 'The model isn’t loaded');
  const chunks = chunkText(text);
  const spans = [];
  const started = performance.now();
  for (let i = 0; i < chunks.length; i++) {
    if (cancelled.delete(id)) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
    postMessage({ id, type: 'progress', phase: 'scan', done: i, total: chunks.length });
    const groups = await classifier(chunks[i].text, { aggregation_strategy: 'simple' });
    spans.push(...locate(chunks[i].text, groups, chunks[i].offset));
  }
  return { spans, chunks: chunks.length, ms: Math.round(performance.now() - started) };
}

self.onmessage = async ({ data: msg }) => {
  if (msg.type === 'cancel') { cancelled.add(msg.cancels); return; }
  try {
    let result;
    if (msg.type === 'load') result = await load(msg.id, msg.source);
    else if (msg.type === 'scan') result = await scan(msg.id, msg.text);
    else if (msg.type === 'clearCache') { await caches.delete(CACHE); classifier = null; loaded = null; result = true; }
    postMessage({ id: msg.id, type: 'done', result });
  } catch (e) {
    postMessage({ id: msg.id, type: 'error', name: e?.name, reason: e?.reason || 'error', message: e?.message || String(e) });
  }
};

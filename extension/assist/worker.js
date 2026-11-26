// The profile assistant: a small instruct model (Gemma 3 1B by default) run on this computer with
// Transformers.js on WebGPU, off the page's main thread. Like the privacy model it comes only from the chosen
// model server, at a pinned revision, each file checked against its SHA-256 as it downloads. It keeps its
// own cache, so changing one model never deletes the other's files.
// Protocol: { id, type: 'load' | 'generate' | 'unload' | 'clearCache', ... } in; { id, type: 'progress' | 'done' | 'error', ... } out.
import { env, pipeline } from '../vendor/transformers.min.js';
import { failure, filesRoot, transformersPaths, verifyingFetch } from '../lib/model-fetch.js';

env.allowLocalModels = false;
env.useWasmCache = false;
env.backends.onnx.wasm.wasmPaths = {
  mjs: new URL('../vendor/ort-wasm-simd-threaded.asyncify.mjs', import.meta.url).href,
  wasm: new URL('../vendor/ort-wasm-simd-threaded.asyncify.wasm', import.meta.url).href,
};
const CACHE = 'power-loader-assist-cache';
env.cacheKey = CACHE;

let generator = null;
let loaded = null;
let loading = null;

const sameSource = (a, b) => a && b && filesRoot(a) === filesRoot(b) && a.modelId === b.modelId && a.revision === b.revision;

async function checkWebGPU() {
  if (!globalThis.navigator?.gpu) throw failure('webgpu', 'This browser doesn’t offer WebGPU to extensions, which the model needs');
  const adapter = await navigator.gpu.requestAdapter().catch(() => null);
  if (!adapter) throw failure('webgpu', 'WebGPU is available but found no usable graphics adapter');
}

async function dropOtherCache(source) {
  const keep = filesRoot(source);
  const cache = await caches.open(CACHE).catch(() => null);
  if (!cache) return;
  for (const req of await cache.keys()) if (!req.url.startsWith(keep)) await cache.delete(req);
}

// The answer is started for the model ('The field is "'), so even a small model answers with a field name
// rather than an explanation; generation stops at the closing quote. Thinking models' <think> parts are dropped.
const PREFILL = 'The field is "';
let prefill = true;
async function generate(messages, maxTokens = 12) {
  if (prefill) {
    const prompt = generator.tokenizer.apply_chat_template(messages, { tokenize: false, add_generation_prompt: true }) + PREFILL;
    const out = await generator(prompt, { max_new_tokens: maxTokens, do_sample: false, return_full_text: false });
    return String(out?.[0]?.generated_text ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').split('"')[0].trim();
  }
  const out = await generator(messages, { max_new_tokens: maxTokens, do_sample: false });
  const g = out?.[0]?.generated_text;
  return (Array.isArray(g) ? String(g.at(-1)?.content ?? '') : String(g ?? '')).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

function load(id, source) {
  if (!(source?.baseUrl || source?.filesUrl) || !source.revision) return Promise.reject(failure('config', 'No model server address and pinned revision are set'));
  if (generator && sameSource(loaded, source)) return Promise.resolve(loaded.result);
  if (loading && sameSource(loading.source, source)) return loading.promise;
  generator = null;
  const promise = (async () => {
    await checkWebGPU();
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
    try {
      generator = await pipeline('text-generation', source.modelId, { device: 'webgpu', dtype: source.dtype || 'q4f16', revision: source.revision, progress_callback });
    } catch (e) {
      if (e.reason) throw e;
      if (e.name === 'QuotaExceededError' || /quota|disk/i.test(e.message)) throw failure('disk', 'Not enough disk space for the model');
      throw failure('load', `The model didn’t start: ${e.message}`);
    }
    prefill = source.prefill !== false;
    // A test answer in the format the matcher asks for: "Surname" is the last name.
    postMessage({ id, type: 'progress', phase: 'test' });
    const t0 = performance.now();
    const answer = await generate([{ role: 'user', content: `A web page shows: "Surname": "Smith".\nWhich of these form fields does it fill? First name; Last name; Email; none.\nAnswer with the field name only.${source.promptSuffix || ''}` }], 16);
    if (!/last\s*name/i.test(answer)) {
      generator = null;
      throw failure('test', 'The model started but its test answer wasn’t usable');
    }
    const result = { device: 'webgpu', ms: Math.round(performance.now() - t0), at: new Date().toISOString(), revision: source.revision };
    loaded = { ...source, result };
    return result;
  })();
  loading = { source, promise };
  promise.finally(() => { if (loading?.promise === promise) loading = null; }).catch(() => {});
  return promise;
}

self.onmessage = async ({ data: msg }) => {
  try {
    let result;
    if (msg.type === 'load') result = await load(msg.id, msg.source);
    else if (msg.type === 'generate') {
      if (!generator) throw failure('not-loaded', 'The model isn’t loaded');
      result = await generate(msg.messages, msg.maxTokens);
    } else if (msg.type === 'unload') { await generator?.dispose?.(); generator = null; loaded = null; result = true; }
    else if (msg.type === 'clearCache') { await caches.delete(CACHE); generator = null; loaded = null; result = true; }
    postMessage({ id: msg.id, type: 'done', result });
  } catch (e) {
    postMessage({ id: msg.id, type: 'error', name: e?.name, reason: e?.reason || 'error', message: e?.message || String(e) });
  }
};

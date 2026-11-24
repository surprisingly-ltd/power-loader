// Model downloads: only from the chosen model server (Hugging Face unless policy, the caseworker or the
// library says otherwise), at a pinned revision, each file checked against its expected SHA-256 while it
// streams. Used by privacy/worker.js; no Transformers.js dependency, so it can be tested.
import { Sha256 } from './sha256.js';

export function failure(reason, message) { return Object.assign(new Error(message), { reason }); }

// The default: OpenAI Privacy Filter from Hugging Face, pinned to one commit, with the SHA-256 of every file
// Transformers.js loads for it (token classification, q4). A mirror at another address serves the same files.
export const DEFAULT_MODEL = Object.freeze({
  baseUrl: 'https://huggingface.co/',
  modelId: 'openai/privacy-filter',
  revision: '7ffa9a043d54d1be65afb281eddf0ffbe629385b',
  hashes: Object.freeze({
    'config.json': 'b2b26a4a4a000639ad30b0c264adbefe365bdb567fbd7bb27303b8c438375bd1',
    'tokenizer_config.json': '6c14af9ce1a284d3c3c5146b26efe4cd589c68e1dd4e9d94455606ec911ba774',
    'tokenizer.json': '0614fe83cadab421296e664e1f48f4261fa8fef6e03e63bb75c20f38e37d07d3',
    'onnx/model_q4.onnx': '8f7dee8b46d096f052b359375dfba5d983cc4d18c44a783bf548615c472f8dea',
    'onnx/model_q4.onnx_data': 'f30998e28c71c5374cc7e8b7de8f0f83e981592c0c2d652d2ad4928454dbb496',
  }),
});

// The profile assistant: Gemma 3 1B instruct (ONNX, q4f16 for WebGPU), pinned to one commit, with the SHA-256
// of every file Transformers.js may load for text generation. About 785 MB, downloaded the first time someone
// makes a profile, never at install. Measured on labels the rules don't know (docs/plans/local-profile-assist.md):
// Gemma 3 270M added nothing however it was prompted; Gemma 3 1B, with its answer started for it, matched as
// well as the best other small model tried. Policy can pin another model with assistModel.modelId, revision,
// hashes, dtype, promptSuffix and prefill.
export const DEFAULT_ASSIST_MODEL = Object.freeze({
  baseUrl: 'https://huggingface.co/',
  modelId: 'onnx-community/gemma-3-1b-it-ONNX',
  revision: 'a58439f40017d3b99c7d378ff525e54e0ba08ebf',
  dtype: 'q4f16',
  promptSuffix: '',
  prefill: true,
  sizeMB: 785,
  hashes: Object.freeze({
    'config.json': '91e864295e06e3069a26e89dc5d7e506d32153b23a29bf283e8e3a46fc546806',
    'generation_config.json': '2ff57fef908e4da8accc2e369d2c848785e6f2f8c5d1ed102bd9cb9aa70f7aaa',
    'tokenizer.json': '55da1312bdf1d7d8fe8d9d1b3eed04086261149e6034e0ac3f8c633b67f5aac8',
    'tokenizer_config.json': '362055c2b4c69af56db94be4f1297bc6d2936a8f4ab9c0173b5bedd502280507',
    'special_tokens_map.json': '2f7b0adf4fb469770bb1490e3e35df87b1dc578246c5e7e6fc76ecf33213a397',
    'chat_template.jinja': '7de1c58e208eda46e9c7f86397df37ec49883aeece39fb961e0a6b24088dd3c4',
    'onnx/model_q4f16.onnx': '522d1f0e1d1fd0065ca02d61a0bf17a43701c1835b4ebf0c4628b73f1a6fb796',
    'onnx/model_q4f16.onnx_data': '6fb9bc8dd4b93a040bcea60c953c2e24f60f9d52e708befec077f6ab60baa007',
  }),
});

/**
 * Where the profile assistant comes from: policy (assistModel.*) can switch it off, or pin another model,
 * revision and hashes; the address follows the privacy model's server when the caseworker or policy set one,
 * since a mirror usually carries both.
 */
export function assistSource(policy, settings) {
  const p = policy?.values?.assistModel || {};
  const pin = p.revision ? p : DEFAULT_ASSIST_MODEL;
  const mirror = p.baseUrl || policy?.values?.privacyModel?.baseUrl || settings?.privacy?.modelUrl || DEFAULT_ASSIST_MODEL.baseUrl;
  return {
    baseUrl: String(mirror).replace(/\/?$/, '/'), modelId: pin.modelId || DEFAULT_ASSIST_MODEL.modelId, revision: pin.revision,
    dtype: pin.dtype || DEFAULT_ASSIST_MODEL.dtype, hashes: pin.hashes || null,
    promptSuffix: pin.promptSuffix || '', prefill: pin.prefill !== false, sizeMB: pin.sizeMB || null,
    enabled: p.enabled !== false && settings?.assist?.model !== false, locked: p.enabled === false,
  };
}

/** A model server address the caseworker typed: https (or http on this computer), no credentials, query or fragment. */
export function normalizeModelUrl(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error('Enter a full address, such as https://huggingface.co/'); }
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('The model server address must start with https://');
  if (url.username || url.password || url.search || url.hash) throw new Error('The address must not contain credentials, query parameters or a fragment');
  return url.href.replace(/\/?$/, '/');
}

// Every request goes through here: only the model server, and each file checked against its expected hash.
export function verifyingFetch(source, base = globalThis.fetch) {
  const root = `${source.baseUrl}${source.modelId}/resolve/`;
  const prefix = `${root}${source.revision}/`;
  return async (url, init) => {
    let href = String(url?.url || url);
    // Transformers.js reads the config files from "main" before it applies the revision. Pin those to the
    // revision too, so every file comes from the same commit and is checked against its hash.
    if (href.startsWith(root) && !href.startsWith(prefix)) href = prefix + href.slice(root.length).replace(/^[^/]*\//, '');
    if (!href.startsWith(source.baseUrl)) throw failure('blocked', `Blocked a request outside the model server: ${new URL(href).host}`);
    let res;
    try { res = await base(href, init); } catch { throw failure('unreachable', 'Couldn’t reach the model server'); }
    if (res.status === 401 || res.status === 403) throw failure('denied', `The model server refused access (HTTP ${res.status})`);
    if (!res.ok || !res.body) return res;
    const path = href.startsWith(prefix) ? href.slice(prefix.length).split('?')[0] : null;
    const expected = path && source.hashes ? source.hashes[path] : null;
    if (source.hashes && path && !expected) throw failure('hash', `No expected hash for ${path}, so it was refused`);
    if (!expected) return res;
    const hash = new Sha256();
    const checked = res.body.pipeThrough(new TransformStream({
      transform(chunk, controller) { hash.update(chunk); controller.enqueue(chunk); },
      flush(controller) { if (hash.hex() !== expected) controller.error(failure('hash', `${path} doesn’t match its expected hash`)); },
    }));
    return new Response(checked, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

/**
 * Where the model comes from. The address: policy (locked), then the caseworker's own setting, then the
 * library's privacy.json "model" block, then Hugging Face. The pin (model, revision, hashes): policy, then
 * the library, then the default, so a mirror typed by the caseworker is still checked against the default hashes.
 */
export function modelSource(policy, lib, settings) {
  const p = policy?.values?.privacyModel || {};
  const l = lib?.privacy?.model || {};
  const yours = settings?.privacy?.modelUrl || null;
  const pin = p.revision ? p : l.revision ? l : DEFAULT_MODEL;
  const [baseUrl, from] = p.baseUrl ? [p.baseUrl, 'policy'] : yours ? [yours, 'you'] : l.baseUrl ? [l.baseUrl, 'library'] : [DEFAULT_MODEL.baseUrl, 'default'];
  return {
    baseUrl: String(baseUrl).replace(/\/?$/, '/'), modelId: pin.modelId || DEFAULT_MODEL.modelId, revision: pin.revision, hashes: pin.hashes || null,
    required: p.required !== false, from, locked: from === 'policy',
  };
}

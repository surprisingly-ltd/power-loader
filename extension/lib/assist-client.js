// The sidebar's handle on the profile assistant worker (assist/worker.js), and the matching run that uses it.
// State: off | not-loaded | downloading { loaded, total } | starting | testing | ready { ms, at } | failed { reason, message }
// The model is optional: every caller has the rules' answer already, and the model only refines it.
import { buildItemPrompt, forModel, mergeModel, readItemAnswer } from './assist.js';

let worker = null;
let nextId = 1;
const pending = new Map();
const listeners = new Set();
export const assist = { state: 'not-loaded' };

function set(patch) {
  Object.keys(assist).forEach((k) => delete assist[k]);
  Object.assign(assist, patch);
  listeners.forEach((fn) => fn(assist));
}

export const onAssistChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const assistReady = () => assist.state === 'ready';

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('../assist/worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const p = pending.get(data.id);
    if (!p) return;
    if (data.type === 'progress') { p.onProgress?.(data); return; }
    pending.delete(data.id);
    if (data.type === 'done') p.resolve(data.result);
    else p.reject(Object.assign(new Error(data.message), { name: data.name || 'Error', reason: data.reason }));
  };
  worker.onerror = (e) => {
    const err = Object.assign(new Error(e.message || 'The profile assistant failed to start'), { reason: 'load' });
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    worker = null;
  };
  return worker;
}

function call(msg, onProgress) {
  const id = nextId++;
  const w = ensureWorker();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    try { w.postMessage({ ...msg, id }); } catch (error) { pending.delete(id); reject(error); }
  });
}

/** Load the model once; later calls share the same load. source: assistSource() from model-fetch.js. */
let loadingPromise = null;
export function loadAssist(source) {
  if (!source?.enabled) { set({ state: 'off', message: source?.locked ? 'Switched off by your organisation' : 'Switched off' }); return Promise.resolve(assist); }
  if (assistReady()) return Promise.resolve(assist);
  if (loadingPromise) return loadingPromise;
  set({ state: 'starting' });
  const { enabled, locked, ...pin } = source; // eslint-disable-line no-unused-vars
  loadingPromise = call({ type: 'load', source: pin }, (p) => {
    if (p.phase === 'download') set({ state: 'downloading', loaded: p.loaded, total: p.total });
    else if (p.phase === 'test') set({ state: 'testing' });
  }).then((r) => { set({ state: 'ready', ...r }); return assist; }, (e) => { set({ state: 'failed', reason: e.reason || 'load', message: e.message }); return assist; })
    .finally(() => { loadingPromise = null; });
  return loadingPromise;
}

export const generate = (messages, maxTokens) => call({ type: 'generate', messages, maxTokens });

export async function clearAssistCache() {
  await call({ type: 'clearCache' }).catch(() => {});
  set({ state: 'not-loaded' });
}

export function stopAssist() {
  if (!worker) return;
  worker.terminate();
  worker = null;
  for (const p of pending.values()) p.reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
  pending.clear();
  set({ state: 'not-loaded' });
}

export function describeAssist(a = assist) {
  if (a.state === 'ready') return 'On-device model ready';
  if (a.state === 'downloading') return `Downloading the on-device model: ${Math.round((a.loaded || 0) / 1e6)} of ${Math.round((a.total || 0) / 1e6)} MB`;
  if (a.state === 'starting') return 'Starting the on-device model…';
  if (a.state === 'testing') return 'Testing the on-device model…';
  if (a.state === 'failed') return `On-device model unavailable: ${a.message}`;
  if (a.state === 'off') return `On-device model off${a.message ? ` (${a.message.toLowerCase()})` : ''}`;
  return 'On-device model not loaded';
}

/**
 * Ask the model about each candidate in turn and merge its answers into the rules' matches.
 * run(messages, maxTokens) is generate() here, or a stand-in in tests. suffix: the model's prompt suffix.
 * Returns mergeModel's { matches, changed, agreed }.
 */
export async function refineWithModel(rule, candidates, fields, run = generate, { suffix = '', signal } = {}) {
  const answer = {};
  for (const c of forModel(candidates, fields)) {
    signal?.throwIfAborted();
    const key = readItemAnswer(await run(buildItemPrompt(c, fields, { suffix }), 16), fields);
    if (key && !Object.values(answer).includes(key)) answer[c.id] = key;
  }
  return mergeModel(rule, answer, candidates, fields);
}

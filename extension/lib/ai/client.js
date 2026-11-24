// Minimal Chat Completions transport. No case storage, browser messages or UI.
// It sends only payloads approved by previewBeforeSend() (lib/ai/boundary.js), exactly as approved.
import { validateAI } from './settings.js';
import { isApproved } from './boundary.js';
export const MAX_RESPONSE_CHARS = 100000;
export const MAX_REQUEST_CHARS = 200000;
// Images count as a fixed cost against the budget, since their size isn't text length.
export const IMAGE_COST = 20000;

export function requestSize(messages) {
  return messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length
    : (m.content || []).reduce((k, part) => k + (part.type === 'text' ? String(part.text).length : part.type === 'image_url' ? IMAGE_COST : 0), 0)), 0);
}

export function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    void Promise.resolve(promise).catch(() => {});
    return Promise.reject(signal.reason || new DOMException('Cancelled', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new DOMException('Cancelled', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function readBounded(response, signal) {
  if (!response.body?.getReader) {
    const value = await abortable(response.text(), signal);
    if (value.length > MAX_RESPONSE_CHARS) throw new Error('AI response is too large');
    return value;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let value = '';
  try {
    while (true) {
      const { done, value: chunk } = await abortable(reader.read(), signal);
      if (done) break;
      value += decoder.decode(chunk, { stream: true });
      if (value.length > MAX_RESPONSE_CHARS) throw new Error('AI response is too large');
    }
    return value + decoder.decode();
  } finally { void reader.cancel().catch(() => {}); }
}

export async function complete(payload, config, { signal, fetchFn = globalThis.fetch } = {}) {
  if (!isApproved(payload)) throw new Error('Power Loader only sends what you approved in the preview');
  const { messages } = payload;
  if (requestSize(messages) > MAX_REQUEST_CHARS) throw new Error('This request is larger than the AI budget allows; use a smaller page or document');
  const ai = validateAI(config);
  if (ai.auth === 'bearer' && !config.apiKey) throw new Error('Enter an API key in Settings');
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new DOMException('AI request timed out', 'TimeoutError')), ai.requestTimeoutMs);
  try {
    let response;
    controller.signal.throwIfAborted();
    try {
      response = await abortable(fetchFn(`${ai.baseUrl}/chat/completions`, {
        method: 'POST', redirect: 'error', credentials: 'omit', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(ai.auth === 'bearer' ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
        body: JSON.stringify({ model: ai.model, messages, stream: false }),
      }), controller.signal);
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      const failure = new Error('Could not reach the AI endpoint; check its address, permission and connection');
      failure.retryable = true;
      throw failure;
    }
    if (!response.ok) {
      // Do not echo arbitrary server text: it may contain credentials or prompts.
      const labels = { 401: 'API key rejected', 403: 'API access denied', 404: 'Endpoint or model not found', 429: 'AI endpoint rate limit reached' };
      const error = new Error(labels[response.status] || `AI endpoint returned HTTP ${response.status}`);
      error.retryable = response.status === 429 || response.status >= 500;
      throw error;
    }
    let body;
    try { body = JSON.parse(await readBounded(response, controller.signal)); }
    catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error.message === 'AI response is too large') throw error;
      throw new Error('The AI endpoint did not return a valid JSON response');
    }
    const choice = body.choices?.[0];
    if (choice?.message?.refusal || choice?.finish_reason === 'content_filter') throw new Error('The model declined this request');
    if (choice?.finish_reason === 'length') throw new Error('The model response was cut short; reduce the task size or choose another model');
    if (typeof choice?.message?.content !== 'string' || !choice.message.content.trim()) throw new Error('The AI endpoint returned no text content');
    return choice.message.content;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

// The one boundary between Power Loader and the AI gateway. previewBeforeSend() builds the exact payload, finds
// personal data in it on this computer, swaps each finding for a placeholder, and shows the caseworker the
// result. Only a payload it returns, frozen and registered here, can be sent by lib/ai/client.js.
// The ref map lives in memory for the request only: it is never stored or logged.
import { assignRefs, formatHint, neutralise, newNs, restoreAnswer, restoreString, shortToken, token } from '../pii.js';
import { decide, detect } from '../privacy-detect.js';

const approved = new WeakSet();
const secrets = new WeakMap();
let presenter = null;

// The page that shows previews registers how; a context without one can't send anything.
export function registerPresenter(fn) { presenter = fn; }

export const isApproved = (payload) => approved.has(payload);

/**
 * request: { purpose, title, parts: [{ id, label, text, kind: 'text' | 'html' } | { id, label, kind: 'image', url }],
 *   compose(sent) → messages, schema? }
 *   compose receives { [partId]: sent text, or an image part's data URL } and returns Chat Completions messages
 *   built only from them and fixed instructions. Request metadata (title, address, file name) goes in as parts
 *   so it is scanned too. A picture can't be scanned or redacted, so it is sent only when the caseworker has
 *   ticked that they understand it goes as it is (state.imageAck), and never when policy blocks pictures.
 * context: { known, patterns, modelSpans: { partId: spans }, settings, identifierTypes, model: { ready, required } }
 */
export function prepare(request, context) {
  const images = request.parts.filter((p) => p.kind === 'image');
  if (images.length && context.blockImages) throw new Error('Your organisation doesn’t allow pictures to be sent to the AI. Read it on this computer instead.');
  if (images.some((p) => !/^data:image\/(png|jpeg|webp);base64,/.test(String(p.url || '')))) throw new Error('Only a picture read on this computer can be sent');
  let planted = 0;
  const parts = request.parts.map((p) => {
    if (p.kind === 'image') return { ...p, text: '' };
    const n = neutralise(p.text);
    planted += n.count;
    return { ...p, text: n.text };
  });
  return { ...request, parts, planted, ns: newNs(6), over: {}, extra: [], context, imageAck: false };
}

/** What would be sent now, with the current switches. Pure: call it again after every change. */
export function review(state) {
  const { context } = state;
  const parts = state.parts.map((p) => {
    if (p.kind === 'image') return { ...p, findings: [] };
    const found = detect(p.text, { known: context.known, patterns: context.patterns, modelSpans: context.modelSpans?.[p.id] || [], extra: state.extra });
    return { ...p, findings: decide(found, context.settings, state.over) };
  });
  const refs = assignRefs(parts.flatMap((p) => p.findings), state.ns);
  const fmt = (f) => formatHint(f, context.identifierTypes, context.settings.format);
  for (const p of parts) {
    if (p.kind === 'image') { p.pieces = []; p.sent = p.url; continue; }
    // Where each placeholder sits in the sent text, so quotes can be mapped back to the original.
    let sent = '';
    let at = 0;
    p.pieces = [];
    for (const f of p.findings) {
      if (!f.redact) continue;
      sent += p.text.slice(at, f.start);
      const t = token(f, { format: fmt(f) });
      p.pieces.push({ sentStart: sent.length, sentEnd: sent.length + t.length, origStart: f.start, origEnd: f.end });
      sent += t;
      at = f.end;
    }
    p.sent = sent + p.text.slice(at);
  }
  const all = parts.flatMap((p) => p.findings);
  const images = parts.filter((p) => p.kind === 'image').length;
  const blocked = context.model?.required && !context.model.ready
    ? 'The on-device privacy model isn’t ready, and your organisation requires it before anything is sent. Download it in the sidebar under Settings → On-device privacy model.' : null;
  return {
    parts, refs, blocked,
    counts: {
      redacted: new Set(all.filter((f) => f.redact).map((f) => f.ref)).size,
      low: all.filter((f) => !f.redact && f.why === 'low').length,
      off: all.filter((f) => !f.redact && f.why === 'off').length,
      unticked: all.filter((f) => !f.redact && (f.why === 'on' || f.why === 'you')).length,
    },
    chars: parts.filter((p) => p.kind !== 'image').reduce((n, p) => n + p.sent.length, 0),
    images, needsAck: images > 0 && !state.imageAck,
    planted: state.planted,
  };
}

const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };

/** Freeze and register the payload exactly as reviewed. Throws when the model is required and not ready. */
export function approve(state) {
  const r = review(state);
  if (r.blocked) throw new Error(r.blocked);
  if (r.needsAck) throw new Error('Tick that you understand the picture is sent as it is, without redaction');
  const sentById = Object.fromEntries(r.parts.map((p) => [p.id, p.sent]));
  const messages = state.compose(sentById);
  const payload = deepFreeze({ purpose: state.purpose, ns: state.ns, messages: structuredClone(messages), chars: r.chars, redacted: r.counts.redacted, images: r.images });
  const sent = new Map();
  for (const f of r.parts.flatMap((p) => p.findings)) {
    if (!f.redact) continue;
    if (!sent.has(f.ref)) sent.set(f.ref, new Set());
    sent.get(f.ref).add(token(f, { format: formatHint(f, state.context.identifierTypes, state.context.settings.format) }));
    sent.get(f.ref).add(shortToken(f));
  }
  approved.add(payload);
  secrets.set(payload, { refs: r.refs, sent, parts: r.parts, schema: state.schema || {} });
  return payload;
}

/**
 * Show the preview and resolve the approved payload, or null when the caseworker cancels. Nothing is sent here.
 */
export async function previewBeforeSend(request, context) {
  if (!presenter) throw new Error('Nothing can be sent to the AI from here');
  const state = prepare(request, context);
  const ok = await presenter(state, { review, approve });
  return ok ? approve(state) : null;
}

// Map a stretch of the sent text back to the original, across the placeholders.
function originalSpan(part, a, b) {
  const map = (pos, isEnd) => {
    let delta = 0;
    for (const t of part.pieces) {
      if (pos <= t.sentStart) break;
      if (pos < t.sentEnd) return isEnd ? t.origEnd : t.origStart;
      delta = t.origEnd - t.sentEnd;
    }
    return pos + delta;
  };
  return part.text.slice(map(a, false), map(b, true));
}

/**
 * Restore a parsed answer, strictly (lib/pii.js restoreAnswer), and put quotes back exactly as written by
 * finding them in what was sent. schema: { field: allowed categories }, from the library's case fields.
 */
export function restore(payload, answer, schema) {
  const s = secrets.get(payload);
  if (!s) throw new Error('This answer doesn’t belong to a request sent from here');
  const out = restoreAnswer(answer, { ns: payload.ns, refs: s.refs, sent: s.sent, schema: schema || s.schema });
  for (const [field, v] of Object.entries(answer || {})) {
    if (!out.values[field] || typeof v?.quote !== 'string') continue;
    const q = v.quote.trim();
    // The model may quote with the short placeholder; look for the long one that was sent.
    const expand = (part) => q.replace(/<redacted:([a-z_]+)\|ref:([a-z0-9]+\.\d+)>/g, (m, cat, ref) => [...(s.sent.get(ref) || [])].find((t) => t !== m && part.sent.includes(t)) || m);
    // Quotes are looked for in the text that was sent; a picture's data is never searched.
    const hit = s.parts.filter((p) => p.kind !== 'image').map((p) => ({ p, q2: expand(p) })).find(({ p, q2 }) => q2 && p.sent.includes(q2));
    if (hit) { const i = hit.p.sent.indexOf(hit.q2); out.values[field].quote = originalSpan(hit.p, i, i + hit.q2.length); }
    else out.values[field].quote = restoreString(q, { ns: payload.ns, refs: s.refs, sent: s.sent }).value;
  }
  return out;
}

/** Restore free text from an answer (an explanation, a label): every placeholder must be one this request issued. */
export function restoreText(payload, str) {
  const s = secrets.get(payload);
  if (!s) throw new Error('This answer doesn’t belong to a request sent from here');
  return restoreString(String(str ?? ''), { ns: payload.ns, refs: s.refs, sent: s.sent });
}

// Drop the request's ref map once its answer has been handled.
export function forget(payload) { secrets.delete(payload); }

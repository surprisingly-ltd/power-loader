// The ✦ actions. Each builds its request as parts for previewBeforeSend() (lib/ai/boundary.js), sends the
// approved payload once (transport retries resend it unchanged), and parses the answer locally against a
// fixed schema. A result that needs another attempt is a new request, previewed again.
/* global browser */
import '../extract.js';
import { complete } from './client.js';
import { previewBeforeSend, restore, restoreText, forget } from './boundary.js';
import { assertSafeData, review, validate } from './checks.js';
import { cleanHtml, formForPrompt, parseSnapshot } from './snapshot.js';
import { display, TYPES, validateValue } from '../fields.js';
import { PERIOD_CATS } from '../timeline.js';
import { suggestPatterns } from '../drafts.js';

const E = globalThis.PowerLoaderExtract;
export const PURPOSES = {
  extract: { title: '✦ Extract with AI', activity: 'Extract page' },
  form: { title: '✦ Map this form with AI', activity: 'Map form' },
  profile: { title: '✦ Suggest a profile', activity: 'Suggest profile' },
  flowForm: { title: '✦ Work out what this form collects', activity: 'Flow: form fields' },
  read: { title: '✦ Read with AI', activity: 'Read document' },
  readImage: { title: '✦ Read the picture with AI', activity: 'Read picture' },
  flowSteps: { title: '✦ Write the caseworker’s steps', activity: 'Flow: steps' },
  calc: { title: '✦ Ask about these amounts', activity: 'Calculator question' },
  tlFind: { title: '✦ Find periods in the notes', activity: 'Timeline: find periods' },
  tlExplain: { title: '✦ Explain the timeline', activity: 'Timeline: explain' },
};
const PROMPTS = { extract: 'extract-values', read: 'extract-values', readImage: 'read-image', flowSteps: 'flow-steps', form: 'map-form', profile: 'profile', flowForm: 'flow-form', calc: 'ask-amounts', tlFind: 'find-periods', tlExplain: 'explain-timeline' };
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const money = (n) => display({ type: 'money' }, n);
// Case notes as numbered lines, with the date each was written, for the calculator and the timeline.
const notesParts = (notes) => (notes?.length ? [{ id: 'notes', label: 'Case notes', kind: 'text', text: notes.map((n, i) => `[${i + 1}] ${n.date || 'undated'}: ${n.text}`).join('\n') }] : []);

export async function loadPrompt(name) {
  const read = async (n) => {
    const res = await fetch(browser.runtime.getURL(`prompts/${n}.md`));
    if (!res.ok) throw new Error('Could not load packaged AI instructions');
    return res.text();
  };
  const [main, rules] = await Promise.all([read(name), read('placeholders')]);
  return `${main.replace('{{DSL}}', name === 'profile' ? await read('dsl') : '')}\n\n${rules}`;
}

export function parseReply(text) {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fence ? fence[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The AI’s answer had no JSON in it');
  const value = JSON.parse(body.slice(start, end + 1));
  assertSafeData(value);
  return value;
}

const fieldList = (lib, keys) => keys.map((k) => ({ key: k, label: lib.fields[k].label, type: lib.fields[k].type || 'text', ...(lib.fields[k].options ? { options: lib.fields[k].options } : {}) }));
// A link pattern is sent instead of the address: the path shape, never the identifiers in it.
const pageShape = (url) => { try { return suggestPatterns(url).urlPattern.replace(/^https?:\/\/[^/]+/, ''); } catch { return ''; } };
// A flow page's address with its host, identifiers already replaced by {…}: a link needs the whole address.
const pageShapeFull = (url) => { try { return /\{/.test(url) ? url.split('?')[0] : suggestPatterns(url).urlPattern; } catch { return ''; } };

// The fields a profile request asks about: the draft's target fields when they're set, else every case field
// (fields people fill in themselves are left out for pages, but a form can have boxes for them).
const wanted = (lib, input, manual = false) => (input.keys?.length ? input.keys.filter((k) => lib.fields[k]) : Object.keys(lib.fields).filter((k) => manual || !lib.fields[k].manual));
// The author's guidance for a flow goes as a part of its own, so it is scanned and previewed like the page.
const guidancePart = (input) => (String(input.guidance || '').trim() ? [{ id: 'guidance', label: 'Flow guidance', kind: 'text', text: String(input.guidance).trim().slice(0, 5000) }] : []);
const guidanceLine = (sent) => (sent.guidance ? `Guidance from the flow's author:\n${sent.guidance}\n\n` : '');
const targetsLine = (input) => (input.targets?.length ? `Target forms: ${input.targets.join(', ')}. Only these forms' fields are listed.\n\n` : '');

/** Build the request for previewBeforeSend(). */
export function buildRequest(purpose, input, { lib, system, maxHtmlChars = 120000 }) {
  const meta = { id: 'meta', label: 'Page title and link shape', kind: 'text', text: `Page title: ${input.title || '(none)'}\nPage link shape: ${pageShape(input.url)}` };
  if (purpose === 'calc') {
    return {
      purpose, title: PURPOSES[purpose].title,
      parts: [
        { id: 'question', label: 'Your question', kind: 'text', text: input.question },
        { id: 'amounts', label: 'The ticked amounts', kind: 'text', text: input.amounts.map((a, i) => `${i + 1}. ${a.date || 'case value'} · ${a.label} · ${money(a.amount)} · ${a.source}`).join('\n') },
        ...notesParts(input.notes),
      ],
      compose: (sent) => [
        { role: 'system', content: system },
        { role: 'user', content: `Question: ${sent.question}\n\nAmounts:\n${sent.amounts}${sent.notes ? `\n\nCase notes:\n${sent.notes}` : ''}` },
      ],
    };
  }
  if (purpose === 'tlFind') {
    return {
      purpose, title: PURPOSES[purpose].title,
      parts: notesParts(input.notes),
      compose: (sent) => [{ role: 'system', content: system }, { role: 'user', content: `Case notes:\n${sent.notes}` }],
    };
  }
  if (purpose === 'tlExplain') {
    return {
      purpose, title: PURPOSES[purpose].title,
      parts: [{ id: 'summary', label: 'The timeline summary', kind: 'text', text: input.summary }, ...notesParts(input.notes)],
      compose: (sent) => [{ role: 'system', content: system }, { role: 'user', content: `Timeline:\n${sent.summary}${sent.notes ? `\n\nCase notes:\n${sent.notes}` : ''}` }],
    };
  }
  if (purpose === 'extract' || purpose === 'read') {
    const keys = input.keys;
    return {
      purpose, title: PURPOSES[purpose].title,
      parts: [meta, { id: 'text', label: input.label || 'Page text', kind: 'text', text: input.text }],
      schema: Object.fromEntries(keys.map((k) => [k, lib.fields[k].accepts || []])),
      compose: (sent) => [
        { role: 'system', content: system },
        { role: 'user', content: `Case fields:\n${JSON.stringify(fieldList(lib, keys))}\n\n${sent.meta}\n\nText:\n${sent.text}` },
      ],
    };
  }
  if (purpose === 'readImage') {
    // The picture goes as it is: the preview shows it and won't send it until the caseworker says they understand.
    const keys = input.keys;
    return {
      purpose, title: PURPOSES.readImage.title,
      parts: [
        { id: 'meta', label: 'Name of the picture', kind: 'text', text: `Picture: ${input.title || 'Picture'}` },
        { id: 'image', label: 'The picture, sent as it is', kind: 'image', url: input.image, width: input.width, height: input.height },
      ],
      schema: Object.fromEntries(keys.map((k) => [k, lib.fields[k].accepts || []])),
      compose: (sent) => [
        { role: 'system', content: system },
        { role: 'user', content: [
          { type: 'text', text: `Case fields:\n${JSON.stringify(fieldList(lib, keys))}\n\n${sent.meta}\n\nRead the values from this picture.` },
          { type: 'image_url', image_url: { url: sent.image } },
        ] },
      ],
    };
  }
  if (purpose === 'flowSteps') {
    // Page names and link shapes, the fields' names, and the author's guidance. Never a page's content.
    const pages = input.pages.map((p, i) => `${i + 1}. id ${p.id} · ${p.role} · ${p.name}${p.url ? ` · ${pageShapeFull(p.url)}` : ''}`).join('\n');
    return {
      purpose, title: PURPOSES.flowSteps.title,
      parts: [...guidancePart(input), { id: 'pages', label: 'The flow’s pages: names and link shapes', kind: 'text', text: pages }],
      compose: (sent) => [
        { role: 'system', content: system },
        { role: 'user', content: `${guidanceLine(sent)}Pages, in the order the caseworker takes them:\n${sent.pages}\n\nNames a link can use: {ref} (the case reference)${Object.keys(lib.fields).length ? `, ${Object.entries(lib.fields).map(([k, f]) => `{${k}} (${f.label})`).join(', ')}` : ''}` },
      ],
    };
  }
  if (purpose === 'form') {
    return {
      purpose, title: PURPOSES.form.title,
      parts: [meta, { id: 'form', label: 'Form boxes: labels and options, not what’s typed in', kind: 'text', text: JSON.stringify(formForPrompt(input.form), null, 1) }],
      compose: (sent) => [
        { role: 'system', content: system },
        { role: 'user', content: `${targetsLine(input)}Case fields:\n${JSON.stringify(fieldList(lib, wanted(lib, input, true)))}\n\n${sent.meta}\n\nForm:\n${sent.form}` },
      ],
    };
  }
  if (purpose === 'flowForm') {
    const known = Object.entries(lib.fields).map(([key, f]) => ({ key, label: f.label, type: f.type || 'text' }));
    return {
      purpose, title: PURPOSES.flowForm.title,
      parts: [...guidancePart(input), meta, { id: 'form', label: 'Form boxes: labels and options, not what’s typed in', kind: 'text', text: JSON.stringify(formForPrompt(input.form), null, 1) }],
      compose: (sent) => [
        { role: 'system', content: system },
        { role: 'user', content: `${guidanceLine(sent)}Fields the flow already has (reuse these keys when a box means the same):\n${JSON.stringify(known)}\n\nField types: ${TYPES.join(', ')}\n\n${sent.meta}\n\nForm:\n${sent.form}` },
      ],
    };
  }
  if (purpose === 'profile') {
    const doc = parseSnapshot(input.html, input.document);
    const cleaned = cleanHtml(doc, maxHtmlChars);
    return {
      purpose, title: PURPOSES.profile.title, doc,
      parts: [...guidancePart(input), meta, { id: 'html', label: 'Reduced page HTML (shown as it will be sent)', kind: 'html', text: cleaned.html }],
      truncated: cleaned.truncated,
      compose: (sent) => [
        { role: 'system', content: system },
        { role: 'user', content: `${guidanceLine(sent)}${targetsLine(input)}Case fields:\n${JSON.stringify(fieldList(lib, wanted(lib, input)))}\n\n${sent.meta}\n${cleaned.truncated ? 'The HTML was cut short.\n' : ''}\nHTML:\n${sent.html}` },
      ],
    };
  }
  throw new Error('Unknown AI action');
}

/**
 * Parse an answer. extract → { rows: [{ key, value, quote, ok, error, problems }] } after the strict restore;
 * form → { fields: { box: key }, dropped }; profile → { name, fields, sample, problems, dropped }.
 * Placeholders are never restored into selectors: a field whose selector holds one is dropped.
 */
const placeholderIn = (str) => /redacted:/i.test(str);

export function parseAnswer(purpose, payload, text, { lib, request, input }) {
  const reply = parseReply(text);
  const free = (str) => { const r = restoreText(payload, str); return { text: r.ok ? r.value : '', bad: r.bad }; };
  if (purpose === 'calc') {
    const answer = free(typeof reply.answer === 'string' ? reply.answer.slice(0, 2000) : '');
    const items = [...new Set((Array.isArray(reply.items) ? reply.items : []).map(Number))].filter((n) => Number.isInteger(n) && n >= 1 && n <= input.amounts.length).map((n) => input.amounts[n - 1].id);
    return { answer: answer.text, problems: answer.bad, items };
  }
  if (purpose === 'tlFind') {
    const out = [];
    for (const p of Array.isArray(reply.periods) ? reply.periods.slice(0, 20) : []) {
      const note = input.notes[Number(p?.note) - 1];
      if (!note || !ISO.test(p.start || '') || (p.end != null && !ISO.test(p.end)) || (p.end && p.end < p.start)) continue;
      const label = free(String(p.label || '').slice(0, 80));
      const quote = free(String(p.quote || '').slice(0, 300));
      const why = free(String(p.why || '').slice(0, 300));
      // A period whose words can't be restored exactly is dropped, never shown half-filled.
      if (!label.text || label.bad.length || quote.bad.length) continue;
      out.push({ label: label.text, cat: PERIOD_CATS.includes(p.category) ? p.category : 'Other', start: p.start, end: p.end || null, approx: !!p.approx,
        quote: quote.text, why: why.text, clipId: note.clipId, noteDate: note.date || null });
    }
    return { periods: out };
  }
  if (purpose === 'tlExplain') {
    const r = free(typeof reply.explanation === 'string' ? reply.explanation.slice(0, 3000) : '');
    return { explanation: r.text, problems: r.bad };
  }
  if (purpose === 'flowSteps') {
    const ids = new Map(input.pages.map((p) => [p.id, p]));
    const vars = new Set(['ref', ...Object.keys(lib.fields)]);
    const steps = [];
    for (const st of (Array.isArray(reply.steps) ? reply.steps : []).slice(0, 40)) {
      const page = ids.get(st?.page);
      if (!page) continue;
      const text = free(String(st.text || '').slice(0, 3000));
      if (text.bad.length) continue;
      const links = [];
      for (const l of (Array.isArray(st.links) ? st.links : []).slice(0, 6)) {
        const label = free(String(l?.label || '').slice(0, 80));
        const to = ids.has(l?.to) ? l.to : '';
        const url = typeof l?.url === 'string' ? l.url.trim().slice(0, 2000) : '';
        // An address is used only if it's a web address with no placeholder in it, and every {name} is known.
        const names = [...url.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((m) => m[1]);
        const urlOk = url && /^https?:\/\//.test(url) && !placeholderIn(url) && names.every((n) => vars.has(n));
        if (label.bad.length || (!urlOk && !to)) continue;
        links.push({ label: label.text, url: urlOk ? url : '', to });
      }
      // An "only if" in the guidance, as a condition on one known name: missing or present.
      const w = st.when;
      const when = w && typeof w === 'object' && vars.has(w.field) && ['missing', 'present'].includes(w.is) ? { field: w.field, is: w.is } : null;
      steps.push({ page: page.id, text: text.text, links, ...(when ? { when } : {}) });
    }
    return { steps, notes: typeof reply.notes === 'string' ? free(reply.notes.slice(0, 500)).text : '' };
  }
  if (purpose === 'extract' || purpose === 'read' || purpose === 'readImage') {
    const values = reply.values && typeof reply.values === 'object' ? reply.values : {};
    const { values: restored, problems } = restore(payload, values, request.schema);
    const rows = Object.entries(restored).filter(([k]) => lib.fields[k]).map(([key, v]) => {
      const bad = problems.find((p) => p.field === key)?.bad || [];
      const raw = typeof v === 'object' ? v.value : v;
      const check = raw ? validateValue(lib.fields[key], raw) : { ok: false, error: 'Empty' };
      return { key, value: check.ok ? check.value : String(raw || ''), quote: typeof v === 'object' ? v.quote || '' : '', ok: !bad.length && check.ok, error: bad.length ? 'Couldn’t restore a placeholder, so this was left empty' : check.ok ? null : check.error, bad };
    });
    return { rows, notes: typeof reply.notes === 'string' ? reply.notes.slice(0, 500) : '', ...(purpose === 'readImage' && typeof reply.text === 'string' ? { text: reply.text.slice(0, 20000) } : {}) };
  }
  const placeholder = /redacted:/i;
  if (purpose === 'form') {
    const boxes = new Set([...(input.form.controls || []), ...(input.form.groups || []).flatMap((g) => g.controls)].map((c) => c.selector));
    const fields = {};
    const dropped = [];
    for (const [box, key] of Object.entries(reply.fields || {})) {
      if (boxes.has(box) && lib.fields[key] && (!input.keys?.length || input.keys.includes(key)) && !placeholder.test(box + key)) fields[box] = key;
      else dropped.push(box);
    }
    return { fields, dropped, notes: typeof reply.notes === 'string' ? reply.notes.slice(0, 500) : '' };
  }
  if (purpose === 'flowForm') {
    // Only boxes that are on the form, keys and labels with no placeholder in them. Types are checked by the flow.
    const boxes = new Set([...(input.form.controls || []), ...(input.form.groups || []).flatMap((g) => g.controls)].map((c) => c.selector));
    const fields = [];
    const dropped = [];
    for (const f of (Array.isArray(reply.fields) ? reply.fields : []).slice(0, 80)) {
      const box = typeof f?.box === 'string' ? f.box : '';
      const label = typeof f?.label === 'string' ? f.label.trim().slice(0, 80) : '';
      if (!boxes.has(box) || !label || placeholder.test(box + label + (f.key || ''))) { dropped.push(box || '?'); continue; }
      fields.push({ box, label, key: typeof f.key === 'string' ? f.key : '', type: TYPES.includes(f.type) ? f.type : 'text', required: f.required !== false, typed: !!f.typed });
    }
    return { name: free(String(reply.name || '').slice(0, 60)).text, fields, dropped, notes: typeof reply.notes === 'string' ? reply.notes.slice(0, 500) : '' };
  }
  if (purpose === 'profile') {
    const fields = {};
    const dropped = [];
    for (const [key, spec] of Object.entries(reply.fields || {})) {
      if (lib.fields[key] && (!input.keys?.length || input.keys.includes(key)) && typeof spec === 'string' && !placeholder.test(spec)) fields[key] = spec;
      else dropped.push(key);
    }
    const profile = validate({ name: String(reply.name || input.title || 'Suggested profile').slice(0, 60), match: ['https://example.invalid/*'], fields });
    const out = E.extract(request.doc, profile, { baseUrl: input.url });
    return { name: profile.name, fields, dropped, sample: out.data, problems: review(out.data, out.diagnostics), notes: typeof reply.notes === 'string' ? reply.notes.slice(0, 500) : '' };
  }
  throw new Error('Unknown AI action');
}

/**
 * Run a ✦ action end to end. Resolves null when the caseworker cancels the preview.
 * context: (parts) => what the boundary needs for those parts (known values, patterns, model spans, settings).
 */
export async function runTask(purpose, input, { lib, context, config, signal, completeFn = complete, onSent }) {
  const system = await loadPrompt(PROMPTS[purpose]);
  const request = buildRequest(purpose, input, { lib, system, maxHtmlChars: config?.maxHtmlChars });
  // The context depends on the request: the on-device model scans every part that will be sent.
  const payload = await previewBeforeSend(request, await context(request.parts));
  if (!payload) return null;
  onSent?.(payload);
  try {
    let text;
    for (let attempt = 1; ; attempt++) {
      try { text = await completeFn(payload, config, { signal }); break; } catch (e) {
        // Transport retries resend the same approved payload; they never rebuild it.
        if (!e.retryable || attempt >= 3 || signal?.aborted) throw e;
        await new Promise((r) => setTimeout(r, attempt * 400));
      }
    }
    return { payload, ...parseAnswer(purpose, payload, text, { lib, request, input }) };
  } finally { forget(payload); }
}

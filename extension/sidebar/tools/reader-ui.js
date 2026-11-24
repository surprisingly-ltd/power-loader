// The reader: select a region of the screen, paste a screenshot, drop a file or choose one; read it on this
// computer (pdf.js text, OCR for scans and pictures), check the values, then add them as a clip with their
// quotes and page numbers. ✦ Enhanced sends the text read here to the AI gateway, after the preview; or, if the
// caseworker chooses, a picture itself, which can't be redacted, once they have said they understand that.
// Whatever is read, its text can be copied or kept in the case, even when no field matches it.
/* global browser */
import { h, plural, announce, copyText, describeError } from '../../ui/dom.js';
import { classify, imageForAi, imageForOcr, renderPage } from '../../lib/reader/sources.js';
import { LIMITS, openPdf, pdfText } from '../../lib/reader/pdf.js';
import { ocrImage, stopOcr } from '../../lib/reader/ocr.js';
import { matchDocument, textLines } from '../../lib/reader/match.js';
import { addClip, caseKeys, fieldState, settled } from '../../lib/case.js';
import { display, norm, validateValue } from '../../lib/fields.js';
import { logEvent } from '../../lib/activity.js';
import { recordFailure } from '../../lib/diagnostics.js';
import { ask } from '../../lib/core.js';
import { enhancedGate, modeSeg, tools } from './tools.js';
import { aiReady } from '../../lib/ai/settings.js';
import { runAi, showExtractResult } from '../privacy.js';

const CONF = { high: ['ok', 'High'], medium: ['warn', 'Medium'], low: ['bad', 'Low'] };
// send: how ✦ Enhanced reads a picture: 'text' (read here, send the redacted text) or 'image' (send the picture).
export const rd = { job: null, result: null, error: null, send: 'text' };
let pdfjs = null;

async function loadPdfjs() {
  if (pdfjs) return pdfjs;
  pdfjs = await import('../../vendor/pdfjs/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = browser.runtime.getURL('vendor/pdfjs/pdf.worker.min.mjs');
  return pdfjs;
}

// Teardown or cancel: stop OCR at once and drop anything read for the case.
export function stopReader() {
  rd.job?.controller.abort();
  rd.job = null;
  rd.result = null;
  rd.error = null;
  void stopOcr();
}

async function read(context, file, how, pages) {
  const { data, lib, act } = context;
  if (!data.case) return;
  stopReader();
  const enhanced = tools.mode.reader === 'enhanced' && aiReady(data.settings);
  const sendImage = enhanced && rd.send === 'image' && !imagesBlocked(context);
  const controller = new AbortController();
  const job = { controller, caseId: data.case.id, steps: [], file, how, title: how === 'region' ? 'Reading the selected region' : `Reading ${file.name || 'the pasted picture'}` };
  rd.job = job;
  const step = (text) => { if (rd.job !== job) return; job.steps.forEach((s) => { s.done = true; }); job.steps.push({ t: text }); act.render(); };
  step(how === 'region' ? `Captured a ${file.width}×${file.height} px region of the visible tab` : how === 'paste' ? 'Received the pasted picture' : `Opened ${file.name}`);
  try {
    const kind = await classify(file);
    const keys = caseKeys(data.case, lib).filter((k) => !lib.fields[k].manual);
    const name = file.name || (how === 'paste' ? 'Pasted picture' : how === 'region' ? `${context.ui?.page?.title || 'Page'} (region)` : 'Document');
    if (sendImage && kind === 'image') {
      // Nothing is read here: the picture goes to the AI as it is, after the preview, which shows it.
      step('Preparing the picture to send (it can’t be redacted)');
      const img = await imageForAi(file);
      controller.signal.throwIfAborted();
      if (rd.job !== job || context.data.case?.id !== job.caseId) return;
      rd.job = null;
      act.render();
      const source = { name, url: '', page: { type: 'document' } };
      await runAi(context, 'readImage', { image: img.url, width: img.width, height: img.height, title: name, keys }, async (out) => {
        if (out.text) rd.result = { name, how, kind, size: file.size, pages: [{ n: 1, how: 'ai' }], rows: [], text: out.text, chosen: new Set(), fromAi: true };
        showExtractResult(context, out, source, 'ai_read_document');
      });
      return;
    }
    let lines = [];
    const pageInfo = [];
    if (kind === 'pdf') {
      step('Reading the text layer (pdf.js, on this computer)');
      const doc = await openPdf(await loadPdfjs(), new Uint8Array(await file.arrayBuffer()));
      const list = await pdfText(doc, { pages, signal: controller.signal });
      for (const p of list) {
        if (!p.scan) { lines.push(...textLines([p])); pageInfo.push({ n: p.n, how: 'text' }); continue; }
        step(`Page ${p.n} has no text layer: reading it with OCR on this computer`);
        const out = await ocrImage(await renderPage(p.page), { page: p.n, signal: controller.signal });
        lines.push(...out.lines);
        pageInfo.push({ n: p.n, how: 'ocr' });
      }
    } else {
      step('Reading the text on this computer (OCR)');
      const out = await ocrImage(await imageForOcr(file), { page: 1, signal: controller.signal });
      lines = out.lines;
      pageInfo.push({ n: 1, how: 'ocr' });
    }
    controller.signal.throwIfAborted();
    // A late result for a case that ended, or a cancelled job, is dropped.
    if (rd.job !== job || context.data.case?.id !== job.caseId) return;
    if (enhanced) {
      step('Sending the text read here to the AI, after you check a redacted preview');
      rd.job = null;
      act.render();
      const text = lines.map((l) => l.text).join('\n');
      const source = { name, url: '', page: { type: 'document' } };
      await runAi(context, 'read', { text, title: name, url: '', keys, label: 'Text read on this computer' }, async (out) => showExtractResult(context, out, source, 'ai_read_document'));
      return;
    }
    step('Matching the text to this case’s field labels');
    const match = matchDocument(lines, lib, keys, lib.documents);
    rd.result = { name, how, kind, size: file.size, pages: pageInfo, ...match, text: lines.map((l) => l.text).join('\n'), rows: match.rows.map((r) => ({ ...r })), chosen: new Set(match.rows.filter((r) => r.ok && statusOf(context, r).s !== 'match' && r.confidence !== 'low').map((r) => r.key)) };
    rd.job = null;
    announce(match.rows.length ? `Read ${plural(pageInfo.length, 'page')}: ${plural(match.rows.length, 'value')} found` : `Read ${plural(pageInfo.length, 'page')}. None of it matches this case’s fields, but the text is shown to copy or keep.`);
  } catch (e) {
    if (rd.job !== job) return;
    if (e.name === 'AbortError') { rd.job = null; rd.error = { message: 'Reading was cancelled.' }; }
    else {
      void recordFailure(`reader-${e.reason || 'error'}`);
      job.steps[job.steps.length - 1].fail = true;
      rd.error = { reason: e.reason, message: describeError(e), numPages: e.numPages, file, how };
    }
  }
  act.render();
}

function statusOf({ data, lib }, r) {
  const check = r.value ? validateValue(lib.fields[r.key], r.value) : { ok: false, error: 'Empty' };
  if (!check.ok) return { s: 'invalid', c: 'bad', t: `Check this value: ${check.error}` };
  const st = fieldState(data.case, lib, r.key);
  if (st.status === 'missing') return { s: 'new', c: 'ok', t: 'New' };
  if (st.status === 'conflict') return { s: 'conflict', c: 'bad', t: 'Already in conflict' };
  if (settled(st.status) && norm(lib.fields[r.key], st.value) === norm(lib.fields[r.key], check.value)) return { s: 'match', c: '', t: 'Matches case' };
  return { s: 'differs', c: 'bad', t: `Differs from ${display(lib.fields[r.key], st.value)}` };
}

async function addToCase(context) {
  const { lib, act } = context;
  const r = rd.result;
  const values = {};
  const quotes = {};
  const pages = {};
  // Re-validated on add, not just on display.
  for (const row of r.rows.filter((x) => r.chosen.has(x.key))) {
    const check = validateValue(lib.fields[row.key], row.value);
    if (!check.ok) continue;
    values[row.key] = check.value;
    quotes[row.key] = row.quote;
    pages[row.key] = row.page;
  }
  if (!Object.keys(values).length) return;
  const activity = r.how === 'paste' ? 'read_pasted_image' : r.how === 'region' ? 'read_screen_region' : 'read_document';
  await act.update((c, l) => {
    const summary = addClip(c, l, { source: `document|${r.name}|${r.size}|${Date.now()}`, kind: r.how === 'region' ? 'region' : 'document', profile: r.profile ? { id: r.profile.id, version: r.profile.version } : { id: 'document', version: '' }, name: r.name, url: r.url || '', title: r.name, capturedAt: new Date().toISOString(), values, quotes, pages, records: [], extra: {} });
    logEvent(c, activity, { page: { type: r.profile ? `${r.profile.id}@${r.profile.version}` : 'document' }, detail: `${plural(r.pages.length, 'page')}, ${plural(Object.keys(values).length, 'value')}`, clip: summary.clipId });
  }, `Added ${plural(Object.keys(values).length, 'value')} from ${r.name}`);
  rd.result = null;
  act.render();
}

const failed = (job) => !!job.steps.at(-1)?.fail;

function jobView({ act }) {
  const j = rd.job;
  if (!j) return null;
  return h('div', { class: 'card', role: 'status' },
    h('b', {}, j.title),
    h('ul', { class: 'jobsteps' }, j.steps.map((s, i) => {
      const state = s.fail ? 'fail' : s.done ? 'ok' : i === j.steps.length - 1 ? 'run' : 'todo';
      return h('li', { class: state }, h('span', { class: 'si', 'aria-hidden': 'true' }, state === 'ok' ? '✓' : state === 'fail' ? '✕' : state === 'run' ? h('span', { class: 'spinner' }) : '·'), s.t);
    })),
    failed(j) ? null : h('button', { type: 'button', class: 'sm', 'data-key': 'rd-cancel', style: 'align-self:flex-start', onclick: () => { stopReader(); rd.error = { message: 'Reading was cancelled.' }; act.render(); } }, 'Cancel'));
}

function resultView(context) {
  const { lib, act } = context;
  const r = rd.result;
  if (!r.rows.length) {
    return h('div', { class: 'card', role: 'region', 'aria-label': 'What the reader found' },
      h('div', { class: 'row between' }, h('b', {}, r.text?.trim() ? 'Text read' : 'No text found'), h('span', { class: 'small muted' }, r.name)),
      h('p', { class: 'small muted' }, r.fromAi && r.text?.trim() ? 'The text the AI read in the picture. Any values it found for this case are in its answer.' : r.text?.trim()
        ? `None of it matches a field this case needs${r.fromAi ? '' : ', so nothing is added on its own'}. Copy the text, or keep it in the case as a note: the ✦ timeline and calculator read notes.`
        : r.how === 'region' ? 'Nothing could be read. Draw the box around the text, a little larger.' : 'Nothing could be read in it.'),
      textBlock(context, r, true),
      h('button', { type: 'button', class: 'sm', 'data-key': 'rd-discard', style: 'align-self:flex-start', onclick: () => { rd.result = null; act.render(); } }, 'Close'));
  }
  const rows = r.rows.map((row) => ({ row, st: statusOf(context, row) }));
  const order = { new: 0, differs: 1, conflict: 2, invalid: 3, match: 4 };
  rows.sort((a, b) => order[a.st.s] - order[b.st.s]);
  const n = rows.filter(({ row, st }) => r.chosen.has(row.key) && st.s !== 'invalid').length;
  return h('div', { class: 'card', role: 'region', 'aria-label': 'What the reader found' },
    h('div', { class: 'row between' }, h('b', {}, `Found ${plural(rows.length, 'value')}`), h('span', { class: 'small muted' }, r.name)),
    h('p', { class: 'small muted' }, `${r.pages.map((p) => `page ${p.n}: ${p.how === 'ocr' ? 'OCR' : 'text layer'}`).join(', ')}${r.profile ? ` · read as ${r.profile.name} ${r.profile.version}` : ' · matched by field labels'}`),
    r.pages.some((p) => p.how === 'ocr') ? h('p', { class: 'notice warn small' }, 'OCR can misread handwriting, stamps and faint text. Check each value against the document.') : null,
    h('div', {}, rows.map(({ row, st }) => h('div', { class: 'rd-row' },
      h('input', { type: 'checkbox', 'data-key': `rd-${row.key}`, checked: r.chosen.has(row.key), 'aria-label': `Use ${lib.fields[row.key].label}`, onchange: (e) => { if (e.target.checked) r.chosen.add(row.key); else r.chosen.delete(row.key); act.render(); } }),
      h('div', { class: 'stack', style: 'gap:3px;min-width:0' },
        h('div', { class: 'row', style: 'gap:5px' }, h('span', { class: 'small muted' }, lib.fields[row.key].label), h('span', { class: `pill ${st.c}` }, st.t), h('span', { class: `pill ${CONF[row.confidence][0]}` }, CONF[row.confidence][1])),
        h('input', { type: 'text', 'data-key': `rd-v-${row.key}`, value: row.value || row.raw || '', 'aria-label': `${lib.fields[row.key].label} value`, 'aria-invalid': String(st.s === 'invalid'), onchange: (e) => { row.value = e.target.value; act.render(); } }),
        row.quote ? h('q', {}, row.quote) : null, h('span', { class: 'small muted' }, `page ${row.page}`))))),
    textBlock(context, r, false),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'primary', 'data-key': 'rd-add', disabled: !n, onclick: () => addToCase(context) }, `Add ${n} to case`),
      h('button', { type: 'button', 'data-key': 'rd-discard', onclick: () => { rd.result = null; act.render(); } }, 'Discard')));
}

// All the text read, to copy or keep in the case as a note (a customer's letter, a PDF with no matching fields).
function textBlock(context, r, open) {
  const text = String(r.text || '').trim();
  if (!text) return null;
  const lines = text.split('\n').length;
  return h('details', { class: 'stack', ...(open ? { open: true } : {}) },
    h('summary', { class: 'small' }, `All the text read (${plural(lines, 'line')})`),
    h('pre', { class: 'px-text small', tabindex: '0', 'data-key': 'rd-text', style: 'max-height:240px;overflow:auto;white-space:pre-wrap' }, text),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'sm', 'data-key': 'rd-copy', onclick: () => copyText(text, 'Text') }, 'Copy text'),
      r.kept ? h('span', { class: 'pill ok' }, '✓ Kept in the case') : h('button', { type: 'button', class: 'sm', 'data-key': 'rd-keep', onclick: () => keepText(context) }, 'Keep the text in the case')));
}

// The text as a clip with one note: it's in the case's clips, shows in the notes the ✦ tools read, and goes at teardown.
async function keepText(context) {
  const r = rd.result;
  if (!r?.text) return;
  const today = new Date().toISOString().slice(0, 10);
  const activity = r.how === 'paste' ? 'read_pasted_image' : r.how === 'region' ? 'read_screen_region' : 'read_document';
  await context.act.update((c, l) => {
    const summary = addClip(c, l, {
      source: `document-text|${r.name}|${r.size}|${Date.now()}`, kind: r.how === 'region' ? 'region' : 'document', profile: { id: 'document-text', version: '' },
      name: `${r.name} (text)`, url: '', title: r.name, capturedAt: new Date().toISOString(), values: {}, quotes: {},
      records: [{ id: 'text-1', type: 'note', group: 'text', date: today, text: r.text }], extra: {},
    });
    logEvent(c, activity, { page: { type: 'document' }, detail: `text kept, ${plural(r.text.split('\n').length, 'line')}`, clip: summary.clipId });
  }, `The text from ${r.name} is kept in the case`);
  if (rd.result === r) r.kept = true;
  context.act.render();
}

const imagesBlocked = (context) => !!context.data.policy?.values?.redaction?.blockImages;

// ⬚ Select a region: the page shows a box to drag; the visible tab is captured and cropped to it here.
async function selectRegion(context) {
  const { ui, data, act } = context;
  // Capturing a tab needs the "all sites" permission; asking must happen in the click itself.
  const allowed = browser.permissions.request({ origins: ['<all_urls>'] });
  if (!await allowed.catch(() => false)) { announce('Power Loader needs permission to capture the screen to read a region'); return; }
  let box;
  try { box = await ask(ui.page.id, { type: 'powerloader:selectRegion' }); } catch (e) { announce(`Couldn’t start selecting: ${describeError(e)}`); return; }
  if (!box) { announce('Selecting a region was cancelled'); return; }
  try {
    // Firefox captures just the box (CSS pixels of the viewport) at the screen's own resolution.
    const url = await browser.tabs.captureVisibleTab(ui.windowId, { format: 'png', rect: { x: box.x, y: box.y, width: box.w, height: box.h }, scale: box.dpr });
    const blob = await (await fetch(url)).blob();
    const file = new File([blob], 'region.png', { type: 'image/png' });
    file.width = Math.round(box.w * box.dpr);
    file.height = Math.round(box.h * box.dpr);
    if (data.case) await read(context, file, 'region');
  } catch (e) {
    void recordFailure('reader-region');
    announce(`Couldn’t capture the region: ${describeError(e)}`);
    act.render();
  }
}

export function readerBlock(context) {
  const { act, ui } = context;
  const enhanced = tools.mode.reader === 'enhanced';
  const input = h('input', { type: 'file', id: 'rd-file', 'data-key': 'rd-file', accept: 'application/pdf,image/*', class: 'sr', tabindex: '-1', onchange: (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) read(context, f, 'file'); } });
  const zone = h('div', {
    class: 'pastezone', tabindex: '0', role: 'button', 'data-key': 'rd-zone', 'aria-label': 'Paste or drop a screenshot or file',
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } },
    ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add('drag'); },
    ondragleave: (e) => e.currentTarget.classList.remove('drag'),
    ondrop: (e) => { e.preventDefault(); e.currentTarget.classList.remove('drag'); const f = e.dataTransfer?.files?.[0]; if (f) read(context, f, 'drop'); },
  }, 'Click here and press ', h('b', {}, 'Ctrl+V'), ' to paste a screenshot, or drop a file.', h('br'),
  h('span', { class: 'small' }, 'If you can’t select it on the page, snip it with ', h('b', {}, 'Win+Shift+S'), ' first.'));
  const e = rd.error;
  // A failed read stays on screen, with its steps, until something else is read.
  const busy = !!rd.job && !failed(rd.job);
  const canRegion = !!ui?.page && /^https?:/.test(ui.page.url || '') && ui.info?.access;
  return [
    h('div', { class: 'row between' }, modeSeg(context, 'reader')),
    enhanced ? enhancedGate(context) || [
      h('fieldset', { class: 'stack', style: 'gap:4px;border:0;padding:0;margin:0' },
        h('legend', { class: 'small' }, 'For a picture, a screen region or a screenshot'),
        h('label', { class: 'check small' }, h('input', { type: 'radio', name: 'rd-send', 'data-key': 'rd-send-text', checked: rd.send !== 'image' || imagesBlocked(context), onchange: () => { rd.send = 'text'; act.render(); } }),
          h('span', {}, h('b', {}, 'Read it here, then send the text'), h('br'), h('span', { class: 'muted' }, 'OCR on this computer; you check the redacted text before it’s sent.'))),
        imagesBlocked(context) ? h('p', { class: 'small muted' }, 'Your organisation doesn’t allow pictures to be sent to the AI.')
          : h('label', { class: 'check small' }, h('input', { type: 'radio', name: 'rd-send', 'data-key': 'rd-send-image', checked: rd.send === 'image', onchange: () => { rd.send = 'image'; act.render(); } }),
            h('span', {}, h('b', {}, 'Send the picture itself'), h('br'), h('span', { class: 'muted' }, 'Better for handwriting, stamps and poor scans. The picture can’t be redacted: you see it, and confirm, before it’s sent.')))),
      h('div', { class: 'disclose' }, rd.send === 'image' && !imagesBlocked(context)
        ? '✦ Sends the picture as it is, with this case’s field names, to your organisation’s AI gateway. PDFs with a text layer are still read here and sent as redacted text.'
        : '✦ Reads the document here first, then sends the text it found, with this case’s field names, to your organisation’s AI gateway. Best for letters and statements in unusual layouts. You check a redacted preview first.'),
    ]
      : h('p', { class: 'small muted' }, `Standard reads PDF text layers and runs OCR on this computer. Nothing leaves the browser. Up to ${LIMITS.pages} pages and ${LIMITS.bytes / 1024 / 1024} MB.`),
    h('div', { class: 'row', style: 'flex-wrap:nowrap' },
      canRegion ? h('button', { type: 'button', 'data-key': 'rd-region', style: 'flex:1', disabled: busy, onclick: () => selectRegion(context) }, '⬚ Select a region') : null,
      h('button', { type: 'button', 'data-key': 'rd-choose', style: 'flex:1', disabled: busy, onclick: () => input.click() }, 'Choose a file'),
      h('label', { for: 'rd-file', class: 'sr' }, 'Choose a PDF or picture to read'), input),
    busy ? null : zone,
    jobView(context),
    e ? h('div', { class: 'notice warn', role: 'alert' }, h('p', {}, e.message),
      e.reason === 'too-many-pages' ? h('button', { type: 'button', class: 'sm', 'data-key': 'rd-first', onclick: () => read(context, e.file, e.how, [1, LIMITS.firstPages]) }, `Read pages 1–${LIMITS.firstPages}`) : null,
      canRegion && e.reason !== 'too-many-pages' ? h('p', { class: 'small' }, 'Read it from the screen instead with ⬚ Select a region, or snip it with Win+Shift+S and paste it above.') : null) : null,
    rd.result ? resultView(context) : null,
  ];
}

// Ctrl+V anywhere in the sidebar while the reader is open.
export function onPaste(context, event) {
  const file = [...(event.clipboardData?.files || [])][0];
  if (!file || !context.data.case) return false;
  event.preventDefault();
  read(context, file, 'paste');
  return true;
}

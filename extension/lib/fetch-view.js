// What a fetch step read, as text: the response laid out as lines (a page's readable text, block by block; JSON
// with one key to a line), where in those lines each value the template reads is, and the excerpts a clip keeps
// so the caseworker can look back at it. Pure, no browser APIs: it walks a parsed document (DOMParser's, or
// lib/json-dom.js's synthetic one) and never builds markup from the response. See
// docs/plans/conflicts-and-fetch-views.md, section 3.
import './json-dom.js';

const E = () => globalThis.PowerLoaderExtract;
const J = () => globalThis.PowerLoaderJson;

export const VIEW_LIMITS = Object.freeze({
  lineChars: 400, // a line longer than this is cut, keeping the value it holds in view
  boxLines: 400, // lines sent to the box drawn on the page: around each value when the response is longer
  around: 3, // lines either side of a value, in the box's windows and in a JSON excerpt
  excerptChars: 500, // one value's excerpt
  clipChars: 20 * 1024, // every excerpt of one clip
  marksPerField: 5, // rows of a list outlined, at most
});

const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'title', 'meta', 'link', 'svg', 'iframe', 'object', 'canvas']);
const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'body', 'caption', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'legend', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'thead', 'tfoot', 'tr', 'ul', 'label', 'option']);
const CELL = new Set(['td', 'th']);
const clean = (s) => String(s || '').replace(/\s+/g, ' ');

/**
 * A page's readable text: one line a block (a paragraph, a list item, a table row with its cells side by side),
 * and for each element read, the line it is on. { lines: [text], lineOf: Map(element → line) }.
 */
function pageLines(doc) {
  const lines = [];
  const lineOf = new Map();
  let cur = null; // the line being written: { text, els: [] }
  const flush = () => {
    if (cur && cur.text.trim()) {
      const n = lines.length;
      lines.push(cur.text.trim());
      for (const el of cur.els) if (!lineOf.has(el)) lineOf.set(el, n);
    }
    cur = null;
  };
  const write = (text, el) => {
    if (!cur) cur = { text: '', els: [], last: null };
    // Two elements side by side with no space between them in the markup (links in a row) read as two words.
    if (cur.text && cur.last !== el && !/\s$/.test(cur.text) && !/^\s/.test(text) && !['b', 'i', 'em', 'strong', 'span', 'sup', 'sub', 'small'].includes(el.localName)) cur.text += ' ';
    cur.last = el;
    cur.text += text;
    // The element and those it is in, up to its block: each is on this line, if not on an earlier one.
    for (let a = el; a && a.nodeType === 1; a = a.parentNode) { if (cur.els.includes(a)) break; cur.els.push(a); if (BLOCK.has(a.localName)) break; }
  };
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) { const t = clean(child.data); if (t.trim()) write(t, child.parentNode); continue; }
      if (child.nodeType !== 1) continue;
      const tag = child.localName;
      if (SKIP.has(tag)) continue;
      if (tag === 'br') { flush(); continue; }
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        const v = clean(child.value ?? child.getAttribute('value') ?? '');
        if (v.trim()) write(` ${v} `, child);
        continue;
      }
      if (BLOCK.has(tag)) flush();
      if (CELL.has(tag) && cur?.text.trim()) write('   ', child);
      walk(child);
      if (BLOCK.has(tag)) flush();
    }
  };
  walk(doc.body || doc.documentElement || doc);
  flush();
  return { lines, lineOf };
}

/**
 * JSON with one key to a line, as it is usually printed: "name": "Sophie",. For each element, the line it starts
 * on and, for a scalar, where its value is in that line. { lines, lineOf: Map(element → line), at: Map(element →
 * [start, end]) }.
 */
function jsonLines(doc) {
  const lines = [];
  const lineOf = new Map();
  const at = new Map();
  const T = J().TAGS;
  const walk = (el, depth, last) => {
    const pad = '  '.repeat(depth);
    const key = el.hasAttribute('key') ? `${JSON.stringify(el.getAttribute('key'))}: ` : '';
    const comma = last ? '' : ',';
    lineOf.set(el, lines.length);
    if (el.localName === T.object || el.localName === T.array) {
      const [open, close] = el.localName === T.object ? ['{', '}'] : ['[', ']'];
      const kids = [...el.children];
      if (!kids.length) { lines.push(`${pad}${key}${open}${close}${comma}`); return; }
      lines.push(`${pad}${key}${open}`);
      kids.forEach((k, i) => walk(k, depth + 1, i === kids.length - 1));
      lines.push(`${pad}${close}${comma}`);
      return;
    }
    const value = J().rawValue(el) ?? '';
    const head = `${pad}${key}`;
    at.set(el, [head.length, head.length + value.length]);
    lines.push(`${head}${value}${comma}`);
  };
  if (doc.documentElement) walk(doc.documentElement, 0, true);
  return { lines, lineOf, at };
}

// The element a field reads (the part before its filters), or each row of a list.
function elementsOf(doc, spec) {
  try {
    if (Array.isArray(spec)) return typeof spec[0] === 'string' ? E().locate(doc, spec[0]).slice(0, VIEW_LIMITS.marksPerField) : [];
    if (typeof spec !== 'string' || spec.startsWith('=')) return [];
    return E().locate(doc, E().locatorOf(spec)).slice(0, 1);
  } catch { return []; }
}

/**
 * The response as text, with where each value is: { format, lines: [text], marks: [{ key, line, start, end,
 * list? }] }. A value that has no place in the text (typed into the template, or read from an attribute) has
 * no mark. lines are cut at VIEW_LIMITS.lineChars around the value they hold.
 */
export function textView(doc, profile) {
  const json = profile?.format === 'json';
  const out = json ? jsonLines(doc) : pageLines(doc);
  const marks = [];
  for (const [key, spec] of Object.entries(profile?.fields || {})) {
    if (key.startsWith('@')) continue;
    for (const el of elementsOf(doc, spec)) {
      let line = out.lineOf.get(el);
      // An element with no text of its own (an empty cell): the line of the first element in it that has some.
      if (line == null) for (const d of el.querySelectorAll?.('*') || []) { if (out.lineOf.has(d)) { line = out.lineOf.get(d); break; } }
      if (line == null) continue;
      let range = out.at?.get(el);
      if (!range) {
        const text = clean(el.textContent || el.value || '').trim();
        const i = text ? out.lines[line].indexOf(text) : -1;
        range = i >= 0 ? [i, i + text.length] : [0, out.lines[line].length];
      }
      marks.push({ key, line, start: range[0], end: range[1], ...(Array.isArray(spec) ? { list: true } : {}) });
    }
  }
  // Long lines are cut around what they hold.
  const lines = out.lines.map((text, n) => {
    if (text.length <= VIEW_LIMITS.lineChars) return text;
    const m = marks.find((x) => x.line === n);
    const from = m ? Math.max(0, Math.min(m.start - 40, text.length - VIEW_LIMITS.lineChars)) : 0;
    for (const x of marks) if (x.line === n) { x.start = Math.max(0, x.start - from + (from ? 1 : 0)); x.end = Math.min(VIEW_LIMITS.lineChars + 1, x.end - from + (from ? 1 : 0)); }
    return `${from ? '…' : ''}${text.slice(from, from + VIEW_LIMITS.lineChars)}…`;
  });
  return { format: json ? 'json' : 'html', lines, marks };
}

/**
 * The lines to draw in a box on the page: all of them when they fit, else windows around each value with a gap
 * between. [{ n, text } | { gap: true }], and the marks with line as an index into that list.
 */
export function boxLines(view, max = VIEW_LIMITS.boxLines) {
  const total = view.lines.length;
  let keep;
  if (total <= max) keep = view.lines.map((_, n) => n);
  else {
    const want = new Set();
    for (let n = 0; n < Math.min(total, 6); n++) want.add(n);
    for (const m of view.marks) for (let n = m.line - VIEW_LIMITS.around; n <= m.line + VIEW_LIMITS.around; n++) if (n >= 0 && n < total) want.add(n);
    keep = [...want].sort((a, b) => a - b).slice(0, max);
  }
  const rows = [];
  const index = new Map();
  keep.forEach((n, i) => {
    if (i && n !== keep[i - 1] + 1) rows.push({ gap: true });
    else if (!i && n) rows.push({ gap: true });
    index.set(n, rows.length);
    rows.push({ n, text: view.lines[n] });
  });
  if (keep.length && keep.at(-1) < total - 1) rows.push({ gap: true });
  return { rows, marks: view.marks.filter((m) => index.has(m.line)).map((m) => ({ ...m, line: index.get(m.line) })), total };
}

/**
 * What a clip keeps of a fetched response, so the caseworker can look back at it: for each value, the text
 * around it (a page's block; for JSON, a few lines either side), up to excerptChars a value and clipChars a
 * clip. { key: { lines: [{ n, text }], marks: [{ line, start, end }] } }, line an index into lines. Only keys
 * the clip holds are kept (keys: the clip's values and lists).
 */
export function excerptsOf(view, keys) {
  const out = {};
  let used = 0;
  const want = new Set(keys);
  for (const key of [...new Set(view.marks.map((m) => m.key))]) {
    if (!want.has(key)) continue;
    const marks = view.marks.filter((m) => m.key === key).slice(0, view.format === 'json' ? 3 : VIEW_LIMITS.marksPerField);
    const around = view.format === 'json' ? VIEW_LIMITS.around : 0;
    const ns = [...new Set(marks.flatMap((m) => Array.from({ length: around * 2 + 1 }, (_, i) => m.line - around + i)))].filter((n) => n >= 0 && n < view.lines.length).sort((a, b) => a - b);
    const lines = [];
    let chars = 0;
    for (const n of ns) {
      let text = view.lines[n];
      const room = VIEW_LIMITS.excerptChars - chars;
      if (room <= 0) break;
      if (text.length > room) {
        // A line cut to fit keeps its value: cut around it.
        const m = marks.find((x) => x.line === n);
        const from = m ? Math.max(0, Math.min(m.start - 20, text.length - room)) : 0;
        text = text.slice(from, from + room);
        if (m) marks.forEach((x) => { if (x.line === n) { x.start = Math.max(0, x.start - from); x.end = Math.min(text.length, x.end - from); } });
      }
      lines.push({ n, text });
      chars += text.length;
    }
    if (!lines.length || used + chars > VIEW_LIMITS.clipChars) continue;
    used += chars;
    const index = new Map(lines.map((l, i) => [l.n, i]));
    out[key] = {
      lines,
      marks: marks.filter((m) => index.has(m.line)).map((m) => ({ line: index.get(m.line), start: m.start, end: Math.min(m.end, lines[index.get(m.line)].text.length) })),
    };
  }
  return out;
}

/** Excerpts in the shape a stored clip may have them: checked, so a hand-edited case can't put more on screen. */
export function validExcerpts(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return {};
  const out = {};
  for (const [k, v] of Object.entries(x)) {
    if (!Array.isArray(v?.lines) || !Array.isArray(v?.marks)) continue;
    const lines = v.lines.filter((l) => l && typeof l.text === 'string' && Number.isInteger(l.n)).map((l) => ({ n: l.n, text: l.text.slice(0, VIEW_LIMITS.excerptChars) }));
    out[k] = { lines, marks: v.marks.filter((m) => Number.isInteger(m?.line) && m.line < lines.length && Number.isInteger(m.start) && Number.isInteger(m.end)) };
  }
  return out;
}

// Personal data placeholders: categories, merging overlapping findings, the placeholder grammar and the
// strict restore. Shared by the model worker, the extension pages and the tests; no browser APIs.
// Based on an earlier PII prototype's pii.js; normalize() is replaced by union-cover merging.

export const MODEL_ID = 'openai/privacy-filter';

// Placeholder categories, grouped for the redaction settings. "Other dates" are off by default so the AI
// can still work out timelines.
export const GROUPS = { names: 'Names', dob: 'Dates of birth', ids: 'Identifiers', contact: 'Contact details', address: 'Addresses', dates: 'Other dates' };
export const DEFAULT_GROUPS = { names: true, dob: true, ids: true, contact: true, address: true, dates: false };
export const CATEGORIES = {
  first_name: { label: 'First name', group: 'names' },
  last_name: { label: 'Last name', group: 'names' },
  person_name: { label: 'Name', group: 'names' },
  date_of_birth: { label: 'Date of birth', group: 'dob', date: true },
  date: { label: 'Date', group: 'dates', date: true },
  nino: { label: 'NI number', group: 'ids', format: true },
  client_id: { label: 'Client ID', group: 'ids', format: true },
  reference: { label: 'Reference', group: 'ids', format: true },
  phone: { label: 'Phone', group: 'contact', format: true },
  email: { label: 'Email', group: 'contact' },
  address: { label: 'Address', group: 'address' },
  postcode: { label: 'Postcode', group: 'address', format: true },
};

// The on-device model's labels, as placeholder categories.
export const MODEL_LABELS = {
  private_person: 'person_name', private_address: 'address', private_date: 'date', private_email: 'email',
  private_phone: 'phone', account_number: 'reference', secret: 'reference',
};

// Splits text into pieces of at most `max` characters, preferring line breaks, then spaces,
// so each model call stays small and progress can be reported. Offsets index the original text.
export function chunkText(text, max = 2000) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + max, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end);
      const sp = text.lastIndexOf(' ', end);
      if (nl > start + max / 2) end = nl + 1;
      else if (sp > start + max / 2) end = sp + 1;
    }
    if (text.slice(start, end).trim()) chunks.push({ text: text.slice(start, end), offset: start });
    start = end;
  }
  return chunks;
}

export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The pipeline reports grouped entities as decoded text without character offsets, in reading
// order. Find each one in the chunk, searching forward from the previous match.
export function locate(text, groups, offset = 0) {
  const spans = [];
  let cursor = 0;
  for (const g of groups) {
    const word = (g.word || '').trim();
    if (!word) continue;
    const pattern = new RegExp(word.split(/\s+/).map(escapeRe).join('\\s+'), 'g');
    let m = null;
    for (const from of [cursor, 0]) {
      pattern.lastIndex = from;
      m = pattern.exec(text);
      if (m) break;
    }
    if (!m) continue;
    spans.push({ start: offset + m.index, end: offset + m.index + m[0].length, label: g.entity_group, score: g.score, text: m[0] });
    cursor = m.index + m[0].length;
  }
  return spans;
}

const TRIM = /[\s,.;:()"'“”‘’]/;

/**
 * Cover the union of overlapping findings. Strongest first (your own additions beat every detector):
 * each keeps its own label, and any part of a weaker finding the stronger ones don't cover stays a finding
 * of its own with its own label and score. "Maria Kowalska" as a name plus "Maria" as a first name gives
 * first_name + person_name for "Kowalska", never a placeholder followed by the bare surname.
 * Findings: { start, end, category, score, by }. Returns sorted, non-overlapping findings.
 */
export function unionCover(text, findings) {
  const rank = (f) => f.score + (f.by === 'you' ? 1 : 0);
  const out = [];
  const sorted = [...findings].sort((a, b) => rank(b) - rank(a) || (b.end - b.start) - (a.end - a.start));
  for (const f of sorted) {
    let pieces = [[f.start, f.end]];
    for (const r of out) {
      pieces = pieces.flatMap(([a, b]) => (b <= r.start || a >= r.end ? [[a, b]] : [[a, Math.min(b, r.start)], [Math.max(a, r.end), b]].filter(([x, y]) => y > x)));
    }
    for (let [a, b] of pieces) {
      while (a < b && TRIM.test(text[a])) a++;
      while (b > a && TRIM.test(text[b - 1])) b--;
      if (b > a && /[\p{L}\p{N}]/u.test(text.slice(a, b))) out.push({ ...f, start: a, end: b, text: text.slice(a, b) });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// A fresh namespace for each request: only that request's placeholders can ever be restored.
export function newNs(length = 6) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), (b) => alphabet[b % alphabet.length]).join('');
}

const PLANTED = /<(\/?)redacted:/gi;
// Text that already looks like a placeholder is neutralised before detection, so a page can't plant one.
export function neutralise(text) {
  let count = 0;
  const out = String(text).replace(PLANTED, (m, slash) => { count++; return `‹${slash}redacted:`; });
  return { text: out, count };
}

export const sameValue = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();

export function token(f, { format } = {}) {
  return `<redacted:${f.category}|ref:${f.ref}${format ? `|format:${format}` : ''}|confidence:${Math.round(f.score * 100)}%>`;
}
export const shortToken = (f) => `<redacted:${f.category}|ref:${f.ref}>`;

// A date's format string says nothing about the date itself.
export function dateFormat(s) {
  const t = String(s).trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(t)) return 'DD/MM/YYYY';
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(t)) return 'D/M/YYYY';
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return 'YYYY-MM-DD';
  const m = /^(\d{1,2})(?:st|nd|rd|th)? ([A-Za-z]+),? (\d{4})$/.exec(t);
  return m ? `${m[1].length === 2 ? 'DD' : 'D'} ${m[2].length > 3 ? 'MMMM' : 'MMM'} YYYY` : '';
}

/**
 * Format hints come from the library's definition of each kind of identifier, never from the value.
 * mode: 'shape' (default), 'regex' (the library's pattern for that kind of identifier; dates keep a date
 * format) or 'off'. Names and addresses never get one; '|', '<' and '>' are refused.
 */
export function formatHint(f, identifierTypes = {}, mode = 'shape') {
  const c = CATEGORIES[f.category];
  if (mode === 'off' || !c || (!c.format && !c.date)) return '';
  const type = identifierTypes[f.category] || {};
  const hint = c.date ? dateFormat(f.text) : (mode === 'regex' ? type.pattern : type.shape) || '';
  return /[|<>]/.test(hint) ? '' : hint;
}

/**
 * Give each redacted finding a ref. The same value (ignoring case and spacing) gets the same ref everywhere
 * in one request. Returns the refs map: ref → { category, values: [original text of every occurrence] }.
 */
export function assignRefs(findings, ns) {
  const byValue = new Map();
  const refs = new Map();
  let n = 0;
  for (const f of findings) {
    if (!f.redact) continue;
    const key = `${f.category}:${sameValue(f.text)}`;
    if (!byValue.has(key)) {
      const ref = `${ns}.${++n}`;
      byValue.set(key, ref);
      refs.set(ref, { category: f.category, values: [] });
    }
    f.ref = byValue.get(key);
    refs.get(f.ref).values.push(f.text);
  }
  return refs;
}

// The text with each redacted finding replaced by its placeholder.
export function applyTokens(text, findings, tokenOf = token) {
  let out = '';
  let at = 0;
  for (const f of findings) {
    if (!f.redact) continue;
    out += text.slice(at, f.start) + tokenOf(f);
    at = f.end;
  }
  return out + text.slice(at);
}

const LONG = /<redacted:([a-z_]+)\|ref:([a-z0-9]+\.\d+)(?:\|format:([^|<>]*))?(?:\|confidence:(\d{1,3})%)?>/g;
const FRAGMENT = /<\/?redacted:?[^>]{0,80}>?|redacted:[a-z_]*\|ref:/i;

/**
 * Restore placeholders in one string value, strictly. A placeholder is swapped back only when its ns is this
 * request's, its ref was issued, its category is the issued one, any format and confidence equal what was
 * sent (sent: ref → Set of the long placeholders sent for it), and the field may receive that category.
 * Anything else, including fragments, is reported and the value is left empty. Values restore the first
 * spelling seen; quotes are restored from the original text by lib/ai/boundary.js.
 */
export function restoreString(str, { ns, refs, sent = new Map(), allow = null }) {
  const bad = [];
  const out = String(str).replace(LONG, (m, category, ref, format, confidence) => {
    const issued = refs.get(ref);
    const why = !ref.startsWith(`${ns}.`) ? 'foreign namespace' : !issued ? 'unknown ref' : issued.category !== category ? 'wrong category'
      : allow && !allow.includes(category) ? 'not allowed in this field'
        : (format !== undefined || confidence !== undefined) && !sent.get(ref)?.has(m) ? 'altered placeholder' : null;
    if (why) { bad.push({ token: m, why }); return m; }
    return issued.values[0];
  });
  if (FRAGMENT.test(out.replace(LONG, ''))) bad.push({ token: (out.match(FRAGMENT) || [''])[0], why: 'placeholder fragment' });
  return bad.length ? { ok: false, value: '', bad } : { ok: true, value: out, bad: [] };
}

/**
 * Restore inside a parsed model answer, only in string values of the expected fields. Keys are never
 * restored, and fields outside the schema are dropped. schema: { field: allowed categories | null }.
 * Returns { values: { field: restored }, problems: [{ field, bad }] }.
 */
export function restoreAnswer(answer, { ns, refs, sent, schema }) {
  const values = {};
  const problems = [];
  const walk = (v, allow) => {
    if (typeof v === 'string') return restoreString(v, { ns, refs, sent, allow });
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = {};
      const bad = [];
      for (const [k, x] of Object.entries(v)) {
        const r = walk(x, k === 'quote' ? null : allow);
        if (r.ok === false) bad.push(...r.bad);
        o[k] = r.ok === false ? '' : r.value;
      }
      return bad.length ? { ok: false, value: o, bad, partial: true } : { ok: true, value: o, bad: [] };
    }
    return { ok: true, value: v, bad: [] };
  };
  for (const [field, allow] of Object.entries(schema)) {
    if (!(field in (answer || {}))) continue;
    const r = walk(answer[field], allow);
    values[field] = r.value;
    if (r.bad.length) problems.push({ field, bad: r.bad });
  }
  return { values, problems };
}

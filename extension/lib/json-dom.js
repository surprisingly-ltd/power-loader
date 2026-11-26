/*
 * JSON as a document the extraction engine reads (browser + Node). See docs/plans/json-clips.md.
 *
 * A JSON response is parsed by the strict parser here, never by JSON.parse and never as markup, into a detached
 * XML document with no browsing context: every value is one element whose tag is its type (j-object, j-array,
 * j-string, j-number, j-boolean, j-null), an object member carries key="…" and an array item index="n". The
 * root element is the JSON's root value, so :root is the top of the JSON. extract(), probe(), profileApplies()
 * and the filters then read it unchanged, which is why lib/extract.js and fixtures/dsl-cases.json don't change.
 *
 * No JavaScript object is ever built from the response: keys are only attribute strings, so __proto__,
 * constructor and prototype keys are plain text. Limits are enforced while parsing (the parser is iterative,
 * so depth can't overflow the stack) and an oversized document is refused, never cut short.
 *
 * Loaded as a classic script or imported for side effects; either way it sets globalThis.PowerLoaderJson.
 */
(function (root) {
  'use strict';

  const LIMITS = Object.freeze({
    bytes: 2 * 1024 * 1024, // the body, as for HTML (lib/fetch-steps.js FETCH_LIMITS.maxBytes)
    depth: 64, // levels of nesting
    values: 50000, // elements in all
    string: 100000, // characters in one string
    key: 1000, // characters in one key
    number: 100, // characters in one number, as sent and as written out
    members: 10000, // members of one object
  });

  const TAGS = Object.freeze({ object: 'j-object', array: 'j-array', string: 'j-string', number: 'j-number', boolean: 'j-boolean', null: 'j-null' });
  const CONTAINERS = new Set([TAGS.object, TAGS.array]);
  const SCALARS = new Set([TAGS.string, TAGS.number, TAGS.boolean, TAGS.null]);

  /** A response Power Loader won't read, with the reason as a code (syntax, encoding, depth, values, …). */
  class JsonRefused extends Error {
    constructor(reason, message, limit) {
      super(message || reason);
      this.name = 'JsonRefused';
      this.reason = reason;
      if (limit != null) this.limit = limit;
    }
  }

  const n = (x) => Number(x).toLocaleString('en-GB');

  /** A refusal in words, for the step card and the editor. name: the request's or page's name. */
  function refusalText(reason, { name = 'This data', limits = LIMITS } = {}) {
    const L = { ...LIMITS, ...limits };
    const ask = ' Ask for less, for example a date range in the address.';
    return {
      syntax: 'This isn’t data Power Loader can read',
      encoding: 'The data isn’t in a text encoding Power Loader can read',
      depth: `${name} is nested too deeply to read (over ${n(L.depth)} levels)`,
      values: `${name} is too large to read (over ${n(L.values)} values).${ask}`,
      members: `${name} is too large to read (over ${n(L.members)} entries in one object).${ask}`,
      string: `${name} has a value too long to read (over ${n(L.string)} characters)`,
      key: `${name} has a key too long to read (over ${n(L.key)} characters)`,
      number: `${name} has a number too long to read (over ${n(L.number)} characters)`,
      bytes: `${name} is too large to read (over 2 MB).${ask}`,
    }[reason] || 'This isn’t data Power Loader can read';
  }

  // ---------------------------------------------------------------- bytes to text

  // XSSI guards some systems put before their JSON so a <script> tag can't run it. After an optional BOM and
  // whitespace, exactly one is removed if the body starts with it. Nothing else is unwrapped: callback(…) JSONP
  // is code, and is refused as not JSON.
  const PREFIXES = [")]}',\n", ")]}',\r\n", ")]}'\n", ")]}'\r\n", 'while(1);', 'for(;;);', '{}&&'];

  /** The body without a BOM, leading whitespace and one known prefix. */
  function stripPrefix(text) {
    let s = String(text);
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    const lead = /^[ \t\r\n]*/.exec(s)[0].length;
    for (const p of PREFIXES) if (s.startsWith(p, lead)) return s.slice(lead + p.length);
    return s;
  }

  const charsetOf = (contentType) => /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(String(contentType || ''))?.[1] || '';

  /**
   * Bytes as text: UTF-8 (RFC 8259) unless the response names a charset TextDecoder knows; a BOM overrides
   * both, as in the Encoding standard. Bytes that don't decode are refused: nothing is replaced silently,
   * because a mis-decoded name would go into the case.
   */
  function decodeJson(bytes, contentType) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
    let label = 'utf-8';
    if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) label = 'utf-8';
    else if (b[0] === 0xfe && b[1] === 0xff) label = 'utf-16be';
    else if (b[0] === 0xff && b[1] === 0xfe) label = 'utf-16le';
    else if (charsetOf(contentType)) {
      try { new TextDecoder(charsetOf(contentType)); label = charsetOf(contentType); } catch (e) { label = 'utf-8'; }
    }
    try {
      return new TextDecoder(label, { fatal: true }).decode(b);
    } catch (e) {
      throw new JsonRefused('encoding', refusalText('encoding'));
    }
  }

  // ---------------------------------------------------------------- numbers

  const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

  /**
   * A number in exponent form written out in plain decimal by string arithmetic (1.5e3 is 1500), because
   * | number reads only the digits before the e, and because a float would lose digits. null when the plain
   * form would be longer than max.
   */
  function plainNumber(src, max) {
    const m = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(src);
    if (!m) return src;
    const [, sign, int, frac = '', expText] = m;
    const digits = int + frac;
    // Where the decimal point goes in digits. An exponent that would need more than max characters is too long.
    const exp = Number(expText);
    if (!Number.isFinite(exp) || Math.abs(exp) > max + digits.length) return null;
    const point = int.length + exp;
    let out;
    if (point <= 0) out = `0.${'0'.repeat(-point)}${digits}`;
    else if (point >= digits.length) out = digits + '0'.repeat(point - digits.length);
    else out = `${digits.slice(0, point)}.${digits.slice(point)}`;
    out = out.replace(/^0+(?=\d)/, '');
    out = sign + out;
    return out.length > max ? null : out;
  }

  // ---------------------------------------------------------------- the parser

  const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);
  const ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

  /**
   * Parse JSON text into a synthetic document. Strict RFC 8259: no comments, trailing commas, single quotes,
   * NaN or Infinity; one value, then only whitespace. Returns { doc, stats: { values, depth, duplicates } },
   * where duplicates lists the path of each repeated key (a position, never a value). Throws JsonRefused.
   * documentSource: any document, for its implementation (the sidebar's own, or jsdom's in tests).
   */
  function jsonToDocument(text, { documentSource = root.document, limits = {} } = {}) {
    const L = { ...LIMITS, ...limits };
    if (!documentSource || !documentSource.implementation) throw new Error('jsonToDocument needs a document to make one from');
    const s = stripPrefix(text);
    const doc = documentSource.implementation.createDocument(null, null, null);
    const bad = () => new JsonRefused('syntax', refusalText('syntax'));
    const over = (reason) => new JsonRefused(reason, refusalText(reason, { limits: L }), L[reason]);
    let i = 0;
    let values = 0;
    let maxDepth = 0;
    const duplicates = [];
    // Open containers: { el, object, count, keys: Set (object members seen), key (the member's key next) }.
    const stack = [];

    const ws = () => { while (i < s.length && WS.has(s.charCodeAt(i))) i++; };

    function readString(max, reason) {
      // s[i] is the opening quote.
      i++;
      let out = '';
      let start = i;
      for (;;) {
        if (i >= s.length) throw bad();
        const c = s.charCodeAt(i);
        if (c === 0x22) { out += s.slice(start, i); i++; break; }
        if (c < 0x20) throw bad(); // control characters must be escaped
        if (c === 0x5c) {
          out += s.slice(start, i);
          const e = s[i + 1];
          if (e === 'u') {
            const hex = s.slice(i + 2, i + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw bad();
            out += String.fromCharCode(parseInt(hex, 16));
            i += 6;
          } else if (e !== undefined && Object.prototype.hasOwnProperty.call(ESCAPES, e)) {
            out += ESCAPES[e];
            i += 2;
          } else throw bad();
          start = i;
        } else i++;
        if (out.length + (i - start) > max) throw over(reason);
      }
      if (out.length > max) throw over(reason);
      // A lone surrogate becomes U+FFFD, as TextDecoder does for bytes.
      return typeof out.toWellFormed === 'function' ? out.toWellFormed() : out.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '�');
    }

    function attach(el) {
      values++;
      if (values > L.values) throw over('values');
      const top = stack[stack.length - 1];
      if (!top) { doc.appendChild(el); return; }
      if (top.object) {
        el.setAttribute('key', top.key);
        if (top.keys.has(top.key)) duplicates.push(pathOf(el, top.el));
        else top.keys.add(top.key);
      } else el.setAttribute('index', String(top.count));
      top.count++;
      if (top.object && top.count > L.members) throw over('members');
      top.el.appendChild(el);
    }

    function stringElement(value) {
      const el = doc.createElementNS(null, TAGS.string);
      // Each line break is an empty <br>, so | lines and | oneline work as they do for block text in HTML.
      const lines = value.split('\n');
      lines.forEach((line, k) => {
        if (k) el.appendChild(doc.createElementNS(null, 'br'));
        if (line) el.appendChild(doc.createTextNode(line));
      });
      return el;
    }

    function scalar(tag, text) {
      const el = doc.createElementNS(null, tag);
      if (text) el.appendChild(doc.createTextNode(text));
      return el;
    }

    function readKey() {
      ws();
      if (s[i] !== '"') throw bad();
      const key = readString(L.key, 'key');
      ws();
      if (s[i] !== ':') throw bad();
      i++;
      stack[stack.length - 1].key = key;
    }

    function open(object) {
      const el = doc.createElementNS(null, object ? TAGS.object : TAGS.array);
      attach(el);
      stack.push({ el, object, count: 0, keys: new Set(), key: '' });
      if (stack.length > L.depth) throw over('depth');
      if (stack.length > maxDepth) maxDepth = stack.length;
      i++;
      ws();
      const close = object ? '}' : ']';
      if (s[i] === close) { i++; stack.pop(); return false; }
      if (object) readKey();
      return true; // a value follows
    }

    // One value, then whatever closes or continues its containers, until the root value is complete.
    let wantValue = true;
    while (wantValue) {
      ws();
      const ch = s[i];
      let more = false;
      if (ch === '{') more = open(true);
      else if (ch === '[') more = open(false);
      else if (ch === '"') attach(stringElement(readString(L.string, 'string')));
      else if (ch === 't' && s.startsWith('true', i)) { attach(scalar(TAGS.boolean, 'true')); i += 4; }
      else if (ch === 'f' && s.startsWith('false', i)) { attach(scalar(TAGS.boolean, 'false')); i += 5; }
      else if (ch === 'n' && s.startsWith('null', i)) { attach(scalar(TAGS.null, '')); i += 4; }
      else if (ch === '-' || (ch >= '0' && ch <= '9')) {
        NUMBER.lastIndex = i;
        const m = NUMBER.exec(s);
        if (!m) throw bad();
        const src = m[0];
        if (src.length > L.number) throw over('number');
        const plain = plainNumber(src, L.number);
        if (plain == null) throw over('number');
        const el = scalar(TAGS.number, plain);
        // The number as sent, for its quote, when writing it out changed it.
        if (plain !== src) el.setAttribute('source', src);
        attach(el);
        i += src.length;
      } else throw bad();
      if (more) continue;
      // After a value: close containers until one continues, or the root is done.
      for (;;) {
        const top = stack[stack.length - 1];
        if (!top) { wantValue = false; break; }
        ws();
        const c = s[i];
        if (c === ',') {
          i++;
          if (top.object) readKey();
          break;
        }
        if (c === (top.object ? '}' : ']')) { i++; stack.pop(); continue; }
        throw bad();
      }
    }
    ws();
    if (i !== s.length) throw bad();
    return { doc, stats: { values, depth: maxDepth, duplicates } };
  }

  /** Bytes of a response to a synthetic document: decoded, refused over the byte limit, then parsed. */
  function readJson(bytes, { contentType = '', documentSource = root.document, limits = {} } = {}) {
    const L = { ...LIMITS, ...limits };
    if ((bytes?.length || 0) > L.bytes) throw new JsonRefused('bytes', refusalText('bytes'), L.bytes);
    return jsonToDocument(decodeJson(bytes, contentType), { documentSource, limits: L });
  }

  // ---------------------------------------------------------------- content types

  /**
   * What a Content-Type means for a profile that reads JSON: 'json' (read it), 'problem' (an error response,
   * never read), 'script' (JSONP is code, never run) or 'other' (refused, with no sniffing). Parameters other
   * than charset are ignored; the body never decides.
   */
  function jsonContentType(type) {
    const t = String(type || '').split(';')[0].trim().toLowerCase();
    if (t === 'application/problem+json') return 'problem';
    if (t === 'application/json' || t === 'text/json' || /^application\/[a-z0-9!#$&^_.-]+\+json$/.test(t)) return 'json';
    if (t === 'text/javascript' || t === 'application/javascript' || t === 'application/x-javascript' || t === 'application/ecmascript') return 'script';
    return 'other';
  }

  // ---------------------------------------------------------------- selectors and paths

  /**
   * A key as a quoted CSS attribute selector: [key='…'], with ' and \ escaped and control characters as
   * hex escapes. null for a key CSS can't express (it has NUL, which CSS reads as U+FFFD).
   */
  function jsonKeySelector(key) {
    const k = String(key);
    if (k.includes('\0')) return null;
    const esc = k.replace(/[\\']/g, (c) => `\\${c}`).replace(/[\u0001-\u001f\u007f]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `);
    return `[key='${esc}']`;
  }

  // The anchored child path to an element, from :root, as the tree view writes it. Each step is the
  // element's key or index, so a selector never depends on document order or matches a key nested elsewhere.
  function steps(el, stop) {
    const out = [];
    for (let cur = el; cur && cur.nodeType === 1 && cur !== stop; cur = cur.parentNode) {
      if (!cur.parentNode || cur.parentNode.nodeType !== 1) break; // the root
      out.unshift(cur);
    }
    return out;
  }

  function stepSelector(el) {
    if (el.hasAttribute('key')) return jsonKeySelector(el.getAttribute('key'));
    return `[index='${el.getAttribute('index')}']`;
  }

  /** The anchored selector for an element: ":root > [key='a'] > [index='0']", or null if a key can't be written. */
  function selectorFor(el, { from = null } = {}) {
    const parts = [];
    for (const s of steps(el, from)) {
      const sel = stepSelector(s);
      if (sel == null) return null;
      parts.push(sel);
    }
    return [from ? ':scope' : ':root', ...parts].join(' > ');
  }

  const NAME_LIKE = /^[A-Za-z_][A-Za-z0-9_]*$/;

  // A path step as jq writes it: .key for a name-like key, .["key"] otherwise, [n] for an index.
  function pathStep(el) {
    if (el.hasAttribute('key')) {
      const k = el.getAttribute('key');
      return NAME_LIKE.test(k) ? `.${k}` : `.[${JSON.stringify(k)}]`;
    }
    return `[${el.getAttribute('index')}]`;
  }

  /** The jq-style path to an element: .person.dateOfBirth, .payments[2].amount, .["first name"]; "." for the root. */
  function pathOf(el, parent) {
    // While parsing, the element isn't in its parent yet: its path is the parent's plus its own step.
    const list = parent ? [...steps(parent), el] : steps(el);
    return list.map(pathStep).join('') || '.';
  }

  /**
   * The jq-style path a selector in the anchored form means, or null for any other selector. For the review
   * screen and the draft list, which show .person.dateOfBirth rather than the CSS.
   */
  function selectorToPath(selector) {
    const loc = String(selector || '').split('|')[0].trim();
    const m = /^(:root|:scope)((?:\s*>\s*\[(?:key|index)='(?:[^'\\]|\\.)*'\])*)\s*(@\w+)?$/.exec(loc);
    if (!m) return null;
    const out = [];
    const re = /\[(key|index)='((?:[^'\\]|\\.)*)'\]/g;
    for (let s; (s = re.exec(m[2]));) {
      const raw = s[2].replace(/\\([0-9a-fA-F]{1,6}) ?/g, (_, hx) => String.fromCodePoint(parseInt(hx, 16))).replace(/\\(.)/g, '$1');
      out.push(s[1] === 'index' ? `[${raw}]` : NAME_LIKE.test(raw) ? `.${raw}` : `.[${JSON.stringify(raw)}]`);
    }
    return (out.join('') || '.') + (m[3] ? ` ${m[3]}` : '');
  }

  // ---------------------------------------------------------------- values and quotes

  // A string element's value as sent: its text with each <br> as a line break.
  function rawString(el) {
    let out = '';
    for (const c of el.childNodes) out += c.nodeType === 3 ? c.data : c.localName === 'br' ? '\n' : '';
    return out;
  }

  /** A scalar's JSON text as received: strings quoted, numbers as sent, true, false, null. null for a container. */
  function rawValue(el) {
    switch (el.localName) {
      case TAGS.string: return JSON.stringify(rawString(el));
      case TAGS.number: return el.getAttribute('source') || el.textContent;
      case TAGS.boolean: return el.textContent;
      case TAGS.null: return 'null';
      default: return null;
    }
  }

  const QUOTE_MAX = 200;
  const cut = (s, max) => (s.length > max ? `${s.slice(0, max)}…` : s);

  /**
   * The quote for one field: its path and the value as sent, ".person.dateOfBirth: "1986-07-14"". Found with
   * the engine's own locate() on the locator before the pipes, so it's the element the field read. null for a
   * literal, a label() that found inline text, an @attribute read or a container.
   */
  function jsonQuote(doc, spec) {
    const E = root.PowerLoaderExtract;
    if (typeof spec !== 'string' || spec.startsWith('=') || !E) return null;
    const loc = E.splitPipes(spec)[0];
    if (E.parseLocator(loc).attr) return null;
    const el = E.locate(doc, loc)[0];
    if (!el || !SCALARS.has(el.localName)) return null;
    return `${pathOf(el)}: ${cut(rawValue(el), QUOTE_MAX)}`;
  }

  /** Quotes for a profile's top-level single-value fields: { key: quote }. */
  function jsonQuotes(doc, profile) {
    const out = {};
    for (const [k, spec] of Object.entries(profile?.fields || {})) {
      if (k.startsWith('@')) continue;
      const q = jsonQuote(doc, spec);
      if (q) out[k] = q;
    }
    return out;
  }

  /**
   * probe() for JSON: as the engine's, and a field whose element is an object or an array fails with "Pick a
   * value inside it", before judgeTest(), which is unchanged.
   */
  function probeJson(doc, spec, opts) {
    const E = root.PowerLoaderExtract;
    const p = E.probe(doc, spec, opts);
    if (typeof spec !== 'string' || spec.startsWith('=') || p.error || !p.count) return p;
    const loc = E.splitPipes(spec)[0];
    if (E.parseLocator(loc).attr) return p;
    const el = E.locate(doc, loc)[0];
    return el && CONTAINERS.has(el.localName) ? { ...p, value: null, error: 'Pick a value inside it' } : p;
  }

  // ---------------------------------------------------------------- data-like keys

  const shapeOf = (s) => String(s).replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/\d/g, '9');
  const childKeys = (el) => [...el.children].map((c) => c.getAttribute('key')).sort().join('\u0000');
  const valueShape = (el) => (el.localName === TAGS.object ? `o:${childKeys(el)}` : el.localName === TAGS.array ? 'a' : `${el.localName}:${shapeOf(el.textContent)}`);

  /**
   * Is this member's key data rather than structure? It has an identifier's shape (three or more digits, so
   * address2 stays structure), isPersonal(key) says so (lib/privacy-detect.js detect(), passed in by the
   * caller), or it's one of three or more sibling keys whose values all have the same shape (an object used
   * as a map, such as { "P-1042": {…}, "P-1043": {…} }). Such a key is treated as a value: the tree view
   * never writes it into a selector, and the leak check catches it if a hand-edited profile does.
   */
  function dataLikeKey(el, { isPersonal = null } = {}) {
    if (!el || !el.hasAttribute || !el.hasAttribute('key')) return false;
    const key = el.getAttribute('key');
    if ((key.match(/\d/g) || []).length >= 3) return true;
    if (isPersonal && isPersonal(key)) return true;
    const sibs = [...el.parentNode.children];
    if (sibs.length >= 3) {
      const shape = valueShape(sibs[0]);
      if (sibs.every((x) => valueShape(x) === shape)) return true;
    }
    return false;
  }

  const VALUE_MAX = 200;

  /**
   * What the leak check is given for a JSON sample: every string and number's text (up to 200 characters),
   * as pageValues() gives every candidate's text on an HTML page, and every data-like key. true, false and
   * null are left out: they're words of the format, not values a profile could leak.
   */
  function jsonValues(doc, { isPersonal = null } = {}) {
    const out = new Set();
    for (const el of doc.getElementsByTagName('*')) {
      const tag = el.localName;
      if (tag === TAGS.string) {
        const raw = rawString(el);
        const clean = root.PowerLoaderExtract ? root.PowerLoaderExtract.cleanText(raw) : raw.trim();
        if (clean) out.add(clean.slice(0, VALUE_MAX));
        for (const line of raw.split('\n')) if (line.trim()) out.add(line.trim().slice(0, VALUE_MAX));
      } else if (tag === TAGS.number) {
        out.add(el.textContent);
        if (el.hasAttribute('source')) out.add(el.getAttribute('source'));
      }
      if (dataLikeKey(el, { isPersonal })) out.add(el.getAttribute('key'));
    }
    return [...out];
  }

  /** Keys among siblings that differ only by case, Unicode form or spaces: the tree view marks them. */
  function lookAlikeKeys(el) {
    const norm = (k) => String(k).normalize('NFC').toLowerCase().replace(/\s+/g, '');
    const seen = new Map();
    for (const c of el.children) {
      if (!c.hasAttribute('key')) continue;
      const k = norm(c.getAttribute('key'));
      seen.set(k, (seen.get(k) || 0) + 1);
    }
    return new Set([...el.children].filter((c) => c.hasAttribute('key') && seen.get(norm(c.getAttribute('key'))) > 1 && [...el.children].some((o) => o !== c && o.hasAttribute('key') && o.getAttribute('key') !== c.getAttribute('key') && norm(o.getAttribute('key')) === norm(c.getAttribute('key')))));
  }

  // A JSON key as a field or group name: letters and digits, starting with a letter (paid_on → paidOn).
  function nameFrom(key, fallback) {
    const words = String(key || '').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
    const out = words.map((w, k) => (k ? w[0].toUpperCase() + w.slice(1) : w[0].toLowerCase() + w.slice(1))).join('').replace(/^[^A-Za-z]+/, '').slice(0, 40);
    return out || fallback;
  }

  /**
   * What clicking a value in the tree view can pick. { path, key, type, single, rows, why }:
   *   single  the anchored selector for just this value, or null when a key on the way looks like data or
   *           can't be written (the picker never writes such a key), with why in words;
   *   rows    when the value is inside a list of objects (an array, or an object used as a map), the rows pick
   *           for every item: { group, rows, field, item, position } (position: the item's index, for the
   *           Just this one warning), or null.
   * Objects and arrays can't be picked as values: single and rows are null with why "Pick a value inside it".
   */
  function pickFor(el, { isPersonal = null } = {}) {
    const out = { path: pathOf(el), key: el.getAttribute('key'), type: typeOf(el), single: null, rows: null, why: null };
    if (CONTAINERS.has(el.localName)) return { ...out, why: 'Pick a value inside it' };
    const chain = steps(el);
    const dataLike = (x) => dataLikeKey(x, { isPersonal });
    const unwritable = chain.some((x) => x.hasAttribute('key') && jsonKeySelector(x.getAttribute('key')) == null);
    if (unwritable) return { ...out, why: 'Power Loader can’t read this key' };
    if (!chain.some(dataLike)) out.single = selectorFor(el);
    // The nearest item of a list of objects: an object in an array, or a member of an object used as a map.
    const item = [...chain].reverse().find((x) => x !== el && x.localName === TAGS.object && (x.parentNode.localName === TAGS.array || dataLike(x)));
    if (item) {
      const inside = steps(el, item);
      const above = steps(item.parentNode);
      if (!inside.some(dataLike) && !above.some(dataLike)) {
        const list = item.parentNode;
        out.rows = {
          group: nameFrom(list.getAttribute('key'), 'rows'), rows: `${selectorFor(list)} > *`, field: nameFrom(el.getAttribute('key'), 'value'),
          item: selectorFor(el, { from: item }), position: item.hasAttribute('index') ? Number(item.getAttribute('index')) : null,
        };
      }
    }
    if (!out.single) out.why = out.rows ? 'A key on the way looks like data, so Power Loader won’t put it in the profile: pick every item instead' : 'A key on the way looks like data, so Power Loader won’t put it in the profile';
    return out;
  }

  /** "dateOfBirth", "date_of_birth" and "date-of-birth" as words: "date of birth". */
  function humanise(key) {
    return String(key).replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  /** A document's element's type, without its prefix: object, array, string, number, boolean or null. */
  const typeOf = (el) => (el && el.localName && el.localName.startsWith('j-') ? el.localName.slice(2) : null);

  root.PowerLoaderJson = {
    LIMITS,
    TAGS,
    JsonRefused,
    refusalText,
    stripPrefix,
    decodeJson,
    plainNumber,
    jsonToDocument,
    readJson,
    jsonContentType,
    jsonKeySelector,
    selectorFor,
    selectorToPath,
    pathOf,
    rawValue,
    jsonQuote,
    jsonQuotes,
    probeJson,
    dataLikeKey,
    jsonValues,
    lookAlikeKeys,
    pickFor,
    nameFrom,
    humanise,
    typeOf,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);

/*
 * Power Loader extraction engine (browser + Node).
 *
 * Evaluates a declarative extraction profile (see extension/prompts/dsl.md)
 * against a DOM Document or Element and returns { data, diagnostics }.
 *
 * Behaviour is specified by the hand-written DSL cases and frozen reference fixtures.
 * Both are checked against the shared conformance fixtures in fixtures/.
 *
 * Loaded as a classic script (content-script injection, sidebar, background) or
 * imported for side effects in Node tests; either way it sets globalThis.PowerLoaderExtract.
 */
(function (root) {
  'use strict';

  const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head']);
  const BLOCK_TAGS = new Set([
    'address', 'article', 'aside', 'blockquote', 'caption', 'dd', 'details', 'dialog', 'div', 'dl', 'dt',
    'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
    'hr', 'legend', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody',
    'tfoot', 'thead', 'tr', 'ul',
  ]);
  const CELL_TAGS = new Set(['td', 'th']);
  const LABEL_SKIP = new Set(['html', 'body', 'head', 'script', 'style', 'noscript', 'template']);
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

  class ExtractError extends Error {}
  class TooLong extends Error {}

  // ---------------------------------------------------------------- text

  function cleanText(s) {
    if (s == null) return null;
    return String(s)
      .replace(/ /g, ' ')
      .replace(/[​-‍﻿]/g, '')
      .split('\n')
      .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
      .filter((line) => line !== '')
      .join('\n');
  }

  function nonWs(s) {
    const m = s.match(/\S/g);
    return m ? m.length : 0;
  }

  const PRE_TAGS = new Set(['pre', 'textarea']);

  // Source line breaks are just whitespace, except inside <pre>/<textarea>.
  function textData(data, pre) {
    return pre ? data : data.replace(/[\r\n]/g, ' ');
  }

  // budget: null, or { left: n } — throws TooLong once more than n non-space chars are seen
  function rawText(node, budget, pre) {
    let out = '';
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        if (budget) {
          budget.left -= nonWs(child.data);
          if (budget.left < 0) throw new TooLong();
        }
        out += textData(child.data, pre);
      } else if (child.nodeType === 1) {
        out += elementText(child, budget, pre);
      }
    }
    return out;
  }

  function elementText(el, budget, pre) {
    const tag = el.localName;
    if (SKIP_TAGS.has(tag)) return '';
    if (tag === 'br') return '\n';
    const inner = rawText(el, budget, pre || PRE_TAGS.has(tag));
    if (BLOCK_TAGS.has(tag)) return '\n' + inner + '\n';
    if (CELL_TAGS.has(tag)) return inner + ' ';
    return inner;
  }

  function getText(node) {
    return cleanText(rawText(node, null, node.nodeType === 1 && PRE_TAGS.has(node.localName)));
  }

  function boundedText(node, limit) {
    try {
      return cleanText(rawText(node, { left: limit }, false));
    } catch (e) {
      if (e instanceof TooLong) return null;
      throw e;
    }
  }

  function normLabel(s) {
    return cleanText(s).replace(/\n/g, ' ').toLowerCase().replace(/[\s:*]+$/, '').trim();
  }

  function inputType(el) {
    return (el.getAttribute('type') || 'text').toLowerCase();
  }

  function elementValue(el) {
    const tag = el.localName;
    if (tag === 'input') {
      const type = inputType(el);
      if (type === 'checkbox' || type === 'radio') return el.checked ? 'true' : 'false';
      return el.value;
    }
    if (tag === 'textarea') return el.value;
    if (tag === 'select') {
      const opt = el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
      return opt ? getText(opt) : '';
    }
    return getText(el);
  }

  function attrValue(el, name) {
    const n = name.toLowerCase();
    const tag = el.localName;
    if (n === 'value' && (tag === 'input' || tag === 'textarea' || tag === 'select')) return el.value;
    if (n === 'checked' && tag === 'input') return el.checked ? 'true' : 'false';
    return el.getAttribute(n);
  }

  // ---------------------------------------------------------------- parsing

  function splitPipes(expr) {
    const parts = [];
    let depth = 0;
    let cur = '';
    for (let i = 0; i < expr.length; i++) {
      const ch = expr[i];
      if (ch === '\\' && i + 1 < expr.length) {
        cur += ch + expr[i + 1];
        i++;
        continue;
      }
      if (ch === '(' || ch === '[') depth++;
      else if ((ch === ')' || ch === ']') && depth > 0) depth--;
      if (ch === '|' && depth === 0) {
        parts.push(cur);
        cur = '';
        continue;
      }
      cur += ch;
    }
    parts.push(cur);
    return parts.map((p) => p.trim());
  }

  const LABEL_RE = /(?:^|\s)label\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/;
  const ATTR_RE = /(?:^|\s)@([A-Za-z_:][-\w:.]*)\s*$/;

  function parseLocator(loc) {
    let s = (loc || '').trim();
    let prefix = '';
    let label = null;
    let attr = null;
    const lm = s.match(LABEL_RE);
    if (lm) {
      label = lm[1] !== undefined ? lm[1] : lm[2] !== undefined ? lm[2] : lm[3];
      prefix = s.slice(0, lm.index).trim();
      s = s.slice(lm.index + lm[0].length).trim();
    }
    const am = s.match(ATTR_RE);
    if (am) {
      attr = am[1];
      s = s.slice(0, am.index).trim();
    }
    if (s === '.') s = '';
    return { prefix, label, css: s, attr };
  }

  function parseFilter(f) {
    const i = f.indexOf(':');
    if (i < 0) return { name: f.trim(), arg: null };
    return { name: f.slice(0, i).trim(), arg: f.slice(i + 1).trim() };
  }

  // ---------------------------------------------------------------- selection

  function query(base, css, all) {
    if (typeof base === 'string') return all ? [] : null;
    try {
      return all ? Array.from(base.querySelectorAll(css)) : base.querySelector(css);
    } catch (e) {
      throw new ExtractError(`Invalid CSS selector "${css}"`);
    }
  }

  function labelScope(node) {
    return node.nodeType === 9 ? node.documentElement : node;
  }

  function followingText(el) {
    // Inline "label: value" — only when the very next non-blank node is text.
    let n = el.nextSibling;
    while (n && n.nodeType === 3 && n.data.trim() === '') n = n.nextSibling;
    if (!n || n.nodeType !== 3) return null;
    let out = '';
    for (n = el.nextSibling; n && n.nodeType !== 1; n = n.nextSibling) {
      if (n.nodeType === 3) out += textData(n.data, false);
    }
    return cleanText(out) || null;
  }

  function labelValue(el, scope) {
    if (el.localName === 'label') {
      const f = el.getAttribute('for');
      if (f) {
        const t = el.ownerDocument.getElementById(f);
        if (t) return t;
      }
      const c = el.querySelector('input, select, textarea');
      if (c) return c;
    }
    const t = followingText(el);
    if (t) return t;
    let cur = el;
    for (let depth = 0; depth < 4 && cur && cur !== scope; depth++) {
      if (cur.nextElementSibling) return cur.nextElementSibling;
      cur = cur.parentElement;
    }
    return null;
  }

  function findByLabel(node, labelText) {
    const target = normLabel(labelText);
    if (!target) return null;
    const scope = labelScope(node);
    if (!scope) return null;
    const els = Array.from(scope.querySelectorAll('*')).filter((el) => !LABEL_SKIP.has(el.localName));
    const limit = nonWs(target) + 10;

    // Pass 1: an element whose whole text is the label; value is next to it.
    for (const el of els) {
      const txt = boundedText(el, limit);
      if (txt == null || normLabel(txt) !== target) continue;
      const deeper = Array.from(el.children).some((c) => {
        const ct = boundedText(c, limit);
        return ct != null && normLabel(ct) === target;
      });
      if (deeper) continue;
      const v = labelValue(el, scope);
      if (v != null) return v;
    }

    // Pass 2: an element whose text is "Label: value".
    const prefixLimit = nonWs(target) + 200;
    const startsWith = (txt) => {
      const flat = txt.replace(/\n/g, ' ');
      if (flat.slice(0, target.length).toLowerCase() !== target) return null;
      const rest = flat.slice(target.length);
      const m = rest.match(/^\s*:\s*(.*)$/);
      return m && m[1].trim() ? m[1].trim() : null;
    };
    for (const el of els) {
      const txt = boundedText(el, prefixLimit);
      if (txt == null) continue;
      const rest = startsWith(txt);
      if (rest == null) continue;
      const deeper = Array.from(el.children).some((c) => {
        const ct = boundedText(c, prefixLimit);
        return ct != null && startsWith(ct) != null;
      });
      if (deeper) continue;
      return rest;
    }
    return null;
  }

  // Returns Element | string (inline text) | null
  function resolveBase(node, loc) {
    let base = node;
    if (loc.prefix) {
      base = query(base, loc.prefix, false);
      if (base == null) return null;
    }
    if (loc.label != null) {
      if (typeof base === 'string') return null;
      base = findByLabel(base, loc.label);
    }
    return base;
  }

  function resolveOne(node, loc) {
    const base = resolveBase(node, loc);
    if (base == null) return null;
    if (!loc.css) return base;
    return query(base, loc.css, false);
  }

  function resolveAll(node, loc) {
    const base = resolveBase(node, loc);
    if (base == null) return [];
    if (!loc.css) return [base];
    return query(base, loc.css, true);
  }

  // ---------------------------------------------------------------- filters

  function toStr(v) {
    if (typeof v === 'string') return v;
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return String(v);
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) return objectText(v);
    return JSON.stringify(v);
  }

  function monthIndex(name) {
    const i = MONTHS.indexOf(name.slice(0, 3).toLowerCase());
    return i < 0 ? 0 : i + 1;
  }

  function twoDigitYear(y) {
    const cur = new Date().getFullYear() % 100;
    return y <= cur ? 2000 + y : 1900 + y;
  }

  function daysIn(y, m) {
    if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
    return [4, 6, 9, 11].includes(m) ? 30 : 31;
  }

  const pad = (n) => String(n).padStart(2, '0');

  function parseDate(v, arg) {
    const s = v
      .trim()
      .replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+/i, '')
      .replace(/,?\s+(at\s+)?[0-9]{1,2}:[0-9]{2}.*$/i, '')
      .trim();
    let y;
    let m;
    let d;
    let mm;
    if ((mm = s.match(/^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})/))) {
      y = +mm[1]; m = +mm[2]; d = +mm[3];
    } else if ((mm = s.match(/^([0-9]{1,2})[/.-]([0-9]{1,2})[/.-]([0-9]{4}|[0-9]{2})$/))) {
      d = +mm[1]; m = +mm[2]; y = +mm[3];
      if (arg === 'mdy') [d, m] = [m, d];
      if (mm[3].length === 2) y = twoDigitYear(y);
    } else if ((mm = s.match(/^([0-9]{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,})\.?,?[\s-]+([0-9]{4}|[0-9]{2})$/))) {
      d = +mm[1]; m = monthIndex(mm[2]); y = +mm[3];
      if (mm[3].length === 2) y = twoDigitYear(y);
    } else if ((mm = s.match(/^([A-Za-z]{3,})\.?\s+([0-9]{1,2})(?:st|nd|rd|th)?,?\s+([0-9]{4})$/))) {
      m = monthIndex(mm[1]); d = +mm[2]; y = +mm[3];
    } else if ((mm = s.match(/^([A-Za-z]{3,})\.?,?\s+([0-9]{4})$/))) {
      m = monthIndex(mm[1]); y = +mm[2];
      return m ? `${y}-${pad(m)}` : v;
    } else {
      return v;
    }
    if (!m || m < 1 || m > 12 || d < 1 || d > daysIn(y, m)) return v;
    return `${String(y).padStart(4, '0')}-${pad(m)}-${pad(d)}`;
  }

  function compileRegex(pattern) {
    try {
      return new RegExp(pattern);
    } catch (e) {
      throw new ExtractError(`Invalid regex "${pattern}"`);
    }
  }

  const TRUE_WORDS = new Set(['true', 'yes', 'y', '1', 'checked', 'on', 'ticked']);
  const FALSE_WORDS = new Set(['false', 'no', 'n', '0', 'off', 'unchecked', 'none']);

  const FILTERS = {
    trim: (v) => v.trim(),
    upper: (v) => v.toUpperCase(),
    lower: (v) => v.toLowerCase(),
    oneline: (v) => v.split('\n').map((s) => s.trim()).filter(Boolean).join(', '),
    number: (v) => {
      const m = v.replace(/,/g, '').match(/-?[0-9]+(?:\.[0-9]+)?/);
      return m ? Number(m[0]) : null;
    },
    int: (v) => {
      const m = v.replace(/,/g, '').match(/-?[0-9]+/);
      return m ? Number(m[0]) : null;
    },
    date: (v, arg) => parseDate(v, arg),
    after: (v, arg) => {
      const i = v.indexOf(arg || '');
      return i < 0 || !arg ? v : v.slice(i + arg.length);
    },
    before: (v, arg) => {
      const i = v.indexOf(arg || '');
      return i < 0 || !arg ? v : v.slice(0, i);
    },
    remove: (v, arg) => (arg ? v.split(arg).join('') : v),
    drop: (v, arg) => (arg ? v.replace(new RegExp(compileRegex(arg).source, 'g'), '') : v),
    regex: (v, arg) => {
      const m = v.match(compileRegex(arg || ''));
      if (!m) return null;
      return m[1] !== undefined ? m[1] : m[0];
    },
    lines: (v) => v.split('\n').map((s) => s.trim()).filter(Boolean),
    split: (v, arg) => v.split(arg || ',').map((s) => s.trim()).filter(Boolean),
    bool: (v) => {
      const k = v.trim().toLowerCase();
      if (TRUE_WORDS.has(k)) return true;
      if (FALSE_WORDS.has(k)) return false;
      return null;
    },
    abs: (v, arg, ctx) => {
      if (!ctx.baseUrl) return v;
      try {
        return new URL(v, ctx.baseUrl).href;
      } catch (e) {
        return v;
      }
    },
    json: (v) => {
      try {
        return JSON.parse(v);
      } catch (e) {
        return null;
      }
    },
  };

  function applyFilter(value, name, arg, ctx) {
    if (name === 'default') return value == null ? (arg == null ? '' : arg) : value;
    if (!['join', 'first'].includes(name) && !Object.prototype.hasOwnProperty.call(FILTERS, name)) throw new ExtractError(`Unknown filter "${name}"`);
    if (value == null) return null;
    if (name === 'join') {
      const sep = arg == null || arg === '' ? ', ' : arg.replace(/\\n/g, '\n');
      return Array.isArray(value) ? value.map(fillValue).filter((v) => v !== null).map(toStr).join(sep) || null : value;
    }
    if (name === 'first') return Array.isArray(value) ? (value.length ? value[0] : null) : value;
    if (Array.isArray(value) && name !== 'json') return value.map((v) => applyFilter(v, name, arg, ctx));
    let out = FILTERS[name](toStr(value), arg, ctx);
    if (typeof out === 'string') {
      out = out.trim();
      if (out === '') out = null;
    }
    return out;
  }

  // ---------------------------------------------------------------- evaluation

  function joinPath(path, key) {
    return path ? `${path}.${key}` : key;
  }

  function diag(ctx, level, path, message) {
    ctx.diagnostics.push({ level, path: path || '(root)', message });
  }

  function evalExpr(expr, node, path, ctx) {
    if (expr.startsWith('=')) return expr.slice(1);
    const [locStr, ...filters] = splitPipes(expr);
    const loc = parseLocator(locStr);
    let value = null;
    let matched = false;
    try {
      const target = resolveOne(node, loc);
      matched = target != null;
      if (target == null) value = null;
      else if (typeof target === 'string') value = loc.attr ? null : target;
      else value = loc.attr ? attrValue(target, loc.attr) : elementValue(target);
      value = value == null ? null : cleanText(value) || null;
      for (const f of filters) {
        if (!f) continue;
        const { name, arg } = parseFilter(f);
        value = applyFilter(value, name, arg, ctx);
      }
    } catch (e) {
      if (!(e instanceof ExtractError)) throw e;
      diag(ctx, 'error', path, e.message);
      return null;
    }
    if (value == null) {
      diag(ctx, 'warning', path, matched ? 'Matched an element but it has no value' : 'Selector matched nothing');
    }
    return value;
  }

  function evalList(spec, node, path, ctx) {
    if (spec.length && spec[0] && typeof spec[0] === 'object' && !Array.isArray(spec[0])) {
      // Fixed list: every item is its own spec, evaluated in the current context.
      return spec.map((item, i) => evalSpec(item, node, `${path}[${i}]`, ctx));
    }
    if (spec.length < 1 || spec.length > 2 || typeof spec[0] !== 'string') {
      diag(ctx, 'error', path, 'List spec must be [selector] or [selector, itemSpec]');
      return [];
    }
    const loc = parseLocator(spec[0]);
    let itemSpec = spec.length === 2 ? spec[1] : '';
    if (spec.length === 1 && loc.attr) itemSpec = '@' + loc.attr;
    let nodes;
    try {
      nodes = resolveAll(node, loc);
    } catch (e) {
      if (!(e instanceof ExtractError)) throw e;
      diag(ctx, 'error', path, e.message);
      return [];
    }
    if (!nodes.length) diag(ctx, 'warning', path, 'List selector matched nothing');
    const out = [];
    nodes.forEach((n, i) => {
      const mark = ctx.diagnostics.length;
      const item = evalSpec(itemSpec, n, `${path}[${i}]`, ctx);
      if (isEmpty(item)) ctx.diagnostics.length = mark; // drop empty rows and their warnings
      else out.push(item);
    });
    return out;
  }

  function isEmpty(v) {
    if (v === null) return true;
    if (typeof v !== 'object' || Array.isArray(v)) return false;
    const keys = Object.keys(v).filter((k) => !k.startsWith('@'));
    return keys.length > 0 && keys.every((k) => v[k] === null);
  }

  function evalObject(spec, node, path, ctx) {
    let scope = node;
    if (typeof spec.$scope === 'string') {
      try {
        scope = resolveOne(node, parseLocator(spec.$scope));
      } catch (e) {
        if (!(e instanceof ExtractError)) throw e;
        diag(ctx, 'error', path, e.message);
        return null;
      }
      if (scope == null) {
        diag(ctx, 'warning', path, '$scope matched nothing');
        return null;
      }
    }
    const out = {};
    for (const [key, sub] of Object.entries(spec)) {
      if (key.startsWith('$')) continue;
      if (key.startsWith('@')) {
        out[key] = sub;
        continue;
      }
      out[key] = evalSpec(sub, scope, joinPath(path, key), ctx);
    }
    return out;
  }

  function evalSpec(spec, node, path, ctx) {
    if (typeof spec === 'string') return evalExpr(spec, node, path, ctx);
    if (Array.isArray(spec)) return evalList(spec, node, path, ctx);
    if (spec && typeof spec === 'object') return evalObject(spec, node, path, ctx);
    diag(ctx, 'error', path, 'Invalid spec: expected a string, list or object');
    return null;
  }

  // ---------------------------------------------------------------- fill profiles (the reverse: case data → form)

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  function splitPath(p) {
    const segs = [];
    let depth = 0;
    let cur = '';
    for (const ch of p) {
      if (ch === '[') depth++;
      else if (ch === ']' && depth > 0) depth--;
      if (ch === '.' && depth === 0) {
        segs.push(cur);
        cur = '';
      } else cur += ch;
    }
    segs.push(cur);
    return segs.map((s) => s.trim()).filter((s) => s !== '');
  }

  function parseSeg(seg) {
    const m = seg.match(/^([^[\]]*)((?:\[[^\]]*\])*)$/);
    if (!m) throw new ExtractError(`Invalid path segment "${seg}"`);
    const sels = (m[2].match(/\[[^\]]*\]/g) || []).map((s) => {
      const inner = s.slice(1, -1).trim();
      if (/^-?[0-9]+$/.test(inner)) return { index: Number(inner) };
      const eq = inner.indexOf('=');
      if (eq < 0) throw new ExtractError(`Invalid selector "${s}" in path`);
      return { key: inner.slice(0, eq).trim(), value: inner.slice(eq + 1).trim().replace(/^["']|["']$/g, '') };
    });
    return { key: m[1].trim(), sels };
  }

  function applySels(v, sels) {
    for (const s of sels) {
      if (v == null) return null;
      const arr = Array.isArray(v) ? v : [v];
      if (s.index !== undefined) v = arr[s.index < 0 ? arr.length + s.index : s.index];
      else v = arr.find((x) => isObj(x) && x[s.key] != null && toStr(x[s.key]).toLowerCase() === s.value.toLowerCase());
      if (v === undefined) v = null;
    }
    return v;
  }

  function getKey(v, key) {
    if (v == null) return null;
    if (Array.isArray(v)) {
      const out = [];
      for (const x of v) {
        const y = getKey(x, key);
        if (Array.isArray(y)) out.push(...y);
        else if (y != null) out.push(y);
      }
      return out.length ? out : null;
    }
    if (isObj(v)) return v[key] === undefined ? null : v[key];
    return null;
  }

  // "Person.address.postalCode", "Person.identifier[propertyID=NI number].value", ".name" (relative to a list item)
  function resolvePath(path, records, item) {
    let p = path.trim();
    const relative = p.startsWith('.');
    if (relative) p = p.slice(1);
    const segs = splitPath(p).map(parseSeg);
    let cur;
    if (relative) {
      cur = item === undefined ? null : item;
    } else {
      if (!segs.length) return null;
      const root = segs.shift();
      const matches = records.filter((r) => isObj(r) && (root.key === '*' || r['@type'] === root.key));
      cur = root.sels.length ? applySels(matches, root.sels) : matches.length ? matches[0] : null;
    }
    for (const s of segs) cur = applySels(getKey(cur, s.key), s.sels);
    return cur;
  }

  function objectText(o) {
    return Object.entries(o)
      .filter(([k]) => !k.startsWith('@'))
      .map(([, v]) => fillValue(v))
      .filter((v) => v !== null && v !== '')
      .map(toStr)
      .join(', ');
  }

  // What actually goes into a form control: scalars stay, lists and objects become text.
  function fillValue(v) {
    if (v === undefined || v === null || v === '') return null;
    if (Array.isArray(v)) {
      const parts = v.map(fillValue).filter((x) => x !== null).map(toStr);
      return parts.length ? parts.join(', ') : null;
    }
    if (isObj(v)) return objectText(v) || null;
    return v;
  }

  const EMPTY = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);

  function evalFillValue(spec, records, item, path, ctx) {
    const alts = Array.isArray(spec) ? spec : [spec];
    for (const alt of alts) {
      if (typeof alt !== 'string') {
        diag(ctx, 'error', path, 'Value must be a path expression or a list of them');
        continue;
      }
      if (alt.startsWith('=')) return alt.slice(1);
      try {
        const [p, ...filters] = splitPipes(alt);
        let v = resolvePath(p, records, item);
        for (const f of filters) {
          if (!f) continue;
          const { name, arg } = parseFilter(f);
          v = applyFilter(EMPTY(v) ? null : v, name, arg, ctx);
        }
        if (!EMPTY(v)) return v;
      } catch (e) {
        if (!(e instanceof ExtractError)) throw e;
        diag(ctx, 'error', path, e.message);
      }
    }
    return null;
  }

  function caseRecords(records) {
    return (records || []).map((r) => (isObj(r) && 'data' in r && !('@type' in r) ? r.data : r)).filter(isObj);
  }

  /**
   * Work out what a fill profile would put into the form, without touching the DOM.
   * Returns { fields: [{target, value}], lists: [{rows, add, items: [[{target, value}]]}], diagnostics }.
   */
  function resolveFill(profile, records) {
    const ctx = { baseUrl: null, diagnostics: [] };
    const recs = caseRecords(records);
    const fields = Object.entries(profile.fields || {}).map(([target, spec]) => {
      const value = fillValue(evalFillValue(spec, recs, undefined, `fields.${target}`, ctx));
      if (value === null) diag(ctx, 'warning', `fields.${target}`, 'No value in the case data');
      return { target, value };
    });
    const lists = (profile.lists || []).map((l, i) => {
      let items = null;
      try {
        items = resolvePath(l.source || '', recs, undefined);
      } catch (e) {
        if (!(e instanceof ExtractError)) throw e;
        diag(ctx, 'error', `lists[${i}].source`, e.message);
      }
      items = items == null ? [] : Array.isArray(items) ? items : [items];
      if (!items.length) diag(ctx, 'warning', `lists[${i}].source`, 'No items in the case data');
      return {
        rows: l.rows,
        add: l.add || null,
        items: items.map((item, j) => Object.entries(l.fields || {}).map(([target, spec]) => ({
          target,
          value: fillValue(evalFillValue(spec, recs, item, `lists[${i}][${j}].${target}`, ctx)),
        }))),
      };
    });
    return { fields, lists, diagnostics: ctx.diagnostics };
  }

  /**
   * Map one record onto a case type's data template with a mapping profile (kind "map").
   * Returns { fields: {key: value}, lists: {key: [{subkey: value}]}, diagnostics }. A record usually
   * covers only part of a template, so missing values are not reported.
   */
  function resolveMap(profile, records) {
    const ctx = { baseUrl: null, diagnostics: [] };
    const recs = caseRecords(records);
    const fields = {};
    for (const [key, spec] of Object.entries(profile.fields || {})) {
      fields[key] = fillValue(evalFillValue(spec, recs, undefined, `fields.${key}`, ctx));
    }
    const lists = {};
    (profile.lists || []).forEach((l, i) => {
      let items = null;
      try {
        items = resolvePath(l.source || '', recs, undefined);
      } catch (e) {
        if (!(e instanceof ExtractError)) throw e;
        diag(ctx, 'error', `lists[${i}].source`, e.message);
      }
      items = items == null ? [] : Array.isArray(items) ? items : [items];
      lists[l.key] = items.map((item, j) => {
        const row = {};
        for (const [k, spec] of Object.entries(l.fields || {})) {
          row[k] = fillValue(evalFillValue(spec, recs, item, `lists.${l.key}[${j}].${k}`, ctx));
        }
        return row;
      });
    });
    return { fields, lists, diagnostics: ctx.diagnostics };
  }

  function validateValueMap(obj, path, errors) {
    if (!isObj(obj)) {
      errors.push(`${path} must be an object`);
      return;
    }
    for (const [k, spec] of Object.entries(obj)) {
      const alts = Array.isArray(spec) ? spec : [spec];
      if (!alts.length || alts.some((a) => typeof a !== 'string')) errors.push(`${path}.${k}: value must be a path expression or a list of them`);
      for (const a of alts) if (typeof a === 'string') validateExpr(a, `${path}.${k}`, errors);
    }
  }

  function validateMapProfile(profile) {
    const errors = [];
    if (typeof profile.caseType !== 'string') errors.push('"caseType" must be a case type id');
    if (typeof profile.sourceProfile !== 'string') errors.push('"sourceProfile" must be an extraction profile id');
    if (profile.fields !== undefined) validateValueMap(profile.fields, 'fields', errors);
    if (profile.lists !== undefined) {
      if (!Array.isArray(profile.lists)) errors.push('"lists" must be a list');
      else profile.lists.forEach((l, i) => {
        if (!isObj(l) || typeof l.key !== 'string' || typeof l.source !== 'string') errors.push(`lists[${i}] needs "key" and "source"`);
        else validateValueMap(l.fields, `lists[${i}].fields`, errors);
      });
    }
    if (profile.unsure !== undefined && !isObj(profile.unsure)) errors.push('"unsure" must be an object of {key: reason}');
    return errors;
  }

  const FIELD_TYPES = new Set(['text', 'date', 'email', 'tel', 'number', 'boolean', 'longtext', 'choice', 'list']);

  function validateCaseType(ct) {
    const errors = [];
    if (typeof ct.name !== 'string' || !ct.name.trim()) errors.push('"name" must be a non-empty string');
    if (ct.form != null && (!isObj(ct.form) || (ct.form.url != null && typeof ct.form.url !== 'string'))) errors.push('"form" must be {url, fillProfile}');
    const checkFields = (fields, path) => {
      if (!Array.isArray(fields) || !fields.length) return errors.push(`${path} must be a non-empty list`);
      const seen = new Set();
      fields.forEach((f, i) => {
        if (!isObj(f) || typeof f.key !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(f.key)) return errors.push(`${path}[${i}].key must be an identifier`);
        if (seen.has(f.key)) errors.push(`${path}: duplicate key "${f.key}"`);
        seen.add(f.key);
        if (f.type != null && !FIELD_TYPES.has(f.type)) errors.push(`${path}.${f.key}: unknown type "${f.type}"`);
        if (f.type === 'list') checkFields(f.fields, `${path}.${f.key}.fields`);
        return null;
      });
      return null;
    };
    checkFields(ct.fields, 'fields');
    return errors;
  }

  function validateFillProfile(profile) {
    const errors = [];
    if (typeof profile.name !== 'string' || !profile.name.trim()) errors.push('"name" must be a non-empty string');
    const match = profile.match;
    if (!(typeof match === 'string' || (Array.isArray(match) && match.every((m) => typeof m === 'string')))) {
      errors.push('"match" must be a URL pattern or a list of URL patterns');
    }
    if (profile.when != null && typeof profile.when !== 'string') errors.push('"when" must be a selector string');
    const checkValues = (obj, path) => {
      if (!isObj(obj)) return errors.push(`${path} must be an object of {"css selector": value}`);
      for (const [target, spec] of Object.entries(obj)) {
        const alts = Array.isArray(spec) ? spec : [spec];
        if (!alts.length || alts.some((a) => typeof a !== 'string')) errors.push(`${path}.${target}: value must be a path expression or a list of them`);
        for (const a of alts) if (typeof a === 'string') validateExpr(a, `${path}.${target}`, errors);
      }
      return null;
    };
    if (profile.fields !== undefined) checkValues(profile.fields, 'fields');
    if (profile.lists !== undefined) {
      if (!Array.isArray(profile.lists)) errors.push('"lists" must be a list');
      else {
        profile.lists.forEach((l, i) => {
          if (!isObj(l)) return errors.push(`lists[${i}] must be an object`);
          if (typeof l.source !== 'string') errors.push(`lists[${i}].source must be a path`);
          if (typeof l.rows !== 'string') errors.push(`lists[${i}].rows must be a selector`);
          if (l.add != null && typeof l.add !== 'string') errors.push(`lists[${i}].add must be a selector`);
          checkValues(l.fields, `lists[${i}].fields`);
          return null;
        });
      }
    }
    if (profile.fields === undefined && profile.lists === undefined) errors.push('a fill profile needs "fields" and/or "lists"');
    return errors;
  }

  // ---------------------------------------------------------------- probing (testing drafts)

  // Every element a label locator could mean, not just the first: a label that appears twice is ambiguous.
  function labelHits(node, labelText) {
    const target = normLabel(labelText);
    const scope = labelScope(node);
    if (!target || !scope) return [];
    const els = Array.from(scope.querySelectorAll('*')).filter((el) => !LABEL_SKIP.has(el.localName));
    const limit = nonWs(target) + 10;
    const hits = [];
    for (const el of els) {
      const txt = boundedText(el, limit);
      if (txt == null || normLabel(txt) !== target) continue;
      const deeper = Array.from(el.children).some((c) => {
        const ct = boundedText(c, limit);
        return ct != null && normLabel(ct) === target;
      });
      if (deeper) continue;
      const v = labelValue(el, scope);
      if (v != null) hits.push(v);
    }
    return hits;
  }

  /**
   * How many elements a field's locator matches, and the value it reads. A string spec is one field;
   * a list spec [rows, item] is a row list, counted by rows. Used by "Test and use on this computer".
   */
  function probe(doc, spec, opts) {
    const ctx = { baseUrl: (opts && opts.baseUrl) || null, diagnostics: [] };
    try {
      if (Array.isArray(spec)) {
        const rows = resolveAll(doc, parseLocator(spec[0]));
        const items = evalList(spec, doc, 'probe', ctx);
        return { rows: true, count: rows.length, sample: items.slice(0, 5).flatMap((it) => (it && typeof it === 'object' ? Object.entries(it).filter(([k]) => !k.startsWith('@')).map(([, v]) => v) : [it])).filter((v) => v != null && typeof v !== 'object') };
      }
      if (typeof spec !== 'string') return { count: 0, error: 'Expected a selector' };
      if (spec.startsWith('=')) return { count: 1, value: spec.slice(1) };
      const loc = parseLocator(splitPipes(spec)[0]);
      let bases = loc.prefix ? query(doc, loc.prefix, true) : [doc];
      if (loc.label != null) bases = bases.flatMap((b) => labelHits(b, loc.label));
      let targets = bases;
      if (loc.css) targets = bases.flatMap((b) => (typeof b === 'string' ? [] : query(b, loc.css, true)));
      const value = evalExpr(spec, doc, 'probe', ctx);
      const error = ctx.diagnostics.find((d) => d.level === 'error');
      return error ? { count: 0, error: error.message } : { count: targets.length, value };
    } catch (e) {
      if (!(e instanceof ExtractError)) throw e;
      return { count: 0, error: e.message };
    }
  }

  // ---------------------------------------------------------------- public API

  function extract(doc, profile, opts) {
    const ctx = { baseUrl: (opts && opts.baseUrl) || null, diagnostics: [] };
    const fields = profile && Object.prototype.hasOwnProperty.call(profile, 'fields') ? profile.fields : profile;
    const data = evalSpec(fields, doc, '', ctx);
    return { data, diagnostics: ctx.diagnostics };
  }

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }

  function matchUrl(patterns, url) {
    if (!url) return false;
    const u = url.split('#')[0];
    const list = Array.isArray(patterns) ? patterns : patterns ? [patterns] : [];
    return list.some((p) => new RegExp('^' + p.split('*').map(escapeRe).join('.*') + '$').test(u));
  }

  // Does the profile apply to this page? (url patterns, then optional `when` selector)
  function profileApplies(profile, url, doc) {
    if (!matchUrl(profile.match, url)) return false;
    if (!profile.when || !doc) return true;
    try {
      return resolveOne(doc, parseLocator(profile.when)) != null;
    } catch (e) {
      return false;
    }
  }

  function validateProfile(profile) {
    const errors = [];
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return ['Profile must be a JSON object'];
    if (profile.kind === 'fill') return validateFillProfile(profile);
    if (profile.kind === 'map') return validateMapProfile(profile);
    if (profile.kind === 'casetype') return validateCaseType(profile);
    if (profile.kind != null && profile.kind !== 'extract') return ['"kind" must be "extract", "fill", "map" or "casetype"'];
    if (typeof profile.name !== 'string' || !profile.name.trim()) errors.push('"name" must be a non-empty string');
    const match = profile.match;
    if (!(typeof match === 'string' || (Array.isArray(match) && match.every((m) => typeof m === 'string')))) {
      errors.push('"match" must be a URL pattern or a list of URL patterns');
    }
    if (profile.when != null && typeof profile.when !== 'string') errors.push('"when" must be a selector string');
    if (profile.autoClip != null && typeof profile.autoClip !== 'boolean') errors.push('"autoClip" must be true or false');
    if (!profile.fields || typeof profile.fields !== 'object' || Array.isArray(profile.fields)) {
      errors.push('"fields" must be an object');
    } else {
      validateSpec(profile.fields, 'fields', errors);
    }
    return errors;
  }

  function validateExpr(expr, path, errors) {
    if (expr.startsWith('=')) return;
    const [, ...filters] = splitPipes(expr);
    for (const f of filters) {
      const { name, arg } = parseFilter(f);
      if (!['default', 'join', 'first'].includes(name) && !Object.prototype.hasOwnProperty.call(FILTERS, name)) {
        errors.push(`${path}: unknown filter "${name}"`);
      }
      if ((name === 'regex' || name === 'drop') && arg != null) {
        try {
          new RegExp(arg);
        } catch (e) {
          errors.push(`${path}: invalid regex "${arg}"`);
        }
      }
    }
  }

  function validateSpec(spec, path, errors) {
    if (typeof spec === 'string') validateExpr(spec, path, errors);
    else if (Array.isArray(spec) && spec.length && spec[0] && typeof spec[0] === 'object' && !Array.isArray(spec[0])) {
      spec.forEach((item, i) => validateSpec(item, `${path}[${i}]`, errors));
    } else if (Array.isArray(spec)) {
      if (spec.length < 1 || spec.length > 2 || typeof spec[0] !== 'string') {
        errors.push(`${path}: list spec must be [selector] or [selector, itemSpec]`);
      } else if (spec.length === 2) validateSpec(spec[1], `${path}[]`, errors);
    } else if (spec && typeof spec === 'object') {
      for (const [k, v] of Object.entries(spec)) {
        if (k === '$scope') {
          if (typeof v !== 'string') errors.push(`${path}.$scope: must be a selector string`);
        } else if (k.startsWith('@')) {
          if (typeof v !== 'string') errors.push(`${path}.${k}: must be a string`);
        } else if (!k.startsWith('$')) validateSpec(v, `${path}.${k}`, errors);
      }
    } else errors.push(`${path}: expected a string, list or object`);
  }

  root.PowerLoaderExtract = {
    extract,
    probe,
    validateFillProfile,
    matchUrl,
    profileApplies,
    validateProfile,
    resolveFill,
    caseRecords,
    resolveMap,
    resolvePath,
    fillValue,
    getText,
    cleanText,
    parseLocator,
    splitPipes,
    parseDate,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);

/*
 * In-page agent. Injected together with extract.js and capture.js in a single
 * scripting.executeScript({files}) call, then driven by runtime messages. (Firefox runs
 * executeScript({func}) in a separate context, so a func cannot see globals that an
 * earlier file injection created.)
 */
/* global browser */
(function (root) {
  'use strict';
  if (root.__powerloaderAgent) return;
  root.__powerloaderAgent = true;
  root.__powerloaderDocumentId = Array.from(crypto.getRandomValues(new Uint32Array(4)), (v) => v.toString(16)).join('-');

  // ---------------------------------------------------------------- describing forms

  const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file', 'password']);
  const esc = (s) => (root.CSS && root.CSS.escape ? root.CSS.escape(s) : String(s).replace(/[^\w-]/g, (c) => `\\${c}`));
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  function isControl(el) {
    const tag = el.localName;
    if (tag === 'select' || tag === 'textarea') return true;
    return tag === 'input' && !SKIP_TYPES.has((el.getAttribute('type') || 'text').toLowerCase());
  }

  function ownText(labelEl) {
    const copy = labelEl.cloneNode(true);
    copy.querySelectorAll('input, select, textarea, button').forEach((n) => n.remove());
    return clean(copy.textContent);
  }

  function labelFor(el) {
    if (el.id) {
      const l = document.querySelector(`label[for="${esc(el.id)}"]`);
      if (l && ownText(l)) return ownText(l);
    }
    const wrap = el.closest('label');
    if (wrap && ownText(wrap)) return ownText(wrap);
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((n) => clean(n.textContent)).join(' ');
      if (t) return t;
    }
    const cell = el.closest('td');
    const table = cell && cell.closest('table');
    if (cell && table) {
      const th = table.querySelectorAll('thead th')[cell.cellIndex];
      if (th && clean(th.textContent)) return clean(th.textContent);
    }
    if (el.getAttribute('placeholder')) return clean(el.getAttribute('placeholder'));
    if (el.getAttribute('title')) return clean(el.getAttribute('title'));
    return el.getAttribute('name') || el.id || el.localName;
  }

  function unique(sel, scope) {
    try {
      return scope.querySelectorAll(sel).length === 1;
    } catch (e) {
      return false;
    }
  }

  // A short selector that finds exactly this element within scope.
  function selectorFor(el, scope) {
    const tag = el.localName;
    if (el.id && unique(`#${esc(el.id)}`, scope)) return `#${esc(el.id)}`;
    const name = el.getAttribute('name');
    if (name) {
      let s = `${tag}[name="${name.replace(/"/g, '\\"')}"]`;
      if (unique(s, scope)) return s;
      if (el.getAttribute('type') === 'radio' && el.value) {
        s += `[value="${el.value.replace(/"/g, '\\"')}"]`;
        if (unique(s, scope)) return s;
      }
    }
    const parts = [];
    let cur = el;
    while (cur && cur !== scope && cur.nodeType === 1) {
      if (cur.id && cur !== el) {
        parts.unshift(`#${esc(cur.id)}`);
        break;
      }
      const same = cur.parentElement ? Array.from(cur.parentElement.children).filter((c) => c.localName === cur.localName) : [];
      parts.unshift(same.length > 1 ? `${cur.localName}:nth-of-type(${same.indexOf(cur) + 1})` : cur.localName);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  // The heading a person would read this element under: a fieldset legend, or the nearest heading before it.
  function nearestHeading(el) {
    const fs = el.closest('fieldset');
    const legend = fs && fs.querySelector(':scope > legend');
    if (legend && clean(legend.textContent)) return clean(legend.textContent);
    let cur = el;
    for (let depth = 0; cur && depth < 6; depth++, cur = cur.parentElement) {
      let sib = cur.previousElementSibling;
      for (let n = 0; sib && n < 15; n++, sib = sib.previousElementSibling) {
        if (/^h[1-6]$/.test(sib.localName)) return clean(sib.textContent).replace(/^\d+[.)]\s*/, '');
        const inner = sib.querySelector && sib.querySelector('h1, h2, h3, h4, h5, h6');
        if (inner && !sib.querySelector('input, select, textarea')) return clean(inner.textContent).replace(/^\d+[.)]\s*/, '');
      }
    }
    return null;
  }

  function describeControl(el, scope) {
    const d = {
      selector: selectorFor(el, scope),
      label: labelFor(el),
      tag: el.localName,
      type: el.localName === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : el.localName,
    };
    if (el.localName === 'select') d.options = Array.from(el.options).map((o) => clean(o.text)).filter(Boolean).slice(0, 40);
    if (el.required) d.required = true;
    if (d.type === 'radio' && el.name) d.name = el.name;
    const section = scope === document ? nearestHeading(el) : null;
    if (section) d.section = section;
    const v = el.type === 'checkbox' || el.type === 'radio' ? (el.checked ? 'checked' : '') : el.value;
    if (v) d.current = String(v).slice(0, 80);
    return d;
  }

  // Controls, repeating table rows (e.g. household members) and buttons on the page.
  function describeForm() {
    const controls = [];
    const groups = new Map();
    for (const el of document.querySelectorAll('input, select, textarea')) {
      if (!isControl(el)) continue;
      const tr = el.closest('tbody tr, table > tr');
      if (tr && tr.parentElement) {
        const body = tr.parentElement;
        const key = `${selectorFor(body, document)} > tr`;
        if (!groups.has(key)) {
          const heading = nearestHeading(body.closest('table') || body);
          groups.set(key, { rows: key, rowCount: body.querySelectorAll(':scope > tr').length, controls: [], ...(heading ? { heading } : {}) });
        }
        const g = groups.get(key);
        const d = describeControl(el, tr);
        if (!g.controls.some((c) => c.selector === d.selector)) g.controls.push(d);
        continue;
      }
      controls.push(describeControl(el, document));
    }
    const buttons = Array.from(document.querySelectorAll('button, input[type=button], input[type=submit], [role=button]'))
      .map((b) => ({ selector: selectorFor(b, document), text: clean(b.textContent || b.value || b.getAttribute('aria-label') || b.title) }))
      .filter((b) => b.text)
      .slice(0, 40);
    return { url: location.href, title: document.title, documentId: root.__powerloaderDocumentId, controls, groups: Array.from(groups.values()), buttons };
  }

  // ---------------------------------------------------------------- filling

  const TRUE = /^(true|yes|y|1|on|checked|ticked)$/i;
  const FALSE = /^(false|no|n|0|off|unchecked|none)$/i;

  function fire(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function highlight(el) {
    el.style.outline = '2px solid #5fa777';
    el.style.outlineOffset = '1px';
    el.dataset.powerloaderFilled = '1';
  }

  // Returns true if the value was put into the control.
  function setControl(el, value) {
    const tag = el.localName;
    const type = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : tag;
    const text = typeof value === 'string' ? value : String(value);
    if (type === 'checkbox') {
      const want = value === true || TRUE.test(text) ? true : value === false || FALSE.test(text) ? false : null;
      if (want === null) return false;
      el.checked = want;
    } else if (type === 'radio') {
      const group = el.name ? Array.from((el.form || document).querySelectorAll(`input[type=radio][name="${el.name.replace(/"/g, '\\"')}"]`)) : [el];
      const want = text.trim().toLowerCase();
      const hit = group.find((r) => r.value.toLowerCase() === want || labelFor(r).toLowerCase() === want);
      if (!hit) return false;
      hit.checked = true;
      fire(hit);
      highlight(hit);
      return true;
    } else if (tag === 'select') {
      const want = text.trim().toLowerCase();
      const opts = Array.from(el.options);
      const hit = opts.find((o) => o.value.toLowerCase() === want || clean(o.text).toLowerCase() === want)
        || opts.find((o) => want && clean(o.text).toLowerCase().startsWith(want))
        || opts.find((o) => want && o.value && want.startsWith(clean(o.text).toLowerCase()) && clean(o.text));
      if (!hit) return false;
      el.value = hit.value;
    } else if (type === 'date') {
      const iso = /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : root.PowerLoaderExtract.parseDate(text);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
      el.value = iso;
    } else {
      el.value = text;
    }
    fire(el);
    highlight(el);
    return true;
  }

  /**
   * Apply an approved fill plan: { items: [{ target, value }] }. Values only: nothing is clicked, and each
   * target must be exactly one form control that takes a value (never a button, submit, reset or link).
   * Returns { filled: [{ target, label }], failed: [{ target, label, reason }] }.
   */
  function fill(plan) {
    const report = { filled: [], failed: [] };
    for (const { target, value } of plan.items || []) {
      let els = [];
      try { els = Array.from(document.querySelectorAll(target)); } catch (e) { els = []; }
      if (els.length !== 1) { report.failed.push({ target, label: target, reason: els.length ? `${els.length} boxes match` : 'Not on this page' }); continue; }
      const el = els[0];
      const label = labelFor(el);
      if (!isControl(el) || el.disabled || el.readOnly) { report.failed.push({ target, label, reason: 'Not a box Power Loader can fill' }); continue; }
      if (setControl(el, value)) report.filled.push({ target, label });
      else report.failed.push({ target, label, reason: 'The box doesn’t accept this value' });
    }
    return report;
  }

  // ---------------------------------------------------------------- personal data highlighting

  // Visible text and form field values in reading order, with a line break wherever the
  // enclosing block changes. Offsets into this text are what the privacy model's spans refer to.
  const PII_SKIP = 'script, style, noscript, template, textarea, select, svg';
  const PII_FIELDS = 'textarea, input:not([type]), input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="search"], input[type="date"], input[type="number"]';
  const PII_ATTR = 'data-powerloader-pii';
  const PII_FIELD_ATTR = 'data-powerloader-pii-field';

  function pageText() {
    const nodes = [];
    let text = '';
    let lastBlock = null;
    const blocks = new Map();
    const blockOf = (el) => {
      for (let e = el; e && e !== document.body; e = e.parentElement) {
        if (!blocks.has(e)) blocks.set(e, !getComputedStyle(e).display.startsWith('inline'));
        if (blocks.get(e)) return e;
      }
      return document.body;
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(n) {
        if (n.nodeType === Node.ELEMENT_NODE) {
          return n.matches(PII_FIELDS) && n.value.trim() && n.getClientRects().length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        }
        const p = n.parentElement;
        if (!n.nodeValue.trim() || !p || p.closest(PII_SKIP) || !p.getClientRects().length) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const field = n.nodeType === Node.ELEMENT_NODE;
      // A field is its own block, so its value never runs into the label text.
      const block = field ? n : blockOf(n.parentElement);
      if (lastBlock && block !== lastBlock) text += '\n';
      lastBlock = block;
      const value = field ? n.value : n.nodeValue;
      nodes.push({ node: n, start: text.length, length: value.length, field });
      text += value;
    }
    return { text, nodes };
  }

  function clearHighlights() {
    const parents = new Set();
    document.querySelectorAll(`mark[${PII_ATTR}]`).forEach((m) => {
      parents.add(m.parentNode);
      m.replaceWith(document.createTextNode(m.textContent));
    });
    parents.forEach((p) => p.normalize());
    document.querySelectorAll(`[${PII_FIELD_ATTR}]`).forEach((f) => {
      f.removeAttribute(PII_FIELD_ATTR);
      f.style.removeProperty('box-shadow');
    });
  }

  function highlightPII(expectedText, spans) {
    clearHighlights();
    const { text, nodes } = pageText();
    if (text !== expectedText) throw new Error('The page changed since it was scanned; scan again');
    if (!document.getElementById('powerloader-pii-style')) {
      const style = document.createElement('style');
      style.id = 'powerloader-pii-style';
      style.textContent = `mark[${PII_ATTR}]{color:#111;border-radius:3px;padding:0 1px;box-shadow:0 0 0 1px rgba(0,0,0,.25)}`
        + `mark[${PII_ATTR}].powerloader-flash,[${PII_FIELD_ATTR}].powerloader-flash{outline:3px solid #2f5f8f;outline-offset:2px}`;
      document.head.append(style);
    }
    // Pieces of each span per text node, wrapped right-to-left within a node so earlier offsets stay valid.
    // Form fields cannot contain markup, so a field holding any finding gets a coloured ring instead.
    const pieces = [];
    spans.forEach((s, idx) => {
      nodes.forEach(({ node, start, length, field }, ni) => {
        const end = start + length;
        if (end <= s.start || start >= s.end) return;
        if (field) {
          const ids = node.getAttribute(PII_FIELD_ATTR);
          node.setAttribute(PII_FIELD_ATTR, ids ? `${ids} ${idx}` : String(idx));
          node.style.setProperty('box-shadow', `0 0 0 3px ${s.color}`, 'important');
          return;
        }
        pieces.push({ node, ni, from: Math.max(s.start, start) - start, to: Math.min(s.end, end) - start, idx, s });
      });
    });
    pieces.sort((a, b) => a.ni - b.ni || b.from - a.from);
    for (const p of pieces) {
      const mid = p.node.splitText(p.from);
      mid.splitText(p.to - p.from);
      const mark = document.createElement('mark');
      mark.setAttribute(PII_ATTR, String(p.idx));
      mark.style.background = p.s.color;
      mark.title = `${p.s.name} (${Math.round(p.s.score * 100)}%)`;
      mid.replaceWith(mark);
      mark.append(mid);
    }
    return { marked: spans.length };
  }

  function focusHighlight(idx) {
    const marks = document.querySelectorAll(`mark[${PII_ATTR}="${Number(idx)}"], [${PII_FIELD_ATTR}~="${Number(idx)}"]`);
    if (!marks.length) return false;
    marks[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
    marks.forEach((m) => m.classList.add('powerloader-flash'));
    setTimeout(() => marks.forEach((m) => m.classList.remove('powerloader-flash')), 1600);
    return true;
  }

  // ---------------------------------------------------------------- picking values for a draft profile
  // Every value the page shows is outlined. A value can be clicked (or reached with Tab and Space), which
  // selects it for the sidebar, or dragged onto a field in the sidebar. Values in the draft are solid and carry
  // their field's name. The override tool lets any other element be chosen, and it then works the same way.

  const PICK = 'data-powerloader-pick';
  const FIELD = 'data-powerloader-field';
  const DRAG_TYPE = 'application/x-powerloader-pick';
  const PICK_SKIP = 'script, style, noscript, template, nav, dt, th, label, legend, button, option, [data-powerloader-ui]';
  let picking = null;
  let override = null;

  const directText = (el) => clean(Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.data).join(' '));
  const quoteLabel = (t) => clean(t).replace(/[:*]+$/, '').trim();

  function scopeOf(el) {
    for (let cur = el.parentElement; cur && cur !== document.body; cur = cur.parentElement) {
      if (cur.id && unique(`#${esc(cur.id)}`, document)) return `#${esc(cur.id)}`;
    }
    return '';
  }

  // A selector that finds this value by its label or the page structure, never by the value itself.
  function pickSelector(el) {
    const scope = scopeOf(el);
    const within = (s) => (scope ? `${scope} ${s}` : s);
    if (isControl(el)) return selectorFor(el, document);
    const dd = el.closest('dd');
    if (dd && dd.previousElementSibling?.localName === 'dt') return within(`label(${quoteLabel(dd.previousElementSibling.textContent)})`);
    const td = el.closest('td');
    const rowHead = td && td.parentElement.querySelector(':scope > th');
    if (td && rowHead) return within(`label(${quoteLabel(rowHead.textContent)})`);
    // "Client ID: NC-1042": a bold or span label followed by the value as text.
    const lead = Array.from(el.children).find((c) => /:\s*$/.test(c.textContent) && c.nextSibling?.nodeType === 3 && c.nextSibling.data.trim());
    if (lead) return within(`label(${quoteLabel(lead.textContent)})`);
    if (el.id && unique(`#${esc(el.id)}`, document)) return `#${esc(el.id)}`;
    const parts = [];
    let cur = el;
    const stop = scope ? document.querySelector(scope) : document.body;
    while (cur && cur !== stop && cur !== document.body) {
      const same = Array.from(cur.parentElement.children).filter((c) => c.localName === cur.localName);
      parts.unshift(same.length > 1 ? `${cur.localName}:nth-of-type(${same.indexOf(cur) + 1})` : cur.localName);
      cur = cur.parentElement;
    }
    return within(parts.join(' > '));
  }

  // What a person would read as this value's label, and whether it sits in a repeating row (a household
  // member, a note) rather than being the record's own value.
  function describeValue(el) {
    if (isControl(el)) return { label: labelFor(el), repeat: false };
    const dd = el.closest('dd');
    if (dd && dd.previousElementSibling?.localName === 'dt') return { label: quoteLabel(dd.previousElementSibling.textContent), repeat: false };
    const td = el.closest('td');
    if (td) {
      const rowHead = td.parentElement.querySelector(':scope > th');
      if (rowHead) return { label: quoteLabel(rowHead.textContent), repeat: false };
      const table = td.closest('table');
      const th = table && table.querySelectorAll('thead th')[td.cellIndex];
      const rows = table ? table.querySelectorAll('tbody > tr').length : 0;
      return { label: th ? quoteLabel(th.textContent) : null, repeat: rows > 1 };
    }
    const lead = Array.from(el.children).find((c) => /:\s*$/.test(c.textContent) && c.nextSibling?.nodeType === 3 && c.nextSibling.data.trim());
    if (lead) return { label: quoteLabel(lead.textContent), repeat: false };
    const aria = el.getAttribute('aria-label');
    if (aria) return { label: clean(aria), repeat: false };
    // Three or more siblings with the same tag and class: a list of things, not one value.
    const p = el.parentElement;
    const kin = p ? Array.from(p.children).filter((c) => c.localName === el.localName && c.className === el.className).length : 0;
    const host = el.closest('li, .note, article');
    return { label: null, repeat: kin >= 3 || !!(host && host.parentElement && Array.from(host.parentElement.children).filter((c) => c.className === host.className).length >= 2) };
  }

  // A short, readable path to the element, for the model: main/table.details/tr[3]/td.
  function shortPath(el) {
    const out = [];
    for (let cur = el, n = 0; cur && cur !== document.body && n < 4; cur = cur.parentElement, n++) {
      const same = cur.parentElement ? Array.from(cur.parentElement.children).filter((c) => c.localName === cur.localName) : [];
      const cls = cur.classList && cur.classList[0] && !/^css-/.test(cur.classList[0]) ? `.${cur.classList[0]}` : '';
      out.unshift(cur.id ? `${cur.localName}#${cur.id}` : `${cur.localName}${cls}${same.length > 1 ? `[${same.indexOf(cur) + 1}]` : ''}`);
      if (cur.id) break;
    }
    return out.join('/');
  }

  // Boxes a form fill can set: every visible control, empty or not, except buttons, files and hidden ones.
  const FILLABLE = /^(hidden|submit|button|reset|image|file)$/;
  function controlCandidates() {
    return Array.from(document.querySelectorAll('input, select, textarea'))
      .filter((el) => isControl(el) && !el.closest('[data-powerloader-ui]') && el.getClientRects().length && !FILLABLE.test((el.getAttribute('type') || '').toLowerCase()));
  }

  function candidates() {
    const out = [];
    for (const el of document.body.querySelectorAll('*')) {
      if (el.closest(PICK_SKIP) || !el.getClientRects().length) continue;
      if (isControl(el)) { if (el.value && el.type !== 'checkbox' && el.type !== 'radio') out.push(el); continue; }
      const t = directText(el);
      if (t && t.length <= 200 && !/^[:·|•-]+$/.test(t)) out.push(el);
    }
    return out;
  }

  const valueOf = (el) => (isControl(el) ? el.value : clean(el.textContent));

  // What the profile would read with this selector ("NC-1042" for "Client ID: NC-1042"), or the element's text.
  function readValue(el, selector) {
    try {
      const p = root.PowerLoaderExtract.probe(document, selector, { baseUrl: location.href });
      if (p.count === 1 && p.value != null && p.value !== '') return String(p.value);
    } catch { /* a selector the engine can't read: show the element's text */ }
    return valueOf(el);
  }

  function candidateOf(el, id) {
    const d = describeValue(el);
    const section = nearestHeading(el);
    const selector = picking.sel.get(el);
    return {
      id, selector, value: readValue(el, selector).slice(0, 120), label: d.label || null, tag: el.localName,
      ...(isControl(el) ? { type: el.localName === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : el.localName, name: el.getAttribute('name') || null } : {}),
      ...(section ? { section } : {}), path: shortPath(el), repeat: d.repeat,
    };
  }

  // selected: selectors in the draft; fields: { selector: field label } shown as badges; current: the selection.
  function markPicked(selected, fields = {}, current = null) {
    if (!picking) return;
    for (const el of picking.els) {
      const s = picking.sel.get(el);
      el.setAttribute(PICK, s === current ? 'sel' : selected.includes(s) ? 'on' : '');
      if (fields[s]) el.setAttribute(FIELD, fields[s]); else el.removeAttribute(FIELD);
    }
  }

  function send(el, extra = {}) {
    const selector = picking.sel.get(el);
    const d = describeValue(el);
    browser.runtime.sendMessage({ type: 'powerloader:picked', selector, value: readValue(el, selector).slice(0, 200), label: d.label || labelFor(el), ...extra }).catch(() => {});
  }

  function addCandidate(el) {
    if (picking.sel.has(el)) return;
    picking.els.push(el);
    picking.sel.set(el, pickSelector(el));
    picking.tabindex.set(el, el.getAttribute('tabindex'));
    picking.draggable.set(el, el.getAttribute('draggable'));
    el.setAttribute('tabindex', '0');
    if (!isControl(el)) el.setAttribute('draggable', 'true');
    el.setAttribute(PICK, '');
  }

  // mode 'controls' outlines a form's boxes (for mapping a form to fill); otherwise the values on the page.
  function pickStart(selected, fields, mode) {
    pickStop();
    const els = mode === 'controls' ? controlCandidates() : candidates();
    picking = { els: [], sel: new Map(), tabindex: new Map(), draggable: new Map(), mode };
    if (!document.getElementById('powerloader-pick-style')) {
      const style = document.createElement('style');
      style.id = 'powerloader-pick-style';
      style.textContent = `[${PICK}]{outline:2px dashed #2f5f8f!important;outline-offset:2px;cursor:pointer}`
        + `[${PICK}="on"]{outline:3px solid #2f5f8f!important;background:rgba(47,95,143,.10)!important}`
        + `[${PICK}="sel"]{outline:3px solid #ffdd00!important;box-shadow:0 0 0 6px #0b0c0c!important;background:rgba(255,221,0,.25)!important}`
        + `[${PICK}][draggable="true"]{cursor:grab}`
        + `[${FIELD}]::after{content:"→ " attr(${FIELD});display:inline-block;margin-left:6px;padding:0 5px;font:bold 11px/1.6 Arial,sans-serif;color:#fff;background:#2f5f8f;border-radius:3px;vertical-align:middle;pointer-events:none}`
        + `[${PICK}]:focus-visible{box-shadow:0 0 0 5px #9cc3e8!important}`;
      document.head.append(style);
    }
    for (const el of els) addCandidate(el);
    markPicked(selected || [], fields || {});
    picking.click = (e) => {
      const el = e.target.closest(`[${PICK}]`);
      if (!el || !e.isTrusted || override) return;
      e.preventDefault();
      e.stopPropagation();
      send(el);
    };
    picking.key = (e) => {
      const el = e.target.closest?.(`[${PICK}]`);
      if (!el || !e.isTrusted || (e.key !== ' ' && e.key !== 'Enter') || (isControl(el) && (e.key !== 'Enter' || picking.mode !== 'controls'))) return;
      e.preventDefault();
      send(el);
    };
    // Dragging a value to the sidebar: the sidebar reads the selector from the drag data, or from this
    // message when the drag data doesn't reach it.
    picking.drag = (e) => {
      const el = e.target.closest?.(`[${PICK}]`);
      if (!el || !e.isTrusted || !e.dataTransfer) return;
      const sel = picking.sel.get(el);
      const pick = { selector: sel, value: readValue(el, sel).slice(0, 200), label: describeValue(el).label || labelFor(el) };
      e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(pick));
      e.dataTransfer.setData('text/plain', pick.value);
      e.dataTransfer.effectAllowed = 'copy';
      browser.runtime.sendMessage({ type: 'powerloader:dragPick', ...pick }).catch(() => {});
    };
    // On a form, pressing a box would focus it or open its drop-down: in this mode it only chooses it.
    picking.down = (e) => {
      if (picking.mode === 'controls' && e.isTrusted && !override && e.target.closest?.(`[${PICK}]`)) e.preventDefault();
    };
    document.addEventListener('mousedown', picking.down, true);
    document.addEventListener('click', picking.click, true);
    document.addEventListener('keydown', picking.key, true);
    document.addEventListener('dragstart', picking.drag, true);
    // The list doubles as a way to add values without pointing at the page.
    return { candidates: picking.els.map((el, i) => candidateOf(el, `c${i}`)) };
  }

  function pickStop() {
    overrideStop();
    if (!picking) return;
    document.removeEventListener('mousedown', picking.down, true);
    document.removeEventListener('click', picking.click, true);
    document.removeEventListener('keydown', picking.key, true);
    document.removeEventListener('dragstart', picking.drag, true);
    for (const el of picking.els) {
      el.removeAttribute(PICK);
      el.removeAttribute(FIELD);
      const t = picking.tabindex.get(el);
      if (t === null) el.removeAttribute('tabindex'); else el.setAttribute('tabindex', t);
      const dg = picking.draggable.get(el);
      if (dg === null) el.removeAttribute('draggable'); else el.setAttribute('draggable', dg);
    }
    document.getElementById('powerloader-pick-style')?.remove();
    picking = null;
  }

  // The override tool: outline whatever is under the pointer; a click chooses it, Esc cancels. The chosen
  // element joins the candidates, so it can be dragged and is marked like the others.
  function overrideStart() {
    overrideStop();
    if (!picking) return Promise.resolve(null);
    return new Promise((resolve) => {
      const box = document.createElement('div');
      box.setAttribute('data-powerloader-ui', 'override');
      box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:3px solid #d4351c;background:rgba(212,53,28,.10);display:none';
      const hint = document.createElement('div');
      hint.setAttribute('data-powerloader-ui', 'override');
      hint.textContent = 'Click the value to use. Esc cancels.';
      hint.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#0b0c0c;color:#fff;padding:6px 11px;font:13px/1.4 Arial,sans-serif;pointer-events:none';
      document.documentElement.append(box, hint);
      let target = null;
      const move = (e) => {
        const el = e.target;
        if (!el || el.nodeType !== 1 || el === document.body || el === document.documentElement || el.closest('[data-powerloader-ui]')) return;
        target = el;
        const r = el.getBoundingClientRect();
        Object.assign(box.style, { display: 'block', left: `${r.left - 3}px`, top: `${r.top - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px` });
      };
      const click = (e) => {
        if (!e.isTrusted) return;
        e.preventDefault();
        e.stopPropagation();
        const el = target || e.target;
        if (!el || el === document.body || !valueOf(el)) return;
        addCandidate(el);
        finish(candidateOf(el, `c${picking.els.indexOf(el)}`));
      };
      const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); finish(null); } };
      const finish = (out) => {
        document.removeEventListener('mouseover', move, true);
        document.removeEventListener('click', click, true);
        document.removeEventListener('keydown', key, true);
        box.remove();
        hint.remove();
        override = null;
        resolve(out);
      };
      document.addEventListener('mouseover', move, true);
      document.addEventListener('click', click, true);
      document.addEventListener('keydown', key, true);
      override = { cancel: () => finish(null) };
    });
  }

  function overrideStop() { override?.cancel(); }

  // Labels on the page, for "Add a field by label": no pointer needed.
  function pageLabels() {
    const out = new Map();
    const add = (labelEl, valueEl) => {
      const label = quoteLabel(labelEl.textContent);
      if (!label || label.length > 60 || out.has(label) || !valueEl) return;
      const value = isControl(valueEl) ? valueEl.value : clean(valueEl.textContent);
      out.set(label, { label, selector: `${scopeOf(labelEl) ? `${scopeOf(labelEl)} ` : ''}label(${label})`, value: value.slice(0, 120) });
    };
    document.querySelectorAll('dt').forEach((dt) => add(dt, dt.nextElementSibling?.localName === 'dd' ? dt.nextElementSibling : null));
    document.querySelectorAll('tr > th:first-child').forEach((th) => add(th, th.nextElementSibling));
    document.querySelectorAll('label[for]').forEach((l) => add(l, document.getElementById(l.getAttribute('for'))));
    return [...out.values()];
  }

  // ---------------------------------------------------------------- selecting a region of the screen

  // Draw a box over the visible page: drag with the pointer, or use the keyboard (arrows move, Shift+arrows
  // resize, Enter captures, Esc cancels). Resolves the box in CSS pixels of the viewport, or null.
  let region = null;
  function selectRegion() {
    region?.cancel();
    return new Promise((resolve) => {
      const vw = root.innerWidth, vh = root.innerHeight;
      const ov = document.createElement('div');
      ov.setAttribute('data-powerloader', 'region');
      ov.tabIndex = 0;
      ov.setAttribute('role', 'application');
      ov.setAttribute('aria-label', 'Select a region to read. Drag a box, or use the arrow keys to move it, Shift and the arrow keys to resize it, Enter to read it and Escape to cancel.');
      ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(11,12,12,.28);touch-action:none;outline:none';
      const hint = document.createElement('div');
      hint.textContent = 'Drag a box around what you want to read. Arrow keys move it, Shift+arrows resize it, Enter reads it, Esc cancels.';
      hint.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);background:#0b0c0c;color:#fff;padding:6px 11px;font:13px/1.4 Arial,sans-serif;pointer-events:none;max-width:90vw';
      const box = document.createElement('div');
      box.style.cssText = 'position:fixed;border:3px solid #4c2c92;background:rgba(255,255,255,.18);box-shadow:0 0 0 2px #ffdd00;pointer-events:none';
      ov.append(hint, box);
      let r = { x: Math.round(vw * 0.25), y: Math.round(vh * 0.25), w: Math.round(vw * 0.5), h: Math.round(vh * 0.3) };
      let start = null;
      const draw = () => Object.assign(box.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
      const finish = (out) => {
        ov.remove();
        document.removeEventListener('keydown', onKey, true);
        region = null;
        resolve(out);
      };
      const take = () => finish(r.w >= 12 && r.h >= 12 ? { ...r, vw, vh, dpr: root.devicePixelRatio || 1 } : null);
      function onKey(e) {
        const step = e.altKey ? 1 : 10;
        const k = e.key;
        if (k === 'Escape') { e.preventDefault(); finish(null); return; }
        if (k === 'Enter') { e.preventDefault(); take(); return; }
        const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[k];
        if (!d) return;
        e.preventDefault();
        if (e.shiftKey) { r.w = Math.max(12, Math.min(vw - r.x, r.w + d[0])); r.h = Math.max(12, Math.min(vh - r.y, r.h + d[1])); }
        else { r.x = Math.max(0, Math.min(vw - r.w, r.x + d[0])); r.y = Math.max(0, Math.min(vh - r.h, r.y + d[1])); }
        draw();
      }
      ov.addEventListener('pointerdown', (e) => { start = { x: e.clientX, y: e.clientY }; try { ov.setPointerCapture(e.pointerId); } catch { /* not capturable */ } r = { x: e.clientX, y: e.clientY, w: 0, h: 0 }; draw(); });
      ov.addEventListener('pointermove', (e) => { if (!start) return; r = { x: Math.min(start.x, e.clientX), y: Math.min(start.y, e.clientY), w: Math.abs(e.clientX - start.x), h: Math.abs(e.clientY - start.y) }; draw(); });
      ov.addEventListener('pointerup', () => { if (!start) return; start = null; take(); });
      document.addEventListener('keydown', onKey, true);
      document.documentElement.append(ov);
      draw();
      ov.focus();
      region = { cancel: () => finish(null) };
    });
  }

  // ---------------------------------------------------------------- messages

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('powerloader:')) return undefined;
    const E = root.PowerLoaderExtract;
    switch (msg.type) {
      case 'powerloader:ping':
        return Promise.resolve(true);
      case 'powerloader:applies':
        return Promise.resolve(msg.profiles.map((p) => E.profileApplies(p, location.href, document)));
      case 'powerloader:extract':
        return Promise.resolve({
          ...E.extract(document, msg.profile, { baseUrl: location.href }),
          url: location.href,
          title: document.title,
        });
      case 'powerloader:capture':
        return Promise.resolve(root.PowerLoaderCapture());
      case 'powerloader:describeForm':
        return Promise.resolve(describeForm());
      case 'powerloader:probe':
        return Promise.resolve(Object.fromEntries(Object.entries(msg.profile.fields || {}).filter(([k]) => !k.startsWith('@'))
          .map(([k, spec]) => [k, E.probe(document, spec, { baseUrl: location.href })])));
      case 'powerloader:pickStart':
        return Promise.resolve(pickStart(msg.selected, msg.fields, msg.mode));
      case 'powerloader:pickSelected':
        markPicked(msg.selected || [], msg.fields || {}, msg.current || null);
        return Promise.resolve(true);
      case 'powerloader:overrideStart':
        return overrideStart();
      case 'powerloader:overrideStop':
        overrideStop();
        return Promise.resolve(true);
      case 'powerloader:pickStop':
        pickStop();
        return Promise.resolve(true);
      case 'powerloader:scroll':
        return Promise.resolve({ x: root.scrollX, y: root.scrollY });
      case 'powerloader:scrollTo':
        root.scrollTo(Number(msg.x) || 0, Number(msg.y) || 0);
        return Promise.resolve(true);
      case 'powerloader:values':
        return Promise.resolve(candidates().map((el) => (isControl(el) ? el.value : clean(el.textContent)).slice(0, 200)));
      case 'powerloader:labels':
        return Promise.resolve(pageLabels());
      case 'powerloader:pageText':
        clearHighlights();
        return Promise.resolve({ text: pageText().text, url: location.href, title: document.title });
      case 'powerloader:highlightPII':
        try { return Promise.resolve(highlightPII(msg.text, msg.spans)); } catch (e) { return Promise.reject(e); }
      case 'powerloader:clearPII':
        clearHighlights();
        return Promise.resolve(true);
      case 'powerloader:focusPII':
        return Promise.resolve(focusHighlight(msg.index));
      case 'powerloader:selectRegion':
        return selectRegion();
      case 'powerloader:cancelRegion':
        region?.cancel();
        return Promise.resolve(true);
      case 'powerloader:fill':
        if ((msg.documentId && msg.documentId !== root.__powerloaderDocumentId) || (msg.url && msg.url !== location.href)) return Promise.reject(new Error('The page changed before filling; try again'));
        return Promise.resolve(fill({ items: (msg.plan?.items || []).map(({ target, value }) => ({ target: String(target), value })) }));
      default:
        return undefined;
    }
  });
})(globalThis);

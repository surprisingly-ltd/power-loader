/*
 * Showing what a template reads, on the page itself. Injected with the in-page agent (lib/agent.js, by
 * ensureAgent() in lib/core.js) and driven by the sidebar (sidebar/gather-ui.js). Every message is checked
 * against the site rules as a read (lib/core.js MESSAGE_ACTIONS), except clearValues:
 *   powerloader:showValues    outline every value the template reads here, before or after it is clipped
 *   powerloader:gatherValues  the clip has happened: each value lifts off the page and travels to the sidebar
 *   powerloader:pointValue    the caseworker is pointing at one value's row in the sidebar
 *   powerloader:clearValues   take the outlines away, and put back anything revealed
 *   powerloader:revealBefore  Build: remember the class names around a value, before the author opens its part
 *   powerloader:revealAfter   Build: the difference since, offered as a reveal rule
 *   powerloader:fetchBox      a fetch step's box for one request: open, read (its text, outlined) or failed
 * A value out of sight (a closed <details>, a hidden attribute, a part a reveal rule opens with class names) is
 * brought into view when it is outlined or pointed at, and put back when the outlines are cleared.
 * Nothing is read that the template doesn't already read, and nothing leaves the page: the sidebar gets back
 * which fields were found and where on the screen they are, never their text. The words in a travelling value
 * are the page's own, drawn on the page.
 *
 * Drawn on someone else's page: one host element with a closed shadow root, pointer-events none, aria-hidden.
 * Styles are set as properties and motion uses the Web Animations API, which a page's Content-Security-Policy
 * doesn't block (a <style> element can be). With less motion asked for, or no animate(), nothing travels.
 */
/* global browser */
(function (root) {
  'use strict';
  if (root.__powerloaderGather) return;
  root.__powerloaderGather = true;

  const PAD = 4;
  const MAX_ROWS = 40;
  const FLY_MS = 620;
  const STAGGER_MS = 85;
  const STEP_IN_MS = 22;
  const IN_MS = 130; // every outline has started to draw by then, however many there are
  const BLUE = '#1d70b8';
  const GREEN = '#00703c';
  // A conflict is orange, never red: the edge 4:1 on white, the badge's white text 6.6:1 on its fill.
  const ORANGE = '#d55a00';
  const ORANGE_TEXT = '#a33c00';
  const still = () => !root.matchMedia || root.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const canAnimate = (el) => typeof el.animate === 'function' && !still();
  const noHash = (u) => String(u).split('#')[0];

  let host = null;
  let layer = null;
  let marks = []; // { key, el, box, tick }
  let shown = '';
  let watcher = null;
  let flags = {}; // { key: 'conflict' | … } what each value is to the case, from the sidebar, after a clip
  let held = null; // the key a conflict's link points at: outlined in orange until the outlines are cleared
  let rules = []; // the template's reveal rules (lib/extract.js validateReveal())
  let undo = []; // what revealing changed, put back when the outlines are cleared
  let fetchLayer = null; // the boxes a fetch step draws, and the strip they shrink to
  let boxes = new Map(); // request key → { el, body, title, slot, at }
  let strip = null;

  const set = (el, styles) => { for (const [k, v] of Object.entries(styles)) el.style.setProperty(k, v); };

  function ensureLayer() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.setAttribute('data-powerloader', 'values');
    host.setAttribute('aria-hidden', 'true');
    set(host, { position: 'absolute', top: '0', left: '0', width: '0', height: '0', 'z-index': '2147483646', 'pointer-events': 'none' });
    const shadow = host.attachShadow({ mode: 'closed' });
    layer = document.createElement('div');
    // The fetch boxes and their strip have a layer of their own, so outlining the page never clears them.
    fetchLayer = document.createElement('div');
    shadow.append(layer, fetchLayer);
    document.documentElement.append(host);
    marks = [];
    shown = '';
    // Boxes are placed in the document, not the window, and follow a page that grows or reflows.
    if (typeof root.ResizeObserver === 'function') {
      watcher = new root.ResizeObserver(() => { if (marks.length) place(); });
      watcher.observe(document.documentElement);
    }
  }

  /** The elements a field is read from: one for a value, each row for a list. A value typed into the template has none. */
  function elementsFor(spec) {
    const E = root.PowerLoaderExtract;
    if (!E) return [];
    try {
      if (Array.isArray(spec)) return typeof spec[0] === 'string' ? E.locate(document, spec[0]).slice(0, MAX_ROWS) : [];
      if (typeof spec !== 'string' || spec.startsWith('=')) return [];
      return E.locate(document, E.locatorOf(spec)).slice(0, 1);
    } catch { return []; }
  }

  // The value's own words where it has them, so a short value in a wide table cell is outlined, not the cell.
  function rectOf(el) {
    let r = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
    if (!/^(input|select|textarea|img)$/.test(el.localName) && typeof document.createRange === 'function') {
      try {
        const range = document.createRange();
        range.selectNodeContents(el);
        const t = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null;
        if (t && t.width > 0 && t.height > 0) r = t;
      } catch { /* no layout */ }
    }
    return r;
  }

  function place() {
    for (const m of marks) {
      const r = rectOf(m.el);
      set(m.box, {
        display: r.width === 0 && r.height === 0 ? 'none' : 'block',
        left: `${r.left + (root.scrollX || 0) - PAD}px`, top: `${r.top + (root.scrollY || 0) - PAD}px`,
        width: `${r.width + PAD * 2}px`, height: `${r.height + PAD * 2}px`,
      });
    }
  }

  // The badge on an outline: a green tick once clipped, or "⚠ Conflict" on orange. Never colour alone.
  function badge(m, kind) {
    m.tick.textContent = kind === 'conflict' ? '⚠ Conflict' : '✓';
    set(m.tick, kind === 'conflict'
      ? { display: 'block', width: 'auto', 'border-radius': '3px', background: ORANGE_TEXT, padding: '0 5px', top: '-11px', right: '-6px', 'white-space': 'nowrap' }
      : { display: kind ? 'block' : 'none', width: '16px', 'border-radius': '50%', background: GREEN, padding: '0', top: '-9px', right: '-9px' });
  }

  function look(m, state) {
    const done = state === 'done';
    const point = state === 'point';
    // A value in conflict, after its clip, or the one a conflict's link points at.
    const hold = held != null && m.key === held;
    const conflict = hold || (flags[m.key] === 'conflict' && state !== 'pending');
    set(m.box, {
      'border-color': point ? '#0b0c0c' : conflict ? ORANGE : done ? GREEN : BLUE, 'border-width': point || hold ? '3px' : '2px',
      'background-color': point ? 'rgba(255, 221, 0, .45)' : hold ? 'rgba(213, 90, 0, .22)' : conflict ? 'rgba(213, 90, 0, .12)' : done ? 'rgba(0, 112, 60, .10)' : 'rgba(29, 112, 184, .14)',
    });
    badge(m, conflict ? 'conflict' : done ? 'done' : null);
  }

  function clear() {
    if (watcher) { watcher.disconnect(); watcher = null; }
    if (host) host.remove();
    host = null;
    layer = null;
    marks = [];
    shown = '';
    flags = {};
    held = null;
    putBack();
    rules = [];
    fetchLayer = null;
    boxes = new Map();
    strip = null;
  }

  function makeBox() {
    const box = document.createElement('div');
    set(box, { position: 'absolute', 'box-sizing': 'border-box', 'border-style': 'solid', opacity: '0' });
    const tick = document.createElement('div');
    tick.textContent = '✓';
    set(tick, {
      position: 'absolute', top: '-9px', right: '-9px', width: '16px', height: '16px', 'border-radius': '50%', background: GREEN, color: '#fff',
      font: '700 11px/16px Arial, sans-serif', 'text-align': 'center', display: 'none',
    });
    box.append(tick);
    return { box, tick };
  }

  // ---------------------------------------------------------------- revealing a value out of sight

  // Without layout (jsdom), what has no size is judged from the markup: a closed <details>, a hidden
  // attribute or display: none on the way up.
  const hasLayout = () => { try { const r = document.documentElement.getBoundingClientRect(); return r.width > 0 || r.height > 0; } catch { return false; } };
  const hiddenByMarkup = (el) => {
    for (let a = el; a && a.nodeType === 1; a = a.parentElement) {
      if (a.hasAttribute('hidden')) return true;
      if (a.parentElement?.localName === 'details' && !a.parentElement.open && a.localName !== 'summary') return true;
      try { if (root.getComputedStyle?.(a).display === 'none') return true; } catch { /* no styles */ }
    }
    return false;
  };
  function sizeless(el) {
    if (!hasLayout()) return hiddenByMarkup(el);
    const r = rectOf(el);
    return r.width === 0 && r.height === 0;
  }

  /**
   * Bring a value with no size on the screen into view, as the template's reveal rules say and as plain HTML
   * allows: open a closed <details>, remove a hidden attribute, add or remove a rule's class names on the
   * elements its selector matches that contain the value. Nothing is clicked, no event is dispatched by Power
   * Loader and no style or other attribute is set. Each change is remembered and put back by clear(). True
   * when the value now has a size.
   */
  function reveal(el) {
    if (!sizeless(el)) return true;
    const ancestors = [];
    for (let a = el; a && a.nodeType === 1 && a !== document.documentElement; a = a.parentElement) ancestors.push(a);
    ancestors.forEach((a, i) => {
      // A value in the summary itself is already in view.
      if (a.localName === 'details' && !a.open && ancestors[i - 1]?.localName !== 'summary') { a.open = true; undo.push({ el: a, kind: 'open' }); }
      if (a.hasAttribute('hidden')) { undo.push({ el: a, kind: 'hidden', value: a.getAttribute('hidden') }); a.removeAttribute('hidden'); }
    });
    for (const rule of rules) {
      let targets = [];
      try { targets = [...document.querySelectorAll(rule.selector)]; } catch { continue; }
      for (const t of targets.filter((x) => x === el || x.contains(el))) {
        for (const name of rule.addClass || []) if (!t.classList.contains(name)) { t.classList.add(name); undo.push({ el: t, kind: 'add', name }); }
        for (const name of rule.removeClass || []) if (t.classList.contains(name)) { t.classList.remove(name); undo.push({ el: t, kind: 'remove', name }); }
        if (rule.open && t.localName === 'details' && !t.open) { t.open = true; undo.push({ el: t, kind: 'open' }); }
        if (rule.unhide && t.hasAttribute('hidden')) { undo.push({ el: t, kind: 'hidden', value: t.getAttribute('hidden') }); t.removeAttribute('hidden'); }
      }
    }
    return !sizeless(el);
  }

  // Put back what reveal() changed, newest first, and only where the page hasn't changed it again since.
  function putBack() {
    for (const u of undo.reverse()) {
      if (!u.el.isConnected) continue;
      if (u.kind === 'add' && u.el.classList.contains(u.name)) u.el.classList.remove(u.name);
      else if (u.kind === 'remove' && !u.el.classList.contains(u.name)) u.el.classList.add(u.name);
      else if (u.kind === 'open' && u.el.open) u.el.open = false;
      else if (u.kind === 'hidden' && !u.el.hasAttribute('hidden')) u.el.setAttribute('hidden', u.value || '');
    }
    undo = [];
  }

  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  /**
   * The name of the closed part a value is in, from its heading, so the sidebar can say "open Tenancy history
   * to see it": the summary of a closed <details>, the element that labels or controls the part (a tab, an
   * accordion's button), or the heading just before it. true when it has none.
   */
  function sectionName(el) {
    for (let a = el; a && a.nodeType === 1 && a !== document.body; a = a.parentElement) {
      const p = a.parentElement;
      if (p?.localName === 'details' && !p.open && a.localName !== 'summary') return clean(p.querySelector(':scope > summary')?.textContent) || true;
      if (!sizeless(a) || (p && sizeless(p))) continue;
      // a is the outermost part with no size: name it.
      const by = a.getAttribute('aria-labelledby');
      if (by) { const t = clean(by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ')); if (t) return t; }
      if (a.getAttribute('aria-label')) return clean(a.getAttribute('aria-label'));
      if (a.id) {
        const ctl = [...document.querySelectorAll('[aria-controls], a[href^="#"]')].find((x) => (x.getAttribute('aria-controls') || '').split(/\s+/).includes(a.id) || x.getAttribute('href') === `#${a.id}`);
        if (ctl && clean(ctl.textContent)) return clean(ctl.textContent);
      }
      // The heading just before it, or before the element it is in (an accordion's section), two levels up.
      for (let x = a, up = 0; x && x !== document.body && up < 3; x = x.parentElement, up++) {
        for (let s = x.previousElementSibling; s; s = s.previousElementSibling) {
          const head = /^h[1-6]$/.test(s.localName) || s.getAttribute('role') === 'heading' ? s : s.querySelector?.('h1, h2, h3, h4, h5, h6, [role=heading], button');
          if (head && clean(head.textContent)) return clean(head.textContent);
        }
      }
      return true;
    }
    return true;
  }

  // ---------------------------------------------------------------- recording a reveal rule, in Build

  let before = null; // { el, name, parts: [{ el, classes: Set, open, hidden }] } while the author opens a part by hand
  const TOKEN = /^-?[A-Za-z_][A-Za-z0-9_-]{0,99}$/;
  const esc = (s) => (root.CSS?.escape ? root.CSS.escape(s) : String(s).replace(/[^\w-]/g, (c) => `\\${c}`));
  const unique = (sel) => { try { return document.querySelectorAll(sel).length === 1; } catch { return false; } };
  const stateOf = (a) => ({ el: a, classes: new Set(a.classList), open: a.localName === 'details' ? !!a.open : null, hidden: a.hasAttribute('hidden') });

  // A selector for an element of the page, without the class names that open or close it (skip).
  function selectorOf(el, skip) {
    if (el.id && unique(`#${esc(el.id)}`)) return `#${esc(el.id)}`;
    const parts = [];
    for (let cur = el; cur && cur.nodeType === 1 && cur !== document.documentElement; cur = cur.parentElement) {
      if (cur !== el && cur.id && unique(`#${esc(cur.id)}`)) { parts.unshift(`#${esc(cur.id)}`); break; }
      let s = cur.localName + [...cur.classList].filter((c) => !skip.has(c) && TOKEN.test(c)).slice(0, 2).map((c) => `.${esc(c)}`).join('');
      const same = cur.parentElement ? [...cur.parentElement.children].filter((x) => x.localName === cur.localName) : [];
      if (same.length > 1 && cur.parentElement.querySelectorAll(`:scope > ${s}`).length > 1) s += `:nth-of-type(${same.indexOf(cur) + 1})`;
      parts.unshift(s);
      if (unique(parts.join(' > '))) break;
    }
    return parts.join(' > ');
  }

  /**
   * Build: the author says a value is in a closed part of the page. Remember the class names, open and hidden
   * of the value and every element it is in, so that after they open the part by hand the difference can be
   * offered as a reveal rule. Reads class names only; changes nothing.
   */
  function recordBefore(spec) {
    const el = elementsFor(spec)[0];
    if (!el) return { found: false };
    const parts = [];
    for (let a = el; a && a.nodeType === 1 && a !== document.documentElement; a = a.parentElement) parts.push(stateOf(a));
    before = { el, name: sizeless(el) ? sectionName(el) : null, parts };
    return { found: true, hidden: sizeless(el) };
  }

  /** The difference since recordBefore(), as reveal rules, and whether the value is in view now. */
  function recordAfter() {
    if (!before || !before.el.isConnected) { before = null; return { found: false, rules: [] }; }
    const rules = [];
    for (const b of before.parts) {
      const now = stateOf(b.el);
      const addClass = [...now.classes].filter((c) => !b.classes.has(c) && TOKEN.test(c)).slice(0, 10);
      const removeClass = [...b.classes].filter((c) => !now.classes.has(c) && TOKEN.test(c)).slice(0, 10);
      const open = b.open === false && now.open === true;
      const unhide = b.hidden && !now.hidden;
      if (!addClass.length && !removeClass.length && !open && !unhide) continue;
      rules.push({ selector: selectorOf(b.el, new Set([...addClass, ...removeClass])), ...(addClass.length ? { addClass } : {}), ...(removeClass.length ? { removeClass } : {}), ...(open ? { open: true } : {}), ...(unhide ? { unhide: true } : {}) });
    }
    const out = { found: true, shown: !sizeless(before.el), name: before.name === true ? null : before.name, rules: rules.slice(0, 5) };
    before = null;
    return out;
  }

  /** The values with no size even after revealing, by key: the name of the closed part each is in. */
  function closedParts() {
    const out = {};
    for (const m of marks) if (!(m.key in out) && sizeless(m.el)) out[m.key] = sectionName(m.el);
    return out;
  }

  function show(fields, state, { flags: f = null, reveal: r = null } = {}) {
    ensureLayer();
    if (f && typeof f === 'object') flags = f;
    // A held conflict that has been decided is let go: it isn't a conflict any more.
    if (f && held != null && f[held] !== 'conflict') held = null;
    // Only rules that pass the template's own check are used, whatever the message carries.
    const check = root.PowerLoaderExtract?.validateReveal;
    if (Array.isArray(r)) rules = r.slice(0, 20).filter((x) => check && !check([x]).length);
    const sig = JSON.stringify(fields);
    let shownIn = 0;
    if (sig !== shown) {
      layer.replaceChildren();
      marks = [];
      for (const [key, spec] of Object.entries(fields || {})) {
        if (key.startsWith('@')) continue;
        for (const el of elementsFor(spec)) {
          const { box, tick } = makeBox();
          layer.append(box);
          marks.push({ key, el, box, tick });
        }
      }
      shown = sig;
      // A value the template reads that is out of sight (a closed accordion, a tab not chosen) is brought into
      // view when it safely can be, so its outline is on it.
      for (const m of marks) reveal(m.el);
      place();
      // Top to bottom, a few at a time, all within about 150 ms however many there are.
      marks.forEach((m, i) => {
        const delay = still() ? 0 : Math.min(i * STEP_IN_MS, IN_MS);
        if (canAnimate(m.box)) {
          m.box.animate([{ opacity: 0, transform: 'scale(1.12)' }, { opacity: 1, transform: 'none' }], { duration: 200, delay, easing: 'cubic-bezier(.2, .8, .3, 1)', fill: 'forwards' });
        } else m.box.style.setProperty('opacity', '1');
      });
      shownIn = still() ? 0 : Math.min(marks.length * STEP_IN_MS, IN_MS) + 180;
    }
    for (const m of marks) look(m, state === 'done' ? 'done' : 'pending');
    host.setAttribute('data-shown', String(marks.length));
    host.setAttribute('data-state', state === 'done' ? 'done' : 'pending');
    // shownIn: how long until every outline is drawn, so an automatic clip can wait for them. closed: the values
    // still out of sight, each with the name of the part to open (a heading, never a value), when there are any.
    const closed = closedParts();
    return { found: [...new Set(marks.map((m) => m.key))], shownIn, ...(Object.keys(closed).length ? { closed } : {}) };
  }

  const textOf = (el) => String(/^(input|select|textarea)$/.test(el.localName) ? el.value : el.textContent).replace(/\s+/g, ' ').trim().slice(0, 60);
  const screenX = () => (typeof root.mozInnerScreenX === 'number' && root.mozInnerScreenX ? root.mozInnerScreenX : null);
  const screenY = () => (typeof root.mozInnerScreenY === 'number' && root.mozInnerScreenY ? root.mozInnerScreenY : null);

  /**
   * The values travel to the sidebar: one chip a field, from where the value is to the edge of the page the
   * sidebar is on, heading for that field's row in it (targets: field → the row's height on the screen).
   * Returns when each will cross the edge, so the sidebar can carry it on from there. Without the window's
   * place on the screen (resistFingerprinting zeroes it), the values leave to the left, Firefox's default side.
   */
  function gather(fields, sidebar, targets) {
    if (!marks.length) show(fields, 'pending');
    const myX = screenX();
    const myY = screenY();
    const toLeft = !(sidebar && myX != null && typeof sidebar.x === 'number' && sidebar.x > myX);
    const first = new Map();
    for (const m of marks) if (!first.has(m.key)) first.set(m.key, { m, n: 0 });
    for (const m of marks) first.get(m.key).n++;
    const out = [];
    let i = 0;
    const travel = !still();
    for (const [key, { m, n }] of first) {
      const delay = travel ? i++ * STAGGER_MS : 0;
      const r = rectOf(m.el);
      const top = Math.min(Math.max(r.top, 0), (root.innerHeight || 0) - 24);
      const targetY = targets && typeof targets[key] === 'number' && myY != null ? targets[key] - myY : top;
      out.push({ key, at: delay + (travel ? FLY_MS : 0), y: myY != null ? targetY + myY : null });
      const land = () => { for (const x of marks) if (x.key === key) look(x, 'done'); };
      if (!travel || typeof m.box.animate !== 'function') { land(); continue; }
      setTimeout(() => {
        land();
        m.box.animate([{ boxShadow: '0 0 0 6px rgba(29, 112, 184, .25)' }, { boxShadow: '0 0 0 0 rgba(29, 112, 184, 0)' }], { duration: 500, easing: 'ease-out' });
        const chip = document.createElement('div');
        chip.textContent = n > 1 ? `${n} rows` : textOf(m.el) || key;
        set(chip, {
          position: 'fixed', 'box-sizing': 'border-box', 'max-width': '320px', padding: '2px 8px', background: BLUE, color: '#fff', 'white-space': 'nowrap', overflow: 'hidden',
          'text-overflow': 'ellipsis', font: '700 13px/1.5 "Helvetica Neue", Helvetica, Arial, sans-serif', 'box-shadow': '0 2px 8px rgba(11, 12, 12, .3)',
          left: `${Math.max(r.left - PAD, 0)}px`, top: `${top - 2}px`,
        });
        layer?.append(chip);
        const w = chip.getBoundingClientRect().width;
        const dx = toLeft ? -(Math.max(r.left - PAD, 0) + w + 4) : (root.innerWidth || 0) - Math.max(r.left - PAD, 0) + 4;
        const dy = targetY - top;
        chip.animate([
          { transform: 'translate(0, 0) scale(1)', opacity: 0 },
          { transform: 'translate(0, -6px) scale(1.06)', opacity: 1, offset: 0.18 },
          { transform: `translate(${dx}px, ${dy}px) scale(.94)`, opacity: 1 },
        ], { duration: FLY_MS, easing: 'cubic-bezier(.55, 0, .3, 1)', fill: 'forwards' }).finished.then(() => chip.remove(), () => chip.remove());
      }, delay);
    }
    host?.setAttribute('data-state', 'done');
    return { toLeft, items: out };
  }

  /**
   * Mark one field's value. Pointing at its row only marks it; choosing the row (scroll) also brings it into
   * view, opening the part it is in if it has to (reveal()). hold: a conflict's link points at it, so it stays
   * outlined in orange with ⚠ until the outlines are cleared, and the answer says whether it is on the page
   * and, if it is still out of sight, the part to open: { found, closed? }.
   */
  function point(key, scroll, hold = false) {
    let seen = null;
    if (hold) { held = key; host?.setAttribute('data-held', String(key)); }
    const done = host?.getAttribute('data-state') === 'done';
    for (const m of marks) {
      const on = key != null && m.key === key;
      if (on && !seen) {
        seen = m;
        if (scroll || hold) { reveal(m.el); place(); }
        if ((scroll || hold) && typeof m.el.scrollIntoView === 'function') m.el.scrollIntoView({ block: 'center', behavior: still() ? 'auto' : 'smooth' });
      }
      look(m, on && !hold ? 'point' : done ? 'done' : 'pending');
    }
    if (hold && seen && canAnimate(seen.box)) seen.box.animate([{ boxShadow: '0 0 0 10px rgba(213, 90, 0, .45)' }, { boxShadow: '0 0 0 0 rgba(213, 90, 0, 0)' }], { duration: 900, iterations: 2, easing: 'ease-out' });
    if (!hold) return !!seen;
    if (!seen) held = null;
    const out = { found: !!seen };
    if (seen && sizeless(seen.el)) out.closed = sectionName(seen.el);
    return out;
  }

  // ---------------------------------------------------------------- a fetch step's boxes

  /*
   * While a fetch step runs, each request has a box on the trigger page: titled with what is read, showing the
   * response as TEXT (lines the sidebar made with lib/fetch-view.js; never its markup, images, styles or links),
   * with the values the template reads outlined. The box scrolls to each value in turn (programmatically: the
   * layer takes no pointer events) and the value lifts off towards the sidebar. Done, it shrinks to a line in a
   * strip along the bottom of the page. At most four boxes at once.
   */
  const BOX_W = 380;
  const BOX_H = 196;
  const MAX_BOXES = 4;
  const AMBER = '#f47738';
  const BOX_FONT = '12px/1.45 ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", monospace';
  const UI_FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (t) => document.createTextNode(String(t ?? ''));
  const div = (styles, ...kids) => { const el = document.createElement('div'); set(el, styles); el.append(...kids); return el; };

  // Where the open boxes go: two columns, two rows, in the bottom right corner above the strip.
  function slotBoxes() {
    const w = Math.min(BOX_W, Math.max(220, ((root.innerWidth || 1024) - 48) / 2));
    [...boxes.values()].filter((b) => !b.gone).forEach((b, i) => {
      set(b.el, { width: `${w}px`, right: `${16 + (i % 2) * (w + 10)}px`, bottom: `${48 + Math.floor(i / 2) * (BOX_H + 10)}px` });
    });
  }

  function openBox({ id, title, address }) {
    ensureLayer();
    if (boxes.has(id)) return true;
    // A fifth request: the oldest box goes to the strip as it is, so no more than four are open.
    const open = [...boxes.values()].filter((b) => !b.gone);
    if (open.length >= MAX_BOXES) collapse(open[0], open[0].line ? { line: open[0].line, kind: open[0].kind } : { line: `${open[0].title}: reading`, kind: 'wait' });
    const head = div({ background: BLUE, color: '#fff', font: `700 12px/1.4 ${UI_FONT}`, padding: '4px 8px', 'white-space': 'nowrap', overflow: 'hidden', 'text-overflow': 'ellipsis' }, text(`Power Loader is reading ${title}`));
    const where = div({ color: '#505a5f', font: `11px/1.4 ${UI_FONT}`, padding: '2px 8px', 'white-space': 'nowrap', overflow: 'hidden', 'text-overflow': 'ellipsis', 'border-bottom': '1px solid #b1b4b6' }, text(address || ''));
    const body = div({ position: 'relative', height: `${BOX_H - 46}px`, overflow: 'hidden', padding: '4px 8px', font: BOX_FONT, color: '#0b0c0c', background: '#fff' }, div({ color: '#505a5f', font: `italic 12px/1.4 ${UI_FONT}` }, text('Fetching…')));
    const el = div({ position: 'fixed', height: `${BOX_H}px`, background: '#fff', border: `2px solid ${BLUE}`, 'box-sizing': 'border-box', 'box-shadow': '0 4px 16px rgba(11, 12, 12, .3)', overflow: 'hidden', opacity: '0' }, head, where, body);
    fetchLayer.append(el);
    const b = { id, el, head, body, title, at: Date.now() };
    boxes.set(id, b);
    slotBoxes();
    if (canAnimate(el)) el.animate([{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'ease-out', fill: 'forwards' });
    else el.style.setProperty('opacity', '1');
    host.setAttribute('data-fetch-boxes', String(boxes.size));
    return true;
  }

  // A line of the response with its values outlined: plain text nodes around spans, nothing from the response's markup.
  function lineEl(row, marksHere) {
    if (row.gap) return div({ color: '#505a5f', 'text-align': 'center' }, text('⋯'));
    const el = div({ 'white-space': 'pre-wrap', 'overflow-wrap': 'anywhere', 'min-height': '1.45em' });
    const spans = [];
    let at = 0;
    for (const m of [...marksHere].sort((a, b) => a.start - b.start)) {
      const start = Math.max(m.start, 0);
      const end = Math.min(m.end, row.text.length);
      const same = spans.find((s) => s.start === start && s.end === end);
      if (same) { same.marks.push(m); continue; }
      if (start < at || end <= start) continue;
      el.append(text(row.text.slice(at, start)));
      const span = document.createElement('span');
      span.append(text(row.text.slice(start, end)));
      set(span, { outline: `2px solid ${BLUE}`, 'outline-offset': '1px', background: 'rgba(29, 112, 184, .14)' });
      el.append(span);
      spans.push({ span, start, end, marks: [m] });
      at = end;
    }
    el.append(text(row.text.slice(at)));
    return { el, spans };
  }

  // A value lifts off the box and travels to the sidebar, as a clip's values do.
  function fly(rect, words, targetY, toLeft, colour) {
    const chip = div({
      position: 'fixed', 'box-sizing': 'border-box', 'max-width': '280px', padding: '2px 8px', background: colour, color: '#fff', 'white-space': 'nowrap', overflow: 'hidden',
      'text-overflow': 'ellipsis', font: `700 13px/1.5 ${UI_FONT}`, 'box-shadow': '0 2px 8px rgba(11, 12, 12, .3)', left: `${Math.max(rect.left, 0)}px`, top: `${rect.top - 2}px`,
    }, text(words));
    fetchLayer?.append(chip);
    const w = chip.getBoundingClientRect().width;
    const dx = toLeft ? -(Math.max(rect.left, 0) + w + 4) : (root.innerWidth || 0) - Math.max(rect.left, 0) + 4;
    const dy = (targetY ?? rect.top) - rect.top;
    chip.animate([
      { transform: 'translate(0, 0) scale(1)', opacity: 0 },
      { transform: 'translate(0, -6px) scale(1.06)', opacity: 1, offset: 0.18 },
      { transform: `translate(${dx}px, ${dy}px) scale(.94)`, opacity: 1 },
    ], { duration: FLY_MS, easing: 'cubic-bezier(.55, 0, .3, 1)', fill: 'forwards' }).finished.then(() => chip.remove(), () => chip.remove());
  }

  /**
   * The response has been read: its lines, with each value outlined, then scrolled to and sent on its way one
   * at a time; then the box shrinks to its line in the strip. rows/marks: lib/fetch-view.js boxLines();
   * marks carry { key, label, state: 'done' | 'conflict' }. line: what the strip says. targetY: the request's
   * row in the sidebar, on the screen.
   */
  function readBox({ id, rows = [], marks: ms = [], line = '', sidebar = null, targetY = null, conflict = false }) {
    const b = boxes.get(id);
    if (!b) return false;
    b.line = line;
    b.kind = conflict ? 'conflict' : 'done';
    // Already shrunk to the strip to make room: its line there says what was read.
    if (b.gone) { stripLine(b, { line, kind: b.kind }); return { shown: 0 }; }
    b.head.firstChild.data = `Power Loader read ${b.title}`;
    const spans = [];
    const lines = rows.slice(0, 600).map((row, i) => {
      const got = lineEl(row, ms.filter((m) => m.line === i));
      if (got.spans) spans.push(...got.spans);
      return got.el || got;
    });
    b.body.replaceChildren(...lines);
    if (!rows.length) b.body.replaceChildren(div({ color: '#505a5f', font: `italic 12px/1.4 ${UI_FONT}` }, text('Read')));
    void play(b, spans, { line, sidebar, targetY, conflict });
    return { shown: spans.length };
  }

  async function play(b, spans, { line, sidebar, targetY, conflict }) {
    const myX = screenX();
    const myY = screenY();
    const toLeft = !(sidebar && myX != null && typeof sidebar.x === 'number' && sidebar.x > myX);
    const y = targetY != null && myY != null ? targetY - myY : null;
    const mark = (s) => {
      const bad = s.marks.some((m) => m.state === 'conflict');
      set(s.span, { outline: `2px solid ${bad ? ORANGE : GREEN}`, background: bad ? 'rgba(213, 90, 0, .16)' : 'rgba(0, 112, 60, .12)' });
      if (bad && !s.warned) { s.warned = true; const w = document.createElement('b'); w.append(text('⚠ ')); set(w, { color: ORANGE_TEXT }); s.span.before(w); }
    };
    if (still()) spans.forEach(mark);
    else {
      for (const s of spans) {
        if (b.gone) return;
        // A value further down than the box shows: the box scrolls to it, where it sits in the response.
        const top = s.span.offsetTop - b.body.clientHeight / 2;
        if (typeof b.body.scrollTo === 'function') b.body.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
        await wait(260);
        mark(s);
        if (typeof s.span.animate === 'function') s.span.animate([{ boxShadow: '0 0 0 6px rgba(29, 112, 184, .3)' }, { boxShadow: '0 0 0 0 rgba(29, 112, 184, 0)' }], { duration: 450, easing: 'ease-out' });
        const r = s.span.getBoundingClientRect();
        if (r.width && r.height) fly(r, s.marks[0].label || s.span.textContent.slice(0, 40), y, toLeft, s.marks.some((m) => m.state === 'conflict') ? ORANGE_TEXT : BLUE);
        await wait(STAGGER_MS * 3);
      }
    }
    await wait(still() ? 1400 : 900);
    collapse(b, { line, kind: conflict ? 'conflict' : 'done' });
  }

  function failBox({ id, line = '' }) {
    const b = boxes.get(id);
    if (!b) return false;
    Object.assign(b, { line: `${b.title}: ${line}`, kind: 'fail' });
    if (b.gone) { stripLine(b, b); return true; }
    set(b.el, { 'border-color': AMBER });
    set(b.head, { background: AMBER, color: '#0b0c0c' });
    b.head.firstChild.data = `Couldn’t read ${b.title}`;
    b.body.replaceChildren(div({ font: `12px/1.4 ${UI_FONT}` }, text(line)));
    setTimeout(() => collapse(b, b), still() ? 1400 : 1100);
    return true;
  }

  // The box becomes a line in the strip along the bottom of the page: what it read, or why it couldn't.
  function collapse(b, { line, kind }) {
    if (b.gone || !fetchLayer) return;
    b.gone = true;
    const done = () => { b.el.remove(); slotBoxes(); };
    if (canAnimate(b.el)) b.el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(30px) scale(.9)' }], { duration: 220, easing: 'ease-in', fill: 'forwards' }).finished.then(done, done);
    else done();
    slotBoxes();
    stripLine(b, { line, kind });
  }

  // A request's line in the strip: added, or brought up to date when it was shrunk before it had been read.
  function stripLine(b, { line, kind }) {
    if (!fetchLayer) return;
    if (!strip || !strip.isConnected) {
      strip = div({ position: 'fixed', left: '12px', right: '12px', bottom: '8px', display: 'flex', 'flex-wrap': 'wrap', gap: '4px 6px', 'align-items': 'center', 'justify-content': 'flex-end', font: `12px/1.4 ${UI_FONT}` },
        div({ background: '#0b0c0c', color: '#fff', padding: '2px 8px', 'font-weight': '700' }, text('Power Loader fetched')));
      fetchLayer.append(strip);
    }
    const icon = { done: '✓ ', conflict: '⚠ ', fail: '✕ ', wait: '… ' }[kind] || '';
    const item = b.item?.isConnected ? b.item : div({});
    item.textContent = `${icon}${line}`;
    set(item, {
      padding: '2px 8px', 'max-width': '360px', 'white-space': 'nowrap', overflow: 'hidden', 'text-overflow': 'ellipsis', 'box-shadow': '0 1px 4px rgba(11, 12, 12, .25)',
      background: kind === 'fail' ? '#fff7bf' : '#fff', color: kind === 'conflict' ? ORANGE_TEXT : kind === 'fail' ? '#594d00' : '#0b0c0c',
      border: `2px solid ${kind === 'fail' ? AMBER : kind === 'conflict' ? ORANGE : kind === 'wait' ? BLUE : GREEN}`, 'font-weight': kind === 'conflict' ? '700' : '400',
    });
    if (item === b.item) return;
    b.item = item;
    strip.append(item);
    host?.setAttribute('data-fetch-strip', String(strip.children.length - 1));
    // A step that reads 25 pages: the last eight, and how many before them.
    const items = [...strip.children].slice(1).filter((x) => !x.hasAttribute('data-more'));
    const more = strip.querySelector('[data-more]');
    if (items.length > 8) {
      items.slice(0, items.length - 8).forEach((x) => x.remove());
      const n = Number(more?.getAttribute('data-more') || 0) + items.length - 8;
      const m = more || div({ color: '#505a5f', padding: '2px 4px' });
      m.setAttribute('data-more', String(n));
      m.textContent = `and ${n} more`;
      if (!more) strip.children[0].after(m);
    }
  }

  function fetchBox(msg) {
    if (msg.op === 'open') return openBox(msg);
    if (msg.op === 'read') return readBox(msg);
    if (msg.op === 'fail') return failBox(msg);
    return false;
  }

  root.addEventListener?.('resize', () => { if (marks.length) place(); });

  root.PowerLoaderGather = { show, gather, point, clear };
  if (!root.browser?.runtime?.onMessage) return;
  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg.type !== 'string' || !/^powerloader:(showValues|gatherValues|pointValue|clearValues|revealBefore|revealAfter|fetchBox)$/.test(msg.type)) return undefined;
    // As the agent does: the sidebar checked the site rules for atUrl, so a page that has moved on isn't drawn on.
    if (msg.type !== 'powerloader:clearValues' && noHash(msg.atUrl) !== noHash(location.href)) return Promise.reject(new Error('The page changed: try again.'));
    switch (msg.type) {
      case 'powerloader:showValues': return Promise.resolve(show(msg.fields, msg.state, { flags: msg.flags, reveal: msg.reveal }));
      case 'powerloader:gatherValues': return Promise.resolve(gather(msg.fields, msg.sidebar, msg.targets));
      case 'powerloader:pointValue': return Promise.resolve(point(msg.key, !!msg.scroll, !!msg.hold));
      case 'powerloader:clearValues': clear(); return Promise.resolve(true);
      case 'powerloader:revealBefore': return Promise.resolve(recordBefore(msg.spec));
      case 'powerloader:revealAfter': return Promise.resolve(recordAfter());
      case 'powerloader:fetchBox': return Promise.resolve(fetchBox(msg));
      default: return undefined;
    }
  });
})(globalThis);

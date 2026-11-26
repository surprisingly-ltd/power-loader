// Notes a flow adds to a web page: at a selector, expanded (a panel with the note) or compact (a marker that
// opens it), with a style override and content in a small, safe subset of HTML. {ref} and {fieldKey} in the
// content are filled from the case. Pure functions, no browser APIs.
//
// Annotation  { id, selector, type: 'expanded' | 'compact', style, html }
// Marker      { id, at: { row, attr, value }, type: 'marker', style, nodes: [text] }: a fetch step's marker on
//             each row of its page that a run's results picked (journey.js Show's mark). Its text is fixed
//             by the flow; the value is only compared with the row's attribute, never put in the page.
//   selector  the extraction DSL's locator (CSS, label(…), or both): the note goes next to what it finds
//   style     CSS declarations for the note, limited to how it looks: color, background, borders, fonts…
//   html      <b> <strong> <i> <em> <u> <s> <br> <p> <div> <span> <ul> <ol> <li> <code> <small> <h3> <h4> <hr>
//             and <a href> (http, https or mailto). No other tags or attributes. Case values are text: they
//             are never read as HTML.
//
// The page never gets HTML: markup is parsed here into a tree of { tag, href?, children } and strings, and
// the in-page agent builds it with createElement and text nodes. So a value, or a mistake in the markup,
// can't run script or add an attribute. A link's scheme and host are written out: a {name} can only go in
// its path or query, so a case value can't send it to another site.
import { literalOrigin } from './access.js';

const templateVars = (tpl) => [...new Set([...String(tpl || '').matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((m) => m[1]))];

export const ANNOTATION_TYPES = { expanded: 'Expanded: the note shown in full', compact: 'Compact: a marker that opens the note' };
export const LIMITS = Object.freeze({ perStep: 20, html: 4000, style: 500, selector: 300 });

const TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'br', 'p', 'div', 'span', 'ul', 'ol', 'li', 'code', 'small', 'h3', 'h4', 'hr', 'a']);
const VOID = new Set(['br', 'hr']);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ------------------------------------------------------------------ style

// What a note's style can change: how it looks, never where it is or what it loads.
const PROPS = new Set([
  'color', 'background-color', 'background', 'font-weight', 'font-style', 'font-size', 'font-family', 'text-decoration', 'text-transform', 'text-align', 'line-height',
  'border', 'border-color', 'border-width', 'border-style', 'border-left', 'border-right', 'border-top', 'border-bottom', 'border-radius', 'border-left-color', 'border-left-width',
  'padding', 'padding-left', 'padding-right', 'padding-top', 'padding-bottom', 'margin', 'margin-left', 'margin-right', 'margin-top', 'margin-bottom',
  'width', 'max-width', 'min-width', 'outline', 'box-shadow', 'opacity', 'white-space', 'letter-spacing',
]);
// No url() (it would load something), no expression(), no escapes or comments that could hide either.
const BAD_VALUE = /url\s*\(|expression\s*\(|image-set|image\s*\(|element\s*\(|var\s*\(|attr\s*\(|[\\<>{}@]|\/\*|!\s*important/i;

export const STYLE_PRESETS = {
  '': 'Power Loader’s own look',
  'color:#d4351c;font-weight:bold;border-left-color:#d4351c': 'Red and bold: a warning',
  'background-color:#fff7bf;border-left-color:#ffdd00': 'Yellow: something to check',
  'color:#00703c;border-left-color:#00703c': 'Green: all is well',
  'font-size:12px;color:#505a5f;border-left-color:#b1b4b6': 'Small and grey: a quiet hint',
};

/** A style override, cleaned: { style: 'prop:value;…', errors: [text] }. Anything not allowed is dropped. */
export function cleanStyle(css) {
  const errors = [];
  const out = [];
  const text = String(css || '');
  if (text.length > LIMITS.style) errors.push(`the style is over ${LIMITS.style} characters`);
  for (const decl of text.slice(0, LIMITS.style).split(';')) {
    if (!decl.trim()) continue;
    const i = decl.indexOf(':');
    const prop = (i < 0 ? decl : decl.slice(0, i)).trim().toLowerCase();
    const value = i < 0 ? '' : decl.slice(i + 1).trim();
    if (!PROPS.has(prop)) { errors.push(`“${prop.slice(0, 40)}” can’t be set in a note’s style`); continue; }
    if (!value || BAD_VALUE.test(value) || value.length > 120) { errors.push(`the value of ${prop} isn’t allowed`); continue; }
    out.push(`${prop}:${value}`);
  }
  return { style: out.join(';'), errors };
}

// ------------------------------------------------------------------ content

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', pound: '£', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') {
    const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
  }
  return ENTITIES[e.toLowerCase()] ?? m;
});

const HREF = /^(https?:\/\/|mailto:)/i;
// A web link's site has no {name} in it. A mailto: link's address is one the author wrote, or a value
// (encoded, so it can't add a recipient or a header).
const hrefOk = (href) => HREF.test(href) && (/^mailto:/i.test(href) || literalOrigin(href));

/**
 * Parse a note's markup into a tree: [string | { tag, href?, children }]. Unknown tags and attributes are
 * reported and dropped (their text is kept); unclosed tags are closed at the end. { nodes, errors }.
 */
export function parseMarkup(html) {
  const errors = [];
  const src = String(html || '');
  if (src.length > LIMITS.html) errors.push(`the note is over ${LIMITS.html} characters`);
  const top = { tag: '#root', children: [] };
  const stack = [top];
  const cur = () => stack[stack.length - 1];
  const re = /<!--[\s\S]*?-->|<\/?([A-Za-z][A-Za-z0-9]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"'][^\s>]*))?)*)\s*\/?>|[^<]+|</g;
  let m;
  // What's inside a script or style element is code, not words: none of it is kept.
  const text = src.slice(0, LIMITS.html).replace(/<(script|style|template|iframe|object|svg|math)\b[\s\S]*?(<\/\1\s*>|$)/gi, (all, t) => { errors.push(`<${t.toLowerCase()}> isn’t allowed in a note`); return ''; });
  while ((m = re.exec(text))) {
    const tok = m[0];
    if (tok.startsWith('<!--')) continue;
    if (!m[1]) { cur().children.push(decode(tok)); continue; }
    const tag = m[1].toLowerCase();
    const closing = tok.startsWith('</');
    if (!TAGS.has(tag)) { errors.push(`<${tag}> isn’t allowed in a note`); continue; }
    if (closing) {
      const at = stack.map((n) => n.tag).lastIndexOf(tag);
      if (at > 0) stack.length = at;
      continue;
    }
    // As in HTML, a new list item or paragraph closes the one still open.
    if (tag === 'li' || tag === 'p') {
      const at = stack.map((n) => n.tag).lastIndexOf(tag);
      const list = Math.max(stack.map((n) => n.tag).lastIndexOf('ul'), stack.map((n) => n.tag).lastIndexOf('ol'));
      if (at > 0 && (tag === 'p' || at > list)) stack.length = at;
    }
    const node = { tag, children: [] };
    for (const a of (m[2] || '').matchAll(/([^\s=>/]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g)) {
      const name = a[1].toLowerCase();
      const value = decode((a[2] || '').replace(/^["']|["']$/g, '')).trim();
      if (tag === 'a' && name === 'href') {
        if (hrefOk(value)) node.href = value.slice(0, 2000);
        else if (HREF.test(value)) errors.push('a link in a note must have its site written out: a {name} can go in the path or query, not before the first /');
        else errors.push('a link in a note must start https://, http:// or mailto:');
      } else errors.push(`the attribute ${name} isn’t allowed in a note`);
    }
    cur().children.push(node);
    if (!VOID.has(tag) && !tok.endsWith('/>')) stack.push(node);
  }
  return { nodes: top.children, errors: [...new Set(errors)] };
}

const textOf = (nodes) => nodes.map((n) => (typeof n === 'string' ? n : `${n.href || ''} ${textOf(n.children)}`)).join(' ');

/** Every {name} a note uses, in its text and its links. */
export const noteVars = (a) => templateVars(textOf(parseMarkup(a?.html).nodes));

/**
 * The note's tree with {name}s filled in from vars. A value is text, and goes in as text. A name with no
 * value is shown as missing(name) (for the caseworker: "not in the case yet"; in the editor: the field's
 * name). A link whose filled address isn't http, https or mailto loses its address.
 */
export function fillNote(nodes, vars, missing = (k) => `[${k}]`) {
  const fill = (s) => String(s).replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (all, k) => (vars[k] != null && vars[k] !== '' ? String(vars[k]) : missing(k)));
  const walk = (n) => {
    if (typeof n === 'string') return fill(n);
    const out = { tag: n.tag, children: n.children.map(walk) };
    if (n.href && hrefOk(n.href)) {
      const href = n.href.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (all, k) => (vars[k] != null && vars[k] !== '' ? encodeURIComponent(vars[k]) : ''));
      if (/^(https?:\/\/[^/\s]+|mailto:)/i.test(href) && !/\{/.test(href)) out.href = href;
    }
    return out;
  };
  return nodes.map(walk);
}

// ------------------------------------------------------------------ checks

/** Problems with a step's notes. fields: the flow's or library's fields. */
export function annotationErrors(list, fields = {}) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) return ['"annotations" must be a list'];
  const out = [];
  if (list.length > LIMITS.perStep) out.push(`a step has at most ${LIMITS.perStep} notes`);
  const ids = new Set();
  list.forEach((a, i) => {
    const at = `note ${i + 1}`;
    if (!isObj(a)) { out.push(`${at} must be an object`); return; }
    if (typeof a.id !== 'string' || !a.id || ids.has(a.id)) out.push(`${at}: "id" must be a unique string`);
    ids.add(a.id);
    if (typeof a.selector !== 'string' || !a.selector.trim()) out.push(`${at} needs a place on the page (a selector)`);
    else if (a.selector.length > LIMITS.selector) out.push(`${at}: its selector is over ${LIMITS.selector} characters`);
    else if (globalThis.PowerLoaderExtract) { try { globalThis.PowerLoaderExtract.parseLocator(a.selector); } catch { out.push(`${at}: its selector can’t be read`); } }
    if (!ANNOTATION_TYPES[a.type]) out.push(`${at}: "type" must be expanded or compact`);
    if (a.style !== undefined && typeof a.style !== 'string') out.push(`${at}: "style" must be text`);
    else for (const e of cleanStyle(a.style).errors) out.push(`${at}: ${e}`);
    if (typeof a.html !== 'string' || !a.html.trim()) out.push(`${at} has nothing in it`);
    else {
      for (const e of parseMarkup(a.html).errors) out.push(`${at}: ${e}`);
      const unknown = noteVars(a).filter((v) => v !== 'ref' && !fields[v]);
      if (unknown.length) out.push(`${at} uses ${unknown.map((v) => `{${v}}`).join(', ')}, which ${unknown.length === 1 ? 'isn’t a field' : 'aren’t fields'}`);
    }
  });
  return out;
}

/**
 * Every web link in the notes checked as an opening: opening a link is "navigate" in the site rules, as
 * every step link and "Go to" is. A link the rules block keeps its words and loses its address, so a note
 * can't send the caseworker, with case values in the address, where the rules don't allow.
 * mayOpen(url) → boolean. Mailto links are left as they are: they open the caseworker's own email app.
 */
export function guardNoteLinks(notes, mayOpen) {
  const walk = (n) => {
    if (typeof n === 'string') return n;
    const out = { tag: n.tag, children: n.children.map(walk) };
    if (n.href && (/^mailto:/i.test(n.href) || mayOpen(n.href))) out.href = n.href;
    return out;
  };
  return notes.map((note) => ({ ...note, nodes: note.nodes.map(walk) }));
}

/**
 * What the in-page agent draws: each note cleaned, its content filled from vars. Notes with problems are
 * left out. [{ id, selector, type, style, nodes }].
 */
export function notesForPage(list, vars, fields = {}, missing) {
  return (Array.isArray(list) ? list : []).slice(0, LIMITS.perStep).filter((a) => !annotationErrors([a], fields).length).map((a) => ({
    id: a.id, selector: a.selector, type: a.type, style: cleanStyle(a.style).style, nodes: fillNote(parseMarkup(a.html).nodes, vars, missing),
  }));
}

// ------------------------------------------------------------------ markers on rows (a fetch step's show)

const ATTR = /^@?([A-Za-z_:][-\w:.]*)$/;

/**
 * The markers a fetch step's show draws on its page: one per matching row, at the row whose attribute
 * (mark.rowKey, such as @data-message) equals the row's mark.key value, with the mark's fixed text. At most
 * LIMITS.perStep. matches: shownRows().matches. No case value goes into the page: the text is the flow's.
 */
export function markersForPage(mark, matches) {
  if (!isObj(mark) || typeof mark.row !== 'string' || !mark.row.trim() || mark.row.length > LIMITS.selector) return [];
  const attr = ATTR.exec(String(mark.rowKey || ''))?.[1];
  const text = String(mark.text || '').trim().slice(0, 40);
  if (!attr || !text) return [];
  const style = cleanStyle(mark.style).style;
  const seen = new Set();
  const out = [];
  for (const m of matches || []) {
    const value = m?.row?.[mark.key];
    if (typeof value !== 'string' || !value || value.length > 200 || seen.has(value)) continue;
    seen.add(value);
    out.push({ id: `mark-${out.length + 1}`, at: { row: mark.row, attr, value }, type: 'marker', style, nodes: [text] });
    if (out.length >= LIMITS.perStep) break;
  }
  return out;
}

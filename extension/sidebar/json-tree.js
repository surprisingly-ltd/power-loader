// The tree view of a sample JSON response: the picker for data, as clicking a page is the picker for HTML.
// It renders the synthetic document of lib/json-dom.js with h() and textContent only, never markup, so a
// value such as <img onerror=…> is only ever text. Objects and arrays fold; arrays show their first 20 items,
// with Show more. Clicking a value calls onPick(el); what it can pick is decided by lib/json-dom.js pickFor().
// See docs/plans/json-clips.md, Authoring.
import { h, plural } from '../ui/dom.js';

const J = () => globalThis.PowerLoaderJson;
const NAME_LIKE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VALUE_CHARS = 120;
const PAGE = 20;

const cut = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
const keyText = (k) => (NAME_LIKE.test(k) ? k : JSON.stringify(k));

/**
 * The tree, as elements. state: { open: Set of paths toggled, more: { path: items shown } }, kept by the
 * caller in memory with the sample. picked: Map of anchored selector → field label, for the values already
 * mapped. selected: the path selected now. isPersonal(key): lib/privacy-detect.js, for marking data-like keys.
 * onPick(el), onChange() (after folding or Show more).
 */
export function jsonTree(doc, { state, picked = new Map(), selected = null, isPersonal = null, onPick, onChange }) {
  const root = doc.documentElement;
  if (!root) return h('p', { class: 'small muted' }, 'The sample is empty.');
  return h('ul', { class: 'plain json-tree', role: 'tree', 'aria-label': 'Sample response', 'data-key': 'jt-tree', style: 'font-family:var(--mono, monospace);font-size:12px' },
    node(root, { state, picked, selected, isPersonal, onPick, onChange, depth: 0, alike: new Set() }));
}

function label(el, ctx) {
  if (el.hasAttribute('index')) return h('span', { class: 'muted' }, `[${el.getAttribute('index')}] `);
  if (!el.hasAttribute('key')) return null;
  const k = el.getAttribute('key');
  const unwritable = J().jsonKeySelector(k) == null;
  const dataLike = J().dataLikeKey(el, { isPersonal: ctx.isPersonal });
  return h('span', {},
    h('b', { class: unwritable ? 'muted' : '' }, keyText(k)), ': ',
    unwritable ? h('span', { class: 'pill warn', title: 'Power Loader can’t read this key' }, 'can’t read') : null,
    dataLike && !unwritable ? h('span', { class: 'pill', title: 'This key looks like data, not a name: Power Loader never writes it into a template' }, 'data') : null,
    ctx.alike.has(el) ? h('span', { class: 'pill warn', title: 'Two keys look the same here' }, 'look-alike') : null, ' ');
}

function node(el, ctx) {
  const J_ = J();
  const path = J_.pathOf(el);
  const type = J_.typeOf(el);
  const container = type === 'object' || type === 'array';
  if (!container) {
    const sel = J_.selectorFor(el);
    const field = sel && ctx.picked.get(sel);
    const raw = J_.rawValue(el);
    const isSel = ctx.selected === path;
    return h('li', { role: 'treeitem', 'aria-selected': String(isSel), style: `padding-left:${ctx.depth ? 14 : 0}px` },
      label(el, ctx),
      h('button', {
        type: 'button', class: `link sm${isSel ? ' on' : ''}`, 'data-key': `jt-${path}`, title: `Pick ${path}`,
        onclick: () => ctx.onPick(el),
      }, cut(raw, VALUE_CHARS)),
      h('span', { class: 'muted' }, ` ${type}`),
      field ? h('span', { class: 'pill ok', style: 'margin-left:6px' }, field) : null);
  }
  const kids = [...el.children];
  // The top two levels start unfolded; state.open holds the paths folded or unfolded since.
  const open = ctx.depth === 0 || (ctx.depth <= 1) !== ctx.state.open.has(path);
  const shown = type === 'array' ? (ctx.state.more[path] || PAGE) : kids.length;
  const toggle = () => { if (ctx.state.open.has(path)) ctx.state.open.delete(path); else ctx.state.open.add(path); ctx.onChange(); };
  const alike = type === 'object' ? J_.lookAlikeKeys(el) : new Set();
  return h('li', { role: 'treeitem', 'aria-expanded': String(open), style: `padding-left:${ctx.depth ? 14 : 0}px` },
    ctx.depth ? h('button', { type: 'button', class: 'link sm', 'data-key': `jt-fold-${path}`, 'aria-expanded': String(open), onclick: toggle }, open ? '▾ ' : '▸ ') : null,
    label(el, ctx),
    h('span', { class: 'muted' }, type === 'array' ? `list of ${plural(kids.length, 'item')}` : `${plural(kids.length, 'key')}`),
    alike.size ? h('span', { class: 'small warn', style: 'margin-left:6px' }, 'Two keys look the same here') : null,
    open && kids.length ? h('ul', { class: 'plain', role: 'group' },
      kids.slice(0, shown).map((k) => node(k, { ...ctx, depth: ctx.depth + 1, alike })),
      kids.length > shown ? h('li', {}, h('button', {
        type: 'button', class: 'link sm', 'data-key': `jt-more-${path}`, onclick: () => { ctx.state.more[path] = shown + PAGE; ctx.onChange(); },
      }, `Show more (${kids.length - shown} left)`)) : null) : null);
}

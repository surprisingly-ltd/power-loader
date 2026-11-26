// Build-time diagrams for the website, other than sequence diagrams (tools/sequence-svg.mjs): where data
// goes, the layers of site rules, how a site rule decides, the range from locked down to smart and easy, and
// what a case is. Each is drawn twice from one spec, a wide layout for desktop widths and a narrow one for
// phones; site/style.css shows one or the other. Inline SVG of native shapes and <text> only: no script,
// style or foreignObject, no external images. Colours come from currentColor and the classes style.css sets;
// the only literal hues are the accents (the trust boundary, the deny that wins), which style.css also sets.
//
// The output depends only on the spec: no randomness, dates or measurement. Text widths are estimated from
// the number of characters, generously, as in tools/sequence-svg.mjs. Every label goes through escapeXml().

import { escapeXml, wrap } from './sequence-svg.mjs';

const FONT = 13;
const LINE = 16;
const CHAR = 7.1;
const BOLD = 7.7; // bold text is wider
export const AMBER = '#ecb44e'; // the trust boundary; style.css: --amber
export const RED = '#e8483f'; // a refusal, the deny that wins; style.css: --red
export const WIDE_MIN = 62; // rem: below this viewport width, style.css shows the narrow layout

const n = (v) => String(Math.round(v * 10) / 10);
const esc = escapeXml;
const ID = /^[a-z][a-z0-9-]*$/;

function text(x, y, s, { anchor = 'start', cls = '', bold = false } = {}) {
  return `<text${cls ? ` class="${cls}"` : ''} x="${n(x)}" y="${n(y)}"${anchor !== 'start' ? ` text-anchor="${anchor}"` : ''}${bold ? ' font-weight="700"' : ''}>${esc(s)}</text>`;
}

/** A title (bold) and a subtitle (muted), wrapped to a width: { title, sub, h } where h is their height. */
function measure(title, sub, width) {
  const t = title ? wrap(title, width, BOLD) : [];
  const s = sub ? wrap(sub, width) : [];
  return { title: t, sub: s, h: (t.length + s.length) * LINE };
}

/**
 * A box with a bold title and muted subtitle, centred (or start-aligned) and vertically centred.
 * cls: node | zone | deny | allow | ghost; dash: a dashed outline (optional parts).
 */
function box({ x, y, w, h, title, sub, cls = 'node', dash = false, align = 'middle', pad = 10, stroke }) {
  const m = measure(title, sub, w - pad * 2);
  const tx = align === 'middle' ? x + w / 2 : x + pad;
  let ty = y + (h - m.h) / 2 + LINE - 4;
  const out = [`<g class="${cls}"><rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="5" fill="#202a30" stroke="${stroke || 'currentColor'}" stroke-width="${stroke ? 1.6 : 1}"${dash ? ' stroke-dasharray="5 3"' : ''}/>`];
  for (const l of m.title) { out.push(text(tx, ty, l, { anchor: align, cls: 'title', bold: true })); ty += LINE; }
  for (const l of m.sub) { out.push(text(tx, ty, l, { anchor: align, cls: 'sub' })); ty += LINE; }
  out.push('</g>');
  return out.join('');
}
const boxH = (title, sub, w, pad = 10, min = 0) => Math.max(min, measure(title, sub, w - pad * 2).h + 20);

function arrow(d, id, { cls = 'edge', marker = 'arrow', dash = false, stroke } = {}) {
  return `<path class="${cls}" d="${d}" fill="none" stroke="${stroke || 'currentColor'}" stroke-width="1.5"${dash ? ' stroke-dasharray="6 4"' : ''} marker-end="url(#${id}-${marker})"/>`;
}

function defs(id) {
  return `<defs>`
    + `<marker id="${id}-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path class="head" d="M0 0L10 5L0 10z" fill="currentColor"/></marker>`
    + `<marker id="${id}-deny" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path class="head deny" d="M0 0L10 5L0 10z" fill="${RED}"/></marker>`
    + `</defs>`;
}

function svg({ id, cls, w, h, label }, parts) {
  if (!ID.test(id || '')) throw new Error('A diagram needs an id of lowercase letters, digits and hyphens');
  if (!label) throw new Error(`${id}: a diagram needs a label that states its claim`);
  return [
    `<svg class="dg ${cls}" xmlns="http://www.w3.org/2000/svg" width="${n(w)}" height="${n(h)}" viewBox="0 0 ${n(w)} ${n(h)}" role="img" aria-label="${esc(label)}" font-size="${FONT}" fill="currentColor">`,
    `<title>${esc(label)}</title>`,
    defs(id),
    ...parts,
    '</svg>',
  ].join('\n');
}

// Lines of text from a top-left corner (or anchored), returned with their height.
function block(lines, x, y, opts = {}) {
  return { svg: lines.map((l, i) => text(x, y + i * LINE, l, opts)).join(''), h: lines.length * LINE };
}

// ------------------------------------------------------------------ where data goes

/**
 * spec: { id, claim, boundary, inside: [{ id, title, sub, rows: n }], rows: [{ from, to?: { title, sub,
 * optional }, what, who, none? }] }. Each row is one crossing of the boundary, from an inside part to an
 * outside one; an inside part can span several rows. A row with `none` has no arrow: the text says so.
 */
export function flowsSvg(spec, { narrow = false } = {}) {
  const id = `${spec.id}-${narrow ? 'n' : 'w'}`;
  const W = narrow ? 360 : 990;
  const g = narrow
    ? { bx: 8, bw: 132, inX: 16, inW: 116, outX: 196, outW: 156, labX: 148, labW: 204 }
    : { bx: 12, bw: 352, inX: 28, inW: 320, outX: 676, outW: 302, labX: 520, labW: 286 };
  const top = 46;
  const rows = spec.rows.map((r) => {
    const out = r.to ? boxH(r.to.title, r.to.sub, g.outW, 10, 54) : 0;
    const what = wrap(r.what, g.labW);
    const who = r.who ? wrap(r.who, g.labW) : [];
    const inner = spec.inside.find((p) => p.id === r.from);
    if (!inner) throw new Error(`${spec.id}: no inside part "${r.from}"`);
    const inH = inner.rows > 1 ? 0 : boxH(inner.title, inner.sub, g.inW, 10, 54);
    const labels = (what.length + who.length) * LINE;
    const h = narrow
      ? (r.to ? Math.max(inH, out) + labels + 18 : Math.max(inH, labels + 12) + 18)
      : Math.max(inH, out, labels + 24) + 20;
    return { ...r, what, who, outH: out, h };
  });
  const parts = [];
  let y = top;
  const rowY = [];
  rows.forEach((r) => { rowY.push(y); y += r.h; });
  const bottom = y;
  // The boundary: Firefox on this computer.
  parts.push(`<g class="boundary"><rect x="${n(g.bx)}" y="12" width="${n(g.bw)}" height="${n(bottom - 12)}" rx="8" fill="none" stroke="${AMBER}" stroke-width="2" stroke-dasharray="9 5"/>`
    + `${text(g.bx + 12, 34, spec.boundary, { cls: 'zone', bold: true })}</g>`);
  // Inside parts, spanning their rows.
  let at = 0;
  for (const p of spec.inside) {
    const first = rows.findIndex((r) => r.from === p.id);
    const span = p.rows || 1;
    if (first < 0 || rows.slice(first, first + span).some((r) => r.from !== p.id)) throw new Error(`${spec.id}: ${p.id} must have ${span} row(s) in a row`);
    if (first < at) throw new Error(`${spec.id}: inside parts must be in the order of their rows`);
    at = first + span;
    const y0 = rowY[first];
    const y1 = rowY[first + span - 1] + rows[first + span - 1].h;
    const own = boxH(p.title, p.sub, g.inW, 10, 54);
    const h = span > 1 ? y1 - y0 - 20 : narrow ? Math.max(own, rows[first].outH) : own;
    const by = narrow && span === 1 ? y0 : span > 1 ? y0 + 4 : y0 + (narrow ? 0 : (rows[first].h - 20 - h) / 2);
    parts.push(box({ x: g.inX, y: by, w: g.inW, h, title: p.title, sub: p.sub, cls: `node${p.firefox ? ' firefox' : ''}`, dash: !!p.firefox }));
  }
  rows.forEach((r, i) => {
    const y0 = rowY[i];
    if (narrow) {
      const oh = r.to ? r.outH : 0;
      const ay = r.to ? y0 + oh / 2 : y0 + 20;
      if (r.to) {
        parts.push(box({ x: g.outX, y: y0, w: g.outW, h: oh, title: r.to.title, sub: r.to.sub, cls: r.to.optional ? 'node optional' : 'node', dash: !!r.to.optional }));
        parts.push(`<g class="crossing">${arrow(`M${n(g.inX + g.inW)} ${n(ay)}H${n(g.outX - 2)}`, id)}<circle class="cross" cx="${n(g.bx + g.bw)}" cy="${n(ay)}" r="4" fill="${AMBER}"/></g>`);
      }
      const ly = r.to ? y0 + oh + LINE + 2 : y0 + 22;
      const lx = g.labX;
      const a = block(r.what, lx, ly, { cls: r.none ? 'sub' : 'what' });
      const b = block(r.who, lx, ly + a.h, { cls: 'who' });
      parts.push(`<g class="row-label">${a.svg}${b.svg}</g>`);
      return;
    }
    const ay = y0 + (r.h - 20) / 2;
    if (r.to) {
      parts.push(box({ x: g.outX, y: ay - r.outH / 2, w: r.outW || g.outW, h: r.outH, title: r.to.title, sub: r.to.sub, cls: r.to.optional ? 'node optional' : 'node', dash: !!r.to.optional }));
      parts.push(`<g class="crossing">${arrow(`M${n(g.inX + g.inW)} ${n(ay)}H${n(g.outX - 2)}`, id)}<circle class="cross" cx="${n(g.bx + g.bw)}" cy="${n(ay)}" r="4" fill="${AMBER}"/></g>`);
    }
    const cx = r.to ? g.labX : g.bx + g.bw + 24;
    const anchor = r.to ? 'middle' : 'start';
    const a = block(r.what, cx, ay - 8 - (r.what.length - 1) * LINE, { anchor, cls: r.none ? 'sub' : 'what' });
    const b = block(r.who, cx, ay + 20, { anchor, cls: 'who' });
    parts.push(`<g class="row-label">${a.svg}${r.to ? b.svg : ''}</g>`);
  });
  return svg({ id, cls: `dg-flows ${narrow ? 'dg-narrow' : 'dg-wide'}`, w: W, h: bottom + 12, label: spec.claim }, parts);
}

// ------------------------------------------------------------------ the layers of site rules

/**
 * spec: { id, claim, top, bottom, narrows, denyLabel, refused, layers: [{ title, sub, deny }] }. A funnel:
 * each layer is narrower than the one above it. Layers that can hold deny rules send a red arrow to one
 * rail that ends in a refusal.
 */
export function layersSvg(spec, { narrow = false } = {}) {
  const id = `${spec.id}-${narrow ? 'n' : 'w'}`;
  const W = narrow ? 360 : 680;
  const area = narrow ? 252 : 480; // the funnel's column; the rail is to its right
  const cx = area / 2 + 8;
  const widest = area - 8;
  const step = narrow ? 14 : 22;
  const rail = narrow ? 290 : 560;
  const items = [{ title: spec.top, cls: 'node ghost', dash: true }, ...spec.layers.map((l) => ({ ...l, cls: 'node layer' })), { title: spec.bottom, cls: 'node allow' }];
  const parts = [];
  let y = 12;
  const gap = 34;
  const placed = items.map((it, i) => {
    const w = widest - i * step * 2;
    const h = boxH(it.title, it.sub, w, 10, 46);
    const p = { ...it, x: cx - w / 2, y, w, h };
    y += h + gap;
    return p;
  });
  const bottom = y - gap;
  placed.forEach((p, i) => {
    parts.push(box({ x: p.x, y: p.y, w: p.w, h: p.h, title: p.title, sub: p.sub, cls: p.cls, dash: p.dash }));
    if (i < placed.length - 1) {
      const y0 = p.y + p.h + 2;
      const y1 = placed[i + 1].y - 2;
      parts.push(`<g class="narrows">${arrow(`M${n(cx)} ${n(y0)}V${n(y1)}`, id)}${text(cx + 10, (y0 + y1) / 2 + 4, spec.narrows, { cls: 'who' })}</g>`);
    }
  });
  // The rail: a deny in any layer that can hold one is a refusal.
  const denies = placed.filter((p) => p.deny);
  if (denies.length) {
    const first = denies[0].y + denies[0].h / 2;
    const rh = boxH(spec.refused, null, W - rail + 30 - 12, 8, 40);
    const ry = bottom - rh;
    const rx = rail - 30;
    parts.push(`<g class="rail">`);
    parts.push(`<path class="edge deny" d="M${n(rail)} ${n(first)}V${n(ry - 2)}" fill="none" stroke="${RED}" stroke-width="2" marker-end="url(#${id}-deny)"/>`);
    for (const p of denies) {
      const ty = p.y + p.h / 2;
      parts.push(`<path class="edge deny" d="M${n(p.x + p.w)} ${n(ty)}H${n(rail)}" fill="none" stroke="${RED}" stroke-width="2"/>`);
      parts.push(text((p.x + p.w + rail) / 2, ty - 6, spec.denyLabel, { anchor: 'middle', cls: 'deny-label', bold: true }));
    }
    parts.push(box({ x: rx, y: ry, w: W - rx - 12, h: rh, title: spec.refused, cls: 'node refused', stroke: RED, pad: 8 }));
    parts.push('</g>');
  }
  return svg({ id, cls: `dg-layers ${narrow ? 'dg-narrow' : 'dg-wide'}`, w: W, h: bottom + 12, label: spec.claim }, parts);
}

// ------------------------------------------------------------------ how a site rule decides

/**
 * spec: { id, claim, start: { title, sub }, checks: [{ title, sub, pass, fail, refused: { title, sub } }],
 * end: { title, sub } }. A chain: each check passes to the next, or fails to its refusal. Wide: left to
 * right, refusals below. Narrow: top to bottom, refusals to the right.
 */
export function decideSvg(spec, { narrow = false } = {}) {
  const id = `${spec.id}-${narrow ? 'n' : 'w'}`;
  const nodes = [{ ...spec.start, cls: 'node start' }, ...spec.checks.map((c) => ({ ...c, cls: 'node check' })), { ...spec.end, cls: 'node allow' }];
  const parts = [];
  if (!narrow) {
    const w = 128;
    const gap = 36;
    const W = 12 * 2 + nodes.length * w + (nodes.length - 1) * gap;
    const h = Math.max(...nodes.map((d) => boxH(d.title, d.sub, w, 8)));
    const rh = Math.max(...spec.checks.map((c) => boxH(c.refused.title, c.refused.sub, w, 8)));
    const y = 12;
    const ry = y + h + 66;
    nodes.forEach((d, i) => {
      const x = 12 + i * (w + gap);
      parts.push(box({ x, y, w, h, title: d.title, sub: d.sub, cls: d.cls, pad: 8 }));
      if (i < nodes.length - 1) {
        const ay = y + h / 2;
        parts.push(`<g class="pass">${arrow(`M${n(x + w)} ${n(ay)}H${n(x + w + gap - 2)}`, id)}${text(x + w + gap / 2, ay - 7, nodes[i + 1] && d.pass ? d.pass : '', { anchor: 'middle', cls: 'who' })}</g>`);
      }
      if (d.refused) {
        const ax = x + w / 2;
        parts.push(`<g class="fail">${arrow(`M${n(ax)} ${n(y + h)}V${n(ry - 2)}`, id, { cls: 'edge deny', marker: 'deny', stroke: RED })}${text(ax + 8, (y + h + ry) / 2 + 4, d.fail, { cls: 'deny-label', bold: true })}</g>`);
        parts.push(box({ x, y: ry, w, h: rh, title: d.refused.title, sub: d.refused.sub, cls: 'node refused', stroke: RED, pad: 8 }));
      }
    });
    return svg({ id, cls: 'dg-decide dg-wide', w: W, h: ry + rh + 12, label: spec.claim }, parts);
  }
  const W = 360;
  const w = 196;
  const rx = 248;
  const rw = W - rx - 8;
  let y = 12;
  nodes.forEach((d, i) => {
    const h = boxH(d.title, d.sub, w, 8, 44);
    parts.push(box({ x: 12, y, w, h, title: d.title, sub: d.sub, cls: d.cls, pad: 8 }));
    let next = y + h + 40;
    if (d.refused) {
      const rh = boxH(d.refused.title, d.refused.sub, rw, 6, 44);
      const ay = y + h / 2;
      parts.push(`<g class="fail">${arrow(`M${n(12 + w)} ${n(ay)}H${n(rx - 2)}`, id, { cls: 'edge deny', marker: 'deny', stroke: RED })}${text((12 + w + rx) / 2, ay - 7, d.fail, { anchor: 'middle', cls: 'deny-label', bold: true })}</g>`);
      parts.push(box({ x: rx, y: ay - rh / 2, w: rw, h: rh, title: d.refused.title, sub: d.refused.sub, cls: 'node refused', stroke: RED, pad: 6 }));
      next = Math.max(next, ay + rh / 2 + 24);
    }
    if (i < nodes.length - 1) parts.push(`<g class="pass">${arrow(`M${n(12 + w / 2)} ${n(y + h)}V${n(next - 2)}`, id)}${text(12 + w / 2 + 8, (y + h + next) / 2 + 4, d.pass || '', { cls: 'who' })}</g>`);
    y = next;
  });
  return svg({ id, cls: 'dg-decide dg-narrow', w: W, h: y - 40 + 12, label: spec.claim }, parts);
}

// ------------------------------------------------------------------ locked down to smart and easy

/**
 * spec: { id, claim, ends: [left, right], whoTitle, legend: { lock, sets }, always,
 * rows: [{ name, left, right, who: [{ name, lock }] }] }. One track per choice between the two ends, and
 * who can set it, filled where they can also lock it.
 */
export function rangeSvg(spec, { narrow = false } = {}) {
  const id = `${spec.id}-${narrow ? 'n' : 'w'}`;
  const W = narrow ? 360 : 990;
  const chipW = (s) => s.length * CHAR + 18;
  const chips = (list, x, y) => {
    let cx = x;
    return list.map((c) => {
      const w = chipW(c.name);
      const out = `<g class="chip${c.lock ? ' lock' : ''}"><rect x="${n(cx)}" y="${n(y)}" width="${n(w)}" height="22" rx="11" fill="${c.lock ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1"${c.lock ? '' : ' stroke-dasharray="3 2"'}/>${text(cx + w / 2, y + 15.5, c.name, { anchor: 'middle', cls: c.lock ? 'chip-text on' : 'chip-text', bold: !!c.lock })}</g>`;
      cx += w + 6;
      return out;
    }).join('');
  };
  const track = (x0, x1, y) => `<g class="track"><line x1="${n(x0)}" y1="${n(y)}" x2="${n(x1)}" y2="${n(y)}" stroke="currentColor" stroke-width="2"/><circle cx="${n(x0)}" cy="${n(y)}" r="5" fill="#202a30" stroke="currentColor" stroke-width="2"/><circle cx="${n(x1)}" cy="${n(y)}" r="5" fill="currentColor"/></g>`;
  const parts = [];
  const g = narrow ? { tx0: 18, tx1: 342, endW: 150 } : { nameW: 170, tx0: 214, tx1: 716, endW: 250, whoX: 760 };
  // The header: the two ends, and the legend for the chips.
  let y = 12;
  parts.push(`<g class="ends">${text(g.tx0 - 6, y + 14, `← ${spec.ends[0]}`, { bold: true, cls: 'title' })}${text(g.tx1 + 6, y + 14, `${spec.ends[1]} →`, { anchor: 'end', bold: true, cls: 'title' })}</g>`);
  if (!narrow) parts.push(text(g.whoX, y + 14, spec.whoTitle, { bold: true, cls: 'title' }));
  y += 28;
  const legendY = y;
  const legend = `<g class="legend">${chips([{ name: spec.legend.lock, lock: true }], narrow ? 12 : g.whoX, legendY)}${chips([{ name: spec.legend.sets }], (narrow ? 12 : g.whoX) + chipW(spec.legend.lock) + 6, legendY)}</g>`;
  parts.push(legend);
  y += 38;
  for (const r of spec.rows) {
    const left = wrap(r.left, g.endW);
    const right = wrap(r.right, g.endW);
    const ends = Math.max(left.length, right.length) * LINE;
    parts.push(`<line class="rule" x1="12" y1="${n(y - 12)}" x2="${n(W - 12)}" y2="${n(y - 12)}" stroke="currentColor" stroke-width="1"/>`);
    if (narrow) {
      parts.push(text(12, y + 8, r.name, { bold: true, cls: 'title' }));
      parts.push(chips(r.who, 12, y + 18));
      const ty = y + 60;
      parts.push(track(g.tx0, g.tx1, ty));
      parts.push(block(left, g.tx0 - 6, ty + 22, { cls: 'sub' }).svg + block(right, g.tx1 + 6, ty + 22, { anchor: 'end', cls: 'sub' }).svg);
      y = ty + 22 + ends + 14;
    } else {
      const name = wrap(r.name, g.nameW, BOLD);
      const ty = y + 10;
      parts.push(block(name, 12, ty + 5, { bold: true, cls: 'title' }).svg);
      parts.push(track(g.tx0, g.tx1, ty));
      parts.push(block(left, g.tx0 - 6, ty + 24, { cls: 'sub' }).svg + block(right, g.tx1 + 6, ty + 24, { anchor: 'end', cls: 'sub' }).svg);
      parts.push(chips(r.who, g.whoX, ty - 11));
      y = Math.max(ty + 24 + ends, ty + name.length * LINE) + 16;
    }
  }
  // What doesn't change at either end: drawn across the whole range.
  const always = wrap(spec.always, W - 48);
  const ah = always.length * LINE + 18;
  parts.push(`<g class="always"><rect x="12" y="${n(y)}" width="${n(W - 24)}" height="${n(ah)}" rx="6" fill="none" stroke="${AMBER}" stroke-width="1.6"/>${block(always, W / 2, y + LINE + 5, { anchor: 'middle', cls: 'title', bold: true }).svg}</g>`);
  y += ah;
  return svg({ id, cls: `dg-range ${narrow ? 'dg-narrow' : 'dg-wide'}`, w: W, h: y + 12, label: spec.claim }, parts);
}

// ------------------------------------------------------------------ what a case is

/** spec: { id, claim, pages: [title], clip, kept: { title, sub, zone }, fill, form: { title, sub } }. */
export function caseSvg(spec, { narrow = false } = {}) {
  const id = `${spec.id}-${narrow ? 'n' : 'w'}`;
  const parts = [];
  const pageCard = (x, y, w, t) => `<g class="node page"><rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="36" rx="4" fill="#202a30" stroke="currentColor" stroke-width="1"/><path d="M${n(x + 10)} ${n(y + 11)}h14M${n(x + 10)} ${n(y + 18)}h10M${n(x + 10)} ${n(y + 25)}h12" stroke="currentColor" stroke-width="1.5" fill="none"/>${text(x + 32, y + 23, t, { cls: 'title', bold: true })}</g>`;
  if (!narrow) {
    const W = 860;
    const pw = 190;
    const kx = 330; const kw = 220; const fx = 690; const fw = 158;
    const kh = boxH(spec.kept.title, spec.kept.sub, kw, 12, 120);
    const ph = spec.pages.length * 36 + (spec.pages.length - 1) * 10;
    const H = Math.max(kh, ph) + 24 + 30;
    const mid = 30 + Math.max(kh, ph) / 2;
    spec.pages.forEach((t, i) => {
      const y = mid - ph / 2 + i * 46;
      parts.push(pageCard(12, y, pw, t));
      parts.push(arrow(`M${n(12 + pw)} ${n(y + 18)}C${n(12 + pw + 60)} ${n(y + 18)} ${n(kx - 60)} ${n(mid)} ${n(kx - 12)} ${n(mid)}`, id));
    });
    parts.push(text((12 + pw + kx - 12) / 2, mid - ph / 2 - 10, spec.clip, { anchor: 'middle', cls: 'what', bold: true }));
    parts.push(`<g class="boundary"><rect x="${n(kx - 10)}" y="${n(mid - kh / 2 - 10)}" width="${n(kw + 20)}" height="${n(kh + 20)}" rx="9" fill="none" stroke="${AMBER}" stroke-width="2" stroke-dasharray="9 5"/>${text(kx + kw / 2, mid - kh / 2 - 18, spec.kept.zone, { anchor: 'middle', cls: 'zone', bold: true })}</g>`);
    parts.push(box({ x: kx, y: mid - kh / 2, w: kw, h: kh, title: spec.kept.title, sub: spec.kept.sub, pad: 12 }));
    parts.push(arrow(`M${n(kx + kw + 10)} ${n(mid)}H${n(fx - 2)}`, id));
    parts.push(text((kx + kw + 10 + fx) / 2, mid - 10, spec.fill, { anchor: 'middle', cls: 'what', bold: true }));
    parts.push(box({ x: fx, y: mid - 50, w: fw, h: 100, title: spec.form.title, sub: spec.form.sub }));
    return svg({ id, cls: 'dg-case dg-wide', w: W, h: H + 12, label: spec.claim }, parts);
  }
  const W = 360;
  let y = 12;
  spec.pages.forEach((t) => { parts.push(pageCard(60, y, 240, t)); y += 46; });
  y += 2;
  parts.push(arrow(`M180 ${n(y - 10)}V${n(y + 34)}`, id));
  parts.push(text(192, y + 16, spec.clip, { cls: 'what', bold: true }));
  y += 64;
  const kh = boxH(spec.kept.title, spec.kept.sub, 260, 12, 100);
  parts.push(`<g class="boundary"><rect x="40" y="${n(y - 10)}" width="280" height="${n(kh + 20)}" rx="9" fill="none" stroke="${AMBER}" stroke-width="2" stroke-dasharray="9 5"/>${text(180, y - 16, spec.kept.zone, { anchor: 'middle', cls: 'zone', bold: true })}</g>`);
  parts.push(box({ x: 50, y, w: 260, h: kh, title: spec.kept.title, sub: spec.kept.sub, pad: 12 }));
  y += kh + 10;
  parts.push(arrow(`M180 ${n(y)}V${n(y + 44)}`, id));
  parts.push(text(192, y + 26, spec.fill, { cls: 'what', bold: true }));
  y += 48;
  parts.push(box({ x: 60, y, w: 240, h: 80, title: spec.form.title, sub: spec.form.sub }));
  y += 80;
  return svg({ id, cls: 'dg-case dg-narrow', w: W, h: y + 12, label: spec.claim }, parts);
}

/**
 * A figure holding both layouts of a diagram, with a caption that states the same claim. The caption may
 * carry inline HTML (code, b) after the claim; the claim itself is escaped.
 */
export function pairFigure(spec, draw, { extra = '' } = {}) {
  if (!spec.claim || spec.caption === undefined) throw new Error(`${spec.id}: a figure needs a claim and a caption`);
  return `<figure class="diagram dg-pair" id="${spec.id}" aria-labelledby="${spec.id}-caption">\n<div class="diagram-box">\n${draw(spec, { narrow: false })}\n${draw(spec, { narrow: true })}\n</div>\n<figcaption id="${spec.id}-caption"><b>${esc(spec.claim)}.</b> ${spec.caption}${extra}</figcaption>\n</figure>`;
}

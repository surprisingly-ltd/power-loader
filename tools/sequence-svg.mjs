// A small sequence-diagram generator for the website: participants with lifelines, messages between them,
// notes, labelled phases, boxed optional parts and a trust boundary, written as one SVG string. It is used at
// build time only (tools/how-it-works.mjs inlines its output into site/how-it-works.html), so nothing is
// loaded at runtime. No dependencies.
//
// spec = {
//   id: 'seq-build',                     prefix for the SVG's ids (several diagrams share one page)
//   title, desc,                         the accessible name (aria-label, <title>) and description (<desc>)
//   participants: [{ id, label, optional? }],   left to right; an optional one has a dashed box and lifeline
//   boundary?: { after, inside, outside },      the trust boundary: a line after participant `after`, with the
//                                        zone names either side of it. Arrows that cross it get a dot on it.
//   groups: { [key]: { kind: 'opt' | 'alt' | 'loop', label } },
//   messages: [{ from, to?, text, kind: 'call' | 'return' | 'note', step?, group?, phase? }],
// }
// A call is a solid line with a filled arrowhead; a return is dashed with an open one; a note is a box over
// one participant (or from `from` to `to`); a message to itself loops back. `step` prefixes the label with
// its number, matching the ordered list printed under the diagram. Consecutive messages with the same
// `group` are boxed together in a dashed frame, with the group's kind ("optional" for opt) and label in a
// tab. `phase` on a message starts a labelled band across the diagram before it. Colour is never the only
// cue: the boundary is also a dashed line with its zones named, and optional parts are dashed and labelled.
//
// The output depends only on the spec: no randomness, dates or measurement. Text widths are estimated from
// the number of characters, generously, so labels wrap before they reach the next lifeline.

const FONT = 13; // px
const LINE = 16; // px between lines of a label
const CHAR = 7.1; // px, a generous average character width at FONT for system-ui
const COL = 124; // px between lifelines
const PAD = 12; // px around the diagram
const ZONE = 26; // px for the zone names above the participants
const PHASE = 24; // px, the height of a phase band
// The one literal accent, for the trust boundary; style.css sets the same through --amber.
const ACCENT = '#ecb44e';
const KIND_TEXT = { opt: 'optional', alt: 'alt', loop: 'loop' };

export const escapeXml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = (v) => String(Math.round(v * 10) / 10);

/** Greedy word wrap to a width in px. A word longer than the width gets a line of its own. */
export function wrap(text, width, char = CHAR) {
  const max = Math.max(4, Math.floor(width / char));
  const lines = [];
  let line = '';
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (line && (line.length + 1 + word.length) > max) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

// Lines of text, with an optional step number in bold before the first.
function textBlock(lines, x, y, { anchor = 'middle', step, cls = 'label' } = {}) {
  return lines.map((l, i) => {
    const num = i === 0 && step != null ? `<tspan class="num" font-weight="700">${escapeXml(step)}.</tspan> ` : '';
    return `<text class="${cls}" x="${n(x)}" y="${n(y + i * LINE)}" text-anchor="${anchor}">${num}${escapeXml(l)}</text>`;
  }).join('');
}

export function sequenceSvg(spec) {
  const { id, title, desc, participants, groups = {}, messages, boundary } = spec;
  if (!/^[a-z][a-z0-9-]*$/.test(id || '')) throw new Error('A diagram needs an id of lowercase letters, digits and hyphens');
  if (!title || !desc) throw new Error(`${id}: a diagram needs a title and a description`);
  const col = new Map(participants.map((p, i) => [p.id, i]));
  if (col.size !== participants.length) throw new Error(`${id}: participant ids must be unique`);
  const x = (pid) => {
    if (!col.has(pid)) throw new Error(`${id}: no participant "${pid}"`);
    return PAD + COL / 2 + col.get(pid) * COL;
  };
  const width = PAD * 2 + COL * participants.length;
  if (boundary && (!col.has(boundary.after) || col.get(boundary.after) === participants.length - 1)) throw new Error(`${id}: the boundary must come after a participant that isn't the last`);
  const bx = boundary ? PAD + (col.get(boundary.after) + 1) * COL : null;

  // Participant boxes, all the same height, below the zone names.
  const heads = participants.map((p) => wrap(p.label, COL - 18));
  const headH = Math.max(...heads.map((l) => l.length)) * LINE + 14;
  const top = PAD + (boundary ? ZONE : 0);
  const body = [];
  const boxes = [];
  const bands = [];
  let y = top + headH + 18;

  let open = null; // the group being drawn: { key, startY, min, max }
  const closeGroup = () => {
    if (!open) return;
    const g = groups[open.key] || { kind: 'opt', label: open.key };
    const x0 = PAD + open.min * COL + 4;
    const x1 = PAD + (open.max + 1) * COL - 4;
    const tab = KIND_TEXT[g.kind] || g.kind;
    const tabW = tab.length * CHAR + 14;
    y += 4;
    boxes.push([
      `<g class="group ${escapeXml(g.kind)}" data-group="${escapeXml(open.key)}">`,
      `<rect class="frame" x="${n(x0)}" y="${n(open.startY)}" width="${n(x1 - x0)}" height="${n(y - open.startY)}" rx="3" fill="none" stroke="currentColor" stroke-width="1.2"${g.kind === 'opt' ? ' stroke-dasharray="5 4"' : ''}/>`,
      `<path class="tab" d="M${n(x0)} ${n(open.startY)}h${n(tabW)}v${LINE + 2}l-6 6h${n(-tabW + 6)}z" fill="none" stroke="currentColor" stroke-width="1"/>`,
      `<text class="kind" x="${n(x0 + 7)}" y="${n(open.startY + LINE)}" font-weight="700">${escapeXml(tab)}</text>`,
      `<text class="label glabel" x="${n(x0 + tabW + 8)}" y="${n(open.startY + LINE)}">${escapeXml(g.label)}</text>`,
      '</g>',
    ].join(''));
    y += 14;
    open = null;
  };

  messages.forEach((m, i) => {
    if (!m || typeof m.text !== 'string') throw new Error(`${id}: message ${i + 1} needs text`);
    const kind = m.kind || 'call';
    if (!['call', 'return', 'note'].includes(kind)) throw new Error(`${id}: message ${i + 1} has an unknown kind "${kind}"`);
    const a = col.get(m.from);
    const b = col.get(m.to ?? m.from);
    x(m.from); x(m.to ?? m.from);
    if (open && (open.key !== m.group || m.phase)) closeGroup();
    if (m.phase) {
      // A band across the diagram, its name at the left; lifelines show through it.
      bands.push(`<g class="phase"><rect x="${n(PAD)}" y="${n(y)}" width="${n(width - PAD * 2)}" height="${PHASE}" rx="3" fill="currentColor" fill-opacity="0.07"/>`
        + `<text class="phase-name" x="${n(PAD + 8)}" y="${n(y + PHASE / 2 + 4.5)}" font-weight="700">${escapeXml(m.phase)}</text></g>`);
      y += PHASE + 14;
    }
    if (m.group && !open) {
      open = { key: m.group, startY: y, min: Math.min(a, b), max: Math.max(a, b) };
      y += LINE + 16;
    }
    if (open) { open.min = Math.min(open.min, a, b); open.max = Math.max(open.max, a, b); }
    const step = m.step;
    const label = step != null ? `${step}. ${m.text}` : m.text; // for wrapping; the number is drawn bold
    const unnumber = (lines) => lines.map((l, j) => (j === 0 && step != null ? l.slice(String(step).length + 2) : l));

    if (kind === 'note') {
      const [lo, hi] = [Math.min(a, b), Math.max(a, b)];
      const x0 = PAD + lo * COL + 10;
      const x1 = PAD + (hi + 1) * COL - 10;
      const lines = unnumber(wrap(label, x1 - x0 - 16));
      const h = lines.length * LINE + 12;
      body.push(`<g class="msg note" data-n="${i + 1}"><path class="notebox" d="M${n(x0)} ${n(y)}h${n(x1 - x0 - 10)}l10 10v${n(h - 10)}h${n(-(x1 - x0))}z" fill="#18222a" stroke="currentColor" stroke-width="1"/>`
        + `<path class="fold" d="M${n(x1 - 10)} ${n(y)}v10h10" fill="none" stroke="currentColor" stroke-width="1"/>`
        + `${textBlock(lines, x0 + 8, y + LINE + 1, { anchor: 'start', step })}</g>`);
      y += h + 12;
      return;
    }

    const cls = kind === 'return' ? 'return' : 'call';
    const marker = `url(#${id}-${cls})`;
    const dash = kind === 'return' ? ' stroke-dasharray="6 4"' : '';
    if (a === b) {
      // A message to itself: a loop to the right, the label beside it.
      const x0 = x(m.from);
      const lines = unnumber(wrap(label, COL - 40));
      const textH = lines.length * LINE;
      body.push(`<g class="msg ${cls}" data-n="${i + 1}">${textBlock(lines, x0 + 32, y + LINE - 3, { anchor: 'start', step })}`
        + `<path class="line" d="M${n(x0)} ${n(y + 2)}h24v${n(Math.max(textH, LINE + 4))}h-22" fill="none" stroke="currentColor" stroke-width="1.4"${dash} marker-end="${marker}"/></g>`);
      y += Math.max(textH, LINE + 4) + 18;
      return;
    }
    const [x0, x1] = [x(m.from), x(m.to)];
    const span = Math.abs(x1 - x0);
    const lines = unnumber(wrap(label, span - 20));
    const textY = y + LINE - 3;
    const lineY = y + lines.length * LINE + 4;
    const dir = x1 > x0 ? 1 : -1;
    const crosses = bx !== null && Math.min(x0, x1) < bx && Math.max(x0, x1) > bx;
    body.push(`<g class="msg ${cls}${crosses ? ' crosses' : ''}" data-n="${i + 1}">${textBlock(lines, (x0 + x1) / 2, textY, { step })}`
      + `<line class="line" x1="${n(x0)}" y1="${n(lineY)}" x2="${n(x1 - dir * 2)}" y2="${n(lineY)}" stroke="currentColor" stroke-width="1.4"${dash} marker-end="${marker}"/>`
      + `${crosses ? `<circle class="cross" cx="${n(bx)}" cy="${n(lineY)}" r="4" fill="${ACCENT}"/>` : ''}</g>`);
    y = lineY + 16;
  });
  closeGroup();
  const height = y + PAD;

  const lifelines = participants.map((p) => `<line class="lifeline${p.optional ? ' optional' : ''}" x1="${n(x(p.id))}" y1="${n(top + headH)}" x2="${n(x(p.id))}" y2="${n(height - PAD)}" stroke="currentColor" stroke-width="1.2"${p.optional ? ' stroke-dasharray="4 4"' : ''}/>`);
  const headBoxes = participants.map((p, i) => {
    const cx = x(p.id);
    const lines = heads[i];
    const ty = top + (headH - lines.length * LINE) / 2 + LINE - 4;
    return `<g class="actor${p.optional ? ' optional' : ''}"><rect x="${n(cx - COL / 2 + 6)}" y="${n(top)}" width="${n(COL - 12)}" height="${n(headH)}" rx="4" fill="#202a30" stroke="currentColor" stroke-width="1"${p.optional ? ' stroke-dasharray="5 3"' : ''}/>${textBlock(lines, cx, ty, { cls: 'name' })}</g>`;
  });
  const zone = boundary ? [
    `<g class="boundary"><line x1="${n(bx)}" y1="${n(PAD)}" x2="${n(bx)}" y2="${n(height - PAD)}" stroke="${ACCENT}" stroke-width="2" stroke-dasharray="9 5"/>`,
    `<text class="zone" x="${n(bx - 10)}" y="${n(PAD + 15)}" text-anchor="end" font-weight="700">${escapeXml(boundary.inside)}</text>`,
    `<text class="zone" x="${n(bx + 10)}" y="${n(PAD + 15)}" font-weight="700">${escapeXml(boundary.outside)}</text></g>`,
  ].join('') : '';
  const defs = `<defs>`
    + `<marker id="${id}-call" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path class="head" d="M0 0L10 5L0 10z" fill="currentColor"/></marker>`
    + `<marker id="${id}-return" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path class="head open" d="M1 1L9 5L1 9" fill="none" stroke="currentColor" stroke-width="1.5"/></marker>`
    + `</defs>`;
  return [
    `<svg class="seq" xmlns="http://www.w3.org/2000/svg" width="${n(width)}" height="${n(height)}" viewBox="0 0 ${n(width)} ${n(height)}" role="img" aria-label="${escapeXml(title)}" aria-describedby="${id}-desc" font-size="${FONT}" fill="currentColor">`,
    `<title id="${id}-title">${escapeXml(title)}</title>`,
    `<desc id="${id}-desc">${escapeXml(desc)}</desc>`,
    defs,
    ...bands,
    ...lifelines,
    zone,
    ...boxes,
    ...headBoxes,
    ...body,
    '</svg>',
  ].filter(Boolean).join('\n');
}

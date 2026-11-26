// The timeline: periods from the case, with exact gaps. Standard works it out on this computer; ✦ Enhanced
// finds periods written in the case notes and explains the gaps, after the redaction preview.
import { assertTool } from '../../lib/tools.js';
import { h, plural, copyText, announce } from '../../ui/dom.js';
import { PERIOD_CATS, approxDuration, dayNum, fmtDay, periods, pointsText, summaryText, timeline } from '../../lib/timeline.js';
import { datePoints, seriesLanes } from '../../lib/journey.js';
import { addWorking } from '../../lib/case.js';
import { logEvent } from '../../lib/activity.js';
import { caseNotes, enhancedGate, modeSeg, tools } from './tools.js';
import { runAi } from '../privacy.js';

// show: 'ticked' (the periods and dates ticked below), 'all' (every date in the case), or 'def:<id>' (a timeline
// the flow or library defines, with its own series, colours and shapes).
const fresh = () => ({ show: null, off: new Set(), cats: null, from: '', to: '', minGap: 1, busy: null, explain: null });
export const tl = fresh();
export function resetTimeline() { Object.assign(tl, fresh()); }

const SVG = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, ...children) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...children);
  return el;
};
const COLOURS = { Employment: '#1d70b8', Benefit: '#4c2c92', Tenancy: '#28a197', Sickness: '#f47738', Other: '#505a5f' };
const DATES = { id: 'dates', label: 'Dates', colour: '#505a5f', shape: 'diamond' };
const MIN_GAPS = [[1, 'Nothing: show every gap'], [2, '2 days'], [7, '7 days'], [14, '14 days'], [31, '1 month']];
const monthYear = (iso) => fmtDay(iso).replace(/^\d+ /, '');
const dur = (days) => approxDuration(days, { short: true });
const stat = (k, v, d, cls = '') => h('div', { class: `stat ${cls}` }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), h('div', { class: 'd' }, d));

// Pointer shapes: a circle, square, diamond or triangle centred on (x, y).
function marker(shape, x, y, r, fill, title) {
  const t = s('title', {}, title);
  if (shape === 'square') return s('rect', { x: x - r, y: y - r, width: r * 2, height: r * 2, fill, stroke: '#fff', 'stroke-width': 1 }, t);
  if (shape === 'diamond') return s('polygon', { points: `${x},${y - r - 1} ${x + r + 1},${y} ${x},${y + r + 1} ${x - r - 1},${y}`, fill, stroke: '#fff', 'stroke-width': 1 }, t);
  if (shape === 'triangle') return s('polygon', { points: `${x},${y - r - 1} ${x + r + 1},${y + r} ${x - r - 1},${y + r}`, fill, stroke: '#fff', 'stroke-width': 1 }, t);
  return s('circle', { cx: x, cy: y, r, fill, stroke: '#fff', 'stroke-width': 1 }, t);
}

/**
 * A picture of the lanes (bars and pointers) and, when gaps are measured, the covered row with numbered gaps.
 * The list below says the same in text. range: { from, to }; m: the gap measure, or null.
 */
function picture(range, lanes, width, m, shown) {
  const W = width;
  const lane = 16;
  const left = 82;
  const rows = lanes.length + (m ? 1 : 0);
  const H = 18 + rows * (lane + 8) + 22;
  const lo = dayNum(range.from);
  const span = Math.max(1, dayNum(range.to) - lo + 1);
  const x = (iso) => left + ((Math.min(Math.max(dayNum(iso), lo), lo + span) - lo) / span) * (W - left - 8);
  const inRange = (iso) => iso >= range.from && iso <= range.to;
  const svg = s('svg', { class: 'tl-svg', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Timeline from ${fmtDay(range.from)} to ${fmtDay(range.to)}${m ? `: ${plural(shown.length, 'gap')}, numbered` : ''}. The list below describes each date and change.` });
  for (let y = Number(range.from.slice(0, 4)) + 1; y <= Number(range.to.slice(0, 4)); y++) {
    const xx = x(`${y}-01-01`);
    svg.append(s('line', { x1: xx, x2: xx, y1: 8, y2: H - 16, stroke: '#b1b4b6', 'stroke-dasharray': '2 3' }), s('text', { x: xx + 2, y: H - 4, 'font-size': 10, fill: '#505a5f' }, String(y)));
  }
  lanes.forEach((ln, i) => {
    const y = 12 + i * (lane + 8);
    const name = ln.label.length > 13 ? `${ln.label.slice(0, 12)}…` : ln.label;
    svg.append(s('text', { x: 0, y: y + 12, 'font-size': 11, fill: '#0b0c0c' }, name, s('title', {}, ln.label)));
    for (const p of ln.bars) {
      if (p.end && p.end < range.from) continue;
      if (p.start > range.to) continue;
      const a = x(p.start);
      const b = x(p.end || range.to);
      svg.append(s('rect', { x: a, y, width: Math.max(2, b - a), height: lane, fill: ln.colour, opacity: p.approx ? 0.45 : 0.95 },
        s('title', {}, `${p.label}: ${fmtDay(p.start)} to ${p.end ? fmtDay(p.end) : 'now'}${p.approx ? ' (approximate)' : ''}`)));
    }
    for (const p of ln.points.filter((q) => inRange(q.at))) svg.append(marker(p.shape || ln.shape, x(p.at), y + lane / 2, 5.5, p.colour || ln.colour, `${p.label}: ${fmtDay(p.at)}`));
  });
  if (m) {
    const y = 12 + lanes.length * (lane + 8);
    svg.append(s('text', { x: 0, y: y + 12, 'font-size': 11, 'font-weight': 700, fill: '#0b0c0c' }, 'Covered'));
    for (const r of m.merged) svg.append(s('rect', { x: x(r.start), y, width: Math.max(2, x(r.end) - x(r.start)), height: lane, fill: '#00703c' }));
    for (const g of shown) {
      const gx = x(g.start);
      const gw = Math.max(3, x(g.end) - gx);
      svg.append(s('rect', { x: gx, y: y - 2, width: gw, height: lane + 4, fill: '#f4cdc6', stroke: '#d4351c', 'stroke-width': 2 }));
      svg.append(s('circle', { cx: gx + gw / 2, cy: y + lane / 2, r: 7, fill: '#d4351c' }), s('text', { x: gx + gw / 2, y: y + lane / 2 + 3.5, 'font-size': 10, 'font-weight': 700, fill: '#fff', 'text-anchor': 'middle' }, String(g.n)));
    }
  }
  return svg;
}

// Every change on the timeline in order: gaps (numbered), back-to-back joins and overlaps.
function changes(m) {
  return h('ol', { class: 'trlist', style: 'list-style:none;margin:0;padding:0' }, m.transitions.map((t) => {
    if (t.kind === 'gap') {
      return h('li', { class: `tr ${t.ignored ? 't-ign' : 't-gap'}` }, h('span', { class: 'tm' }, t.ignored ? '' : String(t.n)),
        h('div', {}, h('b', {}, t.ignored ? 'Short gap, ignored' : `Gap ${t.n}`), h('span', { class: 'num' }, `${fmtDay(t.start)} – ${fmtDay(t.end)} · ${plural(t.days, 'day')} (${approxDuration(t.days)})`),
          h('small', {}, `${t.prev ? `After ${t.prev}` : 'At the start'}${t.next ? `, before ${t.next}` : ', to the end'}`)));
    }
    return h('li', { class: `tr ${t.kind === 'join' ? 't-join' : 't-over'}` }, h('span', { class: 'tm' }, t.kind === 'join' ? '◆' : '≈'),
      h('div', {}, h('b', {}, t.kind === 'join' ? 'Back to back' : 'Overlap'), h('span', { class: 'num' }, fmtDay(t.at)),
        h('small', {}, `${t.prev} → ${t.next}${t.kind === 'overlap' && t.days ? `, ${plural(t.days, 'day')} overlapping` : ''}`)));
  }));
}

// ✦ Find periods in the notes: suggestions wait in the case until the caseworker adds or dismisses each.
async function findPeriods(context, notes) {
  const { act } = context;
  try { await assertTool('timeline'); } catch (e) { announce(e.message); return; }
  tl.busy = 'find';
  act.render();
  await runAi(context, 'tlFind', { notes }, async (out) => {
    await act.update((cs) => {
      const seen = new Set(cs.aiPeriods.map((p) => `${p.label}|${p.start}|${p.end}`));
      for (const p of out.periods) {
        if (seen.has(`${p.label}|${p.start}|${p.end}`)) continue;
        cs.aiPeriods.push({ id: `p${Date.now().toString(36)}${cs.aiPeriods.length}`, ...p, sub: 'From the case notes', accepted: false, dismissed: false });
      }
      logEvent(cs, 'ai_timeline_find', { detail: plural(out.periods.length, 'period') });
    }, out.periods.length ? `${plural(out.periods.length, 'period')} suggested. Check each before adding it.` : 'No periods found in the notes');
  });
  tl.busy = null;
  act.render();
}

async function explain(context, m, notes) {
  const { act } = context;
  try { await assertTool('timeline'); } catch (e) { announce(e.message); return; }
  tl.busy = 'explain';
  act.render();
  await runAi(context, 'tlExplain', { summary: summaryText(m), notes }, async (out) => {
    tl.explain = { text: out.explanation, problems: out.problems, uses: [...new Set(notes.map((n) => n.clipId))] };
    await act.update((cs) => logEvent(cs, 'ai_timeline_explain', { detail: plural(m.gaps.filter((g) => !g.ignored).length, 'gap') }));
  });
  tl.busy = null;
  act.render();
}

function suggestion({ act }, p) {
  return h('div', { class: 'sugg' },
    h('div', { class: 'row between' }, h('b', {}, p.label), h('span', { class: 'pill magic' }, 'Suggested')),
    h('span', { class: 'num' }, `${fmtDay(p.start)} – ${p.end ? fmtDay(p.end) : 'now'} · ${p.cat}${p.approx ? ' · approximate' : ''}`),
    p.quote ? h('q', {}, p.quote) : null,
    h('span', { class: 'small muted' }, `${p.why ? `${p.why} ` : ''}${p.noteDate ? `From the note of ${fmtDay(p.noteDate)}.` : ''}`),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'sm primary', 'data-key': `tl-add-${p.id}`, onclick: () => act.update((cs) => { const x = cs.aiPeriods.find((q) => q.id === p.id); if (x) x.accepted = true; logEvent(cs, 'ai_timeline_accept', { detail: p.cat }); }, `${p.label} added to the timeline`) }, 'Add to timeline'),
      h('button', { type: 'button', class: 'sm', 'data-key': `tl-dismiss-${p.id}`, onclick: () => act.update((cs) => { const x = cs.aiPeriods.find((q) => q.id === p.id); if (x) x.dismissed = true; }, 'Dismissed') }, 'Dismiss')));
}

// The lanes to draw and the bars whose gaps are measured, for what's shown.
function view(c, lib, all, defs) {
  const series = [];
  const seen = new Set();
  for (const d of defs) for (const ln of seriesLanes(c, lib, d)) if (!seen.has(ln.id)) { seen.add(ln.id); series.push(ln); }
  const points = datePoints(c, lib);
  if (tl.show.startsWith('def:')) {
    const def = defs.find((d) => `def:${d.id}` === tl.show);
    const lanes = seriesLanes(c, lib, def);
    return { def, lanes, gapBars: lanes.filter((l) => l.gaps).flatMap((l) => l.bars), items: [] };
  }
  const ticked = tl.show === 'ticked';
  const on = (p) => !ticked || !tl.off.has(p.id);
  const catLanes = PERIOD_CATS.filter((cat) => all.some((p) => p.cat === cat) && (!ticked || tl.cats.has(cat)))
    .map((cat) => ({ id: `cat:${cat}`, label: cat, colour: COLOURS[cat], shape: 'circle', gaps: true, bars: all.filter((p) => p.cat === cat && on(p)), points: [] }));
  const lanes = [...catLanes, ...series.map((l) => ({ ...l, bars: l.bars.filter(on), points: l.points.filter(on) })),
    ...(points.length ? [{ ...DATES, gaps: false, bars: [], points: points.filter(on) }] : [])].filter((l) => l.bars.length || l.points.length);
  return {
    lanes, gapBars: lanes.filter((l) => l.gaps).flatMap((l) => l.bars),
    // What can be ticked: periods, series rows and single dates.
    items: [...all.map((p) => ({ ...p, colour: COLOURS[p.cat], lane: p.cat, off: !tl.cats.has(p.cat) })), ...series.flatMap((l) => [...l.bars, ...l.points].map((p) => ({ ...p, colour: l.colour, lane: l.label, shape: l.kind === 'point' ? l.shape : null }))),
      ...points.map((p) => ({ ...p, colour: DATES.colour, lane: 'Dates', shape: DATES.shape }))],
  };
}

const showLabel = (c) => (c.library?.flow ? 'From the flow' : 'From the library');

export function timelineBlock(context, { wide = false } = {}) {
  const { data, act, lib } = context;
  const c = data.case;
  const defs = lib?.timelines || [];
  if (!tl.show || (tl.show.startsWith('def:') && !defs.some((d) => `def:${d.id}` === tl.show))) tl.show = defs.length ? `def:${defs[0].id}` : 'ticked';
  const all = periods(c);
  const head = h('div', { class: 'row between' }, modeSeg(context, 'timeline'));
  const cats = PERIOD_CATS.filter((x) => all.some((p) => p.cat === x));
  if (!tl.cats) tl.cats = new Set(cats.filter((x) => x !== 'Tenancy'));
  const v = view(c, lib || { fields: {} }, all, defs);
  const shownPoints = v.lanes.flatMap((l) => l.points.map((p) => ({ ...p, lane: l.label })));
  const today = new Date().toISOString().slice(0, 10);
  const m = timeline(v.gapBars, { today, from: tl.from || undefined, to: tl.to || undefined, minGap: Math.max(1, Number(tl.minGap) || 1) });
  const shown = m.empty ? [] : m.gaps.filter((g) => !g.ignored);
  const text = [summaryText(m, { label: v.def ? v.def.name : 'Timeline' }), pointsText(shownPoints)].filter(Boolean).join('\n');
  // The range drawn: the measured periods, widened to every pointer and bar shown, unless From or To is set.
  const dates = [...v.lanes.flatMap((l) => l.bars.flatMap((b) => [b.start, b.end || today])), ...shownPoints.map((p) => p.at), ...(m.empty ? [] : [m.from, m.to])].sort();
  const range = { from: tl.from || dates[0], to: tl.to || dates.at(-1) };

  // ✦ Enhanced: find periods in the notes, explain the gaps, and the suggestions waiting to be checked.
  const enh = [];
  if (tools.mode.timeline === 'enhanced') {
    const gate = enhancedGate(context);
    const notes = gate ? [] : caseNotes(c);
    if (gate) enh.push(gate);
    else {
      enh.push(h('div', { class: 'disclose' }, '✦ Sends the case notes and the timeline summary to your organisation’s AI gateway. You check a redacted preview first.'));
      if (!notes.length) enh.push(h('div', { class: 'card' }, h('p', {}, 'Enhanced timeline reads dates written in case notes. Clip a case notes page first.')));
      else {
        enh.push(h('div', { class: 'row' },
          h('button', { type: 'button', class: 'magic', 'data-key': 'tl-find', disabled: !!tl.busy, onclick: () => findPeriods(context, notes) }, tl.busy === 'find' ? [h('span', { class: 'spinner' }), ' Reading notes…'] : '✦ Find dates in notes'),
          m.empty ? null : h('button', { type: 'button', class: 'magic', 'data-key': 'tl-explain', disabled: !!tl.busy, onclick: () => explain(context, m, notes) }, tl.busy === 'explain' ? [h('span', { class: 'spinner' }), ' Writing…'] : '✦ Explain the gaps')));
      }
      for (const p of (c.aiPeriods || []).filter((x) => !x.accepted && !x.dismissed)) enh.push(suggestion(context, p));
      if (tl.explain) {
        enh.push(h('div', { class: 'ai-card', role: 'region', 'aria-label': 'Explanation from the AI' },
          h('h4', {}, '✦ What the notes say about the gaps'),
          tl.explain.text ? h('p', {}, tl.explain.text) : h('p', { class: 'error-text' }, 'The explanation couldn’t be restored exactly, so it isn’t shown.'),
          h('div', { class: 'row' },
            h('button', { type: 'button', class: 'sm', 'data-key': 'tl-ex-save', onclick: () => act.update((cs) => addWorking(cs, { title: '✦ Timeline explanation', text: `${text}\n\nExplanation (AI, checked by the caseworker):\n${tl.explain.text}`, uses: tl.explain.uses }), 'Saved to the case’s workings') }, 'Save to case'),
            h('button', { type: 'button', class: 'link sm', 'data-key': 'tl-ex-clear', onclick: () => { tl.explain = null; act.render(); } }, 'Clear'))));
      }
    }
  }
  const anything = all.length || defs.length || v.items.length || v.lanes.length;
  if (!anything) {
    return [head, h('div', { class: 'card' }, h('h3', {}, 'No dates yet'), h('p', { class: 'muted' }, 'Clip a page with dated history, such as employment and income, and its periods appear here.')), ...enh];
  }

  const showSel = h('label', { class: 'field' }, 'Show',
    h('select', { 'data-key': 'tl-show', onchange: (e) => { tl.show = e.target.value; act.render(); } },
      defs.length ? h('optgroup', { label: showLabel(c) }, defs.map((d) => h('option', { value: `def:${d.id}`, selected: tl.show === `def:${d.id}` }, d.name))) : null,
      h('option', { value: 'ticked', selected: tl.show === 'ticked' }, 'Only the ticked dates'),
      h('option', { value: 'all', selected: tl.show === 'all' }, 'All dates in the case')));
  const legend = h('ul', { class: 'plain stack', style: 'gap:2px', 'aria-label': 'Key' }, v.lanes.map((l) => h('li', { class: 'row small', style: 'gap:6px;flex-wrap:nowrap' },
    h('span', { class: 'sw', style: `--g:${l.colour};margin-top:0${l.bars.length ? '' : ';border-radius:50%'}` }),
    h('span', {}, l.label), h('span', { class: 'muted' }, [l.bars.length ? plural(l.bars.length, 'period') : '', l.points.length ? plural(l.points.length, 'date') : ''].filter(Boolean).join(', '))), ));
  const ticks = tl.show === 'ticked' ? [
    cats.length ? h('div', { class: 'chips', role: 'group', 'aria-label': 'Kinds of period' }, cats.map((cat) => h('button', {
      type: 'button', 'data-key': `tl-cat-${cat}`, 'aria-pressed': String(tl.cats.has(cat)),
      onclick: () => { if (tl.cats.has(cat)) tl.cats.delete(cat); else tl.cats.add(cat); act.render(); },
    }, h('span', { class: 'sw', style: `--g:${COLOURS[cat]};width:9px;height:9px;margin-top:0` }), cat))) : null,
    h('div', { class: 'tl-items', role: 'group', 'aria-label': 'Periods and dates' }, v.items.map((p) => h('label', { class: `tl-item${!p.off && !tl.off.has(p.id) ? '' : ' off'}` },
      h('input', { type: 'checkbox', 'data-key': `tl-${p.id}`, checked: !tl.off.has(p.id), disabled: !!p.off, onchange: (e) => { if (e.target.checked) tl.off.delete(p.id); else tl.off.add(p.id); act.render(); } }),
      h('span', { class: 'sw', style: `--g:${p.colour};margin-top:0${p.at ? ';border-radius:50%' : ''}` }),
      h('span', {}, p.at ? `${p.lane}: ${p.label}` : p.label, String(p.id).startsWith('ai:') ? h('span', { class: 'pill magic', style: 'margin-left:4px' }, '✦') : null, p.approx ? h('span', { class: 'small muted' }, ' (approximate)') : null),
      h('span', { class: 'd' }, p.at ? fmtDay(p.at) : `${monthYear(p.start)} – ${p.end ? monthYear(p.end) : 'now'}`)))),
  ] : [legend, h('p', { class: 'small muted' }, v.def ? 'The flow sets this timeline’s series, colours and shapes.' : 'Every period and date in the case. Choose “Only the ticked dates” to leave some out.')];
  const controls = h('div', { class: 'stack' }, showSel, ...ticks,
    h('div', { class: 'row', style: 'flex-wrap:nowrap' },
      h('label', { class: 'field', style: 'flex:1' }, 'From', h('input', { type: 'date', 'data-key': 'tl-from', value: tl.from || range.from || '', onchange: (e) => { tl.from = e.target.value; act.render(); } })),
      h('label', { class: 'field', style: 'flex:1' }, 'To', h('input', { type: 'date', 'data-key': 'tl-to', value: tl.to || range.to || '', onchange: (e) => { tl.to = e.target.value; act.render(); } }))),
    v.gapBars.length ? h('label', { class: 'field' }, 'Ignore short gaps',
      h('select', { 'data-key': 'tl-min', onchange: (e) => { tl.minGap = Number(e.target.value); act.render(); } }, MIN_GAPS.map(([val, l]) => h('option', { value: String(val), selected: val === Number(tl.minGap) }, l)))) : null,
    tl.from || tl.to ? h('button', { type: 'button', class: 'link sm', 'data-key': 'tl-reset', onclick: () => { tl.from = ''; tl.to = ''; act.render(); } }, 'Reset dates to what’s shown') : null);
  const uses = [...new Set(v.lanes.flatMap((l) => [...l.bars, ...l.points]).map((p) => p.clipId).filter(Boolean))];
  const actions = h('div', { class: 'row' },
    h('button', { type: 'button', class: 'sm', 'data-key': 'tl-save', onclick: async () => { try { await assertTool('timeline'); } catch (e) { announce(e.message); return; } act.update((cs) => {
      addWorking(cs, { title: v.def ? `Timeline: ${v.def.name}` : 'Timeline', text, uses });
      logEvent(cs, 'save_timeline', { detail: `${m.empty ? 0 : m.gaps.length} gaps` });
    }, 'Timeline saved to the case’s workings'); } }, 'Save summary to case'),
    h('button', { type: 'button', class: 'sm', 'data-key': 'tl-copy', onclick: () => copyText(text, 'Summary') }, 'Copy summary'));
  const dateList = shownPoints.length ? h('ul', { class: 'plain stack small', style: 'gap:2px', 'aria-label': 'Dates' }, shownPoints.map((p) => h('li', {}, h('b', {}, fmtDay(p.at)), ` · ${p.lane === p.label ? p.label : `${p.lane}: ${p.label}`}`))) : null;
  const bad = tl.from && tl.to && tl.from > tl.to;
  const viz = bad || !range.from || !v.lanes.length ? [h('div', { class: 'card' }, h('p', { class: 'muted' }, bad ? 'The From date must be before the To date.' : tl.show === 'ticked' ? 'Tick at least one period or date to draw the timeline.' : 'Nothing to draw yet: clip the pages this timeline reads.'))] : [
    m.empty ? null : h('div', { class: 'stats' },
      stat('Including gaps', dur(m.span), `${m.span.toLocaleString('en-GB')} days`),
      stat('Excluding gaps', dur(m.covered), `${m.covered.toLocaleString('en-GB')} days${m.ignored.days ? `, after taking out ${plural(m.ignored.days, 'day')} in short gaps` : ''}`),
      stat('Gaps', String(shown.length), `${m.gapDays.toLocaleString('en-GB')} days in total`, shown.length ? 'bad' : ''),
      stat('Longest gap', m.longest ? dur(m.longest.days) : '–', m.longest ? fmtDay(m.longest.start) : 'none')),
    picture(range, v.lanes, wide ? 560 : 352, m.empty ? null : m, shown),
    h('p', { class: 'small muted' }, m.empty ? `${fmtDay(range.from)} to ${fmtDay(range.to)}. No periods here count towards gaps.` : `${fmtDay(m.from)} to ${fmtDay(m.to)}. Overlapping periods count once. Days are exact and include both ends; months and years are approximate.`),
    m.approx?.length ? h('p', { class: 'notice warn small' }, `${plural(m.approx.length, 'period')} with approximate dates ${m.approx.length === 1 ? 'is' : 'are'} drawn faded and left out of these totals until a date is confirmed.`) : null,
    m.empty ? null : changes(m),
    dateList,
    actions,
  ];
  return [head, h('div', { class: wide ? 'tool-grid wide' : 'tool-grid' }, h('div', { class: 'stack' }, controls, enh), h('div', { class: 'stack' }, viz))];
}

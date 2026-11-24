// The timeline: periods of employment, benefits, tenancy and sickness from the case, with exact gaps.
// Days are exact and inclusive; months and years are approximate and labelled so. Pure functions.

export const dayNum = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 864e5); };
export const isoOf = (n) => new Date(n * 864e5).toISOString().slice(0, 10);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const fmtDay = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${d} ${MON[m - 1]} ${y}`; };

/**
 * Periods: period rows from clips, and AI periods the caseworker accepted. An AI period whose dates are
 * approximate ("mid-January") keeps that precision and stays out of exact totals until a date is confirmed.
 * { id, cat, label, sub, start, end | null, clipId, approx }
 */
export function periods(c) {
  const out = [];
  for (const cl of c.clips) {
    for (const r of cl.records || []) {
      if (r.type !== 'period' || !/^\d{4}-\d{2}-\d{2}$/.test(r.start || '')) continue;
      out.push({ id: `${cl.id}:${r.id}`, cat: r.cat || 'Other', label: r.label || 'Period', sub: r.sub || '', start: r.start, end: /^\d{4}-\d{2}-\d{2}$/.test(r.end || '') ? r.end : null, clipId: cl.id, approx: false });
    }
  }
  for (const p of c.aiPeriods || []) if (p.accepted && !p.dismissed) out.push({ ...p, id: `ai:${p.id}`, approx: !!p.approx });
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

// The kinds of period, in the order the timeline draws them. AI-found periods use the same list.
export const PERIOD_CATS = ['Employment', 'Benefit', 'Tenancy', 'Sickness', 'Other'];

// "about 1 year 2 months" (or "1y 2m" with short): approximate, for reading; days are the exact figure.
export function approxDuration(days, { short = false } = {}) {
  if (days < 45) return `${days} day${days === 1 ? '' : 's'}`;
  const y = Math.floor(days / 365.25);
  const m = Math.floor((days - y * 365.25) / 30.44);
  if (short) return [y ? `${y}y` : '', m ? `${m}m` : ''].filter(Boolean).join(' ') || '0m';
  return `about ${[y ? `${y} year${y === 1 ? '' : 's'}` : '', m ? `${m} month${m === 1 ? '' : 's'}` : ''].filter(Boolean).join(' ') || '0 months'}`;
}

/**
 * The timeline for the chosen periods. opts: { today, from, to, minGap } (minGap: gaps shorter than this many
 * days are hidden from the list but still counted and stated). Returns spans, transitions and exact totals.
 */
export function timeline(list, { today, from, to, minGap = 1 } = {}) {
  const exact = list.filter((p) => !p.approx);
  const approx = list.filter((p) => p.approx);
  const t = dayNum(today);
  const iv = exact.map((p) => ({ s: dayNum(p.start), e: p.end ? dayNum(p.end) : t, p })).filter((x) => x.e >= x.s);
  if (!iv.length) return { empty: true, approx };
  const lo = from ? dayNum(from) : Math.min(...iv.map((x) => x.s));
  const hi = to ? dayNum(to) : Math.max(...iv.map((x) => x.e));
  const clipped = iv.map((x) => ({ ...x, s: Math.max(x.s, lo), e: Math.min(x.e, hi) })).filter((x) => x.e >= x.s).sort((a, b) => a.s - b.s || a.e - b.e);
  const merged = [];
  const transitions = [];
  for (const x of clipped) {
    const last = merged[merged.length - 1];
    if (!last) { if (x.s > lo) transitions.push(gap(lo, x.s - 1, null, x.p, minGap)); merged.push({ s: x.s, e: x.e, from: x.p, until: x.p }); continue; }
    if (x.s > last.e + 1) { transitions.push(gap(last.e + 1, x.s - 1, last.until, x.p, minGap)); merged.push({ s: x.s, e: x.e, from: x.p, until: x.p }); }
    else {
      transitions.push({ kind: x.s === last.e + 1 ? 'join' : 'overlap', at: isoOf(x.s), prev: last.until.label, next: x.p.label, days: x.s <= last.e ? Math.min(last.e, x.e) - x.s + 1 : 0 });
      if (x.e > last.e) { last.e = x.e; last.until = x.p; }
    }
  }
  const tail = merged[merged.length - 1];
  if (tail.e < hi) transitions.push(gap(tail.e + 1, hi, tail.until, null, minGap));
  const gaps = transitions.filter((x) => x.kind === 'gap');
  let n = 0;
  gaps.forEach((g) => { if (!g.ignored) g.n = ++n; });
  const span = hi - lo + 1;
  const covered = merged.reduce((s, m) => s + m.e - m.s + 1, 0);
  const counted = gaps.filter((g) => !g.ignored);
  return {
    empty: false, from: isoOf(lo), to: isoOf(hi), span, covered, approx,
    gapDays: gaps.reduce((s, g) => s + g.days, 0), // exact: every uncovered day, short gaps included
    shownGapDays: counted.reduce((s, g) => s + g.days, 0),
    ignored: { count: gaps.length - counted.length, days: gaps.filter((g) => g.ignored).reduce((s, g) => s + g.days, 0) },
    longest: counted.reduce((m, g) => (g.days > (m?.days || 0) ? g : m), null),
    gaps, transitions, merged: merged.map((m) => ({ start: isoOf(m.s), end: isoOf(m.e), days: m.e - m.s + 1 })),
  };
}

function gap(s, e, prev, next, minGap) {
  const days = e - s + 1;
  return { kind: 'gap', start: isoOf(s), end: isoOf(e), days, prev: prev?.label || null, next: next?.label || null, ignored: days < minGap };
}

export function summaryText(m, { label = 'Timeline' } = {}) {
  if (m.empty) return `${label}: no dated periods selected.`;
  const lines = [`${label}, ${fmtDay(m.from)} to ${fmtDay(m.to)} (${m.span} days)`,
    `Covered: ${m.covered} days. Not covered: ${m.gapDays} days in ${m.gaps.length} gap${m.gaps.length === 1 ? '' : 's'}.`];
  if (m.ignored.count) lines.push(`${m.ignored.count} gap${m.ignored.count === 1 ? '' : 's'} shorter than the minimum (${m.ignored.days} days in all) ${m.ignored.count === 1 ? 'is' : 'are'} counted but not listed.`);
  for (const g of m.gaps.filter((x) => !x.ignored)) lines.push(`  Gap ${g.n}: ${fmtDay(g.start)} to ${fmtDay(g.end)}, ${g.days} days (${approxDuration(g.days)})${g.prev ? ` after ${g.prev}` : ''}${g.next ? `, before ${g.next}` : ''}`);
  if (m.approx.length) lines.push(`${m.approx.length} period${m.approx.length === 1 ? ' has' : 's have'} approximate dates and ${m.approx.length === 1 ? 'is' : 'are'} not in these totals.`);
  return lines.join('\n');
}

// Single dates (pointers) under the summary: "Dates: Date of birth 12 Mar 1985; Payment 6 Jan 2026".
export function pointsText(points) {
  if (!points.length) return '';
  return `Dates:\n${points.map((p) => `  ${p.lane ? `${p.lane}: ` : ''}${p.label}, ${fmtDay(p.at)}`).join('\n')}`;
}

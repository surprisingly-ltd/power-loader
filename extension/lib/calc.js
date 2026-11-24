// The calculator: which amounts in the case add up to a figure, such as the landlord's arrears. All local.
// Pure functions, shared with the cancellable worker in tools/calc-worker.js.
import { validateValue } from './fields.js';

export const LIMITS = Object.freeze({ maxAmounts: 60, maxK: 6, results: 50, nodes: 3_000_000 });

export const TARGET = 'arrears';
const FREQ = { weeklyIncome: 'weekly', monthlyRent: 'monthly', ucAward: 'monthly' };

/**
 * Amounts the calculator can use. Transactions (money rows from clips) by default; the case's own money
 * values are opt-in and labelled with their frequency. { id, label, date?, amount, clipId, kind, frequency? }
 */
export function amounts(c, lib) {
  const out = [];
  for (const cl of c.clips) {
    for (const r of cl.records || []) {
      if (r.type !== 'money' || r.amount == null) continue;
      out.push({ id: `${cl.id}:${r.id}`, label: r.label || 'Payment', date: r.date || null, amount: Number(r.amount), clipId: cl.id, kind: 'transaction', source: cl.name });
    }
    for (const [key, v] of Object.entries(cl.values)) {
      // The arrears figure is what the amounts are matched against, not one of them.
      if (lib.fields[key]?.type !== 'money' || key === TARGET || c.excluded.includes(`${cl.id}:${key}`)) continue;
      const check = validateValue(lib.fields[key], v);
      if (check.ok) out.push({ id: `${cl.id}:${key}`, label: lib.fields[key].label, amount: Number(check.value), clipId: cl.id, kind: 'value', key, frequency: lib.fields[key].frequency || FREQ[key] || null, source: cl.name });
    }
  }
  return out;
}

export const pence = (n) => Math.round(Number(n) * 100);

// What a result was computed from: when any of it changes, the result is stale.
export const inputSignature = ({ target, chosen, maxK, tol }) => JSON.stringify([pence(target), chosen.map((a) => [a.id, pence(a.amount)]).sort(), maxK, pence(tol)]);

/**
 * Combinations of at most maxK amounts whose total is within tol of the target, smallest first. Exact in
 * pence. Searches at most LIMITS.nodes steps and LIMITS.results answers, and says when it stopped early.
 */
export function solve(chosen, target, { maxK = 4, tol = 0 } = {}) {
  if (!Number.isFinite(Number(target)) || Number(target) <= 0) throw new Error('Enter the figure to make, such as the arrears');
  if (chosen.some((a) => a.amount < 0)) throw new Error('Adjustments aren’t supported yet: remove negative amounts');
  if (chosen.length > LIMITS.maxAmounts) throw new Error(`Choose at most ${LIMITS.maxAmounts} amounts`);
  const k = Math.min(Math.max(1, maxK), LIMITS.maxK);
  const t = pence(target);
  const tl = Math.max(0, pence(tol));
  const arr = chosen.map((a) => ({ ...a, p: pence(a.amount) })).filter((a) => a.p > 0).sort((a, b) => b.p - a.p);
  const suffix = arr.map((_, i) => arr.slice(i).reduce((s, a) => s + a.p, 0));
  const res = [];
  let nodes = 0;
  let truncated = false;
  const pick = [];
  (function go(start, sum) {
    if (truncated) return;
    if (++nodes > LIMITS.nodes) { truncated = true; return; }
    if (pick.length && Math.abs(sum - t) <= tl) {
      res.push({ items: pick.map((i) => arr[i]), total: sum / 100, diff: (sum - t) / 100 });
      if (res.length >= LIMITS.results) { truncated = true; return; }
    }
    if (pick.length >= k) return;
    for (let j = start; j < arr.length; j++) {
      if (sum + arr[j].p > t + tl) continue; // amounts are positive: too big now stays too big
      if (sum + suffix[j] < t - tl) break; // everything left can't reach the target
      pick.push(j);
      go(j + 1, sum + arr[j].p);
      pick.pop();
      if (truncated) return;
    }
  })(0, 0);
  res.sort((a, b) => a.items.length - b.items.length || Math.abs(a.diff) - Math.abs(b.diff));
  return { list: res, truncated, nodes, limits: { maxK: k, tol: tl / 100, results: LIMITS.results } };
}

export function workingText(combo, target, { label = 'Target' } = {}) {
  const lines = combo.items.map((a) => `  ${a.date || '          '}  ${a.label.padEnd(22).slice(0, 22)}  £${a.amount.toFixed(2)}${a.frequency ? ` (${a.frequency})` : ''}  [${a.source}]`);
  return [`${label}: £${Number(target).toFixed(2)}`, ...lines, `  Total: £${combo.total.toFixed(2)}${combo.diff ? ` (${combo.diff > 0 ? '+' : ''}£${combo.diff.toFixed(2)})` : ''}`].join('\n');
}

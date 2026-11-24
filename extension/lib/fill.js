// The fill plan: what "Fill this form" would put in each box, shown before anything touches the page.
// Only settled, valid values are filled; conflicts, missing and invalid values are skipped and listed.
// Pure functions, no browser APIs.
import { fieldState, settled } from './case.js';
import { display, norm } from './fields.js';
import { canonical } from './hash.js';

// The fill profile for a form: a tested fill draft in use on this computer, or the library's.
export function fillProfileForCase(lib, formId, drafts = []) {
  const draft = drafts.find((d) => d.kind === 'fill' && d.use && d.profile.form?.id === formId && d.tested?.ok && d.tested.snapshot === canonical(d.profile));
  if (draft) return { ...draft.profile, draft: draft.id };
  const form = lib.forms[formId];
  return lib.fill.find((p) => p.id === form?.fill) || lib.fill.find((p) => p.form?.id === formId) || null;
}

/**
 * plan: { formId, profile: { id, version, draft? }, rows: [Row], unmatched: [{ target, label }], sideEffects }
 * Row: { target, label, key, value, display, sources: [clip name], status: 'fill' | 'conflict' | 'missing' | 'invalid' | 'unknown', reason? }
 * controls: the page's boxes (describeForm), to label rows and list boxes the profile doesn't cover.
 */
export function buildFillPlan(c, lib, formId, profile, controls = []) {
  const byTarget = new Map(controls.map((ctl) => [ctl.selector, ctl]));
  const rows = Object.entries(profile.fields || {}).map(([target, path]) => {
    const key = String(path).replace(/^CaseData\./, '');
    const def = lib.fields[key];
    const label = byTarget.get(target)?.label || def?.label || target;
    if (!def) return { target, label, key, status: 'unknown', reason: 'Not a case field' };
    const st = fieldState(c, lib, key);
    if (st.status === 'conflict') return { target, label, key, status: 'conflict', reason: 'Sources disagree: decide first' };
    if (!settled(st.status)) return { target, label, key, status: 'missing', reason: 'Not in the case yet' };
    if (!st.valid) return { target, label, key, status: 'invalid', reason: `Needs fixing: ${st.error}` };
    const clips = st.status === 'manual' ? [] : st.cands.filter((x) => x.n === norm(def, st.value)).flatMap((x) => x.sources);
    const sources = st.status === 'manual' ? ['typed by you'] : clips.map((id) => c.clips.find((cl) => cl.id === id)?.name).filter(Boolean);
    return { target, label, key, value: st.normalised, display: display(def, st.normalised), sources: st.status === 'resolved' ? ['your choice', ...sources] : sources, clips, status: 'fill' };
  });
  const covered = new Set(rows.map((r) => r.target));
  const unmatched = controls.filter((ctl) => !covered.has(ctl.selector)).map((ctl) => ({ target: ctl.selector, label: ctl.label }));
  return {
    formId, profile: { id: profile.id, version: profile.version, ...(profile.draft ? { draft: profile.draft } : {}) },
    rows, unmatched, sideEffects: lib.forms[formId]?.sideEffects || [],
  };
}

// What is sent to the page: only the boxes the plan fills.
export const approvedItems = (plan) => plan.rows.filter((r) => r.status === 'fill').map((r) => ({ target: r.target, value: r.value }));

// The kept record of a fill: the text report the sidebar shows, and what went where (for "check again").
export function fillRecord(plan, report, at = new Date().toISOString()) {
  const failed = new Map(report.failed.map((f) => [f.target, f.reason]));
  const done = new Set(report.filled.map((f) => f.target));
  return {
    at, profile: plan.profile,
    items: plan.rows.filter((r) => done.has(r.target)).map((r) => ({ box: r.target, key: r.key, value: r.value, clips: r.clips })),
    report: {
      filled: plan.rows.filter((r) => done.has(r.target)).map((r) => ({ label: r.label, display: r.display })),
      skipped: plan.rows.filter((r) => r.status !== 'fill').map((r) => ({ label: r.label, reason: r.reason })),
      failed: plan.rows.filter((r) => failed.has(r.target)).map((r) => ({ label: r.label, reason: failed.get(r.target) })),
      unmatched: plan.unmatched.map((u) => ({ label: u.label })),
    },
  };
}

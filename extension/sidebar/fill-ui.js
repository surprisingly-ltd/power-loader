// "Fill this form": a dry-run plan first, then values only, then a text report that stays.
import { h, plural, time, announce, describeError } from '../ui/dom.js';
import { openDialog } from '../ui/dialog.js';
import { ask, describeForm, pageLogInfo, updateCase } from '../lib/core.js';
import { approvedItems, buildFillPlan, fillProfileForCase, fillRecord } from '../lib/fill.js';
import { fillStale } from '../lib/case.js';
import { logEvent } from '../lib/activity.js';
import { recordFailure } from '../lib/diagnostics.js';

const STATUS = { conflict: 'Conflict', missing: 'Missing', invalid: 'Needs fixing', unknown: 'Unknown field' };

function reportView(record, stale) {
  const r = record.report;
  const list = (title, items, render, open = false) => (items.length ? h('details', { open },
    h('summary', {}, `${title} (${items.length})`),
    h('ul', { class: 'impact small' }, items.map((x) => h('li', {}, render(x))))) : null);
  return h('div', { class: 'stack', style: 'gap:6px' },
    h('div', { class: 'diff' },
      h('span', { class: 'pill ok' }, `✓ ${r.filled.length} filled`),
      r.skipped.length ? h('span', { class: 'pill warn' }, `${r.skipped.length} left empty`) : null,
      r.failed.length ? h('span', { class: 'pill bad' }, `✕ ${r.failed.length} failed`) : null,
      r.unmatched.length ? h('span', { class: 'pill' }, `${r.unmatched.length} not in the profile`) : null),
    h('p', { class: 'small' }, `Filled at ${time(record.at)} with ${record.profile.id} ${record.profile.version}${record.profile.draft ? ' (your draft)' : ''}.`),
    list('Filled', r.filled, (x) => [h('b', {}, x.label), `: ${x.display}`], stale),
    list('Left empty', r.skipped, (x) => [h('b', {}, x.label), `: ${x.reason}`], true),
    list('Failed', r.failed, (x) => [h('b', {}, x.label), `: ${x.reason}`], true),
    list('Boxes the profile doesn’t fill', r.unmatched, (x) => x.label),
    h('p', { class: 'small' }, h('b', {}, 'Next: '), 'check the form, complete anything empty, then submit it yourself. Power Loader never submits.'));
}

export function fillBlock(context, form) {
  const { data, lib } = context;
  const c = data.case;
  const record = c.filled[form.id];
  const stale = fillStale(c, lib, form.id);
  return [
    record ? reportView(record, !!stale) : null,
    h('button', { type: 'button', class: record ? 'sm' : 'primary big', 'data-key': `fill-${form.id}`, onclick: () => openFillPlan(context, form) }, record ? 'Fill again' : 'Fill this form'),
  ];
}

async function openFillPlan(context, form) {
  const { ui, data, lib, act } = context;
  const profile = fillProfileForCase(lib, form.id, data.drafts);
  if (!profile) { announce('The library has no fill profile for this form'); return; }
  let described;
  try { described = await describeForm(ui.page.id); } catch (e) { announce(`Couldn’t read the form: ${describeError(e)}`); return; }
  const controls = [...described.controls, ...described.groups.flatMap((g) => g.controls)];
  const plan = buildFillPlan(data.case, lib, form.id, profile, controls);
  const fillRows = plan.rows.filter((r) => r.status === 'fill');
  const skipped = plan.rows.filter((r) => r.status !== 'fill');
  const target = { tabId: ui.page.id, url: described.url, documentId: described.documentId, caseId: data.case.id };
  openDialog({
    title: `Fill ${form.name}`, wide: true,
    body: (dlg) => [
      h('p', {}, `Nothing is put into the page until you choose “Fill ${plural(fillRows.length, 'box', 'boxes')}”. Only values are set: Power Loader clicks nothing and never submits.`),
      plan.sideEffects.length ? h('div', { class: 'notice warn' }, h('b', {}, 'This form reacts when boxes change: '), plan.sideEffects.join(' ')) : null,
      fillRows.length ? h('table', { class: 'grid' },
        h('caption', { class: 'sr' }, 'Boxes that will be filled'),
        h('thead', {}, h('tr', {}, h('th', {}, 'Box'), h('th', {}, 'Value'), h('th', {}, 'From'))),
        h('tbody', {}, fillRows.map((r) => h('tr', {}, h('td', {}, r.label), h('td', {}, r.display), h('td', { class: 'small' }, r.sources.join(', ') || '—')))))
        : h('p', { class: 'notice warn' }, 'Nothing can be filled yet.'),
      skipped.length ? h('div', {}, h('b', {}, `Left empty (${skipped.length})`), h('ul', { class: 'impact small' }, skipped.map((r) => h('li', {}, h('b', {}, r.label), `: ${STATUS[r.status]}. ${r.reason}`)))) : null,
      plan.unmatched.length ? h('details', {}, h('summary', {}, `Boxes on the page the profile doesn’t fill (${plan.unmatched.length})`), h('ul', { class: 'impact small' }, plan.unmatched.map((u) => h('li', {}, u.label)))) : null,
      h('div', { class: 'actions' },
        h('button', { type: 'button', onclick: () => dlg.close() }, 'Cancel'),
        h('button', {
          type: 'button', class: 'primary', disabled: !fillRows.length,
          onclick: async () => {
            dlg.close();
            await applyPlan(form, plan, target);
            act.refresh();
          },
        }, `Fill ${plural(fillRows.length, 'box', 'boxes')}`)),
    ],
  });
}

async function applyPlan(form, plan, target) {
  try {
    const report = await ask(target.tabId, { type: 'powerloader:fill', url: target.url, documentId: target.documentId, plan: { items: approvedItems(plan) } });
    const record = fillRecord(plan, report);
    await updateCase(target.caseId, (c, l) => {
      c.filled[form.id] = record;
      logEvent(c, 'fill_form', { page: pageLogInfo(l, { url: target.url, formId: form.id }), detail: `${form.id} · ${record.report.filled.length} filled, ${record.report.skipped.length} left empty${record.report.failed.length ? `, ${record.report.failed.length} failed` : ''}` });
    });
    announce(`Filled ${plural(record.report.filled.length, 'box', 'boxes')}${record.report.failed.length ? `; ${record.report.failed.length} failed` : ''}. Check the form before you submit it.`);
  } catch (e) {
    if (e.name !== 'CaseEnded') void recordFailure('fill');
    announce(e.name === 'CaseEnded' ? 'That case has ended' : `Filling failed: ${describeError(e)}`);
  }
}

// The Activity log page: every event on this computer, from the open case and the kept logs. Search,
// filters, notes, removal and download. It replaces the sidebar while open.
/* global browser */
import { h, rerender, announce, plural } from '../ui/dom.js';
import { openDialog, confirmDialog } from '../ui/dialog.js';
import { logTable } from '../ui/log-table.js';
import { saveFile } from '../ui/download.js';
import { mutateStorage } from '../lib/storage.js';
import { ACTIVITIES, allRows, applyRetention, exportRows, noteKept, removeEvents, removeKept, toCsv, withNote } from '../lib/activity.js';
import { getPolicy } from '../lib/policy.js';
import { returnToSidebar } from '../lib/pages.js';
import { updateCase } from '../lib/core.js';

const ui = { q: '', caseF: '', actF: '', typeF: '', notesOnly: false, selected: new Set(), editing: null, noteDraft: {} };
let data = { rows: [] };

async function load() {
  const { case: c, teardown, processLog = [] } = await browser.storage.local.get(['case', 'teardown', 'processLog']);
  const policy = await getPolicy().catch(() => ({ values: { activityLog: {} } }));
  data = { case: c && !teardown ? c : null, processLog, policy, rows: allRows(c && !teardown ? c : null, processLog) };
}

function filtered() {
  const q = ui.q.trim().toLowerCase();
  return data.rows.filter(({ event: e, caseId }) => (!ui.caseF || caseId === ui.caseF) && (!ui.actF || e.activity === ui.actF) && (!ui.typeF || e.page_type === ui.typeF)
    && (!ui.notesOnly || e.note) && (!q || [caseId, e.activity, ACTIVITIES[e.activity], e.page_type, e.url_pattern, e.detail, e.note].some((v) => String(v || '').toLowerCase().includes(q))));
}

async function saveNote(row, note) {
  if (row.current) await updateCase(row.caseId, (c) => { c.log = c.log.map((e) => (e.id === row.event.id ? withNote(e, note) : e)); }).catch(() => announce('That case has ended'));
  else await mutateStorage(({ processLog = [] }) => ({ patch: { processLog: noteKept(processLog, row.event.id, note) } }), ['processLog']);
  ui.editing = null;
  delete ui.noteDraft[row.event.id];
  announce(note.trim() ? 'Note saved on this computer' : 'Note removed');
  await refresh();
}

async function removeSelected() {
  const ids = [...ui.selected];
  const ok = await confirmDialog({
    title: `Remove ${plural(ids.length, 'item')} from the log?`,
    text: 'They are deleted from this browser and left out of later downloads and uploads. You can’t undo this.',
    confirm: `Remove ${plural(ids.length, 'item')}`, danger: true,
  });
  if (!ok) return;
  const current = new Set(data.case?.log.map((e) => e.id) || []);
  if (data.case && ids.some((id) => current.has(id))) await updateCase(data.case.id, (c) => removeEvents(c, ids.filter((id) => current.has(id)))).catch(() => {});
  await mutateStorage(({ processLog = [] }) => ({ patch: { processLog: removeKept(processLog, ids.filter((id) => !current.has(id))) } }), ['processLog']);
  ui.selected.clear();
  announce(`${plural(ids.length, 'item')} removed`);
  await refresh();
}

function downloadDialog(format) {
  const rows = filtered();
  const state = { notes: false };
  const withNotes = rows.filter((r) => r.event.note).length;
  const name = `power-loader-activity-${new Date().toISOString().slice(0, 10)}.${format}`;
  const text = () => {
    const out = exportRows(rows, { notes: state.notes, coarse: !!data.policy.values.activityLog.coarseTimestamps });
    return format === 'csv' ? toCsv(out) : JSON.stringify(out, null, 2);
  };
  openDialog({
    title: `Download ${format.toUpperCase()}`, wide: true,
    body: (dlg) => [
      h('p', {}, `${plural(rows.length, 'item')}${rows.length !== data.rows.length ? ' matching your filters' : ''}. Links are patterns, not real addresses. Saved as `, h('b', {}, name), '.'),
      data.policy.values.activityLog.notes === false ? null : h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: state.notes, onchange: (e) => { state.notes = e.target.checked; dlg.refresh(); } }),
        h('span', {}, `Include notes (${plural(withNotes, 'item')} ${withNotes === 1 ? 'has' : 'have'} one). Notes are free text, so read them for client details before you share the file.`)),
      h('pre', { class: 'json', tabindex: '0', 'aria-label': 'File contents' }, text().slice(0, 20000)),
      h('div', { class: 'actions' },
        h('button', { type: 'button', onclick: () => dlg.close() }, 'Close'),
        h('button', { type: 'button', class: 'primary', onclick: async () => { await saveFile(name, text(), format === 'csv' ? 'text/csv' : 'application/json'); dlg.close(); announce(`Saved ${name}`); } }, 'Save file')),
    ],
  });
}

function render() {
  const rows = filtered();
  const cases = [...new Set(data.rows.map((r) => r.caseId))];
  const types = [...new Set(data.rows.map((r) => r.event.page_type).filter(Boolean))].sort();
  const acts = [...new Set(data.rows.map((r) => r.event.activity))];
  const sel = (key, label, value, options, set) => h('label', { class: 'field', style: 'flex:1 1 170px' }, label,
    h('select', { 'data-key': key, onchange: (e) => { set(e.target.value); render(); } }, [h('option', { value: '' }, 'All'), ...options.map(([v, l]) => h('option', { value: v, selected: v === value }, l))]));
  rerender(document.getElementById('app'),
    h('div', { class: 'page-head' },
      h('div', {}, h('div', { class: 'eyebrow' }, 'All cases on this computer'), h('h1', {}, 'Activity log'),
        h('div', { class: 'meta' }, `${plural(data.rows.length, 'event')} from ${plural(cases.length, 'case')}${data.policy.values.activityLog.retentionDays ? ` · kept logs are deleted after ${data.policy.values.activityLog.retentionDays} days` : ''}`)),
      h('div', { class: 'row' },
        h('button', { type: 'button', 'data-key': 'back', onclick: async () => { const r = await returnToSidebar(); if (!r.ok) announce(r.reason); } }, 'Back to the sidebar'),
        h('button', { type: 'button', 'data-key': 'json', disabled: !rows.length, onclick: () => downloadDialog('json') }, 'Download JSON'),
        h('button', { type: 'button', class: 'primary', 'data-key': 'csv', disabled: !rows.length, onclick: () => downloadDialog('csv') }, 'Download CSV'))),
    h('p', { class: 'notice small' }, 'The log records how cases move through approved systems, for process improvement: page types, link patterns, field labels and counts, never field values. Other browsing is not recorded. Notes stay on this computer and are left out of downloads unless you include them.'),
    h('div', { class: 'lg-filters' },
      h('label', { class: 'field', style: 'flex:2 1 240px' }, 'Search', h('input', { type: 'search', 'data-key': 'q', value: ui.q, oninput: (e) => { ui.q = e.target.value; render(); } })),
      sel('caseF', 'Case', ui.caseF, cases.map((c) => [c, c]), (v) => { ui.caseF = v; }),
      sel('actF', 'Activity', ui.actF, acts.map((a) => [a, ACTIVITIES[a] || a]), (v) => { ui.actF = v; }),
      sel('typeF', 'Page type', ui.typeF, types.map((t) => [t, t]), (v) => { ui.typeF = v; }),
      h('label', { class: 'check', style: 'padding-bottom:7px' }, h('input', { type: 'checkbox', 'data-key': 'notesOnly', checked: ui.notesOnly, onchange: (e) => { ui.notesOnly = e.target.checked; render(); } }), h('span', {}, 'Only items with a note'))),
    h('div', { class: 'row between' },
      h('span', { class: 'grow', role: 'status' }, `${plural(rows.length, 'item')} shown`),
      h('button', { type: 'button', 'data-key': 'remove', class: 'sm danger', disabled: !ui.selected.size, onclick: removeSelected }, ui.selected.size ? `Remove ${plural(ui.selected.size, 'item')}` : 'Remove selected')),
    logTable({
      rows, showCase: true, selected: ui.selected, editing: ui.editing, noteDraft: ui.noteDraft,
      onSelect: (id, on) => { if (on) ui.selected.add(id); else ui.selected.delete(id); render(); },
      onEdit: (id) => { ui.editing = id; render(); document.querySelector(`[data-key="note-${CSS.escape(id)}"]`)?.focus(); },
      onSave: saveNote, onCancel: () => { ui.editing = null; render(); },
    }));
}

async function refresh() { await load(); render(); }

browser.storage.onChanged.addListener((changes, area) => { if (area === 'local' && ('case' in changes || 'processLog' in changes)) refresh(); });
await load();
// Kept logs past the retention period go before anything is shown.
const days = data.policy.values.activityLog.retentionDays;
if (applyRetention(data.processLog, days).length !== data.processLog.length) {
  await mutateStorage(({ processLog = [] }) => ({ patch: { processLog: applyRetention(processLog, days) } }), ['processLog']);
  await load();
}
render();

// The activity log as a table, shared by the Activity log page and the case page's Activity tab.
import { h, time } from './dom.js';
import { ACTIVITIES } from '../lib/activity.js';

const clock = (ts) => time(ts, { seconds: true });
const day = (ts) => new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

// Elapsed time to the next event in the same case. It includes calls, breaks and other tabs, so it is
// "Until next", never time spent on the page.
function untilNext(rows, i) {
  const next = rows.slice(i + 1).find((r) => r.caseId === rows[i].caseId);
  if (!next) return '';
  const s = Math.max(0, Math.round((Date.parse(next.event.timestamp) - Date.parse(rows[i].event.timestamp)) / 1000));
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
}

/**
 * opts: { rows, selected: Set, editing: id | null, realLinks, showCase, onSelect(id, on), onEdit(id), onSave(row, note), onCancel() }
 * Unsaved note text lives in opts.noteDraft, so re-rendering never loses it.
 */
export function logTable(opts) {
  const { rows } = opts;
  return h('table', { class: 'grid' },
    h('caption', { class: 'sr' }, 'Activity log events, oldest first'),
    h('thead', {}, h('tr', {},
      opts.onSelect ? h('th', { scope: 'col' }, h('span', { class: 'sr' }, 'Select')) : null,
      h('th', { scope: 'col' }, 'When'), opts.showCase ? h('th', { scope: 'col' }, 'Case') : null,
      h('th', { scope: 'col' }, 'Activity'), h('th', { scope: 'col' }, 'Page type'), h('th', { scope: 'col' }, 'Link'),
      h('th', { scope: 'col' }, 'Detail'), h('th', { scope: 'col' }, 'Until next'), h('th', { scope: 'col' }, 'Note'))),
    h('tbody', {}, rows.length ? rows.map((r, i) => {
      const e = r.event;
      const editing = opts.editing === e.id;
      const noteKey = `note-${e.id}`;
      return h('tr', {},
        opts.onSelect ? h('td', {}, h('input', { type: 'checkbox', 'data-key': `sel-${e.id}`, checked: opts.selected.has(e.id), 'aria-label': `Select ${ACTIVITIES[e.activity] || e.activity} at ${clock(e.timestamp)}`, onchange: (ev) => opts.onSelect(e.id, ev.target.checked) })) : null,
        h('td', { class: 'small' }, clock(e.timestamp), h('br'), h('span', { class: 'muted' }, day(e.timestamp))),
        opts.showCase ? h('td', { class: 'small' }, h('code', {}, r.caseId), h('br'), h('span', { class: 'muted' }, r.current ? 'open case' : r.outcome)) : null,
        h('td', {}, ACTIVITIES[e.activity] || e.activity, h('br'), h('code', { class: 'small muted' }, e.activity)),
        h('td', {}, h('code', {}, e.page_type || '—')),
        h('td', { class: 'small', style: 'overflow-wrap:anywhere' }, opts.realLinks && r.current && e.url ? e.url : e.url_pattern),
        h('td', { class: 'small' }, e.detail),
        h('td', { class: 'small num' }, untilNext(rows, i)),
        h('td', { class: 'small' }, editing
          ? h('div', { class: 'stack', style: 'gap:4px;min-width:180px' },
            h('label', { for: noteKey }, 'Note'),
            h('span', { class: 'muted', id: `${noteKey}-hint` }, 'Don’t write client details. Notes stay on this computer.'),
            h('textarea', { id: noteKey, 'data-key': noteKey, rows: 3, 'aria-describedby': `${noteKey}-hint`, oninput: (ev) => { opts.noteDraft[e.id] = ev.target.value; } }, opts.noteDraft[e.id] ?? e.note ?? ''),
            h('div', { class: 'row' },
              h('button', { type: 'button', class: 'sm primary', 'data-key': `${noteKey}-save`, onclick: () => opts.onSave(r, opts.noteDraft[e.id] ?? e.note ?? '') }, 'Save'),
              h('button', { type: 'button', class: 'sm', 'data-key': `${noteKey}-cancel`, onclick: () => opts.onCancel() }, 'Cancel')))
          : [e.note ? h('span', {}, e.note, ' ') : null, opts.onEdit ? h('button', { type: 'button', class: 'link sm', 'data-key': `${noteKey}-edit`, onclick: () => opts.onEdit(e.id) }, e.note ? 'Edit note' : 'Add note') : null]));
    }) : h('tr', {}, h('td', { colspan: '9' }, 'No events.'))));
}

// The case activity log: how caseworkers move through approved systems, for process mining.
// It describes the process, not the client: no field values, and links only as library patterns.
// Pure functions, no browser APIs.

export const SCHEMA = 'powerloader-activity/1';

// Stable activity ids. Display labels are separate, so renaming one never breaks analysis.
export const ACTIVITIES = {
  start_case: 'Start case', finish_case: 'Finish case', discard_case: 'Discard case', close_case: 'Deleted when Firefox closed', expire_case: 'Deleted after being left without use', keep_case: 'Keep the case',
  visit_page: 'Visit page', open_document: 'Open document',
  clip_page: 'Clip page', auto_clip_page: 'Auto-clip page', fetch_page: 'Fetch page', read_document: 'Read document', read_screen_region: 'Read screen region', read_pasted_image: 'Read pasted image',
  resolve_conflict: 'Resolve conflict', choose_value: 'Choose value', edit_value: 'Edit value', clear_my_value: 'Clear my value',
  exclude_source_value: 'Exclude source value', restore_source_value: 'Restore source value', remove_source: 'Remove source',
  use_calculator: 'Use calculator', save_timeline: 'Save timeline', open_full_case_view: 'Open full case view',
  send_to_ai: 'Send to AI', ai_extract_page: 'AI extract page', ai_read_document: 'AI read document',
  ai_calculator: 'AI calculator question', ai_timeline_find: 'AI find periods', ai_timeline_accept: 'Accept AI period', ai_timeline_explain: 'AI explain timeline',
  fill_form: 'Fill form', submit_form: 'Submit form',
  complete_step: 'Complete step', reopen_step: 'Do a step that isn’t needed', set_reference: 'Set the case reference', skip_step: 'Skip step', follow_step_link: 'Follow step link', open_email: 'Open email',
  update_flow: 'Use the changed flow',
  blocked_action: 'Blocked by site rules',
};

export const NOT_KEPT = '(link not kept)';

/**
 * Append an event to the case log. page: { type, pattern, url } as worked out by the caller from the library;
 * a page with no pattern is logged as "(link not kept)", never with its address. The real url is held only
 * while the case is open, so the caseworker can see it on the Activity tab.
 */
export function logEvent(c, activity, { page = {}, detail = '', clip, doc, at = new Date().toISOString() } = {}) {
  if (!ACTIVITIES[activity]) throw new Error(`Unknown activity "${activity}"`);
  c.seq = (c.seq || 0) + 1;
  const e = {
    id: `${c.id}.${c.seq}`, seq: c.seq, activity, timestamp: at,
    page_type: page.type || '', url_pattern: page.pattern || NOT_KEPT, detail: String(detail || ''),
    ...(page.url ? { url: page.url } : {}), ...(clip ? { clip } : {}), ...(doc ? { doc } : {}),
  };
  c.log.push(e);
  return e;
}

/**
 * Something the caseworker started that the site rules blocked: the action and which layer's rule, never
 * the page's address or the rule's pattern (a caseworker could type a client's address as a pattern).
 */
export function logBlocked(c, { action, layer }) {
  const by = { policy: 'policy rule', library: 'library rule', mine: 'your rule', hosts: 'approved systems' }[layer] || 'site rules';
  return logEvent(c, 'blocked_action', { page: { type: 'blocked' }, detail: `${action} · ${by}` });
}

// The kept copy of a case's log when it ends: real links dropped, notes kept on this computer.
export function archiveLog(c, outcome, at = new Date().toISOString(), { coarse = false } = {}) {
  const forms = c.forms.map((f) => `${f.id}@${f.version}`).join(' ');
  const events = c.log.map(({ url, clip, doc, ...e }) => ({ ...e, timestamp: coarsen(e.timestamp, coarse) })); // eslint-disable-line no-unused-vars
  // A case with purged items is a partial trace; nothing marks where the items were.
  return { schema: SCHEMA, case_id: c.id, forms, outcome, started: c.createdAt, ended: at, ...(c.purged ? { partial: true } : {}), events };
}

// Events a clip removal can purge: the clip's own events, or everything logged on its page (for a page
// about the wrong person). Nothing is kept to mark where items were removed.
export function purgeSets(c, clip) {
  const own = c.log.filter((e) => e.clip === clip.id);
  const page = c.log.filter((e) => e.clip === clip.id || (clip.url && e.url === clip.url));
  return { own, page };
}

export function removeEvents(c, ids) {
  const drop = new Set(ids);
  const before = c.log.length;
  c.log = c.log.filter((e) => !drop.has(e.id));
  c.purged = (c.purged || 0) + (before - c.log.length);
  return before - c.log.length;
}

// Kept logs older than the retention period (set by the DPIA, through policy) are deleted.
export function applyRetention(processLog = [], days, now = Date.now()) {
  if (!Number.isFinite(days) || days <= 0) return processLog;
  const cutoff = now - days * 864e5;
  return processLog.filter((l) => Date.parse(l.ended || l.started || 0) >= cutoff);
}

// Policy can coarsen timestamps to the minute if the DPIA asks.
export const coarsen = (ts, on) => (on && ts ? `${ts.slice(0, 16)}:00Z` : ts);

/**
 * Every event on this computer, oldest first: the open case's (with its real links, for the caseworker
 * only) and the kept logs'. Row: { event, caseId, current, forms, outcome }.
 */
export function allRows(c, processLog = []) {
  const rows = [];
  for (const l of processLog) for (const e of l.events) rows.push({ event: e, caseId: l.case_id, current: false, forms: l.forms, outcome: l.outcome, partial: !!l.partial });
  if (c) for (const e of c.log) rows.push({ event: e, caseId: c.id, current: true, forms: c.forms.map((f) => `${f.id}@${f.version}`).join(' '), outcome: '', partial: !!c.purged });
  return rows.sort((a, b) => a.event.timestamp.localeCompare(b.event.timestamp) || a.event.seq - b.event.seq);
}

/** Download rows in the one chronological schema. Links are always patterns; notes only when chosen. */
export function exportRows(rows, { notes = false, coarse = false } = {}) {
  return rows.map(({ event: e, caseId, forms, outcome, partial }) => ({
    schema: SCHEMA, seq: e.seq, case_id: caseId, activity: e.activity, timestamp: coarsen(e.timestamp, coarse),
    page_type: e.page_type || '', url_pattern: e.url_pattern || NOT_KEPT, detail: e.detail || '', forms: forms || '', outcome: outcome || '',
    partial: partial ? 'yes' : '', ...(notes ? { note: e.note || '' } : {}),
  }));
}

export function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [cols.join(','), ...rows.map((r) => cols.map((c) => q(r[c])).join(','))].join('\r\n');
}

// Notes and removals on kept logs. Removing marks the case's trace partial; nothing marks where.
export function editKept(processLog, ids, change) {
  const want = new Set(ids);
  return processLog.map((l) => {
    const touched = l.events.some((e) => want.has(e.id));
    if (!touched) return l;
    const next = change({ ...l, events: l.events.map((e) => ({ ...e })) }, want);
    return next;
  });
}

export const removeKept = (processLog, ids) => editKept(processLog, ids, (l, want) => ({ ...l, partial: true, events: l.events.filter((e) => !want.has(e.id)) }));
export const noteKept = (processLog, id, note) => editKept(processLog, [id], (l) => ({ ...l, events: l.events.map((e) => (e.id === id ? withNote(e, note) : e)) }));
export function withNote(e, note) {
  const n = String(note || '').trim().slice(0, 500);
  const { note: _old, ...rest } = e; // eslint-disable-line no-unused-vars
  return n ? { ...rest, note: n } : rest;
}

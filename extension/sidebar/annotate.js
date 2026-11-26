// Drawing a flow's notes on the page in the tab. In a case, a step's notes go on its page, filled from the
// case; while a flow's page is open in the Flows tab, its notes are previewed there with the fields' names in
// place of values. The page only ever gets a tree of tags and text (lib/annotations.js), and notes are drawn
// only on a page Power Loader already has access to: drawing never asks for a permission. Nor on a page the
// site rules block for notes: moving to one takes the notes away (the agent also checks at the moment it draws).
import { guardNoteLinks, markersForPage, notesForPage } from '../lib/annotations.js';
import { shownRows } from '../lib/fetch-steps.js';
import { allowed } from '../lib/access.js';
import { caseVars, stepForPage } from '../lib/journey.js';
import { annotateTab, clearTabNotes } from '../lib/core.js';
import { toolOn } from '../lib/tools.js';

// What was last drawn: { tabId, key } and the agent's answer { shown, missing }, for the editor to show.
export const noteState = { tabId: null, key: null, result: null, mode: null };

const isWeb = (url) => /^https?:/.test(url || '');

/** The notes for this tab now, and whether they're a preview. { notes, mode } or null. */
export function notesFor(context, preview = null) {
  const out = notesWanted(context, preview);
  if (!out) return null;
  const access = context.data.access;
  return { ...out, notes: access ? guardNoteLinks(out.notes, (href) => allowed(access, href, 'navigate').ok) : out.notes };
}

function notesWanted(context, preview) {
  const { ui, data, lib } = context;
  const url = ui.page?.url;
  if (!isWeb(url) || !ui.info?.access || ui.info?.blocked?.annotate) return null;
  if (!toolOn(data.policy, data.settings, 'notes')) return null;
  if (preview) {
    const label = (k) => (k === 'ref' ? 'Case reference' : preview.flow.fields[k]?.label || k);
    return { mode: 'preview', notes: notesForPage(preview.notes, {}, preview.flow.fields, (k) => `‹${label(k)}›`) };
  }
  const c = data.case;
  if (!c || !lib?.steps?.length) return null;
  const step = stepForPage(lib, url);
  // A fetch step's markers: on the rows its last run picked, from the rows the case holds, so they come back
  // when the caseworker returns to the page and go when the case ends.
  const marks = step?.role === 'fetch' && step.fetch?.show?.mark ? markersForPage(step.fetch.show.mark, shownRows(c, step)?.matches) : [];
  if (!step?.annotations?.length && !marks.length) return null;
  const label = (k) => (k === 'ref' ? 'case reference' : lib.fields[k]?.label || k);
  const notes = step.annotations?.length ? notesForPage(step.annotations, caseVars(c, lib, { text: true }), lib.fields, (k) => `(${label(k)}: not in the case yet)`) : [];
  return { mode: 'case', notes: [...notes, ...marks].slice(0, 20) };
}

/** Draw or clear the notes for the tab, only when they've changed. */
export async function syncNotes(context, preview = null) {
  const tabId = context.ui.page?.id ?? null;
  const want = notesFor(context, preview);
  const key = want?.notes.length ? `${context.ui.page.url}|${JSON.stringify(want.notes)}` : null;
  if (noteState.tabId === tabId && noteState.key === key) return noteState.result;
  // Notes drawn on another tab, or no longer wanted here, are taken away.
  if (noteState.tabId != null && noteState.key) await clearTabNotes(noteState.tabId);
  Object.assign(noteState, { tabId, key, result: null, mode: want?.mode || null });
  if (!key) return null;
  try {
    noteState.result = await annotateTab(tabId, want.notes);
  } catch {
    noteState.result = { shown: [], missing: want.notes.map((n) => n.id), error: true };
  }
  return noteState.result;
}

/** Take every note away: the case ended, or the sidebar is closing. */
export async function clearNotes() {
  if (noteState.tabId != null && noteState.key) await clearTabNotes(noteState.tabId);
  Object.assign(noteState, { tabId: null, key: null, result: null, mode: null });
}

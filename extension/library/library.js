// The Library page: published page and fill profiles, forms, and this computer's drafts. It replaces the
// sidebar while open. Power Loader never writes to the library: drafts are exported for a maintainer.
/* global browser */
import '../lib/extract.js';
import { h, rerender, announce, describeError, plural, when } from '../ui/dom.js';
import { tabList, tabPanel } from '../ui/tabs.js';
import { openDialog, confirmDialog } from '../ui/dialog.js';
import { ask, deleteDraft, libraryAt, saveDraft, updateDraft } from '../lib/core.js';
import { formList, fillProfileFor } from '../lib/library.js';
import { libraryConfig, syncLibrary } from '../lib/library-sync.js';
import { contentHash, canonical } from '../lib/hash.js';
import {
  diffDraft, draftFromProfile, exportBody, exportChecks, exportFileName, newFillDraft, repoPath, setUse, testedNow,
} from '../lib/drafts.js';
import { fieldState, settled } from '../lib/case.js';
import { display } from '../lib/fields.js';
import { returnToSidebar } from '../lib/pages.js';
import { saveFile } from '../ui/download.js';

const params = new URLSearchParams(location.search);
const ui = { tab: 'page', open: params.get('draft') ? { kind: 'draft', id: params.get('draft') } : null, values: {} };
let data = {};

async function load() {
  const s = await browser.storage.local.get(['library', 'profileDrafts', 'case', 'settings']);
  const { fullPage } = await browser.storage.session.get('fullPage').catch(() => ({}));
  data = {
    state: s.library, lib: s.library ? libraryAt(s.library, s.library.current) : null, drafts: s.profileDrafts || [],
    case: s.case || null, cfg: await libraryConfig().catch(() => ({})), from: fullPage?.from || null,
  };
  if (ui.open?.kind === 'draft' && !data.drafts.some((d) => d.id === ui.open.id)) ui.open = null;
  if (ui.open?.kind === 'draft') ui.tab = 'drafts';
}

const allPublished = () => [...(data.lib?.profiles || []), ...(data.lib?.fill || [])];
const published = (id) => allPublished().find((p) => p.id === id) || null;
const history = (p) => data.state?.sets?.[data.lib.commit]?.manifest?.history?.[p.path] || [];
const draftFor = (id) => data.drafts.filter((d) => d.profile.id === id || d.base?.id === id);
const fieldLabel = (k) => data.lib.fields[k]?.label || k;

function status(d) {
  return [
    h('span', { class: 'pill magic' }, `Draft ${d.profile.version} · this computer`),
    d.exported ? h('span', { class: 'pill acc' }, `Exported ${when(d.exported.at)}`) : null,
    d.use ? h('span', { class: 'pill ok' }, '✓ In use here') : testedNow(d) && d.tested.ok ? h('span', { class: 'pill' }, 'Tested, not in use') : h('span', { class: 'pill warn' }, 'Not tested'),
    d.conflict && !d.conflict.dismissed ? h('span', { class: 'pill bad' }, `${d.conflict.version} published, differs`) : null,
  ];
}

// The values a profile reads on the page the caseworker came from, if that page is one it reads.
async function readOrigin(profile) {
  const from = data.from;
  if (!from?.tabId || !globalThis.PowerLoaderExtract.matchUrl(profile.match, from.url || '')) return null;
  try {
    const tab = await browser.tabs.get(from.tabId);
    if (tab.url !== from.url) return null;
    return await ask(from.tabId, { type: 'powerloader:probe', profile: { fields: Object.fromEntries(Object.entries(profile.fields || {}).filter(([, s]) => typeof s === 'string')) } });
  } catch { return null; }
}

// ------------------------------------------------------------------ lists

function profileRow(p) {
  const drafts = draftFor(p.id);
  const fields = Object.keys(p.fields || {}).length;
  return [
    h('tr', {},
      h('td', {}, h('button', { type: 'button', class: 'link', 'data-key': `open-${p.id}`, onclick: () => open({ kind: 'profile', id: p.id }) }, p.name), h('br'), h('code', {}, p.id)),
      h('td', {}, p.version),
      h('td', {}, h('code', {}, p.urlPattern || '(link not kept)')),
      h('td', { class: 'num' }, String(fields)),
      h('td', {}, drafts.some((d) => d.use) ? h('span', { class: 'pill magic' }, 'Your draft is in use here') : h('span', { class: 'pill ok' }, 'Published'))),
    ...drafts.map((d) => h('tr', {},
      h('td', { style: 'padding-left:24px' }, '↳ ', h('button', { type: 'button', class: 'link', 'data-key': `open-${d.id}`, onclick: () => open({ kind: 'draft', id: d.id }) }, `${d.profile.name} ${d.profile.version}`)),
      h('td', {}, d.profile.version), h('td', {}, h('code', {}, d.profile.urlPattern || '')), h('td', { class: 'num' }, String(Object.keys(d.profile.fields || {}).length)),
      h('td', {}, status(d)))),
  ];
}

function profileList(kind) {
  const list = kind === 'fill' ? data.lib.fill : data.lib.profiles;
  const loose = data.drafts.filter((d) => (kind === 'fill') === (d.kind === 'fill') && !list.some((p) => p.id === d.profile.id || p.id === d.base?.id));
  return h('table', { class: 'grid' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Profile'), h('th', {}, 'Version'), h('th', {}, 'Link pattern'), h('th', {}, kind === 'fill' ? 'Boxes' : 'Fields'), h('th', {}, 'Status'))),
    h('tbody', {}, list.flatMap(profileRow), loose.map((d) => h('tr', {},
      h('td', {}, h('button', { type: 'button', class: 'link', 'data-key': `open-${d.id}`, onclick: () => open({ kind: 'draft', id: d.id }) }, d.profile.name), h('br'), h('code', {}, d.profile.id)),
      h('td', {}, d.profile.version), h('td', {}, h('code', {}, d.profile.urlPattern || '')), h('td', { class: 'num' }, String(Object.keys(d.profile.fields || {}).length)), h('td', {}, status(d))))));
}

function formsList() {
  return h('table', { class: 'grid' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Form'), h('th', {}, 'Version'), h('th', {}, 'Fields'), h('th', {}, 'Fill profile'))),
    h('tbody', {}, formList(data.lib).map((f) => {
      const fp = fillProfileFor(data.lib, f.id);
      return h('tr', {},
        h('td', {}, h('b', {}, f.name), h('br'), h('span', { class: 'small muted' }, f.category || ''),
          (f.sideEffects || []).length ? h('p', { class: 'small' }, h('b', {}, 'Side effects when filled: '), f.sideEffects.join(' ')) : null),
        h('td', {}, f.version),
        h('td', {}, `${f.fields.length} (${f.fields.filter((x) => x.required).length} required)`),
        h('td', {}, fp ? h('button', { type: 'button', class: 'link', 'data-key': `open-${fp.id}`, onclick: () => open({ kind: 'profile', id: fp.id }) }, `${fp.id} ${fp.version}`)
          : h('button', {
            type: 'button', class: 'sm', 'data-key': `make-fill-${f.id}`,
            onclick: async () => {
              const d = newFillDraft(f);
              await saveDraft(d);
              await browser.storage.session.set({ editingDraft: d.id });
              announce('Fill draft made. Open the form page with the sidebar to map its boxes.');
              await load();
              open({ kind: 'draft', id: d.id });
            },
          }, 'Make a fill profile')));
    })));
}

function draftsList() {
  if (!data.drafts.length) return h('p', { class: 'muted' }, 'No drafts on this computer. Make one from the sidebar on a page no profile reads, or with “Make a new version” on a published profile.');
  return h('div', { class: 'stack' }, data.drafts.map((d) => h('div', { class: 'card' },
    h('div', { class: 'row between' }, h('h3', {}, `${d.profile.name} ${d.profile.version}`), h('span', { class: 'row' }, status(d))),
    h('p', { class: 'small muted' }, `${d.kind === 'fill' ? 'Fill profile' : 'Page profile'} · ${d.base ? `new version of ${d.base.id} ${d.base.version} (commit ${d.base.commit})` : 'new profile'} · made ${when(d.created)}`),
    h('ol', { class: 'small', style: 'margin:0;padding-left:20px' },
      h('li', {}, 'Test it on the page, then export it. Power Loader never writes to the library.'),
      h('li', {}, `Send ${exportFileName(d)} to a library maintainer, or add it at ${repoPath(d)}.`),
      h('li', {}, 'Once it is reviewed and merged, everyone gets it at their next sync. Your draft is retired when the published file matches what you exported.')),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'sm', 'data-key': `d-open-${d.id}`, onclick: () => open({ kind: 'draft', id: d.id }) }, 'Open'),
      h('button', { type: 'button', class: 'sm primary', 'data-key': `d-exp-${d.id}`, onclick: () => exportDialog(d) }, d.exported ? 'Export again' : 'Export'),
      h('button', { type: 'button', class: 'sm', 'data-key': `d-del-${d.id}`, onclick: () => removeDraft(d) }, 'Delete')))));
}

// ------------------------------------------------------------------ details

function fieldsTable(p, values) {
  const isFill = p.kind === 'fill';
  const rows = Object.entries(p.fields || {}).map(([k, spec]) => {
    if (isFill) {
      const key = String(spec).replace(/^CaseData\./, '');
      const st = data.case ? fieldState(data.case, data.lib, key) : null;
      return h('tr', {}, h('td', {}, h('code', {}, k)), h('td', {}, fieldLabel(key)),
        h('td', {}, st && settled(st.status) ? display(data.lib.fields[key], st.value) : h('span', { class: 'muted' }, st ? st.status : 'no case open')));
    }
    if (Array.isArray(spec)) {
      return h('tr', {}, h('td', {}, `${k} (rows)`), h('td', {}, h('code', {}, spec[0]), h('br'),
        h('span', { class: 'small muted' }, `Row fields: ${Object.entries(spec[1] || {}).map(([a, b]) => `${a} = ${b}`).join('; ')}`)), h('td', {}, ''));
    }
    const v = values?.[k];
    return h('tr', {}, h('td', {}, fieldLabel(k)), h('td', {}, h('code', {}, spec)),
      h('td', {}, v ? (v.error ? h('span', { class: 'pill bad' }, v.error) : v.count === 1 ? String(v.value ?? '') : h('span', { class: 'pill warn' }, `${v.count} matches`)) : ''));
  });
  return h('table', { class: 'grid' },
    h('thead', {}, h('tr', {}, isFill ? [h('th', {}, 'Form box'), h('th', {}, 'Case field'), h('th', {}, 'Case value now')]
      : [h('th', {}, 'Case field'), h('th', {}, 'Selector'), h('th', {}, values ? 'Reads on the page you came from' : 'Value')])),
    h('tbody', {}, rows));
}

function profileDetail(p) {
  const hist = history(p);
  return [
    h('div', { class: 'row between' }, h('div', {}, h('h2', {}, `${p.name} ${p.version}`), h('code', {}, p.id)),
      h('div', { class: 'row' },
        h('button', { type: 'button', 'data-key': 'back-list', onclick: () => open(null) }, 'Back to the list'),
        h('button', {
          type: 'button', class: 'primary', 'data-key': 'new-version',
          onclick: async () => {
            const existing = draftFor(p.id)[0];
            if (existing) return open({ kind: 'draft', id: existing.id });
            const d = draftFromProfile(p, data.lib.commit);
            await saveDraft(d);
            announce(`Draft ${d.profile.version} made from ${p.version}`);
            await load();
            return open({ kind: 'draft', id: d.id });
          },
        }, draftFor(p.id).length ? 'Open your draft' : 'Make a new version'))),
    h('dl', { class: 'cols small' },
      h('div', {}, h('dt', {}, h('b', {}, 'Matches')), h('dd', {}, h('code', {}, [p.match].flat().join(' ')))),
      h('div', {}, h('dt', {}, h('b', {}, 'Link pattern')), h('dd', {}, h('code', {}, p.urlPattern || '(link not kept)'))),
      p.when ? h('div', {}, h('dt', {}, h('b', {}, 'Only when the page has')), h('dd', {}, h('code', {}, p.when))) : null),
    fieldsTable(p, ui.values[p.id]),
    hist.length ? [h('h3', {}, 'Version history'), h('table', { class: 'grid' }, h('tbody', {}, hist.map((x) => h('tr', {}, h('td', {}, x.version), h('td', {}, h('code', {}, x.commit)), h('td', {}, x.date), h('td', {}, x.message)))))] : null,
  ];
}

function compareDialog(d) {
  const pub = published(d.profile.id);
  const base = d.base && published(d.base.id)?.version === d.base.version ? published(d.base.id) : null;
  const show = (title, doc) => h('div', { class: 'stack' }, h('h3', {}, title), h('pre', { class: 'json' }, doc ? JSON.stringify(doc.fields || {}, null, 2) : 'Not on this computer'));
  openDialog({
    title: `Compare ${d.profile.name}`, wide: true,
    body: (dlg) => [
      h('div', { class: 'cols' }, show(`Original base ${d.base?.version || ''}`, base), show(`Your draft ${d.profile.version}`, d.profile), show(`Published ${pub?.version || ''}`, pub)),
      h('div', { class: 'actions' }, h('button', { type: 'button', onclick: () => dlg.close() }, 'Close')),
    ],
  });
}

function draftDetail(d) {
  const base = d.base ? published(d.base.id) : null;
  const diff = base ? diffDraft(d, base) : null;
  const usable = testedNow(d) && d.tested.ok;
  const conflict = d.conflict && !d.conflict.dismissed ? d.conflict : null;
  return [
    h('div', { class: 'row between' },
      h('div', {}, h('h2', {}, `${d.profile.name} ${d.profile.version}`), h('code', {}, d.profile.id), h('div', { class: 'row', style: 'margin-top:4px' }, status(d))),
      h('div', { class: 'row' },
        h('button', { type: 'button', 'data-key': 'back-list', onclick: () => open(null) }, 'Back to the list'),
        h('button', { type: 'button', 'data-key': 'edit-on-page', onclick: () => editOnPage(d) }, 'Edit on the page'),
        h('button', { type: 'button', class: 'primary', 'data-key': 'export', onclick: () => exportDialog(d) }, d.exported ? 'Export again' : 'Export'),
        h('button', { type: 'button', 'data-key': 'delete', onclick: () => removeDraft(d) }, 'Delete'))),
    conflict ? h('div', { class: 'notice warn', role: 'alert' },
      h('p', {}, h('b', {}, `${conflict.version} was published, but it isn’t the same as your draft.`), ' Nothing is deleted until you choose.'),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'sm', 'data-key': 'use-published', onclick: async () => { await deleteDraft(d.id); announce('Using the published version. Your draft was deleted.'); await refresh(); open(null); } }, 'Use published'),
        h('button', { type: 'button', class: 'sm', 'data-key': 'keep-draft', onclick: async () => { await updateDraft(d.id, (x) => { x.conflict.dismissed = true; }); announce('Keeping your draft'); refresh(); } }, 'Keep using my draft'),
        h('button', { type: 'button', class: 'sm', 'data-key': 'compare', onclick: () => compareDialog(d) }, 'Compare'))) : null,
    h('label', { class: 'check' },
      h('input', {
        type: 'checkbox', 'data-key': 'use-here', checked: d.use, disabled: !usable && !d.use,
        onchange: async (e) => { const on = e.target.checked; try { await updateDraft(d.id, (x) => setUse(x, on)); } catch (err) { announce(describeError(err)); } refresh(); },
      }),
      h('span', {}, h('b', {}, 'Used on this computer'), h('br'), h('span', { class: 'small muted' }, usable ? `Instead of the published ${d.base?.version || 'profile'}, for ${d.kind === 'fill' ? 'filling' : 'clipping'} on this computer only.` : 'Available once the draft has passed a test on the page, with nothing changed since.'))),
    d.base ? h('p', { class: 'small' }, `Based on ${d.base.id} ${d.base.version}, commit ${d.base.commit}.`) : h('p', { class: 'small' }, 'A new profile.'),
    diff ? h('div', { class: 'card' }, h('h3', {}, `Changes from ${d.base.version}`),
      diff.same ? h('p', {}, 'No changes.') : h('ul', { class: 'impact' },
        diff.added.length ? h('li', {}, `Added: ${diff.added.map(fieldLabel).join(', ')}`) : null,
        diff.removed.length ? h('li', {}, `Removed: ${diff.removed.map(fieldLabel).join(', ')}`) : null,
        ...diff.remapped.map((r) => h('li', {}, `${r.rows ? 'Rows ' : ''}${fieldLabel(r.key)}: `, h('code', {}, canonical(r.from)), ' → ', h('code', {}, canonical(r.to)))),
        ...diff.meta.map((m) => h('li', {}, `${m.what}: `, h('code', {}, canonical(m.from)), ' → ', h('code', {}, canonical(m.to)))))) : null,
    d.tested ? h('p', { class: 'small' }, testedNow(d) ? `Last test ${when(d.tested.at)}: ${d.tested.ok ? 'passed' : 'failed'}${d.second ? `; second record ${d.second.ok ? 'passed' : 'failed'}` : ''}.` : 'Changed since its last test.') : h('p', { class: 'small' }, 'Not tested yet. Open the page it reads with the sidebar, then use “Test and use on this computer”.'),
    fieldsTable(d.profile, ui.values[d.id]),
    h('details', {}, h('summary', {}, 'The file that would be exported'), h('pre', { class: 'json' }, JSON.stringify(exportBody(d), null, 2))),
  ];
}

// ------------------------------------------------------------------ actions

async function editOnPage(d) {
  await browser.storage.session.set({ editingDraft: d.id });
  const r = await returnToSidebar();
  if (!r.ok) announce(r.reason);
}

async function removeDraft(d) {
  const ok = await confirmDialog({
    title: `Delete draft ${d.profile.name} ${d.profile.version}?`,
    text: [d.base ? `Clipping goes back to the library’s ${d.base.version}.` : 'Pages it reads will be unrecognised again.', d.exported ? 'You exported it, so a copy may already be with a maintainer.' : 'It hasn’t been exported.'],
    confirm: 'Delete draft', danger: true,
  });
  if (!ok) return;
  await deleteDraft(d.id);
  announce('Draft deleted');
  await refresh();
  open(null);
}

// Every string of the case (values typed and clipped) must stay out of the file.
function caseValues() {
  const c = data.case;
  if (!c) return [];
  return [...c.clips.flatMap((cl) => Object.values(cl.values)), ...Object.values(c.manual), ...Object.values(c.resolved), c.ref].filter(Boolean).map(String);
}

function exportDialog(d) {
  const checks = exportChecks(d, { lib: data.lib, values: caseValues() });
  const ok = checks.every((c) => c.ok);
  const repo = data.cfg.baseUrl || 'the library repository';
  openDialog({
    title: `Export ${d.profile.name} ${d.profile.version}`, wide: true,
    body: (dlg) => [
      h('p', {}, 'This saves ', h('b', {}, exportFileName(d)), ' to your Downloads folder.'),
      h('div', {}, h('b', {}, 'Checks'), h('ul', { class: 'checks' }, checks.map((c) => h('li', {}, h('span', { class: `pill ${c.ok ? 'ok' : 'bad'}` }, c.ok ? '✓ Passed' : '✕ Failed'), ' ', c.text)))),
      h('div', {}, h('b', {}, 'To publish it'), h('ol', { style: 'margin:4px 0 0;padding-left:20px' },
        h('li', {}, `Send the file to a library maintainer, or add it yourself to ${repo} at `, h('code', {}, repoPath(d)), d.base ? `, replacing ${d.base.version}.` : '.'),
        h('li', {}, 'A maintainer reviews it: new personal fields or a wider match need explicit sign-off.'),
        h('li', {}, `Everyone gets ${d.profile.version} at their next sync. Your draft is retired once the published file matches what you exported.`))),
      h('pre', { class: 'json', tabindex: '0', 'aria-label': 'File contents' }, JSON.stringify(exportBody(d), null, 2)),
      h('div', { class: 'actions' },
        h('button', { type: 'button', onclick: () => dlg.close() }, 'Close'),
        ok ? h('button', { type: 'button', class: 'primary', onclick: () => doExport(d, dlg) }, d.exported ? 'Export again' : 'Export')
          : h('span', { class: 'small muted' }, 'Fix the failed checks to export.')),
    ],
  });
}

async function doExport(d, dlg) {
  try {
    const body = exportBody(d);
    const hash = await contentHash(body);
    const file = { ...body, exported: { from: `Power Loader ${browser.runtime.getManifest().version}`, date: new Date().toISOString().slice(0, 10), contentHash: hash } };
    await saveFile(exportFileName(d), `${JSON.stringify(file, null, 2)}\n`);
    await updateDraft(d.id, (x) => { x.exported = { at: new Date().toISOString(), hash, version: x.profile.version }; });
    dlg.close();
    announce(`Exported ${exportFileName(d)}`);
    refresh();
  } catch (e) { announce(`Couldn’t export: ${describeError(e)}`); }
}

async function open(target) {
  ui.open = target;
  if (target) {
    const p = target.kind === 'draft' ? data.drafts.find((d) => d.id === target.id)?.profile : published(target.id);
    if (p && p.kind !== 'fill' && !(target.id in ui.values)) {
      render();
      ui.values[target.id] = await readOrigin(p);
    }
  }
  render();
  document.querySelector('.page h2')?.setAttribute('tabindex', '-1');
  document.querySelector('.page h2')?.focus();
}

async function refresh() {
  await load();
  render();
}

// ------------------------------------------------------------------ page

function render() {
  const app = document.getElementById('app');
  const lib = data.lib;
  const last = data.state?.lastSync;
  const headParts = h('div', { class: 'page-head' },
    h('div', {}, h('div', { class: 'eyebrow' }, 'Forms library · read-only copy on this computer'), h('h1', {}, 'Library'),
      h('div', { class: 'meta' }, `${data.cfg.baseUrl || 'Not connected'} · ${data.cfg.branch || 'main'}${lib ? ` · commit ${lib.commit}, synced ${when(lib.syncedAt)}` : ''}`)),
    h('div', { class: 'row' },
      h('button', { type: 'button', 'data-key': 'back', onclick: async () => { const r = await returnToSidebar(); if (!r.ok) announce(r.reason); } }, 'Back to the sidebar'),
      h('button', {
        type: 'button', 'data-key': 'sync',
        onclick: async () => { announce('Syncing…'); const r = await syncLibrary(); announce(r.ok ? `Synced: commit ${r.commit}` : `Sync failed: ${r.error}`); refresh(); },
      }, 'Sync now')));
  // Who changes what: anyone can propose a page profile; forms and fill profiles are the library team's.
  const roles = h('div', { class: 'lib-howto' },
    h('h3', {}, 'Who changes the library'),
    h('ol', {},
      h('li', {}, h('b', {}, 'Anyone'), ' can make a page profile for a page no profile reads, or update one that reads the wrong thing: in the sidebar choose “Make a profile for this page” or “Update this profile”, then test it on the page.'),
      h('li', {}, 'A tested draft is used on your computer only. ', h('b', {}, 'Export'), ' it from “Your drafts” and send the file to your library team.'),
      h('li', {}, h('b', {}, 'The library team'), ' reviews it, adds it to the library and publishes it. Everyone gets it at their next sync, and your draft is retired. Forms and fill profiles are set up by the library team.')));
  if (!lib) return rerender(app, headParts, h('p', {}, 'Connect the library from the sidebar’s Settings first.'));
  const counts = { page: lib.profiles.length, fill: lib.fill.length, forms: Object.keys(lib.forms).length, drafts: data.drafts.length };
  const tabs = [['page', 'Page profiles'], ['fill', 'Fill profiles'], ['forms', 'Forms'], ['drafts', 'Your drafts']].map(([key, label]) => ({ key, label: `${label} (${counts[key]})` }));
  let body;
  if (ui.open?.kind === 'draft') body = draftDetail(data.drafts.find((d) => d.id === ui.open.id));
  else if (ui.open?.kind === 'profile' && published(ui.open.id)) body = profileDetail(published(ui.open.id));
  else body = ui.tab === 'forms' ? formsList() : ui.tab === 'drafts' ? draftsList() : profileList(ui.tab);
  rerender(app,
    headParts,
    last && !last.ok ? h('div', { class: 'notice warn' }, `Using commit ${lib.commit} from ${when(lib.syncedAt)}; latest sync failed: ${last.error}`) : null,
    data.cfg.pinCommit ? h('div', { class: 'notice' }, `🔒 Pinned to commit ${data.cfg.pinCommit} by your organisation.`) : null,
    lib.problems.length ? h('div', { class: 'notice bad' }, `${plural(lib.problems.length, 'file')} skipped: `, lib.problems.map((p) => `${p.path} (${p.errors[0]})`).join('; ')) : null,
    ui.open || ui.tab === 'forms' || ui.tab === 'fill' ? null : roles,
    tabList({ id: 'lib', label: 'Library', tabs, selected: ui.tab, className: 'lib-tabs', onSelect: (t) => { ui.tab = t; ui.open = null; render(); } }),
    tabPanel('lib', ui.tab, body));
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ('library' in changes || 'profileDrafts' in changes || 'case' in changes)) refresh();
});
await load();
if (ui.open) await open(ui.open); else render();

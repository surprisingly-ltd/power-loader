// The Library page: the library's templates (what Power Loader knows about each page and form) and its forms,
// read-only. It replaces the sidebar while open. Power Loader never writes to the library: a template is
// changed in a flow, in the sidebar's Build mode, and the flow is exported for the library team.
/* global browser */
import '../lib/extract.js';
import { h, rerender, announce, plural, when } from '../ui/dom.js';
import { tabList, tabPanel } from '../ui/tabs.js';
import { ask, currentAccess, libraryAt } from '../lib/core.js';
import { accessIssues, formList, fillProfileFor } from '../lib/library.js';
import { libraryConfig, syncFailureShown, syncLibrary } from '../lib/library-sync.js';
import { fieldState, settled } from '../lib/case.js';
import { display } from '../lib/fields.js';
import { returnToSidebar } from '../lib/pages.js';

const params = new URLSearchParams(location.search);
const ui = { tab: params.get('tab') || 'page', open: null, values: {} };
let data = {};

async function load() {
  const s = await browser.storage.local.get(['library', 'case', 'settings']);
  const { fullPage } = await browser.storage.session.get('fullPage').catch(() => ({}));
  data = {
    state: s.library, lib: s.library ? libraryAt(s.library, s.library.current) : null,
    case: s.case || null, cfg: await libraryConfig().catch(() => ({})), from: fullPage?.from || null,
    access: await currentAccess().catch(() => null),
  };
}

const allPublished = () => [...(data.lib?.profiles || []), ...(data.lib?.fill || [])];
const published = (id) => allPublished().find((p) => p.id === id) || null;
const history = (p) => data.state?.sets?.[data.lib.commit]?.manifest?.history?.[p.path] || [];
const fieldLabel = (k) => data.lib.fields[k]?.label || k;

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
  const fields = Object.keys(p.fields || {}).length;
  return [
    h('tr', {},
      h('td', {}, h('button', { type: 'button', class: 'link', 'data-key': `open-${p.id}`, onclick: () => open({ kind: 'profile', id: p.id }) }, p.name), h('br'), h('code', {}, p.id)),
      h('td', {}, p.version),
      h('td', {}, h('code', {}, p.urlPattern || '(link not kept)')),
      h('td', { class: 'num' }, String(fields)),
      h('td', {}, h('span', { class: 'pill ok' }, 'Published'))),
  ];
}

function profileList(kind) {
  const list = kind === 'fill' ? data.lib.fill : data.lib.profiles;
  return h('table', { class: 'grid' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Template'), h('th', {}, 'Version'), h('th', {}, 'Link pattern'), h('th', {}, kind === 'fill' ? 'Boxes' : 'Fields'), h('th', {}, 'Status'))),
    h('tbody', {}, list.flatMap(profileRow)));
}

function formsList() {
  return h('table', { class: 'grid' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Form'), h('th', {}, 'Version'), h('th', {}, 'Fields'), h('th', {}, 'Fill template'))),
    h('tbody', {}, formList(data.lib).map((f) => {
      const fp = fillProfileFor(data.lib, f.id);
      return h('tr', {},
        h('td', {}, h('b', {}, f.name), h('br'), h('span', { class: 'small muted' }, f.category || ''),
          (f.sideEffects || []).length ? h('p', { class: 'small' }, h('b', {}, 'Side effects when filled: '), f.sideEffects.join(' ')) : null),
        h('td', {}, f.version),
        h('td', {}, `${f.fields.length} (${f.fields.filter((x) => x.required).length} required)`),
        h('td', {}, fp ? h('button', { type: 'button', class: 'link', 'data-key': `open-${fp.id}`, onclick: () => open({ kind: 'profile', id: fp.id }) }, `${fp.id} ${fp.version}`)
          : h('span', { class: 'small muted' }, 'None yet: it is made in a flow that fills this form')));
    })));
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
        h('button', { type: 'button', 'data-key': 'back-list', onclick: () => open(null) }, 'Back to the list'))),
    h('dl', { class: 'cols small' },
      h('div', {}, h('dt', {}, h('b', {}, 'Matches')), h('dd', {}, h('code', {}, [p.match].flat().join(' ')))),
      h('div', {}, h('dt', {}, h('b', {}, 'Link pattern')), h('dd', {}, h('code', {}, p.urlPattern || '(link not kept)'))),
      p.when ? h('div', {}, h('dt', {}, h('b', {}, 'Only when the page has')), h('dd', {}, h('code', {}, p.when))) : null),
    fieldsTable(p, ui.values[p.id]),
    hist.length ? [h('h3', {}, 'Version history'), h('table', { class: 'grid' }, h('tbody', {}, hist.map((x) => h('tr', {}, h('td', {}, x.version), h('td', {}, h('code', {}, x.commit)), h('td', {}, x.date), h('td', {}, x.message)))))] : null,
  ];
}

async function open(target) {
  ui.open = target;
  if (target) {
    const p = published(target.id);
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
  // Who changes what: anyone can change a flow, and with it the templates it uses; the library team publishes.
  const roles = h('div', { class: 'lib-howto' },
    h('h3', {}, 'Who changes the library'),
    h('ol', {},
      h('li', {}, h('b', {}, 'Anyone'), ' can change how a page is read or a form is filled: in the sidebar, switch to ', h('b', {}, 'Build'), ', open the flow (a library flow is copied to this computer first) and change its page, then test it on the page.'),
      h('li', {}, 'The changed flow is used on your computer. ', h('b', {}, 'Export'), ' it from Build and send the file to your library team.'),
      h('li', {}, h('b', {}, 'The library team'), ' reviews it, adds it to the library and publishes it. Everyone gets it at their next sync.')));
  if (!lib) return rerender(app, headParts, h('p', {}, 'Connect the library from the sidebar’s Settings first.'));
  const counts = { page: lib.profiles.length, fill: lib.fill.length, forms: Object.keys(lib.forms).length };
  const tabs = [['page', 'Page templates'], ['fill', 'Fill templates'], ['forms', 'Forms']].map(([key, label]) => ({ key, label: `${label} (${counts[key]})` }));
  let body;
  if (ui.open?.kind === 'profile' && published(ui.open.id)) body = profileDetail(published(ui.open.id));
  else body = ui.tab === 'forms' ? formsList() : profileList(ui.tab);
  rerender(app,
    headParts,
    syncFailureShown(data.state) ? h('div', { class: 'notice warn' }, `Using commit ${lib.commit} from ${when(lib.syncedAt)}; latest sync failed: ${last.error}`) : null,
    data.cfg.pinCommit ? h('div', { class: 'notice' }, `🔒 Pinned to commit ${data.cfg.pinCommit} by your organisation.`) : null,
    lib.problems.length ? h('div', { class: 'notice bad' }, `${plural(lib.problems.length, 'file')} skipped: `, lib.problems.map((p) => `${p.path} (${p.errors[0]})`).join('; ')) : null,
    siteRuleNotice(lib),
    ui.open || ui.tab === 'forms' || ui.tab === 'fill' ? null : roles,
    tabList({ id: 'lib', label: 'Library', tabs, selected: ui.tab, className: 'lib-tabs', onSelect: (t) => { ui.tab = t; ui.open = null; render(); } }),
    tabPanel('lib', ui.tab, body));
}

// Profiles and forms the site rules block: beside the library's own problems, not part of them, because the
// caseworker's rules change without the library's commit changing. They're refused when used.
function siteRuleNotice(lib) {
  const issues = data.access ? accessIssues(lib, data.access) : [];
  if (!issues.length) return null;
  return h('div', { class: 'notice warn', 'data-key': 'lib-blocked' },
    h('b', {}, 'Site rules: '), `${plural(issues.length, 'template or form', 'templates or forms')} can’t be used as they are. `,
    h('ul', { class: 'small' }, issues.map((i) => h('li', {}, `${i.path}: ${i.text}`))));
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ('library' in changes || 'case' in changes || 'settings' in changes)) refresh();
});
await load();
if (ui.open) await open(ui.open); else render();

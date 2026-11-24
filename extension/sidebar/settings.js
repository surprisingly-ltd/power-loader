// Settings: the forms library, data from earlier versions, and deleting everything.
/* global browser */
import { h, plural, when, announce, describeError } from '../ui/dom.js';
import { confirmDialog } from '../ui/dialog.js';
import { mutateStorage, wipeStorage } from '../lib/storage.js';
import { endCase } from '../lib/teardown.js';
import { libraryOrigin, syncLibrary } from '../lib/library-sync.js';
import { libraryAt, saveSettings } from '../lib/core.js';
import { saveFile } from '../ui/download.js';
import { collectFacts, diagnosticsReport } from '../lib/diagnostics.js';
import { policyKeysSet } from '../lib/policy.js';
import { modelSetupCard } from './privacy.js';
import { aiReady } from '../lib/ai/settings.js';

function download(name, obj) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function libraryAddressOk(value) {
  try {
    const u = new URL(String(value).replace('{ref}', 'main'));
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname));
  } catch { return false; }
}

// The address form, its status line, and Sync and Connect: shared by the Settings card and the first-run card.
function libraryActions({ data, act }) {
  const cfg = data.libraryCfg || {};
  const form = data.libraryForm || (data.libraryForm = { baseUrl: cfg.baseUrl || '', branch: cfg.branch || 'main' });
  const status = h('p', { class: 'small', role: 'status', 'aria-live': 'polite' });
  const sync = async () => {
    status.textContent = 'Syncing…';
    const out = await syncLibrary();
    if (!out.ok) { status.textContent = `Sync failed: ${out.error}`; announce('Library sync failed'); }
    else {
      const bits = [out.changed ? `Now using commit ${out.commit}.` : `Up to date at commit ${out.commit}.`];
      if (out.drafts.retired.length) bits.push(`Retired drafts that were published unchanged: ${out.drafts.retired.join(', ')}.`);
      if (out.drafts.conflicts.length) bits.push(`New published versions differ from your drafts: ${out.drafts.conflicts.join(', ')}. Choose in the library.`);
      status.textContent = bits.join(' ');
      announce('Library synced');
    }
    act.refresh();
  };
  const connect = () => {
    const baseUrl = form.baseUrl.trim();
    if (!libraryAddressOk(baseUrl)) { status.textContent = 'Enter the library address. It must use https (or http on this computer).'; return; }
    // The permission request must happen during the click itself.
    const granted = browser.permissions.request({ origins: [libraryOrigin(baseUrl)] });
    void (async () => {
      if (!await granted) { status.textContent = 'Power Loader needs permission to read the library address.'; return; }
      if (!cfg.locked?.baseUrl) await saveSettings({ library: { baseUrl, branch: form.branch.trim() || 'main' } });
      await sync();
    })();
  };
  return { cfg, form, status, sync, connect };
}

export function libraryCard(context) {
  const { data, act } = context;
  const state = data.library;
  const lib = data.lib;
  const { cfg, form, status, connect } = libraryActions(context);
  const lockedNote = cfg.locked?.baseUrl ? h('span', { class: 'pill' }, '🔒 Set by your organisation') : null;
  const last = state?.lastSync;
  return h('div', { class: 'card' },
    h('div', { class: 'row between' }, h('h2', {}, 'Forms library'), lockedNote),
    h('label', { class: 'field' }, 'Library address',
      h('span', { class: 'hint' }, 'Where the library publishes library.json. Power Loader only downloads from it; it never writes to it.'),
      h('input', { type: 'url', 'data-key': 'lib-url', value: form.baseUrl, disabled: !!cfg.locked?.baseUrl, placeholder: 'https://git.example.gov.uk/team/power-loader-library/-/raw/{ref}/', oninput: (e) => { form.baseUrl = e.target.value; } })),
    h('label', { class: 'field' }, 'Branch',
      h('input', { type: 'text', 'data-key': 'lib-branch', value: form.branch, disabled: !!cfg.locked?.branch, oninput: (e) => { form.branch = e.target.value; } })),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: lib ? '' : 'primary', 'data-key': 'lib-connect', onclick: connect }, lib ? 'Sync now' : 'Connect'),
      lib ? h('button', { type: 'button', 'data-key': 'lib-open', onclick: () => act.openPage('library') }, 'Open the library') : null),
    status,
    lib ? h('p', {}, `Using commit ${lib.commit}${lib.syncedAt ? ` from ${when(lib.syncedAt)}` : ''}.`) : null,
    last && !last.ok ? h('p', { class: 'notice warn small' }, `Latest sync failed at ${when(last.at)}: ${last.error}${lib ? ' Power Loader keeps using the last good copy.' : ''}`) : null,
    cfg.pinCommit ? h('p', { class: 'small' }, `🔒 Pinned to commit ${cfg.pinCommit} by your organisation.`) : null,
    lib ? h('p', { class: 'small muted' }, `${plural(Object.keys(lib.forms).length, 'form')} · ${plural(lib.profiles.length, 'page profile')} · ${plural(lib.fill.length, 'fill profile')}${data.drafts.length ? ` · ${plural(data.drafts.length, 'draft')} on this computer` : ''}`) : null);
}

// First run: the Case tab asks for the library address before anything else.
export function onboardCard(context) {
  const { cfg, form, status, connect } = libraryActions(context);
  return h('div', { class: 'card' },
    h('h2', {}, 'Connect your team’s forms library'),
    h('p', { class: 'muted' }, 'Power Loader reads its forms and page profiles from one library. Your team lead or IT can give you the address. You only do this once.'),
    h('label', { class: 'field' }, 'Library address',
      h('input', { type: 'url', 'data-key': 'onboard-url', value: form.baseUrl, disabled: !!cfg.locked?.baseUrl, placeholder: 'https://git.example.gov.uk/team/power-loader-library/-/raw/{ref}/', oninput: (e) => { form.baseUrl = e.target.value; } })),
    h('button', { type: 'button', class: 'primary', 'data-key': 'onboard-connect', style: 'align-self:flex-start', onclick: connect }, 'Connect'),
    status,
    h('p', { class: 'small muted' }, 'Power Loader only downloads from this address. It never writes to it.'));
}

function legacyCard({ data, act }) {
  const cases = Object.values(data.cases || {});
  const profiles = Object.values(data.profiles || {});
  if (!cases.length && !profiles.length) return null;
  return h('div', { class: 'card' },
    h('h2', {}, 'Data from an earlier version'),
    h('p', {}, `${cases.length ? plural(cases.length, 'case') : ''}${cases.length && profiles.length ? ' and ' : ''}${profiles.length ? plural(profiles.length, 'profile') : ''} from Power Loader 0.5 ${cases.length + profiles.length === 1 ? 'is' : 'are'} still stored in this browser. This version can’t open ${cases.length + profiles.length === 1 ? 'it' : 'them'}: cases now start from the library’s forms.`),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'sm', 'data-key': 'legacy-dl', onclick: () => download('power-loader-0.5-data.json', { cases: data.cases || {}, profiles: data.profiles || {} }) }, 'Download it'),
      h('button', {
        type: 'button', class: 'sm', 'data-key': 'legacy-rm',
        onclick: async () => {
          if (!await confirmDialog({ title: 'Delete the earlier data?', text: 'The old cases and profiles are deleted from this browser. This can’t be undone.', confirm: 'Delete it', danger: true })) return;
          await mutateStorage(() => ({ patch: { cases: {}, activeCaseId: null, profiles: {}, profileSettings: {} } }), ['cases']);
          announce('Earlier data deleted');
          act.refresh();
        },
      }, 'Delete it')));
}

// Every profile in the library, and the drafts on this computer.
function profilesCard({ data, act }) {
  const lib = data.lib;
  if (!lib) return null;
  const list = [...lib.profiles.map((p) => ({ ...p, kind: 'page' })), ...lib.fill.map((p) => ({ ...p, kind: 'fill' }))];
  return h('div', { class: 'card' },
    h('h2', {}, 'Profiles'),
    h('ul', { class: 'plain' }, list.map((p) => h('li', { class: 'row between', style: 'flex-wrap:nowrap' },
      h('span', {}, p.name, ' ', h('span', { class: 'small muted' }, p.kind)), h('span', { class: 'small muted' }, p.version)))),
    data.drafts.length ? h('p', {}, h('span', { class: 'pill magic' }, `${plural(data.drafts.length, 'draft')} on this computer`)) : null,
    h('button', { type: 'button', class: 'sm', 'data-key': 'lib-open-2', style: 'align-self:flex-start', onclick: () => act.openPage('library') }, 'Open the library'));
}

// Clip recognised pages as soon as they open, while a case is active. The identity check still warns first.
function autoClipCard({ data, act }) {
  const on = !!data.settings?.autoClip;
  return h('div', { class: 'card' },
    h('div', { class: 'row between' }, h('h2', {}, 'Auto-clip'),
      h('label', { class: 'check' }, h('input', {
        type: 'checkbox', 'data-key': 'auto-clip', checked: on,
        onchange: async (e) => { await saveSettings({ autoClip: e.target.checked }); announce(e.target.checked ? 'Auto-clip is on' : 'Auto-clip is off'); act.refresh(); },
      }), h('span', {}, 'On'))),
    h('p', { class: 'muted' }, 'Clip recognised pages as soon as you open them while a case is active. A page about a different person still warns you before anything else.'));
}

function logCard({ data, act }) {
  const kept = data.processLog || [];
  const events = kept.reduce((n, l) => n + l.events.length, 0);
  return h('div', { class: 'card' },
    h('h2', {}, 'Activity log'),
    h('p', { class: 'small muted' }, 'Each case records the approved pages you visit and what you do, for process improvement. After a case ends, its log is kept without case values, with links reduced to patterns such as /clients/{clientId}. Other browsing is not recorded.'),
    h('p', { class: 'small' }, `${kept.length ? `${plural(kept.length, 'ended case')} · ${plural(events, 'event')} kept` : 'No ended cases yet.'}${data.case ? ` · open case: ${plural(data.case.log.length, 'event')}` : ''}`),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'sm', 'data-key': 'open-log', onclick: () => act.openPage('log') }, 'Open the activity log'),
      kept.length ? h('button', {
        type: 'button', class: 'sm', 'data-key': 'clear-logs',
        onclick: async () => {
          if (!await confirmDialog({ title: 'Delete the kept logs?', text: `${plural(events, 'event')} from ${plural(kept.length, 'ended case')} are deleted from this browser.`, confirm: 'Delete kept logs', danger: true })) return;
          await mutateStorage(() => ({ patch: { processLog: [] } }), ['processLog']);
          announce('Kept logs deleted');
          act.refresh();
        },
      }, 'Delete kept logs') : null));
}

function dataCard({ data, act }) {
  return h('div', { class: 'card' },
    h('h2', {}, 'Your data'),
    h('p', { class: 'muted' }, 'You work on one case at a time. Its data stays in this browser until you finish or discard the case.'),
    h('button', {
      type: 'button', class: 'sm', 'data-key': 'wipe', style: 'align-self:flex-start',
      onclick: async () => {
        const ok = await confirmDialog({
          title: 'Delete all Power Loader data?',
          text: ['This removes the active case, kept activity logs, your drafts, starred forms, the library copy and settings from this browser.', 'A downloaded privacy model stays in the browser cache; remove it from the Privacy tab.'],
          confirm: 'Delete everything', danger: true,
        });
        if (!ok) return;
        try {
          if (data.case) await endCase(data.case.id, 'discarded');
          await wipeStorage();
          try { await browser.storage.session?.clear(); } catch { /* nothing held there */ }
          announce('All Power Loader data deleted from this browser');
        } catch (e) { announce(describeError(e)); }
        act.refresh();
      },
    }, 'Delete all Power Loader data'));
}

// Settings set by enterprise policy are shown, locked. Firefox reads policy at startup.
function policyCard({ data }) {
  const locked = [...(data.policy?.locked || [])].sort();
  if (!locked.length) return null;
  return h('div', { class: 'card' },
    h('h2', {}, '🔒 Set by your organisation'),
    h('ul', { class: 'impact small' }, locked.map((k) => h('li', {}, h('code', {}, k)))),
    h('p', { class: 'small muted' }, 'These can’t be changed here. A change to them takes effect after Firefox restarts.'));
}

function supportCard({ data, act }) {
  return h('div', { class: 'card' },
    h('h2', {}, 'Support'),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'sm', 'data-key': 'open-ready', onclick: () => act.openPage('ready') }, 'Check Power Loader is ready'),
      h('button', {
        type: 'button', class: 'sm', 'data-key': 'copy-diag',
        onclick: async () => {
          const report = diagnosticsReport(await collectFacts({ libraryAt, policyKeysSet }));
          try { await navigator.clipboard.writeText(report); announce('Diagnostics copied. They include no case data, links or keys.'); } catch { announce('Copy was blocked'); }
        },
      }, 'Copy diagnostics'),
      h('button', {
        type: 'button', class: 'sm', 'data-key': 'backup',
        onclick: async () => {
          // Settings, starred forms, drafts and flows. Never the case, the logs or any key.
          // Keys are stored apart from settings, so they can't be in it.
          const backup = { schema: 'powerloader-backup/1', made: new Date().toISOString(), settings: data.settings || {}, starred: data.starred, profileDrafts: data.drafts, flows: data.flows || [] };
          await saveFile(`power-loader-backup-${backup.made.slice(0, 10)}.json`, JSON.stringify(backup, null, 2)).then(() => announce('Backup saved'), (e) => announce(describeError(e)));
        },
      }, 'Back up settings, drafts and flows')),
    h('p', { class: 'small muted' }, 'Diagnostics list versions, policy keys set, the library commit, the model and gateway status and failure counts. They never include page links, case values, notes or keys. Backups include settings, starred forms, drafts and flows, never the case, logs or keys.'));
}

// The first time the sidebar opens it starts here: what to set up, in order, all on this page.
function welcomeCard({ ui, data, act }) {
  if (!ui.welcome) return null;
  const go = (id) => document.getElementById(id)?.scrollIntoView({ block: 'start' });
  const step = (done, text, id) => h('li', {}, done ? '✓ ' : '', id ? h('button', { type: 'button', class: 'link', onclick: () => go(id) }, text) : text);
  return h('div', { class: 'card', style: 'border:2px solid var(--accent)', role: 'region', 'aria-label': 'Welcome' },
    h('h2', {}, 'Welcome to Power Loader'),
    h('p', {}, 'Set it up here first. Everything you need is on this page:'),
    h('ol', {},
      step(false, 'Download the on-device privacy model (recommended). It finds personal data before anything is sent to the AI.', 'model-setup'),
      step(!!data.lib, 'Connect your team’s forms library, if you have one. Without one you can make flows yourself in the Flows tab.', 'library-setup'),
      step(aiReady(data.settings), 'Turn on the ✦ Remote AI, if your organisation uses one.', 'ai-setup')),
    h('button', { type: 'button', class: 'sm', 'data-key': 'welcome-done', onclick: () => { ui.welcome = false; act.setTab('case'); } }, 'Done for now: go to the Case tab'));
}

export function renderSettings(context) {
  return [
    welcomeCard(context),
    policyCard(context),
    modelSetupCard(context),
    h('div', { id: 'library-setup' }, libraryCard(context)),
    profilesCard(context),
    context.extraSettings ? h('div', { id: 'ai-setup' }, context.extraSettings(context)) : null,
    autoClipCard(context),
    logCard(context),
    supportCard(context),
    legacyCard(context),
    dataCard(context),
    h('p', { class: 'small muted' }, `Power Loader ${browser.runtime.getManifest().version}`),
  ];
}

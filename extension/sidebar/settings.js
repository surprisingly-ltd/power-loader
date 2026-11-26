// Settings: the forms library, the sites Power Loader works on, data from earlier versions, and deleting everything.
/* global browser */
import { h, plural, when, announce, describeError } from '../ui/dom.js';
import { confirmDialog } from '../ui/dialog.js';
import { mutateStorage, wipeStorage } from '../lib/storage.js';
import { endCase } from '../lib/teardown.js';
import { libraryOrigin, syncFailureShown, syncLibrary } from '../lib/library-sync.js';
import { libraryAt, saveSettings } from '../lib/core.js';
import { saveFile } from '../ui/download.js';
import { collectFacts, diagnosticsReport } from '../lib/diagnostics.js';
import { getPolicy, policyKeysSet } from '../lib/policy.js';
import { modelSetupCard } from './privacy.js';
import { modelUse } from '../lib/model-fetch.js';
import { aiReady } from '../lib/ai/settings.js';
import { siteRulesCard } from './site-rules.js';
import { cleanHours, clearsAfter, clearsOnClose, hoursError, hoursText } from '../lib/teardown.js';
import { allowedNote, policyCard, refuseOutside } from './org-policy.js';
import { allowedFor } from '../lib/policy.js';
import { OTHER_SWITCHES, TOOLS, TOOL_NAMES, setTool, toolState } from '../lib/tools.js';

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
      status.textContent = bits.join(' ');
      announce('Library synced');
    }
    act.refresh();
  };
  const connect = () => {
    const baseUrl = form.baseUrl.trim();
    if (!libraryAddressOk(baseUrl)) { status.textContent = 'Enter the library address. It must use https (or http on this computer).'; return; }
    try { refuseOutside(data.policy, 'library.baseUrl', baseUrl.replace('{ref}', 'main')); } catch (e) { status.textContent = e.message; return; }
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
    cfg.locked?.baseUrl ? null : allowedNote(allowedFor(data.policy, 'library.baseUrl'), { 'data-key': 'lib-allowed' }),
    h('label', { class: 'field' }, 'Branch',
      h('input', { type: 'text', 'data-key': 'lib-branch', value: form.branch, disabled: !!cfg.locked?.branch, oninput: (e) => { form.branch = e.target.value; } })),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: lib ? '' : 'primary', 'data-key': 'lib-connect', onclick: connect }, lib ? 'Sync now' : 'Connect'),
      lib ? h('button', { type: 'button', 'data-key': 'lib-open', onclick: () => act.openPage('library') }, 'Open the library') : null),
    status,
    lib ? h('p', {}, `Using commit ${lib.commit}${lib.syncedAt ? ` from ${when(lib.syncedAt)}` : ''}.`) : null,
    syncFailureShown(state) ? h('p', { class: 'notice warn small' }, `Latest sync failed at ${when(last.at)}: ${last.error}${lib ? ' Power Loader keeps using the last good copy.' : ''}`) : null,
    cfg.pinCommit ? h('p', { class: 'small' }, `🔒 Pinned to commit ${cfg.pinCommit} by your organisation.`) : null,
    lib ? h('p', { class: 'small muted' }, `${plural(Object.keys(lib.forms).length, 'form')} · ${plural(lib.profiles.length + lib.fill.length, 'template')}`) : null);
}

// First run: the Case tab asks for the library address before anything else.
export function onboardCard(context) {
  const { cfg, form, status, connect } = libraryActions(context);
  return h('div', { class: 'card' },
    h('h2', {}, 'Connect your team’s forms library'),
    h('p', { class: 'muted' }, 'Power Loader reads your team’s flows, and the forms and pages they use, from one library. Your team lead or IT can give you the address. You only do this once.'),
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
    h('p', {}, `${cases.length ? plural(cases.length, 'case') : ''}${cases.length && profiles.length ? ' and ' : ''}${profiles.length ? plural(profiles.length, 'profile') : ''} from Power Loader 0.5 ${cases.length + profiles.length === 1 ? 'is' : 'are'} still stored in this browser. This version can’t open ${cases.length + profiles.length === 1 ? 'it' : 'them'}: every case now starts from a flow.`),
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

// Every template in the library.
function profilesCard({ data, act }) {
  const lib = data.lib;
  if (!lib) return null;
  const list = [...lib.profiles.map((p) => ({ ...p, kind: 'page' })), ...lib.fill.map((p) => ({ ...p, kind: 'fill' }))];
  return h('div', { class: 'card' },
    h('h2', {}, 'Templates'),
    h('ul', { class: 'plain' }, list.map((p) => h('li', { class: 'row between', style: 'flex-wrap:nowrap' },
      h('span', {}, p.name, ' ', h('span', { class: 'small muted' }, p.kind)), h('span', { class: 'small muted' }, p.version)))),
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

// One list of every tool and its switch. Those with a switch elsewhere say where it is, and aren't switched twice.
function toolsCard({ data, act }) {
  const row = (name) => {
    const { on, locked } = toolState(data.policy, data.settings, name);
    return h('li', { class: 'stack', style: 'gap:2px' },
      h('label', { class: 'check' }, h('input', {
        type: 'checkbox', 'data-key': `tool-${name}`, checked: on, disabled: locked,
        onchange: async (e) => { await saveSettings(setTool(data.settings, name, e.target.checked)); announce(`${TOOLS[name].label} is ${e.target.checked ? 'on' : 'off'}`); act.refresh(); },
      }), h('span', {}, h('b', {}, TOOLS[name].label), locked ? ' 🔒' : '')),
      h('span', { class: 'small muted' }, TOOLS[name].what, locked ? ' Set by your organisation.' : ''));
  };
  const other = (o) => {
    const locked = data.policy?.locked instanceof Set && data.policy.locked.has(o.key);
    return h('li', { class: 'small' }, h('b', {}, o.label), locked ? ' 🔒 Set by your organisation.' : ` Switched in ${o.where}.`);
  };
  return h('div', { class: 'card', 'data-key': 'tools-card' },
    h('h2', {}, 'Tools'),
    h('p', { class: 'small muted' }, 'Turn off a tool you don’t use. Off, it isn’t offered anywhere. Making and changing flows isn’t affected.'),
    h('ul', { class: 'plain stack' }, TOOL_NAMES.map(row)),
    h('ul', { class: 'plain stack', style: 'gap:2px' }, OTHER_SWITCHES.map(other)));
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

// Clear on close: on by default; the caseworker's to change unless the organisation set it.
function clearOnCloseSwitch({ data, act }) {
  const { on, locked } = clearsOnClose(data.policy, data.settings);
  return h('div', { class: 'stack' },
    h('label', { class: 'check' }, h('input', {
      type: 'checkbox', 'data-key': 'clear-on-close', checked: on, disabled: locked,
      onchange: async (e) => { await saveSettings({ clearCaseOnClose: e.target.checked }); announce(e.target.checked ? 'The open case is deleted when you close Firefox' : 'The open case is kept when you close Firefox'); act.refresh(); },
    }), h('span', {}, 'Delete the open case when I close Firefox')),
    h('p', { class: 'small muted' }, locked ? '🔒 Set by your organisation.' : 'On, nothing about a case stays on this computer once Firefox is closed. Off, the case is still there when you start Firefox again.'),
    clearAfterChoice({ data, act }));
}

// Clear after a time without use: the caseworker's to set, in half hours, unless the organisation fixed it or set a
// maximum, which Settings says.
function clearAfterChoice({ data, act }) {
  const { hours, locked, max } = clearsAfter(data.policy, data.settings);
  const status = h('span', { class: 'small', role: 'status', 'aria-live': 'polite' });
  const save = async (value) => {
    const err = hoursError(data.policy, value);
    if (err) { status.textContent = err; return; }
    await saveSettings({ clearCaseAfterHours: cleanHours(value) });
    announce(cleanHours(value) ? `The open case is deleted after ${hoursText(cleanHours(value))} without use` : 'The open case is never deleted for being left without use');
    act.refresh();
  };
  const input = h('input', { type: 'number', min: '0.5', step: '0.5', ...(max ? { max: String(max) } : {}), 'data-key': 'clear-after', value: hours ? String(hours) : '', disabled: locked || !hours, style: 'width:6em',
    onchange: (e) => save(e.target.value) });
  return h('div', { class: 'stack', style: 'gap:4px' },
    h('label', { class: 'field' }, 'Delete the open case after this many hours without use', input),
    max || locked ? null : h('label', { class: 'check small' }, h('input', { type: 'checkbox', 'data-key': 'clear-never', checked: !hours, onchange: (e) => save(e.target.checked ? 0 : 24) }), h('span', {}, 'Never')),
    h('p', { class: 'small muted' }, locked ? `🔒 Set by your organisation: ${hours ? `after ${hoursText(hours)}` : 'never'}.`
      : max ? `Your organisation allows ${hoursText(max)} at most. Now: after ${hoursText(hours)} without use.`
        : hours ? `Now: after ${hoursText(hours)} without use. In half hours, from 0.5.` : 'Now: never.'),
    status);
}

function dataCard({ data, act }) {
  return h('div', { class: 'card' },
    h('h2', {}, 'Your data'),
    h('p', { class: 'muted' }, 'You work on one case at a time. Its data stays in this browser until you finish or discard the case.'),
    clearOnCloseSwitch({ data, act }),
    h('button', {
      type: 'button', class: 'sm', 'data-key': 'wipe', style: 'align-self:flex-start',
      onclick: async () => {
        const ok = await confirmDialog({
          title: 'Delete all Power Loader data?',
          text: ['This removes the active case, kept activity logs, your flows, starred flows, the library copy and settings from this browser.', 'A downloaded privacy model stays in the browser cache; remove it from the Privacy tab.'],
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

// Settings set by the organisation are shown, locked: sidebar/org-policy.js policyCard.

function supportCard({ data, act }) {
  return h('div', { class: 'card' },
    h('h2', {}, 'Support'),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'sm', 'data-key': 'open-ready', onclick: () => act.openPage('ready') }, 'Check Power Loader is ready'),
      h('button', {
        type: 'button', class: 'sm', 'data-key': 'copy-diag',
        onclick: async () => {
          const siteRules = (data.access || []).map((l) => ({ layer: l.layer, rules: l.rules.length, broken: l.broken !== undefined }));
          const report = diagnosticsReport(await collectFacts({ libraryAt, policyKeysSet, siteRules, getPolicy }));
          try { await navigator.clipboard.writeText(report); announce('Diagnostics copied. They include no case data, links or keys.'); } catch { announce('Copy was blocked'); }
        },
      }, 'Copy diagnostics'),
      h('button', {
        type: 'button', class: 'sm', 'data-key': 'backup',
        onclick: async () => {
          // Settings, starred flows and flows. Never the case, the logs or any key.
          // Keys are stored apart from settings, so they can't be in it.
          const backup = { schema: 'powerloader-backup/1', made: new Date().toISOString(), settings: data.settings || {}, starred: data.starred, flows: data.flows || [] };
          await saveFile(`power-loader-backup-${backup.made.slice(0, 10)}.json`, JSON.stringify(backup, null, 2)).then(() => announce('Backup saved'), (e) => announce(describeError(e)));
        },
      }, 'Back up settings and flows')),
    h('p', { class: 'small muted' }, 'Diagnostics list versions, policy keys set, the library commit, how many site rules are set, the model and gateway status and failure counts. They never include page links, case values, notes or keys. Backups include settings, starred flows and your flows, never the case, logs or keys.'));
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
      modelUse(data.policy, data.lib, data.settings).on ? step(false, 'Download the on-device privacy model (recommended if you use the ✦ AI). It finds personal data before anything is sent to the AI.', 'model-setup') : null,
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
    siteRulesCard(context),
    profilesCard(context),
    context.extraSettings ? h('div', { id: 'ai-setup' }, context.extraSettings(context)) : null,
    autoClipCard(context),
    toolsCard(context),
    logCard(context),
    supportCard(context),
    legacyCard(context),
    dataCard(context),
    h('p', { class: 'small muted' }, `Power Loader ${browser.runtime.getManifest().version}`),
  ];
}

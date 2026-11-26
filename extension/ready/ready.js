// "Check Power Loader is ready": run by IT at deployment and by caseworkers from Settings. Each check reports
// what it found and, when it fails, a specific fix. Standard features stay available whatever fails.
/* global browser */
import '../lib/extract.js';
import { h, rerender, announce } from '../ui/dom.js';
import { getPolicy, policyKeysSet } from '../lib/policy.js';
import { fetchLibrary, libraryConfig, libraryOrigin } from '../lib/library-sync.js';
import { indexLibrary } from '../lib/library.js';
import { libraryAt } from '../lib/core.js';
import { connectionConfig, getSettings } from '../lib/ai/settings.js';
import { complete } from '../lib/ai/client.js';
import { approve, prepare } from '../lib/ai/boundary.js';
import { effectiveSettings } from '../lib/privacy-detect.js';
import { modelSource } from '../lib/model-fetch.js';
import { describeModel, loadModel } from '../lib/privacy-client.js';
import { collectFacts, diagnosticsReport, webgpuInfo } from '../lib/diagnostics.js';
import { returnToSidebar } from '../lib/pages.js';
import { fixedHosts } from '../lib/build-hosts.js';

// An organisation build's hosts are granted at install. A caseworker can still switch a site off in Firefox's
// add-on manager: name what's missing, and how to turn it back on.
async function permissionsCheck(hosts) {
  const missing = [];
  for (const h of hosts) if (!await browser.permissions.contains({ origins: [h] }).catch(() => false)) missing.push(h);
  return missing.length
    ? fail(`Power Loader isn’t allowed on ${missing.join(', ')}, which your organisation’s version needs.`, 'Turn it back on: open about:addons, choose Power Loader, then Permissions, and switch on the sites listed.')
    : hosts.includes('<all_urls>') ? pass(`Every site your organisation’s version needs is allowed: ${hosts.join(', ')}.`)
      : (browser.runtime.getManifest().permissions || []).includes('activeTab')
        ? pass(`Every site your organisation’s version needs is allowed: ${hosts.join(', ')}. Selecting a region starts from the page: its right-click menu, or Alt+Shift+R.`)
        : warn(`Every site your organisation’s version needs is allowed: ${hosts.join(', ')}. Selecting a region is turned off in this version.`, 'Nothing to do: caseworkers paste a screenshot instead (Win+Shift+S, then Ctrl+V).');
}

// Needed for the model download and cache, with room to spare.
const MODEL_BYTES = 1.2e9;

// Things no browser check can prove. A person checks these on the real laptops before rollout.
export const HUMAN_CHECKS = [
  'WebGPU works on each laptop model in the estate, in the deployed Firefox or ESR version; record cold and warm model load times and memory use.',
  'Every model file loads from the chosen model server (huggingface.co and its download CDN by default, or the address set by policy), and a proxy log shows no other model requests.',
  'The library loads from the enterprise git host with the chosen read authentication (token in managed storage, or SSO cookies).',
  'Authenticated PDFs and blob: documents can be read from the document store under cookie partitioning, containers and frames.',
  'Region capture crops correctly at 125%, 150% and 200% Windows scaling, with browser zoom and scrolled pages (⬚ Select a region in the reader).',
  'The signed XPI installs through the managed channel, and the CSP (wasm-unsafe-eval, blob: images) and the vendored libraries pass review.',
  'Managed storage policy applies after a Firefox restart, and locked settings show as locked.',
  'The DPIA, retention period, access to logs and the staff notice are agreed before the activity log is used.',
  'Keyboard-only and NVDA users can complete clipping, conflicts, reading and finishing at sidebar width.',
];

const checks = [
  { id: 'policy', title: 'Managed configuration loaded' },
  { id: 'library', title: 'Forms library reachable and valid' },
  { id: 'gateway', title: 'AI gateway reachable with the key' },
  { id: 'webgpu', title: 'WebGPU adapter' },
  { id: 'model', title: 'Privacy model downloaded, started and test-scanned' },
  { id: 'storage', title: 'Free storage' },
  { id: 'capture', title: 'Capture permission' },
];
const results = {};

const pass = (text) => ({ state: 'pass', text });
const warn = (text, fix) => ({ state: 'warn', text, fix });
const fail = (text, fix) => ({ state: 'fail', text, fix });

const run = {
  async policy() {
    const p = await getPolicy({ fresh: true });
    const keys = await policyKeysSet();
    if (p.builtIn) {
      const ignored = p.managedIgnored ? ' Managed storage (policies.json) is set for this extension, but an organisation build ignores it.' : '';
      return (p.managedIgnored ? warn : pass)(`Rules built in by ${p.builtIn.name}: ${keys.length ? keys.join(', ') : 'none set'}.${ignored}`,
        p.managedIgnored ? 'Nothing to do: to change a rule, ship a new version of the organisation build. Remove the policies.json section if it isn’t needed.' : undefined);
    }
    return p.managed ? pass(`${p.locked.size} setting${p.locked.size === 1 ? '' : 's'} set by policy: ${[...p.locked].sort().join(', ')}`)
      : warn('No managed policy found. Every setting is the caseworker’s to set.', 'For a managed rollout, deploy the policies.json “3rdparty” section for this extension, then restart Firefox.');
  },
  async library() {
    const cfg = await libraryConfig();
    if (!cfg.baseUrl) return fail('No library address is set.', 'Set library.baseUrl in policy, or enter the address in Settings.');
    if (!await browser.permissions.contains({ origins: [libraryOrigin(cfg.baseUrl)] })) return fail('Power Loader has no permission to read the library address.', 'Grant the library host permission in the managed install, or press Connect in Settings.');
    try {
      const set = await fetchLibrary(cfg);
      const { library } = await browser.storage.local.get('library');
      const using = library ? libraryAt(library, library.current) : null;
      const lib = indexLibrary(set);
      const pinNote = cfg.pinCommit ? ` (pinned to ${cfg.pinCommit} by policy)` : '';
      if (using && using.commit !== set.commit) return warn(`The library is at commit ${set.commit}${pinNote}, but this computer uses ${using.commit}.`, 'Sync the library from Settings.');
      return pass(`Commit ${set.commit}${pinNote}: ${Object.keys(lib.forms).length} forms, ${lib.profiles.length} page profiles, ${lib.fill.length} fill profiles, all valid.`);
    } catch (e) {
      return fail(`The library check failed: ${e.message}`, /refused access/.test(e.message) ? 'Check the library read token or sign-in with the git host administrators.' : 'Check the address, the network path to the library host and the published library.json.');
    }
  },
  async gateway() {
    let config;
    try { config = await connectionConfig(); } catch (e) { return warn(`Not set up: ${e.message}`, 'Enhanced (✦) tools stay off until the gateway, key and consent are set in Settings. Standard tools work without it.'); }
    try {
      const payload = approve(prepare({ purpose: 'test', parts: [{ id: 't', kind: 'text', text: 'Reply with OK.' }], compose: (s) => [{ role: 'user', content: s.t }] },
        { known: [], patterns: [], settings: effectiveSettings(), model: { ready: true, required: false } }));
      await complete(payload, config);
      await browser.storage.session.set({ gatewayStatus: { ok: true, status: 200, at: new Date().toISOString() } });
      return pass(`One synthetic request answered, with model ${config.model}.`);
    } catch (e) {
      const status = /rejected/.test(e.message) ? 401 : /denied/.test(e.message) ? 403 : /HTTP (\d+)/.exec(e.message)?.[1] || null;
      await browser.storage.session.set({ gatewayStatus: { ok: false, status, at: new Date().toISOString() } });
      return fail(`The gateway refused or failed the test request: ${e.message}`, status === 401 ? 'The key is wrong or expired: ask for this extension’s own virtual key.' : 'Check the gateway address, its host permission and the network path to it.');
    }
  },
  async webgpu() {
    const g = await webgpuInfo();
    return g.available ? pass(`Adapter found${g.vendor ? `: ${g.vendor} ${g.architecture}` : ''}.`)
      : fail('No usable WebGPU adapter.', 'The on-device privacy model needs WebGPU. Check the graphics driver and Firefox version; policy decides whether ✦ actions are blocked without it.');
  },
  async model() {
    const { library } = await browser.storage.local.get('library');
    const source = modelSource(await getPolicy(), library ? libraryAt(library, library.current) : null, await getSettings());
    // Switched off by the organisation, the library or the caseworker: nothing to download or check.
    if (!source.use.on) return pass(`Not used: switched off ${{ policy: 'by your organisation', library: 'by your library', you: 'in Settings' }[source.use.from] || ''}. Case values and the library’s patterns are still redacted before anything goes to the AI.`);
    const m = await loadModel(source);
    if (m.state === 'ready') return pass(`${describeModel(m)}. ${source.hashes ? 'File hashes were checked.' : 'No file hashes are set, so files weren’t checked against them.'}`);
    const fixes = { config: 'Set a pinned revision for the model server, in policy (privacyModel.revision) or the library’s privacy.json.', blocked: 'A request went outside the model server; check the model server address. A folder address must be the folder that holds config.json.', denied: 'The model server refused access: check the address, or its authentication.', hash: 'A model file doesn’t match its expected hash: check the model server serves that revision unchanged.', webgpu: 'See the WebGPU check above.', disk: 'Free disk space: the model needs about 1 GB.', test: 'The model loaded but its test scan failed: check the revision.', unreachable: 'Check the network path to the model server.' };
    return fail(describeModel(m), fixes[m.reason] || 'Check the model server settings.');
  },
  async storage() {
    const e = await navigator.storage?.estimate?.().catch(() => null);
    if (!e) return warn('The browser didn’t report storage.', 'Check free disk space on this computer.');
    const free = (e.quota || 0) - (e.usage || 0);
    return free > MODEL_BYTES ? pass(`${Math.round(free / 1e9 * 10) / 10} GB free for Power Loader.`)
      : fail(`Only ${Math.round(free / 1e6)} MB free for Power Loader.`, 'Free disk space: the privacy model needs about 1 GB, and the case and logs need a little more.');
  },
  async capture() {
    const all = await browser.permissions.contains({ origins: ['<all_urls>'] });
    const fixed = fixedHosts();
    if (!all && fixed) return permissionsCheck(fixed);
    return all ? pass('Screen capture is allowed (<all_urls>).')
      : warn('<all_urls> isn’t granted, so ⬚ Select a region asks for it the first time it’s used. While site rules are set it doesn’t ask, and a pasted screenshot works instead.', 'Nothing to do unless you want region capture without the prompt: grant <all_urls> through the managed install.');
  },
};

async function runAll() {
  for (const c of checks) results[c.id] = { state: 'running' };
  render();
  for (const c of checks) {
    try { results[c.id] = await run[c.id](); } catch (e) { results[c.id] = fail(`The check itself failed: ${e.message}`, 'Try again, then send the diagnostics to IT.'); }
    render();
  }
  announce('Checks finished');
}

async function copyDiagnostics() {
  const report = diagnosticsReport(await collectFacts({ libraryAt, policyKeysSet, getPolicy }));
  try { await navigator.clipboard.writeText(report); announce('Diagnostics copied. They include no case data, links or keys.'); } catch { announce('Copy was blocked'); }
}

const ICON = { pass: ['ok', '✓ Pass'], warn: ['warn', '! Check'], fail: ['bad', '✕ Fail'], running: ['', 'Checking…'] };

function render() {
  rerender(document.getElementById('app'),
    h('div', { class: 'page-head' },
      h('div', {}, h('div', { class: 'eyebrow' }, 'Support'), h('h1', {}, 'Check Power Loader is ready'), h('p', { class: 'meta' }, `Power Loader ${browser.runtime.getManifest().version}. Standard features stay available whatever fails here.`)),
      h('div', { class: 'row' },
        h('button', { type: 'button', 'data-key': 'back', onclick: async () => { const r = await returnToSidebar(); if (!r.ok) announce(r.reason); } }, 'Back to the sidebar'),
        h('button', { type: 'button', class: 'primary', 'data-key': 'run', onclick: runAll }, 'Run the checks'),
        h('button', { type: 'button', 'data-key': 'diag', onclick: copyDiagnostics }, 'Copy diagnostics'))),
    h('ol', { class: 'checks' }, checks.map((c) => {
      const r = results[c.id];
      return h('li', { class: `card ${r ? { pass: 'pass', warn: 'check', fail: 'fail' }[r.state] || '' : ''}` },
        h('div', { class: 'row between' }, h('h2', {}, c.title), r ? h('span', { class: `pill ${ICON[r.state][0]}`, role: 'status' }, ICON[r.state][1]) : h('span', { class: 'pill' }, 'Not run')),
        r?.text ? h('p', {}, r.text) : null,
        r?.fix ? h('p', { class: 'small' }, h('b', {}, 'To fix: '), r.fix) : null);
    })),
    h('div', { class: 'card' },
      h('h2', {}, 'Checked by a person before rollout'),
      h('p', { class: 'small muted' }, 'These can’t be proved from inside the browser. See section 5 of the release plan.'),
      h('ul', { class: 'impact' }, HUMAN_CHECKS.map((t) => h('li', {}, t)))),
    h('p', { class: 'small muted' }, 'A change to managed policy takes effect after Firefox restarts.'));
}

render();

// Reading the forms library. A git URL isn't a download protocol, so the library publishes a manifest
// (library.json) at each commit, listing every file with its SHA-256. One sync is all from one commit:
// every file is checked against the manifest and validated before the set replaces the last known good one.
/* global browser */
import { mutateStorage } from './storage.js';
import { indexLibrary } from './library.js';
import { allowedFor, checkAllowed, getPolicy } from './policy.js';
import { sha256Hex } from './hash.js';
import { recordFailure } from './diagnostics.js';

const MAX_FILE = 2_000_000;
const MAX_FILES = 500;

// Where the library comes from: policy first (locked), then the caseworker's settings.
export async function libraryConfig() {
  const { values, locked } = await getPolicy();
  const { settings = {} } = await browser.storage.local.get('settings');
  const mine = settings.library || {};
  const pick = (k) => (locked.has(`library.${k}`) ? values.library[k] : mine[k] ?? values.library[k]);
  return {
    baseUrl: pick('baseUrl'), branch: pick('branch') || 'main', pinCommit: values.library.pinCommit,
    auth: values.library.auth, token: values.library.token, syncMinutes: values.library.syncMinutes,
    // A built-in policy file may allow the address by pattern: every file address is checked as it is fetched.
    allowed: allowedFor({ values }, 'library.baseUrl'),
    locked: { baseUrl: locked.has('library.baseUrl'), branch: locked.has('library.branch') },
  };
}

// "{ref}" in the address is replaced by the branch, or by the commit once the manifest names it.
export function libraryUrl(base, ref, path = '') {
  const b = String(base).includes('{ref}') ? String(base).replace('{ref}', encodeURIComponent(ref)) : String(base);
  const url = new URL(b.endsWith('/') ? b : `${b}/`);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Use HTTPS for remote libraries or HTTP on loopback');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('The library address must not contain credentials, query parameters or a fragment');
  const result = new URL(path, url);
  if (result.origin !== url.origin || (url.protocol === 'https:' && result.protocol !== 'https:')) throw new Error('Library files must stay on the library origin');
  return result.href;
}

export function libraryOrigin(base) {
  const u = new URL(libraryUrl(base, 'main'));
  return `${u.protocol}//${u.hostname}/*`;
}

const safePath = (p) => typeof p === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]*\.json$/.test(p) && !p.split('/').includes('..');

export function validateManifest(m) {
  const errors = [];
  if (!m || typeof m !== 'object') return ['library.json is not a JSON object'];
  if (m.schema !== 'powerloader-library/1') errors.push('library.json has an unknown schema');
  if (typeof m.commit !== 'string' || !/^[0-9a-f]{7,40}$/.test(m.commit)) errors.push('library.json has no commit');
  if (!Array.isArray(m.files) || !m.files.length || m.files.length > MAX_FILES) errors.push('library.json lists no files');
  else for (const f of m.files) if (!safePath(f?.path) || !/^[0-9a-f]{64}$/.test(f?.sha256 || '')) errors.push(`library.json has a bad entry: ${String(f?.path).slice(0, 80)}`);
  if (m.history !== undefined && (typeof m.history !== 'object' || Array.isArray(m.history))) errors.push('library.json history must map paths to versions');
  if (m.approvedHosts !== undefined && !(Array.isArray(m.approvedHosts) && m.approvedHosts.every((h) => typeof h === 'string'))) errors.push('library.json approvedHosts must be a list of hosts');
  return errors;
}

async function get(url, cfg, fetchFn) {
  if (cfg.allowed) checkAllowed({ values: { allowed: { 'library.baseUrl': cfg.allowed } } }, 'library.baseUrl', url);
  const headers = cfg.auth === 'token' && cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {};
  let res;
  try {
    res = await fetchFn(url, { headers, credentials: cfg.auth === 'cookies' ? 'include' : 'omit', cache: 'no-store', redirect: 'error' });
  } catch {
    throw new Error('Couldn’t reach the library. Check the address and your connection.');
  }
  // Redirects may only stay on the library's own host.
  if (res.url && new URL(res.url).host !== new URL(url).host) throw new Error('The library redirected to another host, which isn’t allowed');
  if (res.status === 401 || res.status === 403) throw new Error(`The library refused access (HTTP ${res.status}). Ask IT to check the library sign-in.`);
  if (!res.ok) throw new Error(`The library returned HTTP ${res.status} for ${new URL(url).pathname.split('/').pop()}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_FILE) throw new Error('A library file is too large');
  return new Uint8Array(buf);
}

/**
 * Fetch, check and validate one commit of the library. Resolves the stored set; rejects without
 * changing anything when a file is missing, has the wrong hash or fails validation.
 * have: the set already held. When the manifest names its commit, resolves { unchanged: true, commit } after
 * fetching only library.json; otherwise a file whose hash is the same as the held copy's isn't fetched again.
 */
export async function fetchLibrary(cfg, { fetchFn = globalThis.fetch, now = new Date(), have = null } = {}) {
  if (!cfg.baseUrl) throw new Error('Enter the library address');
  const ref = cfg.pinCommit || cfg.branch;
  const manifestBytes = await get(libraryUrl(cfg.baseUrl, ref, 'library.json'), cfg, fetchFn);
  let manifest;
  try { manifest = JSON.parse(new TextDecoder().decode(manifestBytes)); } catch { throw new Error('library.json isn’t valid JSON'); }
  const errors = validateManifest(manifest);
  if (errors.length) throw new Error(errors[0]);
  if (cfg.pinCommit && !manifest.commit.startsWith(cfg.pinCommit) && !cfg.pinCommit.startsWith(manifest.commit)) {
    throw new Error(`The library is pinned to ${cfg.pinCommit} by policy, but the server offered ${manifest.commit}`);
  }
  if (have?.files && have.commit === manifest.commit) return { unchanged: true, commit: manifest.commit };
  const held = new Map((have?.files && Array.isArray(have.manifest?.files) ? have.manifest.files : []).map((f) => [f.path, f.sha256]));
  const files = {};
  for (const f of manifest.files) {
    // Checked against its hash when it was fetched, and the hash is the same: the held copy is this file.
    if (held.get(f.path) === f.sha256 && have.files[f.path] !== undefined) { files[f.path] = have.files[f.path]; continue; }
    // From the commit the manifest names, so a push during the sync can't mix two versions.
    const bytes = await get(libraryUrl(cfg.baseUrl, manifest.commit, f.path), cfg, fetchFn);
    if (await sha256Hex(bytes) !== f.sha256) throw new Error(`${f.path} doesn’t match the library manifest (wrong hash)`);
    try { files[f.path] = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error(`${f.path} isn’t valid JSON`); }
  }
  const set = { commit: manifest.commit, message: String(manifest.message || '').slice(0, 200), syncedAt: now.toISOString(), manifest: { ...manifest }, files };
  const lib = indexLibrary(set);
  if (lib.problems.length) {
    const p = lib.problems[0];
    throw new Error(`${p.path} failed validation: ${p.errors[0]}${lib.problems.length > 1 ? ` (and ${lib.problems.length - 1} more)` : ''}`);
  }
  return set;
}

// Keep the current set, the previous one (last known good) and whatever the active case is pinned to.
export function pruneSets(state, caseCommit) {
  const keep = new Set([state.current, state.previous, caseCommit].filter(Boolean));
  state.sets = Object.fromEntries(Object.entries(state.sets || {}).filter(([commit]) => keep.has(commit)));
  return state;
}

// A timed sync that fails says nothing to the caseworker until the library has been out of date this long.
export const STALE_MS = 24 * 3600_000;

/** Should a failed sync be shown? Always after the caseworker asked for it; after a timed one, once it's stale. */
export function syncFailureShown(state, now = Date.now()) {
  const last = state?.lastSync;
  if (!last || last.ok) return false;
  if (!last.auto) return true;
  const good = state.lastGood || state.sets?.[state.current]?.syncedAt;
  return !good || now - Date.parse(good) > STALE_MS;
}

/**
 * Sync now. Resolves { ok, commit, changed, error? }. auto: a timed sync (at start, on the alarm, when the sidebar
 * opens), which fetches only library.json when the commit is held and only changed files otherwise, and whose
 * failure is recorded without a message until the library is a day out of date.
 */
export async function syncLibrary({ fetchFn, now = new Date(), auto = false } = {}) {
  const cfg = await libraryConfig();
  const { library: held } = await browser.storage.local.get('library');
  let set;
  try {
    // A timed sync fetches only what changed; Sync now (and the readiness check) fetches and checks every file.
    set = await fetchLibrary(cfg, { fetchFn, now, have: auto ? held?.sets?.[held.current] || null : null });
  } catch (e) {
    const error = e.message || String(e);
    void recordFailure('library-sync');
    await mutateStorage(({ library }) => ({ patch: { library: { sets: {}, ...library, lastSync: { at: now.toISOString(), ok: false, error, ...(auto ? { auto } : {}) } } } }), ['library']);
    return { ok: false, error };
  }
  if (set.unchanged) {
    return mutateStorage(({ library }) => {
      const state = { sets: {}, ...(library || {}) };
      // Another sync may have moved on meanwhile: only the commit it checked is confirmed.
      if (state.current !== set.commit) return { result: { ok: true, commit: state.current, changed: false } };
      state.lastSync = { at: now.toISOString(), ok: true, commit: set.commit };
      state.lastGood = now.toISOString();
      return { patch: { library: state }, result: { ok: true, commit: set.commit, changed: false } };
    }, ['library']);
  }
  return mutateStorage(({ library, case: c }) => {
    const state = { sets: {}, ...(library || {}) };
    const changed = state.current !== set.commit;
    if (changed) state.previous = state.current || null;
    state.sets = { ...state.sets, [set.commit]: set };
    state.current = set.commit;
    state.lastSync = { at: now.toISOString(), ok: true, commit: set.commit };
    state.lastGood = now.toISOString();
    pruneSets(state, c?.library?.commit);
    return { patch: { library: state }, result: { ok: true, commit: set.commit, changed } };
  }, ['library', 'case']);
}

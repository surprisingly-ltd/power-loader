import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { manifest } from './helpers/library.js';
import { fetchLibrary, libraryUrl, pruneSets, syncFailureShown, syncLibrary, validateManifest } from '../../extension/lib/library-sync.js';
import { registerStorageWriter } from '../../extension/lib/storage.js';

const BASE = 'https://git.example.gov.uk/lib/-/raw/{ref}/';
const demo = (path) => readFileSync(new URL(`../../demo/library/${path}`, import.meta.url));
let state, requests, serve;
// A library server: files by commit; branch "main" resolves to the current commit's manifest.
function server({ files = {}, manifestOverride, redirectTo } = {}) {
  return async (url, init) => {
    requests.push({ url, init });
    const u = new URL(url);
    const m = /\/raw\/([^/]+)\/(.+)$/.exec(u.pathname);
    const [, ref, path] = m;
    if (redirectTo) return { ok: true, status: 200, url: redirectTo, arrayBuffer: async () => new ArrayBuffer(0) };
    let body;
    if (path === 'library.json') body = Buffer.from(JSON.stringify(manifestOverride || manifest));
    else if (ref !== manifest.commit) return { ok: false, status: 404, url };
    else body = files[path] ?? demo(path);
    return { ok: true, status: 200, url, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
  };
}
const cfg = (extra = {}) => ({ baseUrl: BASE, branch: 'main', auth: 'none', ...extra });

beforeEach(() => { requests = []; });

test('library addresses require encrypted remote transport and cannot contain credentials', async () => {
  for (const baseUrl of ['http://library.example/lib/', 'https://user:secret@library.example/lib/', 'https://library.example/lib/?token=secret', 'file:///tmp/library/']) {
    await assert.rejects(fetchLibrary(cfg({ baseUrl }), { fetchFn: server() }), /HTTPS|credentials/);
    assert.equal(requests.length, 0);
  }
  assert.equal(libraryUrl('http://[::1]:8787/lib/', 'main', 'library.json'), 'http://[::1]:8787/lib/library.json');
  assert.throws(() => libraryUrl(BASE, 'main', 'https://elsewhere.example/file.json'), /origin/);
});

test('a sync fetches the manifest by branch, then every file from the commit it names', async () => {
  const set = await fetchLibrary(cfg(), { fetchFn: server() });
  assert.equal(set.commit, manifest.commit);
  assert.equal(Object.keys(set.files).length, manifest.files.length);
  assert.match(requests[0].url, /\/raw\/main\/library\.json$/);
  assert.ok(requests.slice(1).every((r) => r.url.includes(`/raw/${manifest.commit}/`)));
  assert.equal(requests[0].init.credentials, 'omit');
  assert.equal(requests[0].init.redirect, 'error');
});

test('a file with the wrong hash, or that fails validation, rejects the whole set', async () => {
  await assert.rejects(fetchLibrary(cfg(), { fetchFn: server({ files: { 'forms/hsr.json': Buffer.from('{"tampered":true}') } }) }), /forms\/hsr\.json doesn’t match the library manifest/);
  // A profile that is valid JSON with the right hash but clicks: validation rejects it.
  const bad = Buffer.from(JSON.stringify({ ...JSON.parse(demo('profiles/fill/dhp.json')), lists: [{ source: 'CaseData.x', rows: 'tr', add: '#go', fields: { a: '.b' } }] }));
  const { createHash } = await import('node:crypto');
  const m2 = { ...manifest, files: manifest.files.map((f) => (f.path === 'profiles/fill/dhp.json' ? { ...f, sha256: createHash('sha256').update(bad).digest('hex') } : f)) };
  await assert.rejects(fetchLibrary(cfg(), { fetchFn: server({ files: { 'profiles/fill/dhp.json': bad }, manifestOverride: m2 }) }), /failed validation: Fill profiles can’t click/);
});

test('policy can pin a commit, and the library may not redirect elsewhere', async () => {
  await assert.rejects(fetchLibrary(cfg({ pinCommit: 'abcdef0' }), { fetchFn: server() }), /pinned to abcdef0/);
  const pinned = await fetchLibrary(cfg({ pinCommit: manifest.commit }), { fetchFn: server() });
  assert.equal(pinned.commit, manifest.commit);
  assert.match(requests.at(-manifest.files.length - 1).url, new RegExp(`/raw/${manifest.commit}/library.json`));
  await assert.rejects(fetchLibrary(cfg(), { fetchFn: server({ redirectTo: 'https://elsewhere.example/x' }) }), /redirected to another host/);
});

test('a read token from policy is sent as a bearer header; cookies only when policy says so', async () => {
  await fetchLibrary(cfg({ auth: 'token', token: 'policy-token' }), { fetchFn: server() });
  assert.equal(requests[0].init.headers.Authorization, 'Bearer policy-token');
  requests = [];
  await fetchLibrary(cfg({ auth: 'cookies' }), { fetchFn: server() });
  assert.equal(requests[0].init.credentials, 'include');
  assert.equal(requests[0].init.headers.Authorization, undefined);
});

test('manifests with unsafe paths or no commit are refused', () => {
  assert.match(validateManifest({ ...manifest, files: [{ path: '../secret.json', sha256: 'a'.repeat(64) }] })[0], /bad entry/);
  assert.match(validateManifest({ ...manifest, commit: '' })[0], /no commit/);
  assert.equal(libraryUrl('http://localhost:8787/demo/library', 'main', 'library.json'), 'http://localhost:8787/demo/library/library.json');
});

test('sets kept: current, last known good, and the commit the active case is pinned to', () => {
  const s = pruneSets({ current: 'c3', previous: 'c2', sets: { c1: {}, c2: {}, c3: {}, c0: {} } }, 'c0');
  assert.deepEqual(Object.keys(s.sets).sort(), ['c0', 'c2', 'c3']);
});

test('syncLibrary records failures without replacing the last good set, and retires published drafts', async () => {
  state = { settings: { library: { baseUrl: BASE, branch: 'main' } }, library: { current: 'old1234', sets: { old1234: { commit: 'old1234', files: {} } } } };
  globalThis.browser = {
    storage: { local: { get: async (k) => structuredClone(Object.fromEntries([k].flat().filter((x) => x in state).map((x) => [x, state[x]]))), set: async (p) => Object.assign(state, structuredClone(p)) } },
    runtime: { id: 'x', onMessage: { addListener() {} } },
  };
  registerStorageWriter();
  const failed = await syncLibrary({ fetchFn: async () => { throw new Error('offline'); } });
  assert.equal(failed.ok, false);
  assert.equal(state.library.current, 'old1234');
  assert.match(state.library.lastSync.error, /Couldn’t reach the library/);
  const ok = await syncLibrary({ fetchFn: server() });
  assert.equal(ok.ok, true);
  assert.equal(state.library.current, manifest.commit);
  assert.equal(state.library.previous, 'old1234');
});

test('a timed sync fetches only library.json when the commit is the one held, and only changed files otherwise', async () => {
  const have = await fetchLibrary(cfg(), { fetchFn: server() });
  requests = [];
  const same = await fetchLibrary(cfg(), { fetchFn: server(), have });
  assert.deepEqual(same, { unchanged: true, commit: manifest.commit });
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /library\.json$/);
  // A new commit that changes one file: only that file is fetched.
  const { createHash } = await import('node:crypto');
  const changed = Buffer.from(JSON.stringify({ ...JSON.parse(demo('forms/hsr.json')), name: 'Housing support request (changed)' }));
  const next = { ...manifest, commit: 'feedc0de', files: manifest.files.map((f) => (f.path === 'forms/hsr.json' ? { ...f, sha256: createHash('sha256').update(changed).digest('hex') } : f)) };
  requests = [];
  const fetchFn = async (url, init) => {
    const path = /\/raw\/[^/]+\/(.+)$/.exec(new URL(url).pathname)[1];
    if (path === 'library.json') { const body = Buffer.from(JSON.stringify(next)); return { ok: true, status: 200, url, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) }; }
    requests.push({ url, init });
    const body = path === 'forms/hsr.json' ? changed : demo(path);
    return { ok: true, status: 200, url, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
  };
  const set = await fetchLibrary(cfg(), { fetchFn, have });
  assert.equal(set.commit, 'feedc0de');
  assert.deepEqual(requests.map((r) => r.url), ['https://git.example.gov.uk/lib/-/raw/feedc0de/forms/hsr.json']);
  assert.equal(set.files['forms/hsr.json'].name, 'Housing support request (changed)');
  assert.equal(Object.keys(set.files).length, manifest.files.length);
});

test('a failed timed sync says nothing until the library is a day out of date', () => {
  const now = Date.parse('2026-11-26T12:00:00Z');
  const st = (lastSync, lastGood) => ({ current: 'c1', sets: { c1: { syncedAt: '2026-11-20T00:00:00Z' } }, lastSync, lastGood });
  assert.equal(syncFailureShown(st({ ok: false, auto: true, at: 't' }, '2026-11-26T09:00:00Z'), now), false);
  assert.equal(syncFailureShown(st({ ok: false, auto: true, at: 't' }, '2026-11-25T09:00:00Z'), now), true);
  assert.equal(syncFailureShown(st({ ok: false, auto: true, at: 't' }), now), true, 'no good sync since: the set’s own date');
  assert.equal(syncFailureShown(st({ ok: false, at: 't' }, '2026-11-26T09:00:00Z'), now), true, 'asked for: always shown');
  assert.equal(syncFailureShown(st({ ok: true }), now), false);
});

test('syncLibrary with the commit already held records the sync and keeps the set', async () => {
  const set = await fetchLibrary(cfg(), { fetchFn: server() });
  state.settings = { library: { baseUrl: BASE, branch: 'main' } };
  state.library = { current: set.commit, sets: { [set.commit]: set } };
  requests = [];
  const out = await syncLibrary({ fetchFn: server(), auto: true, now: new Date('2026-11-26T10:00:00Z') });
  assert.deepEqual(out, { ok: true, commit: set.commit, changed: false });
  assert.equal(requests.length, 1);
  assert.equal(state.library.lastGood, '2026-11-26T10:00:00.000Z');
  assert.equal(state.library.sets[set.commit].files['forms/hsr.json'].id, set.files['forms/hsr.json'].id);
  requests = [];
  await syncLibrary({ fetchFn: server() });
  assert.equal(requests.length, manifest.files.length + 1, 'Sync now fetches and checks every file');
  const failed = await syncLibrary({ fetchFn: async () => { throw new Error('offline'); }, auto: true });
  assert.equal(failed.ok, false);
  assert.equal(state.library.lastSync.auto, true);
});

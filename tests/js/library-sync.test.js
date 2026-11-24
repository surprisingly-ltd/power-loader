import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { manifest } from './helpers/library.js';
import { fetchLibrary, libraryUrl, pruneSets, syncLibrary, validateManifest } from '../../extension/lib/library-sync.js';
import { registerStorageWriter } from '../../extension/lib/storage.js';
import { contentHash } from '../../extension/lib/hash.js';
import { newPageDraft } from '../../extension/lib/drafts.js';

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
  // A draft exported with exactly the content the library now publishes is retired; another is kept.
  const published = JSON.parse(demo('profiles/pages/cm/client-record.json'));
  const same = { ...newPageDraft({ url: 'http://localhost:8787/demo/client-1042.html', title: 'Client' }), exported: { hash: await contentHash(published) } };
  same.profile.id = published.id;
  const other = newPageDraft({ url: 'http://localhost:8787/demo/client-1042.html', title: 'Client' });
  other.profile.id = 'harbour-homes/rent-account';
  other.base = { id: 'harbour-homes/rent-account', version: 'v0', commit: 'old1234' };
  state.profileDrafts = [same, other];
  const ok = await syncLibrary({ fetchFn: server() });
  assert.equal(ok.ok, true);
  assert.equal(state.library.current, manifest.commit);
  assert.equal(state.library.previous, 'old1234');
  assert.deepEqual(ok.drafts.retired, ['Client']);
  assert.equal(state.profileDrafts.length, 1);
  assert.equal(state.profileDrafts[0].conflict.version, 'v1');
});

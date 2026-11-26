// tools/policy.mjs: check, explain and try a policy file, with the extension's own reader and rule engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkPolicy, explainPolicy, hostPatternError, nearest, patternCovered, runExpectations, tryAddress, trySetting, urlCovered } from '../../tools/policy.mjs';

const BUILD = { id: 'powerloader@example.gov.uk', updateUrl: 'https://addons.example.gov.uk/powerloader/updates.json' };
const file = (policy = {}, build = {}, extra = {}) => ({ schema: 'powerloader-policy/1', name: 'Example Council', build: { ...BUILD, ...build }, policy, ...extra });
const errorsOf = (doc) => checkPolicy(doc).errors;

test('the default file and a minimal organisation file pass', () => {
  assert.deepEqual(checkPolicy({ schema: 'powerloader-policy/1', name: null, policy: {} }), { errors: [], warnings: [] });
  assert.deepEqual(errorsOf(file()), []);
});

test('the schema, the build identity and unknown keys, with the nearest key suggested', () => {
  assert.match(errorsOf({ ...file(), schema: 'x' })[0], /schema must be/);
  assert.ok(errorsOf(file({}, { id: 'powerloader@surprisingly.ltd' })).some((e) => /build\.id is Surprisingly’s/.test(e)));
  assert.ok(errorsOf(file({}, { updateUrl: 'https://powerloader.surprisingly.ltd/updates.json' })).some((e) => /updateUrl is Surprisingly’s/.test(e)));
  assert.ok(errorsOf(file({}, { id: undefined })).some((e) => /build\.id must be/.test(e)));
  assert.ok(errorsOf(file({ gateway: { baseURL: 'https://ai.example.gov.uk/v1' } })).some((e) => /gateway\.baseURL isn’t known\. Did you mean gateway\.baseUrl\?/.test(e)));
  assert.ok(errorsOf(file({ allowed: { 'library.baseurl': ['https://x.example.gov.uk/*'] } })).some((e) => /Did you mean library\.baseUrl/.test(e)));
  assert.ok(errorsOf({ ...file(), profile: {} }).some((e) => /top-level key profile/.test(e)));
  assert.ok(errorsOf(file({ library: { syncMinutes: 'hourly' } })).some((e) => /syncMinutes must be a number/.test(e)));
  assert.equal(nearest('zzzzzz', ['library']), null);
});

test('no secrets: a token, a key or a password in an address is refused', () => {
  assert.ok(errorsOf(file({ library: { token: 'glpat-123' } })).some((e) => /library\.token looks like a secret/.test(e)));
  assert.ok(errorsOf(file({ library: { auth: 'token' } })).some((e) => /needs a token/.test(e)));
  assert.ok(errorsOf(file({ library: { baseUrl: 'https://me:pw@git.example.gov.uk/lib/' } })).some((e) => /password in it/.test(e)));
});

test('patterns and rules are read by the extension’s own parser', () => {
  assert.ok(errorsOf(file({ siteAccess: { deny: ['https://*bad'] } })).some((e) => /can’t be read|\* can only start a host/.test(e)));
  assert.ok(errorsOf(file({ siteAccess: { rules: [{ id: 'x', effect: 'maybe', pattern: 'https://a.example/*' }] } })).some((e) => /effect/.test(e)));
  assert.ok(errorsOf(file({ allowed: { 'gateway.baseUrl': ['ai.example.gov.uk'] } })).some((e) => /allowed\.gateway\.baseUrl/.test(e)));
  assert.ok(errorsOf(file({ allowed: { 'gateway.model': [] } })).some((e) => /list of model names/.test(e)));
  assert.ok(errorsOf({ schema: 'powerloader-policy/1', name: null, policy: { allowed: { 'gateway.model': ['fast'] } } }).some((e) => /build\.id must be/.test(e)), 'a file that sets anything is an organisation build');
});

test('a fixed value its own allowed refuses, and build.hosts that don’t cover what the policy needs', () => {
  assert.ok(errorsOf(file({ gateway: { baseUrl: 'https://ai.elsewhere.example/v1' }, allowed: { 'gateway.baseUrl': ['https://ai.example.gov.uk/*'] } })).some((e) => /fixed to a value its own allowed patterns refuse/.test(e)));
  const hosts = ['https://*.example.gov.uk/*'];
  assert.ok(errorsOf(file({ library: { baseUrl: 'https://git.elsewhere.example/lib/-/raw/{ref}/' } }, { hosts })).some((e) => /library\.baseUrl is outside build\.hosts/.test(e)));
  assert.ok(errorsOf(file({ allowed: { 'library.baseUrl': ['https://*/*'] } }, { hosts })).some((e) => /reaches outside build\.hosts/.test(e)));
  assert.ok(errorsOf(file({}, { hosts: ['example.gov.uk'] })).some((e) => /match pattern/.test(e)));
  assert.equal(hostPatternError('*://*.example.gov.uk/*'), null);
  assert.ok(patternCovered('https://a.example.gov.uk/x/*', hosts));
  assert.ok(!patternCovered('https://example.com/*', hosts));
  assert.ok(urlCovered('https://ai.example.gov.uk/v1/chat/completions', hosts));
});

test('warnings: the default model source outside build.hosts, and hosts wider than the site rules', () => {
  const { warnings } = checkPolicy(file({ siteAccess: { allow: ['https://records.example.gov.uk/*'] } }, { hosts: ['https://*.gov.uk/*'] }));
  assert.ok(warnings.some((w) => /privacy model downloads from huggingface\.co/.test(w)));
  assert.ok(warnings.some((w) => /profile assistant/.test(w)));
  assert.ok(warnings.some((w) => /https:\/\/\*\.gov\.uk\/\* is wider than what the site rules/.test(w)));
  const mirror = checkPolicy(file({ privacyModel: { filesUrl: 'https://models.example.gov.uk/pf/' }, assistModel: { enabled: false } }, { hosts: ['https://*.example.gov.uk/*'] }));
  assert.deepEqual(mirror, { errors: [], warnings: [] });
});

test('explain says what the build may connect to, and what it works on', () => {
  const text = explainPolicy(file({ gateway: { enabled: false }, siteAccess: { rules: [{ id: 'no-post', effect: 'deny', pattern: '*://*', actions: ['fetch-post'] }] } }, { hosts: ['https://*.example.gov.uk/*'] }));
  assert.match(text, /rules built in by Example Council/);
  assert.match(text, /May connect to \(enforced by Firefox\):\n {2}- example\.gov\.uk and its subdomains/);
  assert.match(text, /Works on \(the site rules/);
  assert.match(text, /Background POST requests \(fetch steps\): never\./);
  assert.match(text, /off, and locked off/);
  assert.match(text, /policies\.json \(managed storage\) is ignored/);
  assert.match(text, /What the build doesn’t promise/);
  assert.match(explainPolicy({ schema: 'powerloader-policy/1', name: null, policy: {} }), /This is the default file/);
});

test('try: which rule decided, and settings against fixed values, patterns and hosts', () => {
  const doc = file({ siteAccess: { rules: [{ id: 'no-post', effect: 'deny', pattern: '*://*', actions: ['fetch-post'] }] }, allowed: { 'gateway.model': ['gpt-*'] } }, { hosts: ['https://*.example.gov.uk/*'] });
  const [post] = tryAddress(doc, 'https://a.example.gov.uk/', ['fetch-post']);
  assert.deepEqual([post.ok, post.by], [false, 'rule no-post']);
  const [outside] = tryAddress(doc, 'https://a.elsewhere.example/', ['read']);
  assert.deepEqual([outside.ok, outside.rules, outside.hosts], [false, true, false]);
  assert.equal(trySetting(doc, 'gateway.model', 'gpt-5').ok, true);
  assert.equal(trySetting(doc, 'gateway.model', 'fast').ok, false);
  assert.match(trySetting(doc, 'library.baseUrl', 'https://git.elsewhere.example/lib/').why, /outside build\.hosts/);
  const misses = runExpectations(doc, [{ url: 'https://a.example.gov.uk/', action: 'read', allowed: false }, { setting: 'gateway.model', value: 'gpt-5', allowed: true }]);
  assert.equal(misses.length, 1);
});

test('the command line exits 1 on a problem', () => {
  const tool = fileURLToPath(new URL('../../tools/policy.mjs', import.meta.url));
  const out = execFileSync(process.execPath, [tool, 'check', fileURLToPath(new URL('../../extension/policy.json', import.meta.url))], { encoding: 'utf8' });
  assert.match(out, /no problems/);
  assert.throws(() => execFileSync(process.execPath, [tool, 'check', fileURLToPath(new URL('../../package.json', import.meta.url))], { encoding: 'utf8' }), (e) => e.status === 1);
});

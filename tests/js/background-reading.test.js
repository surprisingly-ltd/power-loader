// "Read pages in the background": one switch for fetching and clipping pages the caseworker isn't on, set by
// policy, the library's access.json or the caseworker, and enforced as a deny of the fetch actions in the rule
// engine (lib/access.js), so there is one enforcement path. docs/plans/fetch-steps.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../extension/lib/extract.js';
import {
  BACKGROUND_READING_DEFAULT, BACKGROUND_RULE, accessLayers, allowed, backgroundOffText, backgroundReading, isBackgroundRule, originVerdict, restricts,
  setBackgroundReading, settingsRows, validateAccess,
} from '../../extension/lib/access.js';
import { indexLibrary } from '../../extension/lib/library.js';
import { POLICY_DEFAULTS } from '../../extension/lib/policy.js';
import { demoSet } from './helpers/library.js';

const URL1 = 'https://cm.example.gov.uk/clients/1042';
const policy = (siteAccess) => ({ values: { siteAccess: { ...POLICY_DEFAULTS.siteAccess, ...siteAccess } }, locked: new Set() });
const libWith = (access, commit = 'c1') => {
  const set = demoSet();
  set.commit = commit;
  set.files['access.json'] = { schema: 'powerloader-access/1', ...access };
  return indexLibrary(set);
};

test('the default is one constant, and with nothing set background reading follows it', () => {
  assert.equal(typeof BACKGROUND_READING_DEFAULT, 'boolean');
  assert.deepEqual(backgroundReading({}), { on: BACKGROUND_READING_DEFAULT, by: 'default', locked: false });
  assert.equal(POLICY_DEFAULTS.siteAccess.backgroundReading, null, 'policy leaves it unset by default');
  assert.equal(allowed(accessLayers({}), URL1, 'fetch-get').ok, BACKGROUND_READING_DEFAULT);
});

test('off is a deny of fetch-get and fetch-post through the rule engine, and touches nothing else', () => {
  const layers = accessLayers({ settings: { siteAccess: { backgroundReading: false } } });
  for (const a of ['fetch-get', 'fetch-post']) {
    const v = allowed(layers, URL1, a);
    assert.equal(v.ok, false, a);
    assert.deepEqual(v.rule, { layer: 'mine', id: BACKGROUND_RULE });
    assert.ok(isBackgroundRule(v.rule));
  }
  for (const a of ['read', 'fill', 'navigate', 'annotate', 'capture']) assert.equal(allowed(layers, URL1, a).ok, true, a);
  assert.equal(restricts(layers), false, 'the switch isn’t a site rule: Select a region still asks for every site');
  assert.equal(originVerdict(layers, 'https://cm.example.gov.uk/*'), 'open', 'nor does it make every site partly blocked');
  assert.deepEqual(settingsRows({ settings: { siteAccess: { backgroundReading: false } } }), [], 'and it isn’t listed as a rule');
  // On, the caseworker's own choice: fetch-get is allowed like any other action.
  assert.equal(allowed(accessLayers({ settings: { siteAccess: { backgroundReading: true } } }), URL1, 'fetch-get').ok, true);
});

test('policy sets and locks it above the library and the caseworker', () => {
  const lib = libWith({ backgroundReading: { on: true, lock: true } });
  const bg = backgroundReading({ policy: policy({ backgroundReading: false }), settings: { siteAccess: { backgroundReading: true } }, currentLib: lib });
  assert.deepEqual(bg, { on: false, by: 'policy', locked: true });
  const v = allowed(accessLayers({ policy: policy({ backgroundReading: false }), settings: { siteAccess: { backgroundReading: true } }, currentLib: lib }), URL1, 'fetch-get');
  assert.deepEqual(v.rule, { layer: 'policy', id: BACKGROUND_RULE });
  assert.match(backgroundOffText(bg), /Your organisation has turned off reading pages in the background.*open each page and clip it yourself/);
  assert.deepEqual(backgroundReading({ policy: policy({ backgroundReading: true }), settings: { siteAccess: { backgroundReading: false } } }), { on: true, by: 'policy', locked: true });
});

test('the library sets it in access.json, locked or left to the caseworker', () => {
  const locked = libWith({ backgroundReading: { on: false, lock: true } });
  assert.deepEqual(locked.access.background, { on: false, lock: true });
  assert.deepEqual(backgroundReading({ currentLib: locked, settings: { siteAccess: { backgroundReading: true } } }), { on: false, by: 'library', locked: true });
  assert.deepEqual(allowed(accessLayers({ currentLib: locked, settings: { siteAccess: { backgroundReading: true } } }), URL1, 'fetch-get').rule, { layer: 'library', id: BACKGROUND_RULE });
  const open = libWith({ backgroundReading: { on: false } });
  assert.deepEqual(backgroundReading({ currentLib: open }), { on: false, by: 'library', locked: false }, 'the library’s choice, as a starting point');
  assert.match(backgroundOffText(backgroundReading({ currentLib: open })), /off for your library.*turn it on in Settings/);
  assert.deepEqual(backgroundReading({ currentLib: open, settings: { siteAccess: { backgroundReading: true } } }), { on: true, by: 'mine', locked: false }, 'the caseworker can turn it back on');
  // lockLibraryRules locks the library's choice too.
  assert.deepEqual(backgroundReading({ policy: policy({ lockLibraryRules: true }), currentLib: open, settings: { siteAccess: { backgroundReading: true } } }), { on: false, by: 'library', locked: true });
  // The pinned library and the synced one: a locked off in either wins.
  const on = libWith({ backgroundReading: { on: true, lock: true } }, 'c2');
  assert.equal(backgroundReading({ caseLib: locked, currentLib: on }).on, false);
  // An access.json with no choice leaves it to the caseworker and the default.
  assert.equal(libWith({ rules: [] }).access.background, null);
});

test('access.json’s backgroundReading is validated, and a bad one keeps the last good library', () => {
  assert.deepEqual(validateAccess({ schema: 'powerloader-access/1', backgroundReading: { on: false, lock: true } }), []);
  assert.deepEqual(validateAccess({ schema: 'powerloader-access/1', backgroundReading: 'off' }), ['"backgroundReading" must be { on: true or false, lock? }']);
  assert.deepEqual(validateAccess({ schema: 'powerloader-access/1', backgroundReading: { on: false, lock: 'yes' } }), ['"backgroundReading.lock" must be true or false']);
  const bad = libWith({ backgroundReading: { on: 'no' } });
  assert.equal(bad.access, null);
  assert.ok(bad.problems.some((p) => p.path === 'access.json'));
});

test('the caseworker’s choice is kept with their rules, and their rules with it', () => {
  const rule = { id: 'mine-1', effect: 'deny', pattern: 'https://finance.example.gov.uk*' };
  const sa = setBackgroundReading({ siteAccess: { rules: [rule], library: {} } }, false);
  assert.deepEqual(sa, { rules: [rule], library: {}, backgroundReading: false });
  assert.match(backgroundOffText(backgroundReading({ settings: { siteAccess: sa } })), /You’ve turned off reading pages in the background in Settings/);
  assert.equal(backgroundOffText(backgroundReading({ settings: { siteAccess: { backgroundReading: true } } })), null, 'on: nothing to explain');
});

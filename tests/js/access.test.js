// Site rules (lib/access.js): patterns read as URLs, layered decisions, the library's access.json, the
// caseworker's own rules, and where flows, libraries, links and notes meet them. docs/plans/site-access-lists.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../extension/lib/extract.js';
import {
  accessLayers, addMine, allowed, changeDelegated, delegatedView, describePattern, globVerdict, keepMineRule, literalOrigin, originVerdict, parsePattern,
  patternError, patternHints, policyLayer, removeMine, restricts, ruleHash, setDelegatedOff, settingsRows, tryAddress, useLibraryRule, validateAccess,
} from '../../extension/lib/access.js';
import { accessIssues, blockedForms, indexLibrary } from '../../extension/lib/library.js';
import { pageInfo } from '../../extension/lib/visits.js';
import { fillTemplate, templateErrors, emailFor } from '../../extension/lib/journey.js';
import { fillNote, parseMarkup, annotationErrors } from '../../extension/lib/annotations.js';
import { logBlocked, NOT_KEPT } from '../../extension/lib/activity.js';
import { addField, addLink, bindPage, exportFlow, mapPick, flowSet, importFlow, newFlow, pagesOf, startable, validateFlow } from '../../extension/lib/flows.js';
import { demoSet } from './helpers/library.js';

const E = globalThis.PowerLoaderExtract;
globalThis.browser = { runtime: { getURL: (p) => p } };

const ALLOW = 'https://*.casework.example*';
const DENY = 'https://finance.casework.example*';
const example = [{ id: 'org', effect: 'allow', pattern: ALLOW }, { id: 'fin', effect: 'deny', pattern: DENY }];

test('the worked example: allow *.casework.example, deny finance, row by row (and what matchUrl would say)', () => {
  const allowOnly = [example[0]];
  const denyOnly = [{ ...example[1], effect: 'deny' }];
  // [address, allow matches, deny matches, Power Loader works, matchUrl on the allow pattern]
  const rows = [
    ['https://cm.casework.example/cases/1042', true, false, true, true],
    ['https://casework.example/', true, false, true, false],
    ['https://finance.casework.example/ledger', true, true, false, true],
    ['https://FINANCE.Casework.EXAMPLE/ledger', true, true, false, true],
    ['https://finance.casework.example./ledger', true, true, false, true],
    ['https://finance.casework.example:8443/x', true, true, false, true],
    ['https://a.finance.casework.example/', true, false, true, true],
    ['http://cm.casework.example/', false, false, false, false],
    ['http://finance.casework.example/', false, true, false, false],
    ['https://cm.casework.example.evil.example/', false, false, false, true],
    ['https://evil.example/?next=.casework.example', false, false, false, true],
    ['https://cm.casework.example@evil.example/', false, false, false, true],
    ['https://notcasework.example/', false, false, false, false],
    ['https://bücher.casework.example/', true, false, true, true],
    ['https://cm.casework.example/cases/1042#finance', true, false, true, true],
  ];
  for (const [url, allowHit, denyHit, works, glob] of rows) {
    assert.equal(allowed(allowOnly, url, 'read').ok, allowHit, `allow: ${url}`);
    assert.equal(!allowed(denyOnly, url, 'read').ok, denyHit, `deny: ${url}`);
    assert.equal(allowed(example, url, 'read').ok, works, `works: ${url}`);
    // matchUrl as Firefox hands it the address (lowercased host, punycode, no trailing dot change).
    assert.equal(E.matchUrl(ALLOW, new URL(url).href), glob, `matchUrl: ${url}`);
  }
});

test('patterns are read strictly, in their parts: every edge case', () => {
  const p = (s) => parsePattern(s);
  assert.deepEqual(p('https://x.example/a').schemes, ['https']);
  assert.deepEqual(p('http://x.example/a').schemes, ['http']);
  assert.deepEqual(p('*://x.example/a').schemes, ['http', 'https']);
  assert.match(patternError('ftp://x.example/'), /Start the address/);
  assert.match(patternError('x.example'), /Start the address/);
  // *. is the domain and its subdomains, with a label boundary.
  assert.equal(allowed([{ id: 'a', effect: 'allow', pattern: 'https://*.casework.example*' }], 'https://notcasework.example/', 'read').ok, false);
  // * elsewhere in the host is refused.
  assert.match(patternError('https://cm.*.gov.uk/'), /\* can only start a host/);
  assert.match(patternError('https://*cm.gov.uk/'), /\* can only start a host/);
  assert.match(patternError('https://'), /site name/);
  // Ports: none is any, a number is that one only, default ports as new URL() has them.
  assert.equal(p('https://x.example*').port, null);
  const port = [{ id: 'p', effect: 'allow', pattern: 'https://x.example:8443/*' }];
  assert.equal(allowed(port, 'https://x.example:8443/a', 'read').ok, true);
  assert.equal(allowed(port, 'https://x.example/a', 'read').ok, false);
  assert.equal(allowed([{ id: 'd', effect: 'allow', pattern: 'https://x.example:443/*' }], 'https://x.example/a', 'read').ok, true);
  assert.match(patternError('https://x.example:99999/'), /port/);
  // Paths: exact without *, normalised as URLs are, case-sensitive; queries are part of the path.
  const exact = [{ id: 'e', effect: 'allow', pattern: 'https://x.example/a/../case' }];
  assert.equal(p('https://x.example/a/../case').path, '/case');
  assert.equal(allowed(exact, 'https://x.example/case', 'read').ok, true);
  assert.equal(allowed(exact, 'https://x.example/case/1', 'read').ok, false);
  assert.equal(allowed(exact, 'https://x.example/Case', 'read').ok, false);
  assert.deepEqual(patternHints('https://x.example/case', 'allow'), ['Only this exact address: add * for the pages under it.']);
  assert.equal(p('https://x.example/a b').path, '/a%20b');
  const q = [{ id: 'q', effect: 'allow', pattern: 'https://cm.x.example/case?id=*' }];
  assert.equal(allowed(q, 'https://cm.x.example/case?id=42', 'read').ok, true);
  assert.equal(allowed(q, 'https://cm.x.example/case', 'read').ok, false);
  // Fragments go from both sides; case is lowered in scheme and host.
  assert.equal(p('HTTPS://X.Example/a#frag').path, '/a');
  assert.equal(p('HTTPS://X.Example/a').host, 'x.example');
  // IDN in punycode, trailing dot dropped, user info is not the host, IPs as new URL() writes them.
  assert.equal(p('https://bücher.example/*').host, 'xn--bcher-kva.example');
  assert.match(describePattern('https://bücher.example*'), /bücher\.example/);
  assert.equal(p('https://finance.casework.example./').host, 'finance.casework.example');
  assert.ok(patternError('https://cm.casework.example@evil.example/'));
  assert.equal(p('http://0x7f.1/').host, '127.0.0.1');
  assert.equal(allowed([{ id: 'ip', effect: 'deny', pattern: 'http://127.0.0.1*' }], 'http://0x7f.1/x', 'read').ok, false);
  assert.match(patternError('https://*.127.0.0.1/'), /IP address/);
  // A bare host is that host only, and the editor says so for a deny.
  assert.match(patternHints('https://finance.casework.example*', 'deny')[0], /\*\.finance\.casework\.example/);
  // Other schemes are never matched.
  for (const u of ['file:///etc/passwd', 'about:blank', 'moz-extension://x/y', 'data:text/html,x', 'mailto:a@b.example']) {
    assert.equal(allowed([{ id: 'any', effect: 'deny', pattern: '*://*' }], u, 'read').ok, true, u);
  }
  assert.match(describePattern('https://*.casework.example*'), /casework\.example and its subdomains, any page/);
});

test('layers: deny wins anywhere, allow lists intersect, an empty list allows, fetch-post is closed', () => {
  const L = (layer, rules, extra = {}) => ({ layer, rules, ...extra });
  const a = (pattern, actions) => ({ id: pattern, effect: 'allow', pattern, ...(actions ? { actions } : {}) });
  const d = (pattern, actions) => ({ id: pattern, effect: 'deny', pattern, ...(actions ? { actions } : {}) });
  const cm = 'https://cm.x.example/cases/1';
  // Nothing set: everything open except fetch-post.
  assert.equal(allowed([L('policy', []), L('mine', [])], cm, 'fill').ok, true);
  assert.equal(allowed([L('policy', []), L('mine', [])], cm, 'fetch-post').ok, false);
  // A deny in the lowest layer still wins over an allow above it.
  const v = allowed([L('policy', [a('https://*.x.example*')]), L('mine', [d('https://cm.x.example*')])], cm, 'read');
  assert.deepEqual(v, { ok: false, rule: { layer: 'mine', id: 'https://cm.x.example*' } });
  // Allow lists intersect: a lower layer can narrow, never widen.
  const layers = [L('library', [a('https://*.x.example*')]), L('mine', [a('https://other.example*')])];
  assert.equal(allowed(layers, cm, 'read').ok, false);
  assert.equal(allowed(layers, 'https://other.example/', 'read').ok, false);
  // An action-specific deny leaves the rest open.
  const pay = [L('library', [d('https://cm.x.example/payments/*', ['fill'])])];
  assert.equal(allowed(pay, 'https://cm.x.example/payments/1', 'fill').ok, false);
  assert.equal(allowed(pay, 'https://cm.x.example/payments/1', 'read').ok, true);
  // fetch-post: an allow without actions never opens it; one that names it does, where nothing denies it.
  assert.equal(allowed([L('mine', [a('https://*.x.example*')])], cm, 'fetch-post').ok, false);
  assert.equal(allowed([L('mine', [a('https://cm.x.example/*', ['fetch-post'])])], cm, 'fetch-post').ok, true);
  assert.equal(allowed([L('mine', [a('https://cm.x.example/*', ['fetch-post'])]), L('library', [d('https://cm.x.example/cases/*', ['fetch-post'])])], cm, 'fetch-post').ok, false);
  // A deny without actions covers fetch-post too.
  assert.equal(allowed([L('mine', [a('https://cm.x.example/*', ['fetch-post']), d('https://cm.x.example*')])], cm, 'fetch-post').ok, false);
  // The approved-hosts layer narrows but never opens fetch-post, and keeps hostApproved()'s reading.
  const hosts = accessLayers({ hosts: ['*.x.example', 'localhost:8787'] });
  assert.equal(allowed(hosts, cm, 'read').ok, true);
  assert.equal(allowed(hosts, 'https://x.example/', 'read').ok, false, '*.x.example is subdomains only, as today');
  assert.equal(allowed(hosts, 'http://localhost:8787/demo/', 'fill').ok, true);
  assert.equal(allowed(hosts, 'http://localhost:9999/demo/', 'fill').ok, false);
  assert.equal(allowed(hosts, 'https://elsewhere.example/', 'navigate').ok, true, 'navigate isn’t limited to approved hosts');
  assert.equal(allowed(hosts, 'https://elsewhere.example/', 'capture').ok, true, 'capture isn’t either');
  assert.equal(allowed(hosts, cm, 'fetch-post').ok, false);
  assert.equal(allowed(accessLayers({ hosts: [] }), cm, 'read').ok, false, 'no approved hosts approves nothing');
  assert.equal(restricts(accessLayers({ hosts: ['a.example'] })), false);
  assert.equal(restricts(accessLayers({ settings: { siteAccess: { rules: [d('https://a.example*')] } } })), true);
});

test('policy: allow and deny lists and full rules; a deny that doesn’t read fails closed, an allow narrows', () => {
  const policy = (sa) => ({ values: { siteAccess: { allow: null, deny: null, rules: null, lockLibraryRules: false, ...sa } } });
  const ok = accessLayers({ policy: policy({ allow: ['https://*.x.example*'], deny: ['https://fin.x.example*'] }) });
  assert.equal(allowed(ok, 'https://cm.x.example/', 'fill').ok, true);
  assert.deepEqual(allowed(ok, 'https://fin.x.example/', 'fill').rule, { layer: 'policy', id: 'policy-deny-1' });
  assert.equal(allowed(ok, 'https://other.example/', 'fill').ok, false);
  // A deny that doesn't parse: Power Loader works nowhere, and the layer says what it couldn't read.
  const broken = accessLayers({ policy: policy({ deny: ['https://cm.*.x.example/'] }) });
  assert.equal(broken[0].broken, 'https://cm.*.x.example/');
  for (const a of ['read', 'fill', 'capture', 'annotate', 'navigate']) assert.equal(allowed(broken, 'https://anything.example/', a).ok, false, a);
  assert.equal(originVerdict(broken, 'https://anything.example/*'), 'blocked');
  assert.ok(policyLayer({ rules: [{ effect: 'deny', pattern: 'nonsense' }] }).broken !== undefined);
  // An allow that doesn't parse matches nothing: it narrows, so nothing is allowed rather than everything.
  const badAllow = accessLayers({ policy: policy({ allow: ['https://*cm.x.example/'] }) });
  assert.equal(badAllow[0].broken, undefined);
  assert.equal(allowed(badAllow, 'https://cm.x.example/', 'read').ok, false);
  const ruleAllow = accessLayers({ policy: policy({ rules: [{ effect: 'allow', pattern: 'bad', actions: ['fill'] }] }) });
  assert.equal(allowed(ruleAllow, 'https://cm.x.example/', 'fill').ok, false);
  assert.equal(allowed(ruleAllow, 'https://cm.x.example/', 'read').ok, true);
});

test('origins: a whole-origin deny is blocked (no permission asked), a path deny is partial', () => {
  assert.equal(originVerdict(example, 'https://finance.casework.example/*'), 'blocked');
  assert.equal(originVerdict(example, 'https://evil.example/*'), 'blocked', 'outside the allow list entirely');
  assert.equal(originVerdict(example, 'https://cm.casework.example/*'), 'open');
  const path = [{ id: 'p', effect: 'deny', pattern: 'https://cm.casework.example/payments/*' }];
  assert.equal(originVerdict(path, 'https://cm.casework.example/*'), 'partial');
  // Firefox permissions have no port: a deny on one port doesn't cover the origin.
  assert.equal(originVerdict([{ id: 'p', effect: 'deny', pattern: 'http://localhost:8787*' }], 'http://localhost/*'), 'partial');
  assert.equal(originVerdict([{ id: 'p', effect: 'deny', pattern: 'http://localhost*' }], 'http://localhost/*'), 'blocked');
  // A deny for fill only leaves reading: not blocked.
  assert.equal(originVerdict([{ id: 'f', effect: 'deny', pattern: 'https://a.example*', actions: ['fill'] }], 'https://a.example/*'), 'partial');
});

const accessDoc = {
  schema: 'powerloader-access/1',
  allow: { lock: true, rules: [{ id: 'org', pattern: 'https://*.casework.example*' }] },
  deny: { lock: false, rules: [{ id: 'fin', pattern: 'https://finance.casework.example*' }, { id: 'pay', pattern: 'https://cm.casework.example/payments/*', actions: ['fill'], lock: true }] },
  rules: [{ id: 'dec', effect: 'deny', pattern: 'https://cm.casework.example/decide/*', actions: ['fetch-post'], lock: true }],
};
const withAccess = (doc, commit = 'abc1234') => {
  const set = demoSet();
  set.commit = commit;
  set.files['access.json'] = structuredClone(doc);
  return indexLibrary(set);
};

test('access.json: validated, refused as a whole when bad, split into locked and delegated rules', () => {
  assert.deepEqual(validateAccess(accessDoc), []);
  const lib = withAccess(accessDoc);
  assert.deepEqual(lib.problems, []);
  assert.deepEqual(lib.access.locked.map((r) => r.id), ['org', 'pay', 'dec']);
  assert.deepEqual(lib.access.delegated.map((r) => r.id), ['fin']);
  assert.equal(lib.access.locked[0].effect, 'allow', 'a list gives its rules their effect');
  const errors = (doc) => validateAccess(doc).join(' | ');
  assert.match(errors({ ...accessDoc, schema: 'x' }), /schema/);
  assert.match(errors({ schema: accessDoc.schema, rules: [{ id: 'a', effect: 'deny', pattern: 'https://*x.example/' }] }), /can only start a host/);
  assert.match(errors({ schema: accessDoc.schema, rules: [{ id: 'a', effect: 'deny', pattern: 'https://x.example/', actions: ['delete'] }] }), /isn’t an action/);
  assert.match(errors({ schema: accessDoc.schema, rules: [{ id: 'a', effect: 'deny', pattern: 'https://x.example/' }, { id: 'a', effect: 'deny', pattern: 'https://y.example/' }] }), /used twice/);
  assert.match(errors({ schema: accessDoc.schema, rules: [{ effect: 'deny', pattern: 'https://x.example/' }] }), /needs an "id"/);
  assert.match(errors({ schema: accessDoc.schema, rules: Array.from({ length: 501 }, (_, i) => ({ id: `r${i}`, effect: 'deny', pattern: 'https://x.example/' })) }), /more than 500/);
  // A bad access.json is a library problem, so a sync refuses the whole commit.
  const bad = withAccess({ ...accessDoc, rules: [{ id: 'x', effect: 'deny', pattern: 'nope' }] });
  assert.equal(bad.problems[0].path, 'access.json');
  assert.equal(bad.access, null);
});

test('layering: policy, then the library locked (pinned and current), then the caseworker with delegated rules', () => {
  const lib = withAccess(accessDoc);
  const settings = { siteAccess: { rules: [{ id: 'mine-1', effect: 'deny', pattern: 'https://hr.casework.example*' }] } };
  const layers = accessLayers({ policy: null, settings, currentLib: lib });
  assert.deepEqual(layers.map((l) => l.layer), ['policy', 'library', 'mine']);
  assert.equal(allowed(layers, 'https://cm.casework.example/', 'read').ok, true);
  assert.deepEqual(allowed(layers, 'https://finance.casework.example/', 'read').rule, { layer: 'mine', id: 'fin' }, 'delegated rules are the caseworker’s layer');
  assert.deepEqual(allowed(layers, 'https://hr.casework.example/', 'read').rule, { layer: 'mine', id: 'mine-1' });
  assert.deepEqual(allowed(layers, 'https://cm.casework.example/payments/2', 'fill').rule, { layer: 'library', id: 'pay' });
  assert.equal(allowed(layers, 'https://elsewhere.example/', 'read').rule.layer, 'library', 'the locked allow list');
  // The caseworker's own allow can narrow a locked allow list, never widen it.
  const widen = accessLayers({ settings: { siteAccess: { rules: [{ id: 'w', effect: 'allow', pattern: 'https://elsewhere.example*' }] } }, currentLib: lib });
  assert.equal(allowed(widen, 'https://elsewhere.example/', 'read').ok, false);
  assert.equal(allowed(widen, 'https://cm.casework.example/', 'read').ok, false, 'and narrows it to their own list');
  // Turning off a delegated rule opens finance; a locked rule can't be turned off.
  const off = accessLayers({ settings: { siteAccess: { library: { fin: { off: true }, pay: { off: true } } } }, currentLib: lib });
  assert.equal(allowed(off, 'https://finance.casework.example/', 'read').ok, true);
  assert.equal(allowed(off, 'https://cm.casework.example/payments/2', 'fill').ok, false);
  // Policy's lockLibraryRules makes every library rule locked, whatever the caseworker set.
  const lockAll = accessLayers({ policy: { values: { siteAccess: { lockLibraryRules: true } } }, settings: { siteAccess: { library: { fin: { off: true } } } }, currentLib: lib });
  assert.deepEqual(allowed(lockAll, 'https://finance.casework.example/', 'read').rule, { layer: 'library', id: 'fin' });
  // An open case: the pinned commit and the synced one are both layers, so a deny published mid-case applies.
  const later = withAccess({ ...accessDoc, rules: [...accessDoc.rules, { id: 'new', effect: 'deny', pattern: 'https://new.casework.example*', lock: true }] }, 'def5678');
  const open = accessLayers({ caseLib: lib, currentLib: later });
  assert.equal(open.filter((l) => l.layer === 'library').length, 2);
  assert.equal(allowed(open, 'https://new.casework.example/', 'read').ok, false);
  // Policy sits above the library: the library can't widen what policy allows.
  const pol = accessLayers({ policy: { values: { siteAccess: { allow: ['https://cm.casework.example*'] } } }, currentLib: lib });
  assert.equal(allowed(pol, 'https://hr.casework.example/', 'read').rule.layer, 'policy');
  // No library: policy and the caseworker's own rules only.
  assert.deepEqual(accessLayers({ settings }).map((l) => l.layer), ['policy', 'mine']);
});

test('the caseworker’s changes to delegated rules: turned off, changed, removed by the library, changed by it since', () => {
  const lib = withAccess(accessDoc);
  const fin = lib.access.delegated[0];
  let settings = {};
  settings = { siteAccess: setDelegatedOff(settings, 'fin', true) };
  assert.equal(delegatedView(lib.access.delegated, settings.siteAccess.library)[0].state, 'off');
  settings = { siteAccess: setDelegatedOff(settings, 'fin', false) };
  assert.deepEqual(settings.siteAccess.library, {});
  // Changed: the caseworker's version applies, and remembers the library's rule it came from.
  settings = { siteAccess: changeDelegated(settings, fin, 'https://*.finance.casework.example*') };
  let view = delegatedView(lib.access.delegated, settings.siteAccess.library)[0];
  assert.equal(view.state, 'changed');
  assert.equal(allowed(accessLayers({ settings, currentLib: lib }), 'https://a.finance.casework.example/', 'read').ok, false);
  assert.equal(settings.siteAccess.library.fin.base, ruleHash(fin));
  // The library changes it after: The library changed this rule, until the caseworker chooses.
  const changed = withAccess({ ...accessDoc, deny: { ...accessDoc.deny, rules: [{ id: 'fin', pattern: 'https://finance.casework.example/*' }, accessDoc.deny.rules[1]] } });
  view = delegatedView(changed.access.delegated, settings.siteAccess.library)[0];
  assert.equal(view.state, 'conflict');
  assert.equal(view.rule.pattern, 'https://*.finance.casework.example*', 'theirs applies meanwhile');
  const kept = { siteAccess: keepMineRule(settings, changed.access.delegated[0]) };
  assert.equal(delegatedView(changed.access.delegated, kept.siteAccess.library)[0].state, 'changed');
  const back = { siteAccess: useLibraryRule(settings, 'fin') };
  assert.equal(delegatedView(changed.access.delegated, back.siteAccess.library)[0].state, 'library');
  // Removed by the library: gone, even though it was edited.
  const removed = withAccess({ ...accessDoc, deny: { lock: false, rules: [accessDoc.deny.rules[1]] } });
  assert.deepEqual(delegatedView(removed.access.delegated, settings.siteAccess.library), []);
  assert.equal(allowed(accessLayers({ settings, currentLib: removed }), 'https://a.finance.casework.example/', 'read').ok, true);
  // Their own rules: added (refused when the address doesn't read), and removed.
  assert.throws(() => addMine({}, { effect: 'deny', pattern: 'https://cm.*.example/' }), /can only start a host/);
  const mine = { siteAccess: addMine({}, { effect: 'deny', pattern: 'https://hr.casework.example*' }) };
  assert.equal(mine.siteAccess.rules.length, 1);
  assert.deepEqual(removeMine(mine, mine.siteAccess.rules[0].id).rules, []);
  // The Settings card's rows: library-locked rules apart from the caseworker's own.
  const rows = settingsRows({ settings: mine, currentLib: lib, policy: { values: { siteAccess: { deny: ['https://x.example*'] } } } });
  assert.deepEqual(rows.map((r) => `${r.source}:${r.rule.id}`), ['policy:policy-deny-1', 'library:org', 'library:pay', 'library:dec', 'delegated:fin', `mine:${mine.siteAccess.rules[0].id}`]);
  assert.match(tryAddress(accessLayers({ settings: mine, currentLib: lib }), 'https://hr.casework.example/x').text, /doesn’t work here: blocked by your rule https:\/\/hr\.casework\.example\*/);
  assert.equal(tryAddress(accessLayers({ settings: mine, currentLib: lib }), 'https://cm.casework.example/x').text, 'Power Loader works here');
});

test('links and notes: no {name} in the scheme or host; the email step is a mailto: link of single addresses', () => {
  assert.equal(literalOrigin('https://cm.example/case/{ref}'), true);
  assert.equal(literalOrigin('https://{host}/case'), false);
  assert.equal(literalOrigin('https://cm.{x}.example/'), false);
  assert.equal(literalOrigin('{url}'), false);
  assert.match(templateErrors('https://{x}.example/case', {}).join(' '), /site written out/);
  assert.match(templateErrors('https://{ref}/case', {}).join(' '), /site written out/);
  assert.match(templateErrors('https://cm.example{ref}', {}).join(' '), /site written out/);
  assert.deepEqual(templateErrors('https://cm.example/case/{ref}?q={ref}', {}), []);
  assert.equal(fillTemplate('https://{ref}/x', { ref: 'evil.example' }).url, null, 'filled, it still gives no address');
  assert.equal(fillTemplate('https://cm.example/{ref}', { ref: 'a/b' }).url, 'https://cm.example/a%2Fb');
  // Notes: a link's site is written out; its path can hold values.
  const bad = parseMarkup('<a href="https://{host}/x">x</a>');
  assert.equal(bad.nodes[0].href, undefined);
  assert.match(bad.errors.join(' '), /site written out/);
  assert.match(annotationErrors([{ id: 'n', selector: 'h1', type: 'expanded', html: '<a href="https://{ref}.example/">x</a>' }], {}).join(' '), /site written out/);
  assert.equal(fillNote([{ tag: 'a', href: 'https://{host}/x', children: ['x'] }], { host: 'evil.example' })[0].href, undefined, 'a tree made elsewhere is checked too');
  assert.equal(fillNote(parseMarkup('<a href="https://cm.example/case/{ref}">x</a>').nodes, { ref: '1/2' })[0].href, 'https://cm.example/case/1%2F2');
  assert.equal(fillNote(parseMarkup('<a href="mailto:{ref}">x</a>').nodes, { ref: 'a@b.example' })[0].href, 'mailto:a%40b.example');
  // The email step: a value in To must be one address, so it can't add a recipient or a header.
  const e = emailFor({ to: '{landlord}', subject: 'x' }, { landlord: 'a@b.example?bcc=c@d.example' });
  assert.equal(e.mailto, null);
  assert.deepEqual(e.bad, ['a@b.example?bcc=c@d.example']);
});

function boundFlow() {
  const flow = newFlow({ name: 'Rules' });
  const out = pagesOf(flow, 'output')[0];
  const inp = pagesOf(flow, 'input')[0];
  bindPage(flow, out.id, { url: 'https://finance.casework.example/apply', title: 'Apply' });
  bindPage(flow, inp.id, { url: 'https://cm.casework.example/cases/1042', title: 'Case' });
  addLink(inp, { label: 'Ledger', url: 'https://finance.casework.example/ledger/{ref}' });
  return { flow, out, inp };
}

test('validateFlow reports pages, matches and links the rules block; startable refuses when every form is blocked', () => {
  const { flow, out } = boundFlow();
  const layers = accessLayers({ settings: { siteAccess: { rules: example.map((r) => ({ ...r, id: `mine-${r.id}` })) } } });
  const issues = validateFlow(flow, { access: layers }).filter((i) => i.code === 'blocked');
  assert.deepEqual(issues.map((i) => i.text), [
    `Power Loader can’t work on ${out.name}: the site rules block https://finance.casework.example/apply`,
    'Case: Power Loader can’t open the link “Ledger”: the site rules block https://finance.casework.example/ledger/{ref}',
  ]);
  assert.ok(issues.every((i) => i.level === 'error'));
  assert.deepEqual(validateFlow(flow).filter((i) => i.code === 'blocked'), [], 'without rules, no such issue');
  // A guide page and a profile match are judged by their fixed start.
  const g = newFlow({ name: 'G' });
  g.pages.push({ id: 'p-g', role: 'guide', name: 'Ledger', url: 'https://finance.casework.example/', match: 'https://finance.casework.example/*', required: [] });
  assert.ok(validateFlow(g, { access: layers }).some((i) => i.code === 'blocked' && i.pageId === 'p-g'));
  out.draft.profile.match = 'https://*.casework.example/*';
  out.url = '';
  const some = validateFlow(flow, { access: layers }).find((i) => i.pageId === out.id && i.code.startsWith('blocked'));
  assert.equal(some.code, 'blocked-some');
  // startable: a case can't start when the rules block every form the flow fills.
  const s = newFlow({ name: 'Start' });
  const form = pagesOf(s, 'output')[0];
  bindPage(s, form.id, { url: 'https://finance.casework.example/apply', title: 'Apply' });
  mapPick(form, addField(s, { label: 'Landlord' }), '#x');
  assert.equal(startable(s).ok, true);
  assert.deepEqual([startable(s, { access: layers }).ok, startable(s, { access: layers }).reason], [false, 'The site rules block every form this flow fills, so Power Loader can’t fill any of them']);
  assert.equal(globVerdict(layers, 'https://finance.casework.example/apply*', 'fill').verdict, 'blocked');
  assert.equal(globVerdict(layers, 'https://cm.casework.example/*', 'read').verdict, 'ok');
});

test('a flow file carries no rules: a planted access key is dropped; flowSet copies the library’s access.json', () => {
  const { flow } = boundFlow();
  const file = exportFlow(flow);
  assert.equal('access' in file, false);
  const planted = { ...JSON.parse(JSON.stringify(file)), access: accessDoc, files: { ...file.files, 'access.json': accessDoc } };
  planted.pages = planted.pages.map((p) => ({ ...p, access: accessDoc }));
  const back = importFlow(planted);
  assert.equal(JSON.stringify(back).includes('powerloader-access'), false);
  // With no library connected, the flow's set has no rules of its own.
  assert.equal(flowSet(back, { hash: 'abc' }).files['access.json'], undefined);
  // With one, its access.json comes along, so a case pins it.
  const lib = withAccess(accessDoc);
  const set = flowSet(back, { hash: 'abc', base: lib });
  assert.deepEqual(set.files['access.json'], accessDoc);
  assert.deepEqual(indexLibrary(set).access.locked.map((r) => r.id), ['org', 'pay', 'dec']);
});

test('the library page lists profiles and forms the rules block, and visits to blocked pages aren’t logged', () => {
  const lib = indexLibrary(demoSet());
  const layers = accessLayers({ settings: { siteAccess: { rules: [{ id: 'mine-d', effect: 'deny', pattern: 'http://localhost*' }] } } });
  const issues = accessIssues(lib, layers);
  assert.ok(issues.length > 0);
  assert.ok(issues.every((i) => i.level === 'error' && /the site rules block/.test(i.text)));
  assert.ok(issues.some((i) => i.kind === 'page') && issues.some((i) => i.kind === 'fill'));
  assert.ok(Object.keys(blockedForms(lib, layers)).length > 0);
  assert.deepEqual(accessIssues(lib, accessLayers({})), []);
  const page = 'http://localhost:8787/demo/client-1042.html';
  assert.ok(pageInfo(lib, page));
  assert.equal(pageInfo(lib, page, layers), null);
});

test('a blocked attempt is logged with the action and the layer, never the address or the pattern', () => {
  const c = { id: 'c1', log: [] };
  const e = logBlocked(c, { action: 'fill', layer: 'library' });
  assert.equal(e.activity, 'blocked_action');
  assert.equal(e.page_type, 'blocked');
  assert.equal(e.url_pattern, NOT_KEPT);
  assert.equal(e.detail, 'fill · library rule');
  assert.equal('url' in e, false);
});

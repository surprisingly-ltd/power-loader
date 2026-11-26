// lib/json-dom.js: the strict parser, the synthetic document, its limits, prefixes and encodings, the selectors
// and paths the tree view writes, quotes, and what the leak check is given. docs/plans/json-clips.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import '../../extension/lib/extract.js';
import '../../extension/lib/json-dom.js';

const J = globalThis.PowerLoaderJson;
const E = globalThis.PowerLoaderExtract;
const documentSource = new JSDOM('').window.document;
const parse = (text, limits) => J.jsonToDocument(text, { documentSource, limits }).doc;
const stats = (text, limits) => J.jsonToDocument(text, { documentSource, limits }).stats;
const refused = (fn, reason) => assert.throws(fn, (e) => e.name === 'JsonRefused' && e.reason === reason, reason);
const read = (doc, sel) => E.extract(doc, { fields: { v: sel } }).data.v;

test('the document is XML with no browsing context, one typed element per value, keys and indexes as attributes', () => {
  const doc = parse('{"a":[1,"x",true,null,{}],"b":{}}');
  assert.equal(doc.defaultView, null, 'nothing in it can run or load');
  assert.equal(doc.documentElement.localName, 'j-object');
  assert.deepEqual([...doc.querySelectorAll("[key='a'] > *")].map((el) => [el.localName, el.getAttribute('index')]),
    [['j-number', '0'], ['j-string', '1'], ['j-boolean', '2'], ['j-null', '3'], ['j-object', '4']]);
  assert.equal(doc.querySelector("[key='b']").localName, 'j-object');
  assert.equal(stats('{"a":[1,"x",true,null,{}],"b":{}}').values, 8);
});

test('the parser is strict: anything that isn’t RFC 8259 JSON is refused, never guessed', () => {
  for (const bad of ['', ' ', '{', '[1,]', '{"a":1,}', '{a:1}', "{'a':1}", '[NaN]', '[Infinity]', '[01]', '[1.]', '[.5]', '[+1]', '[-]', '// c\n{}', '{} /* c */',
    '{"a" 1}', '[1 2]', '{}{}', '"\u0001"', '"\\x41"', '"\\u12G4"', 'tru', 'nul', '[true false]', 'undefined', 'callback({"a":1})', '"abc']) {
    refused(() => parse(bad), 'syntax');
  }
});

test('numbers keep their text: big integers and decimals exactly, exponents written out by string arithmetic', () => {
  const doc = parse('[12345678901234567890, 1234.50, 1.5e3, 1E+2, 2.5e-3, -1.25e1, 0.5e1, 0e10, -0, 1e-7]');
  assert.deepEqual([...doc.documentElement.children].map((el) => el.textContent),
    ['12345678901234567890', '1234.50', '1500', '100', '0.0025', '-12.5', '5', '0', '-0', '0.0000001']);
  assert.equal(doc.documentElement.children[2].getAttribute('source'), '1.5e3', 'the number as sent, for its quote');
  assert.equal(doc.documentElement.children[0].hasAttribute('source'), false);
  assert.equal(J.plainNumber('1e400', 100), null, 'too long written out');
});

test('null, booleans, empty strings and containers read as they would in HTML', () => {
  const doc = parse('{"t":true,"f":false,"n":null,"e":"","o":{},"a":[]}');
  assert.equal(read(doc, ":root > [key='t'] | bool"), true);
  assert.equal(read(doc, ":root > [key='f'] | bool"), false);
  assert.equal(read(doc, ":root > [key='n']"), null);
  assert.equal(read(doc, ":root > [key='e']"), null);
  assert.equal(E.probe(doc, ":root > [key='n']").count, 1, 'null is there, with no value');
});

test('duplicate keys are both kept, in order, and their paths reported (never their values)', () => {
  const { doc, stats: s } = J.jsonToDocument('{"a":{"x":1,"x":2},"b":[{"id":"S","id":"T"}]}', { documentSource });
  assert.equal(doc.querySelectorAll("[key='x']").length, 2);
  assert.deepEqual(s.duplicates, ['.a.x', '.b[0].id']);
  assert.equal(E.probe(doc, ":root > [key='a'] > [key='x']").count, 2, 'a test of it fails: it matches 2');
});

test('nested arrays and a root array', () => {
  const doc = parse('[[1,[2,[3]]],[]]');
  assert.equal(read(doc, ":root > [index='0'] > [index='1'] > [index='1'] > [index='0']"), '3');
  assert.equal(doc.querySelectorAll(':root > *').length, 2);
});

test('prototype-pollution keys are only attribute strings: nothing is built from the response', () => {
  const before = Object.getOwnPropertyNames(Object.prototype).sort();
  const hostile = '{"__proto__":{"polluted":"yes","toString":"x"},"constructor":{"prototype":{"polluted":"yes"}},"prototype":1,"hasOwnProperty":"h","__defineGetter__":"g"}';
  const doc = parse(hostile);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), before);
  assert.equal(typeof {}.toString, 'function');
  assert.equal(read(doc, ":root > [key='__proto__'] > [key='polluted']"), 'yes');
  assert.equal(read(doc, ":root > [key='constructor'] > [key='prototype'] > [key='polluted']"), 'yes');
  assert.equal(read(doc, ":root > [key='hasOwnProperty']"), 'h');
  // A repeated __proto__ is a duplicate like any key.
  assert.deepEqual(stats('{"__proto__":1,"__proto__":2}').duplicates, ['.__proto__']);
  assert.deepEqual(J.jsonQuotes(doc, { fields: { p: ":root > [key='__proto__'] > [key='polluted']" } }), { p: '.__proto__.polluted: "yes"' });
  assert.equal({}.polluted, undefined);
});

test('markup in a string is only ever text', () => {
  const doc = parse('{"x":"<img src=x onerror=\\"globalThis.hit=1\\"><script>globalThis.hit=1</script>"}');
  assert.equal(doc.querySelector('img, script'), null);
  assert.equal(globalThis.hit, undefined);
  assert.match(read(doc, ":root > [key='x']"), /^<img src=x/);
});

test('every limit, just under and just over: refused, never cut short', () => {
  const nest = (k) => `${'['.repeat(k)}${']'.repeat(k)}`;
  assert.ok(parse(nest(64)));
  refused(() => parse(nest(65)), 'depth');
  refused(() => parse(nest(100000)), 'depth'); // iterative: no stack overflow
  const L = { values: 10, members: 4, string: 10, key: 5, number: 6 };
  assert.ok(parse(`[${Array(9).fill(0)}]`, L));
  refused(() => parse(`[${Array(10).fill(0)}]`, L), 'values');
  assert.ok(parse('{"a":1,"b":2,"c":3,"d":4}', L));
  refused(() => parse('{"a":1,"b":2,"c":3,"d":4,"e":5}', L), 'members');
  assert.ok(parse('"0123456789"', L));
  refused(() => parse('"0123456789x"', L), 'string');
  assert.ok(parse('"\\u0041\\u0041\\u0041\\u0041\\u0041\\u0041\\u0041\\u0041\\u0041\\u0041"', L), 'counted after escapes');
  assert.ok(parse('{"abcde":1}', L));
  refused(() => parse('{"abcdef":1}', L), 'key');
  assert.ok(parse('123456', L));
  refused(() => parse('1234567', L), 'number');
  refused(() => parse('1e9', L), 'number'); // 1000000000 written out is too long
  // The defaults are the plan's.
  assert.deepEqual({ ...J.LIMITS }, { bytes: 2 * 1024 * 1024, depth: 64, values: 50000, string: 100000, key: 1000, number: 100, members: 10000 });
  refused(() => parse(`[${Array(50000).fill(0)}]`), 'values');
  refused(() => J.readJson(new Uint8Array(2 * 1024 * 1024 + 1), { documentSource }), 'bytes');
  assert.match(J.refusalText('values', { name: 'Payment history' }), /^Payment history is too large to read \(over 50,000 values\)\. Ask for less/);
});

test('one known XSSI prefix is removed after a BOM and whitespace; nothing else is unwrapped', () => {
  for (const p of [")]}'\n", ")]}',\n", ")]}'\r\n", 'while(1);', 'for(;;);', '{}&&']) {
    assert.equal(read(parse(`﻿  ${p}{"a":"ok"}`), ":root > [key='a']"), 'ok', JSON.stringify(p));
  }
  refused(() => parse(")]}'\n)]}'\n{}"), 'syntax');
  refused(() => parse(")]}' {}"), 'syntax');
  refused(() => parse('cb({"a":1});'), 'syntax');
  refused(() => parse('/**/cb({"a":1})'), 'syntax');
});

test('encodings: UTF-8 by default, a named charset, a BOM overrides, and bytes that don’t decode are refused', () => {
  const utf8 = new TextEncoder().encode('{"n":"Zoë"}');
  const doc = (bytes, type = 'application/json') => J.readJson(bytes, { contentType: type, documentSource }).doc;
  assert.equal(read(doc(utf8), ":root > [key='n']"), 'Zoë');
  assert.equal(read(doc(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8])), ":root > [key='n']"), 'Zoë');
  const latin1 = new Uint8Array([...new TextEncoder().encode('{"n":"Zo'), 0xeb, ...new TextEncoder().encode('"}')]);
  assert.equal(read(doc(latin1, 'application/json; charset=ISO-8859-1'), ":root > [key='n']"), 'Zoë');
  refused(() => doc(latin1), 'encoding');
  const utf16 = new Uint8Array([0xff, 0xfe, ...[...'{"n":"Zoë"}'].flatMap((ch) => [ch.charCodeAt(0) & 0xff, ch.charCodeAt(0) >> 8])]);
  assert.equal(read(doc(utf16, 'application/json; charset=utf-8'), ":root > [key='n']"), 'Zoë', 'the BOM wins');
  assert.equal(read(doc(utf8, 'application/json; charset=no-such'), ":root > [key='n']"), 'Zoë', 'an unknown charset is UTF-8');
});

test('Content-Type decides, never the body', () => {
  const t = J.jsonContentType;
  for (const ok of ['application/json', 'application/json; charset=utf-8', 'APPLICATION/JSON', 'text/json', 'application/hal+json', 'application/vnd.api+json', 'application/ld+json']) assert.equal(t(ok), 'json', ok);
  assert.equal(t('application/problem+json'), 'problem');
  for (const s of ['text/javascript', 'application/javascript']) assert.equal(t(s), 'script');
  for (const no of ['text/plain', 'text/html', 'application/octet-stream', '', undefined, 'application/jsonx', 'application/+json']) assert.equal(t(no), 'other', String(no));
});

test('keys as selectors: quoted, escaped, case-sensitive; one with NUL can’t be selected', () => {
  const keys = ['plain', 'first name', "it's", 'back\\slash', 'line\nbreak', 'tab\there', '', 'Name', 'name', 'é', '0', 'a.b', '"q"', ']', 'café'.normalize('NFD')];
  const text = `{${keys.map((k, i) => `${JSON.stringify(k)}:${i}`).join(',')},"nul\\u0000key":99}`;
  const doc = parse(text);
  keys.forEach((k, i) => {
    const sel = `:root > ${J.jsonKeySelector(k)}`;
    assert.equal(E.probe(doc, sel).count, 1, sel);
    assert.equal(read(doc, sel), String(i), sel);
  });
  assert.equal(J.jsonKeySelector('nul\u0000key'), null);
  assert.equal(J.selectorFor(doc.querySelectorAll(':root > *')[keys.length]), null, 'the tree view says it can’t read this key');
  assert.equal(J.lookAlikeKeys(doc.documentElement).size, 2, 'Name and name look the same');
});

test('the anchored selector and the jq path for an element, both ways', () => {
  const doc = parse('{"person":{"dateOfBirth":"1986-07-14","first name":"Jane"},"payments":[{"amount":1},{"amount":412.50}]}');
  const amount = doc.querySelectorAll("[key='amount']")[1];
  assert.equal(J.selectorFor(amount), ":root > [key='payments'] > [index='1'] > [key='amount']");
  assert.equal(J.selectorFor(amount, { from: amount.parentNode }), ":scope > [key='amount']");
  assert.equal(J.selectorFor(doc.documentElement), ':root');
  assert.equal(J.pathOf(amount), '.payments[1].amount');
  assert.equal(J.pathOf(doc.querySelector("[key='first name']")), '.person.["first name"]');
  assert.equal(J.pathOf(doc.documentElement), '.');
  assert.equal(J.selectorToPath(":root > [key='person'] > [key='dateOfBirth'] | date"), '.person.dateOfBirth');
  assert.equal(J.selectorToPath(":root > [key='first name'] > [index='0']"), '.["first name"][0]');
  assert.equal(J.selectorToPath(":root > [key='it\\'s']"), `.["it's"]`);
  assert.equal(J.selectorToPath('table.details label(Name)'), null, 'any other selector has no path');
});

test('quotes: the path and the value as sent, cut at 200 characters', () => {
  const doc = parse(`{"person":{"dateOfBirth":"1986-07-14"},"payments":[{"amount":1},{"amount":2},{"amount":412.50}],"first name":"Jane","big":1.5e3,"ok":true,"long":"${'x'.repeat(300)}","o":{}}`);
  const q = J.jsonQuotes(doc, { fields: {
    dob: ":root > [key='person'] > [key='dateOfBirth'] | date", amount: ":root > [key='payments'] > [index='2'] > [key='amount'] | number", first: ":root > [key='first name']",
    big: ":root > [key='big']", ok: ":root > [key='ok'] | bool", long: ":root > [key='long']", lit: '=x', obj: ":root > [key='o']", key: ":root > [key='ok'] @key", rows: [':root > *'],
  } });
  assert.deepEqual(q, {
    dob: '.person.dateOfBirth: "1986-07-14"', amount: '.payments[2].amount: 412.50', first: '.["first name"]: "Jane"', big: '.big: 1.5e3', ok: '.ok: true', long: `.long: "${'x'.repeat(199)}…`,
  });
});

test('probeJson: an object or array picked as a value fails before judgeTest', () => {
  const doc = parse('{"a":{"b":1},"c":[1]}');
  assert.equal(J.probeJson(doc, ":root > [key='a']").error, 'Pick a value inside it');
  assert.equal(J.probeJson(doc, ":root > [key='c']").error, 'Pick a value inside it');
  assert.deepEqual(J.probeJson(doc, ":root > [key='a'] > [key='b']"), { count: 1, value: '1' });
  assert.equal(J.probeJson(doc, ":root > [key='a'] @key").error, undefined);
});

test('data-like keys: identifier shapes, personal data, and objects used as maps; ordinary keys are structure', () => {
  const doc = parse('{"address2":"x","dateOfBirth":"y","P-1042":{"a":1},"payments":{"k1":{"amount":1,"date":"d"},"k2":{"amount":2,"date":"e"},"k3":{"amount":3,"date":"f"}},"jane@example.org":"z","person":{"name":"Jane","city":"Leeds","status":"Open"}}');
  const key = (k) => doc.querySelector(`[key='${k}']`);
  const isPersonal = (k) => /@/.test(k);
  assert.equal(J.dataLikeKey(key('address2')), false);
  assert.equal(J.dataLikeKey(key('dateOfBirth')), false);
  assert.equal(J.dataLikeKey(key('P-1042')), true);
  assert.equal(J.dataLikeKey(key('k1')), true, 'siblings of the same shape');
  assert.equal(J.dataLikeKey(key('jane@example.org'), { isPersonal }), true);
  assert.equal(J.dataLikeKey(key('name')), false, 'a record of strings isn’t a map');
  const values = J.jsonValues(doc, { isPersonal });
  for (const v of ['x', 'Jane', 'Leeds', 'P-1042', 'k2', 'jane@example.org', '3']) assert.ok(values.includes(v), v);
  for (const v of ['address2', 'dateOfBirth', 'person', 'true']) assert.ok(!values.includes(v), v);
});

test('humanise turns keys into words for guessing a field', () => {
  assert.equal(J.humanise('dateOfBirth'), 'date of birth');
  assert.equal(J.humanise('date_of_birth'), 'date of birth');
  assert.equal(J.humanise('NINumber'), 'ni number');
  assert.equal(J.humanise('last-name'), 'last name');
});

// tools/sequence-svg.mjs: the build-time sequence diagrams on /how-it-works.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeXml, sequenceSvg, wrap } from '../../tools/sequence-svg.mjs';
import { BUILD, RUN } from '../../site/how-it-works/diagrams.mjs';

const spec = () => ({
  id: 'seq-test', title: 'A <test> & "title"', desc: 'Two parts talk.',
  participants: [{ id: 'a', label: 'Alice' }, { id: 'b', label: 'Bob & co' }],
  groups: { g: { kind: 'opt', label: 'if <it> applies' } },
  messages: [
    { from: 'a', to: 'b', step: 1, text: 'Hello <script>alert(1)</script>' },
    { from: 'b', to: 'a', kind: 'return', text: 'Hi & bye' },
    { from: 'a', kind: 'note', group: 'g', text: 'Thinks "quietly"' },
    { from: 'b', to: 'b', group: 'g', text: 'Talks to itself' },
  ],
});

test('the SVG is deterministic', () => {
  assert.equal(sequenceSvg(spec()), sequenceSvg(spec()));
  assert.equal(sequenceSvg(BUILD), sequenceSvg(structuredClone(BUILD)));
});

test('it has an accessible title and description, and real text', () => {
  const svg = sequenceSvg(spec());
  assert.match(svg, /^<svg [^>]*role="img" aria-label="A &lt;test&gt; &amp; &quot;title&quot;" aria-describedby="seq-test-desc"/);
  assert.match(svg, /<title id="seq-test-title">A &lt;test&gt; &amp; &quot;title&quot;<\/title>/);
  assert.match(svg, /<desc id="seq-test-desc">Two parts talk\.<\/desc>/);
  assert.match(svg, /<text [^>]*>Alice<\/text>/);
});

test('labels are escaped, and nothing from a label becomes markup', () => {
  const svg = sequenceSvg(spec());
  assert.doesNotMatch(svg, /<script/);
  assert.match(svg, /&lt;script&gt;/);
  assert.match(svg, /Hi &amp; bye/);
  assert.match(svg, /&quot;quietly&quot;/);
  assert.match(svg, />if &lt;it&gt; applies</);
});

test('every message is drawn, calls and returns look different, and groups are boxed', () => {
  const svg = sequenceSvg(spec());
  for (let i = 1; i <= 4; i++) assert.match(svg, new RegExp(`class="msg [a-z]+" data-n="${i}"`));
  assert.match(svg, /class="msg return"[^]*stroke-dasharray="6 4"[^]*marker-end="url\(#seq-test-return\)"/);
  assert.match(svg, /marker-end="url\(#seq-test-call\)"/);
  assert.equal((svg.match(/class="group opt"/g) || []).length, 1);
  assert.match(svg, /<text class="kind"[^>]*>optional<\/text>/);
  assert.match(svg, /<tspan class="num"[^>]*>1\.<\/tspan>/);
});

test('the page’s diagrams draw every message and number every step', () => {
  for (const d of [BUILD, RUN]) {
    const svg = sequenceSvg(d);
    assert.equal((svg.match(/class="msg /g) || []).length, d.messages.length, d.id);
    for (const p of d.participants) assert.ok(svg.includes(`>${escapeXml(wrap(p.label, 106)[0])}<`), `${d.id}: ${p.label}`);
    assert.deepEqual(d.messages.filter((m) => m.step != null).map((m) => m.step), d.steps.map((_, i) => i + 1), d.id);
  }
});

test('phases are labelled bands, optional parts are dashed, and arrows across the boundary are marked', () => {
  const s = spec();
  s.participants.push({ id: 'c', label: 'Server', optional: true });
  s.boundary = { after: 'b', inside: 'Here', outside: 'There <out>' };
  s.messages[0].phase = 'Start & go';
  s.messages.push({ from: 'a', to: 'c', text: 'Out' }, { from: 'a', to: 'b', text: 'In' });
  const svg = sequenceSvg(s);
  assert.match(svg, /<text class="phase-name"[^>]*>Start &amp; go<\/text>/);
  assert.match(svg, /class="actor optional"><rect [^>]*stroke-dasharray/);
  assert.match(svg, /class="lifeline optional"[^>]*stroke-dasharray/);
  assert.match(svg, /<g class="boundary">[^]*>Here<[^]*>There &lt;out&gt;</);
  assert.equal((svg.match(/class="cross"/g) || []).length, 1);
  assert.match(svg, /class="msg call crosses" data-n="5"/);
  assert.throws(() => sequenceSvg({ ...s, boundary: { after: 'c' } }), /boundary/);
});

test('the page’s diagrams mark the trust boundary, and only real crossings', () => {
  const run = sequenceSvg(RUN);
  // What crosses to the organisation's servers while running a flow: a fetch, the caseworker's submit, and AI.
  assert.deepEqual([...run.matchAll(/class="msg [a-z]+ crosses" data-n="(\d+)"/g)].map((m) => RUN.messages[m[1] - 1].text), [
    'GET, same site, no redirects', 'A page or JSON', 'The form, sent by the caseworker',
    'The approved request, with the gateway key; no cookies', 'The answer',
  ]);
  for (const d of [BUILD, RUN]) assert.ok(d.messages.filter((m) => m.phase).length >= 4, d.id);
});

test('bad specs are refused', () => {
  assert.throws(() => sequenceSvg({ ...spec(), id: 'Bad id' }), /id/);
  assert.throws(() => sequenceSvg({ ...spec(), messages: [{ from: 'a', to: 'z', text: 'x' }] }), /no participant "z"/);
  assert.throws(() => sequenceSvg({ ...spec(), messages: [{ from: 'a', to: 'b', kind: 'shout', text: 'x' }] }), /unknown kind/);
  assert.throws(() => sequenceSvg({ ...spec(), title: '' }), /title/);
});

test('wrap keeps words whole and lines short', () => {
  const lines = wrap('one two three four five six seven eight nine ten', 60);
  assert.ok(lines.length > 1);
  assert.equal(lines.join(' '), 'one two three four five six seven eight nine ten');
  for (const l of lines) assert.ok(l.length <= 8 || !l.includes(' '));
});

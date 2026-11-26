// tools/diagram-svg.mjs: the build-time diagrams on /how-it-works and the home page, and the figures they sit in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caseSvg, decideSvg, flowsSvg, layersSvg, pairFigure, rangeSvg } from '../../tools/diagram-svg.mjs';
import { homeValues, howItWorksValues } from '../../tools/how-it-works.mjs';
import { CASE, DECIDE, FLOWS, LAYERS, RANGE } from '../../site/how-it-works/diagrams.mjs';
import { allowed } from '../../extension/lib/access.js';

const ALL = [[FLOWS, flowsSvg], [LAYERS, layersSvg], [DECIDE, decideSvg], [RANGE, rangeSvg], [CASE, caseSvg]];
const layouts = [{ narrow: false }, { narrow: true }];

test('every diagram is deterministic, in both layouts', () => {
  for (const [spec, draw] of ALL) {
    for (const o of layouts) assert.equal(draw(spec, o), draw(structuredClone(spec), o), `${spec.id} ${JSON.stringify(o)}`);
    assert.notEqual(draw(spec, layouts[0]), draw(spec, layouts[1]), spec.id);
  }
});

test('every diagram is an accessible image of native shapes and text, sized by its viewBox', () => {
  for (const [spec, draw] of ALL) {
    for (const o of layouts) {
      const svg = draw(spec, o);
      const [, w, h] = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
      assert.match(svg, new RegExp(`^<svg class="dg [^"]*" xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"`));
      assert.match(svg, /role="img" aria-label="[^"]{20,}"/, spec.id);
      assert.match(svg, /<title>[^<]{20,}<\/title>/, spec.id);
      assert.ok(Number(w) <= (o.narrow ? 360 : 1030), `${spec.id}: ${w} wide`);
      assert.doesNotMatch(svg, /<(script|style|foreignObject|image)\b|href=|on[a-z]+=/i, spec.id);
    }
  }
});

test('labels are escaped, and nothing from a label becomes markup', () => {
  const evil = '<script>alert(1)</script> & "q"';
  const svg = flowsSvg({ ...FLOWS, claim: `${evil} claim`, boundary: evil, rows: FLOWS.rows.map((r, i) => (i ? r : { ...r, what: evil, to: { title: evil, sub: evil } })) });
  assert.doesNotMatch(svg, /<script/);
  assert.match(svg, /&lt;script&gt;/);
  assert.match(svg, /&amp; &quot;q&quot;/);
  for (const [spec, draw] of ALL) {
    const bad = JSON.parse(JSON.stringify(spec).replace(/"(claim|title|sub|name|left|right|what|who|refused|top|bottom|always|clip|fill|zone)":"/g, '"$1":"<b>&'));
    const out = draw(bad);
    assert.doesNotMatch(out, /<b>/, spec.id);
    assert.match(out, /&lt;b&gt;&amp;/, spec.id);
  }
});

test('the boundary diagram has one crossing per destination, and Surprisingly Ltd only through Firefox’s updater', () => {
  for (const o of layouts) {
    const svg = flowsSvg(FLOWS, o);
    assert.equal((svg.match(/class="cross"/g) || []).length, FLOWS.rows.filter((r) => r.to).length);
    assert.match(svg, /stroke-dasharray="9 5"/);
  }
  const site = FLOWS.rows.filter((r) => /website/i.test(r.to?.title || ''));
  assert.deepEqual(site.map((r) => r.from), ['firefox']);
  assert.ok(FLOWS.rows.some((r) => r.from === 'storage' && r.none && !r.to));
});

test('each refusal in the decision diagram is where lib/access.js allowed() stops', () => {
  const [broken, deny, list, closed] = DECIDE.checks;
  const v = (c) => allowed(c.example.layers, c.example.url, c.example.action);
  assert.equal(v(broken).ok, false);
  assert.equal(v(broken).broken, true);
  assert.equal(v(deny).ok, false);
  assert.equal(v(deny).rule.id, 'finance');
  assert.equal(v(list).ok, false);
  assert.equal(v(list).rule.id, null);
  assert.equal(v(closed).ok, false);
  assert.equal(v(closed).rule, null);
  const ok = DECIDE.allowedExample;
  assert.equal(allowed(ok.layers, ok.url, ok.action).ok, true);
  // The same address and action as the fetch-post refusal, once an allow rule names fetch-post.
  const named = [...closed.example.layers, { id: 'post', effect: 'allow', pattern: 'https://cases.council.example/*', actions: ['fetch-post'] }];
  assert.equal(allowed(named, closed.example.url, 'fetch-post').ok, true);
  for (const o of layouts) assert.equal((decideSvg(DECIDE, o).match(/class="node refused"/g) || []).length, DECIDE.checks.length);
});

test('the layers diagram draws a deny from every layer that can hold one, and none from the approved systems', () => {
  for (const o of layouts) {
    const svg = layersSvg(LAYERS, o);
    assert.equal((svg.match(/class="deny-label"/g) || []).length, LAYERS.layers.filter((l) => l.deny).length);
  }
  assert.equal(LAYERS.layers.at(-1).deny, false);
});

test('every figure has a caption stating its claim, and ids and marker ids are unique on each page', () => {
  const pages = { 'how-it-works': Object.values(howItWorksValues()).join('\n'), home: Object.values(homeValues()).join('\n') };
  for (const [name, html] of Object.entries(pages)) {
    const figures = html.match(/<figure[^]*?<\/figure>/g) || [];
    assert.ok(figures.length >= (name === 'home' ? 1 : 6), name);
    for (const f of figures) {
      const caption = /<figcaption id="([^"]+)">([^]*?)<\/figcaption>/.exec(f);
      assert.ok(caption, `${name}: a figure without a caption`);
      assert.match(f, new RegExp(`^<figure [^>]*aria-labelledby="${caption[1]}"`));
      for (const svg of f.match(/<svg [^>]*>/g)) assert.match(svg, /role="img" aria-label="[^"]+"/, name);
      const label = /aria-label="([^"]+)"/.exec(f.match(/<svg [^>]*>/g).at(-1))[1];
      if (f.includes('class="diagram dg-pair"')) assert.ok(caption[2].startsWith(`<b>${label}.</b>`), `${name}: the caption states the claim`);
    }
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, `${name}: duplicate ids ${ids.filter((x, i) => ids.indexOf(x) !== i)}`);
    for (const m of html.matchAll(/url\(#([^)]+)\)/g)) assert.ok(ids.includes(m[1]), `${name}: no marker #${m[1]}`);
  }
});

test('a figure needs a claim and a caption, and a diagram an id', () => {
  assert.throws(() => pairFigure({ ...CASE, claim: '' }, caseSvg), /claim/);
  assert.throws(() => caseSvg({ ...CASE, id: 'Bad id' }), /id/);
  assert.throws(() => flowsSvg({ ...FLOWS, rows: [{ from: 'nowhere', what: 'x' }] }), /nowhere/);
});

// lib/gather.js, the in-page part of showing what a clip gathers, in jsdom: it outlines what a template reads,
// answers with the fields it found and nothing else, refuses a page that has moved on, and leaves the page
// as it was. jsdom has no layout, matchMedia or Element.animate: it works as with less motion asked for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { agentOn, agentOnDom } from './helpers/agent.js';
import { demoLibrary } from './helpers/library.js';

const lib = demoLibrary();
const caseProfile = lib.profiles.find((p) => p.id === 'cm/case');
const url = 'http://localhost:8787/demo/cm/case-1001.html';

test('the fields found on a case page are the ones its template reads, and only keys and numbers come back', async () => {
  const a = agentOn('cm/case-1001.html');
  const before = a.doc.documentElement.outerHTML;
  const res = await a.ask({ type: 'powerloader:showValues', fields: caseProfile.fields, state: 'pending', atUrl: url });
  assert.deepEqual(Object.keys(res).sort(), ['found', 'shownIn']);
  assert.equal(typeof res.shownIn, 'number');
  assert.ok(res.found.every((k) => typeof k === 'string' && Object.hasOwn(caseProfile.fields, k)), 'keys of the template only');
  assert.deepEqual([...res.found].sort(), Object.keys(caseProfile.fields).filter((k) => a.w.PowerLoaderExtract.locate(a.doc, a.w.PowerLoaderExtract.locatorOf(caseProfile.fields[k])).length).sort());
  assert.ok(res.found.includes('clientId') && res.found.includes('lastName'));
  assert.doesNotMatch(JSON.stringify(res), /NC-|@|\d{4}-\d{2}/, 'no value from the page');
  // One host, aria-hidden, that the page can't click through to.
  const host = a.doc.querySelector('[data-powerloader="values"]');
  assert.equal(host.getAttribute('aria-hidden'), 'true');
  assert.equal(host.style.getPropertyValue('pointer-events'), 'none');
  // Pointing and gathering answer with keys and numbers, too.
  assert.equal(await a.ask({ type: 'powerloader:pointValue', key: 'lastName', atUrl: url }), true);
  const g = await a.ask({ type: 'powerloader:gatherValues', fields: caseProfile.fields, sidebar: null, targets: {}, atUrl: url });
  assert.equal(g.toLeft, true, 'without the window’s place on the screen, towards Firefox’s default side');
  assert.ok(g.items.every((i) => Object.keys(i).every((k) => ['key', 'at', 'y'].includes(k)) && typeof i.at === 'number'));
  assert.equal(host.getAttribute('data-state'), 'done');
  // Cleared: the document is as it was.
  assert.equal(await a.ask({ type: 'powerloader:clearValues' }), true);
  assert.equal(a.doc.documentElement.outerHTML, before);
});

test('a field the page doesn’t have is reported missing; a value typed into the template has no outline', async () => {
  const a = agentOn('cm/case-1001.html');
  const fields = { ...caseProfile.fields, tenancyEndDate: '#nowhere label(Tenancy ends)', fixed: '=Typed in' };
  const res = await a.ask({ type: 'powerloader:showValues', fields, state: 'pending', atUrl: url });
  assert.ok(!res.found.includes('tenancyEndDate'));
  assert.ok(!res.found.includes('fixed'));
});

test('a page that has moved on since the sidebar checked the rules isn’t drawn on', async () => {
  const a = agentOn('cm/case-1001.html');
  await assert.rejects(a.ask({ type: 'powerloader:showValues', fields: caseProfile.fields, state: 'pending', atUrl: 'http://localhost:8787/demo/cm/case-1002.html' }), /page changed/);
  assert.equal(a.doc.querySelector('[data-powerloader="values"]'), null);
});

// The layer's shadow root is closed on a real page; here it is opened so the test can see what is drawn.
const openShadows = (a) => {
  const attach = a.w.Element.prototype.attachShadow;
  a.w.Element.prototype.attachShadow = function (o) { return attach.call(this, { ...o, mode: 'open' }); };
};
const boxesOf = (a) => [...(a.doc.querySelector('[data-powerloader="values"]')?.shadowRoot?.firstElementChild?.children || [])];

test('a value in conflict is outlined in orange with ⚠ and the word; decided, it goes back to green', async () => {
  const a = agentOn('cm/case-1001.html');
  openShadows(a);
  const fields = { lastName: caseProfile.fields.lastName, clientId: caseProfile.fields.clientId };
  await a.ask({ type: 'powerloader:showValues', fields, state: 'done', flags: { lastName: 'conflict' }, atUrl: url });
  const [last, id] = boxesOf(a);
  assert.equal(last.style.getPropertyValue('border-color'), 'rgb(213, 90, 0)');
  assert.equal(last.firstChild.textContent, '⚠ Conflict');
  assert.equal(id.style.getPropertyValue('border-color'), 'rgb(0, 112, 60)');
  assert.equal(id.firstChild.textContent, '✓');
  // Decided: the sidebar sends no flag, and the outline is green with its tick.
  await a.ask({ type: 'powerloader:showValues', fields, state: 'done', flags: {}, atUrl: url });
  assert.equal(boxesOf(a)[0].style.getPropertyValue('border-color'), 'rgb(0, 112, 60)');
});

test('a conflict’s link holds its value in orange until the outlines are cleared, and says when it isn’t there', async () => {
  const a = agentOn('cm/case-1001.html');
  openShadows(a);
  const before = a.doc.documentElement.outerHTML;
  await a.ask({ type: 'powerloader:showValues', fields: caseProfile.fields, state: 'done', atUrl: url });
  assert.deepEqual(await a.ask({ type: 'powerloader:pointValue', key: 'lastName', scroll: true, hold: true, atUrl: url }), { found: true });
  // Pointing at other rows, and away, leaves it held.
  await a.ask({ type: 'powerloader:pointValue', key: 'clientId', atUrl: url });
  await a.ask({ type: 'powerloader:pointValue', key: null, atUrl: url });
  const held = boxesOf(a).find((b) => b.firstChild.textContent === '⚠ Conflict');
  assert.ok(held, 'still held');
  assert.equal(held.style.getPropertyValue('border-width'), '3px');
  assert.deepEqual(await a.ask({ type: 'powerloader:pointValue', key: 'tenancyEndDate', hold: true, atUrl: url }), { found: false });
  await a.ask({ type: 'powerloader:clearValues' });
  assert.equal(a.doc.documentElement.outerHTML, before);
});

const revealPage = `<!doctype html><html><head><style>.acc:not(.acc--open) .acc__body { display: none }</style></head><body>
<details id="more"><summary>More about the tenancy</summary><p>Starts <b id="start">2021-04-01</b></p></details>
<div class="acc" id="history"><h3>Tenancy history</h3><div class="acc__body"><span id="arrears">£310.00</span></div></div>
<h3>Notes</h3><div class="acc" id="notes"><div class="acc__body"><span id="note">Call back</span></div></div>
<div hidden id="extra"><span id="phone">07700 900123</span></div>
</body></html>`;
const revealUrl = 'http://localhost:8787/demo/reveal.html';
// The page as markup, each element's attributes in name order: putting back a removed attribute adds it last.
const canonical = (doc) => [...doc.querySelectorAll('*')].map((el) => `${el.localName}[${[...el.attributes].map((x) => `${x.name}=${x.value}`).sort().join(' ')}]${el.open ? ' open' : ''}`).join('\n') + doc.body.textContent;
const revealAgent = () => agentOnDom(new JSDOM(revealPage, { url: revealUrl, runScripts: 'outside-only' }));

test('reveal rules bring a value out of sight into view by class names, <details> and hidden, and are undone', async () => {
  const a = revealAgent();
  const before = canonical(a.doc);
  const fields = { start: '#start', arrears: '#arrears', phone: '#phone', note: '#note' };
  const res = await a.ask({ type: 'powerloader:showValues', fields, state: 'pending', reveal: [{ selector: '#history', addClass: ['acc--open'] }], atUrl: revealUrl });
  // Plain HTML is opened with no rule: a closed <details>, a hidden attribute.
  assert.equal(a.doc.getElementById('more').open, true);
  assert.equal(a.doc.getElementById('extra').hasAttribute('hidden'), false);
  // The rule's class is added to the element it names that holds the value, and nowhere else.
  assert.ok(a.doc.getElementById('history').classList.contains('acc--open'));
  assert.ok(!a.doc.getElementById('notes').classList.contains('acc--open'));
  // A value no rule opens is named by the part it is in, from its heading, never its value.
  assert.deepEqual(res.closed, { note: 'Notes' });
  assert.doesNotMatch(JSON.stringify(res), /Call back|310|0770/);
  // Cleared: everything is put back as it was found.
  await a.ask({ type: 'powerloader:clearValues' });
  assert.equal(canonical(a.doc), before);
});

test('pointing at a row reveals its value then, and a change the page made since is left alone', async () => {
  const a = revealAgent();
  await a.ask({ type: 'powerloader:showValues', fields: { arrears: '#arrears' }, state: 'pending', atUrl: revealUrl });
  assert.ok(!a.doc.getElementById('history').classList.contains('acc--open'), 'no rule, nothing opened');
  // A rule arriving with the next outline, and pointing at the row: open.
  await a.ask({ type: 'powerloader:showValues', fields: { arrears: '#arrears' }, state: 'done', reveal: [{ selector: '.acc', addClass: ['acc--open'] }], atUrl: revealUrl });
  assert.equal(await a.ask({ type: 'powerloader:pointValue', key: 'arrears', scroll: true, atUrl: revealUrl }), true);
  const history = a.doc.getElementById('history');
  assert.ok(history.classList.contains('acc--open'));
  // The caseworker closes it themselves: clearing doesn't open or close anything of theirs.
  history.classList.remove('acc--open');
  await a.ask({ type: 'powerloader:clearValues' });
  assert.ok(!history.classList.contains('acc--open'));
});

test('Build: the class names that change when the author opens a part by hand are offered as a rule', async () => {
  const a = revealAgent();
  const before = await a.ask({ type: 'powerloader:revealBefore', spec: '#arrears', atUrl: revealUrl });
  assert.deepEqual(before, { found: true, hidden: true });
  // The author opens the accordion themselves (the page's own script would, on their click).
  a.doc.getElementById('history').classList.add('acc--open');
  const got = await a.ask({ type: 'powerloader:revealAfter', atUrl: revealUrl });
  assert.deepEqual(got, { found: true, shown: true, name: 'Tenancy history', rules: [{ selector: '#history', addClass: ['acc--open'] }] });
  // The rule passes the template's own check, and works.
  assert.equal(a.w.PowerLoaderExtract.validateReveal(got.rules).length, 0);
  a.doc.getElementById('history').classList.remove('acc--open');
  await a.ask({ type: 'powerloader:showValues', fields: { arrears: '#arrears' }, state: 'pending', reveal: got.rules, atUrl: revealUrl });
  assert.ok(a.doc.getElementById('history').classList.contains('acc--open'));
});

test('a reveal rule may only change class names, open a <details> or remove hidden', async () => {
  const { validateReveal } = agentOn('cm/case-1001.html').w.PowerLoaderExtract;
  assert.equal(validateReveal([{ selector: '#a', addClass: ['open'] }, { selector: 'details.more', open: true }, { selector: '#x', unhide: true }]).length, 0);
  const bad = (rule) => validateReveal([rule]).join(' ');
  assert.match(bad({ selector: '#a', click: true }), /"click" isn’t allowed/);
  assert.match(bad({ selector: '#a', addClass: ['x" onclick="y'] }), /plain class names/);
  assert.match(bad({ selector: '#a', style: 'display:block' }), /"style" isn’t allowed/);
  assert.match(bad({ selector: 'label(Arrears)', addClass: ['x'] }), /plain CSS/);
  assert.match(bad({ selector: '#a' }), /changes nothing/);
  assert.match(validateReveal(Array.from({ length: 21 }, () => ({ selector: '#a', open: true }))).join(), /at most 20/);
  // A rule that fails isn't used, whatever the message carries.
  const a = revealAgent();
  await a.ask({ type: 'powerloader:showValues', fields: { arrears: '#arrears' }, state: 'pending', reveal: [{ selector: '#history', addClass: ['acc--open'], setAttribute: 'x' }], atUrl: revealUrl });
  assert.ok(!a.doc.getElementById('history').classList.contains('acc--open'));
});

test('a fetch step’s box shows the response as text only, at most four at once, then a line in the strip', async () => {
  const a = agentOn('cm/case-1001.html');
  openShadows(a);
  const before = a.doc.body.outerHTML;
  for (let i = 1; i <= 5; i++) assert.equal(await a.ask({ type: 'powerloader:fetchBox', op: 'open', id: `r1#${i}`, title: `Message ${i} of 5`, address: 'localhost/m', atUrl: url }), true);
  const fetchLayer = a.doc.querySelector('[data-powerloader="values"]').shadowRoot.children[1];
  const open = () => [...fetchLayer.children].filter((el) => el.style.getPropertyValue('height'));
  assert.equal(open().length, 4, 'four boxes; the oldest went to the strip');
  // Markup in the response is shown as its characters: nothing is parsed, loaded or run.
  const rows = [{ n: 0, text: '<img src=x onerror="alert(1)"> Name: Sophie <b>Harrison</b>' }, { gap: true }, { n: 9, text: '"income": 93.07,' }];
  const marks = [{ key: 'lastName', label: 'Last name', line: 0, start: 37, end: 43, state: 'conflict' }, { key: 'weeklyIncome', label: 'Weekly income', line: 2, start: 10, end: 15, state: 'done' }];
  assert.deepEqual(await a.ask({ type: 'powerloader:fetchBox', op: 'read', id: 'r1#5', rows, marks, line: 'Message 5 of 5: 2 values', conflict: true, atUrl: url }), { shown: 2 });
  assert.equal(fetchLayer.querySelectorAll('img, script, a, style, iframe').length, 0);
  assert.ok(fetchLayer.textContent.includes('<img src=x onerror="alert(1)"> Name: ⚠ Sophie <b>Harrison</b>'), fetchLayer.textContent);
  assert.equal(a.doc.body.outerHTML, before, 'the page itself is untouched');
  // With less motion (jsdom), outlines appear at once and the box shrinks to the strip shortly after.
  await new Promise((r) => setTimeout(r, 1700));
  assert.match(fetchLayer.textContent, /Power Loader fetched/);
  assert.match(fetchLayer.textContent, /⚠ Message 5 of 5: 2 values/);
  await a.ask({ type: 'powerloader:fetchBox', op: 'fail', id: 'r1#2', line: 'The page couldn’t be reached', atUrl: url });
  await new Promise((r) => setTimeout(r, 1600));
  assert.match(fetchLayer.textContent, /✕ Message 2 of 5: The page couldn’t be reached/);
  // Cleared with the outlines.
  await a.ask({ type: 'powerloader:clearValues' });
  assert.equal(a.doc.querySelector('[data-powerloader]'), null);
});

test('the demo’s tenancy page: the arrears are in a closed accordion, and the template’s rule opens it without a click', async () => {
  const { readdirSync } = await import('node:fs');
  const file = readdirSync(new URL('../../demo/harbour/', import.meta.url)).find((f) => /^tenancy-HH-\d+\.html$/.test(f));
  const profile = lib.profiles.find((p) => p.id === 'harbour-homes/tenancy');
  assert.deepEqual(profile.reveal, [{ selector: '#balance', addClass: ['accordion--open'] }]);
  const a = agentOn(`harbour/${file}`);
  // jsdom doesn't load the stylesheet: the closed section is given its rule here.
  const style = a.doc.createElement('style');
  style.textContent = '.accordion:not(.accordion--open) .accordion__body { display: none; }';
  a.doc.head.append(style);
  let clicks = 0;
  a.doc.addEventListener('click', () => { clicks++; }, true);
  const at = `http://localhost:8787/demo/harbour/${file}`;
  const res = await a.ask({ type: 'powerloader:showValues', fields: profile.fields, state: 'pending', reveal: profile.reveal, atUrl: at });
  assert.ok(res.found.includes('arrears'));
  assert.equal(res.closed, undefined, 'nothing left out of sight');
  assert.ok(a.doc.getElementById('balance').classList.contains('accordion--open'));
  assert.equal(clicks, 0, 'nothing is clicked');
  await a.ask({ type: 'powerloader:clearValues' });
  assert.ok(!a.doc.getElementById('balance').classList.contains('accordion--open'), 'closed again');
  // Without the rule, the step's row would say where to open it, from the accordion's own button.
  const closed = await a.ask({ type: 'powerloader:showValues', fields: { arrears: profile.fields.arrears }, state: 'pending', atUrl: at });
  assert.deepEqual(closed.closed, { arrears: 'Rent account balance' });
});

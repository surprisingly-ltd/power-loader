// Notes a flow draws on a page: a selector, expanded or compact, a style limited to how the note looks, and
// content in a small subset of HTML with case values put in as text. The page gets a tree, never HTML.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../extension/lib/extract.js';
import { agentOn } from './helpers/agent.js';
import { annotationErrors, cleanStyle, fillNote, notesForPage, parseMarkup } from '../../extension/lib/annotations.js';
import { addNote, addPage, bindPage, compileFlow, exportFlow, importFlow, newFlow, notesOf, pagesOf, removeNote, setNote, validateFlow, addField } from '../../extension/lib/flows.js';
import { validateSteps } from '../../extension/lib/journey.js';
import { demoSet } from './helpers/library.js';
import { indexLibrary } from '../../extension/lib/library.js';

const base = 'http://localhost:8787/demo/';

test('a note’s markup keeps only safe tags and links, and drops script, events and other attributes', () => {
  const { nodes, errors } = parseMarkup('<p><b>Check</b> the arrears &amp; rent<p>Then <a href="https://cm.example/case/{ref}" onclick="x()">open it</a><script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">x</a><ul><li>one<li>two</ul>');
  assert.deepEqual(nodes[0], { tag: 'p', children: [{ tag: 'b', children: ['Check'] }, ' the arrears & rent'] });
  assert.equal(nodes[1].children[1].href, 'https://cm.example/case/{ref}');
  assert.ok(!JSON.stringify(nodes).includes('alert(1)'), 'nothing of a script is kept');
  assert.ok(!JSON.stringify(nodes).includes('javascript:'), 'a script link has no address');
  assert.deepEqual(nodes[1].children.find((n) => n.tag === 'ul').children.map((li) => li.children), [['one'], ['two']], 'a new item closes the last');
  for (const e of ['the attribute onclick isn’t allowed in a note', '<script> isn’t allowed in a note', '<img> isn’t allowed in a note', 'a link in a note must start https://, http:// or mailto:']) assert.ok(errors.includes(e), e);
});

test('case values go in as text and into links encoded; a missing one says so', () => {
  const { nodes } = parseMarkup('Arrears <b>£{arrears}</b> for {lastName}. <a href="https://cm.example/search?q={lastName}">Search</a>');
  const out = fillNote(nodes, { arrears: '<img src=x onerror=alert(1)>', lastName: 'O’Brien & Co' }, (k) => `[${k} missing]`);
  assert.equal(out[1].children[0], '£<img src=x onerror=alert(1)>', 'a value is text, not markup');
  assert.equal(out[3].href, 'https://cm.example/search?q=O%E2%80%99Brien%20%26%20Co');
  assert.equal(fillNote(nodes, {}, (k) => `[${k} missing]`)[1].children[0], '£[arrears missing]');
  // A value can't make a link's address into something else.
  assert.equal(fillNote(parseMarkup('<a href="{site}">x</a>').nodes, { site: 'javascript:alert(1)' })[0].href, undefined);
});

test('a note’s style changes how it looks, never where it is or what it loads', () => {
  assert.deepEqual(cleanStyle('color: #d4351c; font-weight: bold; position: fixed; background: url(https://x.example/t.gif); top:0; color:red !important'), {
    style: 'color:#d4351c;font-weight:bold',
    errors: ['“position” can’t be set in a note’s style', 'the value of background isn’t allowed', '“top” can’t be set in a note’s style', 'the value of color isn’t allowed'],
  });
  assert.deepEqual(annotationErrors([{ id: 'a', selector: '', type: 'big', html: '' }]), ['note 1 needs a place on the page (a selector)', 'note 1: "type" must be expanded or compact', 'note 1 has nothing in it']);
  assert.deepEqual(annotationErrors([{ id: 'a', selector: '#x', type: 'compact', html: 'For {nope}' }], {}), ['note 1 uses {nope}, which isn’t a field']);
});

test('the agent draws a note next to what its selector finds, in a closed shadow root, built from the tree', async () => {
  const a = agentOn('rent-account-1042.html');
  const notes = notesForPage([
    { id: 'n1', selector: '#tenancy label(Arrears)', type: 'expanded', style: 'color:#d4351c;font-weight:bold', html: '<b>Check:</b> the referral says £{arrears}' },
    { id: 'n2', selector: '#payments', type: 'compact', style: '', html: 'Payments since {tenancyStart}' },
    { id: 'n3', selector: '#nowhere', type: 'expanded', style: '', html: 'x' },
  ], { arrears: '1,245.60 <script>' }, { arrears: { label: 'Arrears' }, tenancyStart: { label: 'Tenancy start', type: 'date' } }, (k) => `(${k}: not in the case yet)`);
  const out = await a.ask({ type: 'powerloader:annotate', notes });
  assert.deepEqual(out, { shown: ['n1', 'n2'], missing: ['n3'] });
  const hosts = a.doc.querySelectorAll('powerloader-note');
  assert.equal(hosts.length, 2);
  assert.equal(hosts[0].parentElement.localName, 'dd', 'inside the value’s cell, so the list keeps its shape');
  assert.equal(hosts[1].previousElementSibling.id, 'payments', 'after the table');
  assert.equal(hosts[0].shadowRoot, null, 'the page can’t reach into a note');
  assert.equal(hosts[0].textContent, '', 'and its words aren’t in the page’s text (clips and AI requests don’t read them)');
  assert.equal(a.doc.querySelector('#tenancy dd.bal').firstChild.textContent, '£1,245.60', 'the value a clip reads is unchanged');
  assert.equal(a.doc.querySelectorAll('script').length, 0, 'no value became markup');
  await a.ask({ type: 'powerloader:clearNotes' });
  assert.equal(a.doc.querySelectorAll('powerloader-note').length, 0);
});

test('a flow’s pages carry notes: checked, compiled to steps.json, exported and imported; a library’s are untrusted', () => {
  const flow = newFlow({ name: 'Arrears' });
  const inp = pagesOf(flow, 'input')[0];
  bindPage(flow, inp.id, { url: `${base}rent-account-1042.html`, title: 'Rent account' });
  addField(flow, { label: 'Arrears', type: 'money' });
  const mail = addPage(flow, 'email');
  assert.throws(() => addNote(mail), /address/, 'a note goes on a page, not an email');
  const n = addNote(inp, { selector: '#tenancy label(Arrears)' });
  assert.ok(validateFlow(flow).some((i) => i.code === 'note-bad' && i.pageId === inp.id), 'an empty note is a problem');
  setNote(inp, n.id, { html: 'The referral says £{arrears}', type: 'compact', style: 'color:#d4351c' });
  assert.ok(!validateFlow(flow).some((i) => i.code === 'note-bad'));
  assert.ok(!validateFlow(flow).some((i) => i.code === 'unused' && i.key === 'arrears'), 'a field a note uses isn’t unused');
  const back = importFlow(JSON.parse(JSON.stringify(exportFlow(flow))));
  assert.deepEqual(notesOf(pagesOf(back, 'input')[0]), notesOf(inp));
  removeNote(inp, n.id);
  assert.deepEqual(notesOf(inp), []);
  // A team library's own steps.json isn't read at all: steps belong to a flow.
  const team = demoSet();
  team.files['steps.json'] = { schema: 'powerloader-steps/1', steps: [] };
  const teamLib = indexLibrary(team, { approvedHosts: ['localhost:8787'] });
  assert.match(teamLib.problems.find((p) => p.path === 'steps.json').errors[0], /steps belong to a flow/);
  // The set a flow compiles to, with a bad note (an imported flow is untrusted too): reported and not used.
  const set = { ...demoSet(), flow: { id: 'f-x', name: 'Imported' } };
  set.files['steps.json'] = { schema: 'powerloader-steps/1', steps: [{ id: 'g', name: 'Queue', role: 'guide', text: '', url: `${base}cases.html`, match: [`${base}cases.html*`], annotations: [{ id: 'x', selector: '#q', type: 'expanded', style: 'position:fixed', html: '<iframe src=x></iframe>' }] }] };
  const lib = indexLibrary(set, { approvedHosts: ['localhost:8787'] });
  const errs = lib.problems.find((p) => p.path === 'steps.json')?.errors || [];
  assert.ok(errs.some((e) => /position/.test(e)) && errs.some((e) => /<iframe>/.test(e)), errs.join('\n'));
  assert.deepEqual(lib.steps || [], [], 'its steps aren’t used');
  assert.deepEqual(validateSteps({ schema: 'powerloader-steps/1', steps: [] }), []);
  assert.ok(compileFlow(flow).files);
});

test('in a case, the step’s notes for this page are filled from the case; elsewhere, or without access, none', async () => {
  globalThis.browser = globalThis.browser || { runtime: { getURL: (p) => p } };
  const { notesFor } = await import('../../extension/sidebar/annotate.js');
  const { demoLibrary } = await import('./helpers/library.js');
  const { newCase, setManual } = await import('../../extension/lib/case.js');
  const lib = demoLibrary();
  lib.steps = [{ id: 'q', name: 'Queue', role: 'guide', text: '', links: [], url: `${base}cases.html`, match: [`${base}cases.html*`], annotations: [{ id: 'n', selector: 'h1', type: 'expanded', style: '', html: 'Pick {lastName}’s case, {ref}' }] }];
  const c = newCase(lib, ['dhp']);
  c.ref = '1042';
  setManual(c, 'lastName', 'Kowalska');
  const context = (url, access = true) => ({ ui: { page: { id: 1, url }, info: { access } }, data: { case: c }, lib });
  const got = notesFor(context(`${base}cases.html`));
  assert.equal(got.mode, 'case');
  assert.deepEqual(got.notes[0].nodes, ['Pick Kowalska’s case, 1042']);
  assert.equal(notesFor(context(`${base}dhp.html`)), null, 'another page has none');
  assert.equal(notesFor(context(`${base}cases.html`, false)), null, 'no notes without access: drawing never asks for it');
  const preview = notesFor(context(`${base}cases.html`), { flow: { fields: { lastName: { label: 'Last name' } } }, notes: lib.steps[0].annotations });
  assert.deepEqual(preview.notes[0].nodes, ['Pick ‹Last name›’s case, ‹Case reference›'], 'a preview shows the fields’ names');
});

test('a note’s link is checked as an opening: one the site rules block for navigate keeps its words, not its address', async () => {
  const { notesFor } = await import('../../extension/sidebar/annotate.js');
  const { guardNoteLinks } = await import('../../extension/lib/annotations.js');
  const { demoLibrary } = await import('./helpers/library.js');
  const { newCase, setManual } = await import('../../extension/lib/case.js');
  const lib = demoLibrary();
  lib.steps = [{ id: 'q', name: 'Queue', role: 'guide', text: '', links: [], url: `${base}cases.html`, match: [`${base}cases.html*`], annotations: [{
    id: 'n', selector: 'h1', type: 'expanded', style: '',
    html: '<a href="https://attacker.example/?x={lastName}">Check</a> <a href="http://localhost:8787/demo/client-1042.html">Client</a> <a href="mailto:team@example.org">Email</a>',
  }] }];
  const c = newCase(lib, ['dhp']);
  setManual(c, 'lastName', 'Kowalska');
  const access = [{ layer: 'library', rules: [{ id: 'only-demo', effect: 'allow', pattern: 'http://localhost:8787/*' }] }];
  const got = notesFor({ ui: { page: { id: 1, url: `${base}cases.html` }, info: { access: true } }, data: { case: c, access }, lib });
  const links = got.notes[0].nodes.filter((n) => n.tag === 'a');
  assert.deepEqual(links.map((l) => [l.children[0], l.href]), [['Check', undefined], ['Client', 'http://localhost:8787/demo/client-1042.html'], ['Email', 'mailto:team@example.org']]);
  assert.ok(!JSON.stringify(got.notes).includes('Kowalska'), 'the blocked address, with the case value in it, is gone');
  assert.equal(guardNoteLinks([{ nodes: [{ tag: 'a', href: 'https://x.example/', children: ['x'] }] }], () => true)[0].nodes[0].href, 'https://x.example/', 'allowed links stay');
});

test('a note with many attribute-like runs is read in linear time', () => {
  const started = Date.now();
  const { errors } = parseMarkup(`<A !=${'"" !='.repeat(40)}`);
  assert.ok(Date.now() - started < 1000, 'parseMarkup backtracked');
  assert.ok(Array.isArray(errors));
  // Quoted and unquoted attribute values both still parse.
  const { nodes } = parseMarkup('<a href="https://cm.example/a" title=x>one</a><a href=https://cm.example/b>two</a>');
  assert.equal(nodes.length, 2);
});

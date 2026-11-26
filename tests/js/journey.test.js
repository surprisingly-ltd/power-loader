// Flows that guide a case: pages to visit, the caseworker's steps with templated links, timelines drawn from
// rows on a page or from date fields, and a picture sent to the AI only after the caseworker acknowledges it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import '../../extension/lib/extract.js';
import {
  addField, addLink, addPage, addSeries, addTimeline, bindPage, compileFlow, exportFlow, flowLib, importFlow, journeyOf, linkUrl, mapPick, moveStep,
  newFlow, pageOf, pagesOf, removePage, setSeries, setStepText, splitRowSelector, startable, validateFlow,
} from '../../extension/lib/flows.js';
import { judgeFillTest, judgeTest, recordTest } from '../../extension/lib/drafts.js';
import { indexLibrary } from '../../extension/lib/library.js';
import { addClip, clipFromExtract, newCase, setManual } from '../../extension/lib/case.js';
import { caseVars, currentStep, datePoints, fillTemplate, markStep, seriesLanes, stepForPage, stepStatus, templateErrors } from '../../extension/lib/journey.js';
import { approve, prepare, registerPresenter, review } from '../../extension/lib/ai/boundary.js';
import { buildRequest, runTask } from '../../extension/lib/ai/tasks.js';
import { effectiveSettings } from '../../extension/lib/privacy-detect.js';

const E = globalThis.PowerLoaderExtract;
const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const base = 'http://localhost:8787/demo/';
const pageDoc = (file) => new JSDOM(read(`demo/${file}`), { url: base + file }).window.document;
globalThis.browser = { runtime: { getURL: (p) => p } };
globalThis.fetch = async (p) => new Response(read(`extension/${p}`));
const codes = (issues) => issues.map((i) => i.code);

// A flow that starts at the case list, clips the employment page and fills the DHP form.
function guidedFlow() {
  const flow = newFlow({ name: 'Rent arrears help' });
  const out = pagesOf(flow, 'output')[0];
  const inp = pagesOf(flow, 'input')[0];
  const list = addPage(flow, 'guide');
  bindPage(flow, out.id, { url: `${base}dhp.html`, title: 'Discretionary housing payment' });
  bindPage(flow, inp.id, { url: `${base}employment-1042.html`, title: 'Maria Kowalska – Employment', values: ['Maria Kowalska'] });
  bindPage(flow, list.id, { url: `${base}cases.html#top`, title: 'My cases – Northshire Council Case Manager' });
  const employer = addField(flow, { label: 'Current employer' });
  const lastName = addField(flow, { label: 'Last name' });
  const dob = addField(flow, { label: 'Date of birth', type: 'date' });
  for (const [k, box, sel] of [[employer, '#d-employer', '#person label(Current employer)'], [lastName, '#d-last', '#person label(Surname)'], [dob, '#d-dob', '#person label(Date of birth) | date']]) {
    mapPick(out, k, box);
    mapPick(inp, k, sel, { filter: k === dob ? 'date' : '' });
  }
  return { flow, out, inp, list, keys: { employer, lastName, dob } };
}

function testAll(flow) {
  const lib = flowLib(flow);
  for (const p of flow.pages.filter((x) => x.draft)) {
    const file = p.role === 'output' ? 'dhp.html' : 'employment-1042.html';
    const doc = pageDoc(file);
    const probes = Object.fromEntries(Object.entries(p.draft.profile.fields).map(([k, spec]) => [k, E.probe(doc, p.role === 'output' ? k : spec)]));
    recordTest(p.draft, p.role === 'output' ? judgeFillTest(p.draft, probes, { url: base + file, lib }) : judgeTest(p.draft, probes, { url: base + file, lib, pageValues: ['Maria Kowalska'] }));
  }
}

test('a page to visit has an address and no profile, is optional, and comes first in the steps', () => {
  const { flow, out, inp, list } = guidedFlow();
  assert.equal(list.name, 'My cases');
  assert.equal(list.url, `${base}cases.html`, 'the fragment is dropped');
  assert.ok(E.matchUrl(list.match, `${base}cases.html?page=2`));
  assert.equal(list.draft, null);
  assert.deepEqual(journeyOf(flow).map((p) => p.id), [list.id, inp.id, out.id], 'pages to visit, then pages to clip, then forms');
  assert.ok(moveStep(flow, out.id, -1));
  assert.deepEqual(journeyOf(flow).map((p) => p.id), [list.id, out.id, inp.id]);
  assert.equal(moveStep(flow, list.id, -1), false, 'the first step can’t move earlier');
  testAll(flow);
  assert.deepEqual(codes(validateFlow(flow).filter((i) => i.level === 'error')), []);
  assert.deepEqual(startable(flow).unmade, [], 'a page to visit isn’t a page still to make');
  // A page to visit with no address yet is a warning, not a blocker; and the last one can be removed.
  const extra = addPage(flow, 'guide');
  assert.equal(validateFlow(flow).find((i) => i.pageId === extra.id).code, 'guide-unbound');
  assert.ok(removePage(flow, extra.id));
  assert.ok(removePage(flow, list.id));
});

test('links are templates: {ref} and the flow’s fields, checked as they are written, filled from the case', () => {
  const { flow, inp, list, keys } = guidedFlow();
  setStepText(list, 'Pick up the oldest case marked New.');
  const search = addLink(list, { label: 'Search for the client', url: `${base}client-{clientNumber}.html?q={${keys.lastName}}` });
  let bad = validateFlow(flow).filter((i) => i.code === 'link-bad');
  assert.equal(bad.length, 1);
  assert.match(bad[0].text, /\{clientNumber\}, which isn’t a field/);
  search.url = 'javascript:alert(1)';
  assert.match(validateFlow(flow).find((i) => i.code === 'link-bad').text, /must be a web address/);
  search.url = `${base}client-{ref}.html?q={${keys.lastName}}`;
  const open = addLink(list, { to: inp.id });
  assert.equal(linkUrl(flow, open), `${base}employment-{ref}.html`, 'a link to a page opens its address');
  assert.deepEqual(codes(validateFlow(flow)).filter((c) => c.startsWith('link')), []);
  assert.deepEqual(templateErrors('https://x.example/{ref}', {}), []);
  // Values are encoded, and a link that needs a value the case hasn't got says which.
  assert.deepEqual(fillTemplate('https://x.example/s?q={lastName}&c={ref}', { ref: 'HSG/1', lastName: 'Ó Brien & co' }), { url: 'https://x.example/s?q=%C3%93%20Brien%20%26%20co&c=HSG%2F1', missing: [] });
  assert.deepEqual(fillTemplate('https://x.example/{ref}', { ref: '' }), { url: null, missing: ['ref'] });
  // Removing the page a link opens leaves the link with no address, which the checks report.
  const extra = addPage(flow, 'input');
  const to = addLink(list, { label: 'Elsewhere', to: extra.id });
  removePage(flow, extra.id);
  assert.equal(to.to, '');
  assert.ok(validateFlow(flow).some((i) => i.code === 'link-empty' && i.linkId === to.id));
});

test('the steps compile to steps.json, a case follows them page by page, and links fill from the case', () => {
  const { flow, out, inp, list, keys } = guidedFlow();
  setStepText(list, 'Pick up the oldest case marked New, and type its client number as the case reference.');
  addLink(list, { label: 'Open the employment page', to: inp.id });
  addLink(list, { label: 'Search', url: `${base}search.html?q={${keys.lastName}}` });
  setStepText(inp, 'Check it’s the right person, then clip it.');
  addLink(inp, { to: out.id });
  testAll(flow);
  const { files, hosts } = compileFlow(flow);
  assert.deepEqual(files['steps.json'].steps.map((s) => [s.role, s.name]), [['guide', 'My cases'], ['input', inp.name], ['output', 'Discretionary housing payment']]);
  assert.equal(files['steps.json'].steps[0].links[0].label, 'Open the employment page');
  assert.equal(files['steps.json'].steps[1].links[0].label, 'Open Discretionary housing payment', 'a link with no words is named after its page');
  const lib = indexLibrary({ files }, { approvedHosts: hosts });
  assert.deepEqual(lib.problems, []);
  assert.equal(lib.steps.length, 3);
  const c = newCase(lib, Object.keys(lib.forms), { ref: '' });
  // On the case list the step is that page; elsewhere it's the first one not done.
  assert.equal(stepForPage(lib, `${base}cases.html`).name, 'My cases');
  assert.equal(currentStep(c, lib, `${base}cases.html`).here, true);
  assert.equal(currentStep(c, lib, 'https://elsewhere.example/').step.role, 'guide');
  let vars = caseVars(c, lib);
  assert.deepEqual(fillTemplate(lib.steps[0].links[0].url, vars).missing, ['ref'], 'the link waits for the case reference');
  c.ref = '1042';
  setManual(c, keys.lastName, 'Kowalska');
  vars = caseVars(c, lib);
  assert.equal(fillTemplate(lib.steps[0].links[0].url, vars).url, `${base}employment-1042.html`);
  assert.equal(fillTemplate(lib.steps[0].links[1].url, vars).url, `${base}search.html?q=Kowalska`);
  markStep(c, lib.steps[0].id, true);
  assert.equal(currentStep(c, lib, 'https://elsewhere.example/').step.role, 'input');
  // Clipping the page completes its step; filling the form is 'filled' until it's submitted.
  const profile = lib.profiles[0];
  assert.ok(stepForPage(lib, `${base}employment-1042.html`));
  const doc = pageDoc('employment-1042.html');
  addClip(c, lib, clipFromExtract(lib, profile, { ...E.extract(doc, profile, { baseUrl: `${base}employment-1042.html` }), url: `${base}employment-1042.html`, title: doc.title }));
  assert.equal(stepStatus(c, lib.steps[1]), 'done');
  c.filled[lib.steps[2].formId] = { at: new Date().toISOString(), items: [] };
  assert.equal(stepStatus(c, lib.steps[2]), 'filled');
  c.submitted[lib.steps[2].formId] = { how: 'reported' };
  assert.equal(currentStep(c, lib, 'https://elsewhere.example/'), null, 'every step is done');
});

test('a library’s steps.json and timelines.json are untrusted: bad ones are reported and not used', () => {
  const { flow } = guidedFlow();
  testAll(flow);
  const { files, hosts } = compileFlow(flow);
  const steps = { schema: 'powerloader-steps/1', steps: [{ id: 'a', name: 'Somewhere', role: 'guide', match: ['https://not-approved.example/*'], links: [{ label: 'Go', url: 'file:///etc/passwd' }] }, { id: 'b', name: 'Form', role: 'output', formId: 'nope' }] };
  const timelines = { schema: 'powerloader-timelines/1', timelines: [{ id: 't', name: 'T', series: [{ id: 's', label: 'S', kind: 'wave', colour: 'url(x)', source: { at: 'currentEmployer' } }] }] };
  const lib = indexLibrary({ files: { ...files, 'steps.json': steps, 'timelines.json': timelines } }, { approvedHosts: hosts });
  assert.deepEqual(lib.steps, []);
  assert.deepEqual(lib.timelines, []);
  const errs = Object.fromEntries(lib.problems.map((p) => [p.path, p.errors.join(' | ')]));
  assert.match(errs['steps.json'], /must be a web address/);
  assert.doesNotMatch(errs['steps.json'], /approved/, 'link checks come first; hosts are checked once the file is well formed');
  assert.match(errs['timelines.json'], /"kind" must be bar or point/);
  assert.match(errs['timelines.json'], /"colour" must be one of/);
  steps.steps = [steps.steps[0]];
  steps.steps[0].links = [];
  assert.match(indexLibrary({ files: { ...files, 'steps.json': steps } }, { approvedHosts: hosts }).problems[0].errors[0], /not-approved\.example isn’t on the approved systems list/);
});

test('a picked cell gives the repeating row and the part within it', () => {
  assert.deepEqual(splitRowSelector('#history > tbody > tr:nth-of-type(2) > td:nth-of-type(3)'), { rows: '#history > tbody > tr', cell: 'td:nth-of-type(3)' });
  assert.deepEqual(splitRowSelector('main > ul > li:nth-of-type(4) > span'), { rows: 'main > ul > li', cell: 'span' });
  assert.equal(splitRowSelector('#dob'), null, 'a single element isn’t in a row');
});

test('a flow’s timeline draws series of bars and pointers from page rows and date fields, with its own colours', () => {
  const { flow, inp, keys } = guidedFlow();
  const t = addTimeline(flow, 'Work and benefits');
  const jobs = addSeries(flow, t.id, { label: 'Employments', kind: 'bar' });
  const pick = splitRowSelector('#history > tbody > tr:nth-of-type(1) > td:nth-of-type(3)');
  setSeries(flow, t.id, jobs.id, { colour: 'purple', source: { pageId: inp.id, rows: pick.rows, label: 'td:nth-of-type(2)', start: pick.cell, end: 'td:nth-of-type(4)' } });
  const born = addSeries(flow, t.id, { label: 'Born', kind: 'point', type: 'fields' });
  assert.deepEqual(codes(validateFlow(flow)).filter((c) => c.startsWith('tl')), ['tl-incomplete'], 'a pointer needs its date field');
  setSeries(flow, t.id, born.id, { shape: 'diamond', colour: '#123456', source: { at: keys.employer } });
  assert.deepEqual(codes(validateFlow(flow)).filter((c) => c.startsWith('tl')), ['tl-field'], 'only a date field can be a pointer');
  setSeries(flow, t.id, born.id, { source: { at: keys.dob } });
  testAll(flow);
  assert.deepEqual(validateFlow(flow).filter((i) => i.level === 'error'), []);
  assert.ok(!validateFlow(flow).some((i) => i.code === 'unused'), 'a field a timeline uses isn’t unused');
  const { files, hosts } = compileFlow(flow);
  const profile = Object.entries(files).find(([p]) => p.startsWith('profiles/pages/'))[1];
  assert.deepEqual(profile.fields[`tl_${jobs.id}`], ['#history > tbody > tr', { '@type': 'tlbar', label: 'td:nth-of-type(2)', start: 'td:nth-of-type(3) | date', end: 'td:nth-of-type(4) | date' }]);
  assert.deepEqual(files['timelines.json'].timelines[0].series.map((s) => [s.kind, s.colour, s.source]), [
    ['bar', 'purple', { profile: profile.id, group: `tl_${jobs.id}` }], ['point', '#123456', { at: keys.dob }]]);
  const lib = indexLibrary({ files }, { approvedHosts: hosts });
  assert.deepEqual(lib.problems, []);
  // A case clips the page: the series' rows come with the clip, and the pointer comes from the case's value.
  const c = newCase(lib, Object.keys(lib.forms));
  const doc = pageDoc('employment-1042.html');
  const p = lib.profiles[0];
  addClip(c, lib, clipFromExtract(lib, p, { ...E.extract(doc, p, { baseUrl: `${base}employment-1042.html` }), url: `${base}employment-1042.html`, title: doc.title }));
  const [bars, points] = seriesLanes(c, lib, lib.timelines[0]);
  assert.equal(bars.colour, '#4c2c92');
  assert.equal(bars.bars.length, 6, 'every row with a start date, the header left out');
  assert.deepEqual([bars.bars[0].label, bars.bars[0].start, bars.bars[0].end], ['Tesco Stores Ltd', '2016-09-05', '2019-04-30']);
  assert.equal(bars.bars.at(-1).end, null, 'an empty end is ongoing');
  assert.equal(bars.gaps, true);
  assert.deepEqual([points.shape, points.colour, points.points.map((x) => x.at)], ['diamond', '#123456', ['1986-07-14']]);
  assert.deepEqual(datePoints(c, lib).map((x) => x.label), ['Date of birth'], 'every date field is a single date for “All dates”');
  // Round trip: the timeline and the steps survive export and import, with page ids remapped.
  const back = importFlow(JSON.parse(JSON.stringify(exportFlow(flow))));
  const s2 = back.timelines[0].series[0];
  assert.equal(pageOf(back, s2.source.pageId).name, inp.name);
  assert.equal(s2.colour, 'purple');
  assert.deepEqual(journeyOf(back).map((x) => x.role), journeyOf(flow).map((x) => x.role));
  assert.equal(pagesOf(back, 'guide')[0].match, pagesOf(flow, 'guide')[0].match);
});

test('a picture goes to the AI only when the caseworker ticks that it can’t be redacted, and never when policy blocks it', async () => {
  const lib = indexLibrary({ files: compileFlow(guidedFlow().flow).files }, { approvedHosts: ['localhost:8787'] });
  const image = 'data:image/jpeg;base64,/9j/AAAA';
  const ctx = { known: [], patterns: [], settings: effectiveSettings(), identifierTypes: {}, model: { ready: true, required: false } };
  const request = buildRequest('readImage', { image, width: 10, height: 10, title: 'Letter from Maria Kowalska.jpg', keys: Object.keys(lib.fields) }, { lib, system: 'sys' });
  const state = prepare(request, { ...ctx, known: [{ category: 'person_name', text: 'Maria Kowalska' }] });
  const r = review(state);
  assert.equal(r.images, 1);
  assert.equal(r.needsAck, true);
  assert.match(r.parts.find((p) => p.id === 'meta').sent, /<redacted:person_name/, 'the picture’s name is still redacted');
  assert.throws(() => approve(state), /Tick that you understand the picture is sent as it is/);
  state.imageAck = true;
  const payload = approve(state);
  const content = payload.messages[1].content;
  assert.deepEqual(content[1], { type: 'image_url', image_url: { url: image } });
  assert.doesNotMatch(content[0].text, /Maria/);
  assert.equal(payload.images, 1);
  assert.throws(() => prepare(request, { ...ctx, blockImages: true }), /doesn’t allow pictures/);
  assert.throws(() => prepare(buildRequest('readImage', { image: 'https://evil.example/x.png', title: 'x', keys: [] }, { lib, system: '' }), ctx), /Only a picture read on this computer/);
  // End to end: the answer's values are checked like any other, and the text it read is kept for the reader.
  registerPresenter(async (st) => { st.imageAck = true; return true; });
  const out = await runTask('readImage', { image, title: 'Payslip', keys: Object.keys(lib.fields) }, {
    lib, context: () => ctx, config: {}, completeFn: async () => JSON.stringify({ values: { currentEmployer: { value: 'Royal Mail Group', quote: 'Employer: Royal Mail Group' }, dateOfBirth: { value: 'not a date' } }, text: 'Employer: Royal Mail Group' }),
  });
  assert.deepEqual(out.rows.map((x) => [x.key, x.ok]), [['currentEmployer', true], ['dateOfBirth', false]]);
  assert.equal(out.text, 'Employer: Royal Mail Group');
});

test('✦ steps from the guidance: only known pages, web addresses with known names, and no placeholders', async () => {
  const { flow, inp, list } = guidedFlow();
  registerPresenter(async () => true);
  const pages = journeyOf(flow).map((p) => ({ id: p.id, role: p.role, name: p.name, url: p.url }));
  const ctx = { known: [], patterns: [], settings: effectiveSettings(), identifierTypes: {}, model: { ready: true, required: false } };
  let sent;
  const out = await runTask('flowSteps', { guidance: 'Start at My cases, then open the employment page.', pages }, {
    lib: flowLib(flow), context: () => ctx, config: {},
    completeFn: async (payload) => {
      sent = payload.messages[1].content;
      return JSON.stringify({ steps: [
        { page: list.id, text: 'Pick the oldest new case.', links: [{ label: 'Open employment', to: inp.id }, { label: 'Bad', url: 'https://x.example/{secret}' }, { label: 'Search', url: `${base}search.html?q={lastName}` }] },
        { page: 'p-made-up', text: 'Nope' },
      ] });
    },
  });
  assert.match(sent, /employment-\{ref\}\.html/, 'pages go as link shapes');
  assert.match(sent, /\{lastName\} \(Last name\)/);
  assert.equal(out.steps.length, 1);
  assert.deepEqual(out.steps[0].links.map((l) => l.label), ['Open employment', 'Search']);
});

// ------------------------------------------------------------------ the open step's one main button

const X = 'https://x.example';
function stepsLib() {
  return {
    fields: { lastName: { label: 'Last name' } }, forms: { form: { id: 'form', name: 'Form', url: `${X}/form`, fill: 'fill/form', fields: [] } },
    fill: [{ id: 'fill/form', match: [`${X}/form*`], fields: {} }],
    profiles: [{ id: 'case', name: 'Case', match: [`${X}/case-*`], urlPattern: `${X}/case-{ref}.html`, fields: {} }],
    steps: [
      { id: 'g', name: 'Queue', role: 'guide', text: '', url: `${X}/queue`, match: [`${X}/queue*`], links: [{ label: 'Open the queue', url: `${X}/queue` }], choose: { label: 'Choose a case', next: 'p', url: `${X}/case-{ref}.html` } },
      { id: 'p', name: 'Case', role: 'input', text: '', profileId: 'case', links: [] },
      { id: 'g2', name: 'Search', role: 'guide', text: '', links: [{ label: 'Search for the client', url: `${X}/search?q={lastName}` }] },
      { id: 'e', name: 'Tell them', role: 'email', text: '', email: { to: 'a@b.cd', subject: 'Case {ref}' }, links: [] },
      { id: 'f', name: 'Messages', role: 'fetch', text: '', url: `${X}/messages`, match: [`${X}/messages*`], fetch: { requests: [{ id: 'r', name: 'M', url: `${X}/m/{ref}`, profileId: 'm', required: true }] }, links: [] },
      { id: 'o', name: 'Form', role: 'output', text: '', formId: 'form', links: [] },
    ],
  };
}
const blank = () => ({ ref: '', clips: [], steps: {}, filled: {}, submitted: {}, manual: {}, resolved: {}, resolvedOn: {}, excluded: [], forms: [{ id: 'form', version: 'v1' }] });

test('nextStepAction: one main button for every kind of open step, always the next thing to do', async () => {
  const { nextStepAction } = await import('../../extension/lib/journey.js');
  const lib = stepsLib();
  const c = blank();
  const at = (url, o = {}) => nextStepAction(c, lib, { url, ...o });
  // Its page isn't in view, the address is known: go there, with the flow's own words for that address.
  assert.deepEqual(at('https://elsewhere.example/'), { kind: 'go', label: 'Open the queue', url: `${X}/queue`, stepId: 'g' });
  // A page to visit, in view, that chooses the case: done on the page.
  assert.deepEqual(at(`${X}/queue`), { kind: 'on-page', label: '', text: 'On the page: open the case you’re picking up.', stepId: 'g' });
  // A page to clip, in view, not clipped.
  c.ref = '1001';
  assert.equal(at(`${X}/case-1001.html`, { info: { kind: 'source', profileId: 'case' } }).kind, 'clip');
  // Done, and a later step isn't: Next, to that step (its page isn't known, so it just opens).
  c.clips.push({ id: 'c1', profile: { id: 'case' }, values: {}, records: [] });
  assert.deepEqual(at(`${X}/case-1001.html`, { info: { kind: 'source', profileId: 'case' } }), { kind: 'next', label: 'Next: Search', stepId: 'p', nextId: 'g2', url: null });
  // Its address needs a value the case lacks: no button, and which value.
  assert.deepEqual(at('https://elsewhere.example/'), { kind: 'needs', label: '', missing: ['lastName'], stepId: 'g2' });
  // A step the caseworker chose is the open one, wherever they are.
  assert.equal(at('https://elsewhere.example/', { chosen: 'e' }).kind, 'email');
  // A page to visit, not in view: its first link.
  c.manual.lastName = 'Kowalska';
  assert.deepEqual(at('https://elsewhere.example/'), { kind: 'link', label: 'Search for the client', url: `${X}/search?q=Kowalska`, linkIndex: 0, stepId: 'g2' });
  markStep(c, 'g2', true);
  // An email, not opened.
  assert.equal(at('https://elsewhere.example/').kind, 'email');
  markStep(c, 'e', true);
  // A fetch step, on its page, not run; not on its page, go there.
  assert.equal(at(`${X}/messages`).kind, 'fetch');
  assert.deepEqual(at('https://elsewhere.example/'), { kind: 'go', label: 'Go to Messages', url: `${X}/messages`, stepId: 'f' });
  markStep(c, 'f', true);
  // A form, in view, not filled; filled, not submitted.
  assert.equal(at(`${X}/form`, { info: { kind: 'form', formId: 'form' } }).kind, 'fill');
  c.filled.form = { at: 'now' };
  assert.deepEqual(at(`${X}/form`, { info: { kind: 'form', formId: 'form' } }), { kind: 'on-page', label: '', text: 'On the page: check every box, complete anything empty, then submit it yourself.', stepId: 'o' });
  // Every step done: Finish case, except on a confirmation page, whose own card has it.
  c.submitted.form = { how: 'reported' };
  assert.deepEqual(at('https://elsewhere.example/'), { kind: 'finish', label: 'Finish case', stepId: null });
  assert.equal(at('https://elsewhere.example/', { info: { kind: 'confirm' } }), null);
  assert.equal(at('https://elsewhere.example/', { chosen: 'g2' }).kind, 'finish', 'a done step opened, with nothing left to do');
});

test('nextStepAction: a step whose page the site rules block has no main button', async () => {
  const { nextStepAction } = await import('../../extension/lib/journey.js');
  const lib = stepsLib();
  const c = blank();
  assert.equal(nextStepAction(c, lib, { url: 'https://elsewhere.example/', blocked: (s) => s.id === 'g' }).kind, 'blocked');
  // The address can't be opened: no button to it either.
  assert.equal(nextStepAction(c, lib, { url: 'https://elsewhere.example/', navigable: () => false }).kind, 'blocked');
});

// ------------------------------------------------------------------ steps with a condition

test('stepNeeded and stepStatus: a step needed only when a value is missing, or present, judged in its turn', async () => {
  const { stepNeeded, stepStatus: status, validateSteps: check, wantStep } = await import('../../extension/lib/journey.js');
  const lib = { fields: { tenancyRef: { label: 'Tenancy reference' } }, forms: {}, fill: [], profiles: [{ id: 'case', match: [`${X}/case-*`], fields: {} }, { id: 'other', match: [`${X}/other-*`], fields: {} }], steps: [] };
  const first = { id: 'a', name: 'Case', role: 'input', profileId: 'case', text: '', links: [] };
  const ask = { id: 'b', name: 'Ask for it', role: 'email', text: '', email: { to: 'a@b.cd', subject: 'x' }, links: [], when: { field: 'tenancyRef', is: 'missing' } };
  const only = { id: 'c', name: 'Only with it', role: 'input', profileId: 'other', text: '', links: [], when: { field: 'tenancyRef', is: 'present' } };
  lib.steps = [first, ask, only];
  const c = blank();
  // Not judged yet: the step before it isn't done.
  assert.equal(stepNeeded(c, lib, ask), null);
  assert.equal(status(c, ask, lib), 'todo');
  // The case page clipped without the value: missing, so needed; the other isn't.
  c.clips.push({ id: 'c1', profile: { id: 'case' }, values: {}, records: [] });
  assert.equal(stepNeeded(c, lib, ask), true);
  assert.equal(status(c, ask, lib), 'todo');
  // With the value: not needed, and passed over; the step for "present" is needed.
  c.clips[0].values.tenancyRef = 'HH-1';
  assert.equal(stepNeeded(c, lib, ask), false);
  assert.equal(status(c, ask, lib), 'skipped');
  assert.equal(stepNeeded(c, lib, only), true, 'judged once every step before it is done or not needed');
  assert.equal(currentStep(c, lib, 'https://elsewhere.example/').step.id, 'c', 'Next passes over a step that isn’t needed');
  // A value in conflict is there: the caseworker decides it, so the step that asks for it isn't needed.
  c.clips.push({ id: 'c2', profile: { id: 'other' }, values: { tenancyRef: 'HH-2' }, records: [] });
  assert.equal(stepNeeded(c, lib, ask), false);
  // A value removed later brings the step back.
  c.clips = [{ id: 'c1', profile: { id: 'case' }, values: {}, records: [] }];
  assert.equal(status(c, ask, lib), 'todo');
  // Marked done by hand: done, whatever its condition says.
  c.clips[0].values.tenancyRef = 'HH-1';
  markStep(c, 'b', true);
  assert.equal(status(c, ask, lib), 'done');
  markStep(c, 'b', false);
  // Do it anyway: a normal step for this case.
  wantStep(c, 'b');
  assert.equal(status(c, ask, lib), 'todo');
  // Without the library a condition can't be judged: the step is as it would be.
  assert.equal(status(blank(), ask), 'todo');
  // The case reference can be the field.
  assert.equal(stepNeeded({ ...blank(), clips: c.clips }, { ...lib, steps: [first, { ...ask, when: { field: 'ref', is: 'missing' } }] }, { ...ask, when: { field: 'ref', is: 'missing' } }), true);
  // steps.json: the shape, and a field that exists.
  const doc = (when) => ({ schema: 'powerloader-steps/1', steps: [{ ...ask, when }] });
  assert.deepEqual(check(doc({ field: 'tenancyRef', is: 'missing' }), lib.fields), []);
  assert.deepEqual(check(doc({ field: 'ref', is: 'present' }), lib.fields), []);
  assert.match(check(doc({ field: 'tenancyRef', is: 'empty' }), lib.fields)[0], /"when" must be \{ field, is: "missing" \| "present" \}/);
  assert.match(check(doc({ field: 'nope', is: 'missing' }), lib.fields)[0], /"when" uses nope, which isn’t a field/);
});

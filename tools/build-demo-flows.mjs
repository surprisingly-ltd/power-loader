// Exports the demo flows that the site's "Try a flow" page offers for download, from the hosted demo
// library, with the extension's own code (lib/flows.js), so each file is what Flows → Import a flow expects.
// Pages come back untested on import by design: they are tested on the caseworker's computer.
import fs from 'node:fs/promises';
import path from 'node:path';
import '../extension/lib/extract.js'; // defines globalThis.PowerLoaderExtract, which the library checks use
import { indexLibrary } from '../extension/lib/library.js';
import {
  addField, addLink, addListRequest, addNote, addPage, addRequest, exportFlow, flowFileName, flowFromLibrary, newFlow, pagesOf, removePage, setChoose, setEmail, setRequest, setShow, setStepText, setStepWhen, setThen, validateFlow,
} from '../extension/lib/flows.js';
import { ASK_FOR_REFERENCE } from './build-demo-systems.mjs';
import { randomDraftId } from '../extension/lib/drafts.js';
import { contentHash } from '../extension/lib/hash.js';

// The flows offered on the site: library form ids, the name the flow gets, the page profiles it clips (the
// library has more pages that read these forms' fields), and for the rent support review the steps that guide
// the caseworker through the synthetic systems (tools/build-demo-systems.mjs).
export const DEMO_FLOWS = [
  { forms: ['dhp'], name: 'Discretionary housing payment', pages: ['cm/client-record', 'harbour-homes/rent-account', 'biv/employment'] },
  { forms: ['hsr'], name: 'Housing support referral', pages: ['cm/client-record'] },
  // The library has no fill profile for this form yet, so its flow isn't finished: the form is made in Build.
  { forms: ['coc'], name: 'Change of circumstances', pages: ['cm/client-record', 'biv/employment'], unfinished: true },
  { forms: ['rsr'], name: 'Rent support review', pages: ['cm/case', 'harbour-homes/tenancy', 'biv/income'], steps: 'casework', fetch: 'pages' },
  { forms: ['rsr'], name: 'Rent support review (messages as data)', pages: ['cm/case', 'harbour-homes/tenancy', 'biv/income'], steps: 'casework', fetch: 'data' },
  // No form: the team inbox's messages are fetched and read as rows, and the open urgent referrals listed.
  { forms: [], name: 'Inbox triage', pages: [], steps: 'triage' },
];

/** The demo's address in the library: http://localhost:8787/demo/ locally, the site's /demo/ when hosted. */
const demoBase = (lib) => lib.forms.rsr.url.replace(/rent-review\.html$/, '');

/**
 * The rent support review's steps: the work queue, the case and the two records it links to, a fetch step on
 * the client's messages that reads every message (or the same messages as data), the form, and an email.
 */
function casework(flow, lib, { fetch }) {
  const B = demoBase(lib);
  const byProfile = (id) => pagesOf(flow, 'input').find((p) => p.profileId === id);
  const [caseP, tenancy, income] = ['cm/case', 'harbour-homes/tenancy', 'biv/income'].map(byProfile);
  const form = pagesOf(flow, 'output')[0];

  // The case is chosen on the work queue: Power Loader takes its reference from the case page's address
  // (cm/case-{ref}.html), so nothing is typed. The queue can't link to a case it hasn't chosen yet.
  const queue = addPage(flow, 'guide');
  Object.assign(queue, { name: 'Choose a case', url: `${B}cm/queue.html`, match: `${B}cm/queue*` });
  setStepText(queue, 'Go to the work queue and open the case you’re picking up: Pick up the next case offers the oldest one that isn’t done. Power Loader takes the case reference from the case you open. The team’s procedure says what to check at each step.');
  addLink(queue, { label: 'Go to the work queue', url: `${B}cm/queue.html` });
  addLink(queue, { label: 'Read the team’s procedure', url: `${B}intranet/rent-support-review.html` });
  setChoose(queue, caseP.id);

  caseP.name = 'Case';
  setStepText(caseP, 'Clip the case. It has the client’s details and the references for the other systems. Then open the rent account, the income record and the client’s messages.');
  addLink(caseP, { label: 'Open the rent account', to: tenancy.id });
  addLink(caseP, { label: 'Open the income record', to: income.id });

  // An email to the client, written from the case: quicker than typing it, and the same words each time. The
  // case page already has the client's email address; the flow reads it too, for this email only.
  const emailKey = addField(flow, { key: 'email', ...lib.fields.email });
  const caseProfile = lib.profiles.find((p) => p.id === 'cm/case');
  caseP.draft.profile.fields[emailKey] = caseProfile.fields.email;
  const ask = addPage(flow, 'email');
  ask.name = 'Ask the client for a missing reference';
  setStepText(ask, 'Open this email in your email app, check it and send it, then wait for the client’s reply with their Harbour Homes tenancy reference.');
  // Only for a case with no tenancy reference: Next passes over it otherwise.
  setStepWhen(ask, { field: 'tenancyRef', is: 'missing' });
  setEmail(ask, { to: `{${emailKey}}`, subject: ASK_FOR_REFERENCE.subject, body: ASK_FOR_REFERENCE.body });
  setStepText(tenancy, 'Clip the rent account. If the address differs from the case, check which is current before you go on.');
  setStepText(income, 'Clip the income record. If Power Loader says this may be a different person, stop: the reference has been reused, so don’t use this record.');

  const step = addPage(flow, 'fetch');
  Object.assign(step, { name: 'Customer messages', url: `${B}messages/client/{clientId}.html`, match: `${B}messages/client/*` });
  addLink(income, { label: 'Open the client’s messages', to: step.id });
  if (fetch === 'pages') {
    setStepText(step, 'A change of circumstances can be in any of the client’s online forms, and the list doesn’t say which. Press Fetch to read all six messages, 4 at a time: Power Loader clips the effective date, the new weekly income and any tenancy end date from the ones that have them.');
    const message = byProfile('messages/message');
    for (let n = 1; n <= 6; n++) {
      const { request, page } = addRequest(flow, step.id, { name: `Message ${n}` });
      setRequest(flow, step.id, request.id, { url: `${B}messages/message/{clientId}-${n}.html` });
      page.url = `${B}messages/message/{clientId}-${n}.html`;
      page.draft = { ...structuredClone(message.draft), id: randomDraftId() };
      // The library's template, so the Templates tab knows the six are one.
      page.profileId = 'messages/message';
    }
  } else {
    setStepText(step, 'The messages service also sends the client’s messages as data. Press Fetch to read them in one request: Power Loader clips the effective date, the new weekly income and any tenancy end date from the form that has them.');
    const data = byProfile('messages/messages-data');
    const { request, page } = addRequest(flow, step.id, { name: 'Messages (data)' });
    setRequest(flow, step.id, request.id, { url: `${B}messages/api/{clientId}.json` });
    page.url = `${B}messages/api/{clientId}.json`;
    page.draft = { ...structuredClone(data.draft), id: randomDraftId() };
    page.profileId = 'messages/messages-data';
  }
  setThen(step, { to: form.id });
  addNote(step, { selector: '#messages', type: 'expanded', html: '<p><strong>Read every message.</strong> A change of circumstances can be in any online form. Use the step’s Fetch button rather than opening each one.</p>' });
  // The profiles the fetch step reads aren't pages to clip of their own.
  for (const id of ['messages/message', 'messages/messages-data']) {
    const own = byProfile(id);
    if (own) flow.pages.splice(flow.pages.indexOf(own), 1);
  }

  setStepText(form, 'Fill the review from the case. Write your recommendation yourself; check every box, then submit. Back on the case, mark it done and pick up the next one.');
  const email = addPage(flow, 'email');
  email.name = 'Tell the income team';
  setStepText(email, 'Once the review is submitted, open this email in your email app, check the arrears and the tenancy reference in it, and send it. Then mark the case done on its case page.');
  setEmail(email, {
    to: 'income.team@example.org',
    subject: 'Rent support review for {clientId}',
    body: 'Case {ref}: a rent support review has been submitted for {firstName} {lastName} ({clientId}), tenancy {tenancyRef}. Arrears are {arrears}.',
  });
  flow.journey = [queue, caseP, ask, tenancy, income, step, form, email].map((p) => p.id);
  flow.guidance = reviewGuidance(B, fetch);
}

/**
 * The rent support review's instructions, in the order the caseworker takes the steps. The flow's guidance is
 * plain text (the editor shows it, and the AI reads it), so the work queue's address is written out; the first
 * step, Choose a case, has the link.
 */
const reviewGuidance = (B, fetch) => [
  `1. Choose a case. Go to the work queue at ${B}cm/queue.html and open the case you want to work on: Pick up the next case offers the oldest one that isn’t done. Power Loader takes the case reference from the case you open.`,
  '2. Case. Clip the case page: the client’s details and the references for the other systems.',
  '3. Ask the client for a missing reference. Only if the case has no Harbour Homes tenancy reference: open the email, check it and send it, then wait for the reply. Power Loader passes over this step for a case that has one.',
  '4. Harbour Homes tenancy. Clip the rent account. If its address differs from the case, check which is current before you go on.',
  '5. Employment and income record. Clip it. If Power Loader says it may be a different person, stop: the reference has been reused, so don’t use the record.',
  `6. Customer messages. On the client’s messages, press Fetch: ${fetch === 'data' ? 'one request reads the messages as data' : 'Power Loader reads all six messages, 4 at a time'} and clips any change of circumstances (effective date, new weekly income, tenancy end date).`,
  '7. Rent support review. Fill the form from the case, write your recommendation yourself, check every box and submit.',
  '8. Tell the income team. Open the email, check it and send it. Then mark the case done on its case page and pick up the next one.',
  'The team’s own procedure, for doing the same review by hand, is on the staff intranet.',
].join('\n');

/** A library profile as a page's draft: a copy, not yet tested on this computer (tests happen where it's imported). */
const libraryDraft = (lib, id) => {
  const { path, ...body } = structuredClone(lib.profiles.find((p) => p.id === id)); // eslint-disable-line no-unused-vars
  return { id: randomDraftId(), kind: 'extract', base: { id: body.id, version: body.version, commit: lib.commit }, from: 'library', use: false, tested: null, second: null, exported: null, conflict: null, profile: { ...body, kind: 'extract' } };
};

/**
 * The inbox triage: no form and no case reference. A fetch step on the team inbox fetches every message on
 * the page and reads each as a row; its show lists the open urgent referrals and marks them in the inbox.
 * Then a step says what to do with each one.
 */
function triage(lib) {
  const B = demoBase(lib);
  const flow = newFlow({ name: 'Inbox triage' });
  const step = addPage(flow, 'fetch');
  Object.assign(step, { name: 'Team inbox', url: `${B}messages/index.html`, match: `${B}messages/index*` });
  setStepText(step, 'The inbox doesn’t say which messages are referrals, how urgent they are or whether anyone has picked them up. Press Fetch: Power Loader reads every message on this page of the inbox, 4 at a time, and lists the urgent referrals that are still open. They’re marked in the inbox too.');
  const { request, page, listPage } = addListRequest(flow, step.id, { name: 'Messages', max: 25 });
  listPage.name = 'Team inbox: the list';
  listPage.url = `${B}messages/index.html`;
  listPage.draft = libraryDraft(lib, 'messages/inbox');
  listPage.profileId = 'messages/inbox';
  page.name = 'Messages';
  page.url = `${B}messages/message/{messageId}.html`;
  page.draft = libraryDraft(lib, 'messages/inbox-message');
  page.profileId = 'messages/inbox-message';
  setRequest(flow, step.id, request.id, { list: 'items' });
  setShow(step, {
    type: 'inboxItem', where: { urgency: 'Urgent', status: 'Open' }, label: 'Open urgent referrals', columns: ['client', 'reason', 'respondBy'],
    mark: { row: '#inbox tbody tr', key: 'messageId', rowKey: '@data-message', text: 'Urgent, open' },
  });
  const next = addPage(flow, 'guide');
  next.name = 'Deal with each referral';
  setStepText(next, 'Open each referral from the list. Call the referrer, accept it in your own system, and note the client. Then finish this triage and start a Rent support review for the client: Power Loader works on one case at a time.');
  // The empty form and page a new flow starts with: a triage fills nothing.
  for (const p of [...pagesOf(flow, 'output'), ...pagesOf(flow, 'input').filter((x) => !x.parent)]) removePage(flow, p.id);
  flow.journey = [step.id, next.id];
  return flow;
}

export async function buildDemoFlows({ libraryDir, outDir, from }) {
  const manifest = JSON.parse(await fs.readFile(path.join(libraryDir, 'library.json'), 'utf8'));
  const files = {};
  for (const f of manifest.files) files[f.path] = JSON.parse(await fs.readFile(path.join(libraryDir, f.path), 'utf8'));
  const lib = indexLibrary({ commit: manifest.commit, message: manifest.message, files }, manifest);
  if (lib.problems.length) throw new Error(`Demo library problems: ${JSON.stringify(lib.problems)}`);
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  const written = [];
  for (const spec of DEMO_FLOWS) {
    const flow = makeDemoFlow(lib, spec);
    // Only "not tested here" problems are expected: tests happen on the computer that imports the flow.
    const issues = validateFlow(flow);
    const unexpected = issues.filter((i) => i.level === 'error' && !/hasn’t been tested/.test(i.text) && !(spec.unfinished && expectedUnfinished(i)));
    if (unexpected.length) throw new Error(`${spec.name}: ${unexpected.map((i) => i.text).join('; ')}`);
    const body = exportFlow(flow, issues);
    body.problems = [];
    body.exported = { from, date: new Date().toISOString().slice(0, 10), contentHash: await contentHash(body) };
    const name = flowFileName(flow);
    await fs.writeFile(path.join(outDir, name), `${JSON.stringify(body, null, 2)}\n`);
    written.push(name);
  }
  return written;
}

/**
 * The demo flows as the demo library carries them (flows/…): the same flows as the downloads, exported, with
 * the random page, link and request ids numbered in order, so the files are the same at every build and the
 * manifest's hashes don't change unless a flow does. lib: the library indexed without its flows.
 */
export function libraryFlowFiles(lib) {
  const out = {};
  for (const spec of DEMO_FLOWS) {
    const flow = makeDemoFlow(lib, spec);
    const name = flowFileName(flow);
    flow.id = name.replace(/\.flow\.json$/, '');
    const body = exportFlow(flow, validateFlow(flow));
    // Only "not tested here" problems are expected, and those belong to the computer that opens it.
    body.problems = [];
    const seen = new Map();
    const text = JSON.stringify(body, null, 2).replace(/\b([fplnrt])-[0-9a-f]{8}\b/g, (id, kind) => {
      if (!seen.has(id)) seen.set(id, `${kind}-${String(seen.size + 1).padStart(8, '0')}`);
      return seen.get(id);
    });
    out[`flows/${name}`] = `${text}\n`;
  }
  return out;
}

// An unfinished demo flow's problems: its form isn't made yet, so nothing needs what its pages gather.
const expectedUnfinished = (i) => ['unbound', 'not-gathered'].includes(i.code);

/** A line of instruction for each step of a flow made from the library's forms and pages. */
function plainSteps(flow) {
  for (const p of flow.pages) {
    if (p.step?.text) continue;
    setStepText(p, p.role === 'output'
      ? `Open ${p.name}, fill it from the case, check every box, then submit it yourself.`
      : `Open the client’s ${p.name.toLowerCase()} and clip it.`);
  }
}

/** One demo flow from the indexed library, as the editor would hold it. */
export function makeDemoFlow(lib, spec) {
  if (spec.steps === 'triage') {
    const flow = triage(lib);
    flow.guidance = [
      `1. Team inbox. Go to the Housing Support Team’s inbox at ${demoBase(lib)}messages/index.html and press Fetch: Power Loader reads every message on the page, 4 at a time, and lists the urgent referrals nobody has picked up, marked in the inbox too. This flow fills no form and the case has no reference.`,
      '2. Deal with each referral. Open each one from the list, call the referrer and accept it in your own system. Then finish this triage and start a Rent support review for the client: Power Loader works on one case at a time.',
    ].join('\n');
    return flow;
  }
  const flow = flowFromLibrary(lib, spec.forms);
  flow.name = spec.name;
  // The casework flows write their own step-by-step instructions; the others say where they come from.
  flow.guidance = `A demo flow made from the Power Loader demo library. It fills the ${lib.forms[spec.forms[0]].name} form from the fictional Northshire pages.`;
  const keep = new Set([...spec.pages, ...(spec.steps ? ['messages/message', 'messages/messages-data'] : [])]);
  flow.pages = flow.pages.filter((p) => p.role !== 'input' || keep.has(p.profileId));
  if (spec.steps === 'casework') casework(flow, lib, { fetch: spec.fetch });
  else plainSteps(flow);
  return flow;
}

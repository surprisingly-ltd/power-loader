// The two sequence diagrams on /how-it-works, as specs for tools/sequence-svg.mjs, each with the same steps
// in words for the ordered list under it. Each step's number in `messages` matches its place in `steps`.
// Checked against the code, not the plans: see the comments for where each step lives.
//
// After them, the specs for the other diagrams (tools/diagram-svg.mjs): where data goes, the layers of site
// rules, how a site rule decides, the range from locked down to smart and easy, and what a case is (on the
// home page). Each has a `claim`, the one thing it shows, used as its accessible name and the start of its
// caption. Where a label comes from the code (actions, the approved systems' actions), it is read from it.
import { ACTIONS, CLOSED, HOST_ACTIONS, policyLayer } from '../../extension/lib/access.js';

const code = (s) => `<code>${s}</code>`;
const list = (a) => (a.length > 1 ? `${a.slice(0, -1).join(', ')} and ${a.at(-1)}` : a.join(''));

export const BUILD = {
  id: 'seq-build',
  title: 'Building a flow: it stays on the author’s computer until it is exported, and reaches caseworkers only through the library maintainer’s review and the library’s hash check',
  desc: 'A sequence diagram in six phases. The flow author creates a flow in the sidebar, which keeps it in extension storage on this computer. The in-page agent describes the form to fill. Optionally, a redacted request goes to the organisation’s AI gateway after the author approves a preview. The author picks values on each page to clip, optionally with an AI suggestion through the same preview, and the sidebar tests the profile on the page. The author adds steps and exports one flow file. The library maintainer reviews it and commits it to the forms library, and the extension syncs the library and checks every file’s hash and schema. The numbered list after the diagram gives the same steps in words.',
  participants: [
    { id: 'author', label: 'Flow author' },
    { id: 'sidebar', label: 'Sidebar (extension)' },
    { id: 'agent', label: 'In-page agent' },
    { id: 'page', label: 'Casework page (a test record)' },
    { id: 'file', label: 'Flow file' },
    { id: 'gateway', label: 'Your AI gateway (optional)', optional: true },
    { id: 'maintainer', label: 'Library maintainer' },
    { id: 'git', label: 'Forms library (git)' },
  ],
  boundary: { after: 'file', inside: 'On the author’s computer', outside: 'Elsewhere in your organisation' },
  groups: {
    ai: { kind: 'opt', label: 'if ✦ AI maps the form' },
    'ai-profile': { kind: 'opt', label: 'if ✦ AI suggests the profile' },
  },
  messages: [
    // lib/flows.js newFlow(), stored by lib/core.js updateFlows() in extension storage.
    { phase: 'Start the flow', from: 'author', to: 'sidebar', step: 1, text: 'Create a flow' },
    { from: 'sidebar', to: 'agent', kind: 'note', text: 'Kept in extension storage on this computer' },
    // lib/agent.js describeForm().
    { phase: 'Map the form to fill', from: 'sidebar', to: 'agent', step: 2, text: 'Describe the form to fill' },
    { from: 'agent', to: 'page', text: 'Read its boxes' },
    { from: 'agent', to: 'sidebar', kind: 'return', text: 'Labels, types, options; never what is typed in' },
    // lib/ai/boundary.js previewBeforeSend(); lib/ai/snapshot.js formForPrompt() leaves out what is typed in.
    { from: 'sidebar', to: 'agent', kind: 'note', step: 3, group: 'ai', text: 'Build the request, redact it on this computer, show the preview' },
    { from: 'author', to: 'sidebar', group: 'ai', text: 'Send' },
    { from: 'sidebar', to: 'gateway', group: 'ai', text: 'The approved, redacted request, only after Send' },
    { from: 'gateway', to: 'sidebar', kind: 'return', group: 'ai', text: 'Suggested field mappings' },
    // lib/drafts.js judgeTest(): one match per field, the field's validator, and the leak check.
    { phase: 'Profile the pages to clip', from: 'author', to: 'agent', step: 4, text: 'Pick values on each page to clip' },
    { from: 'agent', to: 'sidebar', kind: 'return', text: 'Selectors, not values' },
    // lib/ai/snapshot.js cleanHtml(): outlined values and anything found on this computer become placeholders.
    { from: 'sidebar', to: 'agent', kind: 'note', group: 'ai-profile', text: 'Reduced page HTML, outlined values replaced by placeholders, in the preview' },
    { from: 'sidebar', to: 'gateway', group: 'ai-profile', text: 'The approved request, only after Send' },
    { from: 'gateway', to: 'sidebar', kind: 'return', group: 'ai-profile', text: 'A suggested profile' },
    { from: 'sidebar', to: 'agent', step: 5, text: 'Test the profile on the page' },
    { from: 'agent', to: 'page', text: 'Find each field' },
    { from: 'sidebar', kind: 'note', to: 'agent', text: 'Each field found once and valid; no page value in the profile' },
    // lib/flows.js validateFlow() on every render of the flow editor.
    { phase: 'Add steps', from: 'author', to: 'sidebar', step: 6, text: 'Add steps, notes, fetch steps, timelines' },
    { from: 'sidebar', to: 'agent', kind: 'note', text: 'Checked on every change' },
    // lib/flows.js exportFlow(): schema powerloader-flow/1.
    { phase: 'Review and publish', from: 'sidebar', to: 'file', step: 7, text: 'Export one powerloader-flow/1 file' },
    { from: 'file', to: 'maintainer', step: 8, text: 'The author shares it for review' },
    { from: 'maintainer', to: 'git', text: 'Commit, with library.json listing each file’s SHA-256' },
    // lib/library-sync.js fetchLibrary(): every hash, then lib/library.js indexLibrary() validates every file.
    { phase: 'Every computer syncs', from: 'sidebar', to: 'git', step: 9, text: 'GET library.json, then each file at that commit' },
    { from: 'git', to: 'sidebar', kind: 'return', text: 'Files; no case data is sent' },
    { from: 'sidebar', to: 'agent', kind: 'note', text: 'Every hash and schema checked. A bad set is refused; the last good one stays' },
  ],
  steps: [
    'The author creates a flow in the sidebar. It is kept in the extension’s storage on this computer, and goes nowhere until the author exports it.',
    'On the form to fill, the in-page agent describes the form’s boxes: their labels, types and options. What is typed in a box is left out of anything sent to AI (<code>formForPrompt()</code> in <code>lib/ai/snapshot.js</code>).',
    '<b>Only if ✦ AI is used:</b> the sidebar builds the request, finds personal data in it on this computer, replaces each finding with a placeholder, and shows the author the preview. Nothing is sent until the author presses Send. The organisation’s gateway returns suggested mappings from boxes to case fields.',
    'On each page to clip, the author picks the values the flow needs. The flow keeps selectors that describe where each value is, not the values. If the author asks ✦ AI to suggest a profile instead, a reduced copy of the page’s HTML goes through the same preview (<code>cleanHtml()</code> in <code>lib/ai/snapshot.js</code>). Every value Power Loader outlines on the page is treated as personal data and replaced by a placeholder, as is anything the library’s patterns or the privacy model find; headings and labels are sent as they are.',
    'The author tests the profile on the page. Each field must be found exactly once and pass its field’s validator, and the leak check confirms that no value read from the page appears in the profile. Test results keep counts, never values.',
    'The author adds steps, notes, fetch steps and timelines. The flow is checked on every change, and problems are listed beside it.',
    'The author exports the flow: one file, schema <code>powerloader-flow/1</code>. Export is refused while the flow contains a value from a page.',
    'The library maintainer reviews the file and commits it to the forms library. The library publishes <code>library.json</code>, which names the commit and lists every file with its SHA-256.',
    'The extension syncs the library: it reads <code>library.json</code>, fetches each file from that commit, and checks every file’s hash and schema. If any file fails, the whole set is refused and the last good copy stays in use.',
  ],
};

export const RUN = {
  id: 'seq-run',
  title: 'Running a flow: the case stays on the caseworker’s computer, and Power Loader itself sends only a fetch step’s GET requests and, after Send, an approved ✦ request',
  desc: 'A sequence diagram in five phases. The caseworker starts a case, which pins the library commit. Before every action on a page the sidebar checks the site rules, and the in-page agent re-checks the page’s address as it acts. Reading a page that is already open sends nothing. Clipped values go into the case in extension storage. Optional fetch steps send GET requests from the caseworker’s tab to the same casework system after the caseworker presses Fetch. Optional screenshots are read with OCR on this computer. Notes are drawn on pages. The fill plan is reviewed, values go into the target form, and the caseworker submits it to the casework system. Optional email steps open the email app. Optional AI requests go to the organisation’s gateway only after the redaction preview and Send. Finish or Discard deletes the case; the activity log is kept without values or real addresses. The numbered list after the diagram gives the same steps in words.',
  participants: [
    { id: 'worker', label: 'Caseworker' },
    { id: 'sidebar', label: 'Sidebar (extension)' },
    { id: 'rules', label: 'Site rules' },
    { id: 'storage', label: 'Extension storage: case and log' },
    { id: 'agent', label: 'In-page agent' },
    { id: 'tabs', label: 'Pages in the caseworker’s tabs' },
    { id: 'systems', label: 'Casework systems (servers)' },
    { id: 'gateway', label: 'Your AI gateway (optional)', optional: true },
  ],
  boundary: { after: 'tabs', inside: 'On the caseworker’s computer', outside: 'Your organisation’s servers' },
  groups: {
    fetch: { kind: 'opt', label: 'if a fetch step' },
    // lib/fetch-steps.js planList(): a list request's addresses come from the page, each checked before any is sent.
    links: { kind: 'loop', label: 'for each link, if it fetches a list of links' },
    scan: { kind: 'opt', label: 'if a screenshot step' },
    email: { kind: 'opt', label: 'if an email step' },
    ai: { kind: 'opt', label: 'if ✦ AI is used' },
  },
  messages: [
    // lib/core.js startFlowCase(); lib/case.js newCase().
    { phase: 'Start', from: 'worker', to: 'sidebar', step: 1, text: 'Start a case from a flow' },
    { from: 'sidebar', to: 'storage', text: 'The case, pinned to the library commit' },
    // lib/core.js ask() → checkAccess(); lib/agent.js compares atUrl with location.href.
    { phase: 'Gather', from: 'sidebar', to: 'rules', step: 2, text: 'May Power Loader read here?' },
    { from: 'rules', to: 'sidebar', kind: 'return', text: 'Allowed, or blocked by a named layer' },
    { from: 'sidebar', to: 'agent', text: 'Read, at this address' },
    { from: 'agent', to: 'tabs', text: 'Read the page with its profile' },
    { from: 'agent', to: 'tabs', kind: 'note', text: 'Refuses if the address has changed. The page is already open: nothing is sent' },
    { from: 'agent', to: 'sidebar', kind: 'return', text: 'Values and their quotes' },
    // lib/case.js addClip(): conflicts and identity.
    { from: 'sidebar', to: 'storage', step: 3, text: 'Add the clip; check conflicts and identity' },
    { from: 'sidebar', to: 'storage', text: 'Log: a count, no values' },
    // lib/fetch-steps.js runFetchStep(); lib/core.js fetchFromTab() runs fetchInPage() in the trigger tab.
    { from: 'worker', to: 'sidebar', step: 4, group: 'fetch', text: 'Press Fetch' },
    { from: 'sidebar', to: 'rules', group: 'fetch', text: 'fetch-get here? Background reading on?' },
    { from: 'sidebar', to: 'tabs', group: 'links', text: 'Read the page’s links (up to 25)' },
    { from: 'sidebar', to: 'rules', group: 'links', text: 'Same site, its page’s pattern, fetch-get?' },
    { from: 'sidebar', to: 'tabs', group: 'fetch', text: 'Fetch as the caseworker’s tab' },
    { from: 'tabs', to: 'systems', group: 'fetch', text: 'GET, same site, no redirects' },
    { from: 'systems', to: 'tabs', kind: 'return', group: 'fetch', text: 'A page or JSON' },
    { from: 'tabs', to: 'sidebar', kind: 'return', group: 'fetch', text: 'The response, its address checked again' },
    { from: 'sidebar', to: 'storage', group: 'fetch', text: 'Clips like any other' },
    // sidebar/tools/reader-ui.js: OCR with the packaged Tesseract.
    { from: 'worker', to: 'sidebar', step: 5, group: 'scan', text: 'A screenshot or picture' },
    { from: 'sidebar', to: 'rules', kind: 'note', group: 'scan', text: 'OCR on this computer' },
    { from: 'worker', to: 'sidebar', group: 'scan', text: 'Check the values, then add them' },
    // sidebar/annotate.js guardNoteLinks(): each link checked as navigate.
    { phase: 'Guide and fill', from: 'sidebar', to: 'rules', step: 6, text: 'annotate here? Each link: navigate?' },
    { from: 'sidebar', to: 'agent', text: 'Draw the notes' },
    { from: 'agent', to: 'tabs', text: 'Notes beside boxes and headings' },
    // sidebar/fill-ui.js: buildFillPlan(), then applyPlan() with the rules read again.
    { from: 'sidebar', to: 'worker', kind: 'return', step: 7, text: 'The fill plan, before anything is filled' },
    { from: 'worker', to: 'sidebar', text: 'Fill' },
    { from: 'sidebar', to: 'rules', text: 'May Power Loader fill here?' },
    { from: 'sidebar', to: 'agent', text: 'Values only, box by box' },
    { from: 'agent', to: 'tabs', text: 'Set the boxes; never submit' },
    { from: 'worker', to: 'tabs', text: 'Check the form, press its submit button' },
    { from: 'tabs', to: 'systems', text: 'The form, sent by the caseworker' },
    // lib/journey.js emailFor(): a mailto: link.
    { phase: 'If the flow or the caseworker uses them', from: 'sidebar', to: 'worker', kind: 'return', step: 8, group: 'email', text: 'A mailto: link for the email app; Power Loader sends nothing' },
    // lib/ai/boundary.js previewBeforeSend(); lib/ai/client.js refuses anything not approved.
    { from: 'sidebar', to: 'storage', kind: 'note', step: 9, group: 'ai', text: 'Build the request, redact it on this computer, show the preview' },
    { from: 'worker', to: 'sidebar', group: 'ai', text: 'Send' },
    { from: 'sidebar', to: 'gateway', group: 'ai', text: 'The approved request, with the gateway key; no cookies' },
    { from: 'gateway', to: 'sidebar', kind: 'return', group: 'ai', text: 'The answer' },
    // lib/teardown.js endCase(); lib/activity.js archiveLog().
    { phase: 'End', from: 'worker', to: 'sidebar', step: 10, text: 'Finish or Discard' },
    { from: 'sidebar', to: 'storage', text: 'Delete the case and its values' },
    { from: 'sidebar', to: 'storage', text: 'Keep the log: no values, no real addresses' },
  ],
  steps: [
    'The caseworker starts a case from a flow, the library’s or one on this computer. The case pins the flow as it was when it started, and keeps using it until it ends, unless the caseworker chooses a changed flow.',
    'Before Power Loader reads, fills, writes notes on or captures a page, the sidebar checks the site rules for that address and that action (<code>ask()</code> in <code>lib/core.js</code>). It sends the address it checked with the message, and the in-page agent refuses if the page’s own address has changed since: a redirect or a script changing the address fails safe.',
    'Clipped values, each with the text it was read from, are added to the case in extension storage. Power Loader compares them with what the case already holds, shows conflicts, and warns when a page seems to be about a different person.',
    '<b>Only if the flow has a fetch step:</b> after the caseworker presses its Fetch button, Power Loader sends GET requests from the tab the caseworker is on, to the same site, without following redirects. Each address is checked against the rules as <code>fetch-get</code>, together with the background-reading switch, before the request and again for the response. A step that fetches every link in a list on the page reads those links first, at most 25, and checks each one before anything is sent: it must be on the same site, be a page its profile reads, and pass the rules. What comes back becomes clips like any other.',
    '<b>Only if the flow has a screenshot step:</b> the picture is read with OCR on this computer. The caseworker checks the values read before they are added.',
    'Notes from the flow are drawn on the page, if the rules allow <code>annotate</code> there. Each link in a note is checked as <code>navigate</code>, and a blocked link is shown as plain text.',
    'Before filling the target form, the sidebar shows the fill plan: every box and the value it would get. Once the caseworker approves, the rules are checked again for <code>fill</code>, and only values go into the boxes. Power Loader never clicks or submits: the caseworker submits the form themselves.',
    '<b>Only if the flow has an email step:</b> Power Loader opens the caseworker’s email app with a <code>mailto:</code> link. It sends nothing itself.',
    '<b>Only if ✦ AI is used:</b> the request goes through the redaction preview, and reaches the organisation’s gateway only after the caseworker presses Send.',
    'When the caseworker finishes or discards the case, the case and its values are deleted. The activity log is kept on this computer, without field values or real page addresses.',
  ],
};

// What leaves the browser: the rows match the table in site/how-it-works.html #leaves.
export const FLOWS = {
  id: 'dg-flows',
  claim: 'What leaves Firefox, what triggers it, and where it goes: nothing goes to Surprisingly Ltd except Firefox’s own update check',
  caption: 'The amber dashed line is the edge of Firefox on this computer, and a dot marks each arrow that crosses it. Each arrow is labelled with what is sent and then, in grey, what triggers it. Extension storage sends nothing by itself. The caseworker’s own page views and form submissions reach the casework systems as they would without Power Loader, and values filled into a page can be read by that page’s scripts. The table below gives the controls for each.',
  boundary: 'Firefox on this computer',
  inside: [
    // lib/core.js fetchFromTab() runs lib/fetch-steps.js fetchInPage() in the caseworker's tab.
    { id: 'tabs', title: 'The caseworker’s tabs', sub: 'the in-page agent; fetch steps run here' },
    // lib/ai/client.js; lib/library-sync.js fetchLibrary(); lib/journey.js emailFor().
    { id: 'sidebar', title: 'Sidebar and extension pages', sub: 'the case, the fill plan, the redaction preview, Settings', rows: 3 },
    // privacy/worker.js and assist/worker.js, through lib/model-fetch.js verifyingFetch().
    { id: 'models', title: 'On-device models', sub: 'privacy model, profile assistant; OCR is packaged' },
    { id: 'storage', title: 'Extension storage', sub: 'case, flows, library copies, settings, log' },
    // extension/manifest.json update_url: Firefox makes this request, not the extension's code.
    { id: 'firefox', title: 'Firefox’s add-on updater', sub: 'Firefox itself, not Power Loader', firefox: true },
  ],
  rows: [
    { from: 'tabs', to: { title: 'Casework systems', sub: 'your organisation’s servers' }, what: 'Fetch steps: GET, same site, no redirects', who: 'after the caseworker presses Fetch' },
    { from: 'sidebar', to: { title: 'Your AI gateway (optional)', sub: 'OpenAI-compatible, your choice', optional: true }, what: 'The request exactly as approved, with the gateway key', who: 'only after Send in the preview' },
    { from: 'sidebar', to: { title: 'Your library host', sub: 'static files at one commit' }, what: 'GET library.json and each file; no case data', who: 'Connect, Sync, or opening the sidebar after an hour' },
    { from: 'sidebar', to: { title: 'Your email app', sub: 'outside Firefox' }, what: 'A mailto: link; Power Loader sends nothing', who: 'the caseworker sends the email' },
    { from: 'models', to: { title: 'Model server', sub: 'Hugging Face by default, or one you set' }, what: 'GET model files at a pinned revision; no case data', who: 'downloading a model; never one switched off' },
    { from: 'storage', what: 'Stays on this computer; the case is deleted when it ends', none: true },
    { from: 'firefox', to: { title: 'This website', sub: 'Surprisingly Ltd, on GitHub Pages' }, what: 'GET /updates.json, and the signed XPI if newer', who: 'Firefox’s update check, about once a day' },
  ],
};

// The layers of site rules: lib/access.js accessLayers(), outermost first.
export const LAYERS = {
  id: 'dg-layers',
  claim: 'Each layer of site rules can only narrow what the layer above it allows, and a deny in any layer refuses',
  caption: `Layers 1 to 3 can hold deny rules, and a deny that matches refuses the action whatever the other layers allow. A layer that has allow rules for an action must have one that matches the address; a layer with none has no opinion. The approved systems are allow rules only, for ${list(HOST_ACTIONS.map(code))}. The table below says who can change each layer.`,
  top: 'Everything Power Loader could do: every address, every action',
  layers: [
    { title: '1. Your organisation’s policy', sub: 'IT, in policies.json siteAccess · locked', deny: true },
    { title: '2. The library’s locked rules', sub: 'the maintainer, in access.json, lock: true', deny: true },
    { title: '3. The caseworker’s rules', sub: 'Settings, with the library’s delegated rules', deny: true },
    { title: '4. The library’s approved systems', sub: `approvedHosts in library.json · ${HOST_ACTIONS.join(', ')}`, deny: false },
  ],
  bottom: 'What Power Loader may do at this address',
  narrows: 'only narrows',
  denyLabel: 'deny',
  refused: '✕ A deny in any layer: refused',
};

// How a site rule decides: lib/access.js allowed(), check by check, in its order. `example` is a decision
// that stops at that check; tests/js/diagram-svg.test.js runs each through allowed().
const [closed] = [...CLOSED];
const council = { id: 'council', effect: 'allow', pattern: 'https://*.council.example*' };
export const DECIDE = {
  id: 'dg-decide',
  claim: 'How a site rule decides: Power Loader acts only if no deny matches and every layer’s allow list for that action does',
  caption: `Drawn from ${code('allowed()')} in ${code('lib/access.js')}, in the order it checks, for every action, every time. A deny that names no actions covers all ${ACTIONS.length} actions, and the background-reading switch, when off, is a deny of ${code('fetch-get')} and ${code('fetch-post')}. An allow rule that names no actions covers every action except ${code(closed)}, which stays closed until an allow rule names it.`,
  start: { title: 'An address and an action', sub: `one of ${ACTIONS.length}, such as read or fill` },
  checks: [
    {
      title: 'Can every policy deny be read?', sub: 'one that can’t would widen', pass: 'yes', fail: 'no',
      refused: { title: '✕ Refused', sub: 'on every page, until IT corrects it' },
      example: { layers: [policyLayer({ deny: ['https://*bad'] })], url: 'https://cases.council.example/', action: 'read' },
    },
    {
      title: 'Does a deny in any layer match?', sub: 'for this action and address', pass: 'no', fail: 'yes',
      refused: { title: '✕ Refused', sub: 'by that deny; its layer is named' },
      example: { layers: [council, { id: 'finance', effect: 'deny', pattern: 'https://finance.council.example*' }], url: 'https://finance.council.example/ledger', action: 'read' },
    },
    {
      title: 'Does each layer’s allow list match?', sub: 'lists for this action; a layer with none has no opinion', pass: 'yes', fail: 'no',
      refused: { title: '✕ Refused', sub: 'not on that layer’s allowed list' },
      example: { layers: [council], url: 'https://elsewhere.example/', action: 'read' },
    },
    {
      title: `If ${closed}: is it allowed by name?`, sub: 'an allow rule must name it; the approved systems can’t', pass: 'yes', fail: 'no',
      refused: { title: '✕ Refused', sub: `${closed} stays closed` },
      example: { layers: [council], url: 'https://cases.council.example/', action: closed },
    },
  ],
  end: { title: '✓ Allowed', sub: 'checked again for the next action' },
  allowedExample: { layers: [council], url: 'https://cases.council.example/', action: 'read' },
};

// From locked down to smart and easy: the rows match the table in site/how-it-works.html #spectrum.
const P = { name: 'Policy', lock: true };
export const RANGE = {
  id: 'dg-range',
  claim: 'Each choice is set on its own, anywhere between locked down and smart and easy, and most can be locked by policy or the library',
  caption: 'Each line is one choice. A filled chip marks who can set it and lock it; an outlined chip marks who can set it while nothing above has locked it. The table below gives the policy keys and library files.',
  ends: ['Locked down', 'Smart and easy'],
  whoTitle: 'Who sets it',
  legend: { lock: 'Sets and locks', sets: 'Sets' },
  rows: [
    { name: 'Remote AI', left: 'None set up', right: 'Your own internal gateway', who: [P, { name: 'Caseworker' }] },
    { name: 'Building flows', left: 'By hand', right: '✦ actions, each through the preview', who: [{ name: 'Author' }] },
    { name: 'The privacy model', left: 'Off with no AI; locked on with AI', right: 'On by default; checks every request', who: [P, { name: 'Library', lock: true }, { name: 'Caseworker' }] },
    { name: 'Redaction', left: 'Groups locked, no pictures', right: 'Send as written, or a picture after a tick', who: [P, { name: 'Library' }, { name: 'Caseworker' }] },
    { name: 'Where Power Loader works', left: 'Strict lists, every rule locked', right: 'The library’s rules, some delegated', who: [P, { name: 'Library', lock: true }, { name: 'Caseworker' }] },
    { name: 'Fetch steps', left: 'Off', right: 'On by default, within the caps', who: [P, { name: 'Library', lock: true }, { name: 'Caseworker' }] },
    { name: 'The profile assistant', left: 'Off', right: 'On by default', who: [P, { name: 'Author' }] },
  ],
  always: 'At both ends: every ✦ request is shown in the redaction preview and sent only on Send, and Power Loader never submits a form',
};

// What a case is, for the home page: friendly, no technical words.
export const CASE = {
  id: 'dg-case',
  claim: 'A case gathers values from the pages you clip, keeps them on your computer, and fills the form for you to check',
  caption: 'Every value remembers the page it came from, and Power Loader shows you where sources disagree. You see what goes in each box before it is filled, and you press submit yourself. The case is deleted when you finish.',
  pages: ['Case system', 'Landlord portal', 'Benefits system'],
  clip: 'Clip each page',
  kept: { zone: 'On your computer', title: 'Your case', sub: 'each value, with where it came from; conflicts shown' },
  fill: 'Fill',
  form: { title: 'The form to fill', sub: 'you check it and submit' },
};

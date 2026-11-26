// The generated parts of site/how-it-works.html, built by tools/build-site.mjs: the two sequence diagrams
// with their steps in words, the sample access.json and policies.json (site/how-it-works/), the worked
// examples of the site rules (each decision worked out by lib/access.js itself), and the table of every
// policy key in lib/policy.js. The build fails if a sample doesn't validate, an example's decision differs
// from the one written beside it, or a policy key has no row, so the page can't drift from the code.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sequenceSvg, escapeXml } from './sequence-svg.mjs';
import { caseSvg, decideSvg, flowsSvg, layersSvg, pairFigure, rangeSvg } from './diagram-svg.mjs';
import { BUILD, CASE, DECIDE, FLOWS, LAYERS, RANGE, RUN } from '../site/how-it-works/diagrams.mjs';
import { ACTIONS, accessLayers, accessOf, allowed, policyLayer, ruleErrors, validateAccess } from '../extension/lib/access.js';
import { POLICY_DEFAULTS } from '../extension/lib/policy.js';

const dir = new URL('../site/how-it-works/', import.meta.url);
export const SAMPLE_ACCESS_FILE = fileURLToPath(new URL('access.json', dir));
export const SAMPLE_POLICY_FILE = fileURLToPath(new URL('policies.json', dir));
const manifest = JSON.parse(fs.readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
export const EXTENSION_ID = manifest.browser_specific_settings.gecko.id;

// ------------------------------------------------------------------ policy keys

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Every leaf key of POLICY_DEFAULTS, dotted, with its default. */
export function policyKeys(defaults = POLICY_DEFAULTS, prefix = '') {
  return Object.entries(defaults).flatMap(([k, v]) => (isObj(v) ? policyKeys(v, `${prefix}${k}.`) : [[`${prefix}${k}`, v]]));
}

// What each key does, from the code that reads it. A key added to lib/policy.js without a row here fails the build.
export const POLICY_KEY_NOTES = {
  'library.baseUrl': 'The forms library’s address (<code>{ref}</code> is replaced by the branch or commit). Set: the caseworker can’t change it.',
  'library.branch': 'The branch to sync.',
  'library.pinCommit': 'Hold everyone on one library commit, for example during an incident. A sync that offers another commit is refused.',
  'library.auth': '<code>none</code>, <code>token</code> (sends <code>library.token</code>) or <code>cookies</code> (sends the browser’s cookies for the library host).',
  'library.token': 'A read token for the library, sent as a bearer token. Only ever from <code>policies.json</code>: a built-in policy file can’t hold it, because anyone with the package can read it.',
  'library.syncMinutes': 'How often the library syncs by itself, in minutes. It also syncs when Firefox starts. Default 60, lowest 15, <code>0</code> for off.',
  'gateway.baseUrl': 'The AI gateway’s address, shown locked in Settings. The caseworker still enters the key and ticks the acknowledgement.',
  'gateway.model': 'The model name sent to the gateway, shown locked in Settings.',
  'gateway.enabled': '<code>false</code> turns the remote AI off and locks it off.',
  'privacyModel.filesUrl': 'The folder the on-device privacy model’s files are downloaded from, on any web server: it holds <code>config.json</code>, <code>tokenizer.json</code>, <code>tokenizer_config.json</code> and <code>onnx/model_q4.onnx</code> with its <code>.onnx_data</code>. Locks the address. Takes precedence over <code>privacyModel.baseUrl</code>.',
  'privacyModel.baseUrl': 'A server in Hugging Face’s layout (<code>{model}/resolve/{revision}/</code>) to download the on-device privacy model from, such as a Hugging Face mirror. Locks the address.',
  'privacyModel.modelId': 'The model to download. Used with <code>privacyModel.revision</code>.',
  'privacyModel.revision': 'Pin another revision of the model. Without it, the revision and hashes built into the extension apply.',
  'privacyModel.hashes': 'The SHA-256 of each model file at that revision. A file with no listed hash is refused.',
  'privacyModel.required': 'On by default: while the privacy model is used, nothing is sent to AI until it’s ready on this computer. Set to <code>true</code> by policy, it also keeps the model on and locks it, unless <code>privacyModel.use</code> is set.',
  'privacyModel.use': 'Use the on-device privacy model at all: <code>true</code> or <code>false</code> sets and locks it. Unset, the library’s <code>privacy.json</code> (<code>use: { on, lock }</code>) or the caseworker decides; it’s on by default. Off, nothing is downloaded or scanned, case values and the library’s patterns are still redacted, and the preview says the model is off.',
  'assistModel.enabled': '<code>false</code> turns the on-device profile assistant off for everyone.',
  'assistModel.filesUrl': 'The folder the profile assistant’s files are downloaded from, on any web server. Needed if the privacy model comes from a folder (<code>privacyModel.filesUrl</code>) and huggingface.co is blocked.',
  'assistModel.baseUrl': 'A server in Hugging Face’s layout to download the profile assistant from. By default it follows the privacy model’s server, when that’s in Hugging Face’s layout.',
  'assistModel.modelId': 'Pin another assistant model. Used with <code>assistModel.revision</code>.',
  'assistModel.revision': 'Pin another revision of the assistant model.',
  'assistModel.dtype': 'The assistant model’s weight format.',
  'assistModel.hashes': 'The SHA-256 of each assistant model file.',
  'assistModel.promptSuffix': 'Text added to the assistant’s prompt, for another model.',
  'assistModel.prefill': 'Whether the assistant’s answer is started for it.',
  'redaction.maxThreshold': 'The highest detection threshold the caseworker may choose. A lower threshold redacts more.',
  'redaction.lockedGroups': 'Groups of personal data that are always redacted: <code>names</code>, <code>dob</code>, <code>ids</code>, <code>contact</code>, <code>address</code>, <code>dates</code>.',
  'redaction.allowSendAsWritten': '<code>false</code>: the caseworker can’t untick a redaction in the preview.',
  'redaction.format': '<code>off</code>: placeholders don’t carry the shape of the value they replace.',
  'redaction.blockImages': '<code>true</code>: pictures can never be sent to AI.',
  'activityLog.retentionDays': 'How long kept logs stay on the computer. Default 90 days.',
  'activityLog.coarseTimestamps': 'Round kept and exported timestamps to the minute.',
  'activityLog.notes': '<code>false</code>: the caseworker’s notes can’t be included in an exported log.',
  'workstation.idleConfirmMinutes': 'A case left with nothing done for this long asks the caseworker to confirm it is still theirs. Default 120.',
  'workstation.clearCaseOnClose': 'The open case is deleted when Firefox closes, with a warning before and a receipt after. On by default. Unset, the caseworker can turn it off in Settings; set either way, it is locked.',
  'workstation.clearCaseAfterHours': 'The open case is deleted after this many hours without use: nothing done in it, nothing logged. In half hours, lowest 0.5; <code>0</code> for never; default 24. Most organisations will want no more than 9 hours, and many will want less. It goes the way Discard does, with a receipt of counts only, and shortly before (an hour, or a sixth of a short time) the sidebar says so, with a way to keep working. Set: fixed and locked. Unset: the caseworker chooses it in Settings.',
  'workstation.clearCaseMaxHours': 'Instead of fixing the time, the most the caseworker may choose, as <code>redaction.maxThreshold</code> caps the threshold. With it set, never and anything longer are refused, and Settings says what the limit is. A fixed <code>clearCaseAfterHours</code> wins over it.',
  'siteAccess.allow': 'Addresses Power Loader may work on. The organisation’s allow list.',
  'siteAccess.deny': 'Addresses Power Loader may never work on. One that can’t be read stops Power Loader working anywhere until it is corrected.',
  'siteAccess.rules': 'Full rules, with actions: <code>{ id, effect, pattern, actions?, note? }</code>.',
  'siteAccess.lockLibraryRules': '<code>true</code>: every rule in the library’s <code>access.json</code> is locked, whatever the file says.',
  'siteAccess.backgroundReading': '<code>true</code> or <code>false</code> sets the background-reading switch and locks it.',
  'tools.capture': '⬚ Select a region of the screen: a box drawn on the tab is captured and read. <code>true</code> or <code>false</code> sets and locks it; unset, it is on and the caseworker can turn it off in Settings. The site rules’ <code>capture</code> action still decides which pages. Off in a built-in policy file, the build leaves out the permission capture needs.',
  'tools.reader': 'The reader: PDFs, pictures and pasted screenshots read on this computer (PDF text and OCR), in the Tools tab and a flow’s scan steps. Off, nothing is read, and region capture has nothing to read into. Set: locked; unset: on, the caseworker’s to turn off.',
  'tools.calculator': 'The calculator in the Tools tab and the case page. Set: locked; unset: on, the caseworker’s to turn off.',
  'tools.timeline': 'The timeline in the Tools tab and the case page. Set: locked; unset: on, the caseworker’s to turn off.',
  'tools.notes': 'A flow’s notes and markers drawn onto its pages. Off, flows still keep their notes; they just aren’t drawn. Set: locked; unset: on, the caseworker’s to turn off. The other tools with their own switch are <code>gateway.enabled</code>, <code>siteAccess.backgroundReading</code>, <code>assistModel.enabled</code> and <code>privacyModel.use</code>.',
  allowed: 'Only in a built-in policy file. Constrains a setting by pattern instead of fixing it: <code>{ "library.baseUrl": ["https://gitlab.example.gov.uk/casework/*"] }</code>. Takes <code>gateway.baseUrl</code>, <code>gateway.model</code> (names, <code>*</code> a wildcard), <code>library.baseUrl</code> and the <code>filesUrl</code> and <code>baseUrl</code> of <code>privacyModel</code> and <code>assistModel</code>. Each request is checked when it is sent.',
};

const show = (v) => (v === null ? '<i>none</i>' : `<code>${escapeXml(JSON.stringify(v))}</code>`);

export function policyKeysTable() {
  const keys = policyKeys();
  const missing = keys.filter(([k]) => !POLICY_KEY_NOTES[k]).map(([k]) => k);
  if (missing.length) throw new Error(`site/how-it-works: no row for policy key ${missing.join(', ')} (tools/how-it-works.mjs POLICY_KEY_NOTES)`);
  const extra = Object.keys(POLICY_KEY_NOTES).filter((k) => !keys.some(([key]) => key === k));
  if (extra.length) throw new Error(`site/how-it-works: ${extra.join(', ')} isn’t a policy key in extension/lib/policy.js`);
  return ['<table class="keys">', '<thead><tr><th scope="col">Key</th><th scope="col">Default</th><th scope="col">What it does</th></tr></thead>', '<tbody>',
    ...keys.map(([k, v]) => `<tr><td><code>${k}</code></td><td>${show(v)}</td><td>${POLICY_KEY_NOTES[k]}</td></tr>`),
    '</tbody>', '</table>'].join('\n');
}

// ------------------------------------------------------------------ samples

/** The sample access.json, read and checked by the library's own validator. */
export function sampleAccess() {
  const doc = JSON.parse(fs.readFileSync(SAMPLE_ACCESS_FILE, 'utf8'));
  const errors = validateAccess(doc);
  if (errors.length) throw new Error(`site/how-it-works/access.json: ${errors.join('; ')}`);
  return doc;
}

/**
 * The sample policies.json, checked the way Power Loader reads it: under this extension's ID, every key one
 * that lib/policy.js knows (it ignores any other), and site rules that read.
 */
export function samplePolicy() {
  const doc = JSON.parse(fs.readFileSync(SAMPLE_POLICY_FILE, 'utf8'));
  const ext = doc?.policies?.['3rdparty']?.Extensions?.[EXTENSION_ID];
  if (!isObj(ext)) throw new Error(`site/how-it-works/policies.json: no settings under 3rdparty → Extensions → ${EXTENSION_ID}`);
  const problems = [];
  const walk = (given, defaults, prefix) => {
    for (const [k, v] of Object.entries(given)) {
      const path = `${prefix}${k}`;
      if (!(k in defaults)) { problems.push(`${path} isn’t a policy key`); continue; }
      const d = defaults[k];
      if (isObj(d)) { if (isObj(v)) walk(v, d, `${path}.`); else problems.push(`${path} must be an object`); continue; }
      const type = (x) => (Array.isArray(x) ? 'array' : typeof x);
      if (d !== null && type(v) !== type(d)) problems.push(`${path} must be ${type(d)}`);
    }
  };
  walk(ext, POLICY_DEFAULTS, '');
  const layer = policyLayer(ext.siteAccess || {});
  if (layer.broken) problems.push(`siteAccess: ${layer.broken} can’t be read`);
  for (const r of layer.rules) if (ruleErrors(r).length) problems.push(`siteAccess: ${r.pattern}: ${ruleErrors(r)[0]}`);
  if (problems.length) throw new Error(`site/how-it-works/policies.json: ${problems.join('; ')}`);
  return { doc, settings: ext };
}

// ------------------------------------------------------------------ worked examples

// Two rules in one layer, as in docs/plans/site-access-lists.md. `ok` is what the page says; the build checks it.
export const EXAMPLE_RULES = [
  { id: 'council', effect: 'allow', pattern: 'https://*.council.example*' },
  { id: 'finance', effect: 'deny', pattern: 'https://finance.council.example*' },
];
export const EXAMPLE_ROWS = [
  { url: 'https://cases.council.example/client/1042', ok: true, why: 'Matches the allow rule. No deny matches.' },
  { url: 'https://council.example/benefits/apply', ok: true, why: '<code>*.council.example</code> covers the domain itself as well as its subdomains.' },
  { url: 'https://cases.council.example:8443/client/1042', ok: true, why: 'A pattern ending in <code>*</code> after the host covers any port and any page.' },
  { url: 'https://finance.council.example/ledger', ok: false, why: 'The deny rule matches. A deny wins over any allow.' },
  { url: 'http://finance.council.example/ledger', ok: false, why: 'A deny written with <code>https://</code> also covers <code>http://</code>.' },
  { url: 'https://pay.finance.council.example/', ok: true, why: 'The deny names only <code>finance.council.example</code>. To block its subdomains too, write <code>https://*.finance.council.example*</code>.' },
  { url: 'http://cases.council.example/client/1042', ok: false, why: 'The allow rule says <code>https://</code>, so a plain <code>http://</code> page matches no allow rule.' },
  { url: 'https://council.example.attacker.example/', ok: false, why: 'Hosts are compared whole, so this is not a council address.' },
];

// The sample access.json as the library layer, with policy setting nothing: actions matter.
export const SCOPED_ROWS = [
  { url: 'https://messages.council.example/message/7', action: 'fetch-get', ok: true, why: 'The locked allow rule for <code>fetch-get</code> matches.' },
  { url: 'https://cases.council.example/client/1042', action: 'fetch-get', ok: false, why: 'The library has allow rules for <code>fetch-get</code>, and none matches this address.' },
  { url: 'https://cases.council.example/client/1042', action: 'read', ok: true, why: 'The library has no allow rule for <code>read</code>, so it doesn’t narrow reading. Nothing denies it.' },
  { url: 'https://finance.council.example/ledger', action: 'read', ok: false, why: 'The locked deny rule, with no actions, covers every action.' },
  { url: 'https://cases.council.example/archive/2019/4471', action: 'fill', ok: false, why: 'The delegated deny rule. The caseworker may turn it off in Settings.' },
  { url: 'https://cases.council.example/archive/2019/4471', action: 'read', ok: true, why: 'That rule names only <code>fill</code> and <code>annotate</code>.' },
  { url: 'https://messages.council.example/message/7', action: 'fetch-post', ok: false, why: '<code>fetch-post</code> is closed: only an allow rule that names it opens it.' },
];

export function scopedLayers(doc = sampleAccess()) {
  return accessLayers({ policy: { values: { siteAccess: {} } }, settings: {}, currentLib: { commit: 'sample', access: accessOf(doc) } });
}

function checked(rows, decide, name) {
  for (const r of rows) {
    const got = decide(r);
    if (got.ok !== r.ok) throw new Error(`site/how-it-works ${name}: ${r.url}${r.action ? ` (${r.action})` : ''} is ${got.ok ? 'allowed' : 'blocked'} by lib/access.js, but the page says ${r.ok ? 'allowed' : 'blocked'}`);
  }
  return rows;
}

const verdict = (ok) => (ok ? '<span class="yes">✓ Allowed</span>' : '<span class="no">✕ Blocked</span>');

export function exampleTable() {
  const rows = checked(EXAMPLE_ROWS, (r) => allowed(EXAMPLE_RULES, r.url, 'read'), 'example');
  return ['<table>', '<thead><tr><th scope="col">Address</th><th scope="col">Power Loader</th><th scope="col">Why</th></tr></thead>', '<tbody>',
    ...rows.map((r) => `<tr><td><code>${escapeXml(r.url)}</code></td><td>${verdict(r.ok)}</td><td>${r.why}</td></tr>`),
    '</tbody>', '</table>'].join('\n');
}

export function scopedTable() {
  const layers = scopedLayers();
  const rows = checked(SCOPED_ROWS, (r) => allowed(layers, r.url, r.action), 'action-scoped example');
  return ['<table>', '<thead><tr><th scope="col">Address</th><th scope="col">Action</th><th scope="col">Power Loader</th><th scope="col">Why</th></tr></thead>', '<tbody>',
    ...rows.map((r) => `<tr><td><code>${escapeXml(r.url)}</code></td><td><code>${r.action}</code></td><td>${verdict(r.ok)}</td><td>${r.why}</td></tr>`),
    '</tbody>', '</table>'].join('\n');
}

// ------------------------------------------------------------------ diagrams

const figure = (spec) => `<figure class="diagram" id="${spec.id}" aria-labelledby="${spec.id}-caption">\n<div class="diagram-scroll" tabindex="0" role="group" aria-label="${escapeXml(spec.title)}: diagram, scrolls sideways">\n${sequenceSvg(spec)}\n</div>\n<figcaption id="${spec.id}-caption"><b>${escapeXml(spec.title)}.</b> Solid arrows are requests and dashed arrows answers. A box with a folded corner is work done inside one part. A dashed frame marked <b>optional</b> happens only in the case named, and a dashed part is optional too. The amber dashed line is the edge of this computer, and a dot marks each arrow that crosses it. The steps are numbered as in the list below.</figcaption>\n</figure>`;

function stepList(spec) {
  const numbered = spec.messages.filter((m) => m.step != null).map((m) => m.step);
  const want = spec.steps.map((_, i) => i + 1);
  if (JSON.stringify(numbered) !== JSON.stringify(want)) throw new Error(`site/how-it-works/diagrams.mjs ${spec.id}: steps numbered ${numbered.join(',')}, but ${spec.steps.length} steps are listed`);
  return `<ol class="seq-steps">\n${spec.steps.map((s) => `<li>${s}</li>`).join('\n')}\n</ol>`;
}

const pretty = (doc) => escapeXml(JSON.stringify(doc, null, 2));

/** The placeholders site/how-it-works.html uses. */
export function howItWorksValues() {
  const access = sampleAccess();
  const { doc: policy } = samplePolicy();
  return {
    HIW_BUILD_DIAGRAM: figure(BUILD),
    HIW_BUILD_STEPS: stepList(BUILD),
    HIW_RUN_DIAGRAM: figure(RUN),
    HIW_RUN_STEPS: stepList(RUN),
    HIW_FLOWS_DIAGRAM: pairFigure(FLOWS, flowsSvg),
    HIW_LAYERS_DIAGRAM: pairFigure(LAYERS, layersSvg),
    HIW_DECIDE_DIAGRAM: pairFigure(DECIDE, decideSvg),
    HIW_RANGE_DIAGRAM: pairFigure(RANGE, rangeSvg),
    HIW_EXAMPLE: exampleTable(),
    HIW_SCOPED: scopedTable(),
    HIW_SAMPLE_ACCESS: pretty(access),
    HIW_SAMPLE_POLICY: pretty(policy),
    HIW_POLICY_KEYS: policyKeysTable(),
    HIW_ACTIONS: ACTIONS.map((a) => `<code>${a}</code>`).join(', '),
  };
}

/** The placeholders the home page uses: what a case is. */
export function homeValues() {
  return { HOME_CASE_DIAGRAM: pairFigure(CASE, caseSvg) };
}

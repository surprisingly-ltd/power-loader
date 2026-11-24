// Fill a saved form page with a library fill profile and sample values, using the extension's own agent,
// and report what was filled, what failed, and side effects: changes the page made outside the filled
// boxes, submits and navigation. List any side effects in the form's library entry ("sideEffects").
// node tests/tools/fill-check.mjs <page.html> <url> <fill-profile.json> <sample.json: { caseField: value }>
import { JSDOM } from 'jsdom';
import fs from 'node:fs';

const [,, htmlPath, url, profilePath, samplePath] = process.argv;
if (!samplePath) { process.stderr.write('Usage: node tests/tools/fill-check.mjs <page.html> <url> <fill-profile.json> <sample.json>\n'); process.exit(2); }
const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
const sample = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
const dom = new JSDOM(fs.readFileSync(htmlPath, 'utf8'), { url, runScripts: 'dangerously' });
const w = dom.window;
let listener;
w.browser = { runtime: { onMessage: { addListener: (f) => (listener = f) } } };
for (const f of ['extract.js', 'capture.js', 'agent.js']) w.eval(fs.readFileSync(`extension/lib/${f}`, 'utf8'));
const doc = w.document;
const items = Object.entries(profile.fields || {}).map(([target, path]) => ({ target, value: sample[String(path).replace(/^CaseData\./, '')] })).filter((i) => i.value != null);
const boxes = new Set(items.flatMap((i) => [...doc.querySelectorAll(i.target)]));
const effects = [];
new w.MutationObserver((list) => {
  for (const m of list) {
    const node = m.target.nodeType === 1 ? m.target : m.target.parentElement;
    if (![...boxes].some((b) => b === node || b.contains(node))) effects.push(`${m.type} in <${node?.localName}${node?.id ? `#${node.id}` : ''}>`);
  }
}).observe(doc.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden', 'disabled', 'value'] });
doc.addEventListener('submit', (e) => { effects.push('form submitted'); e.preventDefault(); }, true);
doc.addEventListener('click', () => effects.push('click'), true);
const report = await listener({ type: 'powerloader:fill', url, plan: { items } });
await new Promise((r) => setTimeout(r, 50));
console.log(JSON.stringify({ filled: report.filled.length, failed: report.failed, sideEffects: [...new Set(effects)] }, null, 2));

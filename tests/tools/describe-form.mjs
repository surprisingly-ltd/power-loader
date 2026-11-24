// Print the extension agent's describeForm() output for a saved page. RUN_SCRIPTS=1 runs the page's own scripts (e.g. ones that add table rows).
// node tests/tools/describe-form.mjs <file.html> <url>
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
const [,, htmlPath, url] = process.argv;
const dom = new JSDOM(fs.readFileSync(htmlPath, 'utf8'), { url, runScripts: process.env.RUN_SCRIPTS ? 'dangerously' : 'outside-only' });
let listener;
dom.window.browser = { runtime: { onMessage: { addListener: (f) => (listener = f) } } };
dom.window.eval(fs.readFileSync('extension/lib/extract.js', 'utf8'));
dom.window.eval(fs.readFileSync('extension/lib/agent.js', 'utf8'));
console.log(JSON.stringify(await listener({ type: 'powerloader:describeForm' }), null, 1));

// The in-page agent loaded into a demo page in jsdom, driven by the same messages the extension sends.
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const ext = (f) => readFileSync(new URL(`../../../extension/lib/${f}`, import.meta.url), 'utf8');

export function agentOn(page, { scripts = false } = {}) {
  return agentOnDom(new JSDOM(readFileSync(new URL(`../../../demo/${page}`, import.meta.url), 'utf8'), { url: `http://localhost:8787/demo/${page}`, runScripts: scripts ? 'dangerously' : 'outside-only' }));
}

// The agent in any page: new JSDOM(html, { url, runScripts: 'outside-only' }).
export function agentOnDom(dom) {
  const w = dom.window;
  w.HTMLElement.prototype.getClientRects = function () { return [1]; };
  let listener;
  const sent = [];
  w.browser = { runtime: { onMessage: { addListener: (fn) => { listener = fn; } }, sendMessage: async (m) => { sent.push(m); } } };
  for (const f of ['extract.js', 'capture.js', 'agent.js']) w.eval(ext(f));
  // Results are plain JSON, as they would be after runtime messaging.
  return { w, doc: w.document, ask: async (msg) => JSON.parse(JSON.stringify(await listener(msg)) ?? 'null'), sent };
}

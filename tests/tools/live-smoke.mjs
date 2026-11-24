// Opt-in, billable: one ✦ Suggest a profile request to the organisation's LiteLLM gateway, through the same
// redaction boundary and client the extension uses. Needs POWERLOADER_RUN_LIVE=1, POWERLOADER_LIVE_BASE_URL (the
// gateway's /v1 address) and POWERLOADER_LIVE_API_KEY (a dedicated virtual key). The key is never printed.
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import '../../extension/lib/extract.js';
import { runTask } from '../../extension/lib/ai/tasks.js';
import { registerPresenter } from '../../extension/lib/ai/boundary.js';
import { effectiveSettings, knownValues, patternsFor } from '../../extension/lib/privacy-detect.js';
import { demoLibrary } from '../js/helpers/library.js';

if (process.env.POWERLOADER_RUN_LIVE !== '1') { console.log('Skipped: set POWERLOADER_RUN_LIVE=1 to make one billable request.'); process.exit(0); }
const config = { baseUrl: process.env.POWERLOADER_LIVE_BASE_URL, model: process.env.POWERLOADER_LIVE_MODEL || 'deepseek/deepseek-v4-flash', auth: 'bearer', apiKey: process.env.POWERLOADER_LIVE_API_KEY };
if (!config.baseUrl || !config.apiKey) { console.error('Set POWERLOADER_LIVE_BASE_URL and POWERLOADER_LIVE_API_KEY'); process.exit(2); }
globalThis.browser = { runtime: { getURL: (p) => new URL(`../../extension/${p}`, import.meta.url).href } };
const realFetch = globalThis.fetch;
globalThis.fetch = (u, init) => (String(u).startsWith('file:') ? Promise.resolve(new Response(fs.readFileSync(new URL(u)))) : realFetch(u, init));
const lib = demoLibrary();
let sentChars = 0;
registerPresenter(async (state, { review }) => { const r = review(state); sentChars = r.chars; console.log(`Preview: ${r.counts.redacted} values redacted, ${r.chars} characters`); return true; });
const html = fs.readFileSync(new URL('../../demo/client-1042.html', import.meta.url), 'utf8');
const context = { known: knownValues(null, lib), patterns: patternsFor(lib), settings: effectiveSettings(), identifierTypes: lib.identifierTypes, model: { ready: false, required: false } };
const out = await runTask('profile', { html, url: 'http://localhost:8787/demo/client-1042.html', title: 'Client record', document: new JSDOM('').window.document }, { lib, context, config });
console.log(JSON.stringify({ model: config.model, sentChars, fields: out.fields, dropped: out.dropped, sample: out.sample, problems: out.problems.length }, null, 2));

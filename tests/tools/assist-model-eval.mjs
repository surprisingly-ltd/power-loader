// Opt-in and slow: the profile assistant's model on CPU (onnxruntime-node), through the same prompt, answer
// pre-fill and merge the extension uses. Downloads the pinned model (or POWERLOADER_ASSIST_MODEL / _REVISION)
// from Hugging Face into ~/.cache/power-loader-assist the first time. Reports, for the demo pages, whether the
// model changes the rules' matches, and for labels the rules don't know, how many fields it gets right.
//   node tests/tools/assist-model-eval.mjs
import os from 'node:os';
import path from 'node:path';
import { env, pipeline } from '@huggingface/transformers';
import { agentOn } from '../js/helpers/agent.js';
import { demoLibrary } from '../js/helpers/library.js';
import * as A from '../../extension/lib/assist.js';
import * as P from '../../extension/lib/privacy-detect.js';
import { refineWithModel } from '../../extension/lib/assist-client.js';
import { DEFAULT_ASSIST_MODEL as M } from '../../extension/lib/model-fetch.js';

env.cacheDir = path.join(os.homedir(), '.cache', 'power-loader-assist');
const modelId = process.env.POWERLOADER_ASSIST_MODEL || M.modelId;
const revision = process.env.POWERLOADER_ASSIST_REVISION || (modelId === M.modelId ? M.revision : 'main');
const gen = await pipeline('text-generation', modelId, { dtype: 'q4', revision });
// The worker's generate(), with the answer started for the model.
const run = async (messages, n) => {
  const prompt = gen.tokenizer.apply_chat_template(messages, { tokenize: false, add_generation_prompt: true }) + 'The field is "';
  const o = await gen(prompt, { max_new_tokens: n, do_sample: false, return_full_text: false });
  return String(o[0].generated_text).split('"')[0].trim();
};
const lib = demoLibrary();
const fields = A.targetFields(lib, Object.keys(lib.forms));
console.log(`${modelId}@${revision}`);
for (const page of ['client-1042.html', 'rent-account-1042.html', 'employment-1042.html']) {
  const a = agentOn(page);
  const { candidates } = await a.ask({ type: 'powerloader:pickStart', selected: [] });
  const { text, at } = A.joinValues(candidates);
  const cands = A.categorise(candidates, P.detect(text, { patterns: P.patternsFor(lib) }), at);
  const rule = A.matchFields(cands, fields);
  const out = await refineWithModel(rule, cands, fields, run, { suffix: M.promptSuffix });
  const kept = rule.matches.every((m) => out.matches.some((x) => x.key === m.key && x.selector === m.selector));
  const added = out.matches.filter((x) => !rule.matches.some((r) => r.key === x.key && r.selector === x.selector));
  console.log(`${page}: rules ${rule.matches.length}, kept all: ${kept}, model agreed ${out.agreed}, added ${added.map((m) => `${m.key}←${m.selector}`).join(', ') || 'nothing'}`);
}
// Labels the rules don't know.
const items = [
  ['Owner', 'Harbour Homes Ltd', 'landlord'], ['Weekly pay', '£312.40', 'weeklyIncome'], ['Employer name', 'Royal Mail Group', 'currentEmployer'],
  ['Rent per month', '£725.00', 'monthlyRent'], ['Amount owed', '£1,245.60', 'arrears'], ['Moved in', '01/06/2021', 'tenancyStart'],
  ['Benefits', 'Universal Credit since 2023', 'ucClaim'], ['Spoken language', 'Polish', 'language'], ['Contact by', 'Email', 'contactPref'],
  ['Customer number', 'NC-1042', 'clientId'], ['Home', 'Flat 3, 12 Mill Lane, Northtown', 'address'], ['Last login', '12/03/2026', null],
  ['Worker', 'A. Worker', null], ['Case type', 'Homelessness prevention', null], ['Status', 'Active', null], ['Honorific', 'Ms', 'title'],
].map(([label, value, want], i) => ({ id: `c${i}`, selector: `#i${i}`, label, value, want }));
const rule = A.matchFields(items, fields);
const out = await refineWithModel(rule, items, fields, run, { suffix: M.promptSuffix });
const score = (ms) => [ms.filter((m) => items.find((c) => c.id === m.id).want === m.key).length, ms.filter((m) => items.find((c) => c.id === m.id).want !== m.key).length];
const [r1, w1] = score(rule.matches);
const [r2, w2] = score(out.matches);
console.log(`unfamiliar labels (${items.filter((c) => c.want).length} with a field): rules ${r1} right ${w1} wrong; with the model ${r2} right ${w2} wrong`);

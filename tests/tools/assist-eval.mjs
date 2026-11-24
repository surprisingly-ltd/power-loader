// Scores the profile assistant's rules against the demo library's own profiles: for each demo page with a
// library profile, the values Power Loader would match for its target fields, compared with what the library
// profile reads. Used by tests/js/assist.test.js, and runnable on its own to see the details:
//   node tests/tools/assist-eval.mjs
import { pathToFileURL } from 'node:url';
import { agentOn } from '../js/helpers/agent.js';
import { demoLibrary } from '../js/helpers/library.js';
import { boxCandidates, categorise, joinValues, matchFields, targetFields } from '../../extension/lib/assist.js';
import { detect, patternsFor } from '../../extension/lib/privacy-detect.js';
import { editPicks, newPageDraft } from '../../extension/lib/drafts.js';

const PAGES = [
  ['client-1042.html', 'cm/client-record'],
  ['rent-account-1042.html', 'harbour-homes/rent-account'],
  ['employment-1042.html', 'biv/employment'],
];
const FORMS = [['dhp.html', 'dhp'], ['referral.html', 'hsr']];

const norm = (v) => (v == null ? null : String(v).replace(/\s+/g, ' ').trim());

export async function evalPage(page, profileId, lib = demoLibrary()) {
  const a = agentOn(page);
  const E = a.w.PowerLoaderExtract;
  const { candidates } = await a.ask({ type: 'powerloader:pickStart', selected: [] });
  const { text, at } = joinValues(candidates);
  const cands = categorise(candidates, detect(text, { patterns: patternsFor(lib) }), at);
  const fields = targetFields(lib, Object.keys(lib.forms));
  const { matches } = matchFields(cands, fields);
  const d = newPageDraft({ url: a.w.location.href, title: a.doc.title });
  editPicks(d, (ps) => ps.push(...matches.map((m) => ({ key: m.key, selector: m.selector, part: m.part, filter: m.filter }))));
  // Only what the target forms need: the library profile may read more.
  const need = new Set(fields.map((f) => f.key));
  const want = Object.fromEntries(Object.entries(lib.profiles.find((p) => p.id === profileId).fields).filter(([k, s]) => typeof s === 'string' && need.has(k)));
  const read = (spec) => norm(E.probe(a.doc, spec, { baseUrl: a.w.location.href }).value);
  const rows = [];
  for (const [key, spec] of Object.entries(want)) {
    const got = d.profile.fields[key];
    const expected = read(spec);
    const value = got ? read(got) : null;
    rows.push({ key, ok: value != null && value === expected, missing: !got, expected, value, spec: got });
  }
  // Fields matched that the library profile doesn't read (wrong, or the library simply doesn't take them).
  const extra = Object.keys(d.profile.fields).filter((k) => !(k in want));
  return { page, rows, extra, correct: rows.filter((r) => r.ok).length, total: rows.length, wrong: rows.filter((r) => !r.ok && !r.missing).length };
}

export async function evalForm(page, formId, lib = demoLibrary()) {
  const a = agentOn(page);
  const form = await a.ask({ type: 'powerloader:describeForm' });
  const fields = targetFields(lib, [formId], { manual: true });
  const { matches } = matchFields(boxCandidates(form), fields);
  const want = lib.fill.find((p) => p.form?.id === formId || p.id === lib.forms[formId].fill).fields;
  const got = Object.fromEntries(matches.map((m) => [m.selector, `CaseData.${m.key}`]));
  const rows = Object.entries(want).map(([box, path]) => ({ key: box, ok: got[box] === path, missing: !got[box], expected: path, value: got[box] || null }));
  return { page, rows, extra: Object.keys(got).filter((b) => !(b in want)), correct: rows.filter((r) => r.ok).length, total: rows.length, wrong: rows.filter((r) => !r.ok && !r.missing).length };
}

export async function evalAll() {
  const lib = demoLibrary();
  return [...await Promise.all(PAGES.map(([p, id]) => evalPage(p, id, lib))), ...await Promise.all(FORMS.map(([p, id]) => evalForm(p, id, lib)))];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const r of await evalAll()) {
    console.log(`\n${r.page}: ${r.correct}/${r.total} correct, ${r.wrong} wrong${r.extra.length ? `, extra: ${r.extra.join(', ')}` : ''}`);
    for (const x of r.rows.filter((y) => !y.ok)) console.log(`  ✕ ${x.key}: expected ${JSON.stringify(x.expected)}, got ${JSON.stringify(x.value)} ${x.spec ? `(${x.spec})` : '(missing)'}`);
  }
}

// Runs web-ext lint (self-hosted: the manifest has an update_url) and fails on any error, and on any warning
// or notice not in tools/lint-baseline.json. The baseline holds the known warnings in vendored third-party
// files (eval-like code in pdf.js, tesseract.js and ONNX Runtime). Our own code must lint clean, except for
// findings the baseline explains with a `reason`.
// --update rewrites the baseline from the current result (review the diff).
// --source-dir <dir> lints another unpacked package against the same baseline (an organisation build).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const baselineFile = fileURLToPath(new URL('lint-baseline.json', import.meta.url));
const at = process.argv.indexOf('--source-dir');
const sourceDir = at >= 0 ? process.argv[at + 1] : 'extension';
let raw;
try {
  raw = execFileSync(process.execPath, ['node_modules/web-ext/bin/web-ext.js', 'lint', '--self-hosted', '--source-dir', sourceDir, '--output', 'json'], { cwd: root, encoding: 'utf8', maxBuffer: 64e6 });
} catch (e) { raw = e.stdout } // web-ext exits non-zero when there are errors
const result = JSON.parse(raw.slice(raw.indexOf('{')));
const found = [...result.warnings, ...result.notices].map((w) => `${w.code} ${w.file}`);
const count = (list) => list.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map());
if (process.argv.includes('--update')) {
  const reasons = new Map(JSON.parse(await fs.readFile(baselineFile, 'utf8').catch(() => '[]')).filter((b) => b.reason).map((b) => [b.finding, b.reason]));
  await fs.writeFile(baselineFile, `${JSON.stringify([...count(found)].sort().map(([k, n]) => ({ finding: k, count: n, ...(reasons.has(k) ? { reason: reasons.get(k) } : {}) })), null, 2)}\n`);
  console.log(`tools/lint-baseline.json: ${found.length} findings`);
  process.exit(0);
}
const baseline = JSON.parse(await fs.readFile(baselineFile, 'utf8'));
const allowed = new Map(baseline.map((b) => [b.finding, b.count]));
// A finding in our own code is accepted only with a written reason in the baseline.
const explained = new Set(baseline.filter((b) => b.reason).map((b) => b.finding));
const problems = result.errors.map((e) => `error ${e.code} ${e.file ?? ''}: ${e.message}`);
for (const [k, n] of count(found)) {
  if (n > (allowed.get(k) ?? 0)) problems.push(`new: ${k} (${n}, baseline ${allowed.get(k) ?? 0})`);
  if (!k.split(' ')[1]?.startsWith('vendor/') && !explained.has(k)) problems.push(`own code must lint clean (or have a reason in the baseline): ${k}`);
}
if (problems.length) { console.error([...new Set(problems)].join('\n')); process.exit(1) }
console.log(`web-ext lint${sourceDir === 'extension' ? '' : ` (${sourceDir})`}: no errors; ${found.length} known findings, all in tools/lint-baseline.json`);

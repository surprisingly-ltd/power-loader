// Runs web-ext lint (self-hosted: the manifest has an update_url) and fails on any error, and on any warning
// or notice not in tools/lint-baseline.json. The baseline holds the known warnings in vendored third-party
// files (eval-like code in pdf.js, tesseract.js and ONNX Runtime). Our own code must lint clean.
// --update rewrites the baseline from the current result (review the diff).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const baselineFile = fileURLToPath(new URL('lint-baseline.json', import.meta.url));
let raw;
try {
  raw = execFileSync(process.execPath, ['node_modules/web-ext/bin/web-ext.js', 'lint', '--self-hosted', '--source-dir', 'extension', '--output', 'json'], { cwd: root, encoding: 'utf8', maxBuffer: 64e6 });
} catch (e) { raw = e.stdout } // web-ext exits non-zero when there are errors
const result = JSON.parse(raw.slice(raw.indexOf('{')));
const found = [...result.warnings, ...result.notices].map((w) => `${w.code} ${w.file}`);
const count = (list) => list.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map());
if (process.argv.includes('--update')) {
  await fs.writeFile(baselineFile, `${JSON.stringify([...count(found)].sort().map(([k, n]) => ({ finding: k, count: n })), null, 2)}\n`);
  console.log(`tools/lint-baseline.json: ${found.length} findings`);
  process.exit(0);
}
const allowed = new Map(JSON.parse(await fs.readFile(baselineFile, 'utf8')).map((b) => [b.finding, b.count]));
const problems = result.errors.map((e) => `error ${e.code} ${e.file ?? ''}: ${e.message}`);
for (const [k, n] of count(found)) {
  if (n > (allowed.get(k) ?? 0)) problems.push(`new: ${k} (${n}, baseline ${allowed.get(k) ?? 0})`);
  if (!k.split(' ')[1]?.startsWith('vendor/') && !allowed.has(k)) problems.push(`own code must lint clean: ${k}`);
}
if (problems.length) { console.error([...new Set(problems)].join('\n')); process.exit(1) }
console.log(`web-ext lint: no errors; ${found.length} known findings in vendored files`);

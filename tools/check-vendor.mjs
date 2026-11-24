// Checks extension/vendor/ after `pnpm vendor`: every runtime file is listed in SOURCES.tsv with its SHA-256,
// and every file listed as an npm release is byte-for-byte the file in that release (node_modules, from the
// frozen lockfile). Licences and the metadata files themselves are the only unlisted files allowed.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const vendor = path.join(root, 'extension/vendor');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const problems = [];
const rows = (await fs.readFile(path.join(vendor, 'SOURCES.tsv'), 'utf8')).trim().split('\n').slice(1).map((l) => l.split('\t'));
const listed = new Set();
for (const [file, hash, npm] of rows) {
  const rel = file.replace(/^vendor\//, '');
  listed.add(rel);
  const bytes = await fs.readFile(path.join(vendor, rel)).catch(() => null);
  if (!bytes) { problems.push(`${file}: listed but missing`); continue }
  if (sha(bytes) !== hash) problems.push(`${file}: SHA-256 doesn't match SOURCES.tsv`);
  const m = /^((?:@[^/]+\/)?[^@/]+)@([^/]+)\/(.+)$/.exec(npm);
  if (!m) continue; // generated (the Transformers.js bundle), recorded in BUNDLE.json
  const [, name, version, inner] = m;
  let pkgDir;
  try {
    const req = createRequire(path.join(root, 'package.json'));
    pkgDir = path.dirname(req.resolve(`${name}/package.json`));
  } catch {
    const base = path.join(root, 'node_modules/.pnpm');
    const hit = (await fs.readdir(base)).find((d) => d.startsWith(`${name.replace('/', '+')}@${version}`));
    if (hit) pkgDir = path.join(base, hit, 'node_modules', name);
  }
  const pkg = pkgDir && JSON.parse(await fs.readFile(path.join(pkgDir, 'package.json'), 'utf8').catch(() => '{}'));
  if (!pkg || pkg.version !== version) { problems.push(`${file}: can't find ${name}@${version} in node_modules to compare`); continue }
  const original = await fs.readFile(path.join(pkgDir, inner)).catch(() => null);
  if (!original || sha(original) !== hash) problems.push(`${file}: differs from ${name}@${version}/${inner}`);
}
async function walk(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    out.push(...(e.isDirectory() ? await walk(full) : [path.relative(vendor, full).split(path.sep).join('/')]));
  }
  return out;
}
for (const f of await walk(vendor)) {
  if (listed.has(f) || f.startsWith('licenses/') || ['SOURCES.tsv', 'BUNDLE.json', 'VERSION'].includes(f)) continue;
  problems.push(`vendor/${f}: not listed in SOURCES.tsv`);
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1) }
console.log(`extension/vendor: ${rows.length} files match SOURCES.tsv and their npm releases`);

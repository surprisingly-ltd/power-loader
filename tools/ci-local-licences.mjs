// The local stand-in for dependency-review in security.yml (which runs on pull requests only): every npm
// package this lockfile adds compared with the public repo's main must carry a licence on the same allow
// list. Vulnerabilities are osv-scanner's job (tools/ci-local.sh runs it over the whole lockfile).
//   node tools/ci-local-licences.mjs <owner/repo>      run in a checkout with node_modules installed
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repo = process.argv[2];
const workflow = fs.readFileSync('.github/workflows/security.yml', 'utf8');
const allow = new Set(workflow.match(/allow-licenses:\s*(.+)/)[1].split(',').map((s) => s.trim()));

// Keys of the lockfile's packages: section, e.g. "@scope/name@1.2.3" or "name@1.2.3".
function packages(lock) {
  const out = new Set();
  const section = lock.split(/^packages:\s*$/m)[1]?.split(/^\S/m)[0] ?? '';
  for (const m of section.matchAll(/^ {2}'?([^'\s][^':]*?)'?:\s*$/gm)) out.add(m[1]);
  return out;
}

const head = packages(fs.readFileSync('pnpm-lock.yaml', 'utf8'));
let base;
try {
  const b64 = execFileSync('gh', ['api', `repos/${repo}/contents/pnpm-lock.yaml`, '--jq', '.content'], { encoding: 'utf8' });
  base = packages(Buffer.from(b64, 'base64').toString('utf8'));
} catch (error) {
  console.error(`Couldn't read ${repo}'s pnpm-lock.yaml (gh auth?): ${error.message}`);
  process.exit(1);
}

function licenceOf(key) {
  const at = key.lastIndexOf('@');
  const name = key.slice(0, at), version = key.slice(at + 1);
  const dir = path.join('node_modules/.pnpm', `${name.replace('/', '+')}@${version}`, 'node_modules', name);
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? pkg.licenses?.map((l) => l.type ?? l).join(' OR ');
  } catch { return undefined }
}

// An SPDX expression passes if every AND term has an allowed option, as dependency-review reads them.
const allowed = (expr) => expr.replace(/[()]/g, ' ').split(/\s+AND\s+/i)
  .every((term) => term.split(/\s+OR\s+/i).some((id) => allow.has(id.trim())));

const added = [...head].filter((k) => !base.has(k)).sort();
const bad = [];
for (const key of added) {
  const licence = licenceOf(key);
  if (!licence || !allowed(licence)) bad.push(`${key}: ${licence ?? 'licence not found (optional dependency not installed here?)'}`);
}
console.log(`${added.length} package(s) added compared with ${repo} main`);
for (const line of bad) console.log(`  not on the allow list: ${line}`);
process.exit(bad.length ? 1 : 0);

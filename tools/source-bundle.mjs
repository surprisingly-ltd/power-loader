// Snapshot actual build inputs, including uncommitted fixes. The explicit list excludes local
// credentials, caches, dependencies and generated output. Rebuilding the archive needs no git.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zipDir from 'zip-dir';

const root = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(await fs.readFile(path.join(root, 'extension/manifest.json'), 'utf8'));
const out = path.join(root, `dist/power-loader-${version}-src.zip`);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'powerloader-source-'));
const hashes = {};
async function copy(relative) {
  const from = path.join(root, relative);
  const stat = await fs.lstat(from);
  if (stat.isSymbolicLink()) throw new Error(`Source input must not be a symlink: ${relative}`);
  if (stat.isDirectory()) {
    for (const name of (await fs.readdir(from)).sort()) {
      if (name.startsWith('.') || relative === 'extension' && name === 'vendor') continue;
      await copy(`${relative}/${name}`);
    }
  } else {
    const bytes = await fs.readFile(from);
    const to = path.join(temp, relative);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.writeFile(to, bytes);
    hashes[relative] = createHash('sha256').update(bytes).digest('hex');
  }
}
try {
  for (const input of ['LICENSE', 'NOTICE', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'README.md', 'REVIEWERS.md',
    'amo-metadata.json', 'extension', 'tools', 'tests', 'fixtures', 'demo', 'prototype', 'docs', 'site']) await copy(input);
  await fs.writeFile(path.join(temp, 'SOURCE.json'), JSON.stringify({ version, sha256: hashes }, null, 2) + '\n');
  await fs.mkdir(path.dirname(out), { recursive: true });
  await new Promise((resolve, reject) => zipDir(temp, { saveTo: out }, (error) => error ? reject(error) : resolve()));
  process.stdout.write(`${out} (${Object.keys(hashes).length} source files; hashes in SOURCE.json)\n`);
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}

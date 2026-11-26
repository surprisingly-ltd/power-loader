// Snapshot actual build inputs, including uncommitted fixes. The explicit list excludes local
// credentials, caches, dependencies and generated output. Rebuilding the archive needs no git.
//   pnpm bundle:source                       dist/power-loader-<version>-src.zip, which rebuilds with pnpm build:ext
//   pnpm bundle:source --policy <file.json>  an organisation's archive: the policy file goes in as
//                                            organisation-policy.json, and it rebuilds with
//                                            pnpm build:ext --policy organisation-policy.json
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zipDir from 'zip-dir';
import { slugOf } from './build-ext.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(await fs.readFile(path.join(root, 'extension/manifest.json'), 'utf8'));
const at = process.argv.indexOf('--policy');
const policyFile = at >= 0 ? process.argv[at + 1] : null;
if (at >= 0 && !policyFile) throw new Error('Usage: pnpm bundle:source [--policy <file.json>]');
const slug = policyFile ? slugOf(JSON.parse(await fs.readFile(policyFile, 'utf8')).name) : null;
const out = path.join(root, `dist/power-loader-${version}${slug ? `-${slug}` : ''}-src.zip`);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'powerloader-source-'));
const hashes = {};
async function copy(relative) {
  const from = path.join(root, relative);
  // Opened without following a symlink, then checked and read through the same handle, so a file can't be
  // swapped between the check and the read. (Windows has no O_NOFOLLOW; lstat stands in there.)
  let handle;
  try {
    handle = await fs.open(from, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error.code === 'ELOOP') throw new Error(`Source input must not be a symlink: ${relative}`);
    throw error;
  }
  let stat, bytes;
  try {
    stat = await handle.stat();
    if (fsConstants.O_NOFOLLOW === undefined && (await fs.lstat(from)).isSymbolicLink()) throw new Error(`Source input must not be a symlink: ${relative}`);
    if (!stat.isDirectory()) bytes = await handle.readFile();
  } finally { await handle.close(); }
  if (stat.isDirectory()) {
    for (const name of (await fs.readdir(from)).sort()) {
      if (name.startsWith('.') || relative === 'extension' && name === 'vendor') continue;
      await copy(`${relative}/${name}`);
    }
  } else {
    const to = path.join(temp, relative);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.writeFile(to, bytes);
    hashes[relative] = createHash('sha256').update(bytes).digest('hex');
  }
}
try {
  for (const input of ['LICENSE', 'NOTICE', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'README.md', 'REVIEWERS.md',
    'amo-metadata.json', 'extension', 'tools', 'tests', 'fixtures', 'demo', 'prototype', 'docs', 'site', 'policies']) await copy(input);
  let build = 'pnpm build:ext';
  if (policyFile) {
    const bytes = await fs.readFile(policyFile);
    await fs.writeFile(path.join(temp, 'organisation-policy.json'), bytes);
    hashes['organisation-policy.json'] = createHash('sha256').update(bytes).digest('hex');
    build = 'pnpm build:ext --policy organisation-policy.json';
  }
  await fs.writeFile(path.join(temp, 'SOURCE.json'), JSON.stringify({ version, build, sha256: hashes }, null, 2) + '\n');
  await fs.mkdir(path.dirname(out), { recursive: true });
  await new Promise((resolve, reject) => zipDir(temp, { saveTo: out }, (error) => error ? reject(error) : resolve()));
  process.stdout.write(`${out} (${Object.keys(hashes).length} source files; hashes in SOURCE.json)\n`);
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}

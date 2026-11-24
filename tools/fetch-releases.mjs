// Downloads the signed XPI and SHA256SUMS of every published (not draft) GitHub release into
// dist/releases/<tag>/, newest 10 only, for tools/build-site.mjs to serve at /download/ and list in
// /updates.json. Needs the gh CLI with GH_TOKEN (contents: read). Pre-releases are skipped: they never
// reach installed copies.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO } from './site-config.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = path.join(root, 'dist/releases');
const slug = new URL(REPO).pathname.slice(1);
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' });
const releases = JSON.parse(gh('release', 'list', '-R', slug, '--limit', '100', '--json', 'tagName,isDraft,isPrerelease'))
  .filter((r) => !r.isDraft && !r.isPrerelease).slice(0, 10);
await fs.rm(out, { recursive: true, force: true });
for (const { tagName } of releases) {
  const dir = path.join(out, tagName);
  await fs.mkdir(dir, { recursive: true });
  gh('release', 'download', tagName, '-R', slug, '-D', dir, '-p', `power-loader-${tagName.replace(/^v/, '')}.xpi`, '-p', 'SHA256SUMS');
  process.stdout.write(`dist/releases/${tagName}\n`);
}
if (!releases.length) process.stdout.write('No published releases yet\n');

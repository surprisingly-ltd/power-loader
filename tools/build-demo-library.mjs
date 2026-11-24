// Writes demo/library/library.json: the manifest a real library repo's CI would publish at each
// commit, listing every file with its SHA-256. `--check` fails if the manifest is out of date.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../demo/library/', import.meta.url));

async function walk(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (entry.name.endsWith('.json')) out.push(full);
  }
  return out;
}

// `dir` and `approvedHosts` let tools/build-site.mjs build the copy hosted at powerloader.surprisingly.ltd/demo/.
export async function buildManifest({ dir = root, approvedHosts = ['localhost:8787', '127.0.0.1:8787'] } = {}) {
  const files = [];
  for (const full of (await walk(dir)).sort()) {
    const rel = path.relative(dir, full).split(path.sep).join('/');
    if (rel === 'library.json') continue;
    files.push({ path: rel, sha256: createHash('sha256').update(await fs.readFile(full)).digest('hex') });
  }
  // A static demo has no git history, so the "commit" is derived from the contents.
  const commit = createHash('sha256').update(files.map((f) => `${f.path}:${f.sha256}`).join('\n')).digest('hex').slice(0, 7);
  return {
    schema: 'powerloader-library/1',
    commit,
    message: 'Demo library for the fictional Northshire pages',
    approvedHosts,
    files,
    // A real library's CI writes this from git log; the demo has a short made-up history.
    history: {
      'profiles/pages/cm/client-record.json': [
        { version: 'v3', commit: '9b1e044', date: '2026-08-12', message: 'Read preferred language' },
        { version: 'v2', commit: '51c7a2d', date: '2026-03-03', message: 'New Case Manager layout' },
        { version: 'v1', commit: '0d4f1aa', date: '2026-01-09', message: 'First version' },
      ],
      'profiles/fill/dhp.json': [
        { version: 'v2', commit: 'c3a91f0', date: '2026-10-16', message: 'Add weekly income' },
        { version: 'v1', commit: '7e20b5c', date: '2026-05-20', message: 'First version' },
      ],
    },
  };
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const text = `${JSON.stringify(await buildManifest(), null, 2)}\n`;
  const target = path.join(root, 'library.json');
  if (process.argv.includes('--check')) {
    const current = await fs.readFile(target, 'utf8').catch(() => '');
    if (current !== text) { process.stderr.write('demo/library/library.json is out of date: run node tools/build-demo-library.mjs\n'); process.exitCode = 1; }
  } else {
    await fs.writeFile(target, text);
    process.stdout.write(`Wrote ${target}\n`);
  }
}

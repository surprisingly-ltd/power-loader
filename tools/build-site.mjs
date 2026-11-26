// Builds the public site from site/ into dist/site/: the homepage (with its loader scene, bundled from
// site/hero/), the training pages (setup, try a flow, create a flow), privacy, how it works and reviewer notes. demo/ is
// copied to dist/site/demo/ with its forms library pointing at the hosted pages instead of localhost:8787,
// and the demo flows are exported from that library to dist/site/flows/ with the extension's own code.
// The output is static, for GitHub Pages (CNAME, .nojekyll). Signed releases fetched into dist/releases/ by
// tools/fetch-releases.mjs become /download/ and /updates.json; with none, updates.json lists no versions.
// The version, ID and library checksums come from the build itself, so run `pnpm vendor` first.
// SITE_URL overrides the address the demo library and links are built for (no trailing slash).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { DEFAULT_MODEL } from '../extension/lib/model-fetch.js';
import { buildManifest } from './build-demo-library.mjs';
import { buildDemoFlows } from './build-demo-flows.mjs';
import { ensureSystems } from './build-demo-systems.mjs';
import { homeValues, howItWorksValues } from './how-it-works.mjs';

import { REPO, SITE as DEFAULT_SITE } from './site-config.mjs';

const SITE = (process.env.SITE_URL || DEFAULT_SITE).replace(/\/+$/, '');
const root = fileURLToPath(new URL('..', import.meta.url));
const src = path.join(root, 'site');
// SITE_OUT: another folder under the repo to build into, for a local copy (tools/serve-site.mjs).
const out = path.resolve(root, process.env.SITE_OUT || 'dist/site');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'extension/manifest.json'), 'utf8'));

const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let rows;
try {
  rows = (await fs.readFile(path.join(root, 'extension/vendor/SOURCES.tsv'), 'utf8')).trim().split('\n').slice(1).map((l) => l.split('\t'));
} catch {
  throw new Error('extension/vendor/SOURCES.tsv is missing: run `pnpm vendor` first');
}
const table = ['<table>', '<thead><tr><th scope="col">File</th><th scope="col">npm release</th><th scope="col">SHA-256</th></tr></thead>', '<tbody>',
  ...rows.map(([file, sha, npm, url]) => `<tr><td><code>${escape(file)}</code></td><td><a href="${escape(url)}">${escape(npm)}</a></td><td class="sha">${sha}</td></tr>`),
  '</tbody>', '</table>'].join('\n');

// The tabs on every page, in training order. Privacy, How it works and reviewer notes are in the footer.
const TABS = [
  { file: 'index.html', href: '/', label: 'Home' },
  { file: 'setup.html', href: '/setup', label: 'Setup', level: 1 },
  { file: 'try.html', href: '/try', label: 'Try a flow', level: 2 },
  { file: 'create.html', href: '/create', label: 'Create a flow', level: 3 },
  { file: 'play.html', href: '/play', label: '▶ Play' },
];
const header = (file) => [
  '<a class="skip" href="#main">Skip to content</a>',
  '<header class="top"><div class="bar">',
  '<a class="brand" href="/"><i class="mark" aria-hidden="true"></i><b>Power Loader</b></a>',
  '<nav aria-label="Sections"><ul class="tabs">',
  ...TABS.map((t) => `<li><a href="${t.href}"${t.file === file ? ' aria-current="page"' : ''}>${t.level ? `<span class="lvl">${t.level}</span>` : ''}${t.label}</a></li>`),
  '</ul></nav></div></header>',
].join('\n');
const footer = [
  '<footer class="foot"><div class="bar">',
  '<p><b>Power Loader</b> is open source (Apache-2.0) and published by Surprisingly Limited, registered in England and Wales, company number 13766094.</p>',
  `<ul><li><a href="${REPO}">Source on GitHub</a></li><li><a href="/privacy">Privacy</a></li><li><a href="/how-it-works">How it works</a></li><li><a href="/reviewers">For reviewers</a></li><li><a href="/demo/">Demo pages</a></li><li><a href="mailto:privacy@surprisingly.ltd">privacy@surprisingly.ltd</a></li></ul>`,
  '</div></footer>',
].join('\n');
const nextLevel = (file) => {
  const i = TABS.findIndex((t) => t.file === file), next = TABS[i + 1];
  return next?.level ? `<a class="next-level" href="${next.href}"><small>Next: level ${next.level}</small>${next.label} →</a>` : '';
};
// The guidance the demo index offers for the DHP flow, so the create page shows the same text.
const demoIndex = await fs.readFile(path.join(root, 'demo/index.html'), 'utf8');
const guidance = /<textarea[^>]*id="flow-guidance"[^>]*>([\s\S]*?)<\/textarea>/.exec(demoIndex)?.[1];
if (!guidance) throw new Error('demo/index.html has no #flow-guidance textarea');

// Signed releases: newest first, each XPI checked against its release's SHA256SUMS and its own manifest.
const KEEP = 10;
const releasesDir = path.join(root, 'dist/releases');
const releases = [];
for (const tag of await fs.readdir(releasesDir).catch(() => [])) {
  const version = tag.replace(/^v/, ''), name = `power-loader-${version}.xpi`, dir = path.join(releasesDir, tag);
  const file = path.join(dir, name);
  const bytes = await fs.readFile(file).catch(() => { throw new Error(`Release ${tag} has no ${name}`) });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const sums = await fs.readFile(path.join(dir, 'SHA256SUMS'), 'utf8').catch(() => { throw new Error(`Release ${tag} has no SHA256SUMS`) });
  const listed = sums.split('\n').map((l) => l.trim().split(/\s+\*?/)).find(([, f]) => f === name)?.[0];
  if (listed !== sha256) throw new Error(`${tag}: ${name} doesn't match SHA256SUMS`);
  const inner = JSON.parse(execFileSync('unzip', ['-p', file, 'manifest.json'], { encoding: 'utf8' }));
  if (inner.version !== version || inner.browser_specific_settings?.gecko?.id !== manifest.browser_specific_settings.gecko.id) {
    throw new Error(`${tag}: ${name} has version ${inner.version} and ID ${inner.browser_specific_settings?.gecko?.id}`);
  }
  releases.push({ version, name, file, sha256 });
}
const semver = (v) => v.split(/[.-]/).map((n) => (/^\d+$/.test(n) ? Number(n) : n));
releases.sort((a, b) => {
  const [x, y] = [semver(a.version), semver(b.version)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) return (x[i] ?? 0) > (y[i] ?? 0) ? -1 : 1;
  return 0;
});
const published = releases.slice(0, KEEP);

const values = {
  VERSION: manifest.version,
  ID: manifest.browser_specific_settings.gecko.id,
  VENDOR_TABLE: table,
  NODE: '24.19.0',
  PNPM: '11.3.0',
  MODEL_REVISION: DEFAULT_MODEL.revision,
  SITE,
  HOST: new URL(SITE).host,
  REPO,
  DEMO_LIBRARY: `${SITE}/demo/library/`,
  DOWNLOAD: `${SITE}/download/power-loader-latest.xpi`,
  // Until the first signed release, the install link goes to the (empty) releases page instead of a missing file.
  DOWNLOAD_LINK: published.length ? '/download/power-loader-latest.xpi' : `${REPO}/releases`,
  DEMO_GUIDANCE: guidance.trim(),
  FOOTER: footer,
  // /how-it-works: diagrams, validated samples and worked examples (tools/how-it-works.mjs).
  ...howItWorksValues(),
  ...homeValues(),
};

await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });
for (const entry of await fs.readdir(src, { withFileTypes: true })) {
  const { name } = entry;
  if (!entry.isFile()) continue;
  let body = await fs.readFile(path.join(src, name), 'utf8');
  if (name.endsWith('.html')) {
    const page = { ...values, HEADER: header(name), NEXT_LEVEL: nextLevel(name) };
    body = body.replace(/\{\{(\w+)\}\}/g, (m, k) => {
      if (!(k in page)) throw new Error(`${name}: unknown placeholder ${m}`);
      return page[k];
    });
    // The add-on's own icon is the site's favicon.
    body = body.replace('</head>', '<link rel="icon" href="/favicon.svg" type="image/svg+xml">\n</head>');
  }
  await fs.writeFile(path.join(out, name), body);
  process.stdout.write(`dist/site/${name}\n`);
}

// The demo, as served locally by `pnpm demo`, with every address moved to this site: the library's and its
// flows' (written for localhost:8787) and the pages' links to the guide (written for the live site). SITE is
// the one setting, so a copy built for another address (tools/serve-site.mjs) is the same site throughout.
async function copyDemo(from, to) {
  await fs.mkdir(to, { recursive: true });
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const [inFile, outFile] = [path.join(from, entry.name), path.join(to, entry.name)];
    if (entry.isDirectory()) await copyDemo(inFile, outFile);
    else if (entry.name.endsWith('.json')) await fs.writeFile(outFile, (await fs.readFile(inFile, 'utf8')).replaceAll('http://localhost:8787', SITE));
    // Pages can't send X-Robots-Tag, so the hosted demo pages say it themselves.
    else if (entry.name.endsWith('.html')) await fs.writeFile(outFile, (await fs.readFile(inFile, 'utf8')).replaceAll(DEFAULT_SITE, SITE).replace(/<head>/i, '<head>\n<meta name="robots" content="noindex">'));
    else await fs.copyFile(inFile, outFile);
  }
}
// The synthetic casework systems (tools/build-demo-systems.mjs) are generated into demo/ first.
await ensureSystems();
const demo = path.join(out, 'demo');
await copyDemo(path.join(root, 'demo'), demo);
const demoManifest = await buildManifest({ dir: path.join(demo, 'library'), approvedHosts: [new URL(SITE).host] });
await fs.writeFile(path.join(demo, 'library/library.json'), `${JSON.stringify(demoManifest, null, 2)}\n`);
if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(SITE).hostname) && (JSON.stringify(demoManifest).includes('localhost') || (await fs.readFile(path.join(demo, 'library/profiles/fill/dhp.json'), 'utf8')).includes('localhost'))) throw new Error('The hosted demo library still names localhost');
// The loader scene: the rig from the Transfer Bay 07 game plus the door, as one small script.
await build({ entryPoints: [path.join(src, 'hero/hero.ts')], bundle: true, minify: true, format: 'esm', target: 'firefox115', outfile: path.join(out, 'hero.js'), logLevel: 'warning', legalComments: 'none' });
process.stdout.write('dist/site/hero.js\n');

// The full Transfer Bay 07 game (site/game, from the loader-animation repo) at /game/, played on the Play tab.
// Vite built it originally; esbuild does the same here: the TypeScript and its CSS import, with Vite's
// import.meta.env values defined, and the sound effects copied beside it.
const gameOut = path.join(out, 'game');
await build({
  entryPoints: [path.join(src, 'game/src/main.ts')], bundle: true, minify: true, format: 'esm', target: 'firefox115',
  outfile: path.join(gameOut, 'game.js'), logLevel: 'warning', legalComments: 'none',
  define: { 'import.meta.env.DEV': 'false', 'import.meta.env.BASE_URL': '"./"' },
});
const gameHtml = (await fs.readFile(path.join(src, 'game/index.html'), 'utf8'))
  .replace('<script type="module" src="./src/main.ts"></script>', '<link rel="stylesheet" href="./game.css">\n<script type="module" src="./game.js"></script>');
if (!gameHtml.includes('./game.js')) throw new Error('site/game/index.html: its script tag changed; update tools/build-site.mjs');
await fs.writeFile(path.join(gameOut, 'index.html'), gameHtml);
await fs.cp(path.join(src, 'game/audio'), path.join(gameOut, 'audio'), { recursive: true });
process.stdout.write('dist/site/game/ (Transfer Bay 07)\n');

// Ready-made flows for the "Try a flow" page, exported from the hosted demo library.
for (const file of await buildDemoFlows({ libraryDir: path.join(demo, 'library'), outDir: path.join(out, 'flows'), from: `Power Loader site ${manifest.version}` })) process.stdout.write(`dist/site/flows/${file}\n`);

// The add-on's icon (extension/icons/icon.svg) is the favicon and the header mark.
await fs.copyFile(path.join(root, 'extension/icons/icon.svg'), path.join(out, 'favicon.svg'));
process.stdout.write('dist/site/favicon.svg\n');

// GitHub Pages: serve this host, and don't run Jekyll (it would drop files starting with _).
await fs.writeFile(path.join(out, 'CNAME'), `${new URL(SITE).host}\n`);
await fs.writeFile(path.join(out, '.nojekyll'), '');

// Signed XPIs and the update manifest Firefox polls (update_url in the manifest). Served from this
// origin, not from release download links, so policy allowlists need only this host.
await fs.mkdir(path.join(out, 'download'), { recursive: true });
for (const r of published) await fs.copyFile(r.file, path.join(out, 'download', r.name));
if (published.length) await fs.copyFile(published[0].file, path.join(out, 'download/power-loader-latest.xpi'));
const updates = { addons: { [values.ID]: { updates: [...published].reverse().map((r) => ({
  version: r.version, update_link: `${SITE}/download/${r.name}`, update_hash: `sha256:${r.sha256}`,
})) } } };
await fs.writeFile(path.join(out, 'updates.json'), `${JSON.stringify(updates, null, 2)}\n`);
process.stdout.write(`dist/site/updates.json (${published.length ? published.map((r) => r.version).join(', ') : 'no signed releases yet'})\n`);
process.stdout.write(`dist/site/demo/ (library commit ${demoManifest.commit}, approved host ${demoManifest.approvedHosts[0]})\n`);

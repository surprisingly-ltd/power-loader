// Checks the built site (dist/site) and every address the repo publishes, the way GitHub Pages serves them:
//   - every href/src/action on every page, and every site address in the site's JSON, resolves to a file
//     (/x serves x.html, /dir/ serves dir/index.html), and every #fragment names an id on its target page;
//   - every https://powerloader.surprisingly.ltd/... address in the repo (manifest update_url, AMO notes,
//     README, REVIEWERS, demo pages, extension code) exists in the built site;
//   - no tracked file names another host for the site, or another repository for the project.
// With --external it also fetches every outside link once and fails on any that doesn't answer 2xx/3xx.
// Usage: node tools/check-site.mjs [--external]   (after pnpm build:site)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPO, SITE } from './site-config.mjs';

const HOST = new URL(SITE).host;
const root = fileURLToPath(new URL('..', import.meta.url));
const site = path.join(root, 'dist/site');
const problems = [];
// The product's name before the rename, spelled so this line doesn't match itself.
const OLD_NAME = new RegExp(['magi', 'clip'].join(''), 'i');
const external = new Map();

async function walk(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(full));
    else out.push(full);
  }
  return out;
}
try { await fs.access(path.join(site, 'index.html')) } catch { console.error('dist/site is missing: run pnpm build:site first'); process.exit(2) }
const files = new Set((await walk(site)).map((f) => path.relative(site, f).split(path.sep).join('/')));

/** The file Pages serves for a path, or null. `base`: a directory address that tools read files under (a library). */
function serve(p, base = false) {
  const rel = decodeURIComponent(p).replace(/^\/+/, '');
  if (rel === '' || rel.endsWith('/')) {
    if (files.has(`${rel}index.html`)) return `${rel}index.html`;
    return base && [...files].some((f) => f.startsWith(rel)) ? rel : null;
  }
  if (files.has(rel)) return rel;
  if (files.has(`${rel}.html`)) return `${rel}.html`;
  return null;
}
/** The address a built file is served at: clean for top-level pages, as the nav links them. */
function urlOf(file) {
  if (file.endsWith('index.html')) return `/${file.slice(0, -'index.html'.length)}`;
  if (!file.includes('/') && file.endsWith('.html')) return `/${file.slice(0, -5)}`;
  return `/${file}`;
}
const ids = new Map();
async function idsOf(file) {
  if (!ids.has(file)) {
    const html = await fs.readFile(path.join(site, file), 'utf8');
    ids.set(file, new Set([...html.matchAll(/\s(?:id|name)="([^"]+)"/g)].map((m) => m[1])));
  }
  return ids.get(file);
}

async function check(ref, from, where, base = false) {
  if (/^(mailto:|data:|javascript:|blob:|about:|moz-extension:)/i.test(ref) || ref.includes('{{')) return;
  let url;
  try { url = new URL(ref, `${SITE}${from}`) } catch { problems.push(`${where}: unparsable address ${ref}`); return }
  if (url.host !== HOST) {
    if (/^https?:$/.test(url.protocol)) (external.get(url.href.replace(/#.*/, '')) ?? external.set(url.href.replace(/#.*/, ''), new Set()).get(url.href.replace(/#.*/, ''))).add(where);
    return;
  }
  if (url.protocol !== 'https:') problems.push(`${where}: ${ref} is not https`);
  const target = serve(url.pathname, base);
  if (!target) { problems.push(`${where}: ${ref} → ${url.pathname} is not in the site`); return }
  const frag = decodeURIComponent(url.hash.slice(1));
  if (frag && target.endsWith('.html') && !(await idsOf(target)).has(frag)) problems.push(`${where}: ${ref} → no id "${frag}" in ${target}`);
}

// 1. Pages and JSON in the built site.
for (const file of files) {
  if (file.endsWith('.html')) {
    const html = await fs.readFile(path.join(site, file), 'utf8');
    for (const m of html.matchAll(/\s(?:href|src|action|poster)="([^"]*)"/g)) await check(m[1].replaceAll('&amp;', '&'), urlOf(file), `dist/site/${file}`);
    if (/\{\{\w+\}\}/.test(html)) problems.push(`dist/site/${file}: unfilled placeholder ${/\{\{\w+\}\}/.exec(html)[0]}`);
  } else if (file.endsWith('.json')) {
    const text = await fs.readFile(path.join(site, file), 'utf8');
    // Address templates and match patterns ({clientId}, *) are checked by the library's own tests.
    for (const m of text.matchAll(/https:\/\/[^"\s]+/g)) if (!/[{}*]/.test(m[0]) && new URL(m[0]).host === HOST) await check(m[0], '/', `dist/site/${file}`, true);
  }
}
for (const must of ['index.html', '404.html', 'CNAME', '.nojekyll', 'updates.json', 'privacy.html', 'reviewers.html', 'demo/library/library.json']) {
  if (!files.has(must)) problems.push(`dist/site/${must} is missing`);
}
if ((await fs.readFile(path.join(site, 'CNAME'), 'utf8').catch(() => '')).trim() !== HOST) problems.push(`dist/site/CNAME must be ${HOST}`);
const updates = JSON.parse(await fs.readFile(path.join(site, 'updates.json'), 'utf8'));
const manifest = JSON.parse(await fs.readFile(path.join(root, 'extension/manifest.json'), 'utf8'));
const gecko = manifest.browser_specific_settings.gecko;
if (gecko.update_url !== `${SITE}/updates.json`) problems.push(`extension/manifest.json: update_url must be ${SITE}/updates.json`);
if (!updates.addons?.[gecko.id]) problems.push(`dist/site/updates.json has no entry for ${gecko.id}`);

// 2. Every tracked file: site addresses must exist; no other host or repository for the project.
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0')
  .filter((f) => f && !/^(fixtures\/pages\/|pnpm-lock\.yaml|docs\/plans\/)/.test(f) && !/\.(png|jpe?g|gif|mp3|wasm|onnx|ico|zip|xpi)$/.test(f));
for (const file of tracked) {
  const text = await fs.readFile(path.join(root, file), 'utf8').catch(() => '');
  text.split('\n').forEach((line, i) => {
    const where = `${file}:${i + 1}`;
    for (const m of line.matchAll(/https?:\/\/[a-z0-9.-]*surprisingly[a-z0-9.-]*[^\s"'`<>)\]]*/gi)) {
      const u = m[0].replace(/[.,;:]+$/, '');
      const host = new URL(u).host;
      if (host !== HOST) problems.push(`${where}: ${u} uses ${host}; the site is ${HOST}`);
      else if (!u.includes('{') && !u.includes('*') && !u.includes('${') && !/\/download\/power-loader-[\d.]+\.xpi$/.test(u) && !u.endsWith('/download/power-loader-latest.xpi')) {
        const p = new URL(u).pathname;
        if (!serve(p, true)) problems.push(`${where}: ${u} is not in the built site`);
      }
    }
    for (const m of line.matchAll(/github\.com\/(surprisingly-ltd|relativistic-labs)\/([A-Za-z0-9_-]+)/g)) {
      if (`https://${m[0]}` !== REPO) problems.push(`${where}: ${m[0]} — the project's repository is ${REPO}`);
    }
    if (OLD_NAME.test(line)) problems.push(`${where}: still uses the product's former name`);
  });
}

// 3. Outside links, on request (network).
if (process.argv.includes('--external')) {
  for (const [url, wheres] of external) {
    let status = 0;
    for (const method of ['HEAD', 'GET']) {
      try {
        const r = await fetch(url, { method, redirect: 'follow', signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'power-loader-link-check' } });
        status = r.status;
        if (r.ok) break;
      } catch (e) { status = String(e.cause?.code || e.name) }
    }
    if (!(typeof status === 'number' && status < 400)) problems.push(`${url} answered ${status} (linked from ${[...wheres].join(', ')})`);
  }
}

if (problems.length) {
  console.error(`${problems.length} problem(s):\n${problems.map((p) => `  ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`dist/site: ${files.size} files, every link resolves; ${external.size} outside links${process.argv.includes('--external') ? ' all answer' : ' (not fetched; pass --external)'}`);

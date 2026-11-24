// Screenshots of the extension's own pages next to the clickable prototype, for checking the look by eye.
// The extension pages run in a normal browser tab with tools/preview/stub.js standing in for the WebExtension
// API, seeded with the demo library. Not part of the build or the tests.
//
//   node tools/preview/shoot.mjs [ext|proto|all] [name-filter]     → dist/preview/*.png
//
// Playwright isn't a dependency of this project: set PLAYWRIGHT_DIR to a folder where `@playwright/test` resolves.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const out = path.join(root, 'dist/preview');
const [mode = 'all', only = ''] = process.argv.slice(2);
const require = createRequire(path.join(process.env.PLAYWRIGHT_DIR || '/var/web/jvl_sage/tests/e2e', 'package.json'));
const { firefox, chromium } = require('@playwright/test');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.md': 'text/markdown', '.wasm': 'application/wasm' };
const server = http.createServer(async (req, res) => {
  const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  try { const body = await fs.readFile(file); res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
await fs.mkdir(out, { recursive: true });

let browser;
try { browser = await firefox.launch(); } catch { browser = await chromium.launch(); }
const stub = await fs.readFile(path.join(root, 'tools/preview/stub.js'), 'utf8');
const shots = [];
const want = (name) => !only || name.includes(only);
const shot = async (target, name, opts = {}) => {
  if (!want(name)) return;
  const pg = target.page ? target.page() : target;
  await pg.evaluate(() => document.getElementById('announce')?.classList.remove('show')).catch(() => {});
  const file = path.join(out, `${name}.png`); await target.screenshot({ path: file, ...opts }); shots.push(file); };
const settle = (p) => p.waitForTimeout(250);

async function libraryState(page) {
  const set = await page.evaluate(() => window.__previewLibrary());
  return { library: { current: set.commit, sets: { [set.commit]: set }, lastSync: { at: new Date().toISOString(), ok: true, commit: set.commit } }, starred: ['hsr', 'dhp'], settings: { library: { baseUrl: 'http://localhost:8787/demo/library/', branch: 'main' } } };
}

async function extPage(file, { width, height, local, session, url } = {}) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('pageerror', (e) => process.stderr.write(`[${file}] ${e.message}\n`));
  await page.addInitScript(({ stub, cfg }) => { window.__preview = cfg; (0, eval)(stub); }, { stub, cfg: { local, session, url } });
  await page.goto(`${base}/extension/${file}`);
  await settle(page);
  return page;
}
const click = async (page, text) => { await page.getByRole('button', { name: text, exact: true }).first().click(); await settle(page); };

async function extension() {
  // Seed: the library alone, read once from a blank page that has the stub.
  const seed = await extPage('ui/base.css', { width: 400, height: 300 });
  const lib = await libraryState(seed);
  await seed.close();
  const sb = await extPage('sidebar/sidebar.html', { width: 384, height: 900, local: lib, url: 'http://localhost:8787/demo/index.html' });
  await shot(sb, 'ext-1-start', { fullPage: true });
  await sb.getByRole('checkbox', { name: 'Select Housing support referral' }).first().check();
  await sb.getByRole('checkbox', { name: 'Select Discretionary housing payment' }).first().check();
  await settle(sb);
  await sb.getByRole('button', { name: /^Start case: / }).click();
  await settle(sb);
  await sb.evaluate(() => window.__previewGo('client-1042.html')); await settle(sb);
  await shot(sb, 'ext-2-recognised');
  for (const p of ['client-1042.html', 'employment-1042.html', 'rent-account-1042.html']) {
    await sb.evaluate((f) => window.__previewGo(f), p); await settle(sb);
    await click(sb, 'Clip this page');
  }
  await shot(sb, 'ext-3-case', { fullPage: true });
  await sb.evaluate(() => window.__previewGo('dhp.html')); await settle(sb);
  await shot(sb, 'ext-4-form');
  for (const tab of ['Tools', 'Privacy', 'Settings']) { await sb.getByRole('tab', { name: tab }).click(); await settle(sb); await shot(sb, `ext-5-${tab.toLowerCase()}`, { fullPage: true }); }
  await sb.getByRole('tab', { name: /^Case/ }).click(); await settle(sb);
  await click(sb, 'Finish case');
  await shot(sb, 'ext-6-finish');
  const state = await sb.evaluate(() => ({ local: window.__previewStorage.local, session: window.__previewStorage.session }));
  await sb.close();
  for (const [file, name] of [['case/case.html', 'ext-7-case-page'], ['library/library.html', 'ext-8-library'], ['log/log.html', 'ext-9-log'], ['ready/ready.html', 'ext-10-ready']]) {
    if (!want(name)) continue;
    const p = await extPage(file, { width: 1280, height: 900, ...state });
    await shot(p, name, { fullPage: true });
    if (name === 'ext-7-case-page') {
      for (const v of ['Sources', 'Matrix', 'Activity', 'Calculator', 'Timeline']) {
        const t = p.getByRole('tab', { name: new RegExp(`^${v}`) });
        if (await t.count()) { await t.first().click(); await settle(p); await shot(p, `${name}-${v.toLowerCase()}`, { fullPage: true }); }
      }
    }
    await p.close();
  }
}

async function prototype() {
  const p = await browser.newPage({ viewport: { width: 1320, height: 1000 } });
  await p.goto(`${base}/prototype/case-journeys.html`);
  const jump = async (n) => { await p.locator(`.step-btn[data-v="${n}"]`).click(); await settle(p); };
  const sb = p.locator('#sb');
  await jump(2); await shot(sb, 'proto-1-start');
  await jump(4); await shot(sb, 'proto-3-case');
  await jump(8); await shot(sb, 'proto-4-form');
  for (const tab of ['tools', 'privacy', 'settings']) { await p.locator(`.sb-tabs [data-v="${tab}"]`).click(); await settle(p); await shot(sb, `proto-5-${tab}`); }
  await p.locator('.sb-tabs [data-v="case"]').click(); await settle(p);
  await p.locator('[data-act="finish"]').first().click(); await settle(p); await shot(p.locator('#browser'), 'proto-6-finish');
  await p.locator('[data-act="closeModal"]').first().click(); await settle(p);
  await p.locator('[data-act="openFull"]').first().click(); await settle(p);
  for (const v of ['fields', 'sources', 'matrix', 'activity', 'calc', 'tl']) { await p.locator(`.subnav [data-v="${v}"]`).click(); await settle(p); await shot(p.locator('#page'), `proto-7-case-page-${v}`); }
  await p.close();
}

try {
  if (mode !== 'proto') await extension();
  if (mode !== 'ext') await prototype();
} finally {
  await browser.close();
  server.close();
}
process.stdout.write(`${shots.length} screenshots in ${path.relative(root, out)}/\n${shots.map((f) => `  ${path.basename(f)}`).join('\n')}\n`);

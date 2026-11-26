// An organisation build in real Firefox (docs/plans/org-policy-builds.md, build step 9). The locked-down sample's
// policy, pointed at a local server, is built with tools/build-ext.mjs's own manifest rewrite and installed as a
// normal add-on (an unsigned XPI in the profile's extensions folder, which an ESR or unbranded Firefox accepts
// with xpinstall.signatures.required off): the closest local stand-in for an install by browser policy.
// It checks: hosts granted at install with no prompt and nothing else grantable; connect-src on the background,
// a page and a worker; Transformers.js, tesseract.js and pdf.js under it; managed storage ignored; the library
// synced by itself and read with cookies; capture absent and refused with tools.capture off; storage.session
// sizes; a case open at close gone at the next start, and one left without use past its time gone too. A second
// build, with the capture tool on, checks that capture works from the page's right-click menu (activeTab), with
// the menu clicked as a person would, through Marionette.
//   POWERLOADER_FIREFOX=/path/to/esr/firefox node tests/tools/firefox-org-build.mjs
// The only file written outside a temporary folder is ~/.mozilla/managed-storage/<test id>.json (Firefox reads
// managed storage for an add-on from there on Linux). It names a test-only add-on id and is deleted afterwards.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import zipDir from 'zip-dir';
import { buildManifest } from '../../tools/build-demo-library.mjs';
import { organisationManifest } from '../../tools/build-ext.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const ID = 'powerloader-orgtest@example.gov.uk';
const CAPTURE_ID = 'powerloader-orgcapture@example.gov.uk';
const firefox = process.env.POWERLOADER_FIREFOX || 'firefox';
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'power-loader-org-build-'));
const managedFile = path.join(os.homedir(), '.mozilla/managed-storage', `${ID}.json`);
const requests = [];
let phase = 'install';
let done;
let child;
const results = [];

const server = http.createServer((req, res) => void (async () => {
  const url = new URL(req.url, 'http://x');
  const host = req.headers.host || '';
  requests.push({ host, path: url.pathname, cookie: req.headers.cookie || '', phase });
  if (url.pathname === '/config') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ phase, base })); return; }
  if (url.pathname === '/journal') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(requests)); return; }
  if (url.pathname === '/result') {
    let body = ''; for await (const c of req) body += c;
    res.end('OK'); done?.(JSON.parse(body)); return;
  }
  if (url.pathname === '/act/enter') { await pressEnter().catch(() => {}); res.end('ok'); return; }
  if (url.pathname === '/act/menu') { const out = await rightClickMenu().catch((e) => `error: ${e.message}`); res.end(String(out)); return; }
  if (url.pathname === '/cors') { res.setHeader('Access-Control-Allow-Origin', '*'); res.end('reached'); return; }
  if (url.pathname === '/login') {
    res.setHeader('Set-Cookie', ['lax=1; Path=/; SameSite=Lax', 'none=1; Path=/; SameSite=None', 'strict=1; Path=/; SameSite=Strict', 'plain=1; Path=/']);
    res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Signed in</title><p>Signed in'); return;
  }
  if (url.pathname.startsWith('/model/')) { res.writeHead(503).end('Synthetic model mirror'); return; }
  if (url.pathname.startsWith('/demo/')) {
    const target = path.resolve(temp, 'demo', decodeURIComponent(url.pathname.slice('/demo/'.length)) || 'index.html');
    if (!target.startsWith(path.join(temp, 'demo'))) { res.writeHead(403).end(); return; }
    try {
      const body = await fs.readFile(target);
      res.setHeader('Content-Type', target.endsWith('.html') ? 'text/html' : target.endsWith('.json') ? 'application/json' : 'application/octet-stream');
      res.end(body);
    } catch { res.writeHead(404).end(); }
    return;
  }
  res.writeHead(404).end();
})().catch((e) => res.writeHead(500).end(e.message)));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://localhost:${port}`;

// The locked-down sample, on the local server: its hosts, site rules, library and model mirror.
const sample = JSON.parse(await fs.readFile(path.join(root, 'policies/samples/locked-down.json'), 'utf8'));
const local = (s) => s.replaceAll('https://*.example.gov.uk/*', 'http://localhost/*');
const policy = JSON.parse(local(JSON.stringify(sample)));
policy.name = 'Example Council (test)';
policy.build.id = ID;
policy.policy.library.baseUrl = `${base}/demo/library/`;
policy.policy.privacyModel.filesUrl = `${base}/model/pf/`;
// The same build with the capture tool on, as most organisations will have it.
const capturePolicy = structuredClone(policy);
delete capturePolicy.policy.tools;
capturePolicy.name = 'Example Council (capture test)';
capturePolicy.build.id = CAPTURE_ID;

async function stage(policy, name) {
  const ext = path.join(temp, `extension-${name}`);
  await fs.cp(path.join(root, 'extension'), ext, { recursive: true });
  await fs.writeFile(path.join(ext, 'policy.json'), JSON.stringify(policy, null, 2));
  const manifest = organisationManifest(JSON.parse(await fs.readFile(path.join(ext, 'manifest.json'), 'utf8')), policy);
  manifest.background.scripts = ['tests/org-bootstrap.js'];
  await fs.writeFile(path.join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await fs.mkdir(path.join(ext, 'tests'), { recursive: true });
  await fs.cp(path.join(root, 'tests/firefox/org-build.js'), path.join(ext, 'tests/org-build.js'));
  await fs.writeFile(path.join(ext, 'tests/org-check.html'), '<!doctype html><meta charset="utf-8"><title>Organisation build check</title><script type="module" src="org-build.js"></script>');
  await fs.writeFile(path.join(ext, 'tests/org-worker.js'), `onmessage = async (e) => { const out = {}; for (const u of e.data) { try { out[u] = (await fetch(u)).status; } catch (err) { out[u] = 'blocked: ' + err.message; } } postMessage(out); };`);
  // The background: the real one, then (first start of a phase only) the check page, and its own fetches.
  await fs.writeFile(path.join(ext, 'tests/org-bootstrap.js'), `
import '../background.js';
const cfg = await (await fetch('${base}/config')).json();
const key = 'orgCheck:' + cfg.phase;
if (!(await browser.storage.session.get(key))[key]) {
  await browser.storage.session.set({ [key]: true });
  const bg = {};
  for (const u of ['${base}/cors', '${base.replace('localhost', '127.0.0.1')}/cors']) { try { bg[u] = (await fetch(u)).status; } catch (e) { bg[u] = 'blocked: ' + e.message; } }
  await browser.storage.session.set({ orgBackgroundFetch: bg });
  await browser.storage.session.set({ orgBase: '${base}' });
  await browser.tabs.create({ url: browser.runtime.getURL('tests/org-check.html') });
}
`);
  // Demo pages and library, served by this server (once).
  if (name === 'locked') await fs.cp(path.join(root, 'demo'), path.join(temp, 'demo'), { recursive: true });
  async function rewrite(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) await rewrite(target);
      else if (/\.(html|json)$/.test(entry.name)) await fs.writeFile(target, (await fs.readFile(target, 'utf8')).replaceAll('http://localhost:8787', base));
    }
  }
  if (name === 'locked') {
    await rewrite(path.join(temp, 'demo'));
    const libManifest = await buildManifest({ dir: path.join(temp, 'demo/library'), approvedHosts: [`localhost:${port}`] });
    await fs.writeFile(path.join(temp, 'demo/library/library.json'), JSON.stringify(libManifest));
  }
  // Installed as a normal add-on, from the profile's extensions folder.
  const profile = path.join(temp, `profile-${name}`);
  await fs.mkdir(path.join(profile, 'extensions'), { recursive: true });
  await new Promise((resolve, reject) => zipDir(ext, { saveTo: path.join(profile, 'extensions', `${policy.build.id}.xpi`) }, (e) => (e ? reject(e) : resolve())));
  await fs.writeFile(path.join(profile, 'user.js'), [
    ['xpinstall.signatures.required', false], ['extensions.autoDisableScopes', 0], ['extensions.enabledScopes', 15],
    ['browser.shell.checkDefaultBrowser', false], ['browser.startup.homepage_override.mstone', 'ignore'], ['startup.homepage_welcome_url', ''],
    ['browser.aboutwelcome.enabled', false], ['datareporting.policy.dataSubmissionEnabled', false], ['toolkit.telemetry.reportingpolicy.firstRun', false],
    ['browser.sessionstore.resume_from_crash', false], ['network.proxy.type', 0], ['extensions.webextensions.restrictedDomains', ''],
    ['marionette.port', marionettePort],
  ].map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n'));
  // Managed storage for this add-on, which an organisation build must ignore.
  if (name !== 'locked') return profile;
  await fs.mkdir(path.dirname(managedFile), { recursive: true });
  await fs.writeFile(managedFile, JSON.stringify({ name: ID, description: 'Power Loader organisation build test (deleted after the run)', type: 'storage', data: { gateway: { baseUrl: 'https://managed.example.gov.uk/v1' } } }));
  return profile;
}

// Marionette, for what only a person can do: right-click the page and choose Power Loader's menu item, then press
// Enter on the region box. Its events are trusted, so Firefox treats them as a user action (activeTab).
const marionettePort = 20000 + Math.floor(Math.random() * 20000);
let marionette = null;
async function connectMarionette() {
  let sock = null;
  for (let i = 0; i < 100 && !sock; i++) {
    sock = await new Promise((r) => { const s = net.connect(marionettePort, '127.0.0.1', () => r(s)); s.on('error', () => r(null)); });
    if (!sock) await new Promise((r) => setTimeout(r, 200));
  }
  if (!sock) throw new Error('Marionette did not answer');
  let buf = ''; const replies = [];
  sock.on('data', (d) => { buf += d; for (;;) { const i = buf.indexOf(':'); if (i < 0) break; const n = Number(buf.slice(0, i)); if (buf.length < i + 1 + n) break; replies.push(JSON.parse(buf.slice(i + 1, i + 1 + n))); buf = buf.slice(i + 1 + n); } });
  const wait = async (fn) => { for (let i = 0; i < 150; i++) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return null; };
  await wait(() => replies.length);
  let id = 0;
  const send = async (cmd, params) => {
    const my = ++id; const msg = JSON.stringify([0, my, cmd, params]);
    sock.write(`${Buffer.byteLength(msg)}:${msg}`);
    const r = await wait(() => replies.find((x) => x[1] === my));
    if (r?.[2]) throw new Error(`${cmd}: ${r[2].message}`);
    return r?.[3]?.value;
  };
  await send('WebDriver:NewSession', { capabilities: {} });
  await send('Marionette:SetContext', { value: 'chrome' });
  return { send, close: () => sock.destroy() };
}
const pointer = (id, x, y, button) => [{ type: 'pointer', id, parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerMove', x: Math.round(x), y: Math.round(y) }, { type: 'pointerDown', button }, { type: 'pointerUp', button }] }];
async function rightClickMenu() {
  const m = marionette;
  const [x, y] = await m.send('WebDriver:ExecuteScript', { script: 'const b = gBrowser.selectedBrowser.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2];', args: [] });
  await m.send('WebDriver:PerformActions', { actions: pointer('r', x, y, 2) });
  await new Promise((r) => setTimeout(r, 1500));
  const item = await m.send('WebDriver:ExecuteScript', { script: `const it = [...document.getElementById('contentAreaContextMenu').querySelectorAll('menuitem')].find((x) => x.label === 'Select a region with Power Loader'); if (!it) return null; const r = it.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2];`, args: [] });
  if (!item) { await m.send('WebDriver:ExecuteScript', { script: "document.getElementById('contentAreaContextMenu').hidePopup(); return true;", args: [] }); return 'no menu item'; }
  await m.send('WebDriver:PerformActions', { actions: pointer('l', item[0], item[1], 0) });
  return 'clicked';
}
async function pressEnter() {
  await marionette.send('WebDriver:PerformActions', { actions: [{ type: 'key', id: 'k', actions: [{ type: 'keyDown', value: '\uE007' }, { type: 'keyUp', value: '\uE007' }] }] });
}

async function run(name, profile) {
  phase = name;
  const result = new Promise((resolve, reject) => {
    done = resolve;
    setTimeout(() => reject(new Error(`Phase ${name} timed out`)), 240_000).unref();
  });
  const log = await fs.open(path.join(temp, `${name}.log`), 'w');
  const driven = name === 'capture';
  child = spawn(firefox, ['-profile', profile, '-no-remote', '-headless', ...(driven ? ['-marionette', '-remote-allow-system-access'] : []), 'about:blank'], { stdio: ['ignore', log.fd, log.fd], detached: true });
  if (driven) marionette = await connectMarionette();
  try {
    const report = await result;
    for (const r of report.results) { results.push({ phase: name, ...r }); console.log(`${r.ok ? 'PASS' : 'FAIL'} ${name}: ${r.name}${r.detail ? ` (${r.detail})` : ''}${r.error ? `: ${r.error}` : ''}`); }
  } finally {
    // A clean quit isn't needed: clear on close treats any start as a new session.
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
    await new Promise((r) => { child.once('exit', r); setTimeout(r, 8000); });
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
    marionette?.close();
    marionette = null;
    await log.close();
  }
}

try {
  const profile = await stage(policy, 'locked');
  await run('install', profile);
  await run('restart', profile);
  await run('capture', await stage(capturePolicy, 'capture'));
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} organisation build checks passed.`);
  await fs.mkdir(path.join(root, 'dist/test-results'), { recursive: true });
  await fs.writeFile(path.join(root, 'dist/test-results/firefox-org-build.json'), `${JSON.stringify({ firefox, results }, null, 2)}\n`);
  if (failed.length) process.exitCode = 1;
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  server.closeAllConnections();
  server.close();
  await fs.rm(managedFile, { force: true });
  if (process.exitCode || process.env.POWERLOADER_KEEP_TEST_PROFILE === '1') console.error(`Test artifacts retained: ${temp}`);
  else await fs.rm(temp, { recursive: true, force: true });
}

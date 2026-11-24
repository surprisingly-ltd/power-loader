// Real Firefox integration tests. Only the temporary extension gets loopback host access and a driver.
// The original background, UI, agents, CSP, workers and storage APIs run unchanged.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { buildManifest } from '../../tools/build-demo-library.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'power-loader-firefox-suite-'));
const extension = path.join(temp, 'extension');
const demo = path.join(temp, 'demo');
const modes = { library: 'ok', gateway: 'ok' };
const requests = [];
const held = new Set();
let activeRun;
let child;
let interrupted = false;
const interrupt = () => { interrupted = true; activeRun?.reject(new Error('Firefox suite interrupted')); };
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
const allResults = [];
const server = http.createServer((req, res) => void serve(req, res).catch((error) => {
  res.writeHead(500).end(error.message);
}));
let base;

async function body(req) {
  let value = '';
  for await (const chunk of req) {
    value += chunk;
    if (value.length > 2_000_000) throw new Error('Test request exceeded limit');
  }
  return value;
}
async function serve(req, res) {
  const url = new URL(req.url, base);
  if (url.pathname === '/progress') {
    const result = JSON.parse(await body(req));
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}${result.error ? `: ${result.error}` : ''}`);
    res.end('OK'); return;
  }
  if (url.pathname === '/result') {
    const result = JSON.parse(await body(req));
    res.end('OK');
    activeRun?.resolve(result); return;
  }
  if (url.pathname === '/control') {
    Object.assign(modes, JSON.parse(await body(req)));
    res.end('OK'); return;
  }
  if (url.pathname === '/journal') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(requests)); return; }
  if (/^\/(gateway|sink|model)\//.test(url.pathname)) {
    requests.push({ path: url.pathname, authorization: req.headers.authorization || '', cookie: req.headers.cookie || '', body: await body(req) });
    if (url.pathname.startsWith('/sink/')) { res.end('Should never be requested'); return; }
    if (url.pathname.startsWith('/model/')) { res.writeHead(503).end('Synthetic model mirror outage'); return; }
    if (modes.gatewayFailures > 0) { modes.gatewayFailures--; res.writeHead(503).end('Synthetic retryable failure'); return; }
    switch (modes.gateway) {
      case 'redirect': res.writeHead(307, { Location: `${base.replace('localhost', '127.0.0.1')}/sink/redirect` }).end(); return;
      case 'denied': res.writeHead(401).end('private server text synthetic-key'); return;
      case 'invalid': res.end('not JSON'); return;
      case 'large': res.end('x'.repeat(110_000)); return;
      case 'hang': held.add(res); res.once('close', () => held.delete(res)); return;
      default: res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: modes.gatewayReply || 'OK' } }] })); return;
    }
  }
  if (url.pathname.startsWith('/demo/')) {
    if (url.pathname.startsWith('/demo/library/')) {
      requests.push({ path: url.pathname, authorization: req.headers.authorization || '', body: '' });
      if (modes.library === 'redirect') { res.writeHead(307, { Location: `${base.replace('localhost', '127.0.0.1')}/sink/library` }).end(); return; }
      if (modes.library === 'denied') { res.writeHead(403).end(); return; }
      if (modes.library === 'hang' && !url.pathname.endsWith('library.json')) { held.add(res); res.once('close', () => held.delete(res)); return; }
      if (modes.library === 'corrupt' && !url.pathname.endsWith('library.json')) { res.end('{"tampered":true}'); return; }
    }
    const relative = decodeURIComponent(url.pathname.slice('/demo/'.length));
    const target = path.resolve(demo, relative || 'index.html');
    if (!target.startsWith(`${demo}${path.sep}`)) { res.writeHead(403).end(); return; }
    const bytes = await fs.readFile(target);
    res.setHeader('Content-Type', target.endsWith('.json') ? 'application/json' : 'text/html; charset=utf-8');
    // A cookie deliberately exists: AI transport must omit it.
    res.setHeader('Set-Cookie', 'synthetic_session=must-not-reach-gateway; SameSite=Lax; Path=/');
    res.end(bytes); return;
  }
  res.writeHead(404).end();
}
async function stop() {
  if (!child) return;
  const current = child;
  child = null;
  const exited = current.exitCode !== null || current.signalCode !== null ? Promise.resolve() : once(current, 'exit');
  current.kill('SIGINT');
  let timer;
  await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(() => { try { process.kill(-current.pid, 'SIGKILL'); } catch {} resolve(); }, 6000); })]);
  clearTimeout(timer);
}
async function run(phase) {
  if (interrupted) throw new Error('Firefox suite interrupted');
  const runId = crypto.randomUUID();
  const modelEnabled = process.env.POWERLOADER_TEST_MODEL === '1';
  await fs.writeFile(path.join(extension, 'tests/config.json'), JSON.stringify({ base, phase, runId, modelEnabled }));
  let resolve, reject;
  const result = new Promise((yes, no) => { resolve = yes; reject = no; });
  activeRun = { resolve, reject };
  const timer = setTimeout(() => reject(new Error(`Firefox phase ${phase} timed out; see tests/firefox/README.md`)), modelEnabled ? 20 * 60_000 : 180_000);
  const log = await fs.open(path.join(temp, `${phase}.log`), 'w');
  child = spawn(process.execPath, [path.join(root, 'node_modules/web-ext/bin/web-ext.js'), 'run',
    '--source-dir', extension, '--firefox', process.env.POWERLOADER_FIREFOX || 'firefox',
    '--firefox-profile', path.join(temp, 'profile'), '--profile-create-if-missing', '--keep-profile-changes',
    '--no-input', '--no-reload', ...(process.env.POWERLOADER_FIREFOX_HEADFUL === '1' ? [] : ['--arg=-headless']),
  ], { cwd: root, detached: true, stdio: ['ignore', log.fd, log.fd] });
  child.once('error', reject);
  child.once('exit', (code) => reject(new Error(`Firefox stopped before phase ${phase} completed (exit ${code})`)));
  try {
    const report = await result;
    if (!Array.isArray(report.results) || !report.results.length) throw new Error('Firefox returned no test results');
    allResults.push(...report.results.map((entry) => ({ phase, ...entry })));
    if (report.phase !== phase) throw new Error(`Unexpected phase report: ${report.phase}`);
    return report.results.every((entry) => entry.ok);
  } finally {
    clearTimeout(timer);
    await stop();
    activeRun = null;
    await log.close();
    for (const response of held) response.destroy();
    held.clear();
    modes.library = 'ok'; modes.gateway = 'ok';
  }
}

try {
  await fs.access(path.join(root, 'extension/vendor/transformers.min.js')).catch(() => { throw new Error('Run pnpm vendor before the Firefox suite'); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  base = `http://localhost:${server.address().port}`;
  await fs.cp(path.join(root, 'extension'), extension, { recursive: true });
  await fs.cp(path.join(root, 'tests/firefox'), path.join(extension, 'tests/firefox'), { recursive: true });
  await fs.cp(path.join(root, 'demo'), demo, { recursive: true });
  async function rewrite(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) await rewrite(target);
      else if (/\.(html|json)$/.test(entry.name)) await fs.writeFile(target, (await fs.readFile(target, 'utf8')).replaceAll('http://localhost:8787', base));
    }
  }
  await rewrite(demo);
  const manifest = await buildManifest({ dir: path.join(demo, 'library'), approvedHosts: [new URL(base).host] });
  await fs.writeFile(path.join(demo, 'library/library.json'), JSON.stringify(manifest));
  const extManifest = JSON.parse(await fs.readFile(path.join(extension, 'manifest.json'), 'utf8'));
  extManifest.background.scripts = ['tests/bootstrap.js'];
  extManifest.host_permissions = ['http://localhost/*', 'http://127.0.0.1/*'];
  await fs.writeFile(path.join(extension, 'manifest.json'), JSON.stringify(extManifest));
  await fs.writeFile(path.join(extension, 'tests/bootstrap.js'), `
import '../background.js';
const config = await (await fetch(browser.runtime.getURL('tests/config.json'))).json();
// The background is an event page: Firefox suspends it when idle and starts it again later. Set up the
// run's tabs only on the first start, or a restart would close the running test page and start another.
const key = 'testBootstrap:' + config.runId;
if (!(await browser.storage.session.get(key))[key]) {
  await browser.storage.session.set({ [key]: true });
  // Reuse the first open tab (a blank page, or one restored after a restart) for the demo page and
  // close the rest. Closing every original tab can leave Firefox (161+) without a current window,
  // and then tabs.create fails.
  const [first, ...rest] = await browser.tabs.query({});
  await browser.tabs.update(first.id, { url: config.base + '/demo/client-1042.html', active: true });
  if (rest.length) await browser.tabs.remove(rest.map((tab) => tab.id));
  await browser.tabs.create({ url: browser.runtime.getURL('sidebar/sidebar.html') + '?testRun=' + config.runId, active: false, windowId: first.windowId });
}
`);
  // Install the monitor before the sidebar module starts, so startup races cannot escape the check.
  await fs.writeFile(path.join(extension, 'tests/error-monitor.js'), `
globalThis.PowerLoaderTestErrors = [];
addEventListener('error', event => PowerLoaderTestErrors.push(event.error?.stack || event.message));
addEventListener('unhandledrejection', event => PowerLoaderTestErrors.push(String(event.reason?.stack || event.reason?.message || event.reason)));
`);
  const sidebar = path.join(extension, 'sidebar/sidebar.html');
  await fs.writeFile(sidebar, (await fs.readFile(sidebar, 'utf8'))
    .replace('<head>', '<head><script src="../tests/error-monitor.js"></script>')
    .replace('</body>', '<script type="module" src="../tests/firefox/driver.js"></script></body>'));
  for (const phase of ['main', 'recovered-before-archive', 'recovered-after-archive']) {
    if (!await run(phase)) { process.exitCode = 1; break; }
  }
  const summary = { firefox: process.env.POWERLOADER_FIREFOX || 'firefox', modelEnabled: process.env.POWERLOADER_TEST_MODEL === '1', results: allResults };
  await fs.mkdir(path.join(root, 'dist/test-results'), { recursive: true });
  await fs.writeFile(path.join(root, 'dist/test-results/firefox.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(`${allResults.filter((entry) => entry.ok).length}/${allResults.length} Firefox checks passed. Report: dist/test-results/firefox.json`);
} catch (error) {
  process.exitCode = 1;
  console.error(error.message);
} finally {
  await stop();
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  if (process.exitCode || process.env.POWERLOADER_KEEP_TEST_PROFILE === '1') console.error(`Test artifacts retained: ${temp}`);
  else await fs.rm(temp, { recursive: true, force: true });
}

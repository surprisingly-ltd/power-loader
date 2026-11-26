// The website and its copy of the demo, built for this computer and served here, so the whole thing can be
// tried before it is published: `pnpm site`, then http://localhost:8080/.
//
// `pnpm build:site` builds dist/site/ for the live address, so its demo library and flows name the live
// pages even when the files are opened from a local server. This builds a second copy into dist/site-local/
// with SITE_URL set to this server's address: the library at /demo/library/, its flows and the downloads on
// /try then all point back here. Addresses resolve as GitHub Pages does (a folder's index.html, /name for
// name.html, else 404.html). PORT changes the port; the library's approved host follows it.
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.PORT || 8080);
const site = `http://localhost:${port}`;
const out = path.join(root, 'dist/site-local');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2',
  '.xpi': 'application/x-xpinstall',
};
const isFile = async (f) => { try { return (await fs.stat(f)).isFile(); } catch { return false; } };

execFileSync(process.execPath, [path.join(root, 'tools/vendor.mjs')], { cwd: root, stdio: 'inherit' });
execFileSync(process.execPath, [path.join(root, 'tools/build-site.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, SITE_URL: site, SITE_OUT: 'dist/site-local' } });

const server = http.createServer(async (req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
  let file;
  try { file = path.join(out, decodeURIComponent(new URL(req.url, site).pathname)); } catch { res.writeHead(400); res.end(); return; }
  if (file !== out && !file.startsWith(out + path.sep)) { res.writeHead(403); res.end(); return; }
  for (const f of [file, path.join(file, 'index.html'), `${file}.html`]) {
    if (!(await isFile(f))) continue;
    // Nothing is cached, so a rebuilt library or flow is what the extension reads next.
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : await fs.readFile(f));
    return;
  }
  res.writeHead(404, { 'Content-Type': TYPES['.html'] });
  res.end(await fs.readFile(path.join(out, '404.html')).catch(() => 'Not found'));
});
server.on('error', (error) => { process.stderr.write(`Could not start the site server: ${error.code}\n`); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => process.stdout.write(`Site: ${site}/   Demo: ${site}/demo/   Library address: ${site}/demo/library/\n`));

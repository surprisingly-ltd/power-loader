import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureSystems } from './build-demo-systems.mjs';
const root = fileURLToPath(new URL('../demo/', import.meta.url));
const port = Number(process.env.PORT || 8787);
export async function serveDemo(req, res) {
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/demo') { res.writeHead(302, { Location: '/demo/' }); res.end(); return; }
  if (!url.pathname.startsWith('/demo/')) { res.writeHead(404); res.end(); return; }
  try {
    const relative = decodeURIComponent(url.pathname.slice('/demo/'.length));
    const file = path.resolve(root, relative || 'index.html');
    if (!file.startsWith(root)) throw new Error('Not found');
    // Checked and read through one handle, so what is checked is what is served.
    const handle = await fs.open(file);
    let content;
    try {
      if (!(await handle.stat()).isFile()) throw new Error('Not found');
      content = await handle.readFile();
    } finally { await handle.close(); }
    const type = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' }[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type }); res.end(req.method === 'HEAD' ? undefined : content);
  } catch { res.writeHead(404); res.end('Not found'); }
}
if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  // The synthetic casework systems are generated, not committed: write them first if they're missing or old.
  const made = await ensureSystems();
  if (made.written) process.stdout.write(`Wrote ${made.written} demo system pages into demo/\n`);
  const server = http.createServer(serveDemo);
  server.on('error', (error) => { process.stderr.write(`Could not start demo server: ${error.code}\n`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => process.stdout.write(`Demo: http://localhost:${server.address().port}/demo/\n`));
}

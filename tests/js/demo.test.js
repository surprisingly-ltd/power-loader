import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serveDemo } from '../../tools/serve-demo.mjs';
const request = async (url, method = 'GET') => {
  const response = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
  await serveDemo({ url, method }, response);
  return response;
};
test('demo handler serves fictional pages and excludes files outside demo', async () => {
  const page = await request('/demo/client-1042.html');
  assert.equal(page.status, 200); assert.match(page.body.toString(), /Maria Kowalska/);
  for (const path of ['/README.md', '/demo/%2e%2e/README.md', '/demo/..%2fREADME.md']) assert.equal((await request(path)).status, 404);
  assert.equal((await request('/demo/')).status, 200);
  assert.equal((await request('/demo')).status, 302);
  assert.equal((await request('/demo/', 'POST')).status, 405);
});

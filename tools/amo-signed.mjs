// Downloads the Mozilla-signed XPI of a version already on AMO (unlisted), and checks it is the given
// unsigned build: every file the same apart from Mozilla's META-INF/ signature, and manifest.json the
// same JSON (AMO re-serialises it when signing). Exits 2 if AMO has no such version yet.
// Usage: node tools/amo-signed.mjs <version> <unsigned.zip> <out.xpi>
// Needs AMO_JWT_ISSUER and AMO_JWT_SECRET (an AMO API key pair) in the environment. Never prints them.
import { execFileSync } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [version, unsigned, out] = process.argv.slice(2);
const { AMO_JWT_ISSUER: iss, AMO_JWT_SECRET: secret } = process.env;
if (!version || !unsigned || !out) { console.error('Usage: node tools/amo-signed.mjs <version> <unsigned.zip> <out.xpi>'); process.exit(64) }
if (!iss || !secret) { console.error('AMO_JWT_ISSUER and AMO_JWT_SECRET must be set'); process.exit(64) }
const id = JSON.parse(execFileSync('unzip', ['-p', unsigned, 'manifest.json'], { encoding: 'utf8' })).browser_specific_settings.gecko.id;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function auth() {
  const now = Math.floor(Date.now() / 1000);
  const unsignedToken = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss, jti: randomUUID(), iat: now, exp: now + 60 })}`;
  return { Authorization: `JWT ${unsignedToken}.${createHmac('sha256', secret).update(unsignedToken).digest('base64url')}` };
}

const res = await fetch(`https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(id)}/versions/v${version}/`, { headers: auth() });
if (res.status === 404) { console.log(`AMO has no version ${version} of ${id}`); process.exit(2) }
if (!res.ok) throw new Error(`AMO version lookup: HTTP ${res.status}`);
const info = await res.json();
if (info.file?.status !== 'public' || !info.file?.url) throw new Error(`AMO version ${version} is not signed yet (file status ${info.file?.status})`);
const file = await fetch(info.file.url, { headers: auth() });
if (!file.ok) throw new Error(`AMO download: HTTP ${file.status}`);
const bytes = Buffer.from(await file.arrayBuffer());
const sha = createHash('sha256').update(bytes).digest('hex');
if (info.file.hash !== `sha256:${sha}`) throw new Error(`Downloaded file hash ${sha} doesn't match AMO's ${info.file.hash}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'amo-signed-'));
fs.writeFileSync(path.join(tmp, 'signed.xpi'), bytes);
for (const [name, zip] of [['signed', path.join(tmp, 'signed.xpi')], ['built', unsigned]]) execFileSync('unzip', ['-q', zip, '-d', path.join(tmp, name)]);
const walk = (dir, base = dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name))]);
const signedFiles = walk(path.join(tmp, 'signed')).filter((f) => !f.startsWith('META-INF')).sort();
const builtFiles = walk(path.join(tmp, 'built')).sort();
if (JSON.stringify(signedFiles) !== JSON.stringify(builtFiles)) throw new Error('The signed XPI has different files from the build');
for (const f of builtFiles) {
  const [a, b] = ['signed', 'built'].map((d) => fs.readFileSync(path.join(tmp, d, f)));
  const same = f === 'manifest.json' ? JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b)) : a.equals(b);
  if (!same) throw new Error(`${f} differs between the signed XPI and the build`);
}
fs.rmSync(tmp, { recursive: true, force: true });
fs.writeFileSync(out, bytes);
console.log(`${out}: AMO's signed ${id} ${version} (sha256 ${sha}), the same as ${path.basename(unsigned)} apart from Mozilla's signature`);

#!/usr/bin/env node
// Build the extension package.
//   pnpm build:ext                          the public build, from extension/ as it is: dist/power-loader-<version>.zip
//   pnpm build:ext --policy <file.json>     an organisation build: dist/power-loader-<version>-<slug>.zip
// An organisation build checks the policy file (tools/policy.mjs), copies extension/ to a staging folder, writes
// the file there as policy.json, and rewrites the staged manifest: the add-on's own id and update address, and,
// when build.hosts is set, host_permissions (granted at install), no optional host permissions, and connect-src
// in the extension pages' CSP. extension/ is never changed. See docs/organisation-builds.md.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPolicy, readPolicyFile } from './policy.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const webExt = path.join(root, 'node_modules/web-ext/bin/web-ext.js');

/** A name as it goes into a file name: "Example Council" → "example-council". */
export const slugOf = (name) => String(name || 'organisation').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'organisation';

/** CSP sources for match patterns: both the domain and its subdomains, any port, for each scheme it names. */
export function connectSources(hosts) {
  const out = new Set();
  for (const h of hosts) {
    const m = /^(\*|https?):\/\/(\*|\*\.[^/]+|[^/]+)\//.exec(h);
    if (!m) continue;
    const schemes = m[1] === '*' ? ['https', 'http'] : [m[1]];
    const host = m[2];
    // A match pattern covers every port; a CSP source without a port only the scheme's default one.
    for (const s of schemes) {
      if (host === '*') out.add(`${s}:`);
      else if (host.startsWith('*.')) { out.add(`${s}://${host.slice(2)}:*`); out.add(`${s}://${host}:*`); }
      else out.add(`${s}://${host}:*`);
    }
  }
  return [...out];
}

/** The staged manifest for a policy file. Pure, so it can be tested. */
export function organisationManifest(manifest, doc) {
  const m = structuredClone(manifest);
  const gecko = m.browser_specific_settings.gecko;
  gecko.id = doc.build.id;
  gecko.update_url = doc.build.updateUrl;
  const hosts = Array.isArray(doc.build.hosts) ? doc.build.hosts : null;
  if (hosts) {
    // Granted when the extension is installed, so Firefox never asks site by site; nothing else can be granted.
    m.host_permissions = [...hosts];
    delete m.optional_host_permissions;
    // Capture: Firefox offers it only with <all_urls> or activeTab. activeTab, granted for one tab when the
    // caseworker asks from the page (its right-click menu or Alt+Shift+R), keeps the hosts as they are. Left out
    // when the policy file turns the capture tool (or the reader it reads into) off.
    const tools = doc.policy?.tools || {};
    if (!hosts.includes('<all_urls>') && tools.capture !== false && tools.reader !== false) {
      m.permissions = [...new Set([...(m.permissions || []), 'activeTab', 'menus'])];
      m.commands = { ...(m.commands || {}), 'select-region': { suggested_key: { default: 'Alt+Shift+R' }, description: 'Select a region of the page to read' } };
    }
    if (!hosts.includes('<all_urls>')) {
      const csp = m.content_security_policy.extension_pages.split(';').map((d) => d.trim()).filter((d) => d && !d.startsWith('connect-src'));
      csp.push(`connect-src 'self' ${connectSources(hosts).join(' ')}`);
      m.content_security_policy.extension_pages = csp.join('; ');
    }
  }
  return m;
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${path.basename(args[0] || cmd)} failed`);
}

async function main(argv) {
  const i = argv.indexOf('--policy');
  const policyFile = i >= 0 ? argv[i + 1] : null;
  if (i >= 0 && !policyFile) throw new Error('Usage: pnpm build:ext [--policy <file.json>]');
  run(process.execPath, [path.join(root, 'tools/vendor.mjs')]);
  if (!policyFile) {
    run(process.execPath, [webExt, 'build', '--source-dir', 'extension', '--artifacts-dir', 'dist', '--filename', 'power-loader-{version}.zip', '--overwrite-dest']);
    return;
  }
  const doc = readPolicyFile(policyFile);
  const { errors, warnings } = checkPolicy(doc);
  for (const w of warnings) console.log(`! ${w}`);
  if (errors.length) {
    for (const e of errors) console.error(`✗ ${e}`);
    throw new Error(`${policyFile} has ${errors.length} problem${errors.length === 1 ? '' : 's'}: fix ${errors.length === 1 ? 'it' : 'them'} before building (node tools/policy.mjs check)`);
  }
  if (!doc.build) throw new Error('This is the default policy file: build without --policy');
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'powerloader-org-build-'));
  try {
    const dir = path.join(stage, 'extension');
    await fs.cp(path.join(root, 'extension'), dir, { recursive: true });
    await fs.copyFile(policyFile, path.join(dir, 'policy.json'));
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
    await fs.writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(organisationManifest(manifest, doc), null, 2)}\n`);
    const name = `power-loader-${manifest.version}-${slugOf(doc.name)}.zip`;
    run(process.execPath, [webExt, 'build', '--source-dir', dir, '--artifacts-dir', path.join(root, 'dist'), '--filename', name, '--overwrite-dest']);
    console.log(`dist/${name}: rules built in by ${doc.name}, id ${doc.build.id}`);
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exitCode = 1; });
}

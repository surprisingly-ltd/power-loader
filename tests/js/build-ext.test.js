// tools/build-ext.mjs: an organisation build's manifest, from its policy file. extension/ is never changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { connectSources, organisationManifest, slugOf } from '../../tools/build-ext.mjs';

const manifest = JSON.parse(fs.readFileSync(new URL('../../extension/manifest.json', import.meta.url), 'utf8'));
const sample = (name) => JSON.parse(fs.readFileSync(new URL(`../../policies/samples/${name}.json`, import.meta.url), 'utf8'));

test('the identity is the organisation’s own; without build.hosts, sites are still asked for one by one', () => {
  const m = organisationManifest(manifest, sample('no-post'));
  assert.equal(m.browser_specific_settings.gecko.id, 'powerloader@example.gov.uk');
  assert.equal(m.browser_specific_settings.gecko.update_url, 'https://addons.example.gov.uk/powerloader/updates.json');
  assert.deepEqual(m.optional_host_permissions, ['<all_urls>']);
  assert.equal(m.host_permissions, undefined);
  assert.equal(m.content_security_policy.extension_pages, manifest.content_security_policy.extension_pages);
  assert.equal(m.name, 'Power Loader');
  assert.equal(manifest.browser_specific_settings.gecko.id, 'powerloader@surprisingly.ltd', 'the source manifest is unchanged');
});

test('build.hosts: granted at install, nothing optional, and connect-src limits the extension pages', () => {
  const m = organisationManifest(manifest, sample('locked-down'));
  assert.deepEqual(m.host_permissions, ['https://*.example.gov.uk/*']);
  assert.equal(m.optional_host_permissions, undefined);
  assert.match(m.content_security_policy.extension_pages, /; connect-src 'self' https:\/\/example\.gov\.uk:\* https:\/\/\*\.example\.gov\.uk:\*$/);
  assert.match(m.content_security_policy.extension_pages, /^script-src 'self' 'wasm-unsafe-eval';/);
});

test('capture on a build with fixed hosts: activeTab, the page menu and a command, left out when capture is off', () => {
  const on = organisationManifest(manifest, sample('fixed-endpoints'));
  assert.ok(on.permissions.includes('activeTab') && on.permissions.includes('menus'));
  assert.equal(on.commands['select-region'].suggested_key.default, 'Alt+Shift+R');
  assert.deepEqual(on.host_permissions, ['https://*.example.gov.uk/*'], 'the hosts are as they were');
  assert.ok(!on.permissions.includes('<all_urls>') && !on.optional_host_permissions);
  const off = organisationManifest(manifest, sample('locked-down'));
  assert.ok(!off.permissions.includes('activeTab') && !off.permissions.includes('menus') && !off.commands);
  const noHosts = organisationManifest(manifest, sample('no-post'));
  assert.ok(!noHosts.permissions.includes('activeTab'), 'without build.hosts, capture asks for <all_urls> as the public build does');
});

test('match patterns as CSP sources, and names as file names', () => {
  assert.deepEqual(connectSources(['*://*.gov.uk/*', 'https://supplier.example.com/*', 'http://localhost/*']),
    ['https://gov.uk:*', 'https://*.gov.uk:*', 'http://gov.uk:*', 'http://*.gov.uk:*', 'https://supplier.example.com:*', 'http://localhost:*']);
  assert.deepEqual(connectSources(['https://*/*']), ['https:']);
  assert.equal(slugOf('Example Council'), 'example-council');
  assert.equal(slugOf('  Département  '), 'departement');
  assert.equal(slugOf(null), 'organisation');
});

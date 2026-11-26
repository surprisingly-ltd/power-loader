// Diagnostics for IT: what is set up and what has failed, never what was worked on. The report is built
// only from the fields listed here; it never includes page URLs, payloads, case values, notes or keys.
/* global browser */

// Counts of recent capability failures by type, for this browser session only.
export async function recordFailure(type) {
  try {
    const { capabilityFailures = {} } = await browser.storage.session.get('capabilityFailures');
    capabilityFailures[type] = (capabilityFailures[type] || 0) + 1;
    await browser.storage.session.set({ capabilityFailures });
  } catch { /* diagnostics must never break the feature that failed */ }
}

/**
 * facts: { extension, firefox, policy: { builtIn: { name } | null, managed, managedIgnored, id }, policyKeys, library: { commit, syncedAt, problems: [path], lastSync: { ok, at } },
 *          model: { state, reason, revision, ms }, gateway: { status, ok, at }, webgpu, failures, storage,
 *          siteRules: [{ layer, rules: count, broken }] (how many rules each layer has, never the patterns) }
 */
export function diagnosticsReport(f) {
  const lines = [
    `Power Loader diagnostics, ${new Date().toISOString()}`,
    `Extension: ${f.extension || 'unknown'}`,
    `Firefox: ${f.firefox || 'unknown'}`,
    `Policy: ${f.policy?.builtIn ? `built in by ${f.policy.builtIn.name} (${f.policy.id || 'unknown id'})${f.policy.managedIgnored ? '; managed storage is set and ignored' : ''}` : f.policy?.managed ? 'managed storage' : 'none'}`,
    `Policy keys set: ${f.policyKeys?.length ? f.policyKeys.join(', ') : 'none'}`,
    `Library: ${f.library?.commit ? `commit ${f.library.commit}, synced ${f.library.syncedAt || 'unknown'}` : 'not connected'}${f.library?.lastSync && !f.library.lastSync.ok ? `; last sync failed at ${f.library.lastSync.at}` : ''}`,
    `Library files failing validation: ${f.library?.problems?.length ? f.library.problems.join(', ') : 'none'}`,
    `Privacy model: ${f.model?.state || 'not loaded'}${f.model?.reason ? ` (${f.model.reason})` : ''}${f.model?.revision ? `, revision ${f.model.revision}` : ''}${f.model?.ms ? `, test scan ${f.model.ms} ms` : ''}`,
    `Gateway: ${f.gateway ? `${f.gateway.ok ? 'reachable' : 'failed'}${f.gateway.status ? `, HTTP ${f.gateway.status}` : ''} at ${f.gateway.at}` : 'not tested'}`,
    `WebGPU: ${f.webgpu ? `${f.webgpu.available ? 'adapter found' : 'no adapter'}${f.webgpu.vendor ? `, ${f.webgpu.vendor}` : ''}${f.webgpu.architecture ? ` ${f.webgpu.architecture}` : ''}` : 'not checked'}`,
    `Storage: ${f.storage ? `${Math.round(f.storage.usage / 1e6)} MB used of ${Math.round(f.storage.quota / 1e6)} MB` : 'unknown'}`,
    `Site rules: ${f.siteRules ? `${f.siteRules.map((l) => `${l.layer} ${l.rules}`).join(', ')}${f.siteRules.some((l) => l.broken) ? '; a policy address can’t be read, so Power Loader works nowhere' : ''}` : 'unknown'}`,
    `Recent failures: ${f.failures && Object.keys(f.failures).length ? Object.entries(f.failures).map(([k, n]) => `${k} ×${n}`).join(', ') : 'none'}`,
  ];
  return lines.join('\n');
}

export async function webgpuInfo() {
  try {
    if (!globalThis.navigator?.gpu) return { available: false };
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { available: false };
    const info = adapter.info || {};
    return { available: true, vendor: info.vendor || '', architecture: info.architecture || '' };
  } catch { return { available: false }; }
}

/** Gather the facts from this browser. */
export async function collectFacts({ libraryAt, policyKeysSet, siteRules = null, getPolicy = null }) {
  const local = await browser.storage.local.get(['library']);
  const session = await browser.storage.session.get(['modelStatus', 'gatewayStatus', 'capabilityFailures']).catch(() => ({}));
  const lib = local.library ? libraryAt(local.library, local.library.current) : null;
  const firefox = await browser.runtime.getBrowserInfo?.().then((i) => `${i.name} ${i.version}`).catch(() => null);
  const storage = await navigator.storage?.estimate?.().catch(() => null);
  const m = session.modelStatus;
  return {
    extension: browser.runtime.getManifest().version, firefox, policyKeys: await policyKeysSet(),
    // Where the policy comes from, never its values: a built-in file's name, and whether managed storage was ignored.
    policy: getPolicy ? await getPolicy().then((p) => ({ builtIn: p.builtIn, managed: p.managed, managedIgnored: p.managedIgnored, id: browser.runtime.getManifest().browser_specific_settings?.gecko?.id || null }), () => null) : null,
    library: lib ? { commit: lib.commit, syncedAt: lib.syncedAt, problems: lib.problems.map((p) => p.path), lastSync: local.library.lastSync ? { ok: local.library.lastSync.ok, at: local.library.lastSync.at } : null } : null,
    model: m ? { state: m.state, reason: m.reason, revision: m.revision, ms: m.ms } : null,
    gateway: session.gatewayStatus || null, webgpu: await webgpuInfo(), failures: session.capabilityFailures || {},
    storage: storage ? { usage: storage.usage || 0, quota: storage.quota || 0 } : null,
    siteRules,
  };
}

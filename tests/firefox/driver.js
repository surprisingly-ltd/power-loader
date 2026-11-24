import { config, results, test } from './harness.js';
import { workflow } from './workflow.js';
import { documents } from './documents.js';
import { network } from './network.js';
import { recovery, seedRecovery } from './recovery.js';
import { privacyModel } from './model.js';
import { profiles } from './profiles.js';

const runtimeErrors = globalThis.PowerLoaderTestErrors;
// Restored tabs from the previous browser run must not execute the next phase twice.
if (new URL(location.href).searchParams.get('testRun') === config.runId) {
  try {
    if (config.phase === 'main') {
      await workflow();
      await profiles();
      await network();
      await documents();
      await privacyModel();
    } else {
      await recovery();
    }
    await test('No uncaught extension-page errors', () => {
      if (runtimeErrors.length) throw new Error(runtimeErrors.join('\n'));
    });
    if (config.phase !== 'recovered-after-archive') await test('Persist the next restart checkpoint', seedRecovery);
  } catch (error) {
    results.push({ name: 'Test driver', ok: false, error: error.message, stack: error.stack });
  }
  await fetch(`${config.base}/result`, { method: 'POST', body: JSON.stringify({ phase: config.phase, results }) });
}

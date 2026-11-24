// Exports the demo flows that the site's "Try a flow" page offers for download, from the hosted demo
// library, with the extension's own code (lib/flows.js), so each file is what Flows → Import a flow expects.
// Pages come back untested on import by design: they are tested on the caseworker's computer.
import fs from 'node:fs/promises';
import path from 'node:path';
import '../extension/lib/extract.js'; // defines globalThis.PowerLoaderExtract, which the library checks use
import { indexLibrary } from '../extension/lib/library.js';
import { exportFlow, flowFileName, flowFromLibrary, validateFlow } from '../extension/lib/flows.js';
import { contentHash } from '../extension/lib/hash.js';

// The flows offered on the site: library form ids, and the name the flow gets.
export const DEMO_FLOWS = [
  { forms: ['dhp'], name: 'Discretionary housing payment' },
  { forms: ['hsr'], name: 'Housing support referral' },
];

export async function buildDemoFlows({ libraryDir, outDir, from }) {
  const manifest = JSON.parse(await fs.readFile(path.join(libraryDir, 'library.json'), 'utf8'));
  const files = {};
  for (const f of manifest.files) files[f.path] = JSON.parse(await fs.readFile(path.join(libraryDir, f.path), 'utf8'));
  const lib = indexLibrary({ commit: manifest.commit, message: manifest.message, files }, manifest);
  if (lib.problems.length) throw new Error(`Demo library problems: ${JSON.stringify(lib.problems)}`);
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  const written = [];
  for (const spec of DEMO_FLOWS) {
    const flow = flowFromLibrary(lib, spec.forms);
    flow.name = spec.name;
    flow.guidance = `A demo flow made from the Power Loader demo library (commit ${lib.commit}). It fills the ${spec.name} form from the fictional Northshire pages.`;
    // Only "not tested here" problems are expected: tests happen on the computer that imports the flow.
    const issues = validateFlow(flow);
    const unexpected = issues.filter((i) => i.level === 'error' && !/hasn’t been tested/.test(i.text));
    if (unexpected.length) throw new Error(`${spec.name}: ${unexpected.map((i) => i.text).join('; ')}`);
    const body = exportFlow(flow, issues);
    body.problems = [];
    body.exported = { from, date: new Date().toISOString().slice(0, 10), contentHash: await contentHash(body) };
    const name = flowFileName(flow);
    await fs.writeFile(path.join(outDir, name), `${JSON.stringify(body, null, 2)}\n`);
    written.push(name);
  }
  return written;
}

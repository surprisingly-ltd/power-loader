// Runs every prototype check in jsdom and fails if any script throws, reports page errors or prints FAIL.
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
const dir = new URL('.', import.meta.url).pathname;
let failed = 0;
for (const f of readdirSync(dir).filter(f => f.endsWith('.mjs') && f !== 'run-all.mjs').sort()) {
  let out = '';
  try { out = execFileSync(process.execPath, [dir + f], { encoding: 'utf8', timeout: 120000 }); }
  catch (e) { out = (e.stdout || '') + (e.stderr || '') + '\nThrew'; }
  const bad = /Threw|^FAIL|ERRORS2?: \[/m.test(out) || !/ERRORS: none/.test(out);
  if (bad) failed++;
  console.log(`${bad ? 'FAIL' : 'ok  '} ${f}`);
  if (bad) console.log(out.split('\n').filter(l => /FAIL|Error|ERRORS/.test(l)).slice(0, 5).join('\n'));
}
process.exit(failed ? 1 : 0);

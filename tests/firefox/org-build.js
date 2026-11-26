// Checks run inside an organisation build (tests/tools/firefox-org-build.mjs), in an extension tab: the page's
// CSP is the build's own. Results go back to the runner, which restarts Firefox for the second phase.
/* global browser */
import '../lib/extract.js';
import { getPolicy } from '../lib/policy.js';
import { startFlowCase, updateCase } from '../lib/core.js';
import { addClip } from '../lib/case.js';
import { syncLibrary } from '../lib/library-sync.js';

// The runner's own address, written into the background bootstrap when the package was staged.
const { orgBase: base } = await browser.storage.session.get('orgBase');
const other = base.replace('localhost', '127.0.0.1'); // the same server, under a host outside build.hosts
const { phase } = await (await fetch(`${base}/config`)).json();
const results = [];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await pause(100); }
  throw new Error(`Timed out: ${label}`);
}
async function check(name, fn) {
  try { const detail = await fn(); results.push({ name, ok: true, ...(detail ? { detail: String(detail) } : {}) }); } catch (e) { results.push({ name, ok: false, error: e.message }); }
}
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const journal = () => fetch(`${base}/journal`).then((r) => r.json());
const tryFetch = async (u) => { try { return (await fetch(u)).status; } catch (e) { return `blocked: ${e.message}`; } };

if (phase === 'install') {
  await check('the built-in policy is read, and managed storage is ignored', async () => {
    const p = await getPolicy({ fresh: true });
    assert(p.builtIn?.name === 'Example Council (test)', `builtIn ${JSON.stringify(p.builtIn)}`);
    assert(p.managedIgnored === true, 'managed storage was set for this add-on, so managedIgnored should be true');
    assert(p.values.gateway.baseUrl === null, `managed gateway.baseUrl leaked in: ${p.values.gateway.baseUrl}`);
    assert(p.values.gateway.enabled === false, 'gateway.enabled false from the file');
    const managed = await browser.storage.managed.get(null).catch((e) => `error: ${e.message}`);
    return `managed storage as Firefox gives it: ${JSON.stringify(managed)}`;
  });
  await check('build.hosts are granted at install, with nothing else grantable', async () => {
    const all = await browser.permissions.getAll();
    assert(all.origins.includes('http://localhost/*'), `granted origins: ${JSON.stringify(all.origins)}`);
    assert(!all.origins.includes('<all_urls>'), '<all_urls> granted');
    assert(!(await browser.permissions.contains({ origins: ['http://127.0.0.1/*'] })), '127.0.0.1 is granted');
    const m = browser.runtime.getManifest();
    assert(!m.optional_host_permissions?.length, `optional host permissions: ${JSON.stringify(m.optional_host_permissions)}`);
    let refused;
    try { refused = await browser.permissions.request({ origins: ['http://127.0.0.1/*'] }); } catch (e) { refused = `refused: ${e.message}`; }
    return `granted: ${all.origins.join(', ')}; asking for 127.0.0.1 (no click): ${refused}`;
  });
  await check('connect-src applies to the background’s fetch', async () => {
    const bg = await until(async () => (await browser.storage.session.get('orgBackgroundFetch')).orgBackgroundFetch, 'background fetches');
    assert(bg[`${base}/cors`] === 200, `allowed host: ${bg[`${base}/cors`]}`);
    assert(String(bg[`${other}/cors`]).startsWith('blocked'), `host outside build.hosts: ${bg[`${other}/cors`]}`);
    return JSON.stringify(bg);
  });
  await check('connect-src applies to an extension page and to a worker', async () => {
    const page = { allowed: await tryFetch(`${base}/cors`), outside: await tryFetch(`${other}/cors`) };
    assert(page.allowed === 200 && String(page.outside).startsWith('blocked'), `page ${JSON.stringify(page)}`);
    const w = new Worker(browser.runtime.getURL('tests/org-worker.js'));
    const out = await new Promise((resolve) => { w.onmessage = (e) => resolve(e.data); w.postMessage([`${base}/cors`, `${other}/cors`]); });
    w.terminate();
    assert(out[`${base}/cors`] === 200 && String(out[`${other}/cors`]).startsWith('blocked'), `worker ${JSON.stringify(out)}`);
    return `page ${JSON.stringify(page)}; worker ${JSON.stringify(out)}`;
  });
  await check('the library synced by itself at install', async () => {
    const { library } = await until(async () => { const s = await browser.storage.local.get('library'); return s.library?.current ? s : null; }, 'library synced at install');
    return `commit ${library.current}, lastSync ${JSON.stringify(library.lastSync)}`;
  });
  await check('the library is read with the caseworker’s cookies (library.auth cookies)', async () => {
    const tab = await browser.tabs.create({ url: `${base}/login`, active: false });
    await until(async () => (await browser.tabs.get(tab.id)).status === 'complete', 'sign-in page');
    await browser.tabs.remove(tab.id);
    const before = (await journal()).length;
    const out = await syncLibrary();
    assert(out.ok, `sync: ${out.error}`);
    const req = (await journal()).slice(before).find((r) => r.path.endsWith('/library.json'));
    assert(req, 'no library.json request');
    return `cookies sent: ${req.cookie || '(none)'}`;
  });
  await check('Transformers.js, tesseract.js and pdf.js load and run under connect-src', async () => {
    const { env, AutoTokenizer } = await import('../vendor/transformers.min.js');
    assert(!!env.backends.onnx.wasm && typeof AutoTokenizer.from_pretrained === 'function', 'Transformers.js');
    const { ocrImage, stopOcr } = await import('../lib/reader/ocr.js');
    const canvas = document.createElement('canvas'); canvas.width = 700; canvas.height = 140;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 700, 140); ctx.fillStyle = 'black'; ctx.font = 'bold 60px sans-serif'; ctx.fillText('HELLO FIREFOX', 30, 90);
    const ocr = await ocrImage(canvas.toDataURL());
    await stopOcr();
    assert(ocr.text.includes('HELLO'), `OCR read: ${ocr.text}`);
    const pdfjs = await import('../vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = browser.runtime.getURL('vendor/pdfjs/pdf.worker.min.mjs');
    const text = '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 43>>stream\nBT /F1 12 Tf 10 100 Td (Hello Firefox) Tj ET\nendstream\nendobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF';
    const { openPdf, pdfText } = await import('../lib/reader/pdf.js');
    const pdf = await openPdf(pdfjs, new TextEncoder().encode(text));
    const pages = await pdfText(pdf);
    await pdf.destroy();
    assert(pages[0].text.includes('Hello Firefox'), 'PDF text');
    return `OCR: ${ocr.text.trim()}`;
  });
  await check('the privacy model’s server is reached at the allowed mirror under connect-src (Test connection)', async () => {
    const { modelSource, testModelServer } = await import('../lib/model-fetch.js');
    const before = (await journal()).length;
    const source = modelSource(await getPolicy(), null, {});
    const probe = await testModelServer(source);
    const asked = (await journal()).slice(before).filter((r) => r.path.startsWith('/model/'));
    assert(asked.length === probe.expected, `${asked.length} of ${probe.expected} files asked for: ${JSON.stringify(probe.files.map((f) => f.status))}`);
    const outside = await testModelServer({ ...source, filesUrl: `${other}/model/pf/`, allowed: null });
    assert(outside.files.every((f) => f.status === 'unreachable'), `outside build.hosts: ${JSON.stringify(outside.files.map((f) => f.status))}`);
    return `allowed mirror: ${probe.files.map((f) => f.http || f.status).join(', ')}; a mirror outside build.hosts: unreachable (CSP)`;
  });
  await check('capture off by the organisation: no permission for it, refused, and locked in Settings', async () => {
    const m = browser.runtime.getManifest();
    assert(!(m.permissions || []).includes('activeTab') && !(m.permissions || []).includes('menus') && !m.commands, `permissions ${JSON.stringify(m.permissions)}`);
    assert(typeof browser.tabs.captureVisibleTab !== 'function', 'tabs.captureVisibleTab is offered');
    assert(!browser.menus, 'the page menu is offered');
    const { assertTool } = await import('../lib/tools.js');
    let refused = null;
    try { await assertTool('capture'); } catch (e) { refused = e.message; }
    assert(/organisation has turned off select a region/i.test(refused || ''), `refused: ${refused}`);
    const { renderSettings } = await import('../sidebar/settings.js');
    const root = document.createElement('div');
    root.append(...renderSettings({ data: { policy: await getPolicy(), settings: (await browser.storage.local.get('settings')).settings || {}, access: [] }, ui: {}, act: { refresh() {}, openPage() {} } }).flat().filter(Boolean));
    const box = root.querySelector('[data-key=tool-capture]');
    assert(box && !box.checked && box.disabled, 'the Settings switch is off and locked');
    return `refused: ${refused}`;
  });
  await check('storage.session: how much it holds (reported, for clear on close step 2)', async () => {
    const sizes = {};
    for (const mb of [1, 5, 9, 9.9, 10, 30]) {
      try {
        const n = Math.round(mb * 1024 * 1024);
        await browser.storage.session.set({ quotaProbe: 'x'.repeat(n) });
        const back = (await browser.storage.session.get('quotaProbe')).quotaProbe;
        sizes[`${mb} MiB`] = back.length === n ? 'ok' : 'truncated';
      } catch (e) { sizes[`${mb} MiB`] = `refused: ${e.message}`; }
    }
    await browser.storage.session.remove('quotaProbe');
    return JSON.stringify(sizes);
  });
  await check('a case is open with values when Firefox closes', async () => {
    const c = await startFlowCase(null, { ref: 'ORG-CLOSE-TEST', libraryPath: 'flows/discretionary-housing-payment.flow.json' });
    await updateCase(c.id, (cs, lib) => addClip(cs, lib, { id: 'synthetic', name: 'Synthetic', kind: 'document', values: { firstName: 'SYNTHETIC-CLOSE' }, records: [], capturedAt: new Date().toISOString(), url: `${base}/demo/x.html`, profile: { id: 'qa', version: 'v1' }, quotes: {} }));
    const s = await browser.storage.local.get(['case', 'settings']);
    assert(s.case?.id === c.id, 'case stored');
    await browser.storage.local.set({ orgCloseTest: { caseId: c.id, libraryRequests: (await journal()).filter((r) => r.path.endsWith('/library.json')).length } });
    return `case ${c.id}`;
  });
} else if (phase === 'capture') {
  await check('capture on, fixed hosts: activeTab, the page menu and the command, and the hosts unchanged', async () => {
    const m = browser.runtime.getManifest();
    assert(m.permissions.includes('activeTab') && m.permissions.includes('menus') && m.commands?.['select-region'], `permissions ${JSON.stringify(m.permissions)}`);
    const all = await browser.permissions.getAll();
    assert(JSON.stringify(all.origins) === JSON.stringify(['http://localhost/*']), `origins ${JSON.stringify(all.origins)}`);
    return `permissions ${m.permissions.join(', ')}; origins ${all.origins.join(', ')}`;
  });
  await check('capture from the page’s right-click menu: the box is drawn, and the tab is captured', async () => {
    await until(async () => (await browser.storage.local.get('library')).library?.current, 'library');
    await startFlowCase(null, { ref: 'ORG-CAPTURE-TEST', libraryPath: 'flows/discretionary-housing-payment.flow.json' });
    const tab = await browser.tabs.create({ url: `${base}/demo/client-1042.html`, active: true });
    await until(async () => (await browser.tabs.get(tab.id)).status === 'complete', 'demo page');
    await pause(800);
    let before;
    try { await browser.tabs.captureVisibleTab(tab.windowId, { format: 'png' }); before = 'captured'; } catch (e) { before = e.message; }
    assert(/activeTab/.test(before), `before the menu, capture should be refused: ${before}`);
    const menu = await (await fetch(`${base}/act/menu`)).text();
    assert(menu === 'clicked', `menu: ${menu}`);
    const overlay = () => browser.scripting.executeScript({ target: { tabId: tab.id }, func: () => !!document.querySelector('[data-powerloader=region]') }).then((r) => r[0].result, () => false);
    await until(overlay, 'the region box on the page (the sidebar opened and started selecting)', 20000);
    await fetch(`${base}/act/enter`);
    await until(async () => !(await overlay()), 'the box taken');
    await pause(3000);
    const { capabilityFailures = {} } = await browser.storage.session.get('capabilityFailures');
    assert(!capabilityFailures['reader-region'], `region capture failed: ${JSON.stringify(capabilityFailures)}`);
    const after = (await browser.tabs.captureVisibleTab(tab.windowId, { format: 'png' })).slice(0, 22);
    assert(after.startsWith('data:image/png'), after);
    return `before the menu: “${before}”; after it: captured, no failure recorded`;
  });
} else {
  await check('the case open at close is gone at the next start, with a receipt and a log entry', async () => {
    const { orgCloseTest } = await browser.storage.local.get('orgCloseTest');
    assert(orgCloseTest, 'the first phase left its note');
    const s = await until(async () => { const x = await browser.storage.local.get(null); return x.case === null && x.receipt ? x : null; }, 'case cleared at start');
    assert(s.receipt.outcome === 'closed', `receipt ${JSON.stringify(s.receipt)}`);
    assert(s.processLog.at(-1).outcome === 'closed' && s.processLog.at(-1).case_id === orgCloseTest.caseId, 'log entry');
    assert(!JSON.stringify(s).includes('SYNTHETIC-CLOSE'), 'a value survived');
    return `receipt counts ${JSON.stringify(s.receipt.counts)}`;
  });
  await check('the library synced by itself at start', async () => {
    const { orgCloseTest } = await browser.storage.local.get('orgCloseTest');
    const n = await until(async () => { const k = (await journal()).filter((r) => r.path.endsWith('/library.json') && r.phase === 'restart').length; return k || null; }, 'a library.json request after the restart');
    return `${n} library.json request(s) after the restart (${orgCloseTest.libraryRequests} before it)`;
  });
  await check('a case left without use past its time (4 hours, fixed) is deleted, and the receipt says why', async () => {
    await until(async () => (await browser.storage.local.get('library')).library?.current, 'library');
    const c = await startFlowCase(null, { ref: 'ORG-EXPIRY-TEST', libraryPath: 'flows/discretionary-housing-payment.flow.json' });
    await updateCase(c.id, (cs, lib) => addClip(cs, lib, { id: 'synthetic-2', name: 'Synthetic', kind: 'document', values: { firstName: 'SYNTHETIC-EXPIRY' }, records: [], capturedAt: new Date().toISOString(), url: `${base}/demo/x.html`, profile: { id: 'qa', version: 'v1' }, quotes: {} }));
    // Moved back in time instead of waiting: last used five hours ago.
    const { case: open, storageRevision } = await browser.storage.local.get(['case', 'storageRevision']);
    await browser.storage.local.set({ case: { ...open, touchedAt: new Date(Date.now() - 5 * 3600_000).toISOString() }, storageRevision: (storageRevision || 0) + 1 });
    const s = await until(async () => { const x = await browser.storage.local.get(null); return x.case === null && x.receipt?.outcome === 'expired' ? x : null; }, 'the background deleted the case');
    assert(s.receipt.hours === 4, `receipt ${JSON.stringify(s.receipt)}`);
    assert(s.processLog.at(-1).outcome === 'expired', 'log entry');
    assert(!JSON.stringify(s).includes('SYNTHETIC-EXPIRY'), 'a value survived');
    const { closedReceipt } = await import('../sidebar/close-warning.js');
    return closedReceipt(s.receipt).map((n) => n.textContent).join(' ');
  });
  await check('the alarm for the hourly sync is set', async () => {
    const a = await browser.alarms.get('library-sync');
    assert(a?.periodInMinutes === 60, JSON.stringify(a));
    return `every ${a.periodInMinutes} minutes`;
  });
}
await fetch(`${base}/result`, { method: 'POST', body: JSON.stringify({ phase, results }) });

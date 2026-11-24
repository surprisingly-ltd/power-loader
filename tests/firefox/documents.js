import { test, assert, equal, rejects } from './harness.js';
import { makePdf } from './pdf-fixture.js';
import { openPdf, pdfText, LIMITS } from '../../lib/reader/pdf.js';
import { classify, imageForOcr, renderPage } from '../../lib/reader/sources.js';
import { ocrImage, stopOcr } from '../../lib/reader/ocr.js';
import * as pdfjs from '../../vendor/pdfjs/pdf.min.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = browser.runtime.getURL('vendor/pdfjs/pdf.worker.min.mjs');
function picture() {
  const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 300;
  const context = canvas.getContext('2d');
  context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = 'black'; context.font = 'bold 90px sans-serif'; context.fillText('HELLO FIREFOX', 50, 180);
  return canvas;
}
export async function documents() {
  await test('PDF text and rotated pages are read by the real PDF worker', async () => {
    const doc = await openPdf(pdfjs, makePdf([{ text: 'Synthetic document one' }, { text: 'Synthetic rotated document two', rotate: 90 }]));
    try {
      const pages = await pdfText(doc);
      equal(pages.length, 2, 'Both pages read');
      assert(pages[0].text.includes('Synthetic document one') && !pages[0].scan, 'Text page recognised');
      assert(pages[1].text.includes('Synthetic rotated document two') && !pages[1].scan, 'Rotated text page recognised');
    } finally { await doc.destroy(); }
  });
  await test('Scanned PDFs render locally and OCR returns synthetic text', async () => {
    const canvas = picture();
    const image = Uint8Array.from(atob(canvas.toDataURL('image/jpeg').split(',')[1]), (value) => value.charCodeAt(0));
    const doc = await openPdf(pdfjs, makePdf([{ image, width: canvas.width, height: canvas.height }]));
    try {
      const [page] = await pdfText(doc);
      assert(page.scan, 'Image-only PDF marked for OCR');
      const blob = await renderPage(page.page);
      const result = await ocrImage(await imageForOcr(blob));
      assert(/HELLO\s+FIREFOX/.test(result.text), `Scanned PDF OCR: ${result.text}`);
      assert(result.lines.length > 0, 'OCR returns line-level evidence');
    } finally { await stopOcr(); await doc.destroy(); }
  });
  await test('Picture OCR supports cancellation and restarts after stopping', async () => {
    const data = picture().toDataURL();
    const controller = new AbortController(); controller.abort();
    await rejects(() => ocrImage(data, { signal: controller.signal }), /AbortError/);
    await stopOcr();
    const result = await ocrImage(data);
    assert(/HELLO\s+FIREFOX/.test(result.text), 'OCR restarted after cancellation');
    await stopOcr();
  });
  await test('Stopping OCR during worker startup cancels that job and permits a clean restart', async () => {
    const data = picture().toDataURL();
    const pending = ocrImage(data).then(() => 'completed', (error) => error.name);
    await stopOcr();
    equal(await pending, 'AbortError', 'Stopped startup must never return a result for the ended case');
    const next = await ocrImage(data);
    assert(/HELLO\s+FIREFOX/.test(next.text), 'A new case can start OCR');
    await stopOcr();
  });
  await test('Malformed, oversized and unsupported files fail with bounded errors', async () => {
    await rejects(() => openPdf(pdfjs, new TextEncoder().encode('%PDF- broken')), /corrupt/);
    await rejects(() => openPdf(pdfjs, new Uint8Array(LIMITS.bytes + 1)), /too-large/);
    await rejects(() => classify(new File(['no'], 'example.exe', { type: 'application/octet-stream' })), /unsupported/);
    await rejects(() => classify(new File([new Uint8Array(LIMITS.bytes + 1)], 'huge.pdf', { type: 'application/pdf' })), /too-large/);
    equal(await classify(new File(['%PDF-1.4'], 'renamed.bin')), 'pdf', 'PDF header overrides absent MIME');
  });
  await test('Password-protected PDFs fail safely and open only with the correct password', async () => {
    const fixture = await (await fetch(browser.runtime.getURL('tests/firefox/fixtures/password.pdf'))).arrayBuffer();
    await rejects(() => openPdf(pdfjs, new Uint8Array(fixture.slice(0))), /password/);
    await rejects(() => openPdf(pdfjs, new Uint8Array(fixture.slice(0)), { password: 'wrong-password' }), /password/);
    const doc = await openPdf(pdfjs, new Uint8Array(fixture.slice(0)), { password: 'test-password' });
    try { assert((await pdfText(doc))[0].text.includes('Synthetic password protected document'), 'Correct password decrypts actual PDF text'); }
    finally { await doc.destroy(); }
  });
  await test('Large PDFs require explicit bounded page selection', async () => {
    const doc = await openPdf(pdfjs, makePdf(Array.from({ length: 21 }, (_, i) => ({ text: `Synthetic page ${i + 1}` }))));
    try {
      await rejects(() => pdfText(doc), /too-many-pages/);
      const pages = await pdfText(doc, { pages: [1, 5] });
      equal(pages.map((page) => page.n), [1, 2, 3, 4, 5], 'Only selected pages read');
      // Even a caller-supplied range must not bypass the document resource limit.
      await rejects(() => pdfText(doc, { pages: [1, 21] }), /too-many-pages/);
      await rejects(() => pdfText(doc, { pages: [0, 1] }), /pages|range/i);
    } finally { await doc.destroy(); }
  });
}

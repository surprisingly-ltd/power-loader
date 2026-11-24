// OCR on this computer with tesseract.js, from the extension's own copy: no CDN, no blob workers.
/* global browser */

let worker = null;
let starting = null;
let generation = 0;
const jobs = new Set();
const cancelled = () => new DOMException('Cancelled', 'AbortError');

async function ensureWorker(onProgress) {
  if (worker) return worker;
  if (!starting) {
    const current = generation;
    const attempt = (async () => {
      const { default: { createWorker } } = await import('../../vendor/tesseract/tesseract.esm.min.js');
      if (current !== generation) throw cancelled();
      const base = browser.runtime.getURL('vendor/');
      const created = await createWorker('eng', 1, {
        workerPath: `${base}tesseract/worker.min.js`, corePath: `${base}tesseract/`, langPath: `${base}tessdata`,
        workerBlobURL: false, gzip: true, cacheMethod: 'none',
        logger: (m) => { if (m.status === 'recognizing text') onProgress?.(m.progress); },
      });
      if (current !== generation) { await created.terminate().catch(() => {}); throw cancelled(); }
      worker = created;
      return worker;
    })();
    starting = attempt;
    void attempt.finally(() => { if (starting === attempt) starting = null; }).catch(() => {});
  }
  return starting;
}

/** Lines of text with confidence (0–100) from an image, canvas or blob. */
export async function ocrImage(image, { page = 1, signal, onProgress } = {}) {
  signal?.throwIfAborted();
  let rejectCancelled;
  const stopped = new Promise((resolve, reject) => { rejectCancelled = reject; });
  jobs.add(rejectCancelled);
  const abort = () => { void stopOcr(); };
  signal?.addEventListener('abort', abort, { once: true });
  const current = generation;
  const work = (async () => {
    const w = await ensureWorker(onProgress);
    if (current !== generation) throw cancelled();
    const { data } = await w.recognize(image);
    signal?.throwIfAborted();
    if (current !== generation) throw cancelled();
    const lines = (data.lines || []).map((l) => ({ text: l.text.trim(), confidence: l.confidence, page, bbox: l.bbox })).filter((l) => l.text);
    return { lines, text: data.text || '', confidence: data.confidence };
  })();
  try { return await Promise.race([work, stopped]); }
  finally { jobs.delete(rejectCancelled); signal?.removeEventListener('abort', abort); }
}

// Cancelling a job, or the case ending, stops OCR at once by ending its worker.
export async function stopOcr() {
  generation++;
  starting = null;
  for (const reject of jobs) reject(cancelled());
  jobs.clear();
  const w = worker;
  worker = null;
  await w?.terminate().catch(() => {});
}

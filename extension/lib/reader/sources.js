// What the reader can take: pasted screenshots, dropped files and chosen files. Pictures are downscaled to at
// most 1600 px on the long side before OCR; PDF scans are rendered at about 200 dpi.
import { LIMITS, readerError } from './pdf.js';

const IMAGE = /^image\/(png|jpeg|webp|gif|bmp)$/;

export async function classify(file) {
  if (!file) throw readerError('none', 'Nothing to read');
  if (file.size > LIMITS.bytes) throw readerError('too-large', `This file is over ${LIMITS.bytes / 1024 / 1024} MB`);
  const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  if (String.fromCharCode(...head) === '%PDF-') return 'pdf';
  if (IMAGE.test(file.type || '')) return 'image';
  throw readerError('unsupported', 'Power Loader reads PDFs and pictures (PNG, JPEG, WebP, GIF, BMP)');
}

export async function imageForOcr(file, max = 1600) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.convertToBlob({ type: 'image/png' });
}

export async function renderPage(page, scale = 2.5) {
  const viewport = page.getViewport({ scale });
  const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  return canvas.convertToBlob({ type: 'image/png' });
}

/**
 * A picture to send to the AI as it is, when the caseworker chooses that: at most `max` px on the long side,
 * as a JPEG data URL (smaller than PNG for screenshots of documents). { url, width, height }.
 */
export async function imageForAi(file, max = 2000) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { url: `data:image/jpeg;base64,${btoa(bin)}`, width: canvas.width, height: canvas.height };
}

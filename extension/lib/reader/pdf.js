// Reading PDFs on this computer with pdf.js. Every page is checked on its own: a thin text layer on one
// page doesn't prove the others are readable, so pages with almost no text are treated as scans.

export const LIMITS = Object.freeze({ bytes: 25 * 1024 * 1024, pages: 20, firstPages: 5, scanChars: 20 });

export function readerError(reason, message, extra = {}) { return Object.assign(new Error(message), { reason, ...extra }); }

// Let the caller choose which pages to read when a document is over the page limit ("read pages 1–5").
export async function openPdf(pdfjs, bytes, { password } = {}) {
  if (bytes.byteLength > LIMITS.bytes) throw readerError('too-large', `This file is over ${LIMITS.bytes / 1024 / 1024} MB`);
  try {
    return await pdfjs.getDocument({ data: bytes, password, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
  } catch (e) {
    if (e?.name === 'PasswordException') throw readerError('password', 'This PDF is protected by a password. Open it in its viewer and use a screenshot instead, or ask for an unprotected copy.');
    throw readerError('corrupt', 'This file looks damaged, or isn’t a PDF Power Loader can read');
  }
}

/** Text of the chosen pages: [{ n, text, scan }]. pages: [first, last]; over the limit without it is an error. */
export async function pdfText(doc, { pages, signal, onPage } = {}) {
  if (!pages && doc.numPages > LIMITS.pages) throw readerError('too-many-pages', `This document has ${doc.numPages} pages, more than Power Loader reads at once`, { numPages: doc.numPages });
  const [first, last] = pages || [1, doc.numPages];
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first || last > doc.numPages) {
    throw readerError('page-range', 'Choose a valid range of pages in this document');
  }
  if (last - first + 1 > LIMITS.pages) throw readerError('too-many-pages', `Choose no more than ${LIMITS.pages} pages at once`, { numPages: doc.numPages });
  const out = [];
  for (let n = first; n <= Math.min(last, doc.numPages); n++) {
    signal?.throwIfAborted();
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    let text = '';
    for (const item of content.items) text += (item.str || '') + (item.hasEOL ? '\n' : ' ');
    text = text.replace(/[ \t]+\n/g, '\n').trim();
    out.push({ n, text, scan: text.replace(/\s/g, '').length < LIMITS.scanChars, page });
    onPage?.(n);
  }
  return out;
}

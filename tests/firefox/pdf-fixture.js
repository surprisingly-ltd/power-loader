// Minimal valid PDF writer for synthetic text, rotated and scanned-document regression fixtures.
const encode = (value) => typeof value === 'string' ? new TextEncoder().encode(value) : value;
function join(parts) {
  const bytes = parts.map(encode);
  const output = new Uint8Array(bytes.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of bytes) { output.set(part, offset); offset += part.length; }
  return output;
}
export function makePdf(pages, { encryptStream, encryptionDictionary, documentId } = {}) {
  const objects = [null, '<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = [];
  for (const page of pages) {
    const pageId = objects.length;
    const contentId = pageId + 1;
    const imageId = pageId + 2;
    kids.push(`${pageId} 0 R`);
    const commands = page.image ? `q 400 0 0 100 0 0 cm /Im1 Do Q` : `BT /F1 16 Tf 10 50 Td (${page.text.replace(/[()\\]/g, '\\$&')}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 100] /Rotate ${page.rotate || 0} /Resources << /Font << /F1 3 0 R >> ${page.image ? `/XObject << /Im1 ${imageId} 0 R >>` : ''} >> /Contents ${contentId} 0 R >>`);
    const content = encryptStream ? encryptStream(encode(commands), contentId) : encode(commands);
    objects.push(join([`<< /Length ${content.length} >>\nstream\n`, content, '\nendstream']));
    if (page.image) objects.push(join([`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.image.length} >>\nstream\n`, page.image, '\nendstream']));
  }
  objects[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`;
  const encryptionId = encryptionDictionary ? objects.push(encryptionDictionary) - 1 : null;
  const parts = [encode('%PDF-1.4\n')];
  const offsets = [0];
  let length = parts[0].length;
  for (let id = 1; id < objects.length; id++) {
    offsets.push(length);
    const part = join([`${id} 0 obj\n`, objects[id], '\nendobj\n']);
    parts.push(part); length += part.length;
  }
  parts.push(encode(`xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length} /Root 1 0 R ${encryptionId ? `/Encrypt ${encryptionId} 0 R /ID [<${documentId}><${documentId}>]` : ''} >>\nstartxref\n${length}\n%%EOF`));
  return join(parts);
}

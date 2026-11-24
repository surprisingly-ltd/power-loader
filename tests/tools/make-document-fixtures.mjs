// Deterministic synthetic encrypted PDF (Standard Security Handler revision 2) for password tests.
// RC4/MD5 here implement an old PDF format for compatibility testing, never application encryption.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { makePdf } from '../firefox/pdf-fixture.js';

const md5 = (...parts) => createHash('md5').update(Buffer.concat(parts)).digest();
const padding = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');
const padded = (value) => Buffer.concat([Buffer.from(value), padding]).subarray(0, 32);
function rc4(key, bytes) {
  const table = Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i++) { j = (j + table[i] + key[i % key.length]) & 255; [table[i], table[j]] = [table[j], table[i]]; }
  let i = 0; j = 0;
  return Buffer.from(bytes.map((value) => {
    i = (i + 1) & 255; j = (j + table[i]) & 255;
    [table[i], table[j]] = [table[j], table[i]];
    return value ^ table[(table[i] + table[j]) & 255];
  }));
}
const owner = rc4(md5(padded('synthetic-owner')).subarray(0, 5), padded('test-password'));
const id = md5(Buffer.from('Power Loader synthetic encrypted PDF'));
const permissions = Buffer.alloc(4); permissions.writeInt32LE(-4);
const key = md5(padded('test-password'), owner, permissions, id).subarray(0, 5);
const user = rc4(key, padding);
const bytes = makePdf([{ text: 'Synthetic password protected document' }], {
  encryptionDictionary: `<< /Filter /Standard /V 1 /R 2 /Length 40 /P -4 /O <${owner.toString('hex')}> /U <${user.toString('hex')}> >>`,
  documentId: id.toString('hex'),
  encryptStream: (plain, object) => {
    const suffix = Buffer.from([object & 255, object >> 8 & 255, object >> 16 & 255, 0, 0]);
    return rc4(md5(key, suffix).subarray(0, 10), plain);
  },
});
await fs.mkdir(new URL('../firefox/fixtures/', import.meta.url), { recursive: true });
await fs.writeFile(new URL('../firefox/fixtures/password.pdf', import.meta.url), bytes);

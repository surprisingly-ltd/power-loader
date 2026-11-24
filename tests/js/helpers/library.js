// The demo library as a stored set, read straight from demo/library/, and real extraction on demo pages.
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import '../../../extension/lib/extract.js';
import { indexLibrary } from '../../../extension/lib/library.js';

const read = (p) => readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8');
export const manifest = JSON.parse(read('demo/library/library.json'));

export function demoSet() {
  const files = Object.fromEntries(manifest.files.map((f) => [f.path, JSON.parse(read(`demo/library/${f.path}`))]));
  return { commit: manifest.commit, message: manifest.message, syncedAt: '2026-10-19T09:12:00Z', manifest, files };
}

export const demoLibrary = () => indexLibrary(demoSet());

export function extractDemo(lib, page, profileId) {
  const url = `http://localhost:8787/demo/${page}`;
  const doc = new JSDOM(read(`demo/${page}`), { url }).window.document;
  const profile = lib.profiles.find((p) => p.id === profileId);
  const res = globalThis.PowerLoaderExtract.extract(doc, profile, { baseUrl: url });
  return { profile, res: { ...res, url, title: doc.title } };
}

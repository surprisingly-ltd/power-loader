// Copies third-party runtime code into extension/vendor/ at build time. Manifest V3 forbids remotely hosted
// code, so nothing is loaded from a CDN: Transformers.js and the ONNX Runtime WASM it loads (privacy model),
// pdf.js (document text) and tesseract.js with its WASM core and English data (OCR on this computer).
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const out = fileURLToPath(new URL('../extension/vendor/', import.meta.url));
// Not every package exports package.json, so resolve the entry point and walk up to the package root.
function packageRoot(name, from) {
  const file = createRequire(from).resolve(name);
  return file.slice(0, file.lastIndexOf(path.join('node_modules', name)) + path.join('node_modules', name).length);
}
const here = import.meta.url;
const transformers = packageRoot('@huggingface/transformers', here);
// The upstream all-in-one bundle embeds a prerelease ORT, which AMO does not accept.
// Bundle the upstream web entry with the explicitly pinned release instead. Never patch library code.
const ort = packageRoot('onnxruntime-web', here);
const common = packageRoot('onnxruntime-common', path.join(ort, 'package.json'));
const embedded = ['@huggingface/jinja', '@huggingface/tokenizers'].map((name) => packageRoot(name, path.join(transformers, 'package.json')));
const pdfjs = packageRoot('pdfjs-dist', here);
const tesseract = packageRoot('tesseract.js', here);
const core = packageRoot('tesseract.js-core', here);
const eng = path.dirname(createRequire(here).resolve('@tesseract.js-data/eng/package.json'));

const files = [
  [path.join(ort, 'dist/ort-wasm-simd-threaded.asyncify.mjs'), 'ort-wasm-simd-threaded.asyncify.mjs'],
  [path.join(ort, 'dist/ort-wasm-simd-threaded.asyncify.wasm'), 'ort-wasm-simd-threaded.asyncify.wasm'],
  [path.join(pdfjs, 'legacy/build/pdf.min.mjs'), 'pdfjs/pdf.min.mjs'],
  [path.join(pdfjs, 'legacy/build/pdf.worker.min.mjs'), 'pdfjs/pdf.worker.min.mjs'],
  [path.join(tesseract, 'dist/tesseract.esm.min.js'), 'tesseract/tesseract.esm.min.js'],
  [path.join(tesseract, 'dist/worker.min.js'), 'tesseract/worker.min.js'],
  ...['tesseract-core-simd-lstm', 'tesseract-core-lstm'].flatMap((n) => [[path.join(core, `${n}.wasm.js`), `tesseract/${n}.wasm.js`], [path.join(core, `${n}.wasm`), `tesseract/${n}.wasm`], [path.join(core, `${n}.js`), `tesseract/${n}.js`]]),
  // tessdata "best_int": the integer LSTM English model, about 3 MB compressed.
  [path.join(eng, '4.0.0_best_int/eng.traineddata.gz'), 'tessdata/eng.traineddata.gz'],
];

const version = async (root) => JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const roots = [transformers, ort, pdfjs, tesseract, core, eng];
await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });
const bundle = await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  entryPoints: [path.join(transformers, 'dist/transformers.web.js')],
  outfile: path.join(out, 'transformers.min.js'),
  bundle: true, format: 'esm', platform: 'browser', target: 'firefox140',
  minify: true, legalComments: 'eof', metafile: true,
  alias: {
    'onnxruntime-web/webgpu': path.join(ort, 'dist/ort.webgpu.min.mjs'),
    'onnxruntime-common': common,
  },
});
// Fail rather than accidentally packaging the development runtime from Transformers' dependencies.
const inputs = Object.keys(bundle.metafile.inputs).sort();
if (inputs.some((p) => /onnxruntime[^/]*@[^/]*-dev\./.test(p))) throw new Error('A prerelease ONNX runtime entered the bundle');
const bundleHash = createHash('sha256').update(await fs.readFile(path.join(out, 'transformers.min.js'))).digest('hex');
await fs.writeFile(path.join(out, 'BUNDLE.json'), JSON.stringify({
  file: 'transformers.min.js', sha256: bundleHash, inputs,
  rebuild: 'pnpm install --frozen-lockfile && pnpm vendor',
  packages: { '@huggingface/transformers': await version(transformers), 'onnxruntime-web': await version(ort), 'onnxruntime-common': await version(common) },
}, null, 2) + '\n');
// One line per file, so a reviewer can check each against the published npm release by checksum.
const sources = [`vendor/transformers.min.js\t${bundleHash}\tGenerated: Transformers.js ${await version(transformers)} + ONNX Runtime ${await version(ort)}; see BUNDLE.json and tools/vendor.mjs\thttps://github.com/huggingface/transformers.js/tree/${await version(transformers)}`];
// Preserve the upstream licenses alongside the runtime files.
for (const root of [...roots, common, ...embedded]) {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  for (const file of await fs.readdir(root)) {
    if (!/^(license|notice|copying)(\.|$)/i.test(file)) continue;
    const dest = path.join(out, 'licenses', pkg.name.replaceAll('/', '__'), file);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(path.join(root, file), dest);
  }
}
// The ONNX npm packages omit their repository's license file.
await fs.copyFile(fileURLToPath(new URL('licenses/onnxruntime-LICENSE.txt', import.meta.url)), path.join(out, 'licenses/onnxruntime-LICENSE.txt'));
await fs.writeFile(path.join(out, 'licenses/PACKAGES.json'), JSON.stringify(await Promise.all([...roots, common, ...embedded].map(async (root) => {
  const { name, version, license, repository } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  return { name, version, license, repository };
})), null, 2) + '\n');
for (const [from, name] of files) {
  await fs.mkdir(path.dirname(path.join(out, name)), { recursive: true });
  await fs.copyFile(from, path.join(out, name));
  const root = roots.find((r) => from.startsWith(r + path.sep));
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const inPkg = path.relative(root, from).split(path.sep).join('/');
  const sha = createHash('sha256').update(await fs.readFile(from)).digest('hex');
  sources.push(`vendor/${name}\t${sha}\t${pkg.name}@${pkg.version}/${inPkg}\thttps://cdn.jsdelivr.net/npm/${pkg.name}@${pkg.version}/${inPkg}`);
  process.stdout.write(`vendor/${name}\n`);
}
await fs.writeFile(path.join(out, 'SOURCES.tsv'), ['file\tsha256\tnpm\turl', ...sources, ''].join('\n'));
await fs.writeFile(path.join(out, 'VERSION'), [
  `@huggingface/transformers ${await version(transformers)}`, `onnxruntime-web ${await version(ort)}`, `pdfjs-dist ${await version(pdfjs)}`,
  `tesseract.js ${await version(tesseract)}`, `tesseract.js-core ${await version(core)}`, `@tesseract.js-data/eng ${await version(eng)} (4.0.0_best_int)`, '',
].join('\n'));


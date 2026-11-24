import { config, test, assert, equal, rejects } from './harness.js';
import { loadModel, scanText, stopWorker } from '../../lib/privacy-client.js';
import { DEFAULT_MODEL, verifyingFetch } from '../../lib/model-fetch.js';

export async function privacyModel() {
  await test('Rebuilt Transformers bundle loads under the real extension CSP', async () => {
    const { env, AutoTokenizer } = await import('../../vendor/transformers.min.js');
    assert(env.backends.onnx.wasm && typeof AutoTokenizer.from_pretrained === 'function', 'Runtime and tokenizer exports load');
  });
  await test('Model files reject unknown paths, bad hashes and an unavailable mirror', async () => {
    const source = { baseUrl: `${config.base}/model/`, modelId: 'synthetic', revision: 'pinned', hashes: { 'config.json': '0'.repeat(64) } };
    // Use actual response streaming and hashing; the server is local and holds no model weights.
    const checked = verifyingFetch(source, async () => new Response('tampered file'));
    await rejects(async () => (await checked(`${source.baseUrl}synthetic/resolve/pinned/config.json`)).text(), /hash|match|AbortError/);
    await rejects(() => checked(`${source.baseUrl}synthetic/resolve/pinned/unknown.json`), /expected hash/);
    const response = await verifyingFetch(source)(`${source.baseUrl}synthetic/resolve/pinned/config.json`);
    equal(response.status, 503, 'Mirror outage propagated without accepting model files');
  });
  await test('Privacy worker reports unavailable hardware or model server failure', async () => {
    const result = await loadModel({ ...DEFAULT_MODEL, baseUrl: `${config.base}/model/` });
    equal(result.state, 'failed', 'Unavailable local model cannot become ready');
    assert(['webgpu', 'load', 'unreachable'].includes(result.reason), `Actionable failure reason: ${result.reason}`);
    stopWorker();
  });
  if (config.modelEnabled) {
    await test('Pinned privacy model loads on WebGPU and scans synthetic personal data', async () => {
      const cold = await loadModel(DEFAULT_MODEL);
      equal(cold.state, 'ready', `Privacy model must load on target hardware: ${cold.reason || cold.message || ''}`);
      const text = 'Maria Kowalska lives at Flat 3, 12 Mill Lane, Northtown.';
      const spans = await scanText(text);
      assert(spans.some((span) => span.label === 'private_person'), 'Name detected');
      assert(spans.some((span) => span.label === 'private_address'), 'Address detected');
      for (const span of spans) equal(text.slice(span.start, span.end), span.text, 'Model span aligns with original text');
      stopWorker();
      const warm = await loadModel(DEFAULT_MODEL);
      equal(warm.state, 'ready', 'Worker reload uses verified cached model');
      stopWorker();
    });
  }
}

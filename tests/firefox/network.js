import { config, test, assert, equal, rejects, until, button, control, journal } from './harness.js';
import { complete } from '../../lib/ai/client.js';
import { prepare, approve, previewBeforeSend } from '../../lib/ai/boundary.js';
import { effectiveSettings } from '../../lib/privacy-detect.js';
import { fetchLibrary, syncLibrary } from '../../lib/library-sync.js';
import { runTask } from '../../lib/ai/tasks.js';

const context = { known: [{ category: 'person_name', text: 'Synthetic Citizen' }], patterns: [], settings: effectiveSettings(), model: { ready: false, required: false } };
const request = { purpose: 'test', title: 'Synthetic network privacy check', parts: [{ id: 'text', kind: 'text', text: 'Synthetic Citizen requests help.' }], compose: (sent) => [{ role: 'user', content: sent.text }] };
const gatewayCalls = async () => (await journal()).filter((entry) => entry.path.startsWith('/gateway/'));
const ai = () => ({ baseUrl: `${config.base}/gateway/v1`, model: 'synthetic', auth: 'bearer', apiKey: 'synthetic-key', requestTimeoutMs: 1000 });

export async function network() {
  await test('Unapproved payloads and cancelled preview make zero gateway requests', async () => {
    const before = (await gatewayCalls()).length;
    await rejects(() => complete({ messages: request.compose({ text: 'UNAPPROVED' }) }, ai()), /approved/);
    const pending = previewBeforeSend(request, context);
    const dialog = await until(() => document.querySelector('[role=dialog]'), 'real redaction preview');
    button('Cancel', dialog).click();
    equal(await pending, null, 'Cancelled preview returns no payload');
    equal((await gatewayCalls()).length, before, 'Nothing transmitted');
  });
  await test('The real preview sends only approved redacted text and omits browser cookies', async () => {
    const pending = previewBeforeSend(request, context);
    const dialog = await until(() => document.querySelector('[role=dialog]'), 'redaction preview');
    button(/^✦ Send /, dialog).click();
    const payload = await pending;
    assert(payload, 'Preview approved');
    equal(await complete(payload, ai()), 'OK', 'Gateway response');
    const sent = (await gatewayCalls()).at(-1);
    assert(!sent.body.includes('Synthetic Citizen'), 'Original name never left Firefox');
    assert(sent.body.includes('<redacted:'), 'Placeholders were sent');
    equal(JSON.parse(sent.body).messages, payload.messages, 'Request matches immutable approved payload');
    equal(sent.authorization, 'Bearer synthetic-key', 'Dedicated virtual key sent to configured gateway');
    equal(sent.cookie, '', 'Browser cookie omitted');
  });
  await test('A required unavailable model disables Send in the real preview', async () => {
    const before = (await gatewayCalls()).length;
    const pending = previewBeforeSend(request, { ...context, model: { ready: false, required: true } });
    const dialog = await until(() => document.querySelector('[role=dialog]'), 'blocked preview');
    assert(button(/^✦ Send /, dialog).disabled, 'Unavailable required model blocks approval');
    button('Cancel', dialog).click();
    await pending;
    equal((await gatewayCalls()).length, before, 'Blocked preview never transmits');
  });
  await test('Gateway redirects never forward the request or credentials', async () => {
    await control({ gateway: 'redirect' });
    const payload = approve(prepare(request, context));
    await rejects(() => complete(payload, ai()), /Could not reach/);
    assert(!(await journal()).some((entry) => entry.path.startsWith('/sink/')), 'Redirect destination was never contacted');
    await control({ gateway: 'ok' });
  });
  await test('Automatic retries send the exact same approved payload', async () => {
    await control({ gateway: 'ok', gatewayFailures: 2, gatewayReply: '{"answer":"OK","items":[]}' });
    const before = (await gatewayCalls()).length;
    const pending = runTask('calc', { question: 'Synthetic Citizen requests a total', amounts: [] }, {
      lib: { fields: {} }, context: async () => context, config: ai(),
    });
    const dialog = await until(() => document.querySelector('[role=dialog]'), 'retry request preview');
    button(/^✦ Send /, dialog).click();
    await pending;
    const sent = (await gatewayCalls()).slice(before);
    equal(sent.length, 3, 'Two failures then success');
    assert(sent.every((entry) => entry.body === sent[0].body), 'All retries send identical approved bytes');
    assert(sent.every((entry) => !entry.body.includes('Synthetic Citizen')), 'Every retry remains redacted');
    await control({ gatewayReply: null });
  });
  await test('Cancellation, timeouts, auth failures and bad responses fail safely', async () => {
    const payload = approve(prepare(request, context));
    const before = (await gatewayCalls()).length;
    const controller = new AbortController(); controller.abort();
    await rejects(() => complete(payload, ai(), { signal: controller.signal }), /AbortError/);
    equal((await gatewayCalls()).length, before, 'Already-cancelled requests never transmit');
    for (const [mode, pattern] of [['denied', /API key rejected/], ['invalid', /valid JSON/], ['large', /too large/], ['hang', /TimeoutError/]]) {
      await control({ gateway: mode });
      const error = await rejects(() => complete(payload, { ...ai(), requestTimeoutMs: 150 }), pattern);
      assert(!error.message.includes('synthetic-key'), 'Server response and credentials excluded from error');
    }
    await control({ gateway: 'ok' });
  });
  await test('Corrupt and denied library updates retain the last good commit', async () => {
    const before = (await browser.storage.local.get('library')).library;
    assert(before?.current, 'A known-good library exists');
    for (const mode of ['corrupt', 'denied']) {
      await control({ library: mode });
      const outcome = await syncLibrary();
      assert(!outcome.ok, `${mode} update must fail`);
      const after = (await browser.storage.local.get('library')).library;
      equal(after.current, before.current, 'Current commit retained');
      equal(after.sets[before.current], before.sets[before.current], 'Verified library bytes retained');
    }
    await control({ library: 'ok' });
  });
  await test('Library redirects cannot forward the managed bearer token', async () => {
    await control({ library: 'redirect' });
    await rejects(() => fetchLibrary({ baseUrl: `${config.base}/demo/library/`, branch: 'main', auth: 'token', token: 'synthetic-library-key' }), /Couldn’t reach/);
    assert(!(await journal()).some((entry) => entry.path.startsWith('/sink/')), 'Library redirect destination never requested');
    await control({ library: 'ok' });
  });
}

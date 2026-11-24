// Settings → ✦ Enhanced tools: the organisation's AI gateway. Values set by policy are shown locked.
/* global browser */
import { h, announce, describeError } from '../ui/dom.js';
import { AI_ACK, AI_ACK_TEXT, aiAcknowledged, connectionConfig, endpointPattern, forgetCredential, getCredential, saveCredential, validateAI } from '../lib/ai/settings.js';
import { saveSettings } from '../lib/core.js';
import { complete } from '../lib/ai/client.js';
import { approve, prepare } from '../lib/ai/boundary.js';
import { effectiveSettings } from '../lib/privacy-detect.js';

export function aiSettingsCard({ data, act }) {
  const settings = data.settings || {};
  const ai = { ...(settings.ai || {}) };
  const policy = data.policy?.values?.gateway || {};
  const locked = { baseUrl: data.policy?.locked?.has('gateway.baseUrl'), model: data.policy?.locked?.has('gateway.model') };
  if (locked.baseUrl) ai.baseUrl = policy.baseUrl;
  if (locked.model) ai.model = policy.model;
  const form = data.aiForm || (data.aiForm = { baseUrl: ai.baseUrl || '', model: ai.model || 'fast', key: '', remember: false, consent: aiAcknowledged(settings) });
  const status = h('p', { class: 'small', role: 'status', 'aria-live': 'polite' }, data.aiStatus || '');
  const field = (label, key, attrs = {}) => h('label', { class: 'field' }, label, h('input', { ...attrs, 'data-key': `ai-${key}`, value: form[key], oninput: (e) => { form[key] = e.target.value; } }));
  const save = () => {
    let next;
    try {
      if (!form.consent) throw new Error('Tick the box to confirm you understand what is sent to the remote AI, and that you have checked it is allowed');
      next = validateAI({ ...ai, baseUrl: form.baseUrl, model: form.model, auth: 'bearer' });
    } catch (e) { status.textContent = describeError(e); return; }
    // The permission request must happen during the click itself.
    const permission = browser.permissions.request({ origins: [endpointPattern(next.baseUrl)] });
    void (async () => {
      try {
        if (!await permission) throw new Error('Gateway permission was not granted');
        const existing = await getCredential(next.baseUrl);
        if (!form.key.trim() && !existing) throw new Error('Enter this extension’s gateway key');
        if (next.baseUrl !== ai.baseUrl) await forgetCredential();
        await saveCredential(next.baseUrl, form.key.trim() || existing.key, form.remember);
        await saveSettings({ ai: next, aiConsent: AI_ACK, aiConsentAt: new Date().toISOString() });
        form.key = '';
        data.aiStatus = 'Saved. ✦ actions use this remote AI, always after the preview.';
        announce('Gateway settings saved');
      } catch (e) { data.aiStatus = describeError(e); }
      act.refresh();
    })();
  };
  // One request with synthetic text, through the same boundary as every other request.
  const testGateway = async () => {
    status.textContent = 'Testing the gateway…';
    try {
      const config = await connectionConfig();
      const payload = approve(prepare({ purpose: 'test', parts: [{ id: 't', kind: 'text', text: 'Reply with OK.' }], compose: (s) => [{ role: 'user', content: s.t }] },
        { known: [], patterns: [], settings: effectiveSettings(), model: { ready: true, required: false } }));
      await complete(payload, config);
      data.aiStatus = `Gateway reachable. Model: ${config.model}`;
      await browser.storage.session.set({ gatewayStatus: { ok: true, status: 200, at: new Date().toISOString() } }).catch(() => {});
    } catch (e) {
      data.aiStatus = describeError(e);
      await browser.storage.session.set({ gatewayStatus: { ok: false, status: /HTTP (\d+)/.exec(e.message)?.[1] || (/rejected/.test(e.message) ? '401' : /denied/.test(e.message) ? '403' : null), at: new Date().toISOString() } }).catch(() => {});
    }
    act.refresh();
  };
  const on = aiAcknowledged(settings) && settings.ai?.baseUrl;
  return h('div', { class: 'card' },
    h('div', { class: 'row between' }, h('h2', {}, '✦ Remote AI'), locked.baseUrl ? h('span', { class: 'pill' }, '🔒 Set by your organisation') : on ? h('span', { class: 'pill ok' }, 'On') : h('span', { class: 'pill' }, 'Off')),
    h('p', { class: 'small muted' }, 'An OpenAI-compatible chat completions endpoint, such as your organisation’s AI gateway. It powers the ✦ buttons, including asking for a page profile instead of using the on-device model. Nothing is sent until you press an ✦ button and check the preview, with personal data replaced by placeholders. Standard tools never leave this browser.'),
    field('Endpoint address (including /v1)', 'baseUrl', { type: 'url', disabled: locked.baseUrl, placeholder: 'https://gateway.example.gov.uk/v1' }),
    field('Model name', 'model', { type: 'text', disabled: locked.model }),
    h('label', { class: 'field' }, 'API key', h('span', { class: 'hint' }, 'This extension’s own key, such as a virtual key from IT. Never a personal or provider account key.'),
      h('input', { type: 'password', autocomplete: 'new-password', 'data-key': 'ai-key', value: form.key, oninput: (e) => { form.key = e.target.value; } })),
    h('label', { class: 'check small' }, h('input', { type: 'checkbox', 'data-key': 'ai-remember', checked: form.remember, onchange: (e) => { form.remember = e.target.checked; } }),
      h('span', {}, 'Remember the key in this browser (otherwise it lasts for this session)')),
    h('div', { class: 'notice warn' },
      h('label', { class: 'check small' }, h('input', { type: 'checkbox', 'data-key': 'ai-consent', checked: form.consent, onchange: (e) => { form.consent = e.target.checked; } }),
        h('span', {}, AI_ACK_TEXT))),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'primary sm', 'data-key': 'ai-save', onclick: save }, on ? 'Save' : 'Turn on the remote AI'),
      h('button', { type: 'button', class: 'sm', 'data-key': 'ai-test', onclick: testGateway }, 'Test the connection'),
      on && !locked.baseUrl ? h('button', { type: 'button', class: 'sm', 'data-key': 'ai-off', onclick: async () => { await saveSettings({ aiConsent: null }); form.consent = false; data.aiStatus = 'Remote AI turned off. Nothing will be sent.'; act.refresh(); } }, 'Turn off') : null,
      h('button', { type: 'button', class: 'sm', 'data-key': 'ai-forget', onclick: async () => { await forgetCredential(); data.aiStatus = 'Key forgotten.'; act.refresh(); } }, 'Forget key')),
    status);
}

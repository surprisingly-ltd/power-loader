// The Privacy tab (it works with or without a library), the redaction preview every ✦ action goes through, and the ✦ actions themselves.
import { h, plural, announce, copyText, describeError } from '../ui/dom.js';
import { openDialog } from '../ui/dialog.js';
import { CATEGORIES, GROUPS, shortToken, token } from '../lib/pii.js';
import { effectiveSettings, knownValues, patternsFor } from '../lib/privacy-detect.js';
import { registerPresenter, approve as approvePayload, prepare, review as reviewState } from '../lib/ai/boundary.js';
import { runTask } from '../lib/ai/tasks.js';
import { aiReady, connectionConfig } from '../lib/ai/settings.js';
import { modelSource, normalizeModelUrl } from '../lib/model-fetch.js';
import { describeModel, loadModel, model, modelReady, onModelChange, scanText, clearModelCache } from '../lib/privacy-client.js';
import { ask, describeForm, pageLogInfo, pageTextOf, saveDraft, saveSettings, updateCase } from '../lib/core.js';
import { addClip, caseKeys, fieldState, settled } from '../lib/case.js';
import { display, norm, validateValue } from '../lib/fields.js';
import { logEvent } from '../lib/activity.js';
import { editPicks, newFillDraft } from '../lib/drafts.js';
import { editExisting } from './draft-editor.js';
import { recordFailure } from '../lib/diagnostics.js';

// Page highlights use the same colours as the --pii-* tokens in ui/base.css.
const HL = { names: '#f4b6c2', dob: '#f9dc7a', ids: '#f9c08f', contact: '#d2c3ee', address: '#a9cff5', dates: '#fff1a8' };
export const privacyUi = { hl: false, paste: '', running: null, modelUrl: null, modelUrlError: '', otherServer: false };

const settingsOf = (data) => effectiveSettings(data.settings?.privacy, data.policy?.values?.redaction);

// What the boundary needs from this page: case values, the library's patterns, settings and model state.
export async function boundaryContext(context, parts = []) {
  const { data, lib } = context;
  const source = modelSource(data.policy, lib, data.settings);
  const modelSpans = {};
  if (modelReady()) await Promise.all(parts.filter((p) => p.kind !== 'image').map(async (p) => { modelSpans[p.id] = await scanText(p.text).catch(() => []); }));
  return {
    // extraKnown: values a caller knows are personal, such as every value on a page while a flow is authored.
    known: [...knownValues(data.case, lib), ...(context.extraKnown || [])], patterns: patternsFor(lib), modelSpans,
    settings: settingsOf(data), identifierTypes: lib?.identifierTypes || {}, model: { ready: modelReady(), required: source.required },
    blockImages: !!data.policy?.values?.redaction?.blockImages,
  };
}

// ------------------------------------------------------------------ the preview

function findingButton(f, view, onToggle) {
  const c = CATEGORIES[f.category];
  const info = `${c.label} · scored ${Math.round(f.score * 100)}% · ${{ case: 'value in the case', pattern: 'library pattern', model: 'on-device model', you: 'added by you' }[f.by]}`;
  return h('button', {
    type: 'button', class: `finding g-${c.group}${f.redact ? '' : ' low'}`, 'aria-pressed': String(f.redact),
    title: `${info}. ${f.redact ? 'Redacted: press to send it as written.' : 'Sent as written: press to redact it.'}`,
    'aria-label': `${f.text}: ${c.label}, ${f.redact ? 'redacted' : 'sent as written'}`, onclick: onToggle,
  }, view === 'sent' && f.redact ? token({ ...f }, {}) : f.text);
}

function partView(part, view, toggle) {
  const out = [];
  let at = 0;
  for (const f of part.findings) {
    out.push(part.text.slice(at, f.start));
    out.push(findingButton(f, view, () => toggle(f)));
    at = f.end;
  }
  out.push(part.text.slice(at));
  return out;
}

// Where to get the privacy model, from a message that says it's missing.
function toModelSetup(context, dlg) {
  if (!context.act?.setTab) return h('span', { class: 'small' }, 'Download it in the Power Loader sidebar: Settings → On-device privacy model.');
  return h('button', { type: 'button', class: 'link sm', style: 'align-self:flex-start', onclick: () => { dlg.close(); context.act.setTab('settings'); } }, 'Download the model in Settings');
}

function presenter(context) {
  return (state, { review }) => new Promise((resolve) => {
    const check = state.purpose === 'check';
    const ui = { view: 'sent', html: false };
    let answer = false;
    const toggle = (f) => { state.over[f.key] = !f.redact; d.refresh(); };
    const d = openDialog({
      title: check ? state.title : 'Check what will be sent', wide: true,
      onClose: () => resolve(answer),
      body: (dlg) => {
        const r = review(state);
        const unique = new Map();
        r.parts.flatMap((p) => p.findings).forEach((f) => { const u = unique.get(f.key); if (u) u.n++; else unique.set(f.key, { ...f, n: 1 }); });
        const all = [...unique.values()];
        const s = state.context.settings;
        const why = (f) => (f.why === 'low' ? `scored below ${Math.round(s.threshold * 100)}%` : f.why === 'off' ? `${GROUPS[CATEGORIES[f.category].group].toLowerCase()} are off` : 'you chose to send it');
        const row = (f) => h('label', { class: 'check small' },
          h('input', { type: 'checkbox', checked: f.redact, disabled: f.redact && !s.allowSendAsWritten && f.why !== 'low' && f.why !== 'off', onchange: () => toggle(f) }),
          h('span', {}, h('b', {}, f.text), f.n > 1 ? ` ×${f.n}` : '', h('br'), h('span', { class: 'muted' }, `${CATEGORIES[f.category].label} · scored ${Math.round(f.score * 100)}%${f.redact ? '' : ` · ${why(f)}`}`),
            f.redact && f.ref ? [h('br'), h('code', {}, shortToken(f))] : null));
        const sentText = r.parts.filter((p) => p.kind !== 'image').map((p) => p.sent).join('\n\n');
        const what = `${r.images ? `${plural(r.images, 'picture')} and ` : ''}${r.chars.toLocaleString('en-GB')} characters`;
        const extra = { text: '', category: 'person_name' };
        return [
          h('p', { class: 'muted' }, `${state.title}${check ? ' · Nothing is sent from this check.' : ` · ${what} to your organisation’s AI gateway`}`),
          r.blocked && !check ? h('div', { class: 'notice bad stack', role: 'alert' }, r.blocked, toModelSetup(context, dlg)) : null,
          !state.context.model.ready && !r.blocked ? h('div', { class: 'notice warn stack' }, 'The on-device model isn’t ready, so names and addresses that aren’t already in the case may be missed. Read the text carefully.', toModelSetup(context, dlg)) : null,
          r.planted ? h('div', { class: 'notice warn' }, `${plural(r.planted, 'piece')} of text on the page looked like a placeholder and ${r.planted === 1 ? 'was' : 'were'} neutralised (shown as ‹redacted:…).`) : null,
          h('div', { class: 'px-bar' },
            h('div', { class: 'seg', role: 'group', 'aria-label': 'View' },
              h('button', { type: 'button', 'aria-pressed': String(ui.view === 'sent'), onclick: () => { ui.view = 'sent'; dlg.refresh(); } }, check ? 'Redacted' : 'What the AI receives'),
              h('button', { type: 'button', 'aria-pressed': String(ui.view === 'orig'), onclick: () => { ui.view = 'orig'; dlg.refresh(); } }, 'Original, highlighted')),
            h('span', { class: 'diff' },
              h('span', { class: 'pill ok' }, `${plural(r.counts.redacted, 'value')} redacted`),
              r.counts.low ? h('span', { class: 'pill warn' }, `${r.counts.low} scored below ${Math.round(s.threshold * 100)}%, sent as written`) : null,
              r.counts.off ? h('span', { class: 'pill' }, `${r.counts.off} not redacted by your settings`) : null,
              r.counts.unticked ? h('span', { class: 'pill warn' }, `${r.counts.unticked} you chose to send as written`) : null)),
          h('div', { class: 'px-grid' },
            h('div', { class: 'stack', style: 'min-width:0' }, r.parts.map((p) => (p.kind === 'image' ? imagePart(p) : h('div', { class: 'stack', style: 'gap:4px' },
              h('h3', {}, p.label || p.id),
              p.kind === 'html' && !ui.html ? h('button', { type: 'button', class: 'link sm', style: 'align-self:flex-start', onclick: () => { ui.html = true; dlg.refresh(); } }, 'Show the HTML that will be sent') : null,
              h('div', { class: 'px-text', tabindex: '0', 'aria-label': `${p.label || p.id}, as ${ui.view === 'sent' ? 'sent' : 'written'}`, style: p.kind === 'html' && !ui.html ? 'max-height:120px' : '' }, partView(p, ui.view, toggle)))))),
            h('div', { class: 'px-side' },
              h('h3', {}, `Redacted (${all.filter((f) => f.redact).length})`), all.filter((f) => f.redact).map(row),
              all.some((f) => !f.redact) ? [h('h3', {}, `Sent as written (${all.filter((f) => !f.redact).length})`), all.filter((f) => !f.redact).map(row)] : null,
              h('h3', {}, 'Redact something else'),
              h('label', { class: 'sr', for: 'px-add' }, 'Text to redact'),
              h('input', { type: 'text', id: 'px-add', placeholder: 'Text to redact', oninput: (e) => { extra.text = e.target.value; } }),
              h('div', { class: 'row', style: 'flex-wrap:nowrap' },
                h('label', { class: 'sr', for: 'px-add-cat' }, 'Kind of value'),
                h('select', { id: 'px-add-cat', onchange: (e) => { extra.category = e.target.value; } }, Object.entries(CATEGORIES).map(([k, c]) => h('option', { value: k }, c.label))),
                h('button', { type: 'button', class: 'sm', onclick: () => { if (extra.text.trim()) { state.extra.push({ ...extra }); dlg.refresh(); } } }, 'Add')))),
          r.images ? h('label', { class: 'notice warn check', 'data-key': 'px-image-ack' },
            h('input', { type: 'checkbox', 'data-key': 'px-image-ack-box', checked: !!state.imageAck, onchange: (e) => { state.imageAck = e.target.checked; dlg.refresh(); } }),
            h('span', {}, h('b', {}, 'I understand the picture is sent as it is. '), 'Power Loader can’t find or redact personal details in a picture, so everything in it, names, addresses and numbers included, goes to your organisation’s AI gateway. Only the text above is redacted.')) : null,
          h('div', { class: 'px-foot' },
            h('span', { class: 'grow' }, check ? 'Detectors can miss things. Read it through before you share it.' : 'Click any value to switch it. Each placeholder has a ref, so Power Loader can put the real value back into the answer on this computer. Detectors can miss things: read it through before you send it.'),
            h('button', { type: 'button', onclick: () => dlg.close() }, check ? 'Close' : 'Cancel'),
            h('button', { type: 'button', onclick: () => copyText(sentText, check ? 'Redacted text' : 'What will be sent') }, check ? 'Copy redacted text' : 'Copy what will be sent'),
            check ? null : h('button', { type: 'button', class: 'magic', 'data-key': 'px-send', disabled: !!r.blocked || r.needsAck, title: r.needsAck ? 'Tick that you understand the picture is sent as it is' : undefined, onclick: () => { answer = true; dlg.close(); } }, `✦ Send ${what}`)),
        ];
      },
    });
  });
}

// A picture in the preview: shown exactly as it will be sent, with no redaction.
function imagePart(p) {
  return h('div', { class: 'stack', style: 'gap:4px' },
    h('h3', {}, p.label || 'Picture'),
    h('img', { src: p.url, alt: 'The picture that will be sent', style: 'max-width:100%;max-height:320px;object-fit:contain;border:2px solid var(--warn, #f47738);align-self:flex-start' }),
    h('span', { class: 'small muted' }, `${p.width && p.height ? `${p.width}×${p.height} px · ` : ''}Not redacted: sent as it is.`));
}

export function installPresenter(context) { registerPresenter(presenter(context)); }

// A check that sends nothing: the same preview, with no Send.
async function checkOnly(context, title, text) {
  const ctx = await boundaryContext(context, [{ id: 'text', text }]);
  const state = prepare({ purpose: 'check', title, parts: [{ id: 'text', label: title, kind: 'text', text }], compose: () => [] }, ctx);
  await presenter(context)(state, { review: reviewState, approve: approvePayload });
}

// ------------------------------------------------------------------ ✦ actions

const aiStatus = ({ data }) => (aiReady(data.settings) ? null : 'The ✦ Remote AI is off. Turn it on under ✦ Remote AI in Settings: Settings is open now.');

// Run a ✦ action from the sidebar or a full page: preview, send once, then done(answer).
export async function runAi(context, purpose, input, done) {
  const { ui, data, lib, act } = context;
  const notReady = aiStatus(context);
  if (notReady) { act.setTab?.('settings'); announce(notReady); return; }
  if (privacyUi.running) return;
  const caseId = data.case?.id || null;
  const controller = new AbortController();
  privacyUi.running = { controller, caseId };
  try {
    const config = await connectionConfig();
    const out = await runTask(purpose, input, {
      lib, context: (parts) => boundaryContext(context, parts), config, signal: controller.signal,
      onSent: (payload) => {
        if (caseId) void updateCase(caseId, (c) => logEvent(c, 'send_to_ai', { page: ui?.info?.profile ? pageLogInfo(lib, { url: ui.page.url, profile: ui.info.profile }) : {}, detail: `${purpose} · ${payload.chars} characters · ${payload.redacted} values redacted` })).catch(() => {});
        announce('Sent. Waiting for the answer…');
      },
    });
    if (!out) { announce('Cancelled. Nothing was sent.'); return; }
    if (controller.signal.aborted) return;
    await done(out);
  } catch (e) {
    if (e.name !== 'AbortError') void recordFailure(`ai-${purpose}`);
    announce(e.name === 'AbortError' ? 'Cancelled' : `✦ didn’t work: ${describeError(e)}`);
  } finally {
    privacyUi.running = null;
    act.refresh();
  }
}

// The case ended: cancel anything in flight. Its answer, if it comes, is dropped by updateCase.
export function cancelRunning() {
  privacyUi.running?.controller.abort();
  privacyUi.running = null;
  privacyUi.paste = '';
}

// The ✦ answer for a page or document: each value checked against the case before it's added.
export function showExtractResult(context, out, source, activity = 'ai_extract_page') {
  const { data, lib, act } = context;
  const chosen = new Set(out.rows.filter((r) => r.ok).map((r) => r.key));
  openDialog({
    title: '✦ Answer from the AI', wide: true,
    body: (dlg) => [
      h('p', { class: 'muted' }, `${source.name} · placeholders swapped back on this computer`),
      out.rows.length ? h('ul', { class: 'plain' }, out.rows.map((r) => {
        const st = fieldState(data.case, lib, r.key);
        const status = !r.ok ? ['bad', r.error] : st.status === 'missing' ? ['ok', 'New'] : settled(st.status) && norm(lib.fields[r.key], st.value) === norm(lib.fields[r.key], r.value) ? ['', 'Matches the case'] : ['warn', 'Differs from the case: adding it makes a conflict'];
        return h('li', { class: 'card', style: 'padding:8px' }, h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: chosen.has(r.key), disabled: !r.ok, onchange: (e) => { if (e.target.checked) chosen.add(r.key); else chosen.delete(r.key); dlg.refresh(); } }),
          h('span', {}, h('b', {}, lib.fields[r.key].label), ' ', h('span', { class: `pill ${status[0]}` }, status[1]), h('br'), r.ok ? display(lib.fields[r.key], r.value) : '', r.quote ? [h('br'), h('q', { class: 'small' }, r.quote)] : null)));
      })) : h('p', {}, 'The AI found no values for this case’s fields.'),
      out.notes ? h('p', { class: 'small muted' }, `The AI noted: ${out.notes}`) : null,
      h('div', { class: 'actions' },
        h('button', { type: 'button', onclick: () => dlg.close() }, 'Discard'),
        h('button', {
          type: 'button', class: 'primary', disabled: !chosen.size,
          onclick: async () => {
            dlg.close();
            // Re-validated on add, not just on display.
            const values = {};
            const quotes = {};
            for (const r of out.rows.filter((x) => chosen.has(x.key))) {
              const check = validateValue(lib.fields[r.key], r.value);
              if (!check.ok) continue;
              values[r.key] = check.value;
              if (r.quote) quotes[r.key] = r.quote;
            }
            await act.update((c, l) => {
              const summary = addClip(c, l, { source: `ai|${source.url}|${Date.now()}`, kind: 'ai', profile: { id: 'ai', version: '' }, name: `✦ ${source.name}`, url: source.url, title: source.name, capturedAt: new Date().toISOString(), values, quotes, records: [], extra: {} });
              logEvent(c, activity, { page: source.page || {}, detail: `${Object.keys(values).length} values`, clip: summary.clipId });
            }, `Added ${plural(Object.keys(values).length, 'value')} to the case`);
          },
        }, `Add ${chosen.size} to case`)),
    ],
  });
}

export async function extractWithAI(context) {
  const { ui, data, lib } = context;
  if (!data.case) return;
  const page = await pageTextOf(ui.page.id);
  const keys = caseKeys(data.case, lib).filter((k) => !lib.fields[k].manual);
  const source = { name: ui.info?.profile?.name || ui.page.title || 'Page', url: ui.page.url, page: ui.info?.profile ? pageLogInfo(lib, { url: ui.page.url, profile: ui.info.profile }) : {} };
  await runAi(context, 'extract', { text: page.text, title: page.title, url: page.url, keys, label: 'Page text' }, async (out) => showExtractResult(context, out, source));
}

export async function mapFormWithAI(context, form) {
  const { ui, act } = context;
  const described = await describeForm(ui.page.id);
  await runAi(context, 'form', { form: described, title: ui.page.title, url: ui.page.url }, async (out) => {
    const d = newFillDraft(form, { url: ui.page.url, from: 'ai' });
    editPicks(d, (picks) => { for (const [box, key] of Object.entries(out.fields)) picks.push({ box, key }); });
    await saveDraft(d);
    await editExisting(d.id, act);
    announce(`Draft fill profile made with ${plural(Object.keys(out.fields).length, 'box', 'boxes')}${out.dropped.length ? `; ${out.dropped.length} suggestions weren’t on this form` : ''}. Test it before use.`);
  });
}

// ------------------------------------------------------------------ the tab

async function highlightPage(context) {
  const { ui } = context;
  if (privacyUi.hl) {
    await ask(ui.page.id, { type: 'powerloader:clearPII' }).catch(() => {});
    privacyUi.hl = false;
    return context.act.refresh();
  }
  const { text } = await pageTextOf(ui.page.id);
  const ctx = await boundaryContext(context, [{ id: 'text', text }]);
  const r = reviewState(prepare({ purpose: 'check', title: 'Page', parts: [{ id: 'text', kind: 'text', text }], compose: () => [] }, ctx));
  const spans = r.parts[0].findings.filter((f) => f.redact).map((f) => ({ start: f.start, end: f.end, color: HL[CATEGORIES[f.category].group], name: CATEGORIES[f.category].label, score: f.score }));
  // The page text was neutralised for the check; offsets still line up because ‹ replaces < one for one.
  await ask(ui.page.id, { type: 'powerloader:highlightPII', text, spans }).then(() => { privacyUi.hl = true; announce(`${plural(spans.length, 'value')} highlighted on the page`); }, (e) => announce(describeError(e)));
  context.act.refresh();
}

export function renderPrivacy(context) {
  const { ui, data, lib, act } = context;
  const s = settingsOf(data);
  const source = modelSource(data.policy, lib, data.settings);
  const known = data.case ? knownValues(data.case, lib).length : 0;
  const savePrivacy = (patch) => saveSettings({ privacy: { ...(data.settings?.privacy || {}), ...patch } }).then(() => act.refresh());
  const thresholds = [0.5, 0.6, 0.7, 0.8, 0.9].filter((t) => s.maxThreshold == null || t <= s.maxThreshold);
  const fmtText = { shape: 'Shape: the library’s description of that kind of identifier, such as AA999999A for an NI number. It never comes from the value itself.', regex: 'Pattern: the library’s regular expression for that kind of identifier. Dates keep a date format.', off: 'Off: placeholders say only what kind of value was removed.' };
  return [
    h('div', { class: 'card' },
      h('h2', {}, 'Check before anything goes to the AI'),
      h('p', { class: 'muted' }, 'When an ✦ button would send a page, form or document, Power Loader first finds personal data on this computer and swaps it for a placeholder. You see exactly what will be sent, and can change it.'),
      h('code', { class: 'tokex' }, '<redacted:nino|ref:k3x9qa.3|format:AA999999A|confidence:99%>'),
      h('code', { class: 'tokex' }, '<redacted:date_of_birth|ref:k3x9qa.4|format:DD/MM/YYYY|confidence:99%>'),
      h('p', { class: 'small muted' }, 'The AI answers with the same placeholders. Power Loader puts the real values back on this computer, and only for refs it issued for that request (the letters before the dot change every time).'),
      h('div', { class: 'row between' }, h('span', {}, 'Always show the preview'), h('span', { class: 'pill' }, '🔒 Always on'))),
    ui.info?.access ? h('div', { class: 'card' },
      h('h3', {}, 'This page'),
      h('p', { class: 'small muted' }, ui.info.profile?.name || ui.page?.title || ''),
      h('div', { class: 'row' },
        h('button', { type: 'button', 'data-key': 'px-check', onclick: async () => { const { text, title } = await pageTextOf(ui.page.id); checkOnly(context, `Check this page: ${title}`, text); } }, 'Check this page'),
        ui.info.kind === 'form' ? null : h('button', { type: 'button', 'data-key': 'px-hl', onclick: () => highlightPage(context) }, privacyUi.hl ? 'Hide highlights' : 'Highlight on page'))) : null,
    h('div', { class: 'card' },
      h('h3', {}, 'Check some text'),
      h('label', { class: 'sr', for: 'px-paste' }, 'Text to check'),
      h('textarea', { id: 'px-paste', 'data-key': 'px-paste', rows: 4, placeholder: 'Paste an email or call note', oninput: (e) => { privacyUi.paste = e.target.value; } }, privacyUi.paste),
      h('button', { type: 'button', 'data-key': 'px-text', style: 'align-self:flex-start', onclick: () => privacyUi.paste.trim() && checkOnly(context, 'Check text', privacyUi.paste) }, 'Check text')),
    h('div', { class: 'card' },
      h('h3', {}, 'What to redact'),
      h('fieldset', {}, h('legend', { class: 'sr' }, 'Kinds of personal data'),
        h('div', { class: 'px-grps' }, Object.entries(GROUPS).map(([g, label]) => h('label', {},
          h('input', { type: 'checkbox', 'data-key': `px-grp-${g}`, checked: !!s.groups[g], disabled: s.lockedGroups.includes(g), onchange: (e) => savePrivacy({ groups: { ...(data.settings?.privacy?.groups || {}), [g]: e.target.checked } }) }),
          h('span', { class: `sw g-${g}`, 'aria-hidden': 'true' }), h('span', {}, label, s.lockedGroups.includes(g) ? ' 🔒' : ''))))),
      h('p', { class: 'small muted' }, 'Other dates are off, so the AI can still work out timelines. Dates of birth are found from the case and from words like “born” or “DOB” next to a date.'),
      h('label', { class: 'row small' }, 'Redact findings scored',
        h('select', { 'data-key': 'px-thr', style: 'width:auto', onchange: (e) => savePrivacy({ threshold: Number(e.target.value) }) }, thresholds.map((t) => h('option', { value: String(t), selected: t === s.threshold }, `${Math.round(t * 100)}%`))), 'or more'),
      s.maxThreshold != null ? h('p', { class: 'small muted' }, `🔒 Your organisation sets the highest threshold at ${Math.round(s.maxThreshold * 100)}%: a lower threshold redacts more.`) : null,
      h('div', { class: 'stack' },
        h('span', { id: 'px-fmt-label', class: 'small' }, 'Format hints for identifiers and dates'),
        h('div', { class: 'seg', role: 'group', 'aria-labelledby': 'px-fmt-label' }, [['shape', 'Shape'], ['regex', 'Pattern'], ['off', 'Off']].map(([v, l]) => h('button', {
          type: 'button', 'data-key': `px-fmt-${v}`, 'aria-pressed': String(s.format === v), disabled: s.formatLocked && v !== 'off', onclick: () => savePrivacy({ format: v }),
        }, l))),
        h('span', { class: 'small muted' }, fmtText[s.format]))),
    h('div', { class: 'card' },
      h('h3', {}, 'How it finds personal data'),
      h('ul', { class: 'px-det' },
        h('li', {}, h('b', {}, 'Values already in this case'), h('br'), h('span', { class: 'muted' }, data.case ? `${known} values and their variants · 99%` : 'Start a case to use this')),
        h('li', {}, h('b', {}, lib?.privacy ? 'Patterns from the forms library' : 'Built-in patterns'), h('br'), h('span', { class: 'muted' }, `${[...new Set(patternsFor(lib).map((p) => CATEGORIES[p.category].label))].join(', ')}${lib?.privacy ? ` · commit ${lib.commit}` : lib ? ' · your library adds none' : ' · connect a library in Settings to add its own'}`)),
        h('li', {}, h('b', {}, 'On-device model '), modelPill(),
          h('br'), h('span', { class: 'muted' }, 'OpenAI Privacy Filter, about 920 MB, downloaded once. Finds names and addresses that aren’t in the case. Its score is the confidence.'),
          model.state !== 'ready' ? h('div', { class: 'notice bad small', style: 'margin-top:4px' }, 'Without the model, Power Loader still finds case values and library patterns, but may miss names and addresses that aren’t in the case.') : null)),
      h('p', { class: 'small muted' }, 'All three run in this browser. Nothing you check here leaves this computer.')),
    modelCard(context, source, savePrivacy),
  ];
}

const modelPill = () => h('span', { class: `pill ${model.state === 'ready' ? 'ok' : model.state === 'failed' ? 'bad' : 'warn'}`, role: 'status' }, describeModel());
const FROM = { policy: '🔒 set by your organisation', you: 'your setting', library: 'from the forms library', default: 'Hugging Face, the default' };

// Where the model downloads from. The caseworker can point it at another server with the same files (a mirror in
// Hugging Face's layout), unless policy sets the address. The revision and file hashes stay pinned either way.
function modelCard(context, source, savePrivacy) {
  const { act } = context;
  const mine = context.data.settings?.privacy?.modelUrl || '';
  const src = mine || privacyUi.otherServer ? 'other' : 'hf';
  const value = privacyUi.modelUrl ?? mine;
  const save = async (url) => {
    privacyUi.modelUrlError = '';
    try {
      const modelUrl = url ? normalizeModelUrl(url) : null;
      privacyUi.modelUrl = null;
      await savePrivacy({ modelUrl });
      announce(modelUrl ? 'Model server saved. Load and test the model to use it.' : 'Back to the default model server.');
    } catch (e) {
      privacyUi.modelUrlError = e.message;
      act.render();
    }
  };
  const radio = (v, title, sub) => h('label', { class: 'radio' },
    h('input', { type: 'radio', name: 'px-src', 'data-key': `px-src-${v}`, value: v, checked: src === v, disabled: source.locked,
      onchange: () => { privacyUi.otherServer = v === 'other'; if (v === 'hf' && mine) save(null); else act.render(); } }),
    h('span', {}, h('b', {}, title), h('small', {}, sub)));
  const busy = ['downloading', 'starting', 'testing'].includes(model.state);
  return h('div', { class: 'card' },
    h('div', { class: 'row between' }, h('h3', {}, 'Where the model comes from'), source.locked ? h('span', { class: 'pill' }, '🔒 Set by your organisation') : null),
    h('p', { class: 'small muted' }, 'The model is downloaded once and kept in this browser. Use your organisation’s copy if huggingface.co is blocked.'),
    source.locked ? null : h('fieldset', {}, h('legend', { class: 'sr' }, 'Model server'),
      radio('hf', 'Hugging Face', 'huggingface.co, at a pinned version'),
      radio('other', 'Another model server', 'Any server with the same file layout as Hugging Face')),
    !source.locked && src === 'other' ? h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); save((privacyUi.modelUrl ?? mine).trim()); } },
      h('label', { class: 'field' }, 'Model server address',
        h('input', { type: 'url', 'data-key': 'px-model-url', value, placeholder: 'https://models.example.gov.uk/huggingface/', 'aria-describedby': 'px-model-url-help px-model-url-error', 'aria-invalid': privacyUi.modelUrlError ? 'true' : 'false',
          oninput: (e) => { privacyUi.modelUrl = e.target.value; } })),
      h('p', { class: 'small muted', id: 'px-model-url-help' }, 'Files must be at the same paths as on Hugging Face (', h('code', {}, '{model}/resolve/{revision}/'), '), and the server must allow requests from the browser. They’re still checked against the expected hashes.'),
      h('p', { class: 'small error-text', id: 'px-model-url-error', role: 'alert' }, privacyUi.modelUrlError),
      h('button', { type: 'submit', class: 'sm', 'data-key': 'px-model-save', style: 'align-self:flex-start' }, 'Save')) : null,
    h('p', { class: 'small' }, `Model server (${FROM[source.from]}): `, h('code', {}, source.baseUrl), ` · ${source.modelId} · revision `, h('code', {}, source.revision ? source.revision.slice(0, 12) : 'not set'),
      source.hashes ? ' · every file is checked against its expected hash' : ' · no file hashes are set, so files aren’t checked'),
    source.required ? h('p', { class: 'small' }, '🔒 Your organisation requires the model before anything is sent to the AI.') : null,
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'sm', 'data-key': 'px-load', disabled: busy, onclick: () => loadModel(source).then(() => act.refresh()) }, model.state === 'ready' ? 'Check again' : 'Load and test the model'),
      modelPill()),
    h('p', { class: 'small muted' }, 'Checks the files and their hashes, downloads them if needed, starts the model on the graphics card and runs a test scan.'),
    h('button', { type: 'button', class: 'link sm', 'data-key': 'px-clear', onclick: () => clearModelCache().then(() => { announce('The downloaded model was removed'); act.refresh(); }) }, 'Remove the downloaded model'));
}

/** The model's download, for Settings: setup isn't spread across tabs. The Privacy tab has the rest. */
export function modelSetupCard(context) {
  const { data, lib, act } = context;
  const source = modelSource(data.policy, lib, data.settings);
  const busy = ['downloading', 'starting', 'testing'].includes(model.state);
  const ready = model.state === 'ready';
  return h('div', { class: `card${ready ? '' : ' stack'}`, id: 'model-setup' },
    h('div', { class: 'row between' }, h('h2', {}, 'On-device privacy model'), modelPill()),
    ready ? h('p', { class: 'small muted' }, 'Ready. It finds names and addresses before anything is sent to the AI.')
      : h('p', { class: 'small' }, `Download it now: about 920 MB, once. It runs only on this computer and finds names and addresses that aren’t in the case, before anything goes to the AI.${source.required ? ' Your organisation requires it before anything is sent.' : ''}`),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: ready ? 'sm' : 'primary', 'data-key': 'set-model-load', disabled: busy, onclick: () => loadModel(source).then(() => act.refresh()) },
        busy ? [h('span', { class: 'spinner' }), ' Working…'] : ready ? 'Check again' : 'Download and test the model'),
      h('button', { type: 'button', class: 'link sm', 'data-key': 'set-model-more', onclick: () => act.setTab('privacy') }, 'Where it comes from, and what to redact')),
    h('p', { class: 'small muted' }, `From ${source.baseUrl.replace(/^https?:\/\//, '')}${source.locked ? ' (set by your organisation)' : ''}. Needs a graphics card that Firefox can use (WebGPU).`));
}

export function watchModel(act) { onModelChange(() => act.render()); }

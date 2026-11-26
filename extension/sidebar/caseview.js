// The active case in the sidebar: what this page is to the case, conflicts, per-form progress, clips and fields.
import { NOT_HERE } from '../lib/build-hosts.js';
import { h, plural, time, draftInput, clearDraft, drafts, copyText } from '../ui/dom.js';
import {
  caseKeys, clipTally, conflictKeys, confirmIdentity, contribution, decide, excludeValue, fieldState, fillStale, formProgress, identityWarnings,
  isRequired, markSubmitted, neededBy, notNeededKeys, removeClip, restoreValue, setManual, settled, undecide, unmarkSubmitted,
  clearCaseRef, refChangeable, setCaseRef,
} from '../lib/case.js';
import { display } from '../lib/fields.js';
import { logEvent } from '../lib/activity.js';
import { pageLogInfo } from '../lib/core.js';
import { confirmDialog } from '../ui/dialog.js';
import { aiReady } from '../lib/ai/settings.js';
import { MAILTO_SAFE, caseVars, emailFor, markStep, stepAddress } from '../lib/journey.js';
import { stepReader } from './tools/reader-ui.js';
import { SOURCE_TEXT, allowed, globVerdict } from '../lib/access.js';
import { stepsCard } from './steps.js';
import { followNotice, isRinging, tallyLine, valueList } from './gather-ui.js';
import { listNoun } from '../lib/fetch-steps.js';

const label = (lib, k) => lib.fields[k]?.label || k;
const labels = (lib, keys) => keys.map((k) => label(lib, k)).join(', ');
export const shortUrl = (u) => String(u || '').replace(/^https?:\/\//, '');

// Where the library usually finds a field: the page profiles that read it.
export const whereFound = (lib, key) => lib.profiles.filter((p) => Object.prototype.hasOwnProperty.call(p.fields || {}, key)).map((p) => p.name);

// Page context for log events, from the case's library. Unrecognised pages are logged without a link.
function here({ ui, lib, logPage }) {
  if (logPage) return logPage();
  if (ui.info?.kind === 'source') return pageLogInfo(lib, { url: ui.page.url, profile: ui.info.profile });
  if (ui.info?.kind === 'form') return pageLogInfo(lib, { url: ui.page.url, formId: ui.info.formId });
  return {};
}

// ------------------------------------------------------------------ the flow's steps

const STEP_ACTION = { guide: 'navigate', input: 'read', output: 'fill', fetch: 'navigate' };
const NO_OPEN = 'Power Loader doesn’t open this address: the site rules block it';

// Is a step's own page one the site rules block? Judged by its address or pattern.
export const stepBlocked = (data, lib, s) => !!(data.access && STEP_ACTION[s.role] && stepAddress(lib, s) && globVerdict(data.access, stepAddress(lib, s), STEP_ACTION[s.role]).verdict === 'blocked');
export const STEP_ROLE = { guide: 'Page to visit', input: 'Page to clip', output: 'Form to fill', email: 'Email to send', scan: 'Screenshot to read', fetch: 'Pages to fetch' };
export const varLabel = (lib, k) => (k === 'ref' ? 'Case reference' : label(lib, k));

// A value a link needs and the case doesn't have yet: the case reference, or a value typed by the caseworker.
export function missingInput(context, k) {
  const { lib, act } = context;
  const key = `step-var-${k}`;
  return h('div', { class: 'row', style: 'flex-wrap:nowrap' },
    h('label', { class: 'sr', for: key }, varLabel(lib, k)),
    draftInput(key, { type: 'text', id: key, placeholder: varLabel(lib, k) }),
    h('button', {
      type: 'button', class: 'sm', 'data-key': `${key}-use`,
      onclick: () => {
        const v = (drafts.get(key) || '').trim();
        if (!v) return;
        clearDraft(key);
        act.update((cs, l) => {
          if (k === 'ref') cs.ref = v.slice(0, 80);
          else { setManual(cs, k, v); logEvent(cs, 'edit_value', { page: here(context), detail: label(l, k) }); }
        }, `${varLabel(lib, k)} saved`);
      },
    }, 'Use'));
}

/**
 * An email step: the email as it will be, filled in from the case, and a button that opens it in the
 * caseworker's email app (a mailto: link). Nothing is sent by Power Loader: they check it and send it there.
 */
export function emailBlock(context, s, done, { main = !done } = {}) {
  const { data, lib, act } = context;
  const e = emailFor(s.email, caseVars(data.case, lib, { text: true }));
  const row = (name, v) => (v ? h('div', { class: 'row small', style: 'gap:6px;flex-wrap:nowrap;align-items:baseline' }, h('span', { class: 'muted', style: 'min-width:4.5em' }, name), h('span', { style: 'min-width:0;overflow-wrap:anywhere' }, v)) : null);
  const opened = () => act.update((cs) => {
    logEvent(cs, 'open_email', { detail: s.name });
    if (!done) markStep(cs, s.id, true);
  }, 'The email is open in your email app. Check it there, then send it.');
  return h('div', { class: 'stack', style: 'gap:6px' },
    h('div', { class: 'stack email-preview', style: 'gap:3px;border:1px solid var(--border);border-radius:6px;padding:8px' },
      row('To', e.to.join(', ') || h('i', { class: 'muted' }, 'you choose, in your email app')), row('Cc', e.cc.join(', ')), row('Subject', e.subject),
      e.body ? h('pre', { class: 'small', 'data-key': 'step-email-body', style: 'white-space:pre-wrap;margin:4px 0 0;font:inherit;max-height:220px;overflow:auto' }, e.body) : null),
    e.bad.length ? h('p', { class: 'notice warn small', role: 'alert' }, `${e.bad.map((a) => `“${a.slice(0, 60)}”`).join(', ')} ${e.bad.length === 1 ? 'isn’t an email address' : 'aren’t email addresses'}. Correct the value in the case, or copy the text and write the email yourself.`) : null,
    e.mailto && e.mailto.length > MAILTO_SAFE ? h('p', { class: 'small muted' }, 'This email is long, and some email apps cut a long email short. If the text is cut, paste it in with Copy the text.') : null,
    h('div', { class: 'row' },
      e.mailto
        ? h('a', { class: main ? 'button primary big' : 'button sm', href: e.mailto, 'data-key': 'step-email-open', role: 'button', onclick: opened }, 'Open in your email app')
        : h('button', { type: 'button', class: main ? 'primary big' : 'sm', 'data-key': 'step-email-open', disabled: true, title: e.missing.length ? `Needs ${e.missing.map((k) => varLabel(lib, k)).join(', ')}` : 'Correct the addresses first' }, 'Open in your email app'),
      e.subject ? h('button', { type: 'button', class: 'sm', 'data-key': 'step-email-subject', onclick: () => copyText(e.subject, 'Subject') }, 'Copy the subject') : null,
      e.body ? h('button', { type: 'button', class: 'sm', 'data-key': 'step-email-text', onclick: () => copyText(e.body, 'Text') }, 'Copy the text') : null),
    h('span', { class: 'small muted' }, 'Power Loader doesn’t send it: your email app opens with it written, for you to check and send.'));
}

/**
 * Where the case reference came from, and the guard against working on two cases at once: set from the case
 * the caseworker opened, with Change until the first clip; on another case's page, a warning and only Finish.
 */
export function refNotice(context) {
  const { ui, data, act } = context;
  const c = data.case;
  if (ui.info?.otherRef && c.ref) {
    return h('div', { class: 'notice warn stack', role: 'alert', 'data-key': 'ref-other', style: 'gap:6px' },
      h('p', {}, h('b', {}, `This is case ${ui.info.otherRef}, not this case (${c.ref}).`), ' Power Loader works on one case at a time, so nothing from this page goes into this case.'),
      h('button', { type: 'button', class: 'sm', 'data-key': 'ref-finish', style: 'align-self:flex-start', onclick: () => act.finish() }, 'Finish this case first'));
  }
  if (c.refFrom?.from === 'address' && refChangeable(c)) {
    return h('div', { class: 'notice stack', role: 'status', 'data-key': 'ref-set', style: 'gap:4px' },
      h('p', {}, 'Case reference set to ', h('b', {}, c.ref), ', from the case you opened.'),
      h('button', {
        type: 'button', class: 'link sm', 'data-key': 'ref-change', style: 'align-self:flex-start',
        onclick: () => {
          // This page would set it again straight away: it doesn't, until the tab moves on.
          ui.refDeclined = ui.page?.url || null;
          act.update((cs) => clearCaseRef(cs), 'The case reference is cleared. Open the case you’re working on.');
        },
      }, 'Change'));
  }
  return null;
}

// Choosing the case by hand: a reference typed instead, for a case that isn't opened in the system.
export function typeRefInput(context, s) {
  const { act } = context;
  const key = 'choose-ref';
  return h('details', { class: 'small', 'data-key': 'choose-type' },
    h('summary', {}, 'Or type the case reference'),
    h('div', { class: 'row', style: 'flex-wrap:nowrap' },
      h('label', { class: 'sr', for: key }, 'Case reference'),
      draftInput(key, { type: 'text', id: key, placeholder: 'Case reference' }),
      h('button', {
        type: 'button', class: 'sm', 'data-key': `${key}-use`,
        onclick: () => {
          const v = (drafts.get(key) || '').trim();
          if (!v) return;
          clearDraft(key);
          act.update((cs) => { if (!cs.ref) setCaseRef(cs, v, { from: 'typed', step: s }); }, 'Case reference saved');
        },
      }, 'Use')));
}

// A link the site rules block: shown disabled, with the reason, and the address can still be copied.
export function blockedLink(data, url, key, label = 'Go to it') {
  if (!data.access || allowed(data.access, url, 'navigate').ok) return null;
  return h('div', { class: 'stack', style: 'gap:2px' },
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'sm', 'data-key': key, disabled: true, title: NO_OPEN }, label),
      h('button', { type: 'button', class: 'link sm', 'data-key': `${key}-copy`, onclick: () => copyText(url, 'The address') }, 'Copy the address')),
    h('span', { class: 'small muted' }, `${NO_OPEN}.`));
}

/** A scan step: what it reads, and the reader for a screenshot of it. Done once what it read is added. */
export function scanBlock(context, s, done) {
  const { lib } = context;
  const reads = Object.keys(s.scan?.fields || {}).map((k) => varLabel(lib, k));
  return h('div', { class: 'stack', style: 'gap:6px' },
    h('span', { class: 'small' }, 'Reads ', h('b', {}, reads.join(', ')), done ? ' · added to the case' : ''),
    stepReader(context, s));
}

// ------------------------------------------------------------------ identity

function identityCard(context, clip) {
  const { lib, act } = context;
  return h('div', { class: 'idwarn', role: 'alert' },
    h('b', {}, 'This may be a different person.'),
    h('span', {}, `${clip.name}: ${labels(lib, clip.identity.mismatched)} ${clip.identity.mismatched.length === 1 ? 'doesn’t' : 'don’t'} match the rest of the case.`),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'danger', 'data-key': `undo-${clip.id}`, onclick: () => act.removeClip(clip.id, 'Wrong person') }, 'Undo this clip'),
      h('button', { type: 'button', 'data-key': `same-${clip.id}`, onclick: () => act.update((c) => confirmIdentity(c, clip.id), 'Kept. Power Loader won’t warn about this clip again.') }, 'It’s the same person')));
}

// ------------------------------------------------------------------ this page

// What the site rules block here, in words. Never "this page is blocked": the page works, Power Loader doesn't.
const ruleSource = (rule) => SOURCE_TEXT[rule?.layer] || 'in your Settings';
export function blockedCard(info) {
  const rule = info.blocked?.read || info.blocked?.fill;
  return h('div', { class: 'card', 'data-key': 'blocked-card' },
    h('div', { class: 'ctx-head' }, h('span', { class: 'pill' }, '⛔ Site rules')),
    h('p', {}, h('b', {}, 'Power Loader doesn’t work on this page. '), `The site rules ${ruleSource(rule)} block reading and filling here. You can still use the page yourself.`));
}

// Some actions blocked, not reading: say which.
function partlyBlocked(info) {
  const b = info.blocked || {};
  if (b.fill && !b.read) return h('p', { class: 'notice warn small', 'data-key': 'blocked-fill' }, `Power Loader can read this page but not fill it here: the site rules ${ruleSource(b.fill)} block filling.`);
  return null;
}

/**
 * What this page is to the case. In a step (inStep) it is drawn without its own heading, as part of the step,
 * and its button is green only when it is the step's main one (main).
 */
export function contextCard(context, { inStep = false, main = true } = {}) {
  const { ui, data, lib, act } = context;
  const c = data.case;
  const info = ui.info || { kind: 'none' };
  if (info.kind === 'none') return h('div', { class: 'card' }, h('p', { class: 'muted' }, 'Power Loader works on web pages (http and https).'));
  if (info.kind === 'blocked' || (!info.access && info.originBlocked)) return blockedCard(info);
  if (!info.access && info.grantable === false) {
    return h('div', { class: 'card', 'data-key': 'not-here' }, h('div', { class: 'ctx-head' }, h('span', { class: 'pill' }, 'Not this site')), h('p', {}, NOT_HERE));
  }
  if (!info.access) {
    let host = '';
    try { host = new URL(ui.page.url).host; } catch { /* not a URL */ }
    return h('div', { class: 'card' },
      h('div', { class: 'ctx-head' }, h('span', { class: 'pill' }, 'No access')),
      h('p', {}, 'Power Loader needs your permission to read pages on this site.'),
      h('button', { type: 'button', class: 'primary', 'data-key': 'allow', onclick: () => act.requestAccess() }, `Allow on ${host}`));
  }
  // Another case's page (D9): nothing from it goes into this case, so it isn't offered for clipping.
  if (info.kind === 'source' && info.otherRef && c.ref) {
    return h('div', { class: 'card ctx src' },
      h('div', { class: 'ctx-head' }, h('span', { class: 'pill warn' }, 'Another case'), h('strong', {}, info.profile.name)),
      h('p', { class: 'muted' }, `This page is for case ${info.otherRef}. Finish this case (${c.ref}) before you work on it.`));
  }
  if (info.kind === 'source') {
    const p = info.profile;
    const clip = c.clips.find((x) => x.source === `${p.id}|${ui.page.url}`);
    return h('div', { class: inStep ? 'step-own' : 'card ctx src' },
      inStep ? null : h('div', { class: 'ctx-head' }, h('span', { class: 'pill acc' }, 'Recognised'), h('strong', {}, p.name)),
      clip ? [
        h('p', { class: 'muted' }, `Clipped at ${time(clip.capturedAt)}${ui.lastClip?.url === ui.page.url && ui.lastClip.auto ? ' automatically' : ''}.`),
        tallyLine(context, clipTally(c, lib, clip)),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'sm', 'data-key': 'clip', disabled: !!ui.busy, onclick: () => act.clip(p) }, 'Clip again'),
          h('button', { type: 'button', class: 'sm', 'data-key': 'undo-clip', onclick: () => act.removeClip(clip.id) }, 'Undo this clip')),
        aiButton(context, 'ai-extract', '✦ Read this page with AI', () => act.extractWithAI()),
        fixLink(context, { profileId: p.id }),
      ] : [
        // The values it reads, listed here and outlined on the page (a page a fetch step reads, opened by hand).
        valueList(context, p, null, { live: true }),
        h('button', { type: 'button', class: main ? 'primary big' : 'sm', 'data-key': 'clip', disabled: !!ui.busy, onclick: () => act.clip(p) }, ui.busy === 'clip' ? [h('span', { class: 'spinner' }), ' Clipping…'] : 'Clip this page'),
        h('p', { class: 'small muted' }, `Reads ${plural(Object.keys(p.fields || {}).length, 'item')} with the flow’s template ${p.name} ${p.version}.`),
      ]);
  }
  if (info.kind === 'form' && info.blocked?.fill) return h('div', { class: 'card' }, h('div', { class: 'ctx-head' }, h('span', { class: 'pill' }, 'Form'), h('strong', {}, lib.forms[info.formId]?.name || '')), partlyBlocked(info));
  if (info.kind === 'form') {
    const f = lib.forms[info.formId];
    // A case's forms are its flow's.
    if (!c.forms.some((x) => x.id === info.formId)) {
      return h('div', { class: 'card' },
        h('div', { class: 'ctx-head' }, h('span', { class: 'pill' }, 'Form'), h('strong', {}, f.name)),
        h('p', { class: 'muted', 'data-key': 'form-not-in-flow' }, 'This form isn’t part of this flow.'));
    }
    const pr = formProgress(c, lib, f.id);
    const stale = fillStale(c, lib, f.id);
    return h('div', { class: inStep ? 'step-own' : 'card ctx form' },
      inStep ? null : h('div', { class: 'ctx-head' }, h('span', { class: 'pill ok' }, 'Target form'), h('strong', {}, `${f.name} ${f.version}`)),
      stale ? h('div', { class: 'notice bad', role: 'alert' }, 'Check again: this form was filled before the case changed. Values from a removed or changed source may still be in it. Fill it again, then check every box.') : null,
      c.filled[f.id] ? null : h('p', { class: 'muted' }, `${pr.done} of ${pr.req} required fields ready${pr.conflicts.length ? `, ${plural(pr.conflicts.length, 'conflict')} will be left empty` : ''}${pr.invalid.length ? `, ${pr.invalid.length} need fixing` : ''}${pr.missing.length ? `, ${pr.missing.length} missing` : ''}.`),
      info.fillProfile ? (context.renderFill ? context.renderFill(f, { main }) : null)
        : [h('p', { class: 'small muted' }, 'The flow doesn’t say how to fill this form yet: it has no template for its boxes.'), fixLink(context, { formId: f.id })],
      submittedControl(context, f));
  }
  if (info.kind === 'confirm') {
    const left = c.forms.filter((x) => !c.submitted[x.id]).map((x) => lib.forms[x.id]);
    return h('div', { class: 'card ctx form' },
      h('div', { class: 'ctx-head' }, h('span', { class: 'pill ok' }, 'Submitted'), h('strong', {}, lib.forms[info.formId]?.name)),
      h('p', {}, `Power Loader saw the confirmation page with reference ${info.confirmation.ref}.`),
      left.length ? [h('p', {}, `Still to do: ${left.map((x) => x.name).join(', ')}.`),
        left.filter((x) => x.url).map((x) => h('button', { type: 'button', class: 'primary', 'data-key': `open-${x.id}`, style: 'align-self:flex-start', onclick: () => act.openUrl(x.url) }, `Open ${x.name}`))]
        : [h('p', {}, h('b', {}, 'All forms submitted.'), ' Finish the case to delete its data from this browser.'),
          h('button', { type: 'button', class: 'primary big', 'data-key': 'finish-here', onclick: () => act.finish() }, 'Finish case')]);
  }
  // A page the flow doesn't know: nothing here offers to build (step 9 asks whether the flow is incomplete).
  return null;
}

/**
 * A page that reads the wrong thing, or a form the flow can't fill yet, is mended in the flow: "Fix this in
 * Build" changes mode and opens the flow at that page (a library's flow is copied to this computer first).
 * Building is for everyone; the site rules still bind the mended flow.
 */
export function fixLink(context, { profileId = null, formId = null, stepId = null }) {
  const { act, lib } = context;
  const step = stepId ? { id: stepId } : (lib.steps || []).find((s) => (profileId && s.role === 'input' && s.profileId === profileId) || (formId && s.role === 'output' && s.formId === formId));
  return h('details', { class: 'small', 'data-key': 'fix-wrong' },
    h('summary', {}, formId ? 'This form can’t be filled yet' : 'A value is wrong or missing'),
    h('button', { type: 'button', class: 'link sm', 'data-key': 'fix-in-build', onclick: () => act.fixInBuild(step?.id || null) }, 'Fix this in Build'));
}

// ✦ buttons appear when Enhanced tools are set up. Every one goes through the redaction preview first.
export function aiButton({ data, aiBusy }, key, label, onclick) {
  if (!aiReady(data.settings)) return null;
  return h('div', { class: 'stack', style: 'gap:2px' },
    h('button', { type: 'button', class: 'sm magic', 'data-key': key, style: 'align-self:flex-start', disabled: aiBusy, onclick }, aiBusy ? [h('span', { class: 'spinner' }), ' Waiting for the AI…'] : label),
    h('span', { class: 'small muted' }, 'You see it with personal data redacted before anything is sent.'));
}

// "I submitted this": Power Loader can only see a submission when the library knows the confirmation page.
function submittedControl({ data, act }, f) {
  const s = data.case.submitted[f.id];
  if (s?.how === 'observed') return h('p', { class: 'small' }, h('span', { class: 'pill ok' }, '✓ Submitted'), ` Seen on the confirmation page${s.ref ? ` (${s.ref})` : ''}.`);
  return h('label', { class: 'check small' },
    h('input', {
      type: 'checkbox', 'data-key': `submitted-${f.id}`, checked: !!s,
      onchange: (e) => {
        const on = e.target.checked;
        act.update((c) => {
          if (on) {
            markSubmitted(c, f.id, { how: 'reported' });
            logEvent(c, 'submit_form', { detail: `${f.id} · reported` });
          } else unmarkSubmitted(c, f.id);
        }, on ? 'Recorded as submitted (reported by you)' : 'No longer recorded as submitted');
      },
    }),
    h('span', {}, 'I submitted this form', h('br'), h('span', { class: 'muted' }, 'Power Loader can’t see submissions on this form, so this is recorded as reported by you.')));
}

// ------------------------------------------------------------------ conflicts

/**
 * A source named on a conflict card, as a link back to where the value came from: a page in a tab goes there
 * (the navigate check; a blocked page's link is disabled with the reason) and holds the value in view; a
 * fetched page opens what was read from it. A screenshot, a typed value or an AI reading has no link.
 */
export function sourceLink(context, clip, k, value) {
  const { data, lib, act } = context;
  const words = `${clip.name} ${time(clip.capturedAt)}`;
  const key = `cf-${k}-src-${clip.id}`;
  if (clip.kind === 'fetch' && act.openFetched) {
    return h('button', { type: 'button', class: 'link sm', 'data-key': key, title: 'See what was read from this page', onclick: () => act.openFetched(clip.id, k) }, words);
  }
  if (clip.kind === 'fetch' || !/^https?:/.test(clip.url || '') || !act.followSource) return words;
  if (data.access && !allowed(data.access, clip.url, 'navigate').ok) {
    return h('span', {}, h('button', { type: 'button', class: 'link sm', 'data-key': key, disabled: true, title: NO_OPEN }, words), h('span', { class: 'muted' }, ' · the site rules block this page'));
  }
  return h('button', {
    type: 'button', class: 'link sm', 'data-key': key, title: `Show ${label(lib, k)} on this page`,
    onclick: () => act.followSource({ url: clip.url, key: k, value: display(lib.fields[k], value), at: time(clip.capturedAt) }),
  }, words);
}

export function conflictCard(context, k) {
  const { data, lib, act } = context;
  const c = data.case;
  const st = fieldState(c, lib, k);
  const d = lib.fields[k];
  const key = `cf-${k}`;
  const choose = (value, how) => act.update((cs, l) => {
    decide(cs, l, k, value);
    logEvent(cs, 'resolve_conflict', { page: here(context), detail: `${label(l, k)}${how ? `, ${how}` : ''}` });
  }, `${label(lib, k)} decided`);
  // The step's conflict links come here: the card can be scrolled to, focused and ringed.
  return h('div', { class: `cf${isRinging(k) ? ' ring' : ''}`, id: `cf-card-${k}`, 'data-key': `cf-card-${k}`, tabindex: '-1', role: 'group', 'aria-label': `Conflict: ${label(lib, k)}` },
    h('div', { class: 'cf-title' }, h('b', {}, h('span', { 'aria-hidden': 'true' }, '⚠ '), label(lib, k)), h('span', { class: 'small muted' }, neededBy(c, lib, k).map((id) => lib.forms[id]?.short || id).join(' · '))),
    st.reopened ? h('p', { class: 'small' }, h('b', {}, 'The sources changed since you decided. '), `You chose ${display(d, st.previous)}. Decide again.`) : null,
    st.cands.map((cd, i) => h('div', { class: 'opt' },
      h('span', { class: 'v' }, display(d, cd.value)),
      h('span', { class: 's' }, cd.sources.map((id) => c.clips.find((x) => x.id === id)).filter(Boolean).map((x, j) => [j ? ', ' : null, sourceLink(context, x, k, cd.value)])),
      h('button', { type: 'button', class: 'sm', 'data-key': `${key}-use-${i}`, onclick: () => choose(cd.value) }, 'Use this'))),
    h('label', { class: 'small', for: `${key}-own` }, 'Or type the correct value'),
    h('div', { class: 'row', style: 'flex-wrap:nowrap' },
      draftInput(`${key}-own`, { type: 'text', id: `${key}-own` }),
      h('button', {
        type: 'button', class: 'sm', 'data-key': `${key}-own-use`,
        onclick: () => {
          const v = (drafts.get(`${key}-own`) || '').trim();
          if (!v) return;
          clearDraft(`${key}-own`);
          choose(v, 'typed');
        },
      }, 'Use')));
}

// ------------------------------------------------------------------ progress

function progressCard(context) {
  const { ui, data, lib, act } = context;
  const c = data.case;
  return h('div', { class: 'card' },
    h('div', { class: 'row between' }, h('h3', {}, 'Progress'),
      ui.view.formFilter ? h('button', { type: 'button', class: 'link sm', 'data-key': 'all-forms', onclick: () => { ui.view.formFilter = null; act.render(); } }, 'Show all forms') : null),
    c.forms.map((fv) => {
      const f = lib.forms[fv.id];
      const p = formProgress(c, lib, fv.id);
      const stale = fillStale(c, lib, fv.id);
      const s = c.submitted[fv.id];
      return h('div', { class: 'stack', style: 'gap:2px' },
        h('button', {
          type: 'button', class: 'fp', 'data-key': `fp-${fv.id}`, 'aria-pressed': String(ui.view.formFilter === fv.id),
          'aria-label': `${f.name}: ${p.done} of ${p.req} required fields ready. Show only this form’s fields`,
          onclick: () => { ui.view.formFilter = ui.view.formFilter === fv.id ? null : fv.id; act.render(); },
        },
        h('span', { class: 'fp-top' }, h('b', {}, `${f.name} ${fv.version}`), h('span', { class: 'num muted' }, `${p.done}/${p.req}`)),
        h('span', { class: 'bar', 'aria-hidden': 'true' }, h('i', { style: `width:${p.req ? (p.done / p.req) * 100 : 0}%` }), h('i', { class: 'c', style: `width:${p.req ? (p.conflicts.length / p.req) * 100 : 0}%` })),
        h('span', { class: 'fp-meta' },
          p.ready ? h('span', { class: 'r' }, 'Ready to fill') : null,
          p.conflicts.length ? h('span', { class: 'c' }, plural(p.conflicts.length, 'conflict')) : null,
          p.invalid.length ? h('span', { class: 'c' }, `${p.invalid.length} need fixing`) : null,
          p.missing.length ? h('span', { class: 'm' }, `${p.missing.length} missing`) : null,
          c.filled[fv.id] ? h('span', { class: stale ? 'c' : '' }, stale ? `Filled ${time(c.filled[fv.id].at)} · check again` : `Filled ${time(c.filled[fv.id].at)}`) : null,
          s ? h('span', { class: 'r' }, s.how === 'observed' ? 'Submitted (seen)' : 'Submitted (you said)') : null)));
    }));
}

// ------------------------------------------------------------------ clips

// The pages a list of links fetched are one group in the clip list (“25 messages fetched by Team inbox”), not a
// line each. The group can be opened to see them, and removed whole.
function listGroups(c, lib) {
  const groups = new Map();
  for (const s of lib.steps || []) {
    if (s.role !== 'fetch') continue;
    for (const r of s.fetch?.requests || []) {
      if (!r.each) continue;
      const clips = c.clips.filter((cl) => cl.kind === 'fetch' && cl.via?.stepId === s.id && cl.via.requestId === r.id);
      if (clips.length) groups.set(`${s.id}|${r.id}`, { step: s, request: r, clips });
    }
  }
  return groups;
}

function groupRow(context, g, key) {
  const { ui, act } = context;
  const open = ui.view.clipOpen === key;
  const n = g.clips.length;
  return h('div', { class: 'clip', 'data-key': `clip-group-${g.request.id}` },
    h('div', { class: 'clip-top' },
      h('div', { class: 'clip-main' },
        h('b', {}, `${n} ${listNoun(g.request, n)} fetched by ${g.step.name}`),
        h('span', { class: 'muted' }, `${time(g.clips.at(-1).capturedAt)} · ${plural(g.clips.reduce((k, cl) => k + (cl.records?.length || 0), 0), 'row')}`)),
      h('div', { class: 'row', style: 'flex-wrap:nowrap' },
        h('button', { type: 'button', class: 'sm', 'data-key': `view-group-${g.request.id}`, 'aria-expanded': String(open), onclick: () => { ui.view.clipOpen = open ? null : key; act.render(); } }, open ? 'Hide' : 'View'),
        h('button', {
          type: 'button', class: 'sm', 'data-key': `remove-group-${g.request.id}`,
          onclick: async () => {
            if (!await confirmDialog({ title: `Remove the ${n} ${listNoun(g.request, n)} fetched by ${g.step.name}?`, text: 'Fetch them again from the step’s page if you need them.', confirm: 'Remove them' })) return;
            act.update((cs, l) => { for (const cl of g.clips) if (cs.clips.some((x) => x.id === cl.id)) removeClip(cs, l, cl.id); }, 'Removed');
          },
        }, 'Remove'))),
    open ? h('ul', { class: 'plain clip-vals' }, g.clips.map((cl) => h('li', { class: 'row between', style: 'flex-wrap:nowrap' },
      h('span', { class: 'small', style: 'min-width:0;overflow-wrap:anywhere' }, cl.title || shortUrl(cl.url)),
      h('span', { class: 'row', style: 'gap:8px;flex-wrap:nowrap' },
        h('button', { type: 'button', class: 'link sm', 'data-key': `view-read-${cl.id}`, onclick: () => act.openFetched(cl.id) }, 'View what was read'),
        h('button', { type: 'button', class: 'link sm', 'data-key': `open-${cl.id}`, onclick: () => act.openUrl(cl.url) }, 'Open the page'))))) : null);
}

function clipsCard(context) {
  const { ui, data, lib, act } = context;
  const c = data.case;
  const groups = listGroups(c, lib);
  const grouped = new Set([...groups.values()].flatMap((g) => g.clips.map((cl) => cl.id)));
  const list = [...c.clips].reverse().filter((cl) => !grouped.has(cl.id));
  const keys = new Set(caseKeys(c, lib));
  return h('div', { class: 'card' },
    h('div', { class: 'row between' }, h('h3', {}, `Clips · ${c.clips.length}`), h('span', { class: 'small muted' }, 'Newest first')),
    [...groups.entries()].map(([key, g]) => groupRow(context, g, key)),
    list.length || groups.size ? list.map((cl) => {
      const ks = Object.keys(cl.values);
      const states = ks.map((k) => contribution(c, lib, cl, k, { keys }));
      const used = states.filter((s) => s.s === 'used').length;
      const conf = states.filter((s) => s.s === 'conflict').length;
      const open = ui.view.clipOpen === cl.id;
      return h('div', { class: `clip${conf ? ' has-conf' : ''}` },
        h('div', { class: 'clip-top' },
          h('div', { class: 'clip-main' },
            h('b', {}, cl.name, cl.profile?.draft ? h('span', { class: 'pill magic', style: 'margin-left:6px' }, 'draft') : null),
            cl.kind === 'fetch' ? h('span', { class: 'small', 'data-key': `fetched-${cl.id}` }, `${cl.format === 'json' ? 'data ' : ''}fetched by ${(lib.steps || []).find((x) => x.id === cl.via?.stepId)?.name || 'a step'}`) : null,
            h('span', { class: 'muted' }, `${time(cl.capturedAt)} · ${shortUrl(cl.url)}`),
            h('span', { class: 'diff' },
              used ? h('span', { class: 'pill ok' }, `${used} used`) : null,
              conf ? h('span', { class: 'pill bad' }, `${conf} in conflict`) : null,
              cl.records?.length ? h('span', { class: 'pill' }, `${cl.records.length} rows`) : null,
              !used && !conf && !cl.records?.length ? h('span', { class: 'pill' }, 'Nothing used') : null,
              cl.identity && !cl.identity.confirmed ? h('span', { class: 'pill bad' }, 'May be a different person') : null,
              // Never removed silently: removing evidence is the caseworker's choice.
              cl.url && data.access && !allowed(data.access, cl.url, 'read').ok ? h('span', { class: 'pill warn', 'data-key': `blocked-clip-${cl.id}` }, 'From a page the site rules now block') : null)),
          h('div', { class: 'row', style: 'flex-wrap:nowrap' },
            h('button', { type: 'button', class: 'sm', 'data-key': `view-${cl.id}`, 'aria-expanded': String(open), 'aria-controls': `clip-${cl.id}`, onclick: () => { ui.view.clipOpen = open ? null : cl.id; act.render(); } }, open ? 'Hide' : 'View'),
            h('button', { type: 'button', class: 'sm', 'data-key': `remove-${cl.id}`, onclick: () => act.removeClip(cl.id) }, 'Remove'))),
        open ? h('div', { class: 'clip-vals', id: `clip-${cl.id}` },
          ks.map((k, i) => h('div', { class: 'row between', style: 'flex-wrap:nowrap;align-items:baseline' },
            h('span', { style: 'min-width:0' }, `${label(lib, k)}: `, h('b', {}, display(lib.fields[k], cl.values[k])),
              // Where the value came from, as read: the only way to check a value against a response nobody sees.
              cl.quotes?.[k] ? [h('br'), h('q', { class: 'small muted', 'data-key': `quote-${cl.id}-${k}` }, cl.quotes[k])] : null),
            h('span', { class: `pill ${states[i].c}` }, states[i].s === 'over' ? 'Not used' : states[i].t),
            states[i].s === 'extra' ? null : h('button', {
              type: 'button', class: 'link sm', 'data-key': `ex-${cl.id}-${k}`,
              onclick: () => act.update((cs, l) => {
                if (states[i].s === 'excluded') { restoreValue(cs, cl.id, k); logEvent(cs, 'restore_source_value', { page: here(context), detail: label(l, k) }); }
                else { excludeValue(cs, cl.id, k); logEvent(cs, 'exclude_source_value', { page: here(context), detail: label(l, k) }); }
              }, states[i].s === 'excluded' ? `${label(lib, k)} restored` : `${label(lib, k)} from ${cl.name} excluded`),
            }, states[i].s === 'excluded' ? 'Restore' : 'Exclude'))),
          cl.records?.length ? h('span', { class: 'muted small' }, `${plural(cl.records.length, 'row')} for the tools`) : null,
          // A fetched page wasn't seen: it can be opened in the tab (a navigate check, as every opening is).
          cl.kind === 'fetch' ? h('div', { class: 'row', style: 'gap:10px' },
            h('button', { type: 'button', class: 'link sm', 'data-key': `view-read-${cl.id}`, onclick: () => act.openFetched(cl.id) }, 'View what was read'),
            h('button', { type: 'button', class: 'link sm', 'data-key': `open-${cl.id}`, onclick: () => act.openUrl(cl.url) }, 'Open the page')) : null,
          h('span', { class: 'url' }, cl.url)) : null);
    }) : h('p', { class: 'muted' }, 'Nothing clipped yet.'));
}

// ------------------------------------------------------------------ fields

function statusOf(st, def) {
  if (settled(st.status) && !st.valid) return { cls: 'invalid', icon: '!', text: 'Needs fixing' };
  return {
    ok: { cls: 'ok', icon: '✓', text: 'Gathered' }, resolved: { cls: 'resolved', icon: '✓', text: 'You chose' },
    manual: { cls: 'manual', icon: '✓', text: 'You typed' }, conflict: { cls: 'conflict', icon: '!', text: 'Conflict' },
    missing: { cls: 'missing', icon: '–', text: def?.manual ? 'To enter' : 'Missing' },
  }[st.status];
}

function fieldRow(context, k) {
  const { ui, data, lib, act } = context;
  const c = data.case;
  const d = lib.fields[k];
  const st = fieldState(c, lib, k);
  const s = statusOf(st, d);
  const open = ui.view.expanded === k;
  const tags = c.forms.length > 1 ? neededBy(c, lib, k).map((id) => h('span', { class: 'ftag' }, lib.forms[id]?.short || id)) : [];
  let val;
  let src = '';
  if (settled(st.status)) {
    val = display(d, st.value);
    src = st.status === 'manual' ? 'typed' : st.status === 'resolved' ? 'you chose' : st.cands[0].sources.length > 1 ? `${st.cands[0].sources.length} agree` : c.clips.find((x) => x.id === st.cands[0].sources[0])?.name || '';
  } else if (st.status === 'conflict') {
    val = st.cands.map((cd) => display(d, cd.value)).join(' ≠ ');
    src = 'decide above';
  } else {
    const where = whereFound(lib, k);
    val = d.manual ? 'Not on any page. Open to enter it.' : where.length ? `Missing. Usually on ${where.join(' or ')}` : 'Missing';
  }
  const detailId = `fd-${k}`;
  const row = h('button', {
    type: 'button', class: `frow s-${s.cls}`, 'data-key': `frow-${k}`, 'aria-expanded': String(open), 'aria-controls': detailId,
    onclick: () => { ui.view.expanded = open ? null : k; act.render(); },
  },
  h('span', { class: 'ico', 'aria-hidden': 'true' }, s.icon),
  h('span', {},
    h('span', { class: 'flabel' }, d.label, isRequired(c, lib, k) ? h('span', { class: 'req', 'aria-label': 'required' }, '*') : null, tags),
    h('span', { class: 'fval', style: 'display:block' }, val),
    h('span', { class: 'sr' }, `Status: ${s.text}`)),
  h('span', { class: 'fsrc' }, s.text === 'Needs fixing' ? 'needs fixing' : src));
  if (!open) return row;
  return [row, fieldDetail(context, k, st, detailId)];
}

function fieldDetail(context, k, st, id) {
  const { data, lib, act } = context;
  const c = data.case;
  const d = lib.fields[k];
  const key = `man-${k}`;
  const errId = `${key}-err`;
  const save = (value) => act.update((cs, l) => {
    setManual(cs, k, value);
    logEvent(cs, value ? 'edit_value' : 'clear_my_value', { page: here(context), detail: label(l, k) });
  }, value ? `${d.label} saved` : `${d.label} cleared`);
  const parts = [];
  for (const cd of st.cands) {
    parts.push(h('div', { class: 'small' }, h('b', {}, display(d, cd.value)), ' from ',
      cd.sources.map((sid) => c.clips.find((x) => x.id === sid)).filter(Boolean).map((x) => `${x.name} at ${time(x.capturedAt)}`).join(', ')));
  }
  if (settled(st.status) && !st.valid) parts.push(h('p', { class: 'error-text', id: errId }, `Needs fixing: ${st.error}. It won’t be filled until it’s fixed.`));
  if (st.status === 'missing' && !d.manual) {
    const where = whereFound(lib, k);
    if (where.length) parts.push(h('p', { class: 'small muted' }, `Usually on ${where.join(' or ')}. Open it and clip it.`));
  }
  if (d.options) {
    parts.push(h('div', { class: 'row', role: 'group', 'aria-label': d.label },
      d.options.map((o) => h('button', { type: 'button', class: `sm${st.value === o ? ' primary' : ''}`, 'data-key': `${key}-${o}`, 'aria-pressed': String(st.status === 'manual' && st.value === o), onclick: () => save(o) }, o))));
  } else {
    const input = draftInput(key, {
      type: 'text', id: key, value: c.manual[k] || '', 'aria-describedby': settled(st.status) && !st.valid ? errId : undefined,
      'aria-invalid': settled(st.status) && !st.valid && st.status === 'manual' ? 'true' : undefined,
    }, d.long ? 'textarea' : 'input');
    if (d.long) input.rows = 3;
    parts.push(
      h('label', { for: key, class: 'small' }, settled(st.status) && st.status !== 'manual' ? 'Override with your own value' : d.label),
      h('div', { class: 'row', style: 'flex-wrap:nowrap' }, input,
        h('button', { type: 'button', class: 'sm', 'data-key': `${key}-save`, onclick: () => { const v = (drafts.get(key) ?? input.value).trim(); clearDraft(key); save(v); } }, 'Save')));
  }
  if (st.status === 'manual' && st.cands.length) parts.push(h('button', { type: 'button', class: 'link sm', 'data-key': `${key}-back`, style: 'align-self:flex-start', onclick: () => { clearDraft(key); save(''); } }, 'Go back to the clipped value'));
  parts.push(h('button', { type: 'button', class: 'link sm', 'data-key': `${key}-full`, style: 'align-self:flex-start', onclick: () => act.openPage('case', { field: k }, `frow-${k}`) }, 'Open in the full case page'));
  if (st.status === 'resolved') parts.push(h('button', { type: 'button', class: 'link sm', 'data-key': `${key}-change`, style: 'align-self:flex-start', onclick: () => act.update((cs) => undecide(cs, k), `${d.label} is open again`) }, 'Change my choice'));
  return h('div', { class: 'fdetail', id }, parts);
}

function fieldsBlock(context) {
  const { ui, data, lib, act } = context;
  const c = data.case;
  const keys = caseKeys(c, lib).filter((k) => !ui.view.formFilter || neededBy(c, lib, k).includes(ui.view.formFilter));
  const states = Object.fromEntries(keys.map((k) => [k, fieldState(c, lib, k)]));
  const bucket = (k) => { const st = states[k]; return st.status === 'missing' ? 'missing' : st.status === 'conflict' ? 'conflict' : st.valid ? 'done' : 'fix'; };
  const counts = { all: keys.length, missing: 0, conflict: 0, fix: 0, done: 0 };
  keys.forEach((k) => counts[bucket(k)]++);
  const filters = [['all', 'All'], ['missing', 'Missing'], ['conflict', 'Conflicts'], ['fix', 'Needs fixing'], ['done', 'Gathered']].filter(([f]) => f !== 'fix' || counts.fix);
  const shown = keys.filter((k) => ui.view.fieldFilter === 'all' || bucket(k) === ui.view.fieldFilter);
  const out = [h('div', { class: 'chips', role: 'group', 'aria-label': 'Show fields' },
    filters.map(([f, l]) => h('button', { type: 'button', 'data-key': `ff-${f}`, 'aria-pressed': String(ui.view.fieldFilter === f), onclick: () => { ui.view.fieldFilter = f; act.render(); } }, `${l} `, h('span', { class: 'num' }, String(counts[f])))))];
  let section = null;
  const rows = [];
  for (const k of shown) {
    const sec = lib.fields[k].section || '';
    if (sec !== section || !rows.length) { section = sec; rows.push({ title: sec, items: [] }); }
    rows[rows.length - 1].items.push(fieldRow(context, k));
  }
  out.push(h('div', { class: 'stack', style: 'gap:2px' }, rows.length
    ? rows.map((g) => [g.title ? h('h4', { class: 'fsec' }, g.title) : null, h('div', { class: 'flist' }, g.items)])
    : h('p', { class: 'muted' }, 'Nothing here.')));
  return out;
}

function notNeededCard({ data, lib }) {
  const keys = notNeededKeys(data.case, lib);
  if (!keys.length) return null;
  return h('div', { class: 'card' }, h('h3', {}, 'Not needed by these forms'),
    h('p', { class: 'small muted' }, `${labels(lib, keys)}. Kept until you remove the clip or the case ends.`));
}

export function renderCaseTab(context) {
  const { data, lib } = context;
  const c = data.case;
  const conflicts = conflictKeys(c, lib);
  // The steps first; this page's own card only when the open step hasn't already shown it.
  const { card, showsPage } = stepsCard(context);
  return [
    ...identityWarnings(c).map((cl) => identityCard(context, cl)),
    card,
    // A conflict's page followed, and its value not there now.
    followNotice(context),
    showsPage ? null : contextCard(context),
    conflicts.length ? h('div', { class: 'conflicts', id: 'conflicts' },
      h('h3', {}, `⚠ ${plural(conflicts.length, 'conflict')} to decide`),
      h('p', { class: 'small' }, 'Sources disagree. Conflicting fields are left empty when you fill a form.'),
      conflicts.map((k) => conflictCard(context, k))) : null,
    // A case with no form (an inbox triage) has no progress to show: its results are on the step's card.
    c.forms.length ? progressCard(context) : null,
    clipsCard(context),
    notNeededCard(context),
    ...(c.forms.length ? fieldsBlock(context) : []),
  ];
}

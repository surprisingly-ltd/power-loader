// A case's steps, in the sidebar: every step of its flow listed, numbered, with a tick when done and a bar of
// progress under the flow's name. One step is open, in place in the list: the one the caseworker chose, else the
// one this page is, else the first not done. The open step has one main button, always the next thing to do
// (lib/journey.js nextStepAction()), and when this page is the step's page, what the page is to the case
// (clipping it, filling it) is part of the step. caseview.js is imported by the full case page, so nothing here
// may import sidebar.js.
import { announce, h, plural, time } from '../ui/dom.js';
import { saveSettings } from '../lib/ai/settings.js';
import { tallyLine, valueList, valueRows } from './gather-ui.js';
import { logEvent } from '../lib/activity.js';
import { caseVars, emailFor, fillTemplate, markStep, nextStepAction, openStep, nextStepAfter, stepAddress, stepForPage, stepNeeded, stepStatus, wantStep } from '../lib/journey.js';
import { allowed } from '../lib/access.js';
import { clipTally, clipValueState, markNotInFlow, notInFlow } from '../lib/case.js';
import { changedFlowFor } from '../lib/core.js';
import { scanTarget } from './tools/reader-ui.js';
import { fetchBlock, fetchMissing } from './fetch-ui.js';
import {
  STEP_ROLE, aiButton, blockedLink, contextCard, emailBlock, fixLink, missingInput, refNotice, scanBlock, stepBlocked, typeRefInput, varLabel,
} from './caseview.js';

/**
 * A page a step clips, on that page: the values it gives, listed before the clip and with their values after
 * it, and the clip itself. The clip's summary, Clip again, Undo and the link to mend the template come after
 * the main button, so Next is never pushed out of view by them.
 */
export function clipBlock(context, profile, { main = true, stepId = null } = {}) {
  const { ui, data, lib, act } = context;
  const c = data.case;
  const clip = c.clips.find((x) => x.source === `${profile.id}|${ui.page.url}`);
  const n = valueRows(lib, profile).length;
  const auto = !!data.settings?.autoClip;
  const top = h('div', { class: 'stack', style: 'gap:8px', 'data-key': 'clip-block' },
    h('div', { class: 'gv-head' },
      h('b', {}, clip ? `Clipped at ${time(clip.capturedAt)}${ui.lastClip?.url === ui.page.url && ui.lastClip.auto ? ', automatically' : ''}` : `This page gives ${plural(n, 'value')}`),
      h('span', { class: 'small muted' }, clip ? '' : 'outlined on the page')),
    valueList(context, profile, clip, { live: true }),
    clip ? null : h('button', { type: 'button', class: main ? 'primary big' : 'sm', 'data-key': 'clip', disabled: !!ui.busy, onclick: () => act.clip(profile) },
      ui.busy === 'clip' || (auto && ui.autoClipping) ? [h('span', { class: 'spinner' }), ' Clipping…'] : 'Clip this page'));
  const after = h('div', { class: 'stack small', style: 'gap:6px' },
    // What the clip is to the case now, kept up to date as its conflicts are decided.
    clip ? tallyLine(context, clipTally(c, lib, clip)) : null,
    // Auto-clip, where the caseworker is when they want it, as well as in Settings.
    h('label', { class: 'check small' },
      h('input', { type: 'checkbox', 'data-key': 'step-autoclip', checked: auto, onchange: async (e) => { await saveSettings({ autoClip: e.target.checked }); announce(e.target.checked ? 'Auto-clip is on' : 'Auto-clip is off'); act.refresh(); } }),
      h('span', {}, 'Clip pages like this as soon as I open them')),
    clip ? h('div', { class: 'row', style: 'gap:12px' },
      h('button', { type: 'button', class: 'link sm', 'data-key': 'clip', disabled: !!ui.busy, onclick: () => act.clip(profile) }, 'Clip again'),
      h('button', { type: 'button', class: 'link sm', 'data-key': 'undo-clip', onclick: () => act.removeClip(clip.id) }, 'Undo this clip')) : null,
    clip ? aiButton(context, 'ai-extract', '✦ Read this page with AI', () => act.extractWithAI()) : null,
    clip ? fixLink(context, { profileId: profile.id, stepId }) : null);
  return { top, after };
}

/** What the page should outline now: the open step's page, or a recognised page, while the Case tab shows. */
export function valuesWanted(context) {
  const { ui, data, lib } = context;
  const c = data.case;
  const info = ui.info || {};
  if (!c || ui.tab !== 'case' || info.kind !== 'source' || !info.access || (info.otherRef && c.ref)) return null;
  const clip = c.clips.find((x) => x.source === `${info.profile.id}|${ui.page.url}`);
  // The values in conflict are orange on the page too: their keys only, never a value.
  const flags = clip ? Object.fromEntries(Object.keys(clip.values).filter((k) => clipValueState(c, lib, clip, k) === 'conflict').map((k) => [k, 'conflict'])) : {};
  return { profile: info.profile, state: clip ? 'done' : 'pending', flags };
}

const sameAddress = (a, b) => !!a && !!b && String(a).split('#')[0] === String(b).split('#')[0];
let lastOpen = null; // the step open at the last render, so a step that has just opened is brought into view

/** What the page in view is, for nextStepAction(). */
const pageInfo = (ui) => ({ kind: ui.info?.kind, profileId: ui.info?.profile?.id, formId: ui.info?.formId });

/** The main button for the open step, as data, with what pressing it does. */
export function nextAction(context) {
  const { ui, data, lib, act } = context;
  const c = data.case;
  const a = nextStepAction(c, lib, {
    url: ui.page?.url, info: pageInfo(ui), chosen: ui.view.step,
    blocked: (s) => stepBlocked(data, lib, s), navigable: (u) => !data.access || allowed(data.access, u, 'navigate').ok,
  });
  if (!a) return null;
  const steps = lib.steps || [];
  const step = steps.find((s) => s.id === a.stepId);
  const go = (url, logged = true) => {
    ui.view.step = null;
    act.openUrl(url);
    if (logged && step) act.update((cs) => logEvent(cs, 'follow_step_link', { detail: step.name })).catch(() => {});
  };
  const run = {
    go: () => go(a.url),
    link: () => {
      if (step?.role === 'guide' && step.links?.[a.linkIndex]?.to && stepStatus(c, step, lib) !== 'done') act.update((cs) => markStep(cs, step.id, true));
      go(a.url);
    },
    next: () => {
      const next = steps.find((s) => s.id === a.nextId);
      // After Next loads a page, focus goes to the open step's main button.
      ui.focusMain = true;
      if (a.url) go(a.url);
      else { ui.view.step = next?.id || null; act.render(); }
      if (next) announce(`Next: ${next.name}`);
    },
    finish: () => act.finish(),
  }[a.kind] || null;
  return { ...a, run };
}

/** The flow's steps, as a card: { card, showsPage } where showsPage says the open step drew this page's own controls. */
export function stepsCard(context) {
  const { ui, data, lib, act } = context;
  const steps = lib.steps || [];
  scanTarget.step = null;
  const c = data.case;
  const vars = caseVars(c, lib);
  const status = Object.fromEntries(steps.map((s) => [s.id, stepStatus(c, s, lib)]));
  const done = steps.filter((s) => status[s.id] === 'done').length;
  const skipped = steps.filter((s) => status[s.id] === 'skipped').length;
  const cur = openStep(c, lib, { url: ui.page?.url, chosen: ui.view.step });
  const auto = openStep(c, lib, { url: ui.page?.url });
  const main = nextAction(context);
  const addressOf = (s) => { const tpl = stepAddress(lib, s); return tpl ? fillTemplate(tpl, vars) : { url: null, missing: [] }; };
  const open = (url) => { ui.view.step = null; act.openUrl(url); };
  const { body, showsPage } = cur ? stepBody(context, { cur, steps, status, vars, addressOf, main, open }) : { body: null, showsPage: false };
  // A step that has just opened is brought into view, with as much of the list above it as fits.
  if (cur && cur.step.id !== lastOpen && typeof requestAnimationFrame === 'function') requestAnimationFrame(() => {
    const el = document.querySelector('.step.open');
    if (!el || typeof el.getBoundingClientRect !== 'function') return;
    const r = el.getBoundingClientRect();
    const room = window.innerHeight - (document.querySelector('.sb-foot')?.offsetHeight || 0) - 8;
    if (r.top < 8 || r.bottom > room) window.scrollBy?.({ top: r.top - Math.max(8, Math.min(r.top, room - r.height)), behavior: 'auto' });
  });
  lastOpen = cur?.step.id || null;
  if (ui.focusMain && cur && (cur.here || cur.chosen) && typeof requestAnimationFrame === 'function') {
    ui.focusMain = false;
    requestAnimationFrame(() => document.querySelector('.step-body [data-main], .step-body .primary')?.focus());
  }
  const rail = h('ol', { class: 'steps-rail plain', 'data-key': 'steps-rail' }, steps.map((s, i) => {
    const st = status[s.id];
    const isCur = cur?.step.id === s.id;
    const here = auto?.here && auto.step.id === s.id;
    const blocked = stepBlocked(data, lib, s);
    const a = !isCur && !here && !blocked ? addressOf(s) : null;
    const ifNeeded = s.when && st === 'todo' && !c.steps?.[s.id]?.wanted && stepNeeded(c, lib, s) === null;
    const tag = blocked ? 'Blocked' : here ? 'This page' : st === 'done' ? (s.role === 'guide' && s.choose && c.ref ? c.ref : 'Done') : st === 'filled' ? 'Filled' : st === 'skipped' ? 'Not needed' : ifNeeded ? 'If needed' : '';
    const words = st === 'done' ? 'done' : st === 'filled' ? 'filled, not submitted' : st === 'skipped' ? 'not needed' : 'to do';
    return h('li', { class: `step ${st}${isCur ? ' open' : ''}${here ? ' here' : ''}` },
      h('div', { class: 'step-row' },
        h('button', {
          type: 'button', class: 'step-name', 'data-key': `step-go-${s.id}`, 'aria-current': isCur ? 'step' : undefined, 'aria-expanded': String(isCur),
          // Clicking a step's name opens it in place; choosing the open one again closes it.
          onclick: () => { ui.view.step = isCur && cur.chosen ? null : s.id; act.render(); },
        },
        h('span', { class: 'step-dot', 'aria-hidden': 'true' }, blocked ? '⛔' : st === 'done' ? '✓' : st === 'skipped' ? '–' : String(i + 1)),
        h('span', { class: 'step-title' }, h('span', { class: 'sr' }, `Step ${i + 1}: `), s.name,
          h('span', { class: 'sr' }, `, ${words}${blocked ? ', the site rules block its page' : ''}`))),
        tag ? h('span', { class: `step-tag${here ? ' here' : ''}` }, tag) : null,
        // The arrow at the end of its row goes to its page.
        a?.url && (!data.access || allowed(data.access, a.url, 'navigate').ok) ? h('button', { type: 'button', class: 'step-jump', 'data-key': `step-jump-${s.id}`, title: `Go to ${s.name}`, 'aria-label': `Go to ${s.name}`, onclick: () => { open(a.url); act.update((cs) => logEvent(cs, 'follow_step_link', { detail: s.name })).catch(() => {}); } }, '→') : null),
      isCur ? body : null);
  }));
  const card = h('div', { class: 'card steps flowux', role: 'region', 'aria-label': 'Steps' },
    h('div', { class: 'steps-head' },
      h('h3', {}, c.library?.flow?.name || 'Steps'),
      h('span', { class: 'small muted', 'data-key': 'steps-count' }, `${done} of ${steps.length} steps done${skipped ? ` · ${skipped} not needed` : ''}`)),
    h('div', { class: 'steps-meter', 'aria-hidden': 'true' }, steps.map((s) => h('i', { class: status[s.id] === 'done' ? 'done' : status[s.id] === 'skipped' ? 'skipped' : cur?.step.id === s.id ? 'open' : '' }))),
    // Another case's page: the warning stays at the top of the card.
    ui.info?.otherRef ? refNotice(context) : null,
    rail,
    changedFlowLine(context),
    incompleteBox(context, cur),
    cur ? null : h('div', { class: 'stack', style: 'gap:6px' },
      h('p', {}, h('b', {}, 'Every step is done. '), c.forms.length ? 'Finish the case when the forms are submitted.' : 'Finish the case when you’re ready.'),
      // The confirmation page's own card has the same button.
      main?.kind === 'finish' ? h('button', { type: 'button', class: 'primary big', 'data-key': 'steps-finish', onclick: () => act.finish() }, 'Finish case') : null));
  return { card, showsPage };
}

/**
 * Casework's one reach into Build: on a page that isn't one of the flow's steps, while a case is open, ask
 * whether the flow is incomplete. Any page the site rules let Power Loader read (D15), not only the systems the
 * flow uses; never a page they block, another case's page, Power Loader's own pages or a page the flow knows.
 * Under the steps, never in place of the next thing to do; put away for this page until the case ends (D16).
 */
function incompleteBox(context, cur) {
  const { ui, data, act } = context;
  const c = data.case;
  const info = ui.info || {};
  const url = ui.page?.url;
  if (!/^https?:/.test(url || '') || info.kind !== 'unknown' || !info.access || info.otherRef) return null;
  // A page to go through, or a fetch step's page, isn't a template Power Loader recognises (kind 'unknown'),
  // but it is one of the flow's steps: never asked about.
  if (stepForPage(context.lib, url)) return null;
  if (data.access && !allowed(data.access, url, 'read').ok) return null;
  if (notInFlow(c, url)) return null;
  const from = c.library?.flow;
  const copied = from?.fromLibrary && (data.flows || []).some((f) => f.copiedFrom?.path === from.fromLibrary.path);
  return h('div', { class: 'notice stack', style: 'gap:6px', 'data-key': 'flow-incomplete', role: 'status' },
    h('p', {}, h('b', {}, 'Is this flow incomplete? '), 'This page isn’t one of its steps. If you are using it to complete this case, it should be in the flow, perhaps as a step that is only sometimes needed.'),
    from?.fromLibrary && !copied ? h('p', { class: 'small', 'data-key': 'flow-incomplete-copy' }, 'This flow is from your library, so a copy is made on this computer for you to change.') : null,
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'sm', 'data-key': 'flow-incomplete-add', onclick: () => act.fixInBuild(null, { after: cur?.step.id || null, sometimes: true }) }, 'Add this page to the flow'),
      h('button', { type: 'button', class: 'link sm', 'data-key': 'flow-incomplete-no', onclick: () => act.update((cs) => markNotInFlow(cs, url), 'Not asked again on this page for this case') }, 'Not needed for this flow')));
}

/** The case's flow (or the copy made from it) has changed on this computer since the case started (D17). */
function changedFlowLine(context) {
  const { data, act } = context;
  const c = data.case;
  const set = data.library?.sets?.[c.library?.commit];
  const changed = changedFlowFor(c, data.flows || [], set);
  if (!changed) return null;
  return h('p', { class: 'small notice', 'data-key': 'flow-changed' }, 'This flow has been changed on this computer since the case started · ',
    h('button', { type: 'button', class: 'link sm', 'data-key': 'flow-use-changed', onclick: () => act.useChangedFlow(changed.id) }, 'Use the changed flow'));
}

/** The open step: what to do, this page's own controls when it is the step's page, and one main button. */
function stepBody(context, { cur, steps, status, vars, addressOf, main, open }) {
  const { ui, data, lib, act } = context;
  const c = data.case;
  const s = cur.step;
  const st = status[s.id];
  const info = ui.info || {};
  const isMain = (kind) => main?.stepId === s.id && main.kind === kind;
  const next = st === 'done' || st === 'skipped' ? nextStepAfter(c, lib, s) : null;
  const choosing = s.role === 'guide' && s.choose && st !== 'done' && st !== 'skipped';
  const own = cur.here ? { url: null, missing: [] } : addressOf(s);
  const parts = [];
  const after = [];
  let showsPage = false;
  // A step that isn't needed: why, and Do it anyway, which opens it as a normal step for this case.
  if (st === 'skipped') {
    const w = s.when;
    const what = varLabel(lib, w.field);
    parts.push(h('div', { class: 'stack', style: 'gap:6px', 'data-key': 'step-not-needed' },
      h('p', { class: 'small' }, `Only when the case ${w.is === 'missing' ? 'has no' : 'has a'} ${what}. This case ${w.is === 'missing' ? 'has one' : 'has none'}.`),
      h('button', {
        type: 'button', class: 'sm', 'data-key': 'step-anyway', style: 'align-self:flex-start',
        onclick: () => act.update((cs) => { wantStep(cs, s.id); logEvent(cs, 'reopen_step', { detail: s.name }); }, `${s.name} is open for this case`),
      }, 'Do it anyway')));
  }
  // What the page is to the case, when this is the step's page: the same controls, in the step.
  const otherCase = info.otherRef && c.ref;
  if (cur.here && s.role === 'input' && info.kind === 'source' && info.access && !otherCase && info.profile.id === s.profileId) {
    const b = clipBlock(context, info.profile, { main: isMain('clip'), stepId: s.id });
    parts.push(b.top);
    after.push(b.after);
    showsPage = true;
  } else if (cur.here && (s.role === 'input' || s.role === 'output') && info.access && !otherCase && ['source', 'form', 'confirm', 'blocked', 'unknown'].includes(info.kind)) {
    const ctl = contextCard(context, { inStep: true, main: isMain('clip') || isMain('fill') });
    if (ctl) parts.push(ctl);
    showsPage = true;
  }
  if (cur.here && info.kind === 'unknown') showsPage = true;
  // Where the case reference came from, on the step that chose it.
  if (s.role === 'guide' && s.choose && !info.otherRef) parts.push(refNotice(context));
  if (s.role === 'input' && !cur.here) {
    const p = lib.profiles.find((x) => x.id === s.profileId);
    const clip = c.clips.find((cl) => cl.profile?.id === s.profileId);
    if (clip && p) parts.push(h('div', { class: 'gv-head' }, h('b', {}, `Clipped at ${time(clip.capturedAt)}`)), valueList(context, p, clip, { live: false }), tallyLine(context, clipTally(c, lib, clip)));
  }
  if (s.role === 'email') parts.push(emailBlock(context, s, st === 'done', { main: isMain('email') }));
  if (s.role === 'scan') parts.push(scanBlock(context, s, st === 'done'));
  // The fetch step's own way on is the same place as Next, so it isn't repeated.
  if (s.role === 'fetch' && (cur.here || st === 'done')) parts.push(fetchBlock(context, s, { done: st === 'done', main: isMain('fetch'), then: !next }));
  if (main?.stepId === s.id && main.kind === 'on-page') parts.push(h('p', { class: 'on-page', 'data-key': 'step-on-page' }, h('span', { 'aria-hidden': 'true' }, '☞ '), main.text));
  // Its own page, when the caseworker isn't on it.
  if (own.url && st !== 'done') {
    parts.push(blockedLink(data, own.url, 'step-open') || h('button', {
      type: 'button', class: isMain('go') ? 'primary big' : 'sm', 'data-key': 'step-open', 'data-main': isMain('go') ? '' : undefined,
      onclick: () => (isMain('go') ? main.run() : open(own.url)),
    }, (s.links || []).find((l) => sameAddress(fillTemplate(l.url, vars).url, own.url))?.label || `Go to ${s.name}`));
  }
  // The flow's own links from this step. A page to clip offers them once it is clipped: until then the one
  // thing to do is clip it. A link to the page in view, to the step's own address, or to the step Next goes
  // to, isn't repeated. The others are ordinary buttons after the main one.
  const links = (s.links || []).map((l, i) => ({ l, i, f: fillTemplate(l.url, vars) }))
    .filter(({ l, f }) => !(s.role === 'input' && st !== 'done') && !sameAddress(f.url, ui.page?.url) && !(own.url && sameAddress(f.url, own.url)) && !(next && l.to === next.id) && !(next && f.url && sameAddress(f.url, addressOf(next).url)));
  const linkMain = (i) => main?.stepId === s.id && main.kind === 'link' && main.linkIndex === i;
  if (links.length) {
    (st === 'done' ? after : parts).push(h('div', { class: 'row', style: 'gap:6px' }, links.map(({ l, i, f }) => blockedLink(data, f.url, `step-link-${i}`, l.label) || h('button', {
      type: 'button', class: linkMain(i) ? 'primary big' : 'sm', 'data-key': `step-link-${i}`, disabled: !f.url, 'data-main': linkMain(i) ? '' : undefined,
      title: f.url ? f.url : `Needs ${f.missing.map((k) => varLabel(lib, k)).join(', ')}`,
      onclick: () => {
        if (linkMain(i)) { main.run(); return; }
        // A page to visit is done once the caseworker follows its link to the next page.
        if (s.role === 'guide' && l.to && st !== 'done') act.update((cs) => markStep(cs, s.id, true));
        open(f.url);
        act.update((cs) => logEvent(cs, 'follow_step_link', { detail: s.name })).catch(() => {});
      },
    }, l.label))));
  }
  // On to the next step, once this one is done.
  if (isMain('next')) {
    parts.push(h('button', { type: 'button', class: 'primary big', 'data-key': 'step-next', 'data-main': '', onclick: () => main.run() }, h('span', {}, 'Next: ', h('b', {}, next?.name || '')), h('span', { 'aria-hidden': 'true' }, ' →')));
  }
  if (isMain('finish') && !next) parts.push(h('button', { type: 'button', class: 'primary big', 'data-key': 'steps-finish', 'data-main': '', onclick: () => act.finish() }, 'Finish case'));
  // What a link needs ("the links need Tenancy reference") is asked for only when something shown needs it,
  // and says where it comes from.
  const nextAt = next ? addressOf(next) : null;
  const missing = [...new Set([
    ...own.missing,
    ...links.flatMap(({ f }) => f.missing),
    ...(nextAt?.missing || []),
    ...(s.role === 'email' ? emailFor(s.email, caseVars(c, lib, { text: true })).missing : []),
    ...(s.role === 'fetch' && (cur.here || st === 'done') ? fetchMissing(c, lib, s) : []),
  ])];
  if (missing.length) {
    const from = missing.map((k) => (k === 'ref' ? steps.find((x) => x.role === 'guide' && x.choose) : steps.find((x) => x.role === 'input' && x.id !== s.id && Object.prototype.hasOwnProperty.call(lib.profiles.find((p) => p.id === x.profileId)?.fields || {}, k)))).find(Boolean);
    parts.push(h('div', { class: 'stack needs', style: 'gap:4px', 'data-key': 'step-needs' },
      h('span', { class: 'small' }, `${s.role === 'email' ? 'The email needs' : 'To go on, Power Loader needs'} the ${missing.map((k) => varLabel(lib, k)).join(' and ')}. `,
        from ? [h('button', { type: 'button', class: 'link sm', 'data-key': 'step-needs-from', onclick: () => { ui.view.step = from.id; act.render(); } }, `${from.name} has ${missing.length === 1 ? 'it' : 'them'}`), ', or type ', missing.length === 1 ? 'it' : 'them', ' here:'] : `Type ${missing.length === 1 ? 'it' : 'them'} here:`),
      missing.map((k) => missingInput(context, k))));
  }
  if (choosing) parts.push(typeRefInput(context, s));
  // After the main button: a page or form that reads the wrong thing is mended in Build.
  if ((s.role === 'input' && st === 'done' && !showsPage) || (s.role === 'output' && cur.here)) after.push(fixLink(context, { stepId: s.id }));

  const skip = s.role === 'input' ? 'Skip this page' : s.role === 'output' ? 'Done with this form' : s.role === 'email' ? 'Sent another way, or not needed' : s.role === 'guide' ? 'Mark as done' : 'Skip this step';
  const foot = h('div', { class: 'row step-foot' },
    choosing || st === 'skipped' ? null : st === 'done'
      ? (c.steps?.[s.id] ? h('button', { type: 'button', class: 'link sm', 'data-key': 'step-undo', onclick: () => act.update((cs) => markStep(cs, s.id, false), `${s.name} is open again`) }, 'Not done yet') : null)
      : h('button', {
        type: 'button', class: 'link sm', 'data-key': 'step-done',
        onclick: () => {
          const after2 = nextStepAfter(c, lib, s);
          act.update((cs) => { markStep(cs, s.id, true); logEvent(cs, ['input', 'scan', 'fetch'].includes(s.role) ? 'skip_step' : 'complete_step', { detail: s.name }); }, after2 ? `Next: ${after2.name}` : 'Every step is done').then(() => { ui.view.step = null; act.render(); });
        },
      }, skip),
    cur.chosen ? h('button', { type: 'button', class: 'link sm', 'data-key': 'step-current', onclick: () => { ui.view.step = null; act.render(); } }, 'Back to where you are') : null);
  const body = h('div', { class: 'step-body', 'data-key': 'step-body' },
    h('div', { class: 'step-kind small muted' }, `${STEP_ROLE[s.role]}${cur.here ? ' · you’re on it now' : ''}`),
    s.text ? h('p', { class: 'step-text' }, s.text) : null,
    parts, after, foot);
  return { body, showsPage };
}

// The active case in the sidebar: what this page is to the case, conflicts, per-form progress, clips and fields.
import { h, plural, time, draftInput, clearDraft, drafts, announce } from '../ui/dom.js';
import {
  caseKeys, conflictKeys, confirmIdentity, contribution, decide, excludeValue, fieldState, fillStale, formProgress, identityWarnings,
  isRequired, markSubmitted, neededBy, notNeededKeys, removeForm, restoreValue, setManual, settled, undecide, unmarkSubmitted, addForm,
} from '../lib/case.js';
import { display } from '../lib/fields.js';
import { logEvent } from '../lib/activity.js';
import { libraryUpdates, pageLogInfo, updateCaseLibrary } from '../lib/core.js';
import { confirmDialog } from '../ui/dialog.js';
import { aiReady } from '../lib/ai/settings.js';
import { caseVars, currentStep, fillTemplate, markStep, stepAddress, stepStatus } from '../lib/journey.js';

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

const STEP_ICON = { done: '✓', filled: '◐', todo: '·' };
const STEP_ROLE = { guide: 'Page to visit', input: 'Page to clip', output: 'Form to fill' };
const varLabel = (lib, k) => (k === 'ref' ? 'Case reference' : label(lib, k));

// A value a link needs and the case doesn't have yet: the case reference, or a value typed by the caseworker.
function missingInput(context, k) {
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
 * The steps the flow (or library) gives this case: the step for this page, or the next one not done, with
 * what to do and the links to click. Links are filled in from the case; a value one needs can be typed here.
 */
function stepsCard(context) {
  const { ui, data, lib, act } = context;
  const steps = lib.steps || [];
  if (!steps.length) return null;
  const c = data.case;
  const vars = caseVars(c, lib);
  const status = Object.fromEntries(steps.map((s) => [s.id, stepStatus(c, s)]));
  const done = steps.filter((s) => status[s.id] === 'done').length;
  const chosen = ui.view.step && steps.find((s) => s.id === ui.view.step);
  const cur = chosen ? { step: chosen, index: steps.indexOf(chosen), here: false, chosen: true } : currentStep(c, lib, ui.page?.url);
  const open = (url, { link = false } = {}) => {
    act.openUrl(url);
    if (link) act.update((cs) => logEvent(cs, 'follow_step_link', { detail: cur.step.name })).catch(() => {});
  };
  const list = ui.view.steps ? h('ol', { class: 'plain stack', style: 'gap:2px' }, steps.map((s, i) => h('li', {},
    h('button', {
      type: 'button', class: `link sm${cur?.step.id === s.id ? ' strong' : ''}`, 'data-key': `step-go-${s.id}`, 'aria-current': cur?.step.id === s.id ? 'step' : undefined,
      onclick: () => { ui.view.step = s.id; act.render(); },
    }, h('span', { 'aria-hidden': 'true' }, `${STEP_ICON[status[s.id]]} `), `${i + 1}. ${s.name}`, h('span', { class: 'sr' }, `, ${status[s.id] === 'done' ? 'done' : status[s.id] === 'filled' ? 'filled, not submitted' : 'to do'}`))))) : null;
  const head = h('div', { class: 'row between' },
    h('h3', {}, `Steps · ${done} of ${steps.length} done`),
    h('button', { type: 'button', class: 'link sm', 'data-key': 'steps-all', 'aria-expanded': String(!!ui.view.steps), onclick: () => { ui.view.steps = !ui.view.steps; act.render(); } }, ui.view.steps ? 'Hide the steps' : 'All steps'));
  if (!cur) return h('div', { class: 'card steps' }, head, list, h('p', {}, h('b', {}, 'Every step is done. '), 'Finish the case when the forms are submitted.'));
  const s = cur.step;
  const st = status[s.id];
  const own = !cur.here ? stepAddress(lib, s) : '';
  const ownUrl = own ? fillTemplate(own, vars) : null;
  const links = s.links || [];
  const missing = [...new Set(links.flatMap((l) => fillTemplate(l.url, vars).missing))];
  const next = steps.slice(cur.index + 1).find((x) => status[x.id] !== 'done');
  return h('div', { class: 'card steps', role: 'region', 'aria-label': 'Steps' },
    head, list,
    h('div', { class: 'ctx-head' }, h('span', { class: `pill ${st === 'done' ? 'ok' : 'acc'}` }, `Step ${cur.index + 1}${st === 'done' ? ' · done' : st === 'filled' ? ' · filled' : ''}`), h('strong', {}, s.name)),
    h('span', { class: 'small muted' }, `${STEP_ROLE[s.role]}${cur.here ? ' · you’re on it now' : ''}`),
    s.text ? h('p', { style: 'white-space:pre-wrap' }, s.text) : null,
    own && ownUrl?.url && !cur.here ? h('button', { type: 'button', class: 'sm', 'data-key': 'step-open', style: 'align-self:flex-start', onclick: () => open(ownUrl.url) }, `Go to ${s.name}`) : null,
    links.length ? h('div', { class: 'stack', style: 'gap:4px' }, links.map((l, i) => {
      const f = fillTemplate(l.url, vars);
      return h('button', {
        type: 'button', class: i === 0 ? 'primary sm' : 'sm', 'data-key': `step-link-${i}`, style: 'align-self:flex-start', disabled: !f.url,
        title: f.url ? f.url : `Needs ${f.missing.map((k) => varLabel(lib, k)).join(', ')}`,
        onclick: () => {
          open(f.url, { link: true });
          // A page to visit is done once the caseworker follows its link to the next page.
          if (s.role === 'guide' && l.to && st !== 'done') act.update((cs) => markStep(cs, s.id, true));
          if (chosen) ui.view.step = null;
        },
      }, l.label);
    })) : null,
    missing.length ? h('div', { class: 'stack', style: 'gap:4px' },
      h('span', { class: 'small' }, `${missing.length === 1 ? 'A link needs' : 'The links need'} ${missing.map((k) => varLabel(lib, k)).join(' and ')}. Clip the page that has ${missing.length === 1 ? 'it' : 'them'}, or type ${missing.length === 1 ? 'it' : 'them'} here:`),
      missing.map((k) => missingInput(context, k))) : null,
    h('div', { class: 'row' },
      st === 'done'
        ? (c.steps?.[s.id] ? h('button', { type: 'button', class: 'link sm', 'data-key': 'step-undo', onclick: () => act.update((cs) => markStep(cs, s.id, false), `${s.name} is open again`) }, 'Not done yet') : null)
        : h('button', {
          type: 'button', class: 'sm', 'data-key': 'step-done',
          onclick: () => act.update((cs) => { markStep(cs, s.id, true); logEvent(cs, s.role === 'input' ? 'skip_step' : 'complete_step', { detail: s.name }); }, next ? `Next: ${next.name}` : 'Every step is done').then(() => { ui.view.step = null; act.render(); }),
        }, s.role === 'input' ? 'Skip this page' : s.role === 'output' ? 'Done with this form' : next ? `Done: next is ${next.name}` : 'Done'),
      cur.chosen ? h('button', { type: 'button', class: 'link sm', 'data-key': 'step-current', onclick: () => { ui.view.step = null; act.render(); } }, 'Back to the current step') : null));
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

function contextCard(context) {
  const { ui, data, lib, act } = context;
  const c = data.case;
  const info = ui.info || { kind: 'none' };
  if (info.kind === 'none') return h('div', { class: 'card' }, h('p', { class: 'muted' }, 'Power Loader works on web pages (http and https).'));
  if (!info.access) {
    let host = '';
    try { host = new URL(ui.page.url).host; } catch { /* not a URL */ }
    return h('div', { class: 'card' },
      h('div', { class: 'ctx-head' }, h('span', { class: 'pill' }, 'No access')),
      h('p', {}, 'Power Loader needs your permission to read pages on this site.'),
      h('button', { type: 'button', class: 'primary', 'data-key': 'allow', onclick: () => act.requestAccess() }, `Allow on ${host}`));
  }
  if (info.kind === 'source') {
    const p = info.profile;
    const clip = c.clips.find((x) => x.source === `${p.id}|${ui.page.url}`);
    const s = ui.lastClip?.url === ui.page.url ? ui.lastClip.summary : null;
    return h('div', { class: 'card ctx src' },
      h('div', { class: 'ctx-head' }, h('span', { class: p.draft ? 'pill magic' : 'pill acc' }, p.draft ? `Your draft ${p.version}` : 'Recognised'), h('strong', {}, p.name)),
      clip ? [
        h('p', { class: 'muted' }, `Clipped at ${time(clip.capturedAt)}${ui.lastClip?.url === ui.page.url && ui.lastClip.auto ? ' automatically' : ''}.`),
        s ? h('div', { class: 'diff' },
          s.added.length ? h('span', { class: 'pill ok' }, `+${s.added.length} new`) : null,
          s.agreed.length ? h('span', { class: 'pill' }, `${s.agreed.length} matched`) : null,
          s.conflicts.length ? h('span', { class: 'pill bad' }, `${plural(s.conflicts.length, 'conflict')}: ${labels(lib, s.conflicts)}`) : null,
          s.records ? h('span', { class: 'pill' }, `${plural(s.records, 'row')} for tools`) : null,
          s.extra.length ? h('span', { class: 'pill' }, `${s.extra.length} extra kept`) : null) : null,
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'sm', 'data-key': 'clip', disabled: !!ui.busy, onclick: () => act.clip(p) }, 'Clip again'),
          h('button', { type: 'button', class: 'sm', 'data-key': 'undo-clip', onclick: () => act.removeClip(clip.id) }, 'Undo this clip')),
        aiButton(context, 'ai-extract', '✦ Read this page with AI', () => act.extractWithAI()),
        updateLink(context, p),
      ] : [
        h('button', { type: 'button', class: 'primary big', 'data-key': 'clip', disabled: !!ui.busy, onclick: () => act.clip(p) }, ui.busy === 'clip' ? [h('span', { class: 'spinner' }), ' Clipping…'] : 'Clip this page'),
        h('p', { class: 'small muted' }, `Reads ${plural(Object.keys(p.fields || {}).length, 'item')} with the ${p.draft ? 'draft' : 'library'} profile ${p.id} ${p.version}.`),
        updateLink(context, p),
      ]);
  }
  if (info.kind === 'form') {
    const f = lib.forms[info.formId];
    if (!c.forms.some((x) => x.id === info.formId)) {
      return h('div', { class: 'card' },
        h('div', { class: 'ctx-head' }, h('span', { class: 'pill' }, 'Form'), h('strong', {}, f.name)),
        h('p', { class: 'muted' }, 'This form isn’t part of the current case.'),
        h('button', { type: 'button', class: 'sm', 'data-key': 'add-form', onclick: () => act.update((cs, l) => addForm(cs, l, f.id), `${f.name} added to the case`) }, 'Add it to this case'));
    }
    const pr = formProgress(c, lib, f.id);
    const stale = fillStale(c, lib, f.id);
    return h('div', { class: 'card ctx form' },
      h('div', { class: 'ctx-head' }, h('span', { class: 'pill ok' }, 'Target form'), h('strong', {}, `${f.name} ${f.version}`)),
      stale ? h('div', { class: 'notice bad', role: 'alert' }, 'Check again: this form was filled before the case changed. Values from a removed or changed source may still be in it. Fill it again, then check every box.') : null,
      c.filled[f.id] ? null : h('p', { class: 'muted' }, `${pr.done} of ${pr.req} required fields ready${pr.conflicts.length ? `, ${plural(pr.conflicts.length, 'conflict')} will be left empty` : ''}${pr.invalid.length ? `, ${pr.invalid.length} need fixing` : ''}${pr.missing.length ? `, ${pr.missing.length} missing` : ''}.`),
      info.fillProfile ? (context.renderFill ? context.renderFill(f) : null)
        : [h('p', { class: 'small muted' }, 'The library has no fill profile for this form yet. Fill profiles are usually made by your library team and shared with everyone.'),
          h('button', { type: 'button', class: 'sm', 'data-key': 'make-fill', style: 'align-self:flex-start', onclick: () => act.makeFillProfile(f) }, 'Make a fill profile')],
      aiButton(context, 'ai-form', '✦ Map this form with AI', () => act.mapFormWithAI(f)),
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
  return unrecognisedCard(context);
}

// Any caseworker can fix a page profile that reads the wrong thing: the new version is a draft on this
// computer, used here once tested, and exported for the library team to publish.
export function updateLink({ act, data }, profile) {
  // A case from a flow: its profiles are changed in the Flows tab, not as library drafts.
  if (data?.case?.library?.flow) {
    return h('button', { type: 'button', class: 'link sm', 'data-key': 'update-profile', onclick: () => act.setTab('flows') }, `Something wrong or missing? Change the flow ${data.case.library.flow.name || ''}`.trim());
  }
  return h('button', { type: 'button', class: 'link sm', 'data-key': 'update-profile', onclick: () => act.updateProfile(profile) },
    profile.draft ? 'Edit your draft of this profile' : 'Something wrong or missing? Update this profile');
}

export function unrecognisedCard(context, start = false) {
  const { act } = context;
  return h('div', { class: 'card' },
    h('div', { class: 'ctx-head' }, h('span', { class: 'pill' }, 'Not recognised')),
    h('p', { class: 'muted' }, `No profile in your library reads this page.${start ? '' : ' Go to a client system page to clip, or make a profile for this one.'}`),
    h('button', { type: 'button', class: 'sm primary', 'data-key': 'make-profile', style: 'align-self:flex-start', onclick: () => act.makeProfile() }, 'Make a profile for this page'),
    start ? null : aiButton(context, 'ai-extract', '✦ Extract with AI', () => act.extractWithAI()),
    // The remote AI's profile suggestion is in the editor, once the targets are chosen.
    aiReady(context.data.settings) ? h('p', { class: 'small muted' }, 'With the remote AI on, you can ask it for the profile once you’ve chosen what the page is for.') : null);
}

// ✦ buttons appear when Enhanced tools are set up. Every one goes through the redaction preview first.
function aiButton({ data, aiBusy }, key, label, onclick) {
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
  return h('div', { class: 'cf' },
    h('div', { class: 'cf-title' }, h('b', {}, label(lib, k)), h('span', { class: 'small muted' }, neededBy(c, lib, k).map((id) => lib.forms[id]?.short || id).join(' · '))),
    st.reopened ? h('p', { class: 'small' }, h('b', {}, 'The sources changed since you decided. '), `You chose ${display(d, st.previous)}. Decide again.`) : null,
    st.cands.map((cd, i) => h('div', { class: 'opt' },
      h('span', { class: 'v' }, display(d, cd.value)),
      h('span', { class: 's' }, cd.sources.map((id) => c.clips.find((x) => x.id === id)).filter(Boolean).map((x) => `${x.name} ${time(x.capturedAt)}`).join(', ')),
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
          s ? h('span', { class: 'r' }, s.how === 'observed' ? 'Submitted (seen)' : 'Submitted (you said)') : null)),
        c.forms.length > 1 ? h('button', {
          type: 'button', class: 'link sm', 'data-key': `rm-form-${fv.id}`, style: 'align-self:flex-end',
          onclick: async () => {
            const ok = await confirmDialog({
              title: `Remove ${f.name} from this case?`,
              text: ['Evidence that only this form needed stays in the case, marked “not needed by these forms”, until you remove the clip or the case ends.'],
              confirm: 'Remove form',
            });
            if (ok) act.update((cs) => removeForm(cs, fv.id), `${f.name} removed from the case`);
          },
        }, `Remove ${f.short || f.name}`) : null);
    }));
}

// ------------------------------------------------------------------ clips

function clipsCard(context) {
  const { ui, data, lib, act } = context;
  const c = data.case;
  const list = [...c.clips].reverse();
  const keys = new Set(caseKeys(c, lib));
  return h('div', { class: 'card' },
    h('div', { class: 'row between' }, h('h3', {}, `Clips · ${c.clips.length}`), h('span', { class: 'small muted' }, 'Newest first')),
    list.length ? list.map((cl) => {
      const ks = Object.keys(cl.values);
      const states = ks.map((k) => contribution(c, lib, cl, k, { keys }));
      const used = states.filter((s) => s.s === 'used').length;
      const conf = states.filter((s) => s.s === 'conflict').length;
      const open = ui.view.clipOpen === cl.id;
      return h('div', { class: `clip${conf ? ' has-conf' : ''}` },
        h('div', { class: 'clip-top' },
          h('div', { class: 'clip-main' },
            h('b', {}, cl.name, cl.profile?.draft ? h('span', { class: 'pill magic', style: 'margin-left:6px' }, 'draft') : null),
            h('span', { class: 'muted' }, `${time(cl.capturedAt)} · ${shortUrl(cl.url)}`),
            h('span', { class: 'diff' },
              used ? h('span', { class: 'pill ok' }, `${used} used`) : null,
              conf ? h('span', { class: 'pill bad' }, `${conf} in conflict`) : null,
              cl.records?.length ? h('span', { class: 'pill' }, `${cl.records.length} rows`) : null,
              !used && !conf && !cl.records?.length ? h('span', { class: 'pill' }, 'Nothing used') : null,
              cl.identity && !cl.identity.confirmed ? h('span', { class: 'pill bad' }, 'May be a different person') : null)),
          h('div', { class: 'row', style: 'flex-wrap:nowrap' },
            h('button', { type: 'button', class: 'sm', 'data-key': `view-${cl.id}`, 'aria-expanded': String(open), 'aria-controls': `clip-${cl.id}`, onclick: () => { ui.view.clipOpen = open ? null : cl.id; act.render(); } }, open ? 'Hide' : 'View'),
            h('button', { type: 'button', class: 'sm', 'data-key': `remove-${cl.id}`, onclick: () => act.removeClip(cl.id) }, 'Remove'))),
        open ? h('div', { class: 'clip-vals', id: `clip-${cl.id}` },
          ks.map((k, i) => h('div', { class: 'row between', style: 'flex-wrap:nowrap;align-items:baseline' },
            h('span', { style: 'min-width:0' }, `${label(lib, k)}: `, h('b', {}, display(lib.fields[k], cl.values[k]))),
            h('span', { class: `pill ${states[i].c}` }, states[i].s === 'over' ? 'Not used' : states[i].t),
            states[i].s === 'extra' ? null : h('button', {
              type: 'button', class: 'link sm', 'data-key': `ex-${cl.id}-${k}`,
              onclick: () => act.update((cs, l) => {
                if (states[i].s === 'excluded') { restoreValue(cs, cl.id, k); logEvent(cs, 'restore_source_value', { page: here(context), detail: label(l, k) }); }
                else { excludeValue(cs, cl.id, k); logEvent(cs, 'exclude_source_value', { page: here(context), detail: label(l, k) }); }
              }, states[i].s === 'excluded' ? `${label(lib, k)} restored` : `${label(lib, k)} from ${cl.name} excluded`),
            }, states[i].s === 'excluded' ? 'Restore' : 'Exclude'))),
          cl.records?.length ? h('span', { class: 'muted small' }, `${plural(cl.records.length, 'row')} for the tools`) : null,
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

// A case keeps the library version it started with until it ends, or until you update it here.
function updateNotice({ data, act }) {
  const up = libraryUpdates(data.library, data.case);
  if (!up) return null;
  const text = up.forms.length
    ? `${up.forms.map((f) => `${f.name} ${f.to}`).join(', ')} ${up.forms.length === 1 ? 'is' : 'are'} in the library. This case keeps ${up.forms.map((f) => f.from).join(', ')} until it ends.`
    : `The library has a newer commit (${up.commit}). This case keeps commit ${data.case.library.commit} until it ends.`;
  return h('div', { class: 'notice small' }, h('p', {}, text),
    h('button', {
      type: 'button', class: 'sm', 'data-key': 'update-case-lib',
      onclick: async () => {
        try { await updateCaseLibrary(data.case.id); announce('This case now uses the latest library'); } catch (e) { announce(e.message); }
        act.refresh();
      },
    }, up.forms.length ? `Update this case to ${up.forms.map((f) => `${f.name.split(' ')[0]} ${f.to}`).join(', ')}` : 'Update this case to the latest library'));
}

export function renderCaseTab(context) {
  const { data, lib } = context;
  const c = data.case;
  const conflicts = conflictKeys(c, lib);
  return [
    ...identityWarnings(c).map((cl) => identityCard(context, cl)),
    updateNotice(context),
    stepsCard(context),
    contextCard(context),
    conflicts.length ? h('div', { class: 'conflicts', id: 'conflicts' },
      h('h3', {}, `⚠ ${plural(conflicts.length, 'conflict')} to decide`),
      h('p', { class: 'small' }, 'Sources disagree. Conflicting fields are left empty when you fill a form.'),
      conflicts.map((k) => conflictCard(context, k))) : null,
    progressCard(context),
    clipsCard(context),
    notNeededCard(context),
    ...fieldsBlock(context),
  ];
}

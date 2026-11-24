// Dialogs that change the case as a whole: removing a clip, finishing and discarding.
import { h, plural, time, announce, copyText, describeError } from '../ui/dom.js';
import { openDialog } from '../ui/dialog.js';
import { caseJson, caseLabel, caseText, clipDependents, clipImpact, conflictKeys, counts, fillStale, removeClip } from '../lib/case.js';
import { logEvent, purgeSets, removeEvents } from '../lib/activity.js';
import { endCase } from '../lib/teardown.js';

const REASONS = ['Wrong person', 'Wrong page', 'Out of date', 'Other'];
const labels = (lib, keys) => keys.map((k) => lib.fields[k]?.label || k).join(', ');

// "Wrong person" clears everything that depends on the clip and purges the page from the log.
export function openRemoveClip({ data, lib, act }, clipId, preset) {
  const state = { reason: preset || '', clear: preset === 'Wrong person', log: preset === 'Wrong person' ? 'page' : 'keep' };
  const c = data.case;
  const clip = c.clips.find((x) => x.id === clipId);
  if (!clip) return;
  const impact = clipImpact(c, lib, clipId);
  const deps = clipDependents(c, lib, clipId);
  const sets = purgeSets(c, clip);
  const radio = (name, value, title, sub, onpick) => h('label', { class: 'radio' },
    h('input', { type: 'radio', name, value, checked: state[name] === value, onchange: () => { onpick(value); d.refresh(); } }),
    h('span', {}, h('b', {}, title), sub ? h('small', {}, sub) : null));
  const d = openDialog({
    title: 'Remove clip',
    initialFocus: preset ? '[data-act=remove]' : undefined,
    body: (dlg) => [
      h('div', {}, h('b', {}, clip.name), h('div', { class: 'small muted url' }, `${clip.url} · clipped ${time(clip.capturedAt)}`)),
      h('div', {}, h('b', {}, 'What changes in the case'), h('ul', { class: 'impact' },
        h('li', {}, `${plural(Object.keys(clip.values).length, 'value')}${clip.records?.length ? ` and ${plural(clip.records.length, 'row')} for the tools` : ''} leave the case.`),
        impact.conflictsGone.length ? h('li', {}, `Conflicts that go away: ${labels(lib, impact.conflictsGone)}`) : null,
        impact.becomeMissing.length ? h('li', {}, h('b', {}, 'Become missing: '), labels(lib, impact.becomeMissing)) : null,
        impact.changed.length ? h('li', {}, `Values that change: ${labels(lib, impact.changed)}`) : null)),
      deps.any ? h('div', {}, h('b', {}, 'Also depends on this clip'), h('ul', { class: 'impact' },
        deps.manual.length ? h('li', {}, `Values you typed for: ${labels(lib, deps.manual)}`) : null,
        deps.choices.length ? h('li', {}, `Choices you made using its value: ${labels(lib, deps.choices)}`) : null,
        deps.workings.length ? h('li', {}, `Saved workings: ${c.workings.filter((w) => deps.workings.includes(w.id)).map((w) => w.title).join(', ')}`) : null,
        deps.periods.length ? h('li', {}, `Timeline periods found in it with AI: ${plural(deps.periods.length, 'period')}`) : null,
        deps.filled.length ? h('li', {}, h('b', {}, 'Forms already filled while it was in the case: '),
          `${deps.filled.map((id) => lib.forms[id]?.name || id).join(', ')}. Values from it may still be in ${deps.filled.length === 1 ? 'that form' : 'those forms'}, so ${deps.filled.length === 1 ? 'it' : 'they'} will be marked “check again”. Power Loader can’t empty a page it doesn’t control.`) : null),
      deps.manual.length + deps.choices.length + deps.workings.length + deps.periods.length ? h('label', { class: 'confirm-box' },
        h('input', { type: 'checkbox', checked: state.clear, onchange: (e) => { state.clear = e.target.checked; } }),
        h('span', {}, 'Clear these too')) : null) : null,
      h('fieldset', {}, h('legend', {}, 'Why are you removing it? (optional)'),
        h('div', { class: 'row', style: 'gap:6px 16px' }, REASONS.map((r) => radio('reason', r, r, null, (v) => {
          state.reason = v;
          if (v === 'Wrong person') { state.clear = true; if (state.log === 'keep') state.log = 'page'; }
        })))),
      h('fieldset', {}, h('legend', {}, 'Activity log'),
        radio('log', 'keep', 'Keep the log and record the removal', `Adds “Remove source${state.reason ? ` · ${state.reason}` : ''}”, so the correction shows up in process mining.`, (v) => { state.log = v; }),
        radio('log', 'own', `Remove this clip from the log (${plural(sets.own.length, 'item')})`, 'The visit to the page stays.', (v) => { state.log = v; }),
        radio('log', 'page', `Remove the clip and everything logged on that page (${plural(sets.page.length, 'item')})`, 'Use this for a page about the wrong person. Nothing about it stays in the log.', (v) => { state.log = v; })),
      h('div', { class: 'actions' },
        h('button', { type: 'button', onclick: () => dlg.close() }, 'Cancel'),
        h('button', {
          type: 'button', class: 'danger', 'data-act': 'remove',
          onclick: async () => {
            dlg.close();
            await act.update((cs, l) => {
              const cl = cs.clips.find((x) => x.id === clipId);
              if (!cl) throw new Error('That clip is no longer in the case');
              const ids = (state.log === 'own' ? purgeSets(cs, cl).own : state.log === 'page' ? purgeSets(cs, cl).page : []).map((e) => e.id);
              removeClip(cs, l, clipId, { clearDependents: state.clear || state.reason === 'Wrong person' });
              if (state.log === 'keep') logEvent(cs, 'remove_source', { page: { type: `${cl.profile?.id || ''}@${cl.profile?.version || ''}` }, detail: `${cl.name}${state.reason ? ` · ${state.reason}` : ''}` });
              else removeEvents(cs, ids);
            }, `${clip.name} removed${state.log === 'keep' ? '' : ' and purged from the log'}`);
          },
        }, 'Remove clip')),
    ],
  });
}

// Finish: submissions are shown as seen or as reported, then the case is deleted with one teardown.
export function openFinish(context) {
  const { data, lib } = context;
  const c = data.case;
  const state = { ok: false, busy: false };
  const conflicts = conflictKeys(c, lib).length;
  const n = counts(c);
  openDialog({
    title: 'Finish case',
    body: (dlg) => {
      const allDone = c.forms.every((f) => c.submitted[f.id]);
      return [
        h('p', { class: 'muted' }, caseLabel(c, lib)),
        h('ol', { class: 'steps' },
          h('li', { class: allDone ? 'ok' : 'warn' }, h('div', {}, h('b', {}, 'Submit the forms'),
            h('ul', { class: 'plain', style: 'margin-top:4px' }, c.forms.map((fv) => {
              const f = lib.forms[fv.id];
              const s = c.submitted[fv.id];
              const st = s?.how === 'observed' ? h('span', { class: 'pill ok' }, `✓ Submitted, seen on the confirmation page${s.ref ? ` (${s.ref})` : ''}`)
                : s ? h('span', { class: 'pill ok' }, '✓ Submitted, reported by you')
                  : c.filled[fv.id] ? h('span', { class: 'pill warn' }, fillStale(c, lib, fv.id) ? 'Filled, needs checking, not submitted' : 'Filled, not submitted')
                    : h('span', { class: 'pill warn' }, 'Not filled');
              return h('li', { class: 'row between' }, h('span', {}, f?.name || fv.id), st);
            })),
            allDone ? null : h('p', { class: 'small muted' }, 'You can still finish. Unsubmitted forms will need the data typing in again.'))),
          h('li', {}, h('div', {}, h('b', {}, 'Keep a copy (optional)'),
            h('p', { class: 'small muted' }, `Paste it into the case notes if your team keeps one.${conflicts ? ` Includes ${plural(conflicts, 'unresolved conflict')}.` : ''}`),
            h('div', { class: 'row' },
              h('button', { type: 'button', class: 'sm', onclick: () => copyText(caseText(c, lib), 'Case text') }, 'Copy as text'),
              h('button', { type: 'button', class: 'sm', onclick: () => copyText(JSON.stringify(caseJson(c, lib), null, 2), 'Case JSON') }, 'Copy as JSON')))),
          h('li', {}, h('div', {}, h('b', {}, 'Delete case data from this browser'),
            h('p', { class: 'small muted' }, `${plural(n.clips, 'clip')}, ${plural(n.values, 'value')}, ${plural(n.decisions, 'decision')}${n.workings ? ` and ${plural(n.workings, 'saved working')}` : ''}. This can’t be undone.`),
            h('p', { class: 'small muted' }, `The activity log (${plural(c.log.length + 1, 'event')}) is kept without case values or real links. Notes stay on this computer.`)))),
        h('label', { class: 'confirm-box' },
          h('input', { type: 'checkbox', checked: state.ok, onchange: (e) => { state.ok = e.target.checked; dlg.refresh(); } }),
          h('span', {}, 'I’ve submitted what I need and copied anything I want to keep.')),
        h('div', { class: 'actions' },
          h('button', { type: 'button', onclick: () => dlg.close() }, 'Not yet'),
          h('button', { type: 'button', class: 'danger', disabled: !state.ok || state.busy, onclick: () => runTeardown(context, dlg, 'finished', state) }, 'Finish and delete data')),
      ];
    },
  });
}

export function openDiscard(context) {
  const { data, lib } = context;
  const c = data.case;
  const state = { busy: false };
  openDialog({
    title: 'Discard this case?',
    body: (dlg) => [
      h('p', {}, `This deletes ${plural(c.clips.length, 'clip')} and everything you entered for ${caseLabel(c, lib)} from this browser. Nothing in the client systems changes.`),
      h('p', { class: 'small muted' }, 'The activity log is kept without case values or real links, marked as discarded.'),
      h('div', { class: 'actions' },
        h('button', { type: 'button', onclick: () => dlg.close() }, 'Keep case'),
        h('button', { type: 'button', class: 'danger', disabled: state.busy, onclick: () => runTeardown(context, dlg, 'discarded', state) }, 'Discard case')),
    ],
  });
}

async function runTeardown({ data, act }, dlg, outcome, state) {
  state.busy = true;
  dlg.refresh();
  try {
    await endCase(data.case.id, outcome);
    dlg.close();
    announce(outcome === 'finished' ? 'Case finished and its data deleted' : 'Case discarded and its data deleted');
  } catch (e) {
    state.busy = false;
    dlg.refresh();
    announce(`Couldn’t finish deleting: ${describeError(e)}. Power Loader will finish it at the next start.`);
  }
  await act.refresh();
}

// No active case: start one from a flow. Every case is a case of a flow, so the start screen lists flows and
// nothing else: the library's and this computer's together, starred ones first.
import { h, plural, time } from '../ui/dom.js';
import { dropStars } from '../lib/core.js';
import { choosesFrom, pagesOf, startable } from '../lib/flows.js';
import { onboardCard } from './settings.js';
import { closedReceipt } from './close-warning.js';
import { clearsAfter } from '../lib/teardown.js';
import { libraryFlows, startFromFlow } from './flows.js';

// More flows than this and the list gets a search box.
const SEARCH_FROM = 8;

/**
 * Every flow a case can start from: { key, flow, libraryPath }. key is what its star is stored by: a library
 * flow's path, a flow on this computer's id.
 */
export function startFlows(context) {
  const fromLib = libraryFlows(context).map(({ path, flow }) => ({ key: path, flow, libraryPath: path }));
  const mine = (context.data.flows || []).map((flow) => ({ key: flow.id, flow, libraryPath: null }));
  return [...fromLib, ...mine];
}

function flowCard(context, { key, flow, libraryPath }) {
  const { ui, data, act } = context;
  const starred = (data.starred || []).includes(key);
  const chooses = pagesOf(flow, 'guide').some((p) => choosesFrom(flow, p));
  const can = startable(flow, { access: data.access });
  const name = flow.name || 'Untitled flow';
  const dk = flow.id;
  // What the flow does, without saying its name twice: a flow is usually named after its one form.
  const forms = pagesOf(flow, 'output').map((p) => p.name);
  const clips = pagesOf(flow, 'input').filter((p) => !p.parent).length;
  const does = [
    forms.length ? (forms.length === 1 && forms[0] === name ? 'Fills 1 form' : `Fills ${forms.join(' + ')}`) : null,
    clips ? `${forms.length ? 'clips' : 'Clips'} ${plural(clips, 'page')}` : null,
  ].filter(Boolean);
  return h('div', { class: 'fcard flow start', 'data-key': `flow-card-${dk}` },
    h('button', {
      type: 'button', class: 'star', 'data-key': `star-${dk}`, 'aria-pressed': String(starred),
      'aria-label': `${starred ? 'Unstar' : 'Star'} ${name}`, onclick: () => act.star(key),
    }, starred ? '★' : '☆'),
    h('span', { class: 'nm' }, name),
    h('span', { class: 'meta' }, [...(can.ok ? does : []), libraryPath ? 'from your library' : 'on this computer'].join(' · ')),
    can.ok ? null : h('span', { class: 'meta', 'data-key': `flow-cant-${dk}` }, `Can’t start yet: ${can.reason}`),
    h('span', { class: 'acts' }, h('button', {
      type: 'button', class: 'sm primary', 'data-key': `start-flow-${dk}`, disabled: !can.ok, title: can.ok ? undefined : can.reason,
      onclick: () => startFromFlow(context, flow, { libraryPath }),
    }, 'Start')),
    // The reference: from the case the caseworker opens, for a flow that chooses the case; typed here otherwise.
    h('details', { class: 'small', 'data-key': `flow-ref-${dk}` },
      h('summary', {}, chooses ? 'Type a case reference' : 'Add a case reference'),
      h('label', { class: 'field small' }, 'Case reference',
        h('span', { class: 'hint' }, `${chooses ? 'This flow takes the reference from the case you open, so only type one if the case isn’t in the system. ' : 'Optional. '}Kept on this computer only, and never in the activity log.`),
        h('input', { type: 'text', 'data-key': `flow-ref-input-${dk}`, value: ui.start.flowRef?.[flow.id] || '', placeholder: 'e.g. CM-58213', oninput: (e) => { ui.start.flowRef = { ...(ui.start.flowRef || {}), [flow.id]: e.target.value }; } }))));
}

/** The flows to start from: starred first, then the rest by name, with a search box once there are many. */
function flowList(context) {
  const { ui, data, act } = context;
  const all = startFlows(context);
  // A star whose flow has gone is dropped.
  const keys = all.map((x) => x.key);
  if ((data.starred || []).some((k) => !keys.includes(k))) void dropStars(keys).catch(() => {});
  const q = (ui.start.search || '').trim().toLowerCase();
  const shown = all.filter((x) => !q || (x.flow.name || '').toLowerCase().includes(q));
  const byName = (a, b) => (a.flow.name || '').localeCompare(b.flow.name || '');
  const starred = shown.filter((x) => (data.starred || []).includes(x.key)).sort(byName);
  const rest = shown.filter((x) => !(data.starred || []).includes(x.key)).sort(byName);
  if (!all.length) {
    // No library and no flows of its own: say so, and offer both ways on.
    return h('div', { class: 'card', 'data-key': 'no-flows' },
      h('p', {}, context.lib ? 'Your library has no flows yet. A case is always a run of a flow.' : 'There is no library connected, and no flows on this computer. A case is always a run of a flow.'),
      h('div', { class: 'row' },
        context.lib ? null : h('button', { type: 'button', class: 'sm primary', 'data-key': 'go-connect', onclick: () => act.setTab('settings') }, 'Connect a library'),
        h('button', { type: 'button', class: 'sm', 'data-key': 'go-build', onclick: () => act.setMode('build') }, 'Build a flow')));
  }
  return [
    all.length > SEARCH_FROM ? h('div', { class: 'row', style: 'flex-wrap:nowrap' },
      h('label', { class: 'sr', for: 'flow-search' }, 'Search flows'),
      h('input', { type: 'search', id: 'flow-search', 'data-key': 'flow-search', placeholder: 'Search flows', value: ui.start.search || '', oninput: (e) => { ui.start.search = e.target.value; act.render(); } })) : null,
    starred.length ? [
      h('div', { class: 'sec-title' }, h('span', {}, '★ Your flows')),
      h('div', { class: 'stack', 'data-key': 'flows-starred' }, starred.map((x) => flowCard(context, x))),
    ] : null,
    rest.length ? [
      h('div', { class: 'sec-title' }, h('span', {}, starred.length ? 'Other flows' : `Flows · ${all.length}`),
        starred.length ? null : h('span', { class: 'small' }, 'star the ones you work, and they come first')),
      h('div', { class: 'stack', 'data-key': 'flows-rest' }, rest.map((x) => flowCard(context, x))),
    ] : null,
    !starred.length && !rest.length ? h('p', { class: 'muted' }, 'No flows match.') : null,
  ];
}

export function renderStart(context) {
  const { ui, data } = context;
  const out = [];
  if (!context.lib && !startFlows(context).length) out.push(onboardCard(context));
  if (ui.info?.kind === 'source') {
    out.push(h('div', { class: 'card' },
      h('div', { class: 'ctx-head' }, h('span', { class: 'pill acc' }, 'Recognised'), h('strong', {}, ui.info.profile.name)),
      h('p', { class: 'muted' }, 'Start a case to clip this page.')));
  }
  if (data.receipt) {
    const r = data.receipt;
    const n = r.counts;
    if (r.outcome === 'closed' || r.outcome === 'expired') out.push(h('div', { class: 'card done-card', role: 'status', 'data-key': 'closed-receipt' }, closedReceipt(r, r.hours || clearsAfter(data.policy, data.settings).hours)));
    else out.push(h('div', { class: 'card done-card', role: 'status' },
      h('h2', {}, r.outcome === 'finished' ? 'Case finished' : 'Case discarded'),
      n ? h('p', {}, `Closed at ${time(r.at)}. ${plural(n.clips, 'clip')}, ${plural(n.values, 'value')}, ${plural(n.decisions, 'decision')}${n.workings ? ` and ${plural(n.workings, 'saved working')}` : ''} were deleted from this browser.`)
        : h('p', {}, `Closed at ${time(r.at)}. Its data was deleted from this browser.`),
      h('p', { class: 'small muted' }, 'Anything you copied to the clipboard, downloaded or typed into other systems isn’t affected. Power Loader can’t reach it.')));
  }
  out.push(
    h('div', { class: 'stack' },
      h('h2', { class: 'start-title' }, 'Start a case'),
      h('p', { class: 'muted' }, 'Choose the flow for the work you’re doing. Its steps take you through the case.')),
    flowList(context));
  return out;
}

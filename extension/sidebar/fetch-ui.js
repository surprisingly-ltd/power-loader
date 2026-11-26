// A fetch step on the Case tab: the pages it fetches, each with its state, the button that fetches them from
// the trigger page, Stop while it runs, what each added (with Undo), and where to go next. One run at a time;
// Stop and teardown cancel it. See docs/plans/fetch-steps.md and lib/fetch-steps.js.
/* global DOMParser */
import { h, announce, describeError, plural } from '../ui/dom.js';
import { ask, currentAccess, fetchFromTab, getCase, readListFromTab, updateCase } from '../lib/core.js';
import { boxLines } from '../lib/fetch-view.js';
import { FETCH_LIMITS, failureText, listNoun, planRun, runFetchStep, runSummary, shownRows } from '../lib/fetch-steps.js';
import { backgroundOffText, hostsLayer } from '../lib/access.js';
import { caseVars, fillFetchUrl, fillTemplate, isListRequest } from '../lib/journey.js';
import { addTallies, clipTally } from '../lib/case.js';
import { tallyLine } from './gather-ui.js';

const E = globalThis.PowerLoaderExtract;

// The run in progress or last finished: { stepId, controller, states, result }. lists: the links each list
// request found on its step's page, read when the card is shown there (so the button can say how many) and
// again at the press: { [stepId]: { url, hrefs: { [requestId]: [href] | null } } }. Nothing else is kept.
export const fetchUi = { stepId: null, controller: null, states: {}, result: null, lists: {} };

/** Stop the run, if any, and forget it: Stop, and teardown (resetCaseViews()). */
export function cancelFetches() {
  fetchUi.controller?.abort();
  Object.assign(fetchUi, { stepId: null, controller: null, states: {}, result: null, lists: {} });
}

const listRequests = (s) => (s.fetch?.requests || []).filter(isListRequest);

async function readLists(tabId, lib, s) {
  const out = {};
  for (const r of listRequests(s)) {
    try { out[r.id] = (await readListFromTab(tabId, lib, r))?.hrefs ?? null; } catch { out[r.id] = null; }
  }
  return out;
}

/**
 * On a fetch step's page, read its lists of links (the read check, as for recognising a page), so the card
 * can say Fetch 25 messages. Called by the sidebar as the tab changes. Nothing is fetched or kept.
 */
export async function syncLists({ ui, data, lib }) {
  if (!data.case || !lib || !ui.page?.url || !ui.info?.access) return;
  for (const s of lib.steps || []) {
    if (s.role !== 'fetch' || !listRequests(s).length || !(s.match?.length && E.matchUrl(s.match, ui.page.url))) continue;
    if (fetchUi.lists[s.id]?.url === ui.page.url) continue;
    fetchUi.lists[s.id] = { url: ui.page.url, hrefs: await readLists(ui.page.id, lib, s) };
  }
}

const listsFor = (s, url) => (fetchUi.lists[s.id]?.url === url ? fetchUi.lists[s.id].hrefs : {});
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const cell = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${Number(v.slice(8))} ${MONTHS[Number(v.slice(5, 7)) - 1]} ${v.slice(0, 4)}` : String(v ?? ''));

/** The values the step's addresses need that the case hasn't got, for the Steps card's inputs. */
export const fetchMissing = (c, lib, s) => {
  const vars = caseVars(c, lib);
  return [...new Set([...(s.fetch?.requests || []).filter((r) => !isListRequest(r)).flatMap((r) => fillFetchUrl(r.url, vars).missing), ...(s.fetch?.then?.url ? fillTemplate(s.fetch.then.url, vars).missing : [])])];
};

async function start(context, s, { rest = false } = {}) {
  const { ui, data, lib, act } = context;
  if (fetchUi.controller || !data.case) return;
  const controller = new AbortController();
  const caseId = data.case.id;
  const tab = { id: ui.page.id, url: ui.page.url };
  Object.assign(fetchUi, { stepId: s.id, controller, states: {}, result: null });
  act.render();
  try {
    // The links are read again at the press, so the run fetches what the page shows now.
    const lists = listRequests(s).length ? await readLists(tab.id, lib, s) : {};
    if (listRequests(s).length) fetchUi.lists[s.id] = { url: tab.url, hrefs: lists };
    const out = await runFetchStep({
      step: s, lib, c: data.case, tabUrl: tab.url, signal: controller.signal, DOMParser, lists, rest,
      access: () => currentAccess({ withHosts: true }),
      fetchPage: (url, o) => fetchFromTab(tab.id, url, o),
      update: (fn) => updateCase(caseId, fn),
      onProgress: (states) => { if (fetchUi.controller === controller) { fetchUi.states = states; act.render(); } },
      onShow: (event) => drawOnPage(context, tab, s, event),
    });
    // A run cancelled by teardown has nothing left to show.
    if (fetchUi.controller !== controller) return;
    Object.assign(fetchUi, { states: out.states, result: out });
    announce(out.problem ? problemText(out.problem, s) : [runSummary(out, s), showSentence(s, out, await getCase().catch(() => null))].filter(Boolean).join(' '));
  } catch (e) {
    if (fetchUi.controller === controller) announce(`Couldn’t fetch the pages: ${describeError(e)}`);
  } finally {
    if (fetchUi.controller === controller) fetchUi.controller = null;
    // refresh, not render: the page's markers are drawn from the case's new rows.
    await act.refresh();
  }
}

/**
 * Fetch again, asked for from the fetched view: the step's run starts if the tab is on its page and nothing
 * stops it; otherwise the step is open and says why.
 */
export async function runAgain(context, stepId) {
  const { ui, data, lib } = context;
  const s = (lib?.steps || []).find((x) => x.id === stepId && x.role === 'fetch');
  if (!s || !data.case || !ui.page) return;
  const layers = [...(data.access || []), hostsLayer(lib.approvedHosts || [])];
  const plan = planRun({ step: s, lib, c: data.case, layers, tabUrl: ui.page.url, lists: listsFor(s, ui.page.url) });
  if (backgroundOffText(data.background) || plan.problem || (!plan.items.some((i) => !i.problem) && !listRequests(s).length)) {
    announce(plan.problem ? problemText(plan.problem, s) : 'These pages can’t be fetched now.');
    return;
  }
  await start(context, s);
}

// ------------------------------------------------------------------ the boxes on the trigger page

let drawing = Promise.resolve();

/** "Messages 3 of 25" for a list's address, or the request's name. */
function itemLabel(s, item) {
  const m = /#(\d+)$/.exec(item.key || '');
  if (!m) return item.request.name;
  const total = fetchUi.states ? Object.keys(fetchUi.states).filter((k) => k.startsWith(`${item.request.id}#`)).length : 0;
  return `${listNoun(item.request, 1).replace(/^./, (c) => c.toUpperCase())} ${m[1]}${total ? ` of ${total}` : ''}`;
}

/**
 * Draw a request's box on the trigger page as the run goes (lib/gather.js fetchBox): opened, read (the text
 * view, outlined) or failed. Through ask(), so only where the site rules let Power Loader read that page, and
 * never waited for by the run. In order, one message at a time.
 */
function drawOnPage(context, tab, s, event) {
  const { lib } = context;
  const { item } = event;
  const id = item.key || item.request.id;
  const label = itemLabel(s, item);
  let msg;
  if (event.op === 'open') msg = { op: 'open', id, title: label, address: String(item.url || '').replace(/^https?:\/\//, '') };
  else if (event.op === 'fail') msg = { op: 'fail', id, line: event.text };
  else {
    const sm = event.summary;
    const box = event.view ? boxLines(event.view) : { rows: [], marks: [] };
    const n = sm.added.length + sm.agreed.length + sm.conflicts.length;
    const rows = sm.records ? plural(sm.records, 'row') : '';
    const what = [n ? plural(n, 'value') : '', rows, sm.conflicts.length ? plural(sm.conflicts.length, 'conflict') : ''].filter(Boolean).join(', ') || 'nothing for the case';
    const row = typeof document !== 'undefined' ? document.querySelector(`[data-key="fetch-row-${CSS.escape(item.request.id)}"]`) : null;
    const y = typeof window !== 'undefined' && typeof window.mozInnerScreenY === 'number' && window.mozInnerScreenY && row ? row.getBoundingClientRect().top + window.mozInnerScreenY : null;
    const x = typeof window !== 'undefined' && typeof window.mozInnerScreenX === 'number' && window.mozInnerScreenX ? window.mozInnerScreenX : null;
    msg = {
      op: 'read', id, line: `${label}: ${what}`, conflict: sm.conflicts.length > 0, rows: box.rows, sidebar: x == null ? null : { x, width: window.innerWidth }, targetY: y,
      marks: box.marks.map((m) => ({ ...m, label: lib.fields[m.key]?.label || m.key, state: sm.conflicts.includes(m.key) ? 'conflict' : 'done' })),
    };
  }
  drawing = drawing.then(() => ask(tab.id, { type: 'powerloader:fetchBox', ...msg })).catch(() => {});
}

function problemText(problem, s) {
  if (problem === 'not-here') return `Go to ${s.name} first: the pages are fetched from it.`;
  if (problem === 'cap') return `Power Loader has fetched ${FETCH_LIMITS.perCase} pages for this case in the last 10 minutes. Wait a few minutes, then try again.`;
  if (problem === 'none') return 'This step has no pages to fetch.';
  return 'These pages can’t be fetched now.';
}

/** After a run with a show: "Open urgent referrals: 4." for the live region. */
function showSentence(s, out, c) {
  if (!s.fetch?.show || out.ended || !c) return '';
  const got = shownRows(c, s);
  return got ? `${s.fetch.show.label}: ${got.matches.length}.` : '';
}

/** What a request is now: from this run, or from the case (fetched before, or clipped by hand). */
function rowState(c, s, item) {
  const run = fetchUi.stepId === s.id ? fetchUi.states[item.key || item.request.id] : null;
  if (run?.state === 'fetching') return { icon: h('span', { class: 'spinner' }), text: 'Fetching…' };
  if (run?.state === 'done') {
    const sm = run.summary;
    const n = sm.added.length + sm.agreed.length + sm.conflicts.length;
    return { icon: '✓', text: `${plural(n, 'value')}${sm.conflicts.length ? `, ${plural(sm.conflicts.length, 'conflict')}` : ''}${sm.identity.length ? ' · may be a different person' : ''}${run.warning ? ` · ${run.warning}` : ''}`, clipId: run.clipId, ok: true };
  }
  if (run?.state === 'failed') return { icon: '✕', text: run.text, bad: true };
  const clip = c.clips.find((cl) => cl.via?.stepId === s.id && cl.via.requestId === item.request.id) || c.clips.find((cl) => cl.profile?.id === item.request.profileId);
  if (clip) return { icon: '✓', text: clip.kind === 'fetch' ? 'In the case' : 'In the case, clipped by you', clipId: clip.id, ok: true };
  if (item.problem && item.problem !== 'missing') return { icon: '⛔', text: failureText(item.problem, { name: item.request.name }), bad: true };
  return { icon: '·', text: item.problem === 'missing' ? 'Needs a value from the case' : 'Waiting' };
}

/** The fetch step's part of the Steps card. done: the step's status is done. */
export function fetchBlock(context, s, { done, main = !done, then: showThen = true } = {}) {
  const { ui, data, lib, act } = context;
  const c = data.case;
  // The approved-hosts layer is added as the runner adds it, so the card says what a run would do.
  const layers = [...(data.access || []), hostsLayer(lib.approvedHosts || [])];
  const plan = planRun({ step: s, lib, c, layers, tabUrl: ui.page?.url, lists: listsFor(s, ui.page?.url) });
  const running = fetchUi.stepId === s.id && !!fetchUi.controller;
  const off = backgroundOffText(data.background);
  const ready = plan.items.filter((i) => !i.problem);
  const reason = off ? 'Reading pages in the background is turned off' : plan.problem ? problemText(plan.problem, s) : !ready.length ? 'None of these pages can be fetched now' : null;
  const list = listRequests(s)[0] || null;
  const rows = plan.items.filter((item) => !item.list).map((item) => {
    const st = rowState(c, s, item);
    const clip = st.clipId && c.clips.find((cl) => cl.id === st.clipId);
    return h('li', { class: 'stack', style: 'gap:2px', 'data-key': `fetch-row-${item.request.id}` },
      h('div', { class: 'row between', style: 'flex-wrap:nowrap' },
        h('span', {}, h('span', { 'aria-hidden': 'true' }, st.icon, ' '), h('b', {}, item.request.name), item.request.required === false ? h('span', { class: 'muted' }, ' (optional)') : null),
        h('span', { class: `small ${st.bad ? 'warn' : st.ok ? 'ok' : 'muted'}`, 'data-key': `fetch-state-${item.request.id}` }, st.text)),
      clip ? h('div', { class: 'row', style: 'gap:8px' },
        clip.kind === 'fetch' ? h('button', { type: 'button', class: 'link sm', 'data-key': `fetch-view-${item.request.id}`, onclick: () => act.openFetched(clip.id) }, 'View what was read') : null,
        h('button', { type: 'button', class: 'link sm', 'data-key': `fetch-open-${item.request.id}`, onclick: () => act.openUrl(clip.url) }, 'Open the page'),
        h('button', { type: 'button', class: 'link sm', 'data-key': `fetch-undo-${item.request.id}`, onclick: () => act.removeClip(clip.id) }, 'Undo')) : null,
      // With background reading off, the caseworker opens each page and clips it themselves.
      off && !clip && item.url ? h('button', { type: 'button', class: 'link sm', 'data-key': `fetch-go-${item.request.id}`, style: 'align-self:flex-start', onclick: () => act.openUrl(item.url) }, `Open ${item.request.name} to clip it`) : null);
  });
  if (list) rows.push(listRow(context, s, list, plan, running));
  const vars = caseVars(c, lib);
  const then = s.fetch?.then?.url ? fillTemplate(s.fetch.then.url, vars) : null;
  const thenName = (s.fetch?.then?.to && lib.steps.find((x) => x.id === s.fetch.then.to)?.name) || 'the next page';
  const res = fetchUi.stepId === s.id && fetchUi.result && !running ? fetchUi.result : null;
  const fetched = c.clips.filter((cl) => cl.kind === 'fetch' && cl.via?.stepId === s.id);
  return h('div', { class: 'stack', style: 'gap:6px', 'data-key': 'fetch-step' },
    off ? h('p', { class: 'notice warn small', 'data-key': 'fetch-off', role: 'status' }, off) : null,
    h('span', { class: 'small muted' }, `Power Loader fetches ${plan.items.length === 1 ? 'this page' : 'these pages'} from ${s.name} when you press the button, reads ${plan.items.length === 1 ? 'it' : 'them'} and adds what ${plan.items.length === 1 ? 'it finds' : 'they find'} to the case. You don’t see the pages, but the system logs them as opened by you.`),
    h('ul', { class: 'plain stack', style: 'gap:6px' }, rows),
    res ? h('p', { class: 'small', role: 'status', 'data-key': 'fetch-summary' }, res.problem ? problemText(res.problem, s) : runSummary(res, s)) : null,
    // What the pages read are to the case now, as a clip's line is: kept up to date as conflicts are decided.
    fetched.length && !running ? tallyLine(context, addTallies(fetched.map((cl) => clipTally(c, lib, cl))), { key: 'fetch-tally' }) : null,
    // Back into what the step read, at any time: the fetched view on the case page.
    fetched.length && !running ? h('button', { type: 'button', class: 'link sm', 'data-key': 'fetch-view-all', style: 'align-self:flex-start', onclick: () => act.openPage('case', { view: 'fetched', step: s.id }) }, `View what was read (${plural(fetched.length, 'page')})`) : null,
    showBlock(context, s, res),
    h('div', { class: 'row' },
      running
        ? h('button', { type: 'button', class: 'sm', 'data-key': 'fetch-stop', onclick: () => { fetchUi.controller?.abort(); announce('Stopping'); } }, 'Stop')
        : h('button', {
          type: 'button', class: main ? 'primary big' : 'sm', 'data-key': 'fetch-run', disabled: !!reason || !!fetchUi.controller, title: reason || undefined,
          onclick: () => start(context, s),
        }, `${buttonText(s, plan, ready)}${done ? ' again' : ''}`),
      // A run that stopped part way, or ran out of time, can fetch the links it didn't get to.
      !running && list && res && !res.problem && res.lists?.[list.id] && Object.values(res.states).some((x) => x.state === 'failed' && ['stopped', 'timeout'].includes(x.code))
        ? h('button', { type: 'button', class: 'sm', 'data-key': 'fetch-rest', disabled: !!reason, onclick: () => start(context, s, { rest: true }) }, 'Fetch the rest') : null,
      running ? h('span', { class: 'small muted' }, h('span', { class: 'spinner' }), ' Fetching…') : null),
    reason && !off && !running ? h('span', { class: 'small muted', 'data-key': 'fetch-why' }, reason) : null,
    done && showThen && then?.url ? h('button', { type: 'button', class: 'sm', 'data-key': 'fetch-then', style: 'align-self:flex-start', onclick: () => act.openUrl(then.url) }, `Go to ${thenName}`) : null);
}

/** The button's words: "Fetch 3 pages", or for a list of links "Fetch 25 messages" (with any fixed pages added). */
function buttonText(s, plan, ready) {
  const list = listRequests(s)[0];
  const n = ready.length || plan.items.length;
  if (!list) return `Fetch ${plural(n, 'page')}`;
  const fromList = ready.filter((i) => i.list).length;
  const fixed = ready.filter((i) => !i.list).length;
  // Before the page's links are read (or when they can't be), the button says what a press will do in words.
  if (!fromList && !fixed) return `Fetch the ${listNoun(list, 2)} on this page`;
  return `Fetch ${fromList} ${listNoun(list, fromList)}${fixed ? ` and ${plural(fixed, 'page')}` : ''}`;
}

/**
 * A list request's one row on the card: how many links the page has and how many were refused (with why),
 * then progress while it runs. 25 lines would hide the result.
 */
function listRow(context, s, r, plan, running) {
  const items = plan.items.filter((i) => i.list && i.request.id === r.id);
  const ready = items.filter((i) => !i.problem);
  const refused = items.filter((i) => i.problem && i.url);
  const unread = items.find((i) => i.problem && !i.url);
  const states = fetchUi.stepId === s.id ? Object.entries(fetchUi.states).filter(([k]) => k.startsWith(`${r.id}#`)).map(([, v]) => v) : [];
  const done = states.filter((x) => x.state === 'done').length;
  const why = [...new Set(refused.map((i) => (i.problem === 'profile' ? `not ${i.profile?.name || 'its page'}` : failureText(i.problem, { name: r.name }).toLowerCase())))];
  const text = running ? `Fetching… ${done} of ${states.length || ready.length}`
    : unread ? failureText(unread.problem, { name: r.name })
      : `${plural(ready.length, 'link')} on this page${r.each.max < FETCH_LIMITS.perList ? ` (at most ${r.each.max})` : ''}${refused.length ? `; ${refused.length} refused: ${why.join(', ')}` : ''}`;
  return h('li', { class: 'stack', style: 'gap:2px', 'data-key': `fetch-row-${r.id}` },
    h('div', { class: 'row between', style: 'flex-wrap:nowrap' },
      h('span', {}, h('span', { 'aria-hidden': 'true' }, running ? h('span', { class: 'spinner' }) : unread ? '⛔' : '·', ' '), h('b', {}, r.name)),
      h('span', { class: `small ${unread ? 'warn' : 'muted'}`, 'data-key': `fetch-state-${r.id}` }, text)));
}

/** After a run: the rows the step's show picks, each with its columns and Open, and how many weren't. */
function showBlock(context, s, res) {
  const { data, act } = context;
  const got = shownRows(data.case, s);
  if (!got || (!got.read && !res)) return null;
  const list = listRequests(s)[0];
  const total = res?.lists?.[list?.id]?.total ?? got.read;
  const noun = list ? listNoun(list, 1) : 'page';
  const show = got.show;
  return h('div', { class: 'stack', style: 'gap:4px', role: 'region', 'aria-label': show.label, 'data-key': 'fetch-show' },
    h('h4', { 'data-key': 'fetch-show-title' }, `${show.label}: ${got.matches.length}`),
    got.matches.length ? h('ul', { class: 'plain stack', style: 'gap:4px' }, got.matches.map((m, i) => h('li', { class: 'stack', style: 'gap:1px;border-top:1px solid var(--border);padding-top:4px', 'data-key': `fetch-match-${i}` },
      h('span', { class: 'small' }, (show.columns || []).map((k) => cell(m.row[k])).filter(Boolean).join(' · ')),
      h('button', { type: 'button', class: 'link sm', 'data-key': `fetch-match-open-${i}`, style: 'align-self:flex-start', onclick: () => act.openUrl(m.url) }, `Open the ${noun}`)))) : null,
    h('p', { class: 'small muted', 'data-key': 'fetch-show-others' }, `Read ${got.read} of ${total} ${listNoun(list, total)}. ${got.others} other${got.others === 1 ? '' : 's'} ${got.others === 1 ? 'wasn’t' : 'weren’t'} ${show.label.toLowerCase()}.`));
}

// The Templates tab, in Build: every page and form the flows use (a template is what Power Loader knows about
// one page or one form: where it is, and which values it reads from it or puts into it), what each reads or
// fills, and which flows use it, with links both ways. Read-only: a template is changed in a flow's page editor,
// where its links go. Each flow carries its own copy of a template; the tab gathers the copies that are the same
// one and says when two flows' copies differ. See lib/flows.js templatesOf().
import { h, plural, announce, describeError } from '../ui/dom.js';
import { allowed } from '../lib/access.js';
import { flowFromLibrary, flowFromLibraryPage, templatesOf } from '../lib/flows.js';
import { updateFlows } from '../lib/core.js';
import { flowPageHere, openFlowAt } from './flows.js';

export const templateUi = { open: null, search: '' };

const keyOf = (t) => `${t.kind}:${t.id}`;
const safe = (s) => String(s).replace(/[^\w-]+/g, '_').slice(0, 80);

/** Open the Templates tab at a template: a page of a flow by its page, or a template's own id. */
export function openTemplate(context, { flow, page }) {
  const { templates } = templatesOf({ lib: context.data.lib, flows: context.data.flows });
  const t = templates.find((x) => x.uses.some((u) => u.flowId === flow.id && u.pageId === page.id));
  templateUi.open = t ? keyOf(t) : null;
  context.act.setTab('templates');
}

// The flows that use a template, once each, with the step they use it at.
const flowsOf = (t) => {
  const seen = new Map();
  for (const u of t.uses) if (!seen.has(u.flowId)) seen.set(u.flowId, u);
  return [...seen.values()];
};

function useLink(context, u) {
  const label = `${u.stepNumber ? `Step ${u.stepNumber} of ` : ''}${u.flowName}`;
  return h('button', {
    type: 'button', class: 'link sm', 'data-key': `tpl-use-${safe(u.flowId)}-${safe(u.pageId)}`,
    onclick: () => openFlowAt(context, u),
  }, label, u.library ? h('span', { class: 'muted' }, ' (library)') : null);
}

function row(context, t, here) {
  const n = t.values.length;
  return h('div', { class: 'fcard flow', 'data-key': `tpl-${safe(keyOf(t))}` },
    h('span', { class: 'nm' },
      h('button', { type: 'button', class: 'link', 'data-key': `tpl-open-${safe(keyOf(t))}`, onclick: () => { templateUi.open = keyOf(t); context.act.render(); } }, t.name),
      here ? h('span', { class: 'pill acc', style: 'margin-left:6px', 'data-key': 'tpl-here' }, 'This page') : null),
    h('span', { class: 'meta' }, `${t.kind === 'form' ? `Fills ${plural(n, 'box', 'boxes')}${t.required ? `, ${t.required} required` : ''}` : `Reads ${plural(n, 'value')}`} · ${t.tested ? 'tested on this computer' : 'not tested on this computer'}${t.differs ? ' · flows’ copies differ' : ''}`),
    h('span', { class: 'meta' }, 'Used in ', flowsOf(t).map((u, i) => [i ? ', ' : '', useLink(context, u)])));
}

function grouped(context, list, here) {
  const hosts = [...new Set(list.map((t) => t.host || 'No address'))];
  return hosts.map((host) => [
    h('h4', { class: 'fsec' }, host),
    h('div', { class: 'stack', style: 'gap:6px' }, list.filter((t) => (t.host || 'No address') === host).map((t) => row(context, t, here === keyOf(t)))),
  ]);
}

async function makeFlowFrom(context, x) {
  try {
    const flow = x.kind === 'form' ? flowFromLibrary(context.data.lib, [x.id]) : flowFromLibraryPage(context.data.lib, x.id);
    await updateFlows((list) => { list.push(flow); });
    announce(`Made the flow ${flow.name} from ${x.name}. Change it here.`);
    await openFlowAt(context, { flowId: flow.id, pageId: null });
  } catch (e) { announce(describeError(e)); }
}

function detail(context, t, here) {
  const { act, data } = context;
  const go = t.address && !t.address.includes('*') && !t.address.includes('{') ? t.address : '';
  const can = go && (!data.access || allowed(data.access, go, 'navigate').ok);
  return [
    h('button', { type: 'button', class: 'link sm', 'data-key': 'tpl-back', style: 'align-self:flex-start', onclick: () => { templateUi.open = null; act.render(); } }, '← All templates'),
    h('div', { class: 'card stack', style: 'gap:6px', 'data-key': 'tpl-detail' },
      h('div', { class: 'ctx-head' }, h('span', { class: 'pill' }, t.kind === 'form' ? 'Form' : 'Page'), h('strong', {}, t.name), here ? h('span', { class: 'pill acc', 'data-key': 'tpl-here' }, 'This page') : null),
      h('p', { class: 'small' }, 'Address: ', h('code', {}, t.address || 'none yet')),
      h('p', { class: 'small muted' }, `${t.from === 'library' ? `From your library${t.version ? `, ${t.version}` : ''}` : 'Made on this computer'} · ${t.tested ? 'tested on this computer' : 'not tested on this computer'}`),
      go ? h('button', { type: 'button', class: 'sm', 'data-key': 'tpl-go', style: 'align-self:flex-start', disabled: !can, title: can ? undefined : 'Power Loader doesn’t open this address: the site rules block it', onclick: () => act.openUrl(go) }, 'Go to this page') : null,
      h('h4', {}, t.kind === 'form' ? 'What it fills' : 'What it reads'),
      t.values.length ? h('ul', { class: 'plain small', 'data-key': 'tpl-values' }, t.values.map((v) => h('li', {}, v.label, h('span', { class: 'muted' }, ` · ${v.key}`))))
        : h('p', { class: 'small muted' }, t.kind === 'form' ? 'No boxes yet: the flow’s form isn’t made.' : 'Nothing yet.'),
      h('h4', {}, 'The flows that use it'),
      h('ul', { class: 'plain small', 'data-key': 'tpl-uses' }, t.uses.map((u) => h('li', {}, useLink(context, u)))),
      t.differs ? h('div', { class: 'notice warn small', 'data-key': 'tpl-differs' },
        h('p', {}, h('b', {}, 'The flows’ copies differ. '), 'Each flow carries its own copy of this template.'),
        h('ul', { class: 'plain' }, t.differences.map((d) => h('li', {}, d)))) : null,
      h('p', { class: 'small muted' }, 'To change what it reads or fills, open it in a flow: the change is that flow’s.')),
  ];
}

/** The Templates tab. */
export function renderTemplates(context) {
  const { data, ui } = context;
  const { templates, notInFlow } = templatesOf({ lib: data.lib, flows: data.flows });
  // With a case open and the page in view, the template for this page is marked.
  let here = null;
  if (data.case && /^https?:/.test(ui.page?.url || '')) {
    const t = templates.find((x) => x.kind === 'page' && x.id === ui.info?.profile?.id) || templates.find((x) => x.kind === 'form' && x.id === ui.info?.formId);
    if (t) here = keyOf(t);
    else {
      for (const x of templates) {
        const flow = (data.flows || []).find((f) => x.uses.some((u) => u.flowId === f.id));
        if (flow && x.uses.some((u) => flowPageHere(flow, ui.page.url)?.id === u.pageId)) { here = keyOf(x); break; }
      }
    }
  }
  const open = templateUi.open && templates.find((t) => keyOf(t) === templateUi.open);
  if (open) return detail(context, open, here === keyOf(open));
  const q = templateUi.search.trim().toLowerCase();
  const match = (t) => !q || t.name.toLowerCase().includes(q) || (t.host || '').toLowerCase().includes(q);
  const pages = templates.filter((t) => t.kind === 'page' && match(t));
  const forms = templates.filter((t) => t.kind === 'form' && match(t));
  const loose = notInFlow.filter(match);
  return [
    h('div', { class: 'stack' },
      h('h2', { class: 'start-title' }, 'Templates'),
      h('p', { class: 'muted' }, 'A template is what Power Loader knows about one page or one form: where it is, and which values it reads from it or puts into it. Flows are made of them. This list is read-only: change a template in the flow that uses it.')),
    h('div', { class: 'row', style: 'flex-wrap:nowrap' },
      h('label', { class: 'sr', for: 'tpl-search' }, 'Search templates'),
      h('input', { type: 'search', id: 'tpl-search', 'data-key': 'tpl-search', placeholder: 'Search by name or system', value: templateUi.search, oninput: (e) => { templateUi.search = e.target.value; context.act.render(); } })),
    h('div', { class: 'sec-title' }, h('span', {}, `Pages · ${pages.length}`), h('span', { class: 'small' }, 'what a flow reads')),
    pages.length ? grouped(context, pages, here) : h('p', { class: 'small muted' }, 'No pages.'),
    h('div', { class: 'sec-title' }, h('span', {}, `Forms · ${forms.length}`), h('span', { class: 'small' }, 'what a flow fills')),
    forms.length ? grouped(context, forms, here) : h('p', { class: 'small muted' }, 'No forms.'),
    loose.length ? [
      h('div', { class: 'sec-title' }, h('span', {}, `Not in a flow · ${loose.length}`), h('span', { class: 'small' }, 'in your library')),
      h('p', { class: 'small muted' }, 'A case is always a run of a flow, so these can’t be used on their own.'),
      h('div', { class: 'stack', style: 'gap:6px', 'data-key': 'tpl-loose' }, loose.map((x) => h('div', { class: 'fcard flow', 'data-key': `tpl-loose-${safe(`${x.kind}:${x.id}`)}` },
        h('span', { class: 'nm' }, x.name),
        h('span', { class: 'meta' }, `${x.kind === 'form' ? 'Form' : 'Page'}${x.host ? ` · ${x.host}` : ''}`),
        h('span', { class: 'acts' }, h('button', { type: 'button', class: 'sm', 'data-key': `tpl-make-${safe(`${x.kind}:${x.id}`)}`, onclick: () => makeFlowFrom(context, x) }, 'Make a flow from it'))))),
    ] : null,
  ];
}

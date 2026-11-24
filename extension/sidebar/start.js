// No active case: start one from the forms it needs to fill. There are no freehand cases.
import { h, plural, time } from '../ui/dom.js';
import { formList } from '../lib/library.js';
import { unrecognisedCard, updateLink } from './caseview.js';
import { onboardCard } from './settings.js';
import { authorCard, flowStartCard } from './flows.js';

// Which library pages usually hold a form's fields, from the page profiles' field keys.
function sourcesFor(lib, form) {
  const keys = new Set(form.fields.map((f) => f.key));
  return lib.profiles.filter((p) => Object.keys(p.fields || {}).some((k) => keys.has(k))).map((p) => p.name);
}

function formCard({ ui, act, lib, data }, f, quick) {
  const selected = ui.start.select.has(f.id);
  const starred = data.starred.includes(f.id);
  const req = f.fields.filter((x) => x.required).length;
  const several = ui.start.select.size > 1;
  const pages = quick ? sourcesFor(lib, f).slice(0, 3) : [];
  return h('div', { class: `fcard${selected ? ' sel' : ''}` },
    h('button', {
      type: 'button', class: 'star', 'data-key': `star-${f.id}-${quick ? 'q' : 'a'}`, 'aria-pressed': String(starred),
      'aria-label': `${starred ? 'Unstar' : 'Star'} ${f.name}`, onclick: () => act.star(f.id),
    }, starred ? '★' : '☆'),
    h('span', { class: 'nm' }, f.name),
    h('span', { class: 'meta' }, `${f.category || 'Form'} · ${f.version} · ${req} required${pages.length ? ` · clip ${pages.join(', ')}` : ''}`),
    h('span', { class: 'acts' },
      h('input', {
        type: 'checkbox', 'data-key': `sel-${f.id}-${quick ? 'q' : 'a'}`, checked: selected, 'aria-label': `Select ${f.name}`,
        onchange: (e) => { if (e.target.checked) ui.start.select.add(f.id); else ui.start.select.delete(f.id); act.render(); },
      }),
      quick ? h('button', {
        type: 'button', class: 'sm primary', 'data-key': `start-${f.id}`, disabled: several,
        title: several ? 'Several forms are ticked: use Start case below' : undefined,
        onclick: () => act.start([f.id]),
      }, 'Start') : null));
}

export function renderStart(context) {
  const { ui, data, lib, act } = context;
  const out = [];
  if (!lib) {
    out.push(onboardCard(context), flowStartCard(context), authorCard(context));
    return out;
  }
  if (ui.info?.kind === 'source') {
    out.push(h('div', { class: 'card' },
      h('div', { class: 'ctx-head' }, h('span', { class: ui.info.profile.draft ? 'pill magic' : 'pill acc' }, ui.info.profile.draft ? `Your draft ${ui.info.profile.version}` : 'Recognised'), h('strong', {}, ui.info.profile.name)),
      h('p', { class: 'muted' }, 'Start a case to clip this page.'),
      updateLink(context, ui.info.profile)));
  }
  if (ui.info?.kind === 'unknown' && ui.info.access) out.push(unrecognisedCard(context, true));
  if (data.receipt) {
    const r = data.receipt;
    const n = r.counts;
    out.push(h('div', { class: 'card done-card', role: 'status' },
      h('h2', {}, r.outcome === 'finished' ? 'Case finished' : 'Case discarded'),
      n ? h('p', {}, `Closed at ${time(r.at)}. ${plural(n.clips, 'clip')}, ${plural(n.values, 'value')}, ${plural(n.decisions, 'decision')}${n.workings ? ` and ${plural(n.workings, 'saved working')}` : ''} were deleted from this browser.`)
        : h('p', {}, `Closed at ${time(r.at)}. Its data was deleted from this browser.`),
      h('p', { class: 'small muted' }, 'Anything you copied to the clipboard, downloaded or typed into other systems isn’t affected. Power Loader can’t reach it.')));
  }
  const forms = formList(lib);
  const starred = forms.filter((f) => data.starred.includes(f.id));
  out.push(
    h('div', { class: 'stack' },
      h('h2', { class: 'start-title' }, 'Start a case'),
      h('p', { class: 'muted' }, 'Choose the form this case needs to fill. Tick more than one if the case fills several.')),
    h('label', { class: 'field' }, 'Case reference (optional)',
      h('span', { class: 'hint' }, 'Kept on this computer only, and never in the activity log.'),
      h('input', { type: 'text', 'data-key': 'case-ref', value: ui.start.ref, placeholder: 'e.g. CM-58213', oninput: (e) => { ui.start.ref = e.target.value; } })),
    h('div', { class: 'sec-title' }, h('span', {}, '★ Starred')),
    starred.length ? h('div', { class: 'stack' }, starred.map((f) => formCard(context, f, true)))
      : h('div', { class: 'card' }, h('p', { class: 'muted' }, 'Star the forms you use most and they appear here for a one-click start.')));
  const cats = ['All', ...new Set(forms.map((f) => f.category || 'Other'))];
  const q = ui.start.search.trim().toLowerCase();
  const list = forms.filter((f) => (ui.start.cat === 'All' || (f.category || 'Other') === ui.start.cat) && (!q || f.name.toLowerCase().includes(q)));
  out.push(
    h('div', { class: 'sec-title' }, h('span', {}, `All forms · ${forms.length}`), h('span', { class: 'small' }, 'from your library')),
    h('div', { class: 'row', style: 'flex-wrap:nowrap' },
      h('label', { class: 'sr', for: 'form-search' }, 'Search forms'),
      h('input', { type: 'search', id: 'form-search', 'data-key': 'form-search', placeholder: 'Search forms', value: ui.start.search, oninput: (e) => { ui.start.search = e.target.value; act.render(); } }),
      h('label', { class: 'sr', for: 'form-cat' }, 'Category'),
      h('select', { id: 'form-cat', 'data-key': 'form-cat', style: 'width:auto', onchange: (e) => { ui.start.cat = e.target.value; act.render(); } },
        cats.map((c) => h('option', { value: c, selected: c === ui.start.cat }, c)))),
    h('div', { class: 'stack' }, list.length ? list.map((f) => formCard(context, f, false)) : h('p', { class: 'muted' }, 'No forms match.')));
  // Flows on this computer: a case can start from one instead of the library's forms.
  out.push(flowStartCard(context));
  if (ui.start.select.size) {
    const ids = forms.filter((f) => ui.start.select.has(f.id)).map((f) => f.id);
    const names = ids.map((id) => lib.forms[id].short || lib.forms[id].name).join(' + ');
    out.push(h('div', { class: 'tray' },
      h('span', { class: 'grow' }, h('b', {}, plural(ids.length, 'form')), ` · ${names}`),
      h('button', { type: 'button', class: 'sm', 'data-key': 'clear-sel', onclick: () => { ui.start.select.clear(); act.render(); } }, 'Clear'),
      h('button', { type: 'button', class: 'primary', 'data-key': 'start-sel', onclick: () => act.start(ids) }, ids.length > 1 ? `Start case: ${names}` : 'Start case')));
  }
  return out;
}

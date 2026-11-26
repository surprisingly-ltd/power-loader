// Settings: Sites Power Loader works on. The site rules from policy and the library's locked rules are shown
// apart from the caseworker's own, which they can add, change and remove; the library's delegated rules they
// can change or turn off. The rules only ever limit Power Loader, never the caseworker's own browsing.
import { h, announce, describeError } from '../ui/dom.js';
import { saveSettings } from '../lib/core.js';
import {
  addMine, backgroundReading, changeDelegated, describePattern, editMine, keepMineRule, patternError, patternHints, removeMine, setBackgroundReading,
  setDelegatedOff, settingsRows, tryAddress, useLibraryRule,
} from '../lib/access.js';

const SOURCE = {
  policy: '🔒 Set by your organisation', library: '🔒 Set by your library', delegated: 'From your library', mine: 'Yours',
};

async function save(context, fn, done) {
  try {
    const siteAccess = fn(context.data.settings || {});
    await saveSettings({ siteAccess });
    announce(done);
  } catch (e) { announce(describeError(e)); }
  context.act.refresh();
}

// One rule: its address, how it reads, where it's from, and what the caseworker can do with it.
function ruleRow(context, row) {
  const { data, act } = context;
  const form = data.siteForm;
  const { rule, source, state } = row;
  const editing = form.editing === `${source}:${rule.id}`;
  const actions = rule.actions ? ` · ${rule.actions.join(', ')} only` : '';
  const off = state === 'off';
  const controls = [];
  if (editing) {
    const err = patternError(form.editText);
    controls.push(
      h('label', { class: 'sr', for: 'sa-edit' }, 'Address'),
      h('input', { type: 'text', id: 'sa-edit', 'data-key': 'sa-edit', value: form.editText, oninput: (e) => { form.editText = e.target.value; act.render(); } }),
      h('span', { class: `small ${err ? 'bad' : 'muted'}` }, err || describePattern(form.editText)),
      h('div', { class: 'row' },
        h('button', {
          type: 'button', class: 'sm primary', 'data-key': 'sa-edit-save', disabled: !!err,
          onclick: () => { form.editing = null; save(context, (s) => (source === 'mine' ? editMine(s, rule.id, form.editText) : changeDelegated(s, row.lib, form.editText)), 'Rule changed'); },
        }, 'Save'),
        h('button', { type: 'button', class: 'sm', 'data-key': 'sa-edit-cancel', onclick: () => { form.editing = null; act.render(); } }, 'Cancel')));
  } else if (source === 'delegated') {
    if (off) controls.push(h('button', { type: 'button', class: 'link sm', 'data-key': `sa-on-${rule.id}`, onclick: () => save(context, (s) => setDelegatedOff(s, rule.id, false), 'Rule turned back on') }, 'Turn back on'));
    else {
      if (state === 'conflict') {
        controls.push(h('span', { class: 'small warn' }, 'The library changed this rule.'),
          h('button', { type: 'button', class: 'link sm', 'data-key': `sa-keep-${rule.id}`, onclick: () => save(context, (s) => keepMineRule(s, row.lib), 'Kept your version') }, 'Keep mine'));
      } else if (state === 'changed') controls.push(h('span', { class: 'small muted' }, 'Changed by you'));
      if (state === 'conflict' || state === 'changed') controls.push(h('button', { type: 'button', class: 'link sm', 'data-key': `sa-lib-${rule.id}`, onclick: () => save(context, (s) => useLibraryRule(s, rule.id), 'Using the library’s rule') }, 'Use the library’s'));
      controls.push(
        h('button', { type: 'button', class: 'link sm', 'data-key': `sa-change-${rule.id}`, onclick: () => { Object.assign(form, { editing: `delegated:${rule.id}`, editText: rule.pattern }); act.render(); } }, 'Change'),
        h('button', { type: 'button', class: 'link sm', 'data-key': `sa-off-${rule.id}`, onclick: () => save(context, (s) => setDelegatedOff(s, rule.id, true), 'Rule turned off') }, 'Turn off'));
    }
  } else if (source === 'mine') {
    controls.push(
      h('button', { type: 'button', class: 'link sm', 'data-key': `sa-change-${rule.id}`, onclick: () => { Object.assign(form, { editing: `mine:${rule.id}`, editText: rule.pattern }); act.render(); } }, 'Change'),
      h('button', { type: 'button', class: 'link sm', 'data-key': `sa-rm-${rule.id}`, onclick: () => save(context, (s) => removeMine(s, rule.id), 'Rule removed') }, 'Remove'));
  } else if (source === 'library') controls.push(h('span', { class: 'small muted' }, 'Your library team manages this.'));
  return h('li', { class: 'stack', style: 'gap:2px', 'data-key': `sa-row-${source}-${rule.id}`, 'data-source': source },
    h('div', { class: 'row between', style: 'flex-wrap:nowrap' },
      h('code', { style: off ? 'text-decoration:line-through' : '' }, rule.pattern || '(no address)'),
      h('span', { class: 'pill' }, SOURCE[source])),
    h('span', { class: 'small muted' }, `${describePattern(rule.pattern)}${actions}${rule.note ? ` · ${rule.note}` : ''}`),
    controls.length ? h('div', { class: 'row', style: 'gap:8px' }, controls) : null);
}

// The box to add an address to Allowed or Blocked: how it reads as it's typed, or why it can't be read.
function addBox(context, effect) {
  const { data, act } = context;
  const form = data.siteForm;
  const key = effect === 'allow' ? 'addAllow' : 'addDeny';
  const value = form[key];
  const err = value.trim() ? patternError(value) : null;
  const hints = value.trim() && !err ? patternHints(value, effect) : [];
  const id = `sa-add-${effect}`;
  return h('div', { class: 'stack', style: 'gap:4px' },
    h('label', { class: 'small', for: id }, effect === 'allow' ? 'Add an allowed address' : 'Add a blocked address'),
    h('div', { class: 'row', style: 'flex-wrap:nowrap' },
      h('input', { type: 'text', id, 'data-key': id, value, placeholder: effect === 'allow' ? 'https://*.example.gov.uk*' : 'https://finance.example.gov.uk*', oninput: (e) => { form[key] = e.target.value; act.render(); } }),
      h('button', {
        type: 'button', class: 'sm', 'data-key': `${id}-btn`, disabled: !value.trim() || !!err,
        onclick: () => { const pattern = form[key]; form[key] = ''; save(context, (s) => addMine(s, { effect, pattern }), effect === 'allow' ? 'Address allowed' : 'Address blocked'); },
      }, 'Add')),
    value.trim() ? h('span', { class: `small ${err ? 'bad' : 'muted'}`, 'data-key': `${id}-reads` }, err ? `Power Loader can’t read this: ${err}` : describePattern(value)) : null,
    hints.map((t) => h('span', { class: 'small warn' }, t)));
}

// Read pages in the background: fetch steps fetch the pages the caseworker isn't on and clip them. Policy or
// the library can set it and lock it; otherwise it's the caseworker's.
function backgroundRow(context) {
  const { data } = context;
  const bg = backgroundReading({ policy: data.policy, settings: data.settings, caseLib: data.caseLib, currentLib: data.lib });
  const lockedBy = bg.locked ? (bg.by === 'policy' ? SOURCE.policy : SOURCE.library) : null;
  return h('div', { class: 'stack', style: 'gap:4px', 'data-key': 'sa-background' },
    h('div', { class: 'row between', style: 'flex-wrap:nowrap' },
      h('label', { class: 'check' }, h('input', {
        type: 'checkbox', 'data-key': 'sa-background-on', checked: bg.on, disabled: bg.locked,
        onchange: (e) => save(context, (s) => setBackgroundReading(s, e.target.checked), e.target.checked ? 'Power Loader can read pages in the background' : 'Power Loader won’t read pages in the background'),
      }), h('span', {}, 'Read pages in the background (pages you’re not on)')),
      lockedBy ? h('span', { class: 'pill' }, lockedBy) : null),
    h('span', { class: 'small muted' }, bg.on
      ? 'A step can fetch pages from the system you’re on, when you press its button, and clip them for you. You don’t see those pages, but the system logs them as opened by you.'
      : 'Steps don’t fetch pages for you: open each page and clip it yourself.'),
    bg.locked ? h('span', { class: 'small muted' }, bg.by === 'policy' ? 'Your organisation sets this, so you can’t change it here.' : 'Your library team sets this, so you can’t change it here.') : null);
}

export function siteRulesCard(context) {
  const { data, act } = context;
  data.siteForm = data.siteForm || { addAllow: '', addDeny: '', tryUrl: '', editing: null, editText: '' };
  const form = data.siteForm;
  const rows = settingsRows({ policy: data.policy, settings: data.settings, caseLib: data.caseLib, currentLib: data.lib });
  const broken = data.access?.find((l) => l.broken !== undefined)?.broken;
  const list = (effect) => {
    const mine = rows.filter((r) => r.rule.effect === effect);
    const locked = mine.filter((r) => r.source === 'policy' || r.source === 'library');
    const own = mine.filter((r) => r.source === 'delegated' || r.source === 'mine');
    return [
      locked.length ? h('div', { class: 'stack', style: 'gap:2px' }, h('span', { class: 'small' }, h('b', {}, 'Locked: '), 'set for everyone, so you can’t change them here.'),
        h('ul', { class: 'plain stack', 'data-key': `sa-locked-${effect}` }, locked.map((r) => ruleRow(context, r)))) : null,
      own.length ? h('div', { class: 'stack', style: 'gap:2px' }, h('span', { class: 'small' }, h('b', {}, 'Yours to manage')),
        h('ul', { class: 'plain stack', 'data-key': `sa-own-${effect}` }, own.map((r) => ruleRow(context, r)))) : null,
    ];
  };
  const anyAllow = rows.some((r) => r.rule.effect === 'allow' && r.state !== 'off');
  const tried = form.tryUrl.trim() ? tryAddress(data.access || [], form.tryUrl.trim()) : null;
  return h('div', { class: 'card', id: 'site-rules' },
    h('h2', {}, 'Sites Power Loader works on'),
    broken !== undefined ? h('p', { class: 'notice bad', role: 'alert' }, `Your organisation’s site rules have an address Power Loader can’t read: ${String(broken).slice(0, 120)}. Until it’s corrected Power Loader doesn’t read, fill, capture or open pages anywhere. Ask IT to correct it.`) : null,
    backgroundRow(context),
    h('h3', {}, 'Allowed'),
    h('p', { class: 'small muted' }, anyAllow ? 'Power Loader only reads, fills and fetches on these sites.' : 'Every site, except those blocked below.'),
    list('allow'),
    addBox(context, 'allow'),
    h('h3', {}, 'Blocked'),
    h('p', { class: 'small muted' }, 'Power Loader never reads, fills, captures or fetches on these, even if they’re allowed above. You can still open them yourself.'),
    list('deny'),
    addBox(context, 'deny'),
    h('p', { class: 'small muted' }, '*.example.gov.uk is example.gov.uk and every site under it. A site name on its own is that site only.'),
    h('div', { class: 'stack', style: 'gap:4px' },
      h('label', { class: 'small', for: 'sa-try' }, 'Try an address (it isn’t saved)'),
      h('input', { type: 'url', id: 'sa-try', 'data-key': 'sa-try', value: form.tryUrl, placeholder: 'https://…', oninput: (e) => { form.tryUrl = e.target.value; act.render(); } }),
      tried ? h('span', { class: `small ${tried.ok ? 'ok' : 'warn'}`, 'data-key': 'sa-try-result', role: 'status' }, tried.text) : null));
}

// Tabs with panels: role=tab with aria-controls and aria-selected, roving tabindex, and arrow,
// Home and End keys. Panels are role=tabpanel, labelled by their tab.
import { h } from './dom.js';

/**
 * tabList({ id, label, tabs: [{ key, label, badge? }], selected, onSelect, className }) → the tablist element.
 * className 'seg' draws it as a segmented control instead of tabs.
 * Panels must be rendered with tabPanel(id, key) so the ids line up.
 */
export function tabList({ id, label, tabs, selected, onSelect, className = 'tabs' }) {
  const list = h('div', { class: className, role: 'tablist', 'aria-label': label });
  const buttons = tabs.map((t) => h('button', {
    type: 'button', role: 'tab', id: `${id}-tab-${t.key}`, 'data-key': `${id}-tab-${t.key}`, 'aria-controls': `${id}-panel-${t.key}`,
    'aria-selected': String(t.key === selected), tabindex: t.key === selected ? '0' : '-1',
    onclick: () => onSelect(t.key),
  }, t.label, t.badge ? h('span', { class: 'badge' }, t.badge) : null));
  list.addEventListener('keydown', (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (i < 0) return;
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: buttons.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const b = buttons[(next + buttons.length) % buttons.length];
    b.focus();
    onSelect(tabs[buttons.indexOf(b)].key);
  });
  list.append(...buttons);
  return list;
}

export function tabPanel(id, key, ...children) {
  return h('section', { role: 'tabpanel', id: `${id}-panel-${key}`, 'aria-labelledby': `${id}-tab-${key}`, tabindex: '0' }, ...children);
}

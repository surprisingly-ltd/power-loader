// Tools for the active case: calculator, timeline and reader. Standard tools never leave this browser;
// ✦ Enhanced sends what you choose to the organisation's AI gateway, after the redaction preview.
import { h } from '../../ui/dom.js';
import { tabList, tabPanel } from '../../ui/tabs.js';
import { calcBlock, stopCalc } from './calc-ui.js';
import { resetTimeline, timelineBlock } from './timeline-ui.js';
import { readerBlock, stopReader } from './reader-ui.js';
import { aiReady } from '../../lib/ai/settings.js';
import { TOOLS, toolOn } from '../../lib/tools.js';

const modes = () => ({ calc: 'standard', timeline: 'standard', reader: 'standard' });
export const tools = { tab: 'calc', mode: modes() };

/** Case notes clipped into the case, oldest first, for ✦ requests: { clipId, date, text }. */
export function caseNotes(c) {
  return c.clips.flatMap((cl) => (cl.records || []).filter((r) => r.type === 'note' && r.text).map((r) => ({ clipId: cl.id, date: r.date || null, text: String(r.text) })))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

export function modeSeg({ act }, tool) {
  const m = tools.mode[tool];
  const pick = (v) => { tools.mode[tool] = v; act.render(); };
  return h('div', { class: 'seg', role: 'group', 'aria-label': 'Mode' },
    h('button', { type: 'button', 'data-key': `${tool}-std`, 'aria-pressed': String(m === 'standard'), onclick: () => pick('standard') }, 'Standard'),
    h('button', { type: 'button', class: 'mg', 'data-key': `${tool}-enh`, 'aria-pressed': String(m === 'enhanced'), onclick: () => pick('enhanced') }, '✦ Enhanced'));
}

// Shown in place of ✦ controls until the remote AI is turned on.
export function enhancedGate(context) {
  if (aiReady(context.data.settings)) return null;
  return h('div', { class: 'disclose' }, '✦ The remote AI isn’t turned on. ',
    context.act.setTab ? h('button', { type: 'button', class: 'link sm', 'data-key': 'gate-settings', onclick: () => context.act.setTab('settings') }, 'Turn it on in Settings') : 'Turn it on in the Power Loader sidebar: Settings → ✦ Remote AI.');
}

export const TOOL_LABELS = { calc: 'Calculator', timeline: 'Timeline', reader: 'Reader' };

// The Tools tab's tools, by their switch (lib/tools.js).
const SWITCH = { calc: 'calculator', timeline: 'timeline', reader: 'reader' };
/** The Tools tab's tools that are on. */
export const toolsShown = (context) => Object.keys(TOOL_LABELS).filter((t) => toolOn(context.data.policy, context.data.settings, SWITCH[t]));

export function toolBlock(context, tool, opts = {}) {
  if (!toolOn(context.data.policy, context.data.settings, SWITCH[tool])) {
    const locked = context.data.policy?.locked instanceof Set && context.data.policy.locked.has(`tools.${SWITCH[tool]}`);
    return h('div', { class: 'card', 'data-key': `tool-off-${SWITCH[tool]}` }, h('p', { class: 'muted' }, `${TOOLS[SWITCH[tool]].label} is turned off${locked ? ' by your organisation' : ''}.`));
  }
  return tool === 'timeline' ? timelineBlock(context, opts) : tool === 'reader' ? readerBlock(context) : calcBlock(context, opts);
}

export function renderTools(context) {
  if (!context.data.case) {
    return h('div', { class: 'card' }, h('h2', {}, 'Tools work on the active case'),
      h('p', { class: 'muted' }, 'Start a case and clip a few pages. The calculator searches the case’s amounts, the timeline uses its dates, and the reader reads documents into it.'));
  }
  const shown = toolsShown(context);
  if (!shown.length) return h('div', { class: 'card', 'data-key': 'tools-all-off' }, h('p', { class: 'muted' }, 'Every tool is turned off. You can turn them on in Settings, unless your organisation has turned them off.'));
  if (!shown.includes(tools.tab)) tools.tab = shown[0];
  const tabs = shown.map((key) => ({ key, label: TOOL_LABELS[key] }));
  return [
    h('div', { class: 'tool-head' },
      tabList({ id: 'tool', label: 'Tools', tabs, selected: tools.tab, className: 'seg', onSelect: (t) => { tools.tab = t; context.act.render(); } }),
      tools.tab === 'reader' || !context.act.openToolFull ? null : h('button', { type: 'button', class: 'icon', 'data-key': 'tool-full', title: 'Open full size', 'aria-label': `Open the ${TOOL_LABELS[tools.tab].toLowerCase()} full size`, onclick: () => context.act.openToolFull(tools.tab) }, '⤢')),
    tabPanel('tool', tools.tab, h('div', { class: 'tool' }, toolBlock(context, tools.tab))),
  ];
}

// Teardown: searches, OCR jobs, results, ✦ answers and selections for the ended case all go.
export function resetTools() {
  stopCalc(true);
  resetTimeline();
  stopReader();
  tools.mode = modes();
}

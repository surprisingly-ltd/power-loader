// A switch for each tool. Policy tools.<name> (true or false) sets and locks it; unset, the caseworker turns
// each on or off in Settings; otherwise it is on. Off, the tool isn't offered anywhere and its action is refused
// where it is carried out (assertTool()). Build mode is never switched: making a template picks values on a page
// with the clipper itself, which isn't one of these tools.
// The tools that already have their own switch are listed with them (OTHER_SWITCHES), so Settings and the docs
// show one list. Pure, apart from assertTool(), which reads policy and settings now.
/* global browser */
import { getPolicy } from './policy.js';

export const TOOLS = {
  capture: { label: 'Select a region of the screen', what: '⬚ Select a region: a box drawn on the tab is captured as a picture and read.' },
  reader: { label: 'Reader', what: 'Reads PDFs, pictures and pasted screenshots on this computer (PDF text and OCR), in the Tools tab and a flow’s scan steps.' },
  calculator: { label: 'Calculator', what: 'Searches the case’s amounts and works sums out on this computer.' },
  timeline: { label: 'Timeline', what: 'Puts the case’s dates and periods on a timeline.' },
  notes: { label: 'Notes on pages', what: 'Draws a flow’s notes and markers onto its pages in the tab.' },
};
export const TOOL_NAMES = Object.keys(TOOLS);

// Switched elsewhere already: shown in the same list, never switched twice.
export const OTHER_SWITCHES = [
  { key: 'gateway.enabled', label: '✦ Remote AI', where: 'Settings → ✦ Remote AI' },
  { key: 'siteAccess.backgroundReading', label: 'Reading pages in the background (fetch steps)', where: 'Settings → Sites Power Loader works on' },
  { key: 'assistModel.enabled', label: 'On-device profile assistant', where: 'the template editor' },
  { key: 'privacyModel.use', label: 'On-device privacy model', where: 'Settings → On-device privacy model' },
];

/** Is this tool on, and who decided? { on, locked }. */
export function toolState(policy, settings, name) {
  const locked = policy?.locked instanceof Set && policy.locked.has(`tools.${name}`);
  if (locked) return { on: policy.values.tools[name] !== false, locked: true };
  const mine = settings?.tools?.[name];
  return { on: mine !== false, locked: false };
}
export const toolOn = (policy, settings, name) => toolState(policy, settings, name).on;

export class ToolOff extends Error {
  constructor(name) {
    super(`${TOOLS[name]?.label || name} is turned off. You can turn it on in Settings.`);
    this.name = 'ToolOff';
    this.tool = name;
  }
}

/** Where a tool's action is carried out: refused, reading policy and settings now, when the tool is off. */
export async function assertTool(name) {
  const [policy, { settings }] = await Promise.all([getPolicy().catch(() => null), browser.storage.local.get('settings')]);
  const s = toolState(policy, settings, name);
  if (!s.on) {
    const e = new ToolOff(name);
    if (s.locked) e.message = `Your organisation has turned off ${TOOLS[name].label.toLowerCase()}.`;
    throw e;
  }
}

/** The caseworker's settings with one tool switched. */
export const setTool = (settings, name, on) => ({ tools: { ...(settings?.tools || {}), [name]: !!on } });

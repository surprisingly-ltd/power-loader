// Settings: what the organisation set. On an organisation build its rules are built in (extension/policy.json);
// on the public build they come from managed storage. A setting it constrains by pattern (policy allowed) shows
// the patterns beside its box, and a value outside them isn't saved. The same check runs on every request.
import { h } from '../ui/dom.js';
import { ALLOWED_SETTINGS, allowedFor, matchesAllowed } from '../lib/policy.js';

/** "Your organisation allows: …" beside a box, or null. */
export function allowedNote(list, attrs = {}) {
  if (!list) return null;
  return h('p', { class: 'small muted', ...attrs }, '🔒 Your organisation allows ', list.length ? list.map((p, i) => [i ? ' or ' : '', h('code', {}, p)]) : 'no address here', '.');
}

/** Throws when the organisation constrains this setting and the value (as it is requested) is outside it. */
export function refuseOutside(policy, setting, value) {
  const list = allowedFor(policy, setting);
  if (!list || !value || matchesAllowed(setting, list, value)) return;
  throw new Error(`Your organisation doesn’t allow this ${setting === 'gateway.model' ? 'model' : 'address'}. It allows ${list.join(' or ') || 'none'}.`);
}

/** Settings' card: whose rules these are, and which keys they set (never their values). */
export function policyCard({ data }) {
  const policy = data.policy || {};
  const locked = [...(policy.locked || [])].sort();
  const constrained = ALLOWED_SETTINGS.filter((k) => allowedFor(policy, k));
  if (!policy.builtIn && !locked.length) return null;
  return h('div', { class: 'card', 'data-key': 'org-policy' },
    h('h2', {}, policy.builtIn ? `🔒 Rules built in by ${policy.builtIn.name}` : '🔒 Set by your organisation'),
    policy.builtIn ? h('p', { class: 'small muted' }, 'This is your organisation’s version of Power Loader. Its rules are part of it: they change when your organisation ships a new version.') : null,
    locked.length ? h('ul', { class: 'impact small' }, locked.map((k) => h('li', {}, h('code', {}, k)))) : null,
    constrained.length ? [h('p', { class: 'small' }, 'You choose these, from the addresses your organisation allows:'),
      h('ul', { class: 'impact small' }, constrained.map((k) => h('li', {}, h('code', {}, k))))] : null,
    h('p', { class: 'small muted' }, policy.builtIn ? 'These can’t be changed here.' : 'These can’t be changed here. A change to them takes effect after Firefox restarts.'));
}

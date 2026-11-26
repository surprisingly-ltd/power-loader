// Site rules: the addresses Power Loader may work on, and what it may do there. One rule shape for policy,
// the library's access.json, the caseworker's Settings and fetch steps. They guard against mistaken and
// poisoned flows, never against the caseworker: a blocked page still opens and works as normal, Power
// Loader just doesn't read it, fill it, write notes into it, capture it or fetch it.
// Pure functions, no browser APIs. See docs/plans/site-access-lists.md.
//
// Rule    { id, effect: 'allow' | 'deny', pattern, actions?: [Action], lock?: boolean, note? }
// Layer   { layer: 'policy' | 'library' | 'mine' | 'hosts', rules: [Rule], narrowOnly?, broken? }
//
// A decision for an address and an action: a deny that matches, in any layer, blocks it; a layer with allow
// rules for the action must have one that matches; every layer must allow it. So deny always wins, an empty
// allow list allows everything not denied, and adding a layer can only take pages away. fetch-post is closed:
// it needs an allow rule that names it, and an allow rule without actions never opens it.
import { canonical } from './hash.js';

export const ACCESS_SCHEMA = 'powerloader-access/1';
export const ACTIONS = ['navigate', 'read', 'fill', 'annotate', 'capture', 'fetch-get', 'fetch-post'];
export const CLOSED = new Set(['fetch-post']);
export const MAX_RULES = 500;
// What the approved-hosts layer covers: today's rule. Step links and region capture were never limited to
// approved hosts, so it doesn't cover navigate or capture (or annotate, drawn only where a step's page is).
export const HOST_ACTIONS = ['read', 'fill', 'fetch-get', 'fetch-post'];
// The actions that need the in-page agent.
export const PAGE_ACTIONS = ['read', 'fill', 'annotate', 'capture'];
export const LAYER_LABELS = { policy: 'organisation', library: 'library', mine: 'your', hosts: 'approved systems' };
export const SOURCE_TEXT = { policy: 'from your organisation', library: 'from your library', mine: 'in your Settings', hosts: 'of your library’s approved systems' };

// Reading pages in the background: fetch steps fetch pages the caseworker isn't on and clip them. One switch,
// on unless policy, the library or the caseworker turns it off. Off is a deny of the fetch actions in the same
// rule engine as every other rule, so there is one place that enforces it. The owner may change the default.
export const BACKGROUND_READING_DEFAULT = true;
export const BACKGROUND_RULE = 'background-reading-off';
export const BACKGROUND_ACTIONS = ['fetch-get', 'fetch-post'];
const backgroundDeny = () => ({ id: BACKGROUND_RULE, effect: 'deny', pattern: '*://*', actions: BACKGROUND_ACTIONS, background: true });
/** Is this decision's rule the background-reading switch, not a site rule? */
export const isBackgroundRule = (rule) => rule?.id === BACKGROUND_RULE;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const STAR_IN_HOST = '* can only start a host, as in *.example.gov.uk';

export class Blocked extends Error {
  constructor(action, rule = null) {
    super(action === 'navigate' ? 'Power Loader doesn’t open this address: the site rules block it' : 'Power Loader doesn’t work on this page: the site rules block it');
    this.name = 'Blocked';
    this.action = action;
    this.rule = rule; // { layer, id } or null
  }
}

// ------------------------------------------------------------------ patterns

// Scheme and host as Firefox reads them: lowercased, punycode, IPv4 normalised, no trailing dot.
function cleanHost(name) {
  let u;
  try { u = new URL(`http://${name}/`); } catch { return null; }
  if (u.username || u.password || u.port || u.pathname !== '/') return null;
  return u.hostname.replace(/\.$/, '');
}
const isIp = (host) => host.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(host);

/**
 * Read a pattern, written like a profile match pattern, as a URL in its parts:
 *   scheme "://" host [":" port] [rest]   scheme https | http | *; host * | [*.]name; port digits | *;
 *   rest "*" (any page, any port) | "/" path (with query; * is any run of characters)
 * { schemes, host (null: any), subdomains, port (null: any), path (null: any), re }. Throws with the reason.
 */
export function parsePattern(pattern) {
  const src = String(pattern ?? '').trim();
  if (!src) throw new Error('Enter an address');
  if (src.length > 2000) throw new Error('The address is too long');
  const m = /^(https?|\*):\/\/(.*)$/i.exec(src);
  if (!m) throw new Error('Start the address with https://, http:// or *://');
  const scheme = m[1].toLowerCase();
  let rest = m[2];
  let host = null;
  let subdomains = false;
  let anyHost = false;
  if (rest.startsWith('*.')) { subdomains = true; rest = rest.slice(2); } else if (/^\*($|[/:])/.test(rest)) { anyHost = true; rest = rest.slice(1); } else if (rest.startsWith('*')) throw new Error(STAR_IN_HOST);
  if (!anyHost) {
    const n = /^(\[[0-9A-Fa-f:.]+\]|[^\s:/*?#@[\]\\]+)/.exec(rest);
    if (!n) throw new Error(rest.startsWith('*') ? STAR_IN_HOST : 'The site name can’t be read');
    host = cleanHost(n[1]);
    if (!host) throw new Error('The site name can’t be read');
    if (subdomains && isIp(host)) throw new Error('*. can’t go before an IP address');
    rest = rest.slice(n[1].length);
  }
  let port = null;
  const p = /^:(\d{1,5}|\*)/.exec(rest);
  if (p) {
    if (p[1] !== '*') {
      port = Number(p[1]);
      if (port < 1 || port > 65535) throw new Error('The port must be a number from 1 to 65535');
    }
    rest = rest.slice(p[0].length);
  } else if (rest.startsWith(':')) throw new Error('The port must be a number');
  let path = null;
  if (rest === '' || rest === '*') path = null;
  else if (rest.startsWith('/')) {
    // Normalised as a URL is, so /a/../b is /b and a space is %20 on both sides. The fragment is dropped.
    const u = new URL(`http://x.invalid${rest}`);
    if (u.host !== 'x.invalid') throw new Error('The path can’t be read');
    path = `${u.pathname}${u.search}`;
    if (path === '/*') path = null;
  } else if (rest.startsWith('*')) throw new Error(STAR_IN_HOST);
  else throw new Error('After the site name put *, a path starting with / or a :port');
  const re = path === null ? null : new RegExp(`^${path.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return { schemes: scheme === '*' ? ['http', 'https'] : [scheme], host, subdomains, port, path, re };
}

export function patternError(pattern) {
  try { parsePattern(pattern); return null; } catch (e) { return e.message; }
}

// Compiled patterns, by text: rules are checked on every action.
const compiled = new Map();
function compile(pattern) {
  const key = String(pattern);
  if (!compiled.has(key)) {
    let out;
    try { out = parsePattern(pattern); } catch { out = null; }
    if (compiled.size > 5000) compiled.clear();
    compiled.set(key, out);
  }
  return compiled.get(key);
}

/** An address in its parts, or null when it isn't an http or https page. */
export function readUrl(url) {
  let u;
  try { u = url instanceof URL ? url : new URL(String(url)); } catch { return null; }
  const scheme = u.protocol.slice(0, -1);
  if (scheme !== 'http' && scheme !== 'https') return null;
  return {
    scheme, host: u.hostname.toLowerCase().replace(/\.$/, ''), hostPort: u.host.toLowerCase().replace(/\.(?=:|$)/, ''),
    port: u.port ? Number(u.port) : scheme === 'https' ? 443 : 80, path: `${u.pathname}${u.search}`,
  };
}

const hostMatches = (p, host) => p.host === null || host === p.host || (p.subdomains && host.endsWith(`.${p.host}`));

/** Does a parsed pattern match a read address? A deny written with https:// also covers http://. */
export function patternMatches(p, u, { deny = false } = {}) {
  if (!p || !u) return false;
  if (!p.schemes.includes(u.scheme) && !(deny && p.schemes.includes('https') && u.scheme === 'http')) return false;
  if (!hostMatches(p, u.host)) return false;
  if (p.port !== null && p.port !== u.port) return false;
  return p.re ? p.re.test(u.path) : true;
}

/** Does an address match any of these patterns? A pattern that can't be read matches nothing. */
export const matchesAny = (patterns, url) => {
  const u = readUrl(url);
  return !!u && (patterns || []).some((p) => patternMatches(compile(p), u));
};

// A punycode label (xn--…) in Unicode, for the editor to show beside it (RFC 3492). Anything odd stays as it is.
function fromPunycode(label) {
  if (!/^xn--/i.test(label)) return label;
  const input = label.slice(4).toLowerCase();
  const out = [];
  const b = input.lastIndexOf('-');
  if (b > 0) out.push(...input.slice(0, b));
  let n = 128;
  let bias = 72;
  let i = 0;
  const digit = (c) => (c >= 48 && c <= 57 ? c - 22 : c >= 97 && c <= 122 ? c - 97 : 36);
  for (let pos = b > 0 ? b + 1 : 0; pos < input.length;) {
    const old = i;
    for (let w = 1, k = 36; ; k += 36) {
      if (pos >= input.length) return label;
      const d = digit(input.charCodeAt(pos++));
      if (d >= 36) return label;
      i += d * w;
      const t = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias;
      if (d < t) break;
      w *= 36 - t;
    }
    let delta = old === 0 ? Math.floor((i - old) / 700) : (i - old) >> 1;
    delta += Math.floor(delta / (out.length + 1));
    let k = 0;
    for (; delta > 455; k += 36) delta = Math.floor(delta / 35);
    bias = Math.floor(k + (36 * delta) / (delta + 38));
    n += Math.floor(i / (out.length + 1));
    i %= out.length + 1;
    if (n > 0x10ffff) return label;
    out.splice(i++, 0, String.fromCodePoint(n));
  }
  return out.join('');
}

/** How a pattern reads, for the editor: "surprisingly.ltd and its subdomains, any page". */
export function describePattern(pattern) {
  const p = compile(pattern);
  if (!p) return 'An address Power Loader can’t read';
  const scheme = p.schemes.length > 1 ? '' : p.schemes[0] === 'https' ? ' (https only)' : ' (http only)';
  const unicode = p.host && p.host.split('.').map(fromPunycode).join('.');
  const name = unicode !== p.host ? `${unicode} (${p.host})` : p.host;
  const host = p.host === null ? 'Every site' : p.subdomains ? `${name} and its subdomains` : name;
  const port = p.port === null ? '' : `, port ${p.port}`;
  const path = p.path === null ? 'any page' : p.path.includes('*') ? `pages ${p.path}` : `only ${p.path}`;
  return `${host}${port}, ${path}${scheme}`;
}

// Hints for the editor, beside a pattern that parses.
export function patternHints(pattern, effect) {
  const p = compile(pattern);
  if (!p) return [];
  const out = [];
  if (p.path !== null && !p.path.includes('*')) out.push('Only this exact address: add * for the pages under it.');
  if (effect === 'deny' && p.host && !p.subdomains && !isIp(p.host)) out.push(`This doesn’t block its subdomains. Block *.${p.host} instead?`);
  return out;
}

// ------------------------------------------------------------------ rules

/** Problems with one rule: { id, effect, pattern, actions?, lock?, note? }. */
export function ruleErrors(rule, { needId = true } = {}) {
  if (!isObj(rule)) return ['a rule must be an object'];
  const out = [];
  if (needId && (typeof rule.id !== 'string' || !rule.id.trim() || rule.id.length > 80)) out.push('needs an "id"');
  if (!['allow', 'deny'].includes(rule.effect)) out.push('"effect" must be allow or deny');
  const err = typeof rule.pattern === 'string' ? patternError(rule.pattern) : 'needs a "pattern"';
  if (err) out.push(`the address ${String(rule.pattern ?? '').slice(0, 80)}: ${err}`);
  if (rule.actions !== undefined) {
    if (!Array.isArray(rule.actions) || !rule.actions.length) out.push('"actions" must be a list of actions');
    else for (const a of rule.actions) if (!ACTIONS.includes(a)) out.push(`“${String(a).slice(0, 40)}” isn’t an action`);
  }
  if (rule.lock !== undefined && typeof rule.lock !== 'boolean') out.push('"lock" must be true or false');
  if (rule.note !== undefined && (typeof rule.note !== 'string' || rule.note.length > 500)) out.push('"note" must be text');
  return out;
}

// A rule as it is kept: only the known keys.
export const cleanRule = (r) => ({
  id: String(r.id), effect: r.effect, pattern: String(r.pattern).trim(),
  ...(Array.isArray(r.actions) ? { actions: [...new Set(r.actions)] } : {}), ...(r.note ? { note: String(r.note) } : {}),
});

const covers = (rule, action) => (rule.actions ? rule.actions.includes(action) : rule.effect === 'deny' || !CLOSED.has(action));

function ruleMatches(rule, u, deny) {
  // The approved-hosts layer: today's hostApproved(), host[:port] exact or *.example for subdomains only.
  if (rule.approvedHost) {
    const a = rule.approvedHost.toLowerCase();
    return !!u && (a === u.hostPort || (a.startsWith('*.') && u.hostPort.endsWith(a.slice(1))));
  }
  return patternMatches(compile(rule.pattern), u, { deny });
}

// Rules given as a plain list are one layer.
const asLayers = (layers) => (Array.isArray(layers) && layers.length && 'effect' in layers[0] ? [{ layer: 'rules', rules: layers }] : layers || []);

/**
 * May Power Loader do this action at this address? layers: from accessLayers(), or a plain list of rules.
 * { ok, rule: { layer, id } | null }. rule names what blocked it; id is null when no allow rule matched.
 */
export function allowed(layers, url, action) {
  if (!ACTIONS.includes(action)) throw new Error(`Unknown action "${action}"`);
  const list = asLayers(layers);
  const u = readUrl(url);
  for (const l of list) if (l.broken) return { ok: false, rule: { layer: l.layer, id: null }, broken: true };
  for (const l of list) {
    const hit = l.rules.find((r) => r.effect === 'deny' && covers(r, action) && ruleMatches(r, u, true));
    if (hit) return { ok: false, rule: { layer: l.layer, id: hit.id } };
  }
  for (const l of list) {
    const allows = l.rules.filter((r) => r.effect === 'allow' && covers(r, action));
    if (allows.length && !allows.some((r) => ruleMatches(r, u, false))) return { ok: false, rule: { layer: l.layer, id: null } };
  }
  if (CLOSED.has(action) && !list.some((l) => !l.narrowOnly && l.rules.some((r) => r.effect === 'allow' && r.actions?.includes(action) && ruleMatches(r, u, false)))) {
    return { ok: false, rule: null };
  }
  return { ok: true, rule: null };
}

/** The actions blocked at this address: { action: { layer, id } | null }. */
export function blockedHere(layers, url, actions = ACTIONS.filter((a) => !CLOSED.has(a))) {
  const out = {};
  for (const a of actions) {
    const v = allowed(layers, url, a);
    if (!v.ok) out[a] = v.rule;
  }
  return out;
}

/**
 * A Firefox host permission is a whole origin: "blocked" when the rules block every page of it for every
 * page action, "partial" when some pages of it may be blocked, else "open". origin: "https://host/*" or a URL.
 */
export function originVerdict(layers, origin) {
  const m = /^(https?):\/\/([^/]+)/i.exec(String(origin));
  if (!m) return 'open';
  const u = readUrl(`${m[1]}://${m[2]}/`);
  if (!u) return 'open';
  const list = asLayers(layers);
  if (list.some((l) => l.broken)) return 'blocked';
  const whole = (p) => p && p.port === null && p.path === null;
  const blockedFor = (action) => list.some((l) => {
    if (l.rules.some((r) => r.effect === 'deny' && covers(r, action) && !r.approvedHost && whole(compile(r.pattern)) && patternMatches(compile(r.pattern), u, { deny: true }))) return true;
    const allows = l.rules.filter((r) => r.effect === 'allow' && covers(r, action));
    // No allow rule here can match any page of this origin: a scheme or host it doesn't name.
    return allows.length && !allows.some((r) => (r.approvedHost ? ruleMatches(r, u, false) : (() => { const p = compile(r.pattern); return p && p.schemes.includes(u.scheme) && hostMatches(p, u.host); })()));
  });
  if (PAGE_ACTIONS.every(blockedFor)) return 'blocked';
  const some = list.some((l) => l.rules.some((r) => r.effect === 'deny' && !r.approvedHost && !r.background && (() => { const p = compile(r.pattern); return p && hostMatches(p, u.host); })()));
  return some || PAGE_ACTIONS.some(blockedFor) ? 'partial' : 'open';
}

/** Do any site rules narrow what Power Loader may do (beyond the approved hosts)? */
export const restricts = (layers) => asLayers(layers).some((l) => l.layer !== 'hosts' && (l.broken || l.rules.some((r) => !r.background)));

// ------------------------------------------------------------------ layers

/**
 * Policy's siteAccess: { allow: [pattern], deny: [pattern], rules: [Rule], lockLibraryRules }. An allow that
 * doesn't parse matches nothing, which narrows. A deny that doesn't parse would widen if it were dropped,
 * so the layer is broken: Power Loader then works nowhere until IT corrects it.
 */
export function policyLayer(sa = {}) {
  const rules = [];
  let broken = null;
  const list = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
  list(sa?.allow).forEach((pattern, i) => rules.push({ id: `policy-allow-${i + 1}`, effect: 'allow', pattern: String(pattern) }));
  list(sa?.deny).forEach((pattern, i) => {
    if (typeof pattern !== 'string' || patternError(pattern)) broken = broken ?? String(pattern);
    rules.push({ id: `policy-deny-${i + 1}`, effect: 'deny', pattern: String(pattern) });
  });
  list(sa?.rules).forEach((r, i) => {
    const id = String((isObj(r) && r.id) || `policy-rule-${i + 1}`);
    if (!ruleErrors({ ...r, id }).length) rules.push(cleanRule({ ...r, id }));
    // An allow rule that doesn't read still narrows: it matches nothing, for the actions it names.
    else if (r?.effect === 'allow') rules.push({ id, effect: 'allow', pattern: String(r.pattern ?? ''), ...(Array.isArray(r.actions) && r.actions.length && r.actions.every((a) => ACTIONS.includes(a)) ? { actions: r.actions } : {}) });
    else broken = broken ?? String(r?.pattern ?? '');
  });
  return { layer: 'policy', rules, ...(broken !== null ? { broken } : {}) };
}

/** The approved-hosts layer: a library's approvedHosts, or a flow's own hosts. An empty list approves nothing. */
export function hostsLayer(hosts = []) {
  const rules = hosts.map((h, i) => ({ id: `host-${i + 1}`, effect: 'allow', pattern: `*://${h}*`, approvedHost: String(h), actions: HOST_ACTIONS }));
  // An empty list is a list that allows nothing, never "no opinion".
  if (!rules.length) rules.push({ id: 'no-hosts', effect: 'allow', pattern: '', approvedHost: ' ', actions: HOST_ACTIONS });
  return { layer: 'hosts', rules, narrowOnly: true };
}

export const ruleHash = (r) => canonical(cleanRule(r));

/**
 * The library's delegated rules as the caseworker has left them. overrides: settings.siteAccess.library,
 * { [id]: { off?: true, rule?: Rule, base?: hash of the library's rule when it was changed } }. A rule the
 * library removed is gone, even if it was edited. [{ id, lib, rule, state: 'library' | 'changed' | 'conflict' | 'off' }]
 */
export function delegatedView(delegated = [], overrides = {}) {
  return delegated.map((lib) => {
    const o = overrides?.[lib.id];
    if (o?.off) return { id: lib.id, lib, rule: lib, state: 'off' };
    if (o?.rule) {
      const rule = { ...cleanRule({ ...o.rule, id: lib.id }) };
      return { id: lib.id, lib, rule, state: o.base && o.base !== ruleHash(lib) ? 'conflict' : 'changed' };
    }
    return { id: lib.id, lib, rule: lib, state: 'library' };
  });
}

/** The caseworker's own rules, as saved: { rules: [Rule], library: overrides }. Rules that don't read are left out. */
export const mineOf = (settings) => (Array.isArray(settings?.siteAccess?.rules) ? settings.siteAccess.rules : []).filter((r) => !ruleErrors(r).length && !r.off);

/**
 * Every layer for a decision. policy: getPolicy()'s result; settings: the caseworker's; caseLib: the open
 * case's pinned library (its access.json); currentLib: the library synced now. Both libraries' locked rules
 * apply while a case is open, so a deny published mid-case reaches it. hosts: the approved hosts to add as
 * the last layer, or undefined for none.
 */
export function accessLayers({ policy = null, settings = null, caseLib = null, currentLib = null, hosts } = {}) {
  const sa = policy?.values?.siteAccess || {};
  const layers = [policyLayer(sa)];
  const lockAll = !!sa.lockLibraryRules;
  const libs = [caseLib, currentLib].filter((l, i, all) => l?.access && all.findIndex((x) => x?.commit === l.commit) === i);
  for (const lib of libs) {
    const rules = [...lib.access.locked, ...(lockAll ? lib.access.delegated : [])];
    if (rules.length) layers.push({ layer: 'library', commit: lib.commit, rules });
  }
  const from = currentLib?.access ? currentLib : caseLib;
  const delegated = lockAll || !from?.access ? [] : delegatedView(from.access.delegated, settings?.siteAccess?.library).filter((d) => d.state !== 'off').map((d) => d.rule);
  layers.push({ layer: 'mine', rules: [...delegated, ...mineOf(settings)] });
  // Background reading off: a deny of the fetch actions, in the layer of whoever turned it off.
  const bg = backgroundReading({ policy, settings, caseLib, currentLib });
  if (!bg.on) {
    const into = bg.by === 'policy' ? layers[0] : bg.by === 'library' && bg.locked ? null : layers[layers.length - 1];
    if (into) into.rules = [...into.rules, backgroundDeny()];
    else layers.splice(1, 0, { layer: 'library', rules: [backgroundDeny()] });
  }
  if (Array.isArray(hosts)) layers.push(hostsLayer(hosts));
  return layers;
}

/**
 * Whether Power Loader may read pages in the background (fetch steps), and who decided:
 * { on, by: 'policy' | 'library' | 'mine' | 'default', locked }. Policy siteAccess.backgroundReading sets and
 * locks it; then a library's access.json backgroundReading with lock (or policy lockLibraryRules); then the
 * caseworker's own setting; then the library's unlocked choice; then BACKGROUND_READING_DEFAULT. Between the
 * case's pinned library and the synced one, a locked off wins.
 */
export function backgroundReading({ policy = null, settings = null, caseLib = null, currentLib = null } = {}) {
  const sa = policy?.values?.siteAccess || {};
  if (typeof sa.backgroundReading === 'boolean') return { on: sa.backgroundReading, by: 'policy', locked: true };
  const lockAll = !!sa.lockLibraryRules;
  const locked = [caseLib, currentLib].map((l) => l?.access?.background).filter((b) => b && (b.lock || lockAll));
  if (locked.length) return { on: locked.every((b) => b.on), by: 'library', locked: true };
  const mine = settings?.siteAccess?.backgroundReading;
  if (typeof mine === 'boolean') return { on: mine, by: 'mine', locked: false };
  const from = currentLib?.access ? currentLib : caseLib;
  if (from?.access?.background) return { on: from.access.background.on, by: 'library', locked: false };
  return { on: BACKGROUND_READING_DEFAULT, by: 'default', locked: false };
}

/** Why background reading is off, in words for the caseworker, or null when it's on. */
export function backgroundOffText(bg) {
  if (!bg || bg.on) return null;
  const yourself = 'You can still open each page and clip it yourself.';
  if (bg.by === 'policy' || (bg.by === 'library' && bg.locked)) return `Your organisation has turned off reading pages in the background, so Power Loader can’t fetch these pages for you. ${yourself}`;
  if (bg.by === 'mine') return `You’ve turned off reading pages in the background in Settings, so Power Loader doesn’t fetch these pages for you. ${yourself} Or turn it back on in Settings.`;
  return `Reading pages in the background is off for your library, so Power Loader doesn’t fetch these pages for you. ${yourself} Or turn it on in Settings.`;
}

// ------------------------------------------------------------------ the library's access.json

/**
 * Problems with access.json: { schema, allow?: { lock, rules }, deny?: { lock, rules }, rules?: [Rule] }.
 * Rules in allow and deny take their list's effect.
 */
export function validateAccess(doc) {
  if (!isObj(doc)) return ['access.json must be a JSON object'];
  const out = [];
  if (doc.schema !== ACCESS_SCHEMA) out.push(`access.json must have schema "${ACCESS_SCHEMA}"`);
  const ids = new Set();
  let n = 0;
  const check = (r, at, effect) => {
    n++;
    for (const e of ruleErrors(effect ? { ...r, effect } : r)) out.push(`${at}: ${e}`);
    if (isObj(r) && typeof r.id === 'string') {
      if (ids.has(r.id)) out.push(`${at}: the id "${r.id.slice(0, 40)}" is used twice`);
      ids.add(r.id);
    }
  };
  for (const effect of ['allow', 'deny']) {
    const list = doc[effect];
    if (list === undefined) continue;
    if (!isObj(list) || !Array.isArray(list.rules)) { out.push(`"${effect}" must be { lock, rules }`); continue; }
    if (list.lock !== undefined && typeof list.lock !== 'boolean') out.push(`"${effect}.lock" must be true or false`);
    list.rules.forEach((r, i) => {
      if (isObj(r) && r.effect !== undefined && r.effect !== effect) out.push(`${effect}.rules[${i}]: a rule in the ${effect} list can’t be ${r.effect}`);
      check(r, `${effect}.rules[${i}]`, effect);
    });
  }
  if (doc.rules !== undefined) {
    if (!Array.isArray(doc.rules)) out.push('"rules" must be a list');
    else doc.rules.forEach((r, i) => check(r, `rules[${i}]`));
  }
  if (n > MAX_RULES) out.push(`access.json has more than ${MAX_RULES} rules`);
  if (doc.backgroundReading !== undefined) {
    const b = doc.backgroundReading;
    if (!isObj(b) || typeof b.on !== 'boolean') out.push('"backgroundReading" must be { on: true or false, lock? }');
    else if (b.lock !== undefined && typeof b.lock !== 'boolean') out.push('"backgroundReading.lock" must be true or false');
  }
  return out;
}

/**
 * The rules of a valid access.json, locked or delegated. A rule's own lock overrides its list's. background:
 * the library's choice for reading pages in the background, { on, lock }, or null when it makes none.
 */
export function accessOf(doc) {
  const locked = [];
  const delegated = [];
  const add = (r, listLock) => ((r.lock ?? listLock ?? false) ? locked : delegated).push(cleanRule(r));
  for (const effect of ['allow', 'deny']) for (const r of doc[effect]?.rules || []) add({ ...r, effect }, doc[effect].lock);
  for (const r of doc.rules || []) add(r, false);
  const b = doc.backgroundReading;
  return { locked, delegated, background: isObj(b) ? { on: b.on, lock: !!b.lock } : null };
}

// ------------------------------------------------------------------ addresses in templates and patterns

/**
 * Is the scheme and host of a templated address written out, with no {name} in it? A case value in the host
 * could send a link (or a fetch) to any site. The path and query may hold values.
 */
export function literalOrigin(tpl) {
  const m = /^(https?):\/\/([^/?#]*)/i.exec(String(tpl || ''));
  return !!m && !!m[2] && !/[{}]/.test(m[2]);
}

/**
 * What the rules say about a profile-style match pattern (a glob that can cover many addresses), judged by
 * its fixed start: scheme, host and the path up to the first *. 'blocked' when that start is blocked,
 * 'some' when a deny for the action names its host (some pages it matches may be blocked), else 'ok'.
 */
export function globVerdict(layers, glob, action) {
  const m = /^(\*|https?):\/\/(\*\.)?([^/*?#]+)(.*)$/i.exec(String(glob || '').replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g, 'sample'));
  if (!m) return { verdict: 'ok', rule: null };
  const fixed = m[4].startsWith('/') ? m[4].split('*')[0] : '/';
  const schemes = m[1] === '*' ? ['https', 'http'] : [m[1].toLowerCase()];
  for (const s of schemes) {
    const v = allowed(layers, `${s}://${m[3]}${fixed}`, action);
    if (!v.ok) return { verdict: 'blocked', rule: v.rule };
  }
  const u = readUrl(`${schemes[0]}://${m[3]}/`);
  // A deny on the glob's host, or (for *.host) on any site under it, may block some of the pages it matches.
  const under = (p) => !!m[2] && p.host && u && (p.host === u.host || p.host.endsWith(`.${u.host}`));
  const some = asLayers(layers).find((l) => l.rules.some((r) => r.effect === 'deny' && covers(r, action) && !r.approvedHost && (() => { const p = compile(r.pattern); return p && u && (hostMatches(p, u.host) || under(p)); })()));
  return some ? { verdict: 'some', rule: { layer: some.layer, id: null } } : { verdict: 'ok', rule: null };
}

// ------------------------------------------------------------------ the caseworker's rules in Settings

// settings.siteAccess = { rules: [Rule], library: { [id]: { off?: true, rule?: Rule, base?: hash } }, backgroundReading?: boolean }
const saOf = (settings) => ({
  rules: Array.isArray(settings?.siteAccess?.rules) ? structuredClone(settings.siteAccess.rules) : [],
  library: isObj(settings?.siteAccess?.library) ? structuredClone(settings.siteAccess.library) : {},
  ...(typeof settings?.siteAccess?.backgroundReading === 'boolean' ? { backgroundReading: settings.siteAccess.backgroundReading } : {}),
});

/** The caseworker's own choice for reading pages in the background. It applies only where nothing locks it. */
export function setBackgroundReading(settings, on) {
  const sa = saOf(settings);
  sa.backgroundReading = !!on;
  return sa;
}

/**
 * Every rule the Settings card lists, by where it comes from. source: 'policy' | 'library' (locked) |
 * 'delegated' | 'mine'; state for delegated rules as delegatedView() gives it.
 */
export function settingsRows({ policy = null, settings = null, caseLib = null, currentLib = null } = {}) {
  const sa = policy?.values?.siteAccess || {};
  const rows = policyLayer(sa).rules.map((rule) => ({ source: 'policy', rule }));
  const seen = new Set();
  const lockAll = !!sa.lockLibraryRules;
  for (const lib of [currentLib, caseLib]) {
    for (const rule of lib?.access ? [...lib.access.locked, ...(lockAll ? lib.access.delegated : [])] : []) {
      const key = ruleHash(rule);
      if (!seen.has(key)) { seen.add(key); rows.push({ source: 'library', rule }); }
    }
  }
  const from = currentLib?.access ? currentLib : caseLib;
  if (!lockAll && from?.access) for (const d of delegatedView(from.access.delegated, settings?.siteAccess?.library)) rows.push({ source: 'delegated', rule: d.rule, lib: d.lib, state: d.state });
  for (const rule of saOf(settings).rules) rows.push({ source: 'mine', rule });
  return rows;
}

const newId = () => `mine-${Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('')}`;

/** Add one of the caseworker's own rules. Throws with the reason when the address doesn't read. */
export function addMine(settings, { effect, pattern, actions }) {
  const rule = cleanRule({ id: newId(), effect, pattern, ...(actions ? { actions } : {}) });
  const errors = ruleErrors(rule);
  if (errors.length) throw new Error(patternError(pattern) || errors[0]);
  const sa = saOf(settings);
  sa.rules.push(rule);
  return sa;
}

export function editMine(settings, id, pattern) {
  const err = patternError(pattern);
  if (err) throw new Error(err);
  const sa = saOf(settings);
  sa.rules = sa.rules.map((r) => (r.id === id ? { ...r, pattern: String(pattern).trim() } : r));
  return sa;
}

export function removeMine(settings, id) {
  const sa = saOf(settings);
  sa.rules = sa.rules.filter((r) => r.id !== id);
  return sa;
}

/** A delegated rule, turned off or back on. */
export function setDelegatedOff(settings, id, off) {
  const sa = saOf(settings);
  const o = { ...(sa.library[id] || {}) };
  if (off) o.off = true; else delete o.off;
  if (Object.keys(o).length) sa.library[id] = o; else delete sa.library[id];
  return sa;
}

/** The caseworker's own version of a delegated rule. base remembers the library's rule it was made from. */
export function changeDelegated(settings, libRule, pattern) {
  const err = patternError(pattern);
  if (err) throw new Error(err);
  const sa = saOf(settings);
  sa.library[libRule.id] = { ...(sa.library[libRule.id]?.off ? { off: true } : {}), rule: { ...cleanRule(libRule), pattern: String(pattern).trim() }, base: ruleHash(libRule) };
  return sa;
}

/** Back to the library's rule: the caseworker's change is dropped. */
export function useLibraryRule(settings, id) {
  const sa = saOf(settings);
  const o = { ...(sa.library[id] || {}) };
  delete o.rule;
  delete o.base;
  if (Object.keys(o).length) sa.library[id] = o; else delete sa.library[id];
  return sa;
}

/** The library changed a rule the caseworker had changed: keep theirs, against the library's new one. */
export function keepMineRule(settings, libRule) {
  const sa = saOf(settings);
  if (sa.library[libRule.id]?.rule) sa.library[libRule.id] = { ...sa.library[libRule.id], base: ruleHash(libRule) };
  return sa;
}

/** "Try an address": what the rules say about it, in words. */
export function tryAddress(layers, url) {
  const u = readUrl(url);
  if (!u) return { ok: false, text: 'Power Loader only works on web pages: addresses starting http:// or https://' };
  const blocked = PAGE_ACTIONS.filter((a) => !allowed(layers, url, a).ok);
  if (!blocked.length) return { ok: true, text: 'Power Loader works here' };
  const rule = allowed(layers, url, blocked[0]).rule;
  const found = rule?.id && asLayers(layers).find((l) => l.layer === rule.layer)?.rules.find((r) => r.id === rule.id);
  const by = rule ? `${LAYER_LABELS[rule.layer] || 'a'} rule${found?.pattern ? ` ${found.pattern}` : rule.id === null ? ': the address isn’t on its allowed list' : ''}` : 'the site rules';
  const what = blocked.length === PAGE_ACTIONS.length ? '' : ` for ${blocked.join(', ')}`;
  return { ok: false, text: `Power Loader doesn’t work here${what}: blocked by ${by}` };
}

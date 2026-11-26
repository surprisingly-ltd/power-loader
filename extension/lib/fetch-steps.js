// Running a fetch step: the pages it names are fetched from the trigger page when the caseworker presses its
// button, read with their page profiles and added to the case as clips. GET only, from the trigger page's own
// site, no redirects, every address checked by the site rules before and after. See docs/plans/fetch-steps.md.
//
// Everything here is pure except fetchInPage() and abortInPage(), which are packaged functions that
// lib/core.js fetchFromTab() runs in the trigger tab. The runner takes its browser parts as arguments, so it is
// tested offline with a stubbed fetch.
//
// How a response is read depends on the page profile's format (FORMATS): HTML is parsed with DOMParser, JSON
// with lib/json-dom.js into a synthetic document (docs/plans/json-clips.md). Either way extract() reads it.
import './json-dom.js';
import { excerptsOf, textView } from './fetch-view.js';
import { allowed, isBackgroundRule } from './access.js';
import { addClip, clipFromExtract, removeClip } from './case.js';
import { logBlocked, logEvent } from './activity.js';
import { MAX_LIST, MAX_REQUESTS, caseVars, fillFetchUrl, isListRequest, markStep, stepStatus } from './journey.js';
import { judgeTest } from './drafts.js';
import { detect, patternsFor } from './privacy-detect.js';

const E = () => globalThis.PowerLoaderExtract;
const J = () => globalThis.PowerLoaderJson;

export const FETCH_LIMITS = Object.freeze({
  perStep: MAX_REQUESTS, // fixed requests a step
  perList: MAX_LIST, // addresses a list of links gives, at most; a step has at most one list
  perCase: 60, // requests a case in windowMs, so a mistaken flow can't hammer a system: two full lists and a case's own
  windowMs: 10 * 60 * 1000,
  parallel: 4, // requests at a time: 25 pages in about 7 rounds, still gentle on a casework system
  timeoutMs: 20 * 1000, // one request
  runMs: 60 * 1000, // a whole run
  maxBytes: 2 * 1024 * 1024, // one response
});

// ------------------------------------------------------------------ response formats

// The media type of a Content-Type header, lowercased, without its parameters.
export const mediaType = (contentType) => String(contentType || '').split(';')[0].trim().toLowerCase();
const charsetOf = (contentType) => /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(String(contentType || ''))?.[1] || 'utf-8';

/** Bytes as text in the response's charset (UTF-8 when it names none, or one TextDecoder doesn't know). */
export function decodeText(bytes, contentType, { fatal = false } = {}) {
  let decoder;
  try { decoder = new TextDecoder(charsetOf(contentType), { fatal }); } catch { decoder = new TextDecoder('utf-8', { fatal }); }
  return decoder.decode(bytes || new Uint8Array(0));
}

/**
 * How each profile format is fetched and read. accept: the request's one Accept header; accepts(mediaType):
 * whether a response's Content-Type is this format (never sniffed from the body); refuse(mediaType): the
 * failure code for one it doesn't accept; read(bytes, { contentType, url, DOMParser }): { doc, stats? }, a
 * document extract() can read, or throws; title(doc, profile): the clip's title.
 */
export const FORMATS = {
  html: {
    accept: 'text/html,application/xhtml+xml',
    accepts: (type) => type === 'text/html' || type === 'application/xhtml+xml',
    refuse: () => 'type',
    // A parsed document has no browsing context: its scripts don't run and nothing in it loads. extract() uses
    // no layout, so it reads a parsed page as it reads a live one (elements hidden with CSS are read too).
    read: (bytes, { contentType, DOMParser }) => ({ doc: new DOMParser().parseFromString(decodeText(bytes, contentType), 'text/html') }),
    title: (doc, profile) => String(doc.title || profile.name || ''),
  },
  json: {
    // One fixed header, never templated: many APIs answer 406, or send HTML, without it.
    accept: 'application/json',
    accepts: (type) => J().jsonContentType(type) === 'json',
    // problem+json is an error response, and JavaScript is code (JSONP), which Power Loader never runs.
    refuse: (type) => ({ problem: 'problem', script: 'script' }[J().jsonContentType(type)] || 'notdata'),
    // Our own strict parser, in the extension's context, into a document with no browsing context. The
    // DOMParser's document only lends its implementation: nothing is parsed as markup.
    read: (bytes, { contentType, DOMParser }) => J().readJson(bytes, { contentType, documentSource: new DOMParser().parseFromString('', 'text/html') }),
    // JSON has no <title>: the clip is named after its profile.
    title: (doc, profile) => String(profile.name || ''),
  },
};

/** A page profile's format: 'html' unless it says otherwise. */
export const formatOf = (profile) => profile?.format || 'html';

// ------------------------------------------------------------------ what goes wrong, in words

/** A failure, as the step card shows it. name: the request's name; reason: why JSON was refused (lib/json-dom.js). */
export function failureText(code, { name = 'This page', status = '', reason = '', data = false } = {}) {
  if (code === 'json') return J().refusalText(reason, { name });
  return {
    missing: 'Needs a value the case hasn’t got yet',
    template: 'Its address can’t be used: ask the flow’s author to correct it',
    dots: 'A value the address needs can’t be used in an address',
    origin: 'Its address would go to another site, so Power Loader won’t fetch it',
    trigger: 'It’s on a different site from this page, so it can’t be fetched from here',
    profile: 'Its address isn’t the page its profile reads, so Power Loader won’t fetch it',
    noprofile: 'Its page profile isn’t in this case’s library',
    format: 'Power Loader can’t read this kind of page yet',
    blocked: 'Blocked by the site rules',
    off: 'Reading pages in the background is turned off',
    redirect: `${name} moved to another address, probably a sign-in page. Open it in a tab, sign in, then try again.`,
    signin: 'You may need to sign in again',
    status: `The ${data ? 'system' : 'page'} returned an error (${status})`,
    size: 'The page is too large to read (over 2 MB)',
    type: 'This isn’t a page Power Loader can read',
    notdata: `${name} sent a page, not data: check the address`,
    script: 'This is a script, not data',
    problem: 'The system returned an error',
    unreadable: 'The page couldn’t be read',
    when: 'The page isn’t the one its profile reads',
    timeout: 'The page took too long to answer',
    network: 'The page couldn’t be reached',
    moved: 'This tab moved to another page, so the request was stopped',
    list: 'Couldn’t read the links on this page',
    stopped: 'Stopped',
    ended: 'The case ended, so nothing was added',
  }[code] || 'Couldn’t fetch it';
}

// For the activity log: the kind of failure only, never the address or a value.
const LOG_CODE = {
  redirect: 'redirect', signin: 'sign-in', size: 'too large', type: 'not a page', unreadable: 'not a page', when: 'not its page', timeout: 'timeout', network: 'network', moved: 'moved', stopped: 'stopped', format: 'not a page',
  notdata: 'not data', script: 'script', problem: 'error',
};
const JSON_LOG = { syntax: 'not data', encoding: 'encoding', depth: 'too deep', values: 'too large', members: 'too large', string: 'too large', key: 'too large', number: 'too large', bytes: 'too large' };
const logCode = (code, status, reason) => (code === 'status' ? `error ${status}` : code === 'json' ? JSON_LOG[reason] || 'not data' : LOG_CODE[code] || code);

// ------------------------------------------------------------------ planning a run

const originOf = (url) => { try { return new URL(url).origin; } catch { return null; } };
const recentFetches = (c, now) => (c.log || []).filter((e) => e.activity === 'fetch_page' && now - Date.parse(e.timestamp) < FETCH_LIMITS.windowMs).length;

/**
 * What one request would fetch, before anything is sent: its profile, its filled address and any reason it
 * can't go. { request, profile, url, missing, problem: null | code, rule? }. The address must fill from the
 * case's settled values, keep its template's site, be on the tab's own site, match its profile, and be
 * allowed for fetch-get by every layer of the site rules (background reading off is one of them).
 */
export function planRequest({ request, lib, vars, layers, tabUrl }) {
  const profile = lib.profiles.find((p) => p.id === request.profileId) || null;
  const out = { request, profile, url: null, missing: [], problem: null };
  if (!profile) return { ...out, problem: 'noprofile' };
  if (!FORMATS[formatOf(profile)]) return { ...out, problem: 'format' };
  if (request.method && request.method !== 'GET') return { ...out, problem: 'template' };
  const f = fillFetchUrl(request.url, vars);
  if (f.error) return { ...out, problem: f.error };
  if (!f.url) return { ...out, missing: f.missing, problem: 'missing' };
  out.url = f.url;
  if (!tabUrl || originOf(f.url) !== originOf(tabUrl)) return { ...out, problem: 'trigger' };
  if (!E().matchUrl(profile.match, f.url)) return { ...out, problem: 'profile' };
  const v = allowed(layers, f.url, 'fetch-get');
  if (!v.ok) return { ...out, problem: isBackgroundRule(v.rule) ? 'off' : 'blocked', rule: v.rule };
  return out;
}

/**
 * The addresses of a list's links, as a run would fetch them: each resolved against the page's address, its
 * fragment removed, duplicates dropped, in order, and only the first max kept (never more than perList).
 */
export function listAddresses(hrefs, pageUrl, max = FETCH_LIMITS.perList) {
  const cap = Math.min(Number.isInteger(max) ? max : FETCH_LIMITS.perList, FETCH_LIMITS.perList);
  const seen = new Set();
  const out = [];
  for (const href of Array.isArray(hrefs) ? hrefs : []) {
    if (out.length >= cap) break;
    if (typeof href !== 'string' || !href.trim()) continue;
    let u;
    try { u = new URL(href.trim(), pageUrl); } catch { continue; }
    u.hash = '';
    if (seen.has(u.href)) continue;
    seen.add(u.href);
    out.push(u.href);
  }
  return out;
}

/**
 * A list request's items, before anything is sent: one per address taken from the page's links, each with
 * the reason it can't go, if any. Every address must be on the trigger tab's site, be a page the child profile
 * reads (its match) and be allowed for fetch-get by every layer of the site rules. hrefs is what the trigger
 * page's own profile read (lib/core.js readListFromTab()), or null when it couldn't be read.
 */
export function planList({ request, lib, layers, tabUrl, hrefs }) {
  const profile = lib.profiles.find((p) => p.id === request.profileId) || null;
  const base = { request, profile, url: null, missing: [], list: true };
  if (!profile || !lib.profiles.some((p) => p.id === request.each?.profileId)) return [{ ...base, key: request.id, problem: 'noprofile' }];
  if (!FORMATS[formatOf(profile)]) return [{ ...base, key: request.id, problem: 'format' }];
  if (hrefs == null) return [{ ...base, key: request.id, problem: 'list' }];
  return listAddresses(hrefs, tabUrl, request.each.max).map((url, i) => {
    const item = { ...base, key: `${request.id}#${i + 1}`, url, problem: null };
    if (!tabUrl || originOf(url) !== originOf(tabUrl)) return { ...item, problem: 'trigger' };
    if (!E().matchUrl(profile.match, url)) return { ...item, problem: 'profile' };
    const v = allowed(layers, url, 'fetch-get');
    if (!v.ok) return { ...item, problem: isBackgroundRule(v.rule) ? 'off' : 'blocked', rule: v.rule };
    return item;
  });
}

/** The clips a list request has put in the case. */
export const listClips = (c, step, request) => c.clips.filter((cl) => cl.kind === 'fetch' && cl.via?.stepId === step.id && cl.via.requestId === request.id);

/**
 * A run as it would start now: { problem: null | 'not-here' | 'cap' | 'none', items: [planRequest() | planList() item] }.
 * Each item has a key: the request's id, or for a list's addresses the request's id and its place (r1#3).
 * not-here: the tab isn't on the step's trigger page, from which every request is made. lists: { requestId:
 * hrefs } read from the trigger tab. rest: a list's addresses already fetched into the case are left out
 * (Fetch the rest).
 */
export function planRun({ step, lib, c, layers, tabUrl, now = Date.now(), lists = {}, rest = false }) {
  const all = step.fetch?.requests || [];
  const requests = [...all.filter((r) => !isListRequest(r)).slice(0, FETCH_LIMITS.perStep), ...all.filter(isListRequest).slice(0, 1)];
  const vars = caseVars(c, lib);
  const items = [];
  for (const request of all.filter((r) => requests.includes(r))) {
    if (!isListRequest(request)) { items.push({ ...planRequest({ request, lib, vars, layers, tabUrl }), key: request.id }); continue; }
    let got = planList({ request, lib, layers, tabUrl, hrefs: lists[request.id] ?? null });
    if (rest) { const have = new Set(listClips(c, step, request).map((cl) => cl.url)); got = got.filter((i) => !i.url || !have.has(i.url)); }
    items.push(...got);
  }
  let problem = null;
  if (!requests.length) problem = 'none';
  else if (step.match?.length && !(tabUrl && E().matchUrl(step.match, tabUrl))) problem = 'not-here';
  else if (recentFetches(c, now) + items.filter((i) => !i.problem).length > FETCH_LIMITS.perCase) problem = 'cap';
  return { problem, items };
}

/**
 * What a fetch step's show picks from the case: the rows of its type, read by its list request, whose values
 * equal where's exactly. { show, matches: [{ clipId, url, row }], read: pages read, others: pages with no match }
 * or null when the step has no show.
 */
export function shownRows(c, step) {
  const show = step.fetch?.show;
  if (!show) return null;
  const list = (step.fetch.requests || []).find(isListRequest);
  const clips = c.clips.filter((cl) => cl.kind === 'fetch' && cl.via?.stepId === step.id && (!list || cl.via.requestId === list.id));
  const matches = [];
  for (const cl of clips) {
    for (const row of cl.records || []) {
      if (row.type !== show.type) continue;
      if (Object.entries(show.where || {}).every(([k, v]) => String(row[k] ?? '') === v)) matches.push({ clipId: cl.id, url: cl.url, row });
    }
  }
  const hit = new Set(matches.map((m) => m.clipId));
  return { show, matches, read: clips.length, others: clips.filter((cl) => !hit.has(cl.id)).length };
}

/** A list request's name as a plural noun: "Messages" fetches "25 messages", or "1 message". */
export const listNoun = (request, n) => {
  const w = String(request?.name || 'pages').trim().toLowerCase() || 'pages';
  return n === 1 && /[^s]s$/.test(w) ? w.slice(0, -1) : w;
};

// ------------------------------------------------------------------ reading a response

/**
 * What's wrong with a response, or null. Any redirect fails: following one would let a request end up
 * somewhere the checks didn't cover. A response from another address than the one asked for is checked
 * again against the rules, the origin and the profile before anything is read.
 */
export function responseProblem(res, { url, profile, layers }) {
  if (!res || typeof res !== 'object') return { code: 'network' };
  if (res.error) return { code: ['timeout', 'stopped', 'moved', 'origin'].includes(res.error) ? (res.error === 'origin' ? 'trigger' : res.error) : 'network' };
  if (res.type === 'opaqueredirect' || res.redirected || res.status === 0 || (res.status >= 300 && res.status < 400)) return { code: 'redirect' };
  if (res.status === 401 || res.status === 403) return { code: 'signin' };
  if (!(res.status >= 200 && res.status <= 299)) return { code: 'status', status: res.status };
  if (res.tooLarge || (res.bytes?.length || 0) > FETCH_LIMITS.maxBytes) return { code: 'size' };
  const format = FORMATS[formatOf(profile)];
  if (!format.accepts(mediaType(res.contentType))) return { code: format.refuse(mediaType(res.contentType)) };
  const final = res.url || url;
  if (final !== url) {
    if (originOf(final) !== originOf(url) || !E().matchUrl(profile.match, final)) return { code: 'redirect' };
    const v = allowed(layers, final, 'fetch-get');
    if (!v.ok) return { code: isBackgroundRule(v.rule) ? 'off' : 'blocked', rule: v.rule };
  }
  return null;
}

/**
 * Read a good response with its profile: { data, url, title } as the agent's extract gives for a tab, or
 * { problem }. DOMParser comes from the caller (the sidebar's, or jsdom's in tests). JSON adds quotes (each
 * field's path and the value as sent, the only way to check a value against a response nobody sees), its
 * format, and repeated: whether the response repeats a key.
 */
export function readResponse(res, { url, profile, DOMParser }) {
  const got = responseDocument(res, { url, profile, DOMParser });
  if (got.problem) return got;
  const out = E().extract(got.doc, profile, { baseUrl: got.url });
  const json = formatOf(profile) === 'json';
  const read = {
    data: out.data, url: got.url, title: FORMATS[formatOf(profile)].title(got.doc, profile).slice(0, 300),
    ...(json ? { quotes: J().jsonQuotes(got.doc, profile), format: 'json', repeated: !!got.stats?.duplicates?.length } : {}),
  };
  // The parsed response, for its text view (lib/fetch-view.js): in memory only, never stored or sent as markup.
  Object.defineProperty(read, 'doc', { value: got.doc, enumerable: false });
  return read;
}

/** A good response as a document its profile applies to: { doc, url, stats? } or { problem }. */
export function responseDocument(res, { url, profile, DOMParser }) {
  const final = res.url || url;
  let read;
  try { read = FORMATS[formatOf(profile)].read(res.bytes, { contentType: res.contentType, url: final, DOMParser }); } catch (e) {
    return { problem: e?.name === 'JsonRefused' ? { code: 'json', reason: e.reason } : { code: 'unreadable' } };
  }
  if (!E().profileApplies(profile, final, read.doc)) return { problem: { code: 'when' } };
  return { doc: read.doc, url: final, ...(read.stats ? { stats: read.stats } : {}) };
}

/**
 * What the leak check is given for a fetched response: for JSON, every scalar in it and every key that looks
 * like data (lib/json-dom.js jsonValues(), with detect() deciding which keys hold personal data). For HTML,
 * nothing more than the fields read, as before.
 */
export function responseValues(doc, profile, lib) {
  if (formatOf(profile) !== 'json') return [];
  return J().jsonValues(doc, { isPersonal: keyIsPersonal(lib) });
}

/** Does a JSON key hold personal data, by the library's privacy patterns (lib/privacy-detect.js detect())? */
export function keyIsPersonal(lib) {
  const patterns = patternsFor(lib);
  return (key) => detect(String(key), { patterns }).length > 0;
}

/** Each field's probe on a fetched response. JSON fields that land on an object or array fail. */
export function probeFields(doc, profile, url) {
  const probe = formatOf(profile) === 'json' ? J().probeJson : E().probe;
  return Object.fromEntries(Object.entries(profile.fields || {}).map(([k, spec]) => [k, probe(doc, spec, { baseUrl: url })]));
}

/**
 * Judge a draft on a fetched document, as the test on a page does: judgeTest() with every field's probe and,
 * for JSON, every value and data-like key in the response for the leak check. Kept in memory by the JSON
 * editor, so a sample fetched once is tested again after each change without another request.
 */
export function judgeDocument(draft, doc, { url, lib }) {
  return judgeTest(draft, probeFields(doc, draft.profile, url), { url, lib, pageValues: responseValues(doc, draft.profile, lib) });
}

/**
 * Test as fetched, for the flow editor: a response fetched exactly as a case would fetch it, judged per field
 * as the test on the page is. { ok, fields, test, doc, code?, text? }: test is judgeTest()'s verdict (no
 * values); doc is the response as a document, for the JSON tree view to keep in memory only. A JSON response
 * is checked for leaks against every value in it and every key that looks like data.
 */
export function judgeFetched(draft, res, { url, layers, lib, DOMParser }) {
  const profile = draft.profile;
  const bad = responseProblem(res, { url, profile, layers });
  const got = bad ? { problem: bad } : responseDocument(res, { url, profile, DOMParser });
  if (got.problem) return { ok: false, fields: {}, code: got.problem.code, text: failureText(got.problem.code, { name: profile.name, status: got.problem.status, reason: got.problem.reason, data: formatOf(profile) === 'json' }) };
  const t = judgeDocument(draft, got.doc, { url: got.url, lib });
  const repeated = !!got.stats?.duplicates?.length;
  return { ok: t.ok, fields: t.fields, test: t, doc: got.doc, url: got.url, ...(repeated ? { text: 'This response has a repeated key: check the profile' } : {}) };
}

// ------------------------------------------------------------------ into the case

const logPage = (profile, url) => ({ type: `${profile.id}@${profile.version}${profile.draft ? '+draft' : ''}`, pattern: profile.urlPattern, url });

/**
 * Add a fetched page to the case, as clipping that page would: the same source (so fetching again, or
 * clipping it by hand, replaces it), kind 'fetch' with the step and request it came from, and addClip()'s
 * identity check unchanged. Logged without values: the profile's pattern, and the live address for the
 * open case only. Returns addClip()'s summary.
 */
export function applyFetched(c, lib, { step, request, profile, read }) {
  const clip = clipFromExtract(lib, profile, read, { kind: 'fetch', via: { stepId: step.id, requestId: request.id }, quotes: read.quotes });
  // A quote is kept only for a value the clip holds. JSON is marked for display only: nothing reads it.
  if (clip.quotes) clip.quotes = Object.fromEntries(Object.entries(clip.quotes).filter(([k]) => k in clip.values));
  if (read.format === 'json') clip.format = 'json';
  // What was read, around each value, to look back at in the fetched view: case data, deleted with the case.
  const groups = new Set(clip.records.map((r) => r.group));
  const excerpts = Object.fromEntries(Object.entries(read.excerpts || {}).filter(([k]) => k in clip.values || groups.has(k)));
  if (Object.keys(excerpts).length) clip.excerpts = excerpts;
  const summary = addClip(c, lib, clip);
  const n = Object.keys(clip.values).length + clip.records.length;
  const what = `${read.format === 'json' ? 'json · ' : ''}${n} item${n === 1 ? '' : 's'}${read.repeated ? ' · duplicate key' : ''}`;
  logEvent(c, 'fetch_page', { page: logPage(profile, read.url), detail: `${step.name} · ${request.name} · ${what}`, clip: summary.clipId });
  return summary;
}

/** A request that was sent and failed: logged with the kind of failure, never the address, a key or a value. */
export function logFetchFailure(c, { step, request, profile, code, status, reason }) {
  logEvent(c, 'fetch_page', { page: profile ? logPage(profile) : {}, detail: `${step.name} · ${request.name} · ${profile && formatOf(profile) === 'json' ? 'json · ' : ''}${logCode(code, status, reason)}` });
}

// ------------------------------------------------------------------ the run

const abortError = (signal) => Object.assign(new Error('Stopped'), { name: 'AbortError', reason: signal.reason });
const untilAbort = (promise, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(abortError(signal)); return; }
  const stop = () => reject(abortError(signal));
  signal.addEventListener('abort', stop, { once: true });
  promise.then((v) => { signal.removeEventListener('abort', stop); resolve(v); }, (e) => { signal.removeEventListener('abort', stop); reject(e); });
});

/**
 * Run a fetch step. Arguments:
 *   step, lib, c        the step, the case's library and the case as it is when the button is pressed
 *   tabUrl              the trigger tab's address now; every request is made from it
 *   access()            the site rules now (lib/core.js currentAccess({ withHosts: true })), read again before each request
 *   fetchPage(url, o)   sends one request from the tab: o = { signal, accept, timeoutMs, maxBytes, atUrl }
 *   update(fn)          commits fn(case, lib) to the case; throws CaseEnded once the case has ended
 *   signal              Stop and teardown abort it
 *   onProgress(states)  { [requestId]: { state: 'waiting' | 'fetching' | 'done' | 'failed', code?, text?, summary? } }
 *   onShow(event)       for the box drawn on the page: { op: 'open' | 'read' | 'fail', item, view?, summary?, text? }
 *                       (view: lib/fetch-view.js textView()); called as things happen, never waited for
 *   DOMParser           to parse a response
 * Resolves with { problem, states, added, conflicts, identity: [clipId], stopped, ended }. Nothing is
 * retried: Try again is a new run.
 */
export async function runFetchStep({ step, lib, c, tabUrl, access, fetchPage, update, signal, onProgress = () => {}, onShow = () => {}, DOMParser, now = Date.now(), lists = {}, rest = false }) {
  const layers = await access();
  const plan = planRun({ step, lib, c, layers, tabUrl, now, lists, rest });
  const states = Object.fromEntries(plan.items.map((i) => [i.key, { state: 'waiting' }]));
  const report = () => onProgress(structuredClone(states));
  const listRequests = (step.fetch?.requests || []).filter(isListRequest).slice(0, 1);
  // For each list: how many addresses it gave, and the noun the card counts them in.
  const listInfo = Object.fromEntries(listRequests.map((r) => [r.id, { total: plan.items.filter((i) => i.request.id === r.id && i.url).length, read: lists[r.id] != null }]));
  const out = { problem: plan.problem, states, added: 0, conflicts: 0, identity: [], stopped: false, ended: false, lists: listInfo, rest };
  if (plan.problem) return out;
  const wasDone = stepStatus(c, step) === 'done';
  const fail = (key, code, extra = {}) => {
    const item = plan.items.find((i) => i.key === key);
    states[key] = { state: 'failed', code, text: failureText(code, { name: item?.request.name, status: extra.status, reason: extra.reason, data: !!item?.profile && formatOf(item.profile) === 'json' }) };
    report();
  };
  // One run is at most runMs; Stop and teardown abort it at once.
  const run = new AbortController();
  const timer = setTimeout(() => run.abort('timeout'), FETCH_LIMITS.runMs);
  const stop = () => run.abort('stopped');
  if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true });
  // What the page shows while it runs (a box for each request): never waited for, and never the run's failure.
  const show = (event) => { try { onShow(event); } catch { /* drawing is optional */ } };
  let blockedLogged = false;
  const logBlockedOnce = async (rule) => {
    if (blockedLogged) return;
    blockedLogged = true;
    await update((cs) => { logBlocked(cs, { action: 'fetch-get', layer: rule?.layer }); }).catch(() => {});
  };
  for (const i of plan.items) {
    if (!i.problem) continue;
    fail(i.key, i.problem);
    if (i.problem === 'blocked' || i.problem === 'off') await logBlockedOnce(i.rule);
  }

  const one = async (item) => {
    const { request, profile, url, key } = item;
    if (run.signal.aborted) { fail(key, run.signal.reason === 'timeout' ? 'timeout' : 'stopped'); return; }
    // The rules are read again just before the request: a change since the button was pressed counts.
    const live = await access();
    const v = allowed(live, url, 'fetch-get');
    if (!v.ok) { const code = isBackgroundRule(v.rule) ? 'off' : 'blocked'; fail(key, code); await logBlockedOnce(v.rule); return; }
    states[key] = { state: 'fetching' };
    report();
    show({ op: 'open', item });
    let res;
    try {
      res = await untilAbort(Promise.resolve(fetchPage(url, { signal: run.signal, accept: FORMATS[formatOf(profile)].accept, timeoutMs: FETCH_LIMITS.timeoutMs, maxBytes: FETCH_LIMITS.maxBytes, atUrl: tabUrl })), run.signal);
    } catch {
      res = { error: run.signal.reason === 'timeout' ? 'timeout' : run.signal.aborted ? 'stopped' : 'network' };
    }
    const bad = responseProblem(res, { url, profile, layers: live }) || null;
    const read = bad ? null : readResponse(res, { url, profile, DOMParser });
    const problem = bad || read?.problem || (run.signal.aborted ? { code: 'stopped' } : null);
    // The response as text, with where each value is: for the box on the page and the clip's excerpts.
    let view = null;
    if (!problem && read.doc) {
      try { view = textView(read.doc, profile); read.excerpts = excerptsOf(view, Object.keys(read.data || {})); } catch { view = null; }
    }
    try {
      if (problem) {
        show({ op: 'fail', item, text: failureText(problem.code, { name: request.name, status: problem.status, reason: problem.reason, data: formatOf(profile) === 'json' }) });
        fail(key, problem.code, problem);
        if (problem.code === 'blocked' || problem.code === 'off') await logBlockedOnce(problem.rule);
        else await update((cs) => logFetchFailure(cs, { step, request, profile, code: problem.code, status: problem.status, reason: problem.reason }));
        return;
      }
      const summary = await update((cs, l) => applyFetched(cs, l, { step, request, profile, read }));
      states[key] = { state: 'done', summary, clipId: summary.clipId, ...(read.repeated ? { warning: 'This response has a repeated key: check the profile' } : {}) };
      out.added += summary.added.length;
      out.conflicts += summary.conflicts.length;
      if (summary.identity.length) out.identity.push(summary.clipId);
      report();
      show({ op: 'read', item, view, summary });
    } catch (e) {
      if (e?.name !== 'CaseEnded') throw e;
      // A late result after Finish or Discard is dropped, and so is the rest of the run.
      out.ended = true;
      fail(key, 'ended');
      run.abort('ended');
    }
  };

  try {
    const queue = plan.items.filter((i) => !i.problem);
    const workers = Array.from({ length: Math.min(FETCH_LIMITS.parallel, queue.length) }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) await one(item);
    });
    await Promise.all(workers);
    // A run with a list of links that finished (not stopped, not out of time): the clips an earlier run left
    // for addresses no longer in the list go, so a message that has dropped off the page isn't counted, and
    // the step is done, whatever it found.
    if (!out.ended && listRequests.length && !run.signal.aborted) {
      await update((cs, l) => {
        for (const r of listRequests) {
          if (!listInfo[r.id].read || rest) continue;
          const keep = new Set(plan.items.filter((i) => i.request.id === r.id && i.url).map((i) => i.url));
          for (const cl of listClips(cs, step, r)) if (!keep.has(cl.url)) removeClip(cs, l, cl.id);
        }
        // A list that couldn't be read leaves the step as it was: nothing was looked at.
        if (listRequests.every((r) => listInfo[r.id].read) && !cs.steps?.[step.id]?.done) markStep(cs, step.id, true);
      }).catch((e) => { if (e?.name === 'CaseEnded') out.ended = true; else throw e; });
    }
    if (!out.ended && !wasDone) {
      await update((cs) => { if (stepStatus(cs, step) === 'done') logEvent(cs, 'complete_step', { detail: step.name }); }).catch((e) => { if (e?.name === 'CaseEnded') out.ended = true; else throw e; });
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
  out.stopped = run.signal.aborted && run.signal.reason !== 'timeout';
  return out;
}

/**
 * What a finished run says, for the live region and the card: "Fetched 3 pages: 9 values added, 1 conflict.",
 * or for a list of links "Read 25 of 25 messages." (step gives the list's noun).
 */
export function runSummary(out, step = null) {
  const done = Object.values(out.states).filter((s) => s.state === 'done').length;
  const failed = Object.values(out.states).filter((s) => s.state === 'failed').length;
  const n = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
  if (out.ended) return 'The case ended, so the rest wasn’t fetched';
  const list = (step?.fetch?.requests || []).find(isListRequest);
  const total = list ? out.lists?.[list.id]?.total ?? 0 : 0;
  const head = list && !out.rest
    ? `Read ${done} of ${total} ${listNoun(list, total)}${out.added ? `: ${n(out.added, 'value')} added${out.conflicts ? `, ${n(out.conflicts, 'conflict')}` : ''}` : ''}`
    : `Fetched ${n(done, 'page')}${done ? `: ${n(out.added, 'value')} added${out.conflicts ? `, ${n(out.conflicts, 'conflict')}` : ''}` : ''}`;
  const tail = [failed ? `${n(failed, 'page')} couldn’t be fetched` : '', out.stopped ? 'stopped' : ''].filter(Boolean).join(', ');
  return `${head}${tail ? `. ${tail[0].toUpperCase()}${tail.slice(1)}` : ''}.${out.identity.length ? ' This may be a different person: check before anything else.' : ''}`;
}

// ------------------------------------------------------------------ in the trigger tab

/**
 * Fetch one page as the trigger tab, run there by lib/core.js fetchFromTab() with scripting.executeScript. It
 * is passed to executeScript as a function, so it must use nothing outside itself. It refuses when the tab
 * has moved on since the check (atUrl) or the address is another site, never follows a redirect, reads at
 * most maxBytes and returns the bytes, never a parsed page: the response is read in the extension.
 */
export async function fetchInPage({ url, atUrl, accept, timeoutMs, maxBytes, id }) {
  if (location.href !== atUrl) return { error: 'moved' };
  let target;
  try { target = new URL(url); } catch { return { error: 'origin' }; }
  if (target.origin !== location.origin) return { error: 'origin' };
  const ctl = new AbortController();
  const runs = globalThis.__powerLoaderFetches || (globalThis.__powerLoaderFetches = new Map());
  runs.set(id, ctl);
  const timer = setTimeout(() => ctl.abort('timeout'), timeoutMs);
  try {
    const res = await fetch(target.href, { method: 'GET', credentials: 'same-origin', redirect: 'manual', cache: 'no-store', headers: { Accept: accept }, signal: ctl.signal });
    const head = { status: res.status, type: res.type, redirected: res.redirected, url: res.url, contentType: res.headers.get('content-type') || '' };
    // An error page or a redirect is never read.
    if (res.type === 'opaqueredirect' || res.status < 200 || res.status > 299) return head;
    if (Number(res.headers.get('content-length')) > maxBytes) { ctl.abort('size'); return { ...head, tooLarge: true }; }
    const reader = res.body.getReader();
    const parts = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > maxBytes) { ctl.abort('size'); return { ...head, tooLarge: true }; }
      parts.push(value);
    }
    const bytes = new Uint8Array(n);
    let at = 0;
    for (const p of parts) { bytes.set(p, at); at += p.length; }
    return { ...head, bytes };
  } catch {
    return { error: ctl.signal.aborted ? (ctl.signal.reason === 'timeout' ? 'timeout' : 'stopped') : 'network' };
  } finally {
    clearTimeout(timer);
    runs.delete(id);
  }
}

/** Stop a request fetchInPage() is making in the tab. Also passed to executeScript as it is. */
export function abortInPage(id) {
  globalThis.__powerLoaderFetches?.get(id)?.abort('stopped');
}

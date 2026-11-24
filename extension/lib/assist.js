// Making a profile on this computer: match what a page shows to the target form's fields. Pure functions,
// no browser APIs. The rules (labels, names, types, the privacy categories and the library's validators)
// always run; the optional on-device model only re-labels candidates, and its answers are checked against
// the same rules. Neither ever writes a selector: those come from the in-page agent.
//
// Candidate (page value):  { id, selector, value, label, section, path, tag, type, name, options, repeat, category }
// Target field:            { key, label, type, accepts, options, section, aliases, required }
// Match:                   { key, id, selector, score, by: 'label' | 'type' | 'model' | 'derived', part?, filter?, check }
import { validateValue } from './fields.js';

// Words people commonly use for the usual case fields, beyond the library's own label. A library field can
// add its own with "aliases": ["Forename", ...].
const BUILTIN = {
  firstName: ['first name', 'forename', 'forenames', 'given name', 'first names'],
  lastName: ['last name', 'surname', 'family name'],
  dob: ['date of birth', 'dob', 'd o b', 'birth date', 'born'],
  nino: ['ni number', 'ni no', 'national insurance', 'national insurance number', 'nino'],
  clientId: ['client id', 'client ref', 'client reference', 'client number', 'person id'],
  phone: ['telephone', 'phone', 'tel', 'mobile', 'phone number', 'contact number'],
  email: ['email', 'e mail', 'email address'],
  address: ['address', 'home address', 'current address', 'address line', 'property', 'property address'],
  postcode: ['postcode', 'post code', 'postal code'],
  title: ['title', 'salutation'],
};
const STOP = new Set(['the', 'of', 'a', 'an', 'your', 'their', 'is', 'and', 'or', 'to', 'for', 'in', 'on', 'what', 'why', 'how']);
// Categories that say what a value is so clearly that a field that doesn't accept them is unlikely.
const STRONG = new Set(['nino', 'postcode', 'email', 'phone', 'date_of_birth']);
const TYPED = new Set(['date', 'money', 'number', 'nino', 'postcode', 'phone', 'email']);
export const MIN_SCORE = 0.45;
const CONFIDENT = 0.9;

export const words = (s) => String(s ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const tokens = (s) => words(s).split(' ').filter((w) => w && !STOP.has(w));

function phrasesOf(field) {
  return [...new Set([field.label, words(field.key), ...(field.aliases || []), ...(BUILTIN[field.key] || [])].map(words).filter(Boolean))];
}

// How well a label reads as one of a field's names: 1 for the same words, less for containment or overlap.
export function labelScore(label, phrases) {
  const l = words(label);
  if (!l) return 0;
  const lt = tokens(l);
  let best = 0;
  for (const p of phrases) {
    if (l === p) return 1;
    const pt = tokens(p);
    if (!pt.length || !lt.length) continue;
    const has = (a, b) => ` ${a} `.includes(` ${b} `);
    // "Date of birth (DOB)" holds a field's whole name; "Date" is only part of "Date of birth".
    if (p.length >= 3 && has(l, p)) { best = Math.max(best, 0.8); continue; }
    if (l.length >= 3 && has(p, l)) { best = Math.max(best, 0.4 + (0.4 * lt.length) / pt.length); continue; }
    const shared = pt.filter((w) => lt.includes(w)).length;
    if (shared) best = Math.max(best, (0.7 * shared) / new Set([...pt, ...lt]).size);
  }
  return best;
}

// The library field type a fill box's input type points at.
const INPUT_TYPES = { date: 'date', email: 'email', tel: 'phone', number: 'number' };

/** Score one candidate for one field, with the reason: higher is better; below MIN_SCORE isn't a match. */
export function scorePair(c, f) {
  const phrases = phrasesOf(f);
  const byLabel = Math.max(labelScore(c.label, phrases), c.name ? 0.8 * labelScore(c.name, phrases) : 0);
  let score = byLabel;
  const accepts = f.accepts || [];
  if (c.category) {
    if (accepts.includes(c.category)) score += 0.35;
    else if (STRONG.has(c.category) && f.type !== 'long' && !f.long) score -= 0.3;
  }
  const isBox = c.tag === 'input' || c.tag === 'select' || c.tag === 'textarea';
  if (isBox && !c.value) {
    // An empty form box: its input type and options are the only evidence besides its label.
    const t = INPUT_TYPES[c.type];
    if (t && f.type) score += t === f.type ? 0.3 : -0.2;
    if (c.options?.length && f.options?.length) {
      const o = c.options.map(words);
      if (f.options.some((x) => o.includes(words(x)))) score += 0.2;
    }
  } else if (TYPED.has(f.type)) {
    score += validateValue(f, c.value).ok ? 0.15 : -0.5;
  }
  if (c.section && f.section && labelScore(c.section, [words(f.section)]) > 0.3) score += 0.05;
  // Without a label, only a category that says exactly what the value is (an NI number, an email) is enough:
  // a date or an amount alone could be any of several fields.
  if (byLabel < 0.3 && !(STRONG.has(c.category) && accepts.includes(c.category)) && !(isBox && !c.value && INPUT_TYPES[c.type] === f.type && f.type !== 'date')) score = Math.min(score, MIN_SCORE - 0.05);
  // A value in a repeating row (a household member's date of birth, a payment's date) is rarely the record's own.
  if (c.repeat) score -= 0.7;
  return { score: Math.round(score * 100) / 100, by: byLabel >= 0.5 ? 'label' : 'type' };
}

// The filter a field's type needs, added by rule rather than by the model.
export function filterFor(f, c) {
  if (f.type === 'date') return 'date';
  if (f.type === 'money') return 'number';
  if ((f.accepts || []).includes('address') && f.key !== 'postcode' && /\n/.test(c?.value || '')) return 'oneline';
  return '';
}

// Labels under which a full name is the record's person.
const PERSON_LABELS = ['name', 'full name', 'client name', 'client', 'tenant', 'tenant name', 'claimant', 'applicant', 'customer', 'resident', 'person'];
const POSTCODE = /[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}/;

/**
 * Match page values to target fields, one value per field and one field per value, best pairs first.
 * Then two derived matches the rules can be sure of: a postcode at the end of a matched address, and
 * first and last name from one full-name value. Returns { matches, unmatched: [key] }.
 */
export function matchFields(candidates, fields, { min = MIN_SCORE } = {}) {
  const pairs = [];
  for (const c of candidates) for (const f of fields) {
    const s = scorePair(c, f);
    if (s.score >= min) pairs.push({ c, f, ...s });
  }
  pairs.sort((a, b) => b.score - a.score || (a.c.repeat ? 1 : 0) - (b.c.repeat ? 1 : 0));
  const taken = new Set();
  const used = new Set();
  const matches = [];
  for (const p of pairs) {
    if (taken.has(p.f.key) || used.has(p.c.id)) continue;
    taken.add(p.f.key);
    used.add(p.c.id);
    matches.push({ key: p.f.key, id: p.c.id, selector: p.c.selector, score: p.score, by: p.by, filter: filterFor(p.f, p.c), part: 'all', check: p.score < CONFIDENT });
  }
  const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
  const address = matches.find((m) => (byKey[m.key].accepts || []).includes('address') && m.key !== 'postcode');
  const addrCand = address && candidates.find((c) => c.id === address.id);
  if (byKey.postcode && !taken.has('postcode') && addrCand && POSTCODE.test(addrCand.value || '')) {
    taken.add('postcode');
    matches.push({ key: 'postcode', id: addrCand.id, selector: addrCand.selector, score: 0.7, by: 'derived', part: 'postcode', filter: '', check: true });
  }
  if (byKey.firstName && byKey.lastName && !taken.has('firstName') && !taken.has('lastName')) {
    // A full name: the privacy model calls it a person, or a person's label is on two to four capitalised words.
    const nameLike = (v) => /^\p{Lu}[\p{L}'’-]+(\s+\p{Lu}[\p{L}'’-]+){1,3}$/u.test(String(v || '').trim());
    const full = candidates.find((c) => !c.repeat && !used.has(c.id) && nameLike(c.value)
      && ((c.category === 'person_name' && (!c.label || labelScore(c.label, PERSON_LABELS) >= 0.5)) || labelScore(c.label, PERSON_LABELS) >= 0.75));
    if (full) {
      for (const [key, part] of [['firstName', 'first'], ['lastName', 'last']]) {
        taken.add(key);
        matches.push({ key, id: full.id, selector: full.selector, score: 0.6, by: 'derived', part, filter: '', check: true });
      }
    }
  }
  return { matches, unmatched: fields.map((f) => f.key).filter((k) => !taken.has(k)) };
}

/** The fields a set of target forms needs, in form order, each once. Manual fields are left out for gathering. */
export function targetFields(lib, formIds, { manual = false } = {}) {
  const seen = new Set();
  const out = [];
  for (const id of formIds) {
    for (const f of lib.forms[id]?.fields || []) {
      const def = lib.fields[f.key];
      if (!def || seen.has(f.key) || (def.manual && !manual)) continue;
      seen.add(f.key);
      out.push({ key: f.key, ...def, required: !!f.required });
    }
  }
  return out;
}

/** A form's boxes as candidates (from the agent's describeForm). */
export function boxCandidates(form) {
  const controls = [...(form?.controls || []), ...(form?.groups || []).flatMap((g) => g.controls.map((c) => ({ ...c, repeat: true })))];
  return controls.map((c, i) => ({
    id: `b${i}`, selector: c.selector, label: c.label, tag: c.tag, type: c.type, options: c.options, section: c.section,
    name: [c.selector.match(/^#([\w-]+)$/)?.[1], c.name].filter(Boolean).join(' ').replace(/^[a-z]-/, '') || null,
    value: '', repeat: !!c.repeat,
  }));
}

/**
 * Each candidate's privacy category, from findings over the joined values (detect() in privacy-detect.js):
 * the category of the finding that covers most of the value, if it covers at least 60% of it.
 */
export function joinValues(candidates) {
  let text = '';
  const at = [];
  for (const c of candidates) {
    at.push([text.length, text.length + (c.value || '').length]);
    text += `${c.value || ''}\n`;
  }
  return { text, at };
}

export function categorise(candidates, findings, at) {
  return candidates.map((c, i) => {
    const [s, e] = at[i];
    const len = e - s;
    if (!len) return c;
    let best = null;
    for (const f of findings) {
      const cover = Math.min(e, f.end) - Math.max(s, f.start);
      if (cover > 0 && cover / len >= 0.6 && (!best || cover > best.cover || (cover === best.cover && f.score > best.f.score))) best = { f, cover };
    }
    return best ? { ...c, category: best.f.category } : c;
  });
}

// ------------------------------------------------------------------ the on-device model

// What the model sees: one value at a time, with its label, and the target fields by name. Small models
// (well under a billion parameters) lose track of a numbered batch and copy the example back; asked about one
// value, with the answer being a field name, they do far better (see tests/tools/assist-eval.mjs). Values stay
// on this computer, so they're included, cut short. suffix: what the model's chat format needs, such as
// Qwen3's " /no_think".
export function buildItemPrompt(c, fields, { suffix = '' } = {}) {
  const shows = `${c.label ? `"${String(c.label).slice(0, 40)}": ` : ''}"${String(c.value || '').replace(/\s+/g, ' ').slice(0, 40)}"`;
  return [{
    role: 'user',
    content: `A web page shows: ${shows}${c.section ? ` under "${String(c.section).slice(0, 30)}"` : ''}.\nWhich of these form fields does it fill? ${fields.map((f) => f.label).join('; ')}; none.\nAnswer with the field name only.${suffix}`,
  }];
}

/** The field the model named, read back by the same label scoring as the rules; null for none or anything else. */
export function readItemAnswer(text, fields) {
  const out = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim().split('\n')[0].replace(/^["'`*\s]+|["'`*.\s]+$/g, '');
  if (!out || /^none\b/i.test(out)) return null;
  const best = fields.map((f) => ({ f, s: labelScore(out, [words(f.label), words(f.key)]) })).sort((a, b) => b.s - a.s)[0];
  return best && best.s >= 0.65 ? best.f.key : null;
}

/**
 * Merge the model's labels into the rules' matches. The model can confirm a match, or fill a field the rules
 * left empty with a candidate the rules didn't use, unless the rules say it can't be (a value that fails the
 * field's validator, a strong category the field doesn't accept). It never overrides a confident rule match.
 * Returns { matches, changed: number, agreed: number }.
 */
export function mergeModel(rule, answer, candidates, fields) {
  const byId = Object.fromEntries(candidates.map((c) => [c.id, c]));
  const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
  const matches = rule.matches.map((m) => ({ ...m }));
  let changed = 0;
  let agreed = 0;
  for (const [id, key] of Object.entries(answer)) {
    const c = byId[id];
    const f = byKey[key];
    if (!c || !f) continue;
    const same = matches.find((m) => m.key === key && m.id === id);
    if (same) { agreed++; same.check = false; same.by = same.by === 'derived' ? 'derived' : 'model'; continue; }
    const s = scorePair(c, f).score;
    if (s < 0) continue; // the rules rule it out: a value that fails the field's validator, or the wrong kind
    const holder = matches.findIndex((m) => m.key === key);
    if (holder >= 0 && (!matches[holder].check || matches[holder].score >= s + 0.2)) continue;
    if (matches.some((m) => m.id === id && m.by !== 'derived')) continue; // already the confident home of another field
    if (holder >= 0) matches.splice(holder, 1);
    matches.push({ key, id, selector: c.selector, score: Math.max(s, MIN_SCORE), by: 'model', filter: filterFor(f, c), part: 'all', check: true });
    changed++;
  }
  return { matches, changed, agreed };
}

// Which candidates to ask the model about: labelled or categorised, not in repeating rows, best first, capped.
export function forModel(candidates, fields, max = 40) {
  return candidates
    .filter((c) => !c.repeat && (c.label || c.category))
    .map((c) => ({ c, best: Math.max(0, ...fields.map((f) => scorePair(c, f).score)) }))
    .sort((a, b) => b.best - a.best)
    .slice(0, max)
    .map((x) => x.c);
}


// Case fields: types, validation and comparison. The library defines each field once
// (fields.json) and forms list which fields they need. Pure functions, no browser APIs.

const X = () => globalThis.PowerLoaderExtract;

export const TYPES = ['text', 'longtext', 'date', 'money', 'number', 'nino', 'postcode', 'phone', 'email', 'choice', 'boolean'];

// Identity fields decide "this may be a different person". A library field can opt in with identity: true.
export const DEFAULT_IDENTITY = ['firstName', 'lastName', 'dob', 'nino', 'clientId'];

// Shape only: the allocation rules would reject QQ, the prefix HMRC reserves for examples and tests.
const NINO = /^[A-Z]{2}\d{6}[A-D]$/;
const POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const squash = (v) => String(v).trim().replace(/\s+/g, ' ');

export function typeOf(def) {
  return def && TYPES.includes(def.type) ? def.type : def && def.options ? 'choice' : 'text';
}

function isoDate(v) {
  const s = squash(v);
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : X().parseDate(s);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? iso : null;
}

function money(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v.toFixed(2) : null;
  const s = squash(v).replace(/^£\s*/, '').replace(/,/g, '');
  return /^-?\d+(\.\d{1,2})?$/.test(s) ? Number(s).toFixed(2) : null;
}

/**
 * Check a value against its field definition. Returns { ok, value, error }: value is the
 * normalised form (ISO dates, money with two decimals, matched option), or the input when invalid.
 */
export function validateValue(def, raw) {
  if (raw === null || raw === undefined || squash(raw) === '') return { ok: false, value: null, error: 'Empty' };
  const type = typeOf(def);
  const s = squash(raw);
  const bad = (error) => ({ ok: false, value: s, error });
  switch (type) {
    case 'date': {
      const iso = isoDate(s);
      return iso ? { ok: true, value: iso } : bad('Not a date');
    }
    case 'money': {
      const m = money(raw);
      return m === null ? bad('Not an amount of money') : { ok: true, value: m };
    }
    case 'number':
      return /^-?\d+(\.\d+)?$/.test(s.replace(/,/g, '')) ? { ok: true, value: s.replace(/,/g, '') } : bad('Not a number');
    case 'nino': {
      const n = s.replace(/\s+/g, '').toUpperCase();
      return NINO.test(n) ? { ok: true, value: s.toUpperCase() } : bad('Not a National Insurance number');
    }
    case 'postcode': {
      const p = s.replace(/\s+/g, '').toUpperCase();
      return POSTCODE.test(p) ? { ok: true, value: `${p.slice(0, -3)} ${p.slice(-3)}` } : bad('Not a UK postcode');
    }
    case 'phone': {
      const digits = s.replace(/[\s()-]/g, '').replace(/^\+44/, '0');
      return /^0\d{9,10}$/.test(digits) ? { ok: true, value: s } : bad('Not a UK phone number');
    }
    case 'email':
      return EMAIL.test(s) ? { ok: true, value: s } : bad('Not an email address');
    case 'boolean':
      if (/^(yes|true|y)$/i.test(s)) return { ok: true, value: 'Yes' };
      if (/^(no|false|n)$/i.test(s)) return { ok: true, value: 'No' };
      return bad('Not yes or no');
    case 'choice': {
      const hit = (def.options || []).find((o) => o.toLowerCase() === s.toLowerCase());
      return hit ? { ok: true, value: hit } : bad(`Choose one of: ${(def.options || []).join(', ')}`);
    }
    default:
      return { ok: true, value: typeof raw === 'string' ? raw.trim() : s };
  }
}

// The comparison key for agreement and conflicts: case, spacing and formatting don't count.
export function norm(def, v) {
  if (v === null || v === undefined) return '';
  const type = typeOf(def);
  const checked = validateValue(def, v);
  if (checked.ok && ['date', 'money', 'boolean', 'choice'].includes(type)) return String(checked.value).toLowerCase();
  let s = squash(v).toLowerCase();
  if (['nino', 'postcode', 'phone'].includes(type) || def?.ns) s = s.replace(/\s+/g, '');
  return s;
}

export function display(def, v) {
  if (v === null || v === undefined || v === '') return '';
  const type = typeOf(def);
  if (type === 'date') {
    const iso = isoDate(v);
    if (!iso) return String(v);
    const [y, m, d] = iso.split('-').map(Number);
    return `${d} ${MON[m - 1]} ${y}`;
  }
  if (type === 'money') {
    const m = money(v);
    return m === null ? String(v) : `£${Number(m).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return String(v);
}

/**
 * Library cross-field rules. Each rule: { field, before | after: field key or "today", message }.
 * values: { key: normalised value } for settled, valid fields. A rule with a missing side is skipped.
 * Returns [{ field, keys, message }].
 */
export function checkRules(rules, values, today) {
  const out = [];
  for (const r of rules || []) {
    const a = values[r.field];
    const otherKey = r.before ?? r.after;
    const b = otherKey === 'today' ? today : values[otherKey];
    if (!a || !b) continue;
    const ok = r.before !== undefined ? a < b : a > b;
    if (!ok) out.push({ field: r.field, keys: [r.field, otherKey].filter((k) => k !== 'today'), message: r.message || `${r.field} must be ${r.before !== undefined ? 'before' : 'after'} ${otherKey}` });
  }
  return out;
}

export function validateFieldDefs(fields) {
  const errors = [];
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return ['"fields" must be an object of field definitions'];
  for (const [key, def] of Object.entries(fields)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) errors.push(`fields.${key}: key must be an identifier`);
    if (!def || typeof def !== 'object') { errors.push(`fields.${key} must be an object`); continue; }
    if (typeof def.label !== 'string' || !def.label.trim()) errors.push(`fields.${key}.label must be a non-empty string`);
    if (def.type !== undefined && !TYPES.includes(def.type)) errors.push(`fields.${key}: unknown type "${def.type}"`);
    if (def.options !== undefined && !(Array.isArray(def.options) && def.options.every((o) => typeof o === 'string'))) errors.push(`fields.${key}.options must be a list of strings`);
    if (def.accepts !== undefined && !(Array.isArray(def.accepts) && def.accepts.every((o) => typeof o === 'string'))) errors.push(`fields.${key}.accepts must be a list of placeholder categories`);
  }
  return errors;
}

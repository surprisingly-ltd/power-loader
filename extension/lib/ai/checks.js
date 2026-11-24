// Checks on what the AI proposes: safe JSON, a valid profile, and review of what it reads.
import '../extract.js';
const E = globalThis.PowerLoaderExtract;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const problem = (level, path, message) => ({ level, path, message, count: 1 });
export const score = (problems) => problems.reduce((s, p) => s + ({ error: 10, warning: 1 }[p.level] || 0), 0);

export function assertSafeData(value, depth = 0) {
  if (depth > 40) throw new Error('Profile nesting is too deep');
  if (!value || typeof value !== 'object') return;
  for (const [key, sub] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Reserved object key in profile');
    if (key === 'key' && ['__proto__', 'prototype', 'constructor'].includes(sub)) throw new Error('Reserved template field key');
    assertSafeData(sub, depth + 1);
  }
}

export function validate(profile) {
  assertSafeData(profile);
  const errors = E.validateProfile(profile);
  if (errors.length) throw new Error(errors.join('; '));
  return profile;
}

export function review(data, diagnostics) {
  const dedup = new Map();
  for (const d of diagnostics) {
    const path = d.path.replace(/\[\d+\]/g, '[*]');
    const key = `${path}\n${d.message}`;
    if (dedup.has(key)) dedup.get(key).count++;
    else dedup.set(key, { ...d, path, count: 1, level: d.message.startsWith('Matched an element') ? 'info' : d.level });
  }
  function walk(v, path) {
    if (Array.isArray(v)) v.slice(0, 20).forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (isObject(v)) Object.entries(v).forEach(([k, x]) => walk(x, path ? `${path}.${k}` : k));
    else if (typeof v === 'string' && v.length > 600 && !/note|description|summary|text|body/i.test(path)) {
      const generic = path.replace(/\[\d+\]/g, '[*]');
      dedup.set(`${generic}\nlong`, problem('warning', generic, `Value is ${v.length} characters: the selector probably matches a container, not the field`));
    }
  }
  walk(data, '');
  return [...dedup.values()];
}

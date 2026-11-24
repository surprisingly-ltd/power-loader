// Hashing and canonical JSON, shared by library sync and draft export.

export async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// JSON with object keys sorted at every level, so formatting and key order never change a hash.
export function canonical(value) {
  const sort = (v) => (Array.isArray(v) ? v.map(sort)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v);
  return JSON.stringify(sort(value));
}

// A profile file's content hash: the file without its "exported" block.
export function contentHash(doc) {
  const { exported, path, ...body } = doc || {}; // eslint-disable-line no-unused-vars
  return sha256Hex(canonical(body));
}

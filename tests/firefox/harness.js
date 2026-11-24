/* global browser */
export const config = await (await fetch(browser.runtime.getURL('tests/config.json'))).json();
export const results = [];
export function assert(ok, message) { if (!ok) throw new Error(message); }
export function equal(actual, expected, message) {
  if (actual === expected) return;
  if (actual instanceof Node || expected instanceof Node) throw new Error(`${message}: DOM nodes differ`);
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
export async function rejects(fn, pattern) {
  try { await fn(); } catch (error) {
    assert(pattern.test(`${error.name} ${error.reason || ''} ${error.message}`), `Unexpected rejection: ${error.message}`);
    return error;
  }
  throw new Error(`Expected rejection matching ${pattern}`);
}
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(fn, label, timeout = 15000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    const value = await fn();
    if (value) return value;
    await pause(40);
  }
  throw new Error(`Timed out: ${label}`);
}
export async function test(name, fn) {
  const start = performance.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Math.round(performance.now() - start) });
  } catch (error) {
    results.push({ name, ok: false, error: error.message, stack: error.stack });
  }
  await fetch(`${config.base}/progress`, { method: 'POST', body: JSON.stringify(results.at(-1)) });
}
export const state = () => browser.storage.local.get(null);
export const query = (key) => document.querySelector(`[data-key="${key}"]`);
export const button = (text, scope = document) => [...scope.querySelectorAll('button')].find((el) => typeof text === 'string' ? el.textContent === text : text.test(el.textContent));
export async function click(key) { (await until(() => query(key), `control ${key}`)).click(); }
export async function go(page) {
  const url = `${config.base}/demo/${page}`;
  const existing = (await browser.tabs.query({})).find((tab) => tab.url?.startsWith(`${config.base}/demo/`));
  if (existing?.url === url && existing.status === 'complete') return existing;
  const tab = existing ? await browser.tabs.update(existing.id, { url, active: true }) : await browser.tabs.create({ url, active: true });
  await until(async () => {
    const current = await browser.tabs.get(tab.id);
    return current.status === 'complete' && current.url === url;
  }, `load ${page}`);
  return tab;
}
export async function pageValue(tab, selector) {
  const [result] = await browser.scripting.executeScript({
    target: { tabId: tab.id }, args: [selector],
    func: (sel) => document.querySelector(sel)?.value,
  });
  return result.result;
}
export const control = (changes) => fetch(`${config.base}/control`, { method: 'POST', body: JSON.stringify(changes) });
export const journal = () => fetch(`${config.base}/journal`).then((res) => res.json());

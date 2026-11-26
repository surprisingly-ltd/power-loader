// Conflicts you can see and follow, reveal rules, and fetches you can watch and review
// (docs/plans/conflicts-and-fetch-views.md), in real Firefox, on pages served with a strict CSP (default-src 'self'):
// everything Power Loader draws there is in its closed shadow root, styled as properties.
import { test, assert, equal, until, state, query, click, button, go } from './harness.js';
import { ask, getCase } from '../../lib/core.js';
import { endCase } from '../../lib/teardown.js';

const DHP = 'start-flow-f-lib-discretionary-housing-payment';
const REVIEW = 'start-flow-f-lib-rent-support-review';
const inPage = async (tab, func, args = []) => (await browser.scripting.executeScript({ target: { tabId: tab.id }, func, args }))[0].result;
const host = (tab) => inPage(tab, () => { const el = document.querySelector('[data-powerloader="values"]'); return el ? { ...el.dataset } : null; });
const finish = async () => {
  (await until(() => button('Finish case'), 'finish')).click();
  const fin = await until(() => document.querySelector('[role=dialog]'), 'finish dialog');
  fin.querySelector('input[type=checkbox]').click();
  button('Finish and delete data', document.querySelector('[role=dialog]')).click();
  await until(async () => (await state()).case === null, 'case finished');
};
// Each journey starts in Casework with no case open, whatever an earlier one left behind.
const fresh = async () => {
  const open = (await state()).case;
  if (open) await endCase(open.id, 'discarded');
  await until(async () => !(await state()).case && !(await state()).teardown, 'no case open');
  if (query('mode-casework')?.getAttribute('aria-pressed') === 'false') query('mode-casework').click();
  await until(() => document.querySelector('.sb-head.mode-casework'), 'Casework');
};
const start = async (key) => {
  await fresh();
  await go('index.html');
  [...document.querySelectorAll('[role=tab]')].find((t) => t.textContent.startsWith('Case'))?.click();
  await click(key);
  const dlg = await until(() => document.querySelector('[role=dialog]') || null, 'start confirmation', 3000).catch(() => null);
  if (dlg) button('Start case', dlg).click();
  await until(async () => (await state()).case, 'case started');
};

export async function conflicts() {
  await test('A conflict is orange in the step and on the page, and its card follows it back to the page', async () => {
    await go('index.html');
    await start(DHP);
    for (const page of ['client-1042.html?csp=strict', 'rent-account-1042.html?csp=strict', 'employment-1042.html?csp=strict']) {
      await go(page);
      (await until(() => button('Clip this page'), `clip on ${page}`)).click();
      await until(async () => (await getCase())?.clips.some((c) => c.url.endsWith(page)), `clipped ${page}`);
    }
    const tab = await go('employment-1042.html?csp=strict');
    // The step's line names the conflict, and the name brings its card into view, focused.
    const line = await until(() => query('clip-tally'), 'the clip’s line');
    assert(/⚠ 1 conflict: Last name/.test(line.textContent.replace(/\s+/g, ' ')), `line: ${line.textContent}`);
    query('clip-tally-cf-lastName').click();
    await until(() => document.activeElement?.id === 'cf-card-lastName', 'the card has focus');
    // On the page, under the strict CSP: the value is marked in conflict.
    await until(async () => (await host(tab))?.state === 'done', 'outlined, done');
    // The card's first source is the client record: it opens in this tab and the value is held there.
    const c = await getCase();
    const first = c.clips.find((x) => x.url.includes('client-1042'));
    query(`cf-lastName-src-${first.id}`).click();
    await until(async () => (await browser.tabs.get(tab.id)).url === first.url, 'the client record opened in the case’s tab');
    await until(async () => (await host(tab))?.held === 'lastName', 'the value is held on its page');
    equal(query('follow-not-here'), null, 'the value is on its page');
    // Decided: the line says which way, and the page lets go of the conflict.
    button('Use this', document.getElementById('conflicts')).click();
    await until(async () => (await getCase()).resolved.lastName, 'decided');
    await until(() => /1 used|1 overridden/.test(query('clip-tally')?.textContent || ''), 'the line after deciding');
    await finish();
  });

  await test('A value in a closed accordion is opened by its template’s rule, with no click, and closed again', async () => {
    const tab = await go('harbour/tenancy-HH-44191.html?csp=strict');
    await inPage(tab, () => { window.__clicks = 0; document.addEventListener('click', () => { window.__clicks++; }, true); });
    const fields = { arrears: '#tenancy label(Arrears) | number' };
    const closedFirst = await ask(tab.id, { type: 'powerloader:showValues', fields, state: 'pending' });
    const why = await inPage(tab, () => { const el = document.querySelector('#balance .bal'); const r = el?.getBoundingClientRect(); return { found: !!el, open: document.getElementById('balance')?.className, w: r?.width, h: r?.height, d: el && getComputedStyle(el.parentElement.parentElement).display, url: location.href }; });
    equal(closedFirst.closed, { arrears: 'Rent account balance' }, `without a rule, named by its part (${JSON.stringify({ ...closedFirst, why })})`);
    await ask(tab.id, { type: 'powerloader:clearValues' });
    const res = await ask(tab.id, { type: 'powerloader:showValues', fields, state: 'pending', reveal: [{ selector: '#balance', addClass: ['accordion--open'] }] });
    equal(res.closed, undefined, 'in view');
    const opened = await inPage(tab, () => ({ open: document.getElementById('balance').classList.contains('accordion--open'), clicks: window.__clicks, h: document.querySelector('#balance .bal').getBoundingClientRect().height }));
    assert(opened.open && opened.h > 0, `opened: ${JSON.stringify(opened)}`);
    equal(opened.clicks, 0, 'nothing clicked');
    await ask(tab.id, { type: 'powerloader:clearValues' });
    equal(await inPage(tab, () => document.getElementById('balance').classList.contains('accordion--open')), false, 'put back');
  });

  await test('A fetch step draws a box for each request on its page, and what it read can be looked at again', async () => {
    await go('index.html');
    await start(REVIEW);
    await go('cm/case-1001.html?csp=strict');
    (await until(() => button('Clip this page'), 'clip the case')).click();
    await until(async () => (await getCase())?.clips.length === 1, 'case clipped');
    const clientId = (await getCase()).clips[0].values.clientId;
    const tab = await go(`messages/client/${clientId}.html?csp=strict`);
    const run = await until(() => query('fetch-run'), 'the fetch button');
    let sawBox = false;
    run.click();
    await until(async () => { const hh = await host(tab); if (Number(hh?.fetchBoxes) > 0) sawBox = true; return query('fetch-summary'); }, 'the run finished', 30000);
    await until(async () => Number((await host(tab))?.fetchStrip) >= 1, 'boxes shrink to the strip', 15000);
    assert(sawBox || Number((await host(tab))?.fetchBoxes) > 0, 'a box was drawn');
    // The clips keep what was read, as text.
    const fetched = (await getCase()).clips.filter((x) => x.kind === 'fetch');
    assert(fetched.length && fetched.some((x) => x.excerpts && Object.keys(x.excerpts).length), 'excerpts kept');
    // The fetched view, on the case page.
    const view = await browser.tabs.create({ url: browser.runtime.getURL(`case/case.html?view=fetched&clip=${fetched.find((x) => x.excerpts).id}`) });
    const page = await until(() => browser.extension.getViews({ type: 'tab' }).find((w) => w.location.href.includes('view=fetched') && w.document.querySelector('[data-key="fetched-view"]')), 'the fetched view');
    assert(page.document.querySelector('.fv-mark'), 'a value outlined');
    assert(/Showing the parts that were read/.test(page.document.body.textContent), 'says what it shows');
    equal(page.document.querySelectorAll('[data-key="fetched-view"] img, [data-key="fetched-view"] script').length, 0, 'text only');
    await browser.tabs.remove(view.id);
    await finish();
  });
}

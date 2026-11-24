import { config, test, assert, equal, until, state, query, click, button, go, pageValue } from './harness.js';
import { saveSettings, getCase } from '../../lib/core.js';
import { syncLibrary } from '../../lib/library-sync.js';

export async function workflow() {
  await test('Connect a library through real HTTP and render its forms', async () => {
    // The first time it opens, the sidebar starts on Settings with the library form.
    await until(() => query('lib-url'), 'first run opens Settings with the library form');
    equal(document.querySelector('[role=tab][aria-selected=true]')?.textContent, 'Settings', 'First-run tab');
    // Origins are pre-granted only in the temporary test extension. Native permission prompts
    // need trusted browser input and remain a manual check; no permissions API is mocked here.
    await saveSettings({ library: { baseUrl: `${config.base}/demo/library/`, branch: 'main' } });
    const synced = await syncLibrary();
    assert(synced.ok, synced.error);
    [...document.querySelectorAll('[role=tab]')].find((tab) => tab.textContent === 'Case').click();
    await until(() => query('sel-dhp-a'), 'library forms appear');
    assert((await state()).library.current === synced.commit, 'Verified library was persisted');
  });
  await test('Keyboard navigation follows the selected sidebar tab', async () => {
    const tabs = [...document.querySelectorAll('[role=tab]')];
    equal(tabs.map((tab) => tab.textContent), ['Case', 'Tools', 'Privacy', 'Flows', 'Settings'], 'Sidebar tabs');
    tabs[0].focus();
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await until(() => document.activeElement?.textContent === 'Tools', 'keyboard tab focus');
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await until(() => query('sel-dhp-a'), 'return to Case');
  });
  await test('Start a case, clip real tabs, resolve conflicts and undo the wrong person', async () => {
    await go('client-1042.html');
    await click('sel-dhp-a');
    await click('start-sel');
    await until(() => button('Clip this page'), 'case ready to clip');
    for (const page of ['client-1042.html', 'rent-account-1042.html', 'employment-1042.html']) {
      await go(page);
      (await until(() => button('Clip this page'), `clip action on ${page}`)).click();
      await until(async () => (await getCase())?.clips.some((clip) => clip.url.endsWith(page)), `clip persisted: ${page}`);
    }
    const conflicts = await until(() => document.getElementById('conflicts'), 'source conflict');
    assert(conflicts.textContent.includes('Kowalska'), 'Conflict shows competing source values');
    while (document.getElementById('conflicts')) {
      const current = JSON.stringify((await getCase()).resolved);
      button('Use this', document.getElementById('conflicts')).click();
      await until(async () => JSON.stringify((await getCase()).resolved) !== current, 'conflict decision persisted');
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    await go('client-2077.html');
    (await until(() => button('Clip this page'), 'wrong-person clip')).click();
    const warning = await until(() => document.querySelector('.idwarn[role=alert]'), 'identity warning');
    button('Undo this clip', warning).click();
    const dialog = await until(() => document.querySelector('[role=dialog]'), 'remove dialog');
    assert(document.getElementById('app').inert, 'Dialog makes background inert');
    assert(dialog.contains(document.activeElement), 'Focus moves into dialog');
    button('Remove clip', dialog).click();
    await until(async () => (await getCase())?.clips.length === 3, 'wrong-person clip removed');
    assert(!(await getCase()).log.some((event) => event.url?.includes('2077')), 'Wrong-person page purged from activity log');
  });
  await test('Fill preview leaves the target untouched; approval fills without submission', async () => {
    const tab = await go('dhp.html');
    await browser.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
      document.documentElement.dataset.testSubmissions = '0';
      document.addEventListener('submit', (event) => {
        event.preventDefault();
        document.documentElement.dataset.testSubmissions = String(Number(document.documentElement.dataset.testSubmissions) + 1);
      }, true);
    } });
    (await until(() => button('Fill this form'), 'fill action')).click();
    let dialog = await until(() => document.querySelector('[role=dialog]'), 'fill preview');
    equal(await pageValue(tab, '#d-last'), '', 'Preview did not change target');
    assert(dialog.textContent.includes('Left empty'), 'Preview describes missing values');
    button('Cancel', dialog).click();
    equal(await pageValue(tab, '#d-last'), '', 'Cancelled preview did not fill');
    button('Fill this form').click();
    dialog = await until(() => document.querySelector('[role=dialog]'), 'second fill preview');
    button(/^Fill \d+ boxes?$/, dialog).click();
    await until(async () => (await getCase())?.filled.dhp, 'fill receipt persisted');
    equal(await pageValue(tab, '#d-last'), 'Kowalska', 'Settled surname filled');
    equal(await pageValue(tab, '#d-reason'), '', 'Missing field left empty');
    const [check] = await browser.scripting.executeScript({ target: { tabId: tab.id }, func: () => ({ submissions: document.documentElement.dataset.testSubmissions, lookup: document.querySelector('#d-lookup').textContent }) });
    equal(check.result.submissions, '0', 'Power Loader never submitted');
    equal(check.result.lookup, 'Claimant found', 'Real page change handlers ran');
  });
  await test('Finishing traps focus, supports Escape and deletes case data', async () => {
    const opener = await until(() => button('Finish case'), 'finish button');
    opener.focus(); opener.click();
    let dialog = await until(() => document.querySelector('[role=dialog]'), 'finish dialog');
    const focusable = [...dialog.querySelectorAll('button:not([disabled]), input:not([disabled])')];
    focusable.at(-1).focus();
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    equal(document.activeElement, focusable[0], 'Tab wraps to first dialog control');
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    equal(document.activeElement, focusable.at(-1), 'Shift+Tab wraps to last dialog control');
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await until(() => !document.querySelector('[role=dialog]'), 'Escape closes dialog');
    equal(document.activeElement.textContent, 'Finish case', 'Focus restored to opener');
    button('Finish case').click();
    dialog = await until(() => document.querySelector('[role=dialog]'), 'finish confirmation');
    assert(button('Finish and delete data', dialog).disabled, 'Deletion requires confirmation');
    dialog.querySelector('input[type=checkbox]').click();
    button('Finish and delete data', document.querySelector('[role=dialog]')).click();
    await until(async () => (await state()).case === null && (await state()).receipt?.outcome === 'finished', 'case deleted');
    const stored = await state();
    assert(!/Kowalska|07700|QQ123|client-1042/.test(JSON.stringify({ receipt: stored.receipt, logs: stored.processLog })), 'Receipts and retained logs contain no case values or real links');
  });
}

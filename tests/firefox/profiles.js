// Making a profile target first, in real Firefox: the target chooser, the injected agent outlining the page
// under the real CSP, selecting a value, a drop on a field, the override tool, the test, and the assistant
// worker failing actionably when it can't run. The model never downloads here: it is switched off for the
// journey, and the worker check uses the local mirror, which holds no weights.
import { config, test, assert, equal, until, query, click, button, go, state } from './harness.js';
import { deleteDraft, saveSettings } from '../../lib/core.js';
import { loadAssist, stopAssist } from '../../lib/assist-client.js';
import { DEFAULT_ASSIST_MODEL } from '../../lib/model-fetch.js';

const inPage = async (tab, func, args = []) => (await browser.scripting.executeScript({ target: { tabId: tab.id }, func, args }))[0].result;

export async function profiles() {
  await test('Profile assistant worker loads under the real CSP and reports why it can’t run', async () => {
    const r = await loadAssist({ ...DEFAULT_ASSIST_MODEL, baseUrl: `${config.base}/model/`, enabled: true });
    equal(r.state, 'failed', 'No weights on the local mirror, so it can’t become ready');
    assert(['webgpu', 'load', 'unreachable', 'hash'].includes(r.reason), `Actionable failure reason: ${r.reason}`);
    stopAssist();
  });
  await test('Make a profile target first: match, select, drop, override and test on a real page', async () => {
    await saveSettings({ assist: { model: false } });
    const tab = await go('index.html');
    (await until(() => button('Make a profile for this page'), 'make profile')).click();
    await until(() => button('Find the values'), 'target chooser');
    assert(query('ps-t-coc').disabled, 'A form without a fill profile can’t be a target yet');
    query('ps-t-dhp').click();
    await until(() => !button('Find the values').disabled, 'target ticked');
    button('Find the values').click();
    const zone = await until(() => document.querySelector('[data-field="landlord"]'), 'drop zones');
    const d = (await state()).profileDrafts.at(-1);
    equal(JSON.stringify(d.targets), '["dhp"]', 'Draft remembers its target form');
    await until(() => /On-device model off/.test(document.body.textContent), 'model switched off for the suite');
    const outlined = await until(() => inPage(tab, () => document.querySelectorAll('[data-powerloader-pick]').length), 'page outlined');
    assert(outlined > 3, `Values outlined on the page: ${outlined}`);
    assert(await inPage(tab, () => !!document.getElementById('powerloader-pick-style')), 'Outline style injected');
    // A value chosen on the page arrives (not the heading: it repeats the page title, the draft's default
    // name, so the leak check would rightly fail the test) from the page's tab, as the agent sends it.
    await inPage(tab, () => browser.runtime.sendMessage({ type: 'powerloader:picked', selector: '#library-address', value: document.getElementById('library-address').textContent, label: null }));
    const sel = await until(() => document.getElementById('ed-sel-key'), 'selection bar');
    await until(() => inPage(tab, () => document.getElementById('library-address').getAttribute('data-powerloader-pick') === 'sel'), 'selection marked on the page');
    sel.value = 'landlord';
    button('Use for this field').click();
    await until(async () => (await state()).profileDrafts.at(-1).profile.fields.landlord === '#library-address', 'value assigned');
    await until(() => inPage(tab, () => document.getElementById('library-address').getAttribute('data-powerloader-field') === 'Landlord'), 'field badge on the page');
    // A drop on a field, with the agent's drag message standing in for the drag data.
    await inPage(tab, () => browser.runtime.sendMessage({ type: 'powerloader:dragPick', selector: '#library-address', value: document.getElementById('library-address').textContent, label: null }));
    await new Promise((r) => setTimeout(r, 100));
    document.querySelector('[data-field="currentEmployer"]').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true }));
    await until(async () => (await state()).profileDrafts.at(-1).profile.fields.currentEmployer === '#library-address', 'drop assigned');
    void zone;
    // The override tool outlines anything under the pointer; cancelling leaves nothing behind.
    await click(`ed-any-${d.id}`);
    await until(() => inPage(tab, () => document.querySelectorAll('[data-powerloader-ui="override"]').length === 2), 'override outline shown');
    await click(`ed-any-${d.id}`);
    await until(() => inPage(tab, () => document.querySelectorAll('[data-powerloader-ui="override"]').length === 0), 'override cancelled');
    button('Test and use on this computer').click();
    const tested = await until(async () => (await state()).profileDrafts.at(-1).tested, 'draft tested');
    assert(tested.ok, `Test failed: ${JSON.stringify(Object.entries(tested.fields).filter(([, f]) => !f.ok))} ${tested.leaks.join(', ')} · fields ${JSON.stringify((await state()).profileDrafts.at(-1).profile.fields)}`);
    await until(async () => (await state()).profileDrafts.at(-1).use, 'draft in use');
    button('Done').click();
    await until(() => inPage(tab, () => document.querySelectorAll('[data-powerloader-pick], [data-powerloader-field]').length === 0), 'page left as it was');
    await deleteDraft(d.id);
    await saveSettings({ assist: { model: true } });
  });
}

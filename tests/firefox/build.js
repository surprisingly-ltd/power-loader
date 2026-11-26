// Build, in real Firefox: make a two-page flow on the real pages (a form mapped by hand from its labels, a page
// to clip whose value is chosen on the page through the injected agent under the real CSP), test both, then
// Try it: Casework, a case of the flow, clip (its values outlined on the page under a strict CSP, then gathered into
// the step's rows), fill and finish. Also the on-device assistant's worker, which
// loads under the real CSP and says why it can't run (no weights on the local mirror).
import { config, test, assert, equal, until, query, click, button, go, state } from './harness.js';
import { loadAssist, stopAssist } from '../../lib/assist-client.js';
import { DEFAULT_ASSIST_MODEL } from '../../lib/model-fetch.js';

const inPage = async (tab, func, args = []) => (await browser.scripting.executeScript({ target: { tabId: tab.id }, func, args }))[0].result;
const flowNamed = async (name) => ((await state()).flows || []).find((f) => f.name === name);

export async function build() {
  await test('Profile assistant worker loads under the real CSP and reports why it can’t run', async () => {
    const r = await loadAssist({ ...DEFAULT_ASSIST_MODEL, baseUrl: `${config.base}/model/`, enabled: true });
    equal(r.state, 'failed', 'No weights on the local mirror, so it can’t become ready');
    assert(['webgpu', 'load', 'unreachable', 'hash'].includes(r.reason), `Actionable failure reason: ${r.reason}`);
    stopAssist();
  });
  await test('Build a two-page flow on real pages, Try it, and finish its case', async () => {
    assert(!(await state()).case, 'No case open before building');
    await click('mode-build');
    await until(() => document.querySelector('.sb-head.mode-build'), 'Build mode');
    await click('fl-new');
    const name = await until(() => query('fl-name'), 'new flow');
    name.value = 'Firefox build';
    name.dispatchEvent(new Event('change', { bubbles: true }));
    const flow = await until(() => flowNamed('Firefox build'), 'flow saved');
    const out = flow.pages.find((p) => p.role === 'output');
    const inp = flow.pages.find((p) => p.role === 'input');
    // The form: bound to the real page, its box mapped from the form's own label, tested.
    await click(`fl-page-${out.id}`);
    await go('dhp.html');
    (await until(() => query('fl-bind') && /Use the current form/.test(query('fl-bind').textContent) && query('fl-bind'), 'use the form')).click();
    await until(async () => (await flowNamed('Firefox build')).pages.find((p) => p.id === out.id).draft, 'form bound');
    await click('fl-manual');
    (await until(() => query('fl-add'), 'typeahead')).value = 'Landlord';
    await click('fl-add-go');
    await until(async () => (await flowNamed('Firefox build')).pages.find((p) => p.id === out.id).draft.profile.fields['#d-landlord'], 'box mapped');
    await click('fl-test');
    await until(async () => (await flowNamed('Firefox build')).pages.find((p) => p.id === out.id).draft.tested?.ok, 'form tested');
    await click('fl-page-done');
    // The page to clip: its value chosen on the page, as the agent sends it.
    await click(`fl-page-${inp.id}`);
    const tab = await go('rent-account-1042.html');
    (await until(() => query('fl-bind') && /Use the current page/.test(query('fl-bind').textContent) && query('fl-bind'), 'use the page')).click();
    await until(async () => (await flowNamed('Firefox build')).pages.find((p) => p.id === inp.id).draft, 'page bound');
    await click('fl-manual');
    await until(() => inPage(tab, () => document.querySelectorAll('[data-powerloader-pick]').length > 3), 'values outlined on the page');
    (await until(() => query('fl-add'), 'typeahead')).value = 'Landlord';
    await click('fl-add-go');
    await until(() => /Now click the value for/.test(document.body.textContent), 'waiting for its value');
    await inPage(tab, () => browser.runtime.sendMessage({ type: 'powerloader:picked', selector: '#tenancy label(Landlord)', value: 'Harbour Homes Ltd', label: 'Landlord' }));
    await until(async () => Object.keys((await flowNamed('Firefox build')).pages.find((p) => p.id === inp.id).draft.profile.fields).length, 'value mapped');
    await click('fl-test');
    await until(async () => (await flowNamed('Firefox build')).pages.find((p) => p.id === inp.id).draft.tested, 'page tested');
    await click('fl-page-done');
    // Try it: the only way from Build to a case.
    await click('fl-try');
    await until(async () => document.querySelector('[role=dialog]') || (await state()).case, 'case starting');
    const dlg = document.querySelector('[role=dialog]');
    if (dlg) button('Start case', dlg).click();
    await until(async () => (await state()).case?.library?.flow?.name === 'Firefox build', 'case of the flow');
    await until(() => document.querySelector('.sb-head.mode-casework'), 'Casework mode');
    // Under a strict page policy (default-src 'self'), the values the template reads are outlined all the same.
    const strict = await go('rent-account-1042.html?csp=strict');
    (await until(() => button('Clip this page'), 'clip')).click();
    await until(async () => (await state()).case.clips.length === 1, 'clipped');
    const host = () => inPage(strict, () => { const el = document.querySelector('[data-powerloader="values"]'); return el ? { shown: Number(el.dataset.shown), state: el.dataset.state } : null; });
    await until(async () => (await host())?.state === 'done', 'the outlines in their done state, under the page’s CSP');
    assert((await host()).shown >= 1, `Outlined on the page: ${JSON.stringify(await host())}`);
    await until(() => document.querySelector('[data-gather] .gv-value') && [...document.querySelectorAll('[data-gather]')].every((el) => el.classList.contains('got') || el.classList.contains('none')), 'the rows have their values');
    await go('dhp.html');
    (await until(() => button('Fill this form'), 'fill')).click();
    button(/^Fill \d+ box(es)?$/, await until(() => document.querySelector('[role=dialog]'), 'fill plan')).click();
    await until(async () => (await state()).case.filled[Object.keys((await state()).case.filled)[0]], 'filled');
    (await until(() => button('Finish case'), 'finish')).click();
    const fin = await until(() => document.querySelector('[role=dialog]'), 'finish dialog');
    fin.querySelector('input[type=checkbox]').click();
    button('Finish and delete data', document.querySelector('[role=dialog]')).click();
    await until(async () => (await state()).case === null, 'case finished');
  });
  await test('Mend a flow from a case: add a page from the box, test it, use the changed flow, clip the new page, finish', async () => {
    const flow = await flowNamed('Firefox build');
    // A case of the flow, from Build. The tab is on a page the flow doesn't have first: arriving on one of the
    // flow's pages in Build opens that page's editor, which isn't what this test is about.
    await go('index.html');
    await click('mode-build');
    // The flow may still be open from the build above (its overview), or the list may show.
    const at = await until(() => query('fl-try') || query(`fl-open-${flow.id}`), 'the flow, or the list');
    if (at.dataset.key !== 'fl-try') at.click();
    await click('fl-try');
    await until(async () => document.querySelector('[role=dialog]') || (await state()).case, 'case starting');
    if (document.querySelector('[role=dialog]')) button('Start case', document.querySelector('[role=dialog]')).click();
    await until(async () => (await state()).case?.library?.flow?.id === flow.id, 'a case of the flow');
    // A page the flow doesn't have: Casework asks whether the flow is incomplete.
    const tab = await go('employment-1042.html');
    await click('flow-incomplete-add');
    await until(() => document.querySelector('.sb-head.mode-build') && query('fl-add-here'), 'Build, with Add this page');
    const before = (await flowNamed('Firefox build')).pages.length;
    await click('fl-add-here-input');
    await until(async () => (await flowNamed('Firefox build')).pages.length === before + 1, 'the page added');
    const added = (await flowNamed('Firefox build')).pages.find((p) => !flow.pages.some((q) => q.id === p.id));
    await click('fl-manual');
    await until(() => inPage(tab, () => document.querySelectorAll('[data-powerloader-pick]').length > 3), 'values outlined');
    (await until(() => query('fl-add'), 'typeahead')).value = 'Current employer';
    await click('fl-add-go');
    // No form in the flow uses it yet, so the editor asks before it adds the field.
    const ask = await until(() => document.querySelector('[role=dialog]'), 'the new field confirmation');
    assert(/Add Current employer to the flow\?/.test(ask.textContent), `asked: ${ask.textContent}`);
    button('Add it', ask).click();
    await until(() => /Now click the value for/.test(document.body.textContent), 'waiting for its value');
    await inPage(tab, () => browser.runtime.sendMessage({ type: 'powerloader:picked', selector: '#person label(Current employer)', value: 'Northshire Care Ltd', label: 'Current employer' }));
    await until(async () => Object.keys((await flowNamed('Firefox build')).pages.find((p) => p.id === added.id).draft.profile.fields).length, 'mapped');
    await click('fl-test');
    const t = await until(async () => (await flowNamed('Firefox build')).pages.find((p) => p.id === added.id).draft.tested, 'tested');
    const d = (await flowNamed('Firefox build')).pages.find((p) => p.id === added.id).draft;
    assert(t.ok, `Test failed: ${JSON.stringify(t.fields)} ${t.leaks.join(', ')} · fields ${JSON.stringify(d.profile.fields)}`);
    // The open case takes the changed flow, when asked.
    await click('fl-use-changed');
    await until(async () => (await state()).case.log.some((e) => e.activity === 'update_flow'), 'the case uses the changed flow');
    await click('mode-casework');
    await go('employment-1042.html');
    (await until(() => button('Clip this page'), 'clip the new page')).click();
    await until(async () => (await state()).case.clips.some((c) => c.url.includes('employment-1042')), 'clipped');
    (await until(() => button('Finish case'), 'finish')).click();
    const fin = await until(() => document.querySelector('[role=dialog]'), 'finish dialog');
    fin.querySelector('input[type=checkbox]').click();
    button('Finish and delete data', document.querySelector('[role=dialog]')).click();
    await until(async () => (await state()).case === null, 'case finished');
  });
}

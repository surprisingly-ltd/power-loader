import { JSDOM } from 'jsdom';
import fs from 'fs';
const html = fs.readFileSync(new URL('../case-journeys.html', import.meta.url), 'utf8');
const errors = [];
const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { runScripts: 'dangerously', pretendToBeVisual: true });
const w = dom.window; w.addEventListener('error', e => errors.push(e.message + ' ' + (e.error?.stack || '').split('\n')[1]));
const d = w.document; const q = s => d.querySelector(s); const qa = s => [...d.querySelectorAll(s)];
const click = s => { const el = typeof s === 'string' ? q(s) : s; if (!el) throw new Error('missing ' + s); el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); };
const change = (el, v) => { el.value = v; el.dispatchEvent(new w.Event('change', { bubbles: true })); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const txt = el => el.textContent.replace(/\s+/g, ' ').trim();
click('[data-act=jump][data-v="9"]');
console.log('ctx:', txt(q('#sb .sb-body')).slice(0, 160));
click('#sb [data-act=makeProfile]');
console.log('picking:', q('#page').classList.contains('picking'), 'candidates:', qa('#page [data-pick]').length);
for (const k of ['firstName', 'lastName', 'address', 'postcode', 'email']) click(q(`#page [data-pick=${k}]`));
console.log('picked:', qa('#page .picked').length, '| editor:', txt(q('.editor')).slice(0, 300));
click(q('#page [data-pick=email]')); console.log('after unpick email:', qa('#page .picked').length);
click('#sb [data-act=libTest]'); console.log('test toast:', txt(q('.toast'))); click('[data-act=edDone]'); console.log('toast:', txt(q('.toast')));
console.log('ctx now:', txt(q('#sb .ctx')).slice(0, 80));
click('#sb [data-act=clip]'); console.log('clip:', w.eval('JSON.stringify(S.case.clips.find(c=>c.id==="ctax"))').slice(0, 220));
// settings -> library
click('[data-act=sideTab][data-v=settings]'); click('#sb [data-act=openLib]');
console.log('lib:', txt(q('.full')).slice(0, 400));
// new version of client record
click('[data-act=libOpen][data-v="cm/client-record"]'); console.log('detail:', txt(q('.full')).slice(300, 800));
click('[data-act=libNewVer]'); console.log('draft detail head:', txt(q('.full')).slice(250, 450));
const sel = qa('.full select.txt')[8]; console.log('remap', sel.id, sel.value); change(sel, 'clientId');
click(qa('.full [data-act=edRemove]')[9]);
console.log('diff:', txt(q('.full .diff') || q('.full')).slice(0, 120), '| gone rows:', qa('tr.gone').length);
click('[data-act=libTest]'); console.log('v4 test:', txt(q('.toast'))); click('[data-act=libExport]'); console.log('export:', txt(q('.modal')).slice(0, 700)); console.log(q('.modal textarea').value.slice(0, 700)); if (q('[data-act=exDo]')) click('[data-act=exDo]'); click('[data-act=closeModal]');
// fill tab, forms tab, make fill profile
click('[data-act=libTab][data-v=forms]'); click('[data-act=libNewFill][data-v=coc]'); console.log('fill draft:', txt(q('.full')).slice(250, 600));
click('[data-act=libTab][data-v=drafts]'); console.log('drafts tab:', txt(q('.full')).slice(240, 900));
// sync merges exported
click('[data-act=sync]'); await wait(1200); console.log('sync toast:', txt(q('.toast')));
console.log('over:', w.eval('Object.keys(S.lib.over).join(",")'), 'drafts left:', w.eval('S.lib.drafts.map(d=>d.name+" "+d.ver).join(",")'));
// edit on page for council draft
click('[data-act=libOpen][data-v=d1]'); click('[data-act=edEdit]'); console.log('back on page picking:', q('#page').classList.contains('picking'), 'sb hidden', q('#sb').hidden);
click('[data-act=edDone]');
// AI profile draft from intranet? intranet has no values; use ctax AI flow on fresh jump
click('[data-act=jump][data-v="9"]'); click('#sb [data-act=pxOpen][data-v=profile]'); click('[data-act=pxSend]'); await wait(1400);
console.log('ai result:', txt(q('.modal')).slice(0, 200)); click('[data-act=pxDraft]'); console.log('ai draft fields:', w.eval('S.lib.drafts[0].fields.map(f=>f.key).join(",")'), qa('#page .picked').length);
// form AI draft
click('[data-act=jump][data-v="8"]'); click('[data-act=fill][data-v=hsr]'); click('[data-act=pxOpen][data-v=form]'); click('[data-act=pxSend]'); await wait(1400); click('[data-act=pxDraft]');
console.log('form ai draft:', txt(q('.full')).slice(240, 420));
// delete draft
click('[data-act=libDelete]'); click('[data-act=doDelDraft]'); console.log('deleted toast:', txt(q('.toast')));
click('[data-act=closeLibTab]'); console.log('url after close:', txt(q('#url')));
console.log('ERRORS:', errors.length ? errors : 'none');
// fill draft remap affects filling
click('[data-act=jump][data-v="8"]'); click('[data-act=sideTab][data-v=settings]'); click('#sb [data-act=openLib]'); click('[data-act=libTab][data-v=fill]');
click('[data-act=libOpen][data-v="fill/housing-referral"]'); click('[data-act=libNewVer]');
const s2 = qa('.full select.txt').find(x => x.value === 'phone'); change(s2, ''); click('[data-act=libTest]'); console.log('fill test:', txt(q('.toast')));
click('.full [data-act=backToSidebar]'); click('[data-act=sideTab][data-v=case]'); click('[data-act=fill][data-v=hsr]');
console.log('phone box after remap:', w.eval('JSON.stringify(S.case.filled.hsr.map.phone)'), 'risk:', w.eval('JSON.stringify(S.case.filled.hsr.map.riskLevel)'));
console.log('ERRORS2:', errors.length ? errors : 'none');
// Release jsdom timers so the runner can observe normal completion.
dom.window.close();

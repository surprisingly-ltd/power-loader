import { JSDOM } from 'jsdom';
import fs from 'fs';
const html = fs.readFileSync(new URL('../case-journeys.html', import.meta.url), 'utf8');
const errors = [];
const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { runScripts: 'dangerously', pretendToBeVisual: true });
const w = dom.window; w.addEventListener('error', e => errors.push(e.message));
w.HTMLElement.prototype.scrollIntoView = () => {};
const d = w.document;
const click = sel => { const el = typeof sel === 'string' ? d.querySelector(sel) : sel; if (!el) throw new Error('missing ' + sel); el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); };
const txt = () => d.querySelector('#sb').textContent.replace(/\s+/g, ' ');
const wait = ms => new Promise(r => setTimeout(r, ms));
// step 1: onboard
click('[data-act=jump][data-v="1"]'); click('[data-act=fillRepo]'); click('[data-act=connect]'); await wait(1000);
console.log('after connect:', txt().slice(0, 160));
click('[data-act=star][data-v=hsr]'); click('[data-act=sel][data-v=hsr]'); click('[data-act=sel][data-v=dhp]'); click('[data-act=startSel]');
console.log('case started:', d.querySelector('.case-chip').textContent);
for (const p of ['client', 'employment', 'rent', 'notes']) { click(`[data-act=go][data-page=${p}]`); click('[data-act=clip]'); }
console.log('conflicts:', d.querySelectorAll('.cf').length, '| ctx:', d.querySelector('.ctx .diff')?.textContent);
// tools
click('[data-act=sideTab][data-v=tools]'); click('[data-act=calcRun]');
console.log('calc:', [...d.querySelectorAll('.combo')].map(c => c.querySelector('.tot').textContent + '/' + c.querySelectorAll('.ln').length).join(' ; '));
click('[data-act=calcSave]'); click('[data-act=mode][data-t=calc][data-v=enhanced]'); click('[data-act=calcAsk]'); console.log('calc preview:', !!d.querySelector('.px-modal')); click('[data-act=pxSend]'); await wait(1500);
console.log('ai calc:', !!d.querySelector('.ai-card'));
click('[data-act=toolTab][data-v=tl]');
console.log('tl stats:', [...d.querySelectorAll('.stat')].map(s => s.textContent.replace(/\s+/g, ' ')).join(' | '));
click('[data-act=mode][data-t=tl][data-v=enhanced]'); click('[data-act=tlFind]'); click('[data-act=pxSend]'); await wait(1400); click('[data-act=tlAccept]'); click('[data-act=tlExplain]'); click('[data-act=pxSend]'); await wait(1400);
console.log('gaps:', [...d.querySelectorAll('.gap')].map(g => g.textContent).join(' ; '));
click('[data-act=tlSave]'); click('[data-act=openFull]');
console.log('full tl svg:', !!d.querySelector('#page svg'));
for (const v of ['fields', 'calc', 'sources', 'tl', 'matrix', 'activity']) click(`[data-act=fullView][data-v=${v}]`);
click('[data-act=fullView][data-v=fields]');
// resolve conflicts from full page
click('[data-act=resolve][data-k=phone][data-i="1"]'); click('[data-act=resolve][data-k=lastName][data-i="0"]');
click('[data-act=backToSidebar]'); click('[data-act=sideTab][data-v=case]');
console.log('conflicts after:', d.querySelectorAll('.cf').length);
for (const k of ['riskLevel', 'consent']) { click(`.frow[data-k=${k}]`); click(`[data-act=setManual][data-k=${k}]`); }
click('.frow[data-k=reason]'); d.querySelector('#man-reason').value = 'Arrears after sick leave'; click('[data-act=saveManual][data-k=reason]');
click('[data-act=fieldFilter][data-v=missing]'); click('[data-act=formFilter][data-v=dhp]'); click('[data-act=fieldFilter][data-v=all]');
click('[data-act=go][data-page=form-hsr]'); click('[data-act=fill][data-v=hsr]');
console.log('hsr form ok fields:', d.querySelectorAll('.h-field.f-ok').length, 'empty:', d.querySelectorAll('.h-field.f-conflict,.h-field.f-missing').length);
click('[data-act=submitForm][data-v=hsr]'); console.log('confirm ctx:', d.querySelector('.ctx')?.textContent.replace(/\s+/g, ' '));
click('[data-act=go][data-page=form-dhp]'); click('[data-act=fill][data-v=dhp]'); click('[data-act=submitForm][data-v=dhp]');
click('#sb [data-act=finish]'); click('[data-act=copyCase]');
const cb = d.querySelector('#fin-ok'); cb.checked = true; click(cb); click('#fin-btn');
console.log('after finish:', txt().slice(0, 200));
// other jumps + settings + discard + wipe
for (const n of [3, 4, 5, 6, 7, 8, 2, 0]) click(`[data-act=jump][data-v="${n}"]`);
click('[data-act=jump][data-v="4"]'); click('[data-act=sideTab][data-v=settings]'); click('[data-act=toggleManaged]'); click('[data-act=sync]'); await wait(1000);
click('[data-act=toggleAuto]'); click('[data-act=sideTab][data-v=case]'); click('[data-act=discard]'); click('[data-act=doDiscard]');
click('[data-act=go][data-page=intranet]'); click('[data-act=toggleSidebar]'); click('[data-act=toggleSidebar]');
click('[data-act=jump][data-v="8"]'); click('[data-act=go][data-page=intranet]'); click('[data-act=pxOpen][data-v=profile]'); click('[data-act=closeModal]');
click('[data-act=sideTab][data-v=settings]'); click('[data-act=wipeAll]'); click('[data-act=doWipe]');
console.log('ERRORS:', errors.length ? errors : 'none');
// Release jsdom timers so the runner can observe normal completion.
dom.window.close();

import { JSDOM } from 'jsdom';
import fs from 'fs';
const html = fs.readFileSync(new URL('../case-journeys.html', import.meta.url), 'utf8');
const errors = [];
const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { runScripts: 'dangerously', pretendToBeVisual: true });
const w = dom.window; w.addEventListener('error', e => errors.push(e.message + ' ' + e.error?.stack));
const d = w.document; const q = s => d.querySelector(s);
const click = s => { const el = typeof s === 'string' ? q(s) : s; if (!el) throw new Error('missing ' + s); el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const txt = el => el.textContent.replace(/\s+/g, ' ').trim();
click('[data-act=jump][data-v="5"]');
console.log('modal:', txt(q('.modal')).slice(0, 160));
console.log('SENT TEXT:\n' + q('#px-text').textContent);
console.log('pills:', txt(q('.modal .diff')));
// toggle threshold to 90 → A. Patel / J. Okafor (91/89) changes
const thr = q('#px-thr'); thr.value = '90'; thr.dispatchEvent(new w.Event('change', { bubbles: true }));
console.log('thr90 pills:', txt(q('.modal .diff')));
thr.value = '70'; q('#px-thr').dispatchEvent(new w.Event('change', { bubbles: true }));
click('[data-act=pxFmt][data-v=regex]'); console.log('regex tok:', [...d.querySelectorAll('.px-text .tok')].map(e => e.textContent).filter(t => /phone|client/.test(t)).join(' '));
click('[data-act=pxFmt][data-v=shape]');
// un-redact A. Patel via inline click
const patel = [...d.querySelectorAll('.px-text .tok')].find(e => e.dataset.k.includes('patel')); click(patel);
console.log('after unredact patel, kept list:', txt(q('.px-side')).match(/Sent as written \(\d+\)/)?.[0]);
// add manual
q('#px-add').value = 'Royal Mail'; q('#px-add-cat').value = 'person_name'; click('[data-act=pxAdd]');
console.log('royal mail redacted:', q('#px-text').textContent.includes('Royal Mail') ? 'NO' : 'yes');
click('[data-act=pxView][data-v=orig]'); console.log('orig marks:', d.querySelectorAll('.px-text .pmark').length);
click('[data-act=pxSend]'); console.log('sending:', txt(q('.modal')).slice(0, 80));
await wait(1400);
console.log('result:', txt(q('.modal')).slice(0, 900));
click('[data-act=pxAddCase]'); console.log('toast:', txt(q('.toast')));
console.log('clip kinds:', w.eval('S.case.clips.map(c=>c.id+":"+c.kind).join(", ")'));
console.log('log tail:', w.eval('S.case.log.slice(-2).map(e=>e.act+" | "+e.detail).join(" || ")'));
// privacy tab
click('[data-act=sideTab][data-v=privacy]'); console.log('tab:', txt(q('#sb .sb-body')).slice(0, 400));
click('[data-act=pxHl]'); console.log('page marks:', d.querySelectorAll('#page mark.pii').length, [...d.querySelectorAll('#page mark.pii')].slice(0, 6).map(m => m.textContent).join(' / '));
click('[data-act=pxGrp][data-v=dates]'); console.log('page marks with dates:', d.querySelectorAll('#page mark.pii').length);
q('#px-paste').value = 'Hi, this is Maria Kowalska, NI QQ 12 34 56 C, born 14/03/1986, call me on 07700 900123 or maria.kowalska@example.com'; q('#px-paste').dispatchEvent(new w.Event('input', { bubbles: true }));
click('[data-act=pxText]'); console.log('text check:\n' + q('#px-text').textContent);
click('[data-act=pxFmt][data-v=regex]'); console.log('regex:\n' + q('#px-text').textContent);
click('[data-act=closeModal]');
// reader enhanced on scan
click('[data-act=jump][data-v="7"]'); click('[data-act=mode][data-t=rd][data-v=enhanced]'); click('#sb [data-act=readDoc]');
console.log('reader modal image:', !!q('#px-img'), 'blk:', d.querySelectorAll('#px-img mark.blk').length, [...d.querySelectorAll('#px-img mark.blk')].map(m => m.textContent).join(' / '));
click('[data-act=pxSend]'); await wait(5000);
console.log('reader steps:', txt(q('.jobsteps')));
// form mapping
click('[data-act=jump][data-v="8"]'); click('[data-act=fill][data-v=hsr]'); click('[data-act=pxOpen][data-v=form]');
console.log('form text:\n' + q('#px-text').textContent.slice(0, 400));
click('[data-act=pxSend]'); await wait(1400); console.log('form result:', txt(q('.modal')).slice(0, 200)); click('[data-act=pxDraft]'); click('.full [data-act=backToSidebar]');
// intranet extract
click('[data-act=go][data-page=intranet]'); click('[data-act=pxOpen][data-v=extract]'); click('[data-act=pxSend]'); await wait(1400); console.log('intranet result:', txt(q('.modal')).slice(0, 300));
console.log('ERRORS:', errors.length ? errors : 'none');
// Release jsdom timers so the runner can observe normal completion.
dom.window.close();

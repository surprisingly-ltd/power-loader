import { JSDOM } from 'jsdom';
import fs from 'fs';
const html = fs.readFileSync(new URL('../case-journeys.html', import.meta.url), 'utf8');
const errors = [];
const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { runScripts: 'dangerously', pretendToBeVisual: true });
const w = dom.window; w.addEventListener('error', e => errors.push(e.message)); w.HTMLElement.prototype.scrollIntoView = () => {};
const d = w.document; const click = s => { const el = typeof s === 'string' ? d.querySelector(s) : s; if (!el) throw new Error('missing ' + s); el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); };
const T = s => s.textContent.replace(/\s+/g, ' ').trim();
const radio = (name, v) => { const el = d.querySelector(`input[name="${name}"][value="${v}"]`); el.checked = true; el.dispatchEvent(new w.Event('change', { bubbles: true })); };
click('[data-act=jump][data-v="6"]');
console.log('warn:', T(d.querySelector('.idwarn')));
console.log('conflicts:', d.querySelectorAll('#sb .cf').length, '| clips card:', T(d.querySelector('#clips-card')).slice(0, 260));
click('#clips-card [data-act=clipView]'); console.log('view:', T(d.querySelector('.clip-vals')).slice(0, 200));
click('.idwarn [data-act=removeClip]'); console.log('modal:', T(d.querySelector('.modal')).slice(0, 700));
radio('rm-reason', 'Wrong person'); console.log('log option after reason:', d.querySelector('input[name="rm-log"]:checked').value);
const logBefore = w.eval('C().log.map(e => e.act + "@" + e.page).join(", ")'); console.log('log before:', logBefore.split(', ').slice(-4).join(', '));
click('[data-act=doRemoveClip]');
console.log('after: conflicts', d.querySelectorAll('#sb .cf').length, '| clips', w.eval('C().clips.map(c=>c.id).join()'), '| log has client2:', w.eval("C().log.some(e => e.page === 'client2')"), '| toast:', T(d.querySelector('.toast')));
// keep-log path from sidebar list
click('#clips-card [data-act=removeClip]'); radio('rm-reason', 'Out of date'); click('[data-act=doRemoveClip]');
console.log('keep path last log:', w.eval("C().log.at(-1).act + ' · ' + C().log.at(-1).detail"));
// own-only path, from full page sources
click('[data-act=openFull]'); click('[data-act=fullView][data-v=sources]'); click('.srcs-layout [data-act=removeClip]'); radio('rm-log', 'own'); 
const n = w.eval('C().log.length'); click('[data-act=doRemoveClip]'); console.log('own path log', n, '->', w.eval('C().log.length'));
console.log('ERRORS:', errors.length ? errors : 'none');
// Release jsdom timers so the runner can observe normal completion.
dom.window.close();

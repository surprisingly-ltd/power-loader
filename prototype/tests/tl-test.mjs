import { JSDOM } from 'jsdom';
import fs from 'fs';
const html = fs.readFileSync(new URL('../case-journeys.html', import.meta.url), 'utf8');
const errors = [];
const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { runScripts: 'dangerously', pretendToBeVisual: true });
const w = dom.window; w.addEventListener('error', e => errors.push(e.message));
const d = w.document; const click = s => d.querySelector(s).dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const show = tag => console.log(tag, '\n ', [...d.querySelectorAll('.tr')].map(r => r.textContent.replace(/\s+/g, ' ').trim()).join('\n  '), '\n  stats:', [...d.querySelectorAll('.stat')].map(s => s.textContent.replace(/\s+/g, ' ')).join(' | '));
click('[data-act=jump][data-v="4"]'); click('[data-act=sideTab][data-v=tools]'); click('[data-act=toolTab][data-v=tl]');
show('default:');
console.log('  markers:', d.querySelectorAll('#sb svg circle').length, 'diamonds:', d.querySelectorAll('#sb svg path').length);
click('[data-act=tlCat][data-v=Benefit]'); show('employment only:');
const sel = d.querySelector('#tl-min'); sel.value = '7'; sel.dispatchEvent(new w.Event('change', { bubbles: true })); click('[data-act=tlCat][data-v=Benefit]'); show('benefit on, ignore <7:');
click('[data-act=mode][data-t=tl][data-v=enhanced]'); click('[data-act=tlExplain]');
await new Promise(r => setTimeout(r, 1500)); console.log('explain:', d.querySelector('.ai-card')?.textContent.replace(/\s+/g, ' '));
click('[data-act=openFull]'); console.log('full svg:', !!d.querySelector('#page svg'), d.querySelectorAll('#page .tr').length);
console.log('ERRORS:', errors.length ? errors : 'none');
// Release jsdom timers so the runner can observe normal completion.
dom.window.close();

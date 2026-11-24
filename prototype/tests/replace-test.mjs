import { JSDOM } from 'jsdom';
import fs from 'fs';
const html = fs.readFileSync(new URL('../case-journeys.html', import.meta.url), 'utf8');
const errors = [];
const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { runScripts: 'dangerously', pretendToBeVisual: true });
const w = dom.window; w.addEventListener('error', e => errors.push(e.message));
const d = w.document; const click = s => d.querySelector(s).dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const st = () => `sidebar hidden=${d.querySelector('#sb').hidden} cols=${d.querySelector('#viewport').classList.contains('nosb') ? 1 : 2} url=${d.querySelector('#url').textContent}`;
click('[data-act=jump][data-v="4"]'); console.log('host:', st());
click('[data-act=openFull]'); console.log('full:', st());
click('[data-act=toggleSidebar]'); console.log('icon on full:', st(), '|', d.querySelector('#sb').textContent.replace(/\s+/g, ' ').slice(0, 120));
click('#sb [data-act=backToSidebar]'); console.log('back:', st());
click('[data-act=sideTab][data-v=settings]'); click('[data-act=openLog]'); console.log('log:', st());
click('.full [data-act=backToSidebar]'); console.log('back from log:', st());
console.log('ERRORS:', errors.length ? errors : 'none');
// Release jsdom timers so the runner can observe normal completion.
dom.window.close();

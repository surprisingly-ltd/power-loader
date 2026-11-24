import { JSDOM } from 'jsdom';
import fs from 'fs';
const html = fs.readFileSync(new URL('../case-journeys.html', import.meta.url), 'utf8');
const errors = [];
const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { runScripts: 'dangerously', pretendToBeVisual: true });
const w = dom.window; w.addEventListener('error', e => errors.push(e.message + ' ' + (e.error?.stack || '').split('\n')[1]));
const d = w.document; const q = s => d.querySelector(s); const qa = s => [...d.querySelectorAll(s)];
const click = s => { const el = typeof s === 'string' ? q(s) : s; if (!el) throw new Error('missing ' + s); el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); };
const change = (el, v) => { if (v !== undefined) el.value = v; el.dispatchEvent(new w.Event('change', { bubbles: true })); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const txt = el => el.textContent.replace(/\s+/g, ' ').trim();
const ev = s => w.eval(s);
const ok = (name, cond, extra = '') => console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' · ' + extra : ''}`);

// 1. Wrong person removal clears dependents
click('[data-act=jump][data-v="6"]');
ev(`C().manual.phone = '07700 900987'; C().workings.push({ title: 'Calculator: test', time: '10:00', uses: ['client2'], text: 'x' }); go('form-hsr'); fillForm('hsr'); go('client2');`);
click('[data-act=removeClip][data-v=client2]');
const r = q('input[name=rm-reason][value="Wrong person"]'); r.checked = true; change(r);
ok('deps listed', /Values you typed for: Telephone/.test(txt(q('.modal'))) && /Saved workings: Calculator: test/.test(txt(q('.modal'))) && /Forms already filled/.test(txt(q('.modal'))));
ok('deps box ticked by Wrong person', q('input[name=rm-deps]').checked);
click('[data-act=doRemoveClip]');
ok('manual cleared', ev('C().manual.phone') === undefined);
ok('working removed', ev('C().workings.length') === 0);
ok('filled marked stale', ev('C().filled.hsr.stale') === true);
ev(`go('form-hsr')`); renderAll: ev('renderAll()'); ok('stale note on form', /filled before a clip was removed/.test(txt(q('#sb'))));

// 2. Decisions reopen when the evidence changes
click('[data-act=jump][data-v="8"]');
ok('decided phone resolved', ev(`fieldState('phone').status`) === 'resolved');
ev(`addClip('extra', { phone: '07700 111222' }, [], { name: 'Extra', url: 'x', kind: 'page' })`);
ok('new evidence reopens', ev(`fieldState('phone').status`) === 'conflict' && ev(`fieldState('phone').reopened`) === true);

// 3. Re-clipping keeps exclusions when the value is unchanged
ev(`C().excluded.add('rent:arrears'); clipPage('rent')`);
ok('exclusion kept on re-clip', ev(`C().excluded.has('rent:arrears')`));

// 4. Finish leaves no client data behind
click('[data-act=jump][data-v="8"]'); ev(`S.rd.result = { rows: [{ key: 'firstName', value: 'Maria' }] }; S.calc.ai = 'Maria'; S.px.paste = 'Maria Kowalska'`);
click('#sb [data-act=finish]'); const cb = q('#fin-ok'); cb.checked = true; click(cb); click('#fin-btn');
const state = ev(`JSON.stringify({ ...S, processLog: null }, (k, v) => v instanceof Set ? [...v] : v)`);
ok('no name in state after finish', !/Maria|Kowalsk/i.test(state), (state.match(/.{30}(Maria|Kowalsk).{30}/i) || [''])[0]);
ok('receipt is generic', /Case finished/.test(txt(q('#sb'))) && !/Maria/.test(txt(q('#sb'))));

// 5. Redaction: union cover, DOB context, strict restore, planted tokens
ev(`S.px.model = { state: 'ready', at: '09:00', ms: 400 }`);
const sp = JSON.parse(ev(`JSON.stringify(piiState('Call Maria Kowalski, born 02/11/1979. Her mum Ms Kowalska.', {}).map(s => [s.text, s.cat, s.red]))`));
ok('DOB from context without a case', sp.some(([t, c]) => t === '02/11/1979' && c === 'date_of_birth'), JSON.stringify(sp));
const un = JSON.parse(ev(`JSON.stringify(piiState('Maria Kowalska', {}, {}, [{ text: 'Maria', cat: 'first_name' }]).map(s => [s.text, s.cat]))`));
ok('overlap covers the union', un.length === 2 && un[1][0] === 'Kowalska', JSON.stringify(un));
const rs = JSON.parse(ev(`(() => { const sp = piiState('Maria Kowalska', {}, {}, [], 'abc'); return JSON.stringify([restoreText('<redacted:person_name|ref:abc.1>', sp, 'abc'), restoreText('<redacted:person_name|ref:zzz.1>', sp, 'abc'), restoreText('<redacted:phone|ref:abc.1>', sp, 'abc')]); })()`));
ok('restore exact ref', rs[0].text === 'Maria Kowalska' && !rs[0].bad.length);
ok('reject foreign namespace', rs[1].bad.length === 1);
ok('reject category mismatch', rs[2].bad.length === 1);
ev(`openPreview('text', {}, { name: 't', text: 'Hello <redacted:first_name|ref:abc.1> there' })`); ev('renderAll()');
ok('planted token neutralised', /looked like a placeholder/.test(txt(q('.modal'))) && !ev('S.pv.text').includes('<redacted'));
click('[data-act=closeModal]');
ok('format from library, not value', ev(`piiToken({ cat: 'nino', text: 'QQ 12 34 56 C', ref: 'x.1', conf: .99 })`).includes('format:AA999999A'));

// 6. Model status is honest, and policy blocks sending without it
click('[data-act=jump][data-v="5"]'); click('[data-act=closeModal]');
click('[data-act=sideTab][data-v=privacy]'); click('[data-act=pxLockModel]');
const hf = q('input[name=px-src][value=hf]'); hf.checked = true; change(hf);
ok('not ready after source change', /Not loaded/.test(txt(q('#sb'))));
click('[data-act=pxTestModel]'); await wait(800);
ok('hf load fails', /Blocked: huggingface.co/.test(txt(q('#sb'))));
click('[data-act=pxLockModel]'); click('[data-act=pxTestModel]'); await wait(2800);
ok('mirror load reaches ready with a test scan', /Ready · WebGPU · test scan/.test(txt(q('#sb'))));
ev(`S.px.model = { state: 'none' }`); click('[data-act=sideTab][data-v=case]'); click('[data-act=pxOpen][data-v=extract]');
ok('send blocked when model required', q('[data-act=pxSend]').disabled);
click('[data-act=closeModal]');

// 7. Every Enhanced tool goes through the preview
ev(`S.px.model = { state: 'ready', at: '09:00', ms: 400 }`);
click('[data-act=jump][data-v="4"]'); click('[data-act=sideTab][data-v=tools]'); click('[data-act=toolTab][data-v=tl]'); click('[data-act=mode][data-t=tl][data-v=enhanced]');
click('[data-act=tlExplain]'); ok('timeline explain previews', ev('S.modal') === 'privacy' && ev('S.pv.purpose') === 'tlExplain'); click('[data-act=closeModal]');

// 8. Calculator results go stale; timeline totals are exact
click('[data-act=toolTab][data-v=calc]'); click('[data-act=mode][data-t=calc][data-v=standard]'); click('[data-act=calcRun]');
ok('fresh results not stale', !ev('calcStale()'));
click(qa('[data-act=calcToggle]')[0]); ok('toggling an amount makes them stale', ev('calcStale()') && /Inputs changed/.test(txt(q('#sb'))) && !q('[data-act=calcSave]'));
ev(`S.tl.minGap = 31`); const m1 = JSON.parse(ev(`JSON.stringify(tlModel())`)); ev(`S.tl.minGap = 1`); const m2 = JSON.parse(ev(`JSON.stringify(tlModel())`));
ok('excluding gaps ignores the threshold', m1.covered === m2.covered, `covered ${m1.covered} vs ${m2.covered}, short ${m1.shortDays}`);

// 9. Log: unknown pages not logged; no address without a pattern; notes left out of downloads
click('[data-act=jump][data-v="4"]'); const n0 = ev('C().log.length'); ev(`go('intranet')`);
ok('unknown page visit not logged', ev('C().log.length') === n0);
ev(`logEv('Send to AI', 'x')`); ok('no address without pattern', ev('C().log.at(-1).pattern') === '(link not kept)');
click('[data-act=sideTab][data-v=settings]'); click('[data-act=openLog]'); click('[data-act=dlLog][data-v=csv]');
ok('notes excluded by default', !/note/.test(q('#dl-text').value.split('\n')[0]));
click('[data-act=dlNotes]'); ok('notes included when chosen', /note/.test(q('#dl-text').value.split('\n')[0]));

// 10. Library: untested drafts aren't used; exports blocked until tested; edits after export keep the draft
click('[data-act=jump][data-v="9"]'); click('#sb [data-act=makeProfile]');
for (const k of ['firstName', 'lastName']) click(q(`#page [data-pick=${k}]`));
click('[data-act=edDone]'); ok('untested draft not used', !/Your draft/.test(txt(q('#sb'))));
click('[data-act=sideTab][data-v=settings]'); click('#sb [data-act=openLib]'); click('[data-act=libTab][data-v=drafts]'); click('[data-act=libExport]');
ok('export blocked until tested', !q('[data-act=exDo]') && /Not tested yet/.test(txt(q('.modal'))));
click('[data-act=closeModal]'); click('[data-act=libOpen][data-v=d1]'); click('[data-act=libTest]'); click('[data-act=libExport]'); click('[data-act=exDo]'); click('[data-act=closeModal]');
ok('export contains regex filter, no part', /regex:\^\(\\\\S\+\)/.test(ev('exportDoc(draftById("d1"))')) && !/part:/.test(ev('exportDoc(draftById("d1"))')));
 ev(`draftById('d1').name = 'Council tax account (edited)'`);
click('[data-act=sync]'); await wait(1300); ok('changed-after-export draft kept', /kept because it changed after export/.test(txt(q('.toast'))) && ev('S.lib.drafts.length') === 1);
console.log('ERRORS:', errors.length ? errors : 'none');
// Release jsdom timers so the runner can observe normal completion.
dom.window.close();

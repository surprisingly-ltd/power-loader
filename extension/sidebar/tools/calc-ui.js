// The calculator: which amounts in the case make a figure, such as the landlord's arrears. Standard searches
// on this computer; ✦ Enhanced asks the AI gateway a question about the ticked amounts, after the preview.
import { assertTool } from '../../lib/tools.js';
import { h, plural, announce, copyText } from '../../ui/dom.js';
import { TARGET, amounts, inputSignature, LIMITS, workingText } from '../../lib/calc.js';
import { addWorking, fieldState, settled } from '../../lib/case.js';
import { logEvent } from '../../lib/activity.js';
import { fmtDay } from '../../lib/timeline.js';
import { caseNotes, enhancedGate, modeSeg, tools } from './tools.js';
import { runAi } from '../privacy.js';

const money = (n) => `£${Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signed = (n) => `${n > 0 ? '+' : '−'}${money(Math.abs(n))}`;
const TOLERANCES = [['0', 'Exact only'], ['0.5', '± 50p'], ['1', '± £1'], ['5', '± £5']];
const QUESTION = 'Which payments make up the landlord’s arrears figure?';
// What a search and its answer start from; a new case starts from here again.
const fresh = () => ({ target: null, on: null, result: null, picked: 0, question: QUESTION, ai: null });
export const calc = { maxK: 4, tol: '0', worker: null, busy: false, ...fresh() };

// Ending the case, or a new search, stops any search in progress.
export function stopCalc(reset = false) {
  calc.worker?.terminate();
  calc.worker = null;
  calc.busy = false;
  if (reset) Object.assign(calc, fresh());
}

function search(chosen, target, opts, rerender) {
  stopCalc();
  calc.busy = true;
  calc.worker = new Worker(new URL('../../tools/calc-worker.js', import.meta.url), { type: 'module' });
  return new Promise((resolve) => {
    calc.worker.onmessage = ({ data }) => { stopCalc(); resolve(data); };
    calc.worker.onerror = () => { stopCalc(); resolve({ ok: false, message: 'The search stopped unexpectedly' }); };
    calc.worker.postMessage({ chosen, target, opts });
    rerender();
  });
}

const figure = () => Number(String(calc.target).replace(/[£,\s]/g, ''));

function arrearsOf(c, lib) {
  const st = lib.fields[TARGET] ? fieldState(c, lib, TARGET) : null;
  return st && settled(st.status) && st.valid ? st.normalised : null;
}

// ✦ Ask: the ticked amounts, their labels and dates, and the case notes, after the redaction preview.
async function ask(context, chosen) {
  const { data, act } = context;
  if (!calc.question.trim() || !chosen.length) return;
  try { await assertTool('calculator'); } catch (e) { announce(e.message); return; }
  calc.ai = { busy: true };
  act.render();
  const notes = caseNotes(data.case);
  await runAi(context, 'calc', { question: calc.question.trim(), amounts: chosen, notes }, async (out) => {
    calc.ai = { answer: out.answer, items: out.items, problems: out.problems, question: calc.question.trim(), uses: [...new Set([...chosen.map((a) => a.clipId), ...notes.map((n) => n.clipId)])] };
    await act.update((cs) => logEvent(cs, 'ai_calculator', { detail: `${plural(chosen.length, 'amount')}${notes.length ? `, ${plural(notes.length, 'note')}` : ''}` }));
  });
  if (calc.ai?.busy) calc.ai = null;
  act.render();
}

function aiCard({ act }, all) {
  const a = calc.ai;
  if (!a || a.busy) return null;
  const items = all.filter((x) => a.items.includes(x.id));
  const text = [`Question: ${a.question}`, `Answer (AI, checked by the caseworker): ${a.answer}`, ...items.map((x) => `  ${x.date || ''} ${x.label} ${money(x.amount)} [${x.source}]`)].join('\n');
  return h('div', { class: 'ai-card', role: 'region', 'aria-label': 'Answer from the AI' },
    h('h4', {}, '✦ Answer'),
    a.answer ? h('p', {}, a.answer) : h('p', { class: 'error-text' }, 'The answer couldn’t be restored exactly, so it isn’t shown.'),
    items.length ? h('ul', {}, items.map((x) => h('li', {}, `${x.label}${x.date ? ` · ${fmtDay(x.date)}` : ''} · ${money(x.amount)}`))) : null,
    h('p', { class: 'small muted' }, 'Check the sums yourself before you rely on them. Standard search below finds exact combinations on this computer.'),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'sm', 'data-key': 'calc-ai-save', onclick: () => act.update((cs) => addWorking(cs, { title: `✦ ${a.question}`, text, uses: a.uses }), 'Saved to the case’s workings') }, 'Save to case'),
      h('button', { type: 'button', class: 'sm', 'data-key': 'calc-ai-copy', onclick: () => copyText(text, 'Answer') }, 'Copy'),
      h('button', { type: 'button', class: 'link sm', 'data-key': 'calc-ai-clear', onclick: () => { calc.ai = null; act.render(); } }, 'Clear')));
}

export function calcBlock(context, { wide = false } = {}) {
  const { data, lib, act } = context;
  const c = data.case;
  const all = amounts(c, lib);
  const arrears = arrearsOf(c, lib);
  // Transactions are in by default; the case's own weekly or monthly values are opt-in.
  if (!calc.on) calc.on = new Set(all.filter((a) => a.kind === 'transaction').map((a) => a.id));
  if (calc.target == null) calc.target = arrears || '';
  const head = h('div', { class: 'row between' }, modeSeg(context, 'calc'));
  if (!all.length) {
    return [head, h('div', { class: 'card' }, h('h3', {}, 'No amounts yet'), h('p', { class: 'muted' }, 'Clip a page with money on it, such as a rent account, and its amounts appear here.'))];
  }
  const chosen = all.filter((a) => calc.on.has(a.id));
  const sig = inputSignature({ target: figure(), chosen, maxK: calc.maxK, tol: Number(calc.tol) || 0 });
  const stale = calc.result && calc.result.sig !== sig;
  const combo = calc.result?.list[calc.picked];
  const hit = new Set(!stale && combo ? combo.items.map((a) => a.id) : []);
  const aiHit = new Set(calc.ai?.items || []);
  const run = async () => {
    try { await assertTool('calculator'); } catch (e) { announce(e.message); return; }
    const out = await search(chosen, figure(), { maxK: calc.maxK, tol: Number(calc.tol) || 0 }, act.render);
    if (!out.ok) { announce(out.message); calc.result = null; act.render(); return; }
    calc.result = { ...out.result, sig, target: figure() };
    calc.picked = 0;
    announce(out.result.list.length ? `${plural(out.result.list.length, 'combination')} found${out.result.truncated ? ', search stopped at its limit' : ''}` : 'No combination makes that figure');
    await act.update((cs) => logEvent(cs, 'use_calculator', { detail: `${out.result.list.length} combinations found` }));
  };
  const save = () => act.update((cs) => addWorking(cs, {
    title: `Payments making ${money(calc.result.target)}`, text: workingText(combo, calc.result.target), uses: [...new Set(combo.items.map((a) => a.clipId))], inputs: combo.items.map((a) => a.id),
  }), 'Saved to the case’s workings');
  const toggle = (id, on) => { if (on) calc.on.add(id); else calc.on.delete(id); act.render(); };

  const left = h('div', { class: 'stack' },
    h('label', { class: 'field', for: 'calc-target' }, 'Find amounts that add up to'),
    h('div', { class: 'row', style: 'flex-wrap:nowrap' },
      h('input', { type: 'text', inputmode: 'decimal', id: 'calc-target', 'data-key': 'calc-target', class: 'num', style: 'font-size:15px;font-weight:700', value: calc.target, oninput: (e) => { calc.target = e.target.value; } }),
      arrears ? h('button', { type: 'button', class: 'sm', 'data-key': 'calc-arrears', title: 'Use the rent arrears from the case', onclick: () => { calc.target = arrears; act.render(); } }, 'Use arrears') : null),
    h('div', { class: 'row between' },
      h('span', { class: 'small muted' }, `Search ${chosen.length} of ${all.length} amounts`),
      h('span', { class: 'row' },
        h('button', { type: 'button', class: 'link sm', 'data-key': 'calc-all', onclick: () => { calc.on = new Set(all.map((a) => a.id)); act.render(); } }, 'All'),
        h('button', { type: 'button', class: 'link sm', 'data-key': 'calc-none', onclick: () => { calc.on = new Set(); act.render(); } }, 'None'))),
    h('div', { class: 'numlist', role: 'group', 'aria-label': 'Amounts to search', style: wide ? 'max-height:420px' : '' }, all.map((a) => h('label', { class: `numrow${calc.on.has(a.id) ? '' : ' off'}${hit.has(a.id) || aiHit.has(a.id) ? ' hit' : ''}` },
      h('input', { type: 'checkbox', 'data-key': `calc-${a.id}`, checked: calc.on.has(a.id), onchange: (e) => toggle(a.id, e.target.checked) }),
      h('span', { class: 'l' }, a.label, a.frequency ? h('span', { class: 'pill warn', style: 'margin-left:4px' }, a.frequency) : null, h('small', {}, `${a.date ? `${fmtDay(a.date)} · ` : 'case value · '}${a.source}`)),
      h('span', { class: 'a' }, money(a.amount))))),
    h('div', { class: 'row', style: 'flex-wrap:nowrap' },
      h('label', { class: 'field', style: 'flex:1' }, 'Up to',
        h('select', { 'data-key': 'calc-k', onchange: (e) => { calc.maxK = Number(e.target.value); act.render(); } }, [2, 3, 4, 5, 6].map((n) => h('option', { value: String(n), selected: n === calc.maxK }, `${n} amounts`)))),
      h('label', { class: 'field', style: 'flex:1' }, 'Allow a difference of',
        h('select', { 'data-key': 'calc-tol', onchange: (e) => { calc.tol = e.target.value; act.render(); } }, TOLERANCES.map(([v, l]) => h('option', { value: v, selected: v === String(calc.tol) }, l))))),
    h('button', { type: 'button', class: 'primary', 'data-key': 'calc-run', disabled: calc.busy || !chosen.length, onclick: run }, calc.busy ? [h('span', { class: 'spinner' }), ' Searching…'] : 'Find combinations'),
    calc.busy ? h('button', { type: 'button', class: 'sm', 'data-key': 'calc-cancel', style: 'align-self:flex-start', onclick: () => { stopCalc(); announce('Search cancelled'); act.render(); } }, 'Cancel') : null);

  const right = [];
  if (tools.mode.calc === 'enhanced') {
    const gate = enhancedGate(context);
    if (gate) right.push(gate);
    else {
      right.push(h('div', { class: 'disclose' }, '✦ Sends the ticked amounts, their labels and dates, and the case notes to your organisation’s AI gateway. You check a redacted preview first.'),
        h('label', { class: 'field' }, 'What are you trying to work out?',
          h('textarea', { rows: 2, 'data-key': 'calc-q', oninput: (e) => { calc.question = e.target.value; } }, calc.question)),
        h('button', { type: 'button', class: 'magic', 'data-key': 'calc-ask', style: 'align-self:flex-start', disabled: !!calc.ai?.busy || !chosen.length, onclick: () => ask(context, chosen) },
          calc.ai?.busy ? [h('span', { class: 'spinner' }), ' Thinking…'] : '✦ Ask'),
        aiCard(context, all));
    }
  }
  if (stale) right.push(h('div', { class: 'notice warn', role: 'status' }, h('b', {}, 'Inputs changed. '), 'These results are for an earlier search. ', h('button', { type: 'button', class: 'link sm', 'data-key': 'calc-again', onclick: run }, 'Search again')));
  if (calc.result) {
    const r = calc.result;
    right.push(h('div', { class: 'row between' },
      h('b', {}, r.list.length ? `${plural(r.list.length, 'combination')} found` : 'No combinations found'),
      h('span', { class: 'small muted num' }, `target ${money(r.target)}`)));
    if (!r.list.length) right.push(h('p', { class: 'muted' }, `No combination of up to ${r.limits.maxK} amounts makes it. Try allowing more amounts, a small difference, or ticking more rows.`));
    if (r.truncated) right.push(h('p', { class: 'small muted' }, `The search stopped at its limit (${LIMITS.results} answers or ${(LIMITS.nodes / 1e6).toFixed(0)} million steps), so there may be more.`));
    right.push(r.list.slice(0, 10).map((x, i) => h('div', { class: 'stack', style: 'gap:6px' },
      h('button', { type: 'button', class: 'combo', 'data-key': `calc-pick-${i}`, 'aria-pressed': String(i === calc.picked), onclick: () => { calc.picked = i; act.render(); } },
        h('span', { class: 'row between' }, h('span', { class: `pill ${x.diff === 0 ? 'ok' : 'warn'}` }, x.diff === 0 ? 'Exact' : signed(x.diff)), h('span', { class: 'small muted' }, plural(x.items.length, 'amount'))),
        x.items.map((a) => h('span', { class: 'ln' }, h('span', {}, `${a.label}${a.date ? ` · ${fmtDay(a.date)}` : ''}`), h('span', {}, money(a.amount)))),
        h('span', { class: 'ln tot' }, h('span', {}, 'Total'), h('span', {}, money(x.total)))),
      i === calc.picked && !stale ? h('div', { class: 'row' },
        h('button', { type: 'button', class: 'sm', 'data-key': 'calc-save', onclick: save }, 'Save to case'),
        h('button', { type: 'button', class: 'sm', 'data-key': 'calc-copy', onclick: () => copyText(workingText(combo, r.target), 'Working') }, 'Copy')) : null)));
  } else if (tools.mode.calc === 'standard') right.push(h('p', { class: 'small muted' }, 'Runs in this browser. Nothing is sent anywhere.'));
  return [head, h('div', { class: wide ? 'tool-grid wide' : 'tool-grid' }, left, h('div', { class: 'stack' }, right))];
}

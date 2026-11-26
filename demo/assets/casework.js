// The demo systems' only script: which cases this browser has picked up and marked done, kept in
// localStorage. It decorates the pages and never changes a record: the case data is in the HTML as served,
// and nothing is sent anywhere. "Reset the demo" clears it.
(function () {
  'use strict';
  const DONE = 'powerloader-demo-done';
  const PICKED = 'powerloader-demo-picked';
  const read = (key) => { try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch { return {}; } };
  const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private browsing: nothing kept */ } };
  const done = () => read(DONE);
  const ref = (no) => `HSG/2026/${no}`;
  const tag = (text, cls) => { const s = document.createElement('span'); s.className = `tag ${cls}`; s.textContent = text; return s; };

  /** The first case not done, starting after `after` and wrapping round, or null when every case is done. */
  function nextCase(first, count, after) {
    const d = done();
    for (let i = 1; i <= count; i++) {
      const no = first + (((after ?? first - 1) - first + i) % count + count) % count;
      if (!d[no]) return no;
    }
    return null;
  }

  function pickUp(no) { const p = read(PICKED); p[no] = true; write(PICKED, p); }

  function queue(section) {
    if (/[?&]reset\b/.test(location.search)) {
      localStorage.removeItem(DONE);
      localStorage.removeItem(PICKED);
      history.replaceState(null, '', location.pathname);
    }
    const first = Number(section.dataset.first);
    const count = Number(section.dataset.count);
    const d = done();
    const p = read(PICKED);
    for (const tr of section.querySelectorAll('tr[data-case]')) {
      const no = tr.dataset.case;
      const cell = tr.querySelector('.status');
      if (d[no]) { cell.replaceChildren(tag('Done', 'done')); tr.classList.add('done'); }
      else if (p[no]) cell.replaceChildren(tag('With you', 'with-you'));
      tr.querySelector('.pick-up')?.addEventListener('click', () => pickUp(no));
    }
    const next = nextCase(first, count);
    const box = document.getElementById('next-case');
    if (next === null) box.textContent = 'Every case is marked done. Reset the demo to start again.';
    else {
      const a = box.querySelector('a');
      a.href = `case-${next}.html`;
      a.textContent = `Pick up the next case: ${ref(next)}`;
      a.addEventListener('click', () => pickUp(next));
    }
    const type = document.getElementById('type-filter');
    const hide = document.getElementById('hide-done');
    const filter = () => {
      for (const tr of section.querySelectorAll('tr[data-case]')) tr.hidden = (type.value && tr.dataset.type !== type.value) || (hide.checked && tr.classList.contains('done'));
    };
    type.addEventListener('change', filter);
    hide.addEventListener('change', filter);
  }

  // Case Manager's home: the next case to pick up, and the oldest five not marked done.
  function home(section) {
    const first = Number(section.dataset.first);
    const count = Number(section.dataset.count);
    const d = done();
    let shown = 0;
    for (const tr of document.querySelectorAll('#oldest-cases tr[data-case]')) {
      tr.hidden = !!d[tr.dataset.case] || shown >= 5;
      if (!tr.hidden) shown++;
    }
    const next = nextCase(first, count);
    const box = document.getElementById('next-case');
    if (next === null) { box.textContent = 'Every case is marked done. Reset the demo from the work queue to start again.'; return; }
    const a = box.querySelector('a');
    a.href = `case-${next}.html`;
    a.textContent = `Pick up the next case: ${ref(next)}`;
    a.addEventListener('click', () => pickUp(next));
  }

  function casePage(header) {
    const no = header.dataset.case;
    const first = Number(header.dataset.first);
    const count = Number(header.dataset.count);
    pickUp(no);
    const button = document.getElementById('mark-done');
    const message = document.getElementById('done-message');
    const status = header.querySelector('.status');
    const original = status.innerHTML;
    const show = () => {
      const isDone = !!done()[no];
      button.textContent = isDone ? 'Mark as not done' : 'Mark as done';
      if (isDone) status.replaceChildren(tag('Done', 'done')); else status.innerHTML = original;
      message.replaceChildren();
      if (!isDone) return;
      const next = nextCase(first, count, Number(no));
      if (next === null) { message.textContent = 'Marked done. Every case is done.'; return; }
      const a = document.createElement('a');
      a.href = `case-${next}.html`;
      a.textContent = `Next case: ${ref(next)}`;
      message.append('Marked done. ', a);
    };
    button.addEventListener('click', () => {
      const d = done();
      if (d[no]) delete d[no]; else d[no] = new Date().toISOString().slice(0, 10);
      write(DONE, d);
      show();
    });
    show();
  }

  // The rent support review's confirmation: back to the case, which can be marked done there.
  function submitted(box) {
    const q = new URLSearchParams(location.search);
    const no = /^\d{4}$/.test(q.get('case') || '') ? q.get('case') : null;
    if (q.get('ref')) document.getElementById('ref').textContent = q.get('ref');
    if (!no) return;
    const a = document.createElement('a');
    a.href = `cm/case-${no}.html`;
    a.textContent = `Back to case ${ref(no)} to mark it done`;
    box.replaceChildren(a);
  }

  // The review form: the case it's for, from its address, and a reference made from it.
  function reviewForm(form) {
    const no = new URLSearchParams(location.search).get('case');
    if (!/^\d{4}$/.test(no || '')) return;
    form.elements.case.value = no;
    form.elements.ref.value = `RSR-4${no}`;
    document.getElementById('for-case').textContent = `For case ${ref(no)}`;
  }

  const queueSection = document.getElementById('queue');
  if (queueSection?.dataset.first) queue(queueSection);
  const homeSection = document.getElementById('home');
  if (homeSection?.dataset.first) home(homeSection);
  const header = document.getElementById('case-header');
  if (header?.dataset.case) casePage(header);
  const back = document.getElementById('back-to-case');
  if (back) submitted(back);
  const form = document.getElementById('rent-review');
  if (form) reviewForm(form);

  // An accordion, as many real systems have one: its button opens and closes the section by a class name. Power
  // Loader never presses it; a template's reveal rule adds the same class when it needs to show a value inside.
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-accordion]');
    if (!b) return;
    const open = b.closest('.accordion').classList.toggle('accordion--open');
    b.setAttribute('aria-expanded', String(open));
  });
}());

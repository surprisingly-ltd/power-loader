import './style.css';
import { FILE_HEX } from './rig/api';
import { Game, NAME } from './game/game';
import { CHAPTERS, H, W } from './game/level';
import { SLOT_GLYPH } from './game/level';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('game'), g = canvas.getContext('2d')!;
const stage = $('stage'), hud = $('hud'), help = $('help');
const select = $<HTMLSelectElement>('chapter-select'), mute = $<HTMLButtonElement>('mute');
const banner = $('banner'), end = $('end'), small = $('small-screen'), skip = $<HTMLButtonElement>('skip');

const game = new Game();

// ------------------------------------------------------------------ input
const held = new Set<string>();
let jumpPressed = false, interactPressed = false;
const typing = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.matches('input, select, textarea, [contenteditable]') || (el.matches('button') && el.closest('#hud') !== null));

addEventListener('keydown', e => {
  if (typing(e.target)) return;
  const k = e.key.toLowerCase();
  if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown', ' ', 'a', 'd', 'w', 's'].includes(k)) e.preventDefault();
  if (e.repeat) { held.add(k); return }
  held.add(k);
  if (k === ' ' || k === 'arrowup' || k === 'w') jumpPressed = true;
  if (k === 'e' || k === 'enter') {
    // Panel buttons handle their own Enter.
    if (e.target instanceof HTMLButtonElement) return;
    e.preventDefault();
    interactPressed = true;
  }
});
addEventListener('keyup', e => held.delete(e.key.toLowerCase()));
addEventListener('blur', () => held.clear());

function intent() {
  const left = held.has('arrowleft') || held.has('a'), right = held.has('arrowright') || held.has('d');
  return {
    move: (right ? 1 : 0) - (left ? 1 : 0),
    jumpPressed,
    jumpHeld: held.has(' ') || held.has('arrowup') || held.has('w'),
    drop: held.has('arrowdown') || held.has('s'),
  };
}

// -------------------------------------------------------------------- HUD
CHAPTERS.forEach((c, i) => select.add(new Option(`${c.id}. ${c.title}`, String(i))));
select.onchange = () => { game.start(+select.value); select.blur() };
$('restart').onclick = e => { game.start(game.store.chapter); (e.currentTarget as HTMLElement).blur() };
$('banner-next').onclick = () => game.next();
skip.onclick = () => { game.skip(); skip.blur() };
$('play-again').onclick = () => game.start(0);
function renderMute() { mute.textContent = game.audio.muted ? 'Sound off' : 'Sound on'; mute.setAttribute('aria-pressed', String(game.audio.muted)) }
mute.onclick = () => { game.audio.setMuted(!game.audio.muted); renderMute(); mute.blur() };
renderMute();

let hudKey = '';
function syncHud() {
  const s = game.snapshot(), def = CHAPTERS[game.store.chapter];
  const req = s.requested;
  const key = JSON.stringify([s.chapter, s.phase, s.status, s.delivered, s.carrying, s.cases.filed]);
  if (key === hudKey) return;
  hudKey = key;
  $('chapter-title').innerHTML = `<span>Chapter ${def.id}</span>${def.title}`;
  $('caption').textContent = def.caption;
  select.value = String(game.store.chapter);
  const chip = (c: keyof typeof FILE_HEX, label: string) =>
    `<span class="sw" style="background:${FILE_HEX[c]}">${SLOT_GLYPH[c]}</span>${label}`;
  const color = s.carrying ?? req;
  $('request').innerHTML = color && s.kind === 'carry' ? chip(color, s.status) : s.status;
  $('count').innerHTML = `Delivered <b>${s.delivered}</b> / ${s.total} · Cases filed <b>${s.cases.filed}</b>`;
  skip.hidden = !(s.kind !== 'carry' && s.phase === 'play');
  banner.hidden = s.phase !== 'complete';
  end.hidden = s.phase !== 'end';
  if (s.phase === 'complete') {
    const nextDef = CHAPTERS[game.store.chapter + 1];
    $('banner-kicker').textContent = `Chapter ${def.id} complete`;
    $('banner-title').textContent = nextDef ? `Next: ${nextDef.title}` : 'All chapters filed';
    $('banner-text').textContent = nextDef ? nextDef.caption : 'Every file, straight where it belongs.';
    $('banner-next').textContent = nextDef ? 'Next chapter →' : 'Finish →';
  }
}
game.onChange(syncHud);

// ----------------------------------------------------------------- layout
function layout() {
  const tooSmall = innerWidth < 1024 || innerHeight < 576 || (matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches);
  small.hidden = !tooSmall;
  const availW = innerWidth - 16, availH = innerHeight - hud.offsetHeight - help.offsetHeight - 14;
  const scale = Math.min(availW / W, availH / H);
  const cssW = Math.floor(W * scale), cssH = Math.floor(H * scale);
  stage.style.width = cssW + 'px';
  stage.style.height = cssH + 'px';
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  return tooSmall;
}
let paused = layout();
addEventListener('resize', () => { paused = layout() });

// ------------------------------------------------------------------- loop
const STEP = 1 / 120;
let last = performance.now(), acc = 0;
function frame(now: number) {
  acc += Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!paused) {
    while (acc >= STEP) {
      game.update(STEP, intent(), interactPressed);
      jumpPressed = false;
      interactPressed = false;
      acc -= STEP;
    }
  } else acc = 0;
  syncHud();
  g.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);
  game.render(g);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// -------------------------------------------------------------- test hook
if (import.meta.env.DEV || new URLSearchParams(location.search).has('debug')) {
  Object.assign(window, {
    __game: {
      game,
      state: () => game.snapshot(),
      chapter: (n: number) => game.start(n - 1),
      teleport: (x: number, y: number) => {
        const b = game.actor; b.x = x; b.y = y; b.vx = 0; b.vy = 0; b.grounded = false;
      },
      interact: () => game.interact(),
      skip: () => game.skip(),
      next: () => game.next(),
    },
  });
}

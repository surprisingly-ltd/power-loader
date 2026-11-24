// The homepage's closing scene: the inspector in loader 07, parked by the Level 1 door. Walk it in with
// → / D (← / A backs off), or press the Play button: the door rolls up, the loader walks through and the
// page goes to the Play tab, where the full Transfer Bay 07 game starts at chapter 1. The rig is the game's
// own (site/game/src/rig); this file only adds the door, the input and the hand-off.
import { LoaderView } from '../game/src/rig/loader';
import { environment, fileBox, shadow, stripe } from '../game/src/rig/scenery';
import { type Ctx, P, rect, poly, disc, label, ink, steel, iron, gold, shade, green, clamp } from '../game/src/rig/draw';

const W = 1280, H = 480, FLOOR = 440;
const DOOR = { x: 1000, w: 180, h: 300 };
// The game draws its characters for a 720-high bay; this strip is 480 high, so they're drawn larger.
const CHAR_SCALE = 1.55;
const START_X = 620, MIN_X = 260, SPEED = 210;
const ENTER_X = DOOR.x + DOOR.w / 2; // where the loader is through the door
const OPEN_FROM = DOOR.x - 200; // the shutter starts to rise when the loader gets this close

function door(g: Ctx, open: number, time: number) {
  const { x, w, h } = DOOR, top = FLOOR - h;
  // Opening: a warm lit corridor behind the shutter.
  rect(g, ink, x - 14, top - 16, w + 28, h + 16);
  rect(g, '#3a2e1d', x, top, w, h);
  const glow = g.createLinearGradient(0, top, 0, FLOOR);
  glow.addColorStop(0, 'rgba(236,180,78,.55)'); glow.addColorStop(1, 'rgba(236,180,78,.08)');
  g.fillStyle = glow; g.fillRect(x, top, w, h);
  for (let i = 0; i < 4; i++) rect(g, 'rgba(23,36,45,.35)', x + 14 + i * 36, top + 24, 4, h - 24);
  // Roller shutter: slats that roll up into the header box.
  const shut = h * (1 - open);
  g.save(); g.beginPath(); g.rect(x, top, w, shut); g.clip();
  rect(g, '#55656e', x, top, w, shut);
  for (let y = top + shut - 12; y > top - 12; y -= 12) { rect(g, '#46565f', x, y, w, 3); rect(g, '#6c7c84', x, y + 3, w, 1); }
  g.restore();
  if (shut > 10) stripe(g, x + 4, top + shut - 9, w - 8);
  // Frame posts with hazard edges and the header box.
  rect(g, iron, x - 14, top - 16, 14, h + 16); rect(g, iron, x + w, top - 16, 14, h + 16);
  for (let y = top; y < FLOOR - 10; y += 22) { poly(g, shade, x - 12, y, x - 2, y - 8, x - 2, y + 2, x - 12, y + 10); poly(g, shade, x + w + 2, y, x + w + 12, y - 8, x + w + 12, y + 2, x + w + 2, y + 10); }
  rect(g, steel, x - 20, top - 30, w + 40, 18); rect(g, ink, x - 20, top - 14, w + 40, 4);
  // The sign: LEVEL 1, lit, with a status lamp that turns green as the door opens.
  const sx = x + w / 2, sy = top - 100;
  rect(g, ink, sx - 92, sy - 4, 184, 62);
  rect(g, '#1e2a31', sx - 86, sy + 2, 172, 50);
  g.save(); g.textAlign = 'center'; g.shadowColor = 'rgba(236,180,78,.8)'; g.shadowBlur = 14;
  label(g, 'LEVEL 1', sx, sy + 40, 36, gold, 800);
  g.restore();
  rect(g, ink, sx - 2, sy + 58, 4, 34);
  disc(g, ink, P(x + w + 34, top + 30), 9);
  disc(g, open > .9 ? green : Math.sin(time * 3) > 0 ? '#e8483f' : '#7d2f2a', P(x + w + 34, top + 30), 6);
  g.save(); g.textAlign = 'center'; label(g, 'TRANSFER BAY 07 · PLAY', sx, FLOOR + 26, 15, '#9fadb1', 700); g.restore();
}

function bubble(g: Ctx, text: string, x: number, y: number, alpha: number) {
  if (alpha <= 0.01) return;
  g.save(); g.globalAlpha = alpha;
  g.font = '700 17px Arial, Helvetica, sans-serif';
  const w = g.measureText(text).width + 28, h = 36, left = x - w / 2;
  rect(g, ink, left - 2, y - 2, w + 4, h + 4);
  rect(g, '#f4efe0', left, y, w, h);
  poly(g, ink, x - 12, y + h + 2, x + 2, y + h + 2, x - 14, y + h + 16);
  poly(g, '#f4efe0', x - 10, y + h, x, y + h, x - 11, y + h + 11);
  g.fillStyle = ink; g.textAlign = 'center'; g.fillText(text, x, y + 24);
  g.restore();
}

export function mountHero(canvas: HTMLCanvasElement, opts: { target: string; startButton: HTMLElement | null; hint: HTMLElement | null }) {
  const g = canvas.getContext('2d');
  if (!g) return;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const loader = new LoaderView();
  const state = { x: START_X, y: FLOOR, vx: 0, vy: 0, grounded: true, facing: 1 as 1 | -1, carrying: null, piloted: true, power: 1 };
  const keys = new Set<string>();
  let auto = false, leaving = false, fade = 0, open = 0, said = 1, time = 0, last = 0, visible = true, raf = 0;

  function size() {
    const scale = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * scale); canvas.height = Math.round(H * scale);
    g!.setTransform(scale, 0, 0, scale, 0, 0);
    draw(); // resizing clears the canvas, and the loop is paused while it's off screen
  }

  function go() {
    if (leaving) return;
    leaving = true;
    window.location.assign(opts.target);
  }

  function start() {
    if (reduced) { go(); return; }
    auto = true;
    if (opts.hint) opts.hint.textContent = 'Heading for Level 1…';
  }

  function step(dt: number) {
    const right = auto || keys.has('right'), left = !auto && keys.has('left');
    state.vx = right && !left ? SPEED : left && !right ? -SPEED : 0;
    if (state.vx) state.facing = state.vx > 0 ? 1 : -1;
    state.x = Math.max(MIN_X, state.x + state.vx * dt);
    open = clamp(open + (state.x > OPEN_FROM ? 1.6 : -1) * dt);
    said = clamp(said + (state.vx || auto ? -2 : 1) * dt);
    if (state.x > ENTER_X) { fade = clamp(fade + dt * 2.4); if (fade >= 1) go(); }
    loader.update(dt, state);
  }

  function draw() {
    environment(g!, 0, FLOOR);
    fileBox(g!, 70, FLOOR, 3, true); fileBox(g!, 132, FLOOR, 4);
    door(g!, open, time);
    shadow(g!, state.x, 56 * CHAR_SCALE, FLOOR);
    const drawLoader = () => {
      // A warm cab light behind the cage, so the inspector's dark suit reads against the bay wall.
      const cx = state.x + state.facing * 6, cy = FLOOR - 150;
      const halo = g!.createRadialGradient(cx, cy, 10, cx, cy, 120);
      halo.addColorStop(0, 'rgba(244,231,196,.55)'); halo.addColorStop(.55, 'rgba(244,231,196,.18)'); halo.addColorStop(1, 'rgba(244,231,196,0)');
      g!.fillStyle = halo; g!.fillRect(cx - 120, cy - 120, 240, 240);
      g!.save(); g!.translate(state.x, FLOOR); g!.scale(CHAR_SCALE, CHAR_SCALE); g!.translate(-state.x, -FLOOR);
      loader.draw(g!, time);
      g!.restore();
    };
    // Through the door the loader passes behind the far post.
    if (state.x > DOOR.x + 40) { g!.save(); g!.beginPath(); g!.rect(0, 0, DOOR.x + DOOR.w, H); g!.clip(); drawLoader(); g!.restore(); rect(g!, iron, DOOR.x + DOOR.w, FLOOR - DOOR.h - 16, 14, DOOR.h + 16); }
    else drawLoader();
    bubble(g!, 'Level 1. Shall we?', state.x + 30, FLOOR - 300, said);
    if (fade > 0) { g!.fillStyle = `rgba(16,23,28,${fade})`; g!.fillRect(0, 0, W, H); }
  }

  function frame(now: number) {
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 0);
    last = now; time += dt;
    step(dt); draw();
    raf = visible ? requestAnimationFrame(frame) : 0;
  }

  const codes: Record<string, 'left' | 'right'> = { ArrowRight: 'right', KeyD: 'right', ArrowLeft: 'left', KeyA: 'left' };
  function typing(t: EventTarget | null) {
    const el = t as HTMLElement | null;
    return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  }
  window.addEventListener('keydown', (e) => {
    const k = codes[e.code];
    if (!k || !visible || e.altKey || e.ctrlKey || e.metaKey || typing(e.target)) return;
    e.preventDefault();
    if (reduced) { if (k === 'right') go(); return; }
    keys.add(k);
  });
  window.addEventListener('keyup', (e) => { const k = codes[e.code]; if (k) keys.delete(k); });
  window.addEventListener('blur', () => keys.clear());
  // Coming back with the browser's Back button restores this page from the cache: park the loader again.
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    Object.assign(state, { x: START_X, vx: 0, facing: 1 });
    auto = false; leaving = false; fade = 0; open = 0; said = 1; keys.clear();
    if (opts.hint) opts.hint.textContent = '';
  });
  opts.startButton?.addEventListener('click', (e) => { e.preventDefault(); start(); });

  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible && !raf && !reduced) { last = 0; raf = requestAnimationFrame(frame); }
    if (!visible) keys.clear();
  }, { threshold: 0.25 }).observe(canvas);

  loader.update(0, state);
  size();
  window.addEventListener('resize', size);
  if (reduced) return;
  raf = requestAnimationFrame(frame);
}

const canvas = document.getElementById('bay') as HTMLCanvasElement | null;
if (canvas) {
  mountHero(canvas, {
    target: canvas.dataset.target || '/play',
    startButton: document.getElementById('walk-in'),
    hint: document.getElementById('bay-status'),
  });
}

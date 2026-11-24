// The case line: every worker (you, the autopilot, each fleet loader) fills its own active case
// on a cradle on the receptacle bank's roof. Each saved file sends a light from its slot into the
// case, in the order saved. A full case closes, rises on its ram, clips onto the overhead chain
// and rides up and over into the Completed Cases crate, where it drops onto the pile.
//
// The chain runs at one constant speed, so cases riding it keep their spacing. An interlock holds
// a lift until the chain has a gap at that cradle, so any number of cases can be under way at once.
import { FILE_HEX, type FileColor } from '../rig/api';
import { BANK, FLOOR_Y, SLOT_X } from './level';
import { disc, PALETTE, poly, rect, text, type Ctx } from './scenery';

const { ink, iron, gold } = PALETTE;
const kraft = '#c9a66b', kraftDark = '#9c7c47', kraftLight = '#e2c690';

export const CASE_W = 28;
export const CASE_H = 20;
/** Trolley pivot to the top of a hanging case. */
const HANG = 10;
/** The bank's roof, where the cradles sit. */
const ROOF = FLOOR_Y - 128;
/** Top of a case resting in its cradle, and hanging from the low rail. */
const REST_TOP = ROOF - 4 - CASE_H;
const RAIL_LO = 420, RAIL_HI = 228, RISER_X = 282, RAIL_RIGHT = 558, RAIL_LEFT = 24;
const LIFT_UP = REST_TOP - (RAIL_LO + HANG);
/** Chain speed, px/s, and the clear gap a lift needs on it. */
const V = 330, GAP = 58;
const GRAVITY = 1900;
/** Pendulum: pivot to case centre, a softened impulse so jolts swing ~10°, and damping. */
const PEND_L = HANG + CASE_H / 2, KICK = 0.16, DAMP = 3.2;

/** Cradle steps, seconds (scaled by the line's pace). */
const FOLD = 0.34, CLOSE = 0.3, LIFT = 0.36, CLAMP = 0.16, RETRACT = 0.26, PELLET = 0.4;

/** The Completed Cases crate, standing on two legs at the left of the bay, under the top rail. */
export const CRATE = { x: 26, y: 340, w: 236, h: 140 };
const COLS = 7, PITCH = 31, ROW_H = 21;
const PILE_FLOOR = CRATE.y + CRATE.h - 8;
/** Six rows fit inside; past that the pile heaps up over the rim, as high as the chain allows. */
const ROWS_IN = Math.floor((PILE_FLOOR - CRATE.y - 6) / ROW_H);
const ROWS = Math.floor((PILE_FLOOR - (RAIL_HI + HANG + CASE_H + 4)) / ROW_H);

const PATH = [
  { x: RAIL_RIGHT, y: RAIL_LO }, { x: RISER_X, y: RAIL_LO }, { x: RISER_X, y: RAIL_HI }, { x: RAIL_LEFT, y: RAIL_HI },
];
const S_TOP = (RAIL_RIGHT - RISER_X) + (RAIL_LO - RAIL_HI);

function colX(slot: number) { return CRATE.x + 9.5 + (slot % COLS) * PITCH + PITCH / 2 }
function slotTop(slot: number) {
  const row = Math.min(ROWS - 1, Math.floor(slot / COLS));
  return PILE_FLOOR - (row + 1) * ROW_H + 1;
}
/** A small, steady lean per slot so the pile looks stacked by hand. */
function restTilt(slot: number) { return (((slot * 7919) % 13) / 13 - 0.5) * 0.09 }

function posAt(s: number): { x: number; y: number } {
  let left = s;
  for (let i = 1; i < PATH.length; i++) {
    const a = PATH[i - 1], b = PATH[i], len = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    if (left <= len || i === PATH.length - 1) {
      const u = Math.min(1, left / len);
      return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
    }
    left -= len;
  }
  return PATH[PATH.length - 1];
}

const ease = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
const easeBack = (u: number) => { const k = 1.9; u = Math.min(1, Math.max(0, u)); return 1 + (k + 1) * (u - 1) ** 3 + k * (u - 1) ** 2 };

export interface FiledCase { chapter: number; lamps: FileColor[] }

type Stage = 'queued' | 'fold' | 'open' | 'closing' | 'hold' | 'lifting' | 'clamp' | 'riding' | 'falling';
interface Case {
  lamps: FileColor[];
  /** Lamps whose light has arrived. */
  lit: number;
  stage: Stage;
  t: number;
  /** Distance along the chain. */
  s: number;
  vx: number;
  /** Swing angle and its rate. */
  th: number;
  om: number;
  x: number;
  y: number;
  vy: number;
  slot: number;
  engageAt: number;
  landed: boolean;
}
interface Bay { x: number; active: boolean; delay: number; queue: Case[]; plate: number; retracting: boolean }
interface Pellet { bay: number; c: Case; i: number; t: number; from: { x: number; y: number } }

export type Sfx = (cue: 'blip' | 'pickup' | 'feed' | 'stomp') => void;

function newCase(stage: Stage): Case {
  return { lamps: [], lit: 0, stage, t: 0, s: 0, vx: 0, th: 0, om: 0, x: 0, y: 0, vy: 0, slot: -1, engageAt: 0, landed: false };
}

export class CaseLine {
  readonly bays: Bay[];
  private moving: Case[] = [];
  private pellets: Pellet[] = [];
  private time = 0;
  private nextSlot: number;

  /**
   * size: files per case. workers: one cradle each. archive: filed cases, kept by the game across chapters.
   * pace scales the cradle steps (below 1 is faster).
   */
  constructor(readonly size: number, workers: number, private archive: FiledCase[], readonly chapter: number,
    readonly pace = 1, private sfx: Sfx = () => {}) {
    const span = BANK.w - 24, x0 = BANK.x + 12 + CASE_W / 2 - 2;
    this.bays = Array.from({ length: workers }, (_, i) => ({
      x: workers === 1 ? BANK.x + BANK.w / 2 : Math.round(x0 + (i * (span - CASE_W + 4)) / (workers - 1)),
      active: false, delay: 0, queue: [], plate: 0, retracting: false,
    }));
    this.nextSlot = archive.length;
  }

  /** Bring a cradle online: its first empty case folds up after `delay` seconds. */
  activate(bay: number, delay = 0) {
    const b = this.bays[bay];
    if (!b || b.active) return;
    b.active = true; b.delay = delay;
    if (!b.queue.length) b.queue.push(newCase('fold'));
  }

  /** A file of `color` was saved by worker `bay`: its light flies from the slot into that worker's case. */
  add(bay: number, color: FileColor) {
    const b = this.bays[bay];
    if (!b) return;
    if (!b.active) this.activate(bay);
    let c = b.queue[b.queue.length - 1];
    if (!c || c.lamps.length >= this.size) { c = newCase('queued'); b.queue.push(c) }
    c.lamps.push(color);
    this.pellets.push({ bay, c, i: c.lamps.length - 1, t: 0, from: { x: SLOT_X[color], y: FLOOR_Y - 84 } });
  }

  /** Anything still moving that the chapter should wait for (partly filled cases don't count). */
  get busy(): boolean {
    if (this.pellets.length || this.moving.length) return true;
    return this.bays.some(b => b.queue.length > 1 || b.retracting || (b.queue[0] && (b.queue[0].lit >= this.size || !['open', 'fold'].includes(b.queue[0].stage))));
  }

  /** Files lit in each worker's active case. */
  get active(): number[] { return this.bays.map(b => b.queue[0]?.lit ?? 0) }

  /** Skip: file `count` finished cases for this chapter at once and reset the cradles. */
  fileAll(count: number, colors: FileColor[]) {
    for (let i = this.archive.length - 1; i >= 0; i--) if (this.archive[i].chapter === this.chapter) this.archive.splice(i, 1);
    for (let n = 0; n < count; n++) {
      this.archive.push({ chapter: this.chapter, lamps: Array.from({ length: this.size }, (_, i) => colors[(n * this.size + i) % colors.length]) });
    }
    this.moving = []; this.pellets = [];
    this.nextSlot = this.archive.length;
    for (const b of this.bays) {
      b.active = true; b.delay = 0; b.plate = 0; b.retracting = false;
      const c = newCase('open'); b.queue = [c];
    }
  }

  private s0(b: Bay) { return RAIL_RIGHT - b.x }

  /** The chain has room at this cradle for the whole lift and clamp. */
  private clear(b: Bay): boolean {
    const s0 = this.s0(b), up = this.time + LIFT * this.pace, on = up + CLAMP * this.pace;
    const near = (sAt: (t: number) => number) => Math.abs(sAt(up) - s0) < GAP || Math.abs(sAt(on) - s0) < GAP;
    for (const c of this.moving) if (c.stage === 'riding' && near(t => c.s + V * (t - this.time))) return false;
    for (const o of this.bays) {
      const c = o.queue[0];
      if (o === b || !c || (c.stage !== 'lifting' && c.stage !== 'clamp')) continue;
      const so = this.s0(o);
      if (near(t => so + V * Math.max(0, t - c.engageAt))) return false;
    }
    return true;
  }

  update(dt: number) {
    this.time += dt;
    for (const p of [...this.pellets]) {
      p.t += dt;
      if (p.t >= PELLET) { p.c.lit = Math.max(p.c.lit, p.i + 1); this.pellets.splice(this.pellets.indexOf(p), 1); this.sfx('blip') }
    }
    const pace = this.pace;
    for (const b of this.bays) {
      if (!b.active) continue;
      if (b.delay > 0) { b.delay -= dt; continue }
      if (b.retracting) {
        b.plate = Math.max(0, b.plate - dt / (RETRACT * pace));
        if (b.plate > 0) continue;
        b.retracting = false;
        if (!b.queue.length) b.queue.push(newCase('fold'));
        b.queue[0].stage = 'fold'; b.queue[0].t = 0;
      }
      const c = b.queue[0];
      if (!c) continue;
      c.t += dt;
      switch (c.stage) {
        case 'queued': c.stage = 'fold'; c.t = 0; break;
        case 'fold': if (c.t >= FOLD * pace) { c.stage = 'open'; c.t = 0 } break;
        case 'open':
          if (c.lit >= this.size) { c.stage = 'closing'; c.t = 0; this.sfx('pickup') }
          break;
        case 'closing': if (c.t >= CLOSE * pace) { c.stage = 'hold'; c.t = 0 } break;
        case 'hold':
          if (this.clear(b)) { c.stage = 'lifting'; c.t = 0; c.engageAt = this.time + (LIFT + CLAMP) * pace }
          break;
        case 'lifting':
          b.plate = ease(c.t / (LIFT * pace));
          if (c.t >= LIFT * pace) { b.plate = 1; c.stage = 'clamp'; c.t = 0; this.sfx('feed') }
          break;
        case 'clamp':
          if (c.t >= CLAMP * pace) {
            b.queue.shift();
            c.stage = 'riding'; c.t = 0; c.s = this.s0(b); c.vx = 0; c.th = 0; c.om = 0;
            this.moving.push(c);
            b.retracting = true;
          }
          break;
      }
    }
    for (const c of [...this.moving]) {
      c.t += dt;
      if (c.stage === 'riding') {
        const a = posAt(c.s);
        c.s += V * dt;
        const p = posAt(c.s), vx = (p.x - a.x) / dt;
        // A jolt in the trolley's speed (pick-up, corners) kicks the hanging case into a swing.
        c.om += (-(vx - c.vx) / PEND_L) * KICK;
        c.vx = vx;
        c.om += (-(GRAVITY / PEND_L) * Math.sin(c.th) - DAMP * c.om) * dt;
        c.th += c.om * dt;
        if (c.slot < 0 && c.s >= S_TOP) c.slot = this.nextSlot++;
        if (c.slot >= 0 && c.s >= S_TOP + (RISER_X - colX(c.slot))) {
          c.stage = 'falling'; c.t = 0;
          c.x = colX(c.slot); c.y = RAIL_HI + HANG; c.vy = -40;
          this.sfx('feed');
        }
      } else if (c.stage === 'falling') {
        const rest = restTilt(c.slot), target = slotTop(c.slot);
        c.vy += GRAVITY * dt;
        c.y += c.vy * dt;
        c.th += (rest - c.th) * Math.min(1, dt * (c.landed ? 18 : 3));
        if (c.y >= target) {
          c.y = target;
          if (!c.landed) { c.landed = true; this.sfx('stomp') }
          if (c.vy > 140) c.vy = -c.vy * 0.28;
          else {
            this.moving.splice(this.moving.indexOf(c), 1);
            this.archive.push({ chapter: this.chapter, lamps: c.lamps });
          }
        }
      }
    }
  }

  // ------------------------------------------------------------------ drawing
  /** Rails, chain, the crate and its pile, and cases riding the chain. Drawn behind the bank. */
  drawBack(g: Ctx, time: number) {
    drawCrate(g, this.archive, this.moving.filter(c => c.stage === 'falling'));
    drawRails(g, time);
    for (const c of this.moving) {
      if (c.stage !== 'riding') continue;
      const p = posAt(c.s);
      trolley(g, p.x, p.y);
      g.save(); g.translate(p.x, p.y + 3); g.rotate(c.th);
      rect(g, ink, -1, 0, 2, HANG - 3);
      drawCase(g, 0, HANG - 3, this.size, c.lamps, c.lamps.length, 1, 0, 1);
      g.restore();
    }
  }

  /** Cradles, rams and the cases in them, on the bank roof. */
  drawFront(g: Ctx, time: number) {
    for (const b of this.bays) {
      const c = b.queue[0], lift = b.plate * LIFT_UP, plateY = ROOF - 4 - lift;
      // Hatch in the roof and the ram's telescoping stages.
      rect(g, ink, b.x - 15, ROOF - 1, 30, 3);
      if (lift > 0.5) {
        const stages = [10, 7, 5];
        stages.forEach((w, k) => {
          const top = ROOF - (lift * (k + 1)) / 3 - 1, bottom = ROOF - (lift * k) / 3 + (k ? 2 : 0);
          rect(g, ink, b.x - w / 2 - 1, top, w + 2, bottom - top);
          rect(g, k === 0 ? '#7b8a90' : k === 1 ? '#9ba9a7' : '#c3ccca', b.x - w / 2, top, w, bottom - top);
          rect(g, 'rgba(255,255,255,.35)', b.x - w / 2 + 1, top, 1, bottom - top);
        });
      }
      // Plate with side guides.
      rect(g, ink, b.x - 17, plateY, 34, 5);
      rect(g, b.active ? '#6b7b83' : '#46565f', b.x - 16, plateY + 1, 32, 3);
      rect(g, ink, b.x - 17, plateY - 5, 3, 6); rect(g, ink, b.x + 14, plateY - 5, 3, 6);
      // Hold lamp: amber while the cradle waits for a gap on the chain.
      const holding = c?.stage === 'hold';
      disc(g, ink, b.x + 11, plateY + 2.5, 2.4);
      disc(g, holding ? (Math.sin(time * 18) > 0 ? gold : '#7a5a24') : b.active ? '#2f5a40' : '#2a3a43', b.x + 11, plateY + 2.5, 1.5);
      if (!b.active || !c || b.delay > 0 || b.retracting || c.stage === 'queued') continue;
      const top = plateY - CASE_H;
      if (c.stage === 'clamp') {
        // The trolley drops its hook and bites.
        const u = Math.min(1, c.t / (CLAMP * this.pace)), bite = Math.sin(u * Math.PI) * 2;
        trolley(g, b.x, RAIL_LO);
        rect(g, ink, b.x - 1, RAIL_LO + 3, 2, HANG - 3 + bite);
      }
      const fold = c.stage === 'fold' ? c.t / (FOLD * this.pace) : 1;
      const lid = c.stage === 'closing' ? ease(c.t / (CLOSE * this.pace)) : ['hold', 'lifting', 'clamp'].includes(c.stage) ? 1 : 0;
      const flash = c.stage === 'closing' ? Math.max(0, 1 - c.t / (CLOSE * this.pace) * 1.6) : 0;
      drawCase(g, b.x, top, this.size, c.lamps, c.lit, lid, flash, fold);
    }
  }

  /** Lights flying from each slot into their worker's case. */
  drawPellets(g: Ctx) {
    for (const p of this.pellets) {
      const b = this.bays[p.bay], to = lampAt(b.x, REST_TOP, this.size, p.i);
      const hex = FILE_HEX[p.c.lamps[p.i]];
      for (let k = 3; k >= 0; k--) {
        const u = Math.max(0, p.t / PELLET - k * 0.05), e = ease(u);
        const cx = (p.from.x + to.x) / 2, cy = Math.min(p.from.y, to.y) - 46;
        const x = (1 - e) ** 2 * p.from.x + 2 * (1 - e) * e * cx + e * e * to.x;
        const y = (1 - e) ** 2 * p.from.y + 2 * (1 - e) * e * cy + e * e * to.y;
        g.save();
        g.globalAlpha = k === 0 ? 1 : 0.5 - k * 0.12;
        if (k === 0) { g.shadowColor = hex; g.shadowBlur = 10 }
        disc(g, hex, x, y, k === 0 ? 3.4 : 2.6 - k * 0.4);
        if (k === 0) disc(g, '#ffffff', x - 0.8, y - 0.8, 1.2);
        g.restore();
      }
    }
  }
}

function lampAt(cx: number, top: number, size: number, i: number) {
  return { x: cx - 11 + ((i + 0.5) * 22) / size, y: top + 12 };
}

/**
 * A case box: kraft card with a strip of lamps on its face, lit in the order files arrived.
 * lid 0 = flaps open, 1 = shut and sealed. fold 0..1 = folding up out of the cradle.
 */
export function drawCase(g: Ctx, cx: number, top: number, size: number, lamps: FileColor[], lit: number, lid: number, flash: number, fold: number) {
  const w = CASE_W, h = CASE_H, x = cx - w / 2;
  const grow = easeBack(fold);
  g.save();
  g.translate(cx, top + h); g.scale(1, Math.max(0.08, Math.min(1.15, grow))); g.translate(-cx, -(top + h));
  rect(g, ink, x - 1, top - 1, w + 2, h + 2);
  rect(g, kraft, x, top, w, h);
  rect(g, kraftLight, x, top, w, 2);
  rect(g, kraftDark, x, top + h - 3, w, 3);
  // Lamp strip.
  rect(g, ink, x + 2, top + 7, w - 4, 10);
  for (let i = 0; i < size; i++) {
    const p = lampAt(cx, top, size, i);
    if (i < lit && lamps[i]) {
      const hex = FILE_HEX[lamps[i]];
      g.save(); g.shadowColor = hex; g.shadowBlur = 6; disc(g, hex, p.x, p.y, 2.7); g.restore();
      g.save(); g.globalAlpha = 0.7; disc(g, '#fff', p.x - 0.8, p.y - 0.8, 0.9); g.restore();
    } else {
      disc(g, '#1d2a32', p.x, p.y, 2.5);
    }
  }
  // Flaps hinge at the top corners: open, they lean out; shut, they lie flat under a gold seal.
  if (fold > 0.55) {
    const phi = (1 - lid) * 2.05, len = w / 2 - 1;
    g.lineCap = 'round';
    for (const side of [-1, 1]) {
      const hx = cx + side * (w / 2), dx = -side * Math.cos(phi) * len, dy = -Math.sin(phi) * len;
      g.strokeStyle = ink; g.lineWidth = 4; g.beginPath(); g.moveTo(hx, top); g.lineTo(hx + dx, top + dy); g.stroke();
      g.strokeStyle = lid >= 1 ? kraftLight : kraft; g.lineWidth = 2; g.beginPath(); g.moveTo(hx, top); g.lineTo(hx + dx, top + dy); g.stroke();
    }
    if (lid >= 1) { rect(g, ink, cx - 4, top - 2, 8, 6); rect(g, gold, cx - 3, top - 1, 6, 4) }
  }
  if (flash > 0) { g.globalAlpha = flash; rect(g, '#fff8e0', x, top, w, h); g.globalAlpha = 1 }
  g.restore();
}

function trolley(g: Ctx, x: number, railY: number) {
  rect(g, ink, x - 7, railY - 2, 14, 6);
  disc(g, '#7b8a90', x - 4, railY - 3, 2.2); disc(g, '#7b8a90', x + 4, railY - 3, 2.2);
}

function gear(g: Ctx, x: number, y: number, r: number, angle: number) {
  disc(g, ink, x, y, r + 2);
  disc(g, '#6b7b83', x, y, r);
  g.save(); g.translate(x, y); g.rotate(angle);
  for (let i = 0; i < 4; i++) { g.rotate(Math.PI / 4); rect(g, ink, -r + 1, -1, 2 * r - 2, 2) }
  g.restore();
  disc(g, '#c3ccca', x, y, 2);
}

/** I-beam rails hung from the truss, the moving chain beneath them, and the sprockets. */
function drawRails(g: Ctx, time: number) {
  // Hanger rods.
  for (const hx of [360, 470]) { rect(g, ink, hx - 2, 48, 4, RAIL_LO - 52); rect(g, '#5a6a72', hx - 1, 48, 1, RAIL_LO - 52) }
  for (const hx of [80, 210]) { rect(g, ink, hx - 2, 48, 4, RAIL_HI - 52); rect(g, '#5a6a72', hx - 1, 48, 1, RAIL_HI - 52) }
  // Riser post, from the bank's side tower up to the top rail.
  rect(g, ink, RISER_X + 6, RAIL_HI - 6, 6, FLOOR_Y - 110 - RAIL_HI + 6);
  rect(g, '#4a5a63', RISER_X + 8, RAIL_HI - 6, 2, FLOOR_Y - 110 - RAIL_HI + 6);
  // Beams.
  rect(g, ink, RISER_X - 4, RAIL_LO - 7, RAIL_RIGHT - RISER_X + 12, 7); rect(g, iron, RISER_X - 3, RAIL_LO - 6, RAIL_RIGHT - RISER_X + 10, 2);
  rect(g, ink, RAIL_LEFT - 8, RAIL_HI - 7, RISER_X - RAIL_LEFT + 12, 7); rect(g, iron, RAIL_LEFT - 7, RAIL_HI - 6, RISER_X - RAIL_LEFT + 10, 2);
  rect(g, ink, RISER_X - 9, RAIL_HI - 4, 7, RAIL_LO - RAIL_HI + 4);
  // Chain, running on the rail's underside.
  g.save();
  g.strokeStyle = '#9ba9a7'; g.lineWidth = 2; g.setLineDash([4, 3]); g.lineDashOffset = time * V;
  g.beginPath();
  PATH.forEach((p, i) => (i ? g.lineTo(p.x, p.y + 1) : g.moveTo(p.x, p.y + 1)));
  g.stroke();
  g.restore();
  const a = -time * V / 8;
  gear(g, RAIL_RIGHT, RAIL_LO - 2, 8, a);
  gear(g, RISER_X, RAIL_LO - 2, 6, a);
  gear(g, RISER_X, RAIL_HI - 2, 6, a);
  gear(g, RAIL_LEFT, RAIL_HI - 2, 8, a);
  poly(g, gold, RAIL_RIGHT - 30, RAIL_LO - 14, RAIL_RIGHT - 38, RAIL_LO - 18, RAIL_RIGHT - 38, RAIL_LO - 10);
}

/** The Completed Cases crate: a mesh-fronted cage on legs, its pile, and its counter. */
function drawCrate(g: Ctx, archive: FiledCase[], falling: Case[]) {
  const { x, y, w, h } = CRATE;
  // Legs to the floor.
  for (const lx of [x + 8, x + w - 8]) {
    rect(g, '#3b4b55', lx - 5, y + h, 10, FLOOR_Y - y - h);
    rect(g, '#4a5a63', lx - 3, y + h, 3, FLOOR_Y - y - h);
    rect(g, ink, lx - 8, FLOOR_Y - 4, 16, 4);
  }
  rect(g, ink, x - 3, y - 3, w + 6, h + 6);
  rect(g, '#24323b', x, y, w, h);
  for (let r = 0; r < ROWS_IN; r++) rect(g, 'rgba(255,255,255,.03)', x + 4, PILE_FLOOR - (r + 1) * ROW_H, w - 8, 1);
  archive.forEach((c, i) => {
    const top = slotTop(i), cx = colX(i);
    g.save(); g.translate(cx, top + CASE_H / 2); g.rotate(restTilt(i)); g.translate(-cx, -(top + CASE_H / 2));
    drawCase(g, cx, top, c.lamps.length, c.lamps, c.lamps.length, 1, 0, 1);
    g.restore();
  });
  for (const c of falling) {
    g.save(); g.translate(c.x, c.y + CASE_H / 2); g.rotate(c.th); g.translate(-c.x, -(c.y + CASE_H / 2));
    drawCase(g, c.x, c.y, c.lamps.length, c.lamps, c.lamps.length, 1, 0, 1);
    g.restore();
  }
  // Mesh front and frame.
  g.save(); g.globalAlpha = 0.5;
  for (let bx = x + 12; bx < x + w - 4; bx += 16) rect(g, '#7d8b90', bx, y + 2, 1, h - 4);
  g.restore();
  rect(g, ink, x - 3, y - 3, w + 6, 5);
  rect(g, '#d9cfb3', x - 3, y - 3, w + 6, 2);
  rect(g, ink, x - 3, y + h - 4, w + 6, 7);
  rect(g, ink, x - 3, y, 4, h); rect(g, ink, x + w - 1, y, 4, h);
  // Label plate and counter under the crate.
  rect(g, ink, x + 34, y + h + 3, w - 68, 20);
  rect(g, '#3a4a53', x + 36, y + h + 5, w - 72, 16);
  text(g, 'COMPLETED CASES', x + 42, y + h + 17, 11, '#b7c0bb', 700);
  rect(g, gold, x + w - 76, y + h + 6, 38, 14);
  text(g, String(archive.length), x + w - 57, y + h + 17.5, 12, ink, 800, 'center');
}

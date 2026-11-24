// Small AABB platformer physics. Bodies are anchored at feet centre (x, y).
import type { Platform } from './level';

export interface Tuning {
  w: number;
  h: number;
  speed: number;
  accel: number;
  airAccel: number;
  gravity: number;
  jumpVelocity: number;
  /** Multiplier applied to upward velocity when jump is released early. */
  jumpCut: number;
}

export interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
  grounded: boolean;
  /** Id of the surface we stand on, if grounded. */
  ground: string | null;
  facing: 1 | -1;
  coyote: number;
  buffer: number;
  dropUntil: number;
}

export const COYOTE = 0.12;
export const BUFFER = 0.14;
/** Extra width on each side when testing for a landing: easy, forgiving ledges. */
const LANDING_GRACE = 8;

export function makeBody(x: number, y: number, facing: 1 | -1 = 1): Body {
  return { x, y, vx: 0, vy: 0, grounded: true, ground: 'floor', facing, coyote: 0, buffer: 0, dropUntil: 0 };
}

export interface Intent { move: number; jumpPressed: boolean; jumpHeld: boolean; drop: boolean }

export interface StepEvents { jumped: boolean; landed: boolean; landingSpeed: number }

export function step(b: Body, t: Tuning, intent: Intent, solids: Platform[], decks: Platform[], dt: number, now: number): StepEvents {
  const ev: StepEvents = { jumped: false, landed: false, landingSpeed: 0 };
  // Horizontal: accelerate toward the target speed.
  const target = intent.move * t.speed;
  const a = b.grounded ? t.accel : t.airAccel;
  const dv = target - b.vx;
  b.vx += Math.sign(dv) * Math.min(Math.abs(dv), a * dt);
  if (intent.move !== 0) b.facing = intent.move > 0 ? 1 : -1;

  // Jump: coyote time and buffering.
  b.coyote = b.grounded ? COYOTE : Math.max(0, b.coyote - dt);
  b.buffer = intent.jumpPressed ? BUFFER : Math.max(0, b.buffer - dt);
  if (intent.drop && intent.jumpPressed && b.grounded && b.ground && decks.some(d => d.id === b.ground)) {
    b.dropUntil = now + 0.25;
    b.buffer = 0;
    b.grounded = false;
    b.y += 2;
  } else if (b.buffer > 0 && b.coyote > 0) {
    b.vy = -t.jumpVelocity;
    b.buffer = 0;
    b.coyote = 0;
    b.grounded = false;
    ev.jumped = true;
  }
  if (!intent.jumpHeld && b.vy < 0) b.vy *= Math.pow(t.jumpCut, dt * 60);

  b.vy = Math.min(b.vy + t.gravity * dt, 1400);

  // Move x, resolve against solids.
  b.x += b.vx * dt;
  const half = t.w / 2;
  for (const s of solids) {
    const top = b.y - t.h, bottom = b.y;
    if (bottom <= s.y + 0.5 || top >= s.y + s.h) continue;
    if (b.x + half <= s.x || b.x - half >= s.x + s.w) continue;
    // Low obstacles (a few px) are stepped over rather than blocking.
    if (b.grounded && s.y >= bottom - 6) {
      b.y = s.y;
      continue;
    }
    if (b.x < s.x + s.w / 2) b.x = s.x - half;
    else b.x = s.x + s.w + half;
    b.vx = 0;
  }

  // Move y, resolve against solids and one-way decks.
  const prevBottom = b.y;
  const prevTop = b.y - t.h;
  b.y += b.vy * dt;
  const wasGrounded = b.grounded;
  b.grounded = false;
  b.ground = null;
  for (const s of solids) {
    const overlapX = b.x + half + LANDING_GRACE > s.x && b.x - half - LANDING_GRACE < s.x + s.w;
    const strictX = b.x + half > s.x && b.x - half < s.x + s.w;
    if (b.vy >= 0 && overlapX && prevBottom <= s.y + 0.5 && b.y >= s.y) {
      land(b, s, ev, wasGrounded);
    } else if (b.vy < 0 && strictX && prevTop >= s.y + s.h - 0.5 && b.y - t.h < s.y + s.h) {
      b.y = s.y + s.h + t.h;
      b.vy = 0;
    }
  }
  if (now >= b.dropUntil) {
    for (const d of decks) {
      const overlapX = b.x + half + LANDING_GRACE > d.x && b.x - half - LANDING_GRACE < d.x + d.w;
      if (b.vy >= 0 && overlapX && prevBottom <= d.y + 0.5 && b.y >= d.y) land(b, d, ev, wasGrounded);
    }
  }
  return ev;
}

function land(b: Body, s: Platform, ev: StepEvents, wasGrounded: boolean) {
  if (!wasGrounded) {
    ev.landed = true;
    ev.landingSpeed = b.vy;
  }
  b.y = s.y;
  b.vy = 0;
  b.grounded = true;
  b.ground = s.id;
}

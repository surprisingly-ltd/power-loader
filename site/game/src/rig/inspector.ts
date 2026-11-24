// The bowler-hatted inspector: rig drawing, heel-to-toe gait and the game adapter.
import { FILE_HEX, type BodyState, type CharacterView, type FileColor } from './api';
import {
  type Ctx, type Pt, type Keys, P, between, mix, keys, ease, contour, flesh, beam, disc,
  projectedJoint, boot, rig, ink, steel, light, folder,
} from './draw';

/** Drawing scale shared by both characters (native rig sizes are larger than the bay wants). */
export const RIG_SCALE = 0.8;

export interface PersonPose { hip: Pt; feet: Pt[]; hands: Pt[]; lean: number; front: number }

/**
 * Draw the inspector from a solved pose (native units). `held` draws between the
 * body and the near arm, so a carried file sits in the hands.
 */
export function drawPerson(g: Ctx, { hip, feet, hands, lean = 0, front = 0 }: PersonPose, held?: () => void) {
  const shoulder = P(hip.x + lean + 2 * (1 - front), hip.y - 29);
  const head = P(shoulder.x + 2 * (1 - front), shoulder.y - 13);
  const sides = [0, 1].map(i => {
    const side = i ? -1 : 1, root = P(hip.x + side * 5 * front, hip.y), socket = P(shoulder.x + side * 8 * front, shoulder.y);
    const f = feet[i], h = hands[i];
    return {
      root, socket, f, h, k: projectedJoint(root, f, rig.human.leg, -1, front, side * 2),
      e: projectedJoint(socket, h, rig.human.arm, 1, front, side * 7), c: i ? ink : '#30404a',
    };
  });
  type Side = typeof sides[number];
  function leg({ root, k, f, c }: Side) {
    flesh(g, c, root, k, f, [7, 3.9, 4.9, 2.6]);
    // A single pressed trouser stripe follows the articulated leg.
    const crease = between(root, k, .32), hem = between(k, f, .85);
    beam(g, steel, crease, k, .50, .40); beam(g, steel, k, hem, .40, .34);
    const xy = boot(f, f.roll ?? 0), shoe: Pt[] = [];
    for (let j = 0; j < xy.length; j += 2) shoe.push(P(mix(xy[j], f.x + (xy[j] - f.x - 2) * .74, front), xy[j + 1]));
    contour(g, c, shoe);
  }
  function arm({ socket, e, h, c }: Side) {
    flesh(g, c, socket, e, h, [4.9, 3.1, 3.6, 2.15]);
    const palm = between(e, h, 1.08);
    beam(g, c, h, palm, 2.5, 2.8); disc(g, c, palm, 2.8);
  }
  leg(sides[0]); arm(sides[0]); leg(sides[1]);
  // The jacket covers both hip sockets and narrows into the neck.
  const body = (u: number, dx: number, dy = 0) => { const p = between(hip, shoulder, u); return P(p.x + dx, p.y + dy); };
  contour(g, ink, [body(0, -6, 5), body(.2, -8), body(.45, -6.8), body(.78, -8.8),
    body(1, -8.4, -1), body(1, -4, -4), P(head.x - 3.7, head.y + 2),
    P(head.x + 4, head.y + 3), body(1, 3.6, -3), body(.94, 8.5), body(.68, 8.6),
    body(.39, 6.2), body(.1, 8.3), body(0, 6.2, 5), body(0, 0, 6)]);
  // A small shirt opening stays visible between the lapels in profile.
  const opening = mix(4.1, 0, front);
  contour(g, light, [body(1, opening - 3, -1), body(1, opening + 3.4, -1), body(.64, opening + 1)]);
  contour(g, steel, [body(.98, opening - .7), body(.98, opening + 1.5), body(.81, opening + .7), body(.73, opening + 1.2)]);
  contour(g, '#34444d', [body(1, opening - 5.5), body(.93, opening - 2), body(.87, opening - 3.2), body(.59, opening + 1.4)]);
  const fc = (x: number, y: number) => P(head.x + x, head.y + y);
  contour(g, '#66716e', [fc(-5.7, -3), fc(5, -3.5), fc(5.7, .6), fc(7.3 - front, 2.6),
    fc(5.6, 3.6), fc(4.6, 7.3), fc(.6, 7.8), fc(-4.7, 4.6), fc(-5.8, .8)]);
  // A close-fitting felt dome, dark ribbon and a brim curled up at both ends.
  contour(g, '#39454c', [fc(-7, -2.7), fc(-6.9, -6.8), fc(-5.5, -10.2),
    fc(-2.6, -12), fc(2.3, -12), fc(5.5, -10.4), fc(6.8, -7), fc(7, -2.7)]);
  contour(g, ink, [fc(-7, -5.2), fc(7, -5.2), fc(7, -2.5), fc(-7, -2.5)]);
  contour(g, ink, [fc(-10.2, -5.2), fc(-8, -3.5), fc(0, -3), fc(8, -3.7),
    fc(10, -5.2), fc(9.6, -2.1), fc(6, -.9), fc(-6, -.7), fc(-9.8, -2)]);
  held?.();
  arm(sides[1]);
}

// Heel strike, loading response, single support, toe-off and swing.
// The sole rolls around the grounded heel or toe. Its ankle drives the leg IK.
export const gait: { stride: number } & Record<'roll' | 'clearance' | 'pelvis' | 'arm' | 'elbow', Keys> = {
  stride: 80,
  roll: [[0, -.30], [.095, 0], [.37, 0], [.52, .38], [.61, .91], [.73, .62], [.86, .03], [.96, -.30], [1, -.30]],
  clearance: [[0, 0], [.61, 0], [.69, 5], [.78, 9], [.87, 7], [.96, 2], [1, 0]],
  pelvis: [[0, 0], [.19, 2.4], [.48, -.8], [.70, -2.3], [1, 0]],
  arm: [[0, -.36], [.10, -.38], [.29, -.11], [.49, .30], [.58, .34], [.78, .07], [1, -.36]],
  elbow: [[0, .28], [.22, .21], [.45, .46], [.59, .55], [.80, .39], [1, .28]],
};

/** The walking inspector with hip at x, having started at `start`, feet on `floor`. */
export function human(x: number, start: number, floor: number): PersonPose {
  const phase = (x - start) / gait.stride, step = phase * 2 % 1, hip = P(x, floor - 53 + keys(step, gait.pelvis)),
    lean = 2.6 + 1.2 * Math.sin(2 * Math.PI * step - .6), feet: Pt[] = [], hands: Pt[] = [];
  for (let i = 0; i < 2; i++) {
    const n = phase + i * .5, u = n % 1, d = keys(u, gait.roll), cs = Math.cos(d), sn = Math.sin(d), pivot = d < 0 ? -4 : 10;
    const station = start + (Math.floor(n) - i * .5 + .285) * gait.stride;
    const sole = station + gait.stride * ease(.61, 1, u), height = keys(u, gait.clearance);
    const ankle: Pt = P(sole + pivot - pivot * cs + 4 * sn, floor - height - pivot * sn - 4 * cs); ankle.roll = d; feet.push(ankle);
    const upper = keys(u, gait.arm), lower = upper + keys(u, gait.elbow);
    hands.push(P(hip.x + 2 + lean + 21 * Math.sin(upper) + 20 * Math.sin(lower), hip.y - 29 + 21 * Math.cos(upper) + 20 * Math.cos(lower)));
  }
  return { hip, feet, hands, lean, front: 0 };
}

/** Standing at rest, hip at x, feet on floor. */
export function standing(x: number, floor: number): PersonPose {
  const hip = P(x, floor - 52.5), sx = x + 4;
  const f0: Pt = P(x + 5, floor - 4), f1: Pt = P(x - 4, floor - 4); f0.roll = 0; f1.roll = 0;
  return { hip, feet: [f0, f1], hands: [P(sx + 3, hip.y + 8), P(sx + 1, hip.y + 9)], lean: 2, front: 0 };
}

export function mixPose(a: PersonPose, b: PersonPose, u: number): PersonPose {
  const pt = (p: Pt, q: Pt) => { const r = between(p, q, u); r.roll = mix(p.roll ?? 0, q.roll ?? 0, u); return r; };
  return {
    hip: pt(a.hip, b.hip), feet: a.feet.map((f, i) => pt(f, b.feet[i])), hands: a.hands.map((h, i) => pt(h, b.hands[i])),
    lean: mix(a.lean, b.lean, u), front: mix(a.front, b.front, u),
  };
}

/** Bring both hands to the chest to hold a file. */
function holdPose(p: PersonPose, u: number): PersonPose {
  if (u <= 0) return p;
  const sh = P(p.hip.x + p.lean + 2, p.hip.y - 29);
  return { ...p, hands: [between(p.hands[0], P(sh.x + 15, sh.y + 19), u), between(p.hands[1], P(sh.x + 13, sh.y + 21), u)] };
}

/** A mug of tea with steam; raised to the mouth as `sip` goes to 1. */
export function heldMug(g: Ctx, p: PersonPose, sip: number, time: number) {
  const sh = P(p.hip.x + p.lean + 2, p.hip.y - 29);
  const x = mix(sh.x + 17, sh.x + 13, sip), y = mix(sh.y + 15, sh.y - 9, sip);
  g.fillStyle = '#f2efe6'; g.fillRect(x - 5, y - 7, 10, 11);
  g.fillStyle = '#c0392b'; g.fillRect(x - 5, y - 4, 10, 2);
  g.strokeStyle = '#f2efe6'; g.lineWidth = 2; g.beginPath(); g.arc(x + 6, y - 1, 3, -1.4, 1.4); g.stroke();
  g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 1.4;
  for (let i = 0; i < 2; i++) {
    const o = (time * 0.8 + i * 0.5) % 1;
    g.globalAlpha = 1 - o; g.beginPath(); g.moveTo(x - 2 + i * 4, y - 9 - o * 12);
    g.quadraticCurveTo(x + 2 + i * 4, y - 13 - o * 12, x - 1 + i * 4, y - 17 - o * 12); g.stroke();
  }
  g.globalAlpha = 1;
}

export function heldFile(g: Ctx, p: PersonPose, color: FileColor) {
  const sh = P(p.hip.x + p.lean + 2, p.hip.y - 29);
  folder(g, sh.x + 17, sh.y + 15, FILE_HEX[color], color[0].toUpperCase(), 1.05);
}

const approach = (v: number, target: number, rate: number, dt: number) =>
  v + (target - v) * Math.min(1, rate * dt);

export class InspectorView implements CharacterView<BodyState> {
  private distance = 0;
  private moving = 0;
  private air = 0;
  private rise = 0;
  private land = 0;
  private hold = 0;
  private sip = 0;
  private clock = 0;
  private state: BodyState = { x: 0, y: 0, vx: 0, vy: 0, grounded: true, facing: 1, carrying: null };

  update(dt: number, s: BodyState) {
    if (s.grounded && !this.state.grounded) this.land = 1;
    this.state = { ...s };
    this.distance += Math.abs(s.vx) * dt / RIG_SCALE;
    this.moving = approach(this.moving, s.grounded && Math.abs(s.vx) > 6 ? 1 : 0, 10, dt);
    this.air = approach(this.air, s.grounded ? 0 : 1, s.grounded ? 22 : 14, dt);
    this.rise = approach(this.rise, s.vy < 0 ? 1 : 0, 8, dt);
    this.land = Math.max(0, this.land - dt / .16);
    this.hold = approach(this.hold, s.carrying || s.holding ? 1 : 0, 14, dt);
    this.clock += dt;
    const sipping = s.holding === 'tea' && this.moving < .2 && this.clock % 4.5 > 3.2;
    this.sip = approach(this.sip, sipping ? 1 : 0, 6, dt);
  }

  /** The pose in local native units: hip above x = 0, feet on y = 0. */
  pose(): PersonPose {
    let p = mixPose(standing(0, 0), (() => {
      const w = human(this.distance, 0, 0), dx = -this.distance;
      return {
        hip: P(w.hip.x + dx, w.hip.y),
        feet: w.feet.map(f => ({ ...f, x: f.x + dx })),
        hands: w.hands.map(h => P(h.x + dx, h.y)), lean: w.lean, front: 0,
      };
    })(), this.moving);
    if (this.air > 0.001) {
      const hy = -56 - 4 * this.rise, sh = P(4, hy - 29);
      const f0: Pt = P(9, hy + 40 - 6 * this.rise), f1: Pt = P(-7, hy + 44 - 4 * this.rise);
      f0.roll = .35; f1.roll = -.2;
      const jump: PersonPose = {
        hip: P(0, hy), feet: [f0, f1], lean: 4,
        hands: [P(sh.x + mix(17, 14, this.rise), sh.y + mix(14, -4, this.rise)), P(sh.x + mix(-13, -6, this.rise), sh.y + mix(10, 18, this.rise))],
        front: 0,
      };
      p = mixPose(p, jump, this.air);
    }
    if (this.land > 0) p.hip = P(p.hip.x, p.hip.y + 6 * Math.sin(this.land * Math.PI));
    p = holdPose(p, this.hold);
    if (this.sip > 0) {
      const sh = P(p.hip.x + p.lean + 2, p.hip.y - 29);
      p.hands = [between(p.hands[0], P(sh.x + 11, sh.y - 4), this.sip), p.hands[1]];
    }
    return p;
  }

  draw(g: Ctx, _time: number) {
    const s = this.state, p = this.pose();
    g.save();
    g.translate(s.x, s.y); g.scale(RIG_SCALE * s.facing, RIG_SCALE);
    const held = s.carrying ? () => heldFile(g, p, s.carrying!)
      : s.holding === 'tea' ? () => heldMug(g, p, this.sip, _time) : undefined;
    drawPerson(g, p, held);
    g.restore();
  }
}

// The amber loader: rig drawing, planted heavy stride, boarding and the game adapter.
import { FILE_HEX, type CharacterView, type LoaderState } from './api';
import {
  type Ctx, type Pt, P, between, mix, keys, ease, clamp, poly, rect, disc, beam, label, bolt, hydraulic, limb,
  projectedJoint, walk, bob, rig, ink, steel, light, gold, shade, green, folder,
} from './draw';
import { RIG_SCALE, drawPerson, human, standing, mixPose, type PersonPose } from './inspector';

export interface MachinePose {
  hip: Pt; feet: Pt[]; hands: Pt[]; lean: number; front: number;
  power: number; grip: number; belt?: number;
}

/**
 * Draw the loader from a solved pose (native units). `pilot` is drawn seated in the cage;
 * `held` draws just before the near arm, so a carried file sits in its claws.
 * `facing` only keeps the stencilled "07" readable when the caller mirrors the drawing.
 */
export function drawMachine(g: Ctx, s: MachinePose, pilot: PersonPose | null, time: number, held?: () => void, facing: 1 | -1 = 1) {
  const { hip: H, feet, hands, power, lean, front } = s, x = H.x, y = H.y;
  const frame = (profile: number, frontal: number, height: number) => P(x + mix(profile, frontal, front), y + height);
  function leg(i: number) {
    const side = i ? -1 : 1, f = feet[i], a = frame(i ? 4 : -9, side * 19, 0), ank = P(f.x, f.y - 9);
    const k = projectedJoint(a, ank, rig.loader.leg, -1, front, side * 3), c = i ? gold : shade;
    hydraulic(g, P(k.x - 13, k.y + 2), P(f.x - 11, f.y - 9), i ? steel : ink); limb(g, a, k, c, 14); limb(g, k, ank, c, 10); bolt(g, k, 11, c);
    const tip = mix(25, 16, front);
    poly(g, ink, f.x - 16, f.y, f.x - 14, f.y - 11, f.x + 4, f.y - 13, f.x + tip - 1, f.y - 6, f.x + tip, f.y);
    poly(g, c, f.x - 14, f.y - 5, f.x - 10, f.y - 13, f.x + 4, f.y - 14, f.x + tip - 3, f.y - 7, f.x + tip - 7, f.y - 4);
  }
  function arm(i: number) {
    const side = i ? -1 : 1, a = frame(lean + (i ? 27 : 12), side * 37, -48 + (i ? 0 : -3) * (1 - front)), h = hands[i];
    const k = projectedJoint(a, h, rig.loader.arm, 1, front, side * 9), c = i ? gold : shade;
    hydraulic(g, P(a.x - 6, a.y + 10), P(k.x - 8, k.y + 3), steel); limb(g, a, k, c, 12); limb(g, k, h, c, 10); bolt(g, a, 13, c); bolt(g, k, 10, c);
    const spread = 11 - s.grip * 6; rect(g, ink, h.x - 5, h.y - 7, 12, 15);
    for (const j of [-1, 1]) {
      const tip = P(h.x + mix(13, j * spread, front), h.y + mix(j * spread, 13, front));
      beam(g, c, h, tip, 4, 3); beam(g, ink, tip, P(tip.x + mix(6, -j * 4, front), tip.y + mix(-j * 4, 6, front)), 3, 2);
    }
  }
  leg(0); arm(0);
  const tray = frame(-23, 0, -13), back = frame(-30 + lean, 0, -74);
  beam(g, ink, tray, back, 12 + front * 8); beam(g, steel, tray, back, 8 + front * 8);
  const casing = frame(-28 + lean, -17, -66); rect(g, shade, casing.x - 5, casing.y, 9, 43);
  for (let j = 0; j < 3; j++) rect(g, ink, casing.x - 5, casing.y + 5 + j * 6, 7, 2);
  const cage = [frame(-19, -25, -12), frame(-21 + lean, -29, -80), frame(-8 + lean, -18, -94), frame(17 + lean, 18, -94), frame(28 + lean, 29, -74), frame(18, 25, -13)];
  for (let i = 1; i < cage.length; i++) beam(g, i === 5 ? shade : gold, cage[i - 1], cage[i], i === 5 ? 3 : 4);
  const lamp = frame(-3 + lean, 0, -99); rect(g, ink, lamp.x - 6, lamp.y, 12, 5);
  disc(g, power > .5 ? green : shade, P(lamp.x, lamp.y - 1 + Math.sin(time * 9) * power), 3);
  for (let i = 0; i < 2; i++) { const plate = between(P(x + 2, y - 13), feet[i], .44); rect(g, steel, plate.x - 8, plate.y + 2, 17, 4); }
  if (pilot) drawPerson(g, pilot);
  leg(1); poly(g, gold, x - 22, y - 13, x + 12, y - 16, x + 22, y - 6, x + 13, y + 7, x - 16, y + 7);
  if (facing < 0) { g.save(); g.translate(x - 8, 0); g.scale(-1, 1); g.translate(-(x - 8), 0); }
  label(g, '07', x - 15, y + 2, 12, ink, 800);
  if (facing < 0) g.restore();
  if (s.belt) {
    const a = P(x - 9, y - 52), b = P(x + 7, y - 19);
    beam(g, steel, a, between(a, b, s.belt), 2.4); disc(g, light, between(a, b, s.belt), 2);
    const lap = ease(.55, 1, s.belt); beam(g, steel, P(x - 12, y - 20), P(x - 12 + 24 * lap, y - 20), 2);
  }
  held?.();
  arm(1);
}

/** The inspector seated in the cage, following the machine's bob. */
export function pilotPose(s: MachinePose, phase: number): PersonPose {
  const h = P(s.hip.x + 2, s.hip.y - 13 + 1.4 * Math.sin(phase * 6.283 - .35)), shoulder = P(h.x + 2, h.y - 29);
  return { hip: h, feet: s.feet.map(p => between(h, p, .44)), hands: s.hands.map(p => between(shoulder, p, .43)), lean: s.lean * .55, front: s.front };
}

/** Loader stride length in native units. */
export const LOADER_STRIDE = 104;

const approach = (v: number, target: number, rate: number, dt: number) => v + (target - v) * Math.min(1, rate * dt);

export class LoaderView implements CharacterView<LoaderState> {
  /** Fired when a foot plants while walking (heavy footfall). */
  onStomp?: () => void;
  /** Fired when the loader lands from a jump or fall. */
  onLand?: () => void;

  private distance = 0;
  private moving = 0;
  private air = 0;
  private airTime = 0;
  private land = 0;
  private grip = 0;
  private belt = 0;
  private plants = [0, 0];
  private state: LoaderState = { x: 0, y: 0, vx: 0, vy: 0, grounded: true, facing: 1, carrying: null, piloted: false, power: 0 };

  update(dt: number, s: LoaderState) {
    const wasGrounded = this.state.grounded;
    this.state = { ...s };
    if (s.grounded && !wasGrounded) { this.land = 1; this.onLand?.(); }
    this.airTime = s.grounded ? 0 : this.airTime + dt;
    this.distance += Math.abs(s.vx) * dt / RIG_SCALE;
    this.moving = approach(this.moving, s.grounded && Math.abs(s.vx) > 6 ? 1 : 0, 9, dt);
    this.air = approach(this.air, s.grounded ? 0 : 1, s.grounded ? 20 : 12, dt);
    this.land = Math.max(0, this.land - dt / .24);
    this.grip = approach(this.grip, s.carrying ? 1 : 0, 12, dt);
    this.belt = approach(this.belt, s.piloted ? 1 : 0, 5, dt);
    for (let i = 0; i < 2; i++) {
      const n = Math.floor(this.distance / LOADER_STRIDE + i * .5);
      if (n !== this.plants[i]) { this.plants[i] = n; if (s.grounded && this.moving > .5) this.onStomp?.(); }
    }
  }

  /** The machine pose in local native units: hip above x = 0, feet on y = 0. */
  pose(front = 0): MachinePose {
    const s = this.state, d = this.distance, m = this.moving, power = s.power, phase = d / LOADER_STRIDE;
    let feet = [0, 1].map(i => {
      const f = walk(d, 0, LOADER_STRIDE, i, true, 0);
      return P(f.x - d, mix(0, f.y, m));
    });
    let hipY = -76 - 15 * power + m * 5 * keys(phase * 2 % 1, bob);
    if (this.air > .001) {
      // Legs tuck under the body in the air; a short push-off keeps them long for the first instant.
      const tuck = this.air * ease(.04, .16, this.airTime);
      feet = feet.map((f, i) => P(mix(f.x, i ? -10 : 26, tuck), mix(f.y, -24 - (i ? 0 : 6), tuck)));
      hipY -= 8 * tuck;
    }
    if (this.land > 0) hipY += 14 * Math.sin(this.land * Math.PI);
    const H = P(0, hipY), lean = 2 + m * 2 * Math.sin(phase * 6.283);
    let hands = [0, 1].map(i => P((i ? 25 : 7) + power * 20 + (i ? 1 : -1) * 10 * m * Math.cos(phase * 6.283), H.y + 35 - power * 55));
    if (this.grip > .001) hands = hands.map((h, i) => between(h, P(i ? 66 : 56, H.y - (i ? 22 : 26)), this.grip));
    if (front > 0) {
      // A quarter turn on two successive foot contacts (see the motion study).
      const turn = 1 - front, turning = Math.sin(turn * Math.PI);
      H.x += 3 * turning; H.y -= 2 * turning;
      feet = feet.map((f, i) => {
        const pivot = ease(i * .47, .53 + i * .47, turn);
        return P(mix(H.x - 3 * turning + (i ? -28 : 28), f.x, pivot), f.y - 7 * Math.sin(Math.PI * pivot));
      });
      hands = hands.map((h, i) => between(h, P(H.x + (i ? -1 : 1) * (46 + 8 * power), H.y + 33 - 37 * power), front));
    }
    return { hip: H, feet, hands, lean, front, power, grip: this.grip, belt: this.belt };
  }

  private phase() { return this.distance / LOADER_STRIDE; }

  private held(g: Ctx, p: MachinePose) {
    const c = this.state.carrying;
    if (!c) return undefined;
    return () => {
      const h = p.hands[1];
      g.save(); g.globalAlpha = clamp(this.grip * 1.5);
      folder(g, h.x + 12, h.y - 4, FILE_HEX[c], c[0].toUpperCase(), 1.6);
      g.restore();
    };
  }

  draw(g: Ctx, time: number) {
    const s = this.state, p = this.pose();
    g.save();
    g.translate(s.x, s.y); g.scale(RIG_SCALE * s.facing, RIG_SCALE);
    drawMachine(g, p, s.piloted ? pilotPose(p, this.phase()) : null, time, this.held(g, p), s.facing);
    g.restore();
  }

  /** Where the ocelot sits on the cage roof, in canvas coordinates. */
  roofAnchor(): { x: number; y: number } {
    const s = this.state, p = this.pose();
    return { x: s.x + s.facing * RIG_SCALE * (12 + p.lean), y: s.y + RIG_SCALE * (p.hip.y - 96) };
  }

  /**
   * Draw the boarding choreography instead of draw() for this frame.
   * u: 0 = inspector standing on the ground at inspectorX, 1 = seated (play 1 -> 0 to dismount).
   * The loader turns to face the camera, the inspector walks in, grabs the rails, climbs
   * one foot at a time, settles and the loader turns back to profile.
   */
  drawBoarding(g: Ctx, u: number, inspectorX: number, time: number) {
    const s = this.state, sc = RIG_SCALE * s.facing;
    const ix = (inspectorX - s.x) / sc, stand = -6;
    // Phases: walk in (0-.3), climb (.3-.85, the motion study's 5.0s-7.8s), turn back (.85-1).
    const loaderFront = ease(0, .25, u) * (1 - ease(.86, 1, u));
    const L = this.pose(loaderFront);
    const t = 5 + 2.8 * clamp((u - .3) / .55);
    const mount = (a: number, b: number) => ease(a, b, t);
    const walkU = ease(0, .3, u), hx = mix(ix, stand, walkU), dir: 1 | -1 = stand >= ix ? 1 : -1;
    const turnToCamera = ease(.16, .3, u);

    g.save();
    g.translate(s.x, s.y); g.scale(sc, RIG_SCALE);
    const lift = mount(5.65, 7.45);
    const inside = pilotPose({ ...L, front: 1 }, 0);
    if (lift > .96 || u >= 1) {
      const seated = pilotPose(L, this.phase());
      drawMachine(g, { ...L, belt: ease(.85, 1, u) }, mixPose(inside, seated, ease(.86, 1, u)), time, undefined, s.facing);
      g.restore();
      return;
    }
    drawMachine(g, L, null, time, undefined, s.facing);
    if (u < .3) {
      // Walking in, gait driven by distance covered; mirrored if approaching from the right.
      const walked = Math.abs(hx - ix), w = human(walked, 0, 0), mv = 1 - ease(.22, .3, u);
      const local: PersonPose = {
        hip: P(w.hip.x - walked, w.hip.y), feet: w.feet.map(f => ({ ...f, x: f.x - walked })),
        hands: w.hands.map(h => P(h.x - walked, h.y)), lean: w.lean, front: 0,
      };
      const pose = mixPose(standing(0, 0), local, mv);
      pose.front = turnToCamera;
      g.save(); g.translate(hx, 0); g.scale(dir, 1);
      drawPerson(g, pose);
      g.restore(); g.restore();
      return;
    }
    // Climbing: the motion study's mount, condensed.
    const h = standing(stand, 0); h.front = 1;
    let hip = between(h.hip, inside.hip, lift);
    hip = P(hip.x, hip.y + 6 * Math.sin(lift * Math.PI * 2));
    const feet = h.feet.map((f, i) => {
      const v = mount(5.35 + i * .8, 6.45 + i * .8), q = between(f, inside.feet[i], v);
      q.y -= 12 * Math.sin(v * Math.PI); q.roll = (f.roll ?? 0) * (1 - v); return q;
    });
    const lean = mix(h.lean, inside.lean, lift) + 5 * Math.sin(lift * Math.PI);
    const shoulder = P(hip.x + lean + 2, hip.y - 29);
    const hands = h.hands.map((p, i) => {
      const rail = P(L.hip.x + (i ? -1 : 1) * 25, -93 - i * 4);
      const grab = mount(5 + i * .15, 5.9 + i * .15), guide = mount(6.6 + i * .18, 7.6 + i * .18);
      const target = between(between(p, rail, grab), inside.hands[i], guide);
      const socket = P(shoulder.x + (i ? -8 : 8) - 2, shoulder.y);
      const length = Math.hypot(target.x - socket.x, target.y - socket.y);
      return between(socket, target, Math.min(1, 40.99 / (length || 1)));
    });
    drawPerson(g, { hip, feet, hands, lean, front: 1 });
    g.restore();
  }
}

/** Convenience wrapper matching the contract's wording. */
export function drawBoarding(g: Ctx, u: number, inspectorX: number, loader: LoaderView, time: number) {
  loader.drawBoarding(g, u, inspectorX, time);
}

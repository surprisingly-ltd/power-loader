// Automated chapters: loaders on autopilot, the fleet, and native integration.
// Everything here runs on simple timed schedules so each sequence is deterministic
// and replays identically after a restart.
import type { FileColor } from '../rig/api';
import { LoaderView } from '../rig/loader';
import type { LoaderViewLike } from './views';
import { DECKS, DISPENSERS, FLOOR_Y, SLOT_X, TERMINAL_X, type Platform } from './level';
import { makeBody, step, type Body, type Tuning } from './physics';

const ALL_COLORS: FileColor[] = ['red', 'blue', 'green', 'purple'];

export interface Beamer {
  beam(color: FileColor, counts: boolean, from: AutoLoader): void;
}

/** A loader that patrols between two points and beams a file on a fixed beat. */
export class AutoLoader {
  power = 0;
  active = false;
  onJump?: () => void;
  protected target: number;
  private nextBeam = 0;
  private colorIndex: number;

  constructor(
    readonly body: Body,
    readonly view: LoaderViewLike,
    readonly from: number,
    readonly to: number,
    readonly every: number,
    readonly colors: FileColor[],
    offset: number,
  ) {
    this.target = to;
    this.nextBeam = offset;
    this.colorIndex = Math.floor(offset * 7) % colors.length;
  }

  update(dt: number, tuning: Tuning, solids: Platform[], decks: Platform[], time: number, out: Beamer, counts: boolean, beaming = true) {
    const b = this.body;
    this.power = Math.min(1, Math.max(0, this.power + (this.active ? dt / 0.5 : -dt / 0.8)));
    let move = 0;
    if (this.active && b.grounded) {
      if (Math.abs(this.target - b.x) < 6) this.target = this.target === this.to ? this.from : this.to;
      move = Math.sign(this.target - b.x) * 0.55;
    }
    step(b, tuning, { move, jumpPressed: false, jumpHeld: false, drop: false }, solids, decks, dt, time);
    this.view.update(dt, { ...b, carrying: null, piloted: false, power: this.power });
    if (this.active && beaming && b.grounded) {
      this.nextBeam -= dt;
      if (this.nextBeam <= 0) {
        this.nextBeam += this.every;
        out.beam(this.colors[this.colorIndex++ % this.colors.length], counts, this);
      }
    }
  }
}

/**
 * The route a player would take with the mounted loader. Each step either walks
 * to an x (optionally on a given surface) or jumps toward `dir` once grounded on
 * `from`. `beam` marks arrival at a dispenser: stop, then beam that colour.
 */
export type RouteStep =
  | { walk: number; on?: string }
  | { jumpAt: number; dir: 1 | -1; from: string }
  | { beam: FileColor };

/** Where a loader stands to use each dispenser. */
export const STAND: Record<FileColor, { x: number; deck: string }> = {
  red: { x: 786, deck: 'red' },
  blue: { x: 1152, deck: 'blue' },
  green: { x: 704, deck: 'green' },
  purple: { x: 482, deck: 'purple' },
};

/**
 * Direct journeys between dispensers, each starting at the `from` stand. They are
 * the moves a player makes: hops up, walking off a deck edge to drop down, and the
 * floor route over the pipe. Other journeys chain these through the bay.
 */
const LEGS: Partial<Record<`${FileColor}>${FileColor}`, RouteStep[]>> = {
  'red>blue': [{ jumpAt: 884, dir: 1, from: 'red' }, { walk: STAND.blue.x, on: 'blue' }],
  'blue>red': [{ walk: STAND.red.x, on: 'red' }],
  'blue>green': [
    { jumpAt: 1010, dir: -1, from: 'blue' }, { jumpAt: -1, dir: -1, from: 'step' }, { walk: STAND.green.x, on: 'green' },
  ],
  'green>blue': [{ walk: STAND.blue.x, on: 'blue' }],
  'green>purple': [{ jumpAt: 606, dir: -1, from: 'green' }, { walk: STAND.purple.x, on: 'purple' }],
  'green>red': [{ walk: 500, on: 'floor' }, { jumpAt: 540, dir: 1, from: 'floor' }, { walk: STAND.red.x, on: 'red' }],
  'purple>green': [{ walk: STAND.green.x, on: 'green' }],
  'purple>red': [{ walk: 300, on: 'floor' }, { jumpAt: 540, dir: 1, from: 'floor' }, { walk: STAND.red.x, on: 'red' }],
};

/** Shortest chain of direct journeys from one dispenser to another. */
export function journey(from: FileColor, to: FileColor): RouteStep[] {
  const prev = new Map<FileColor, FileColor>([[from, from]]);
  const queue: FileColor[] = [from];
  while (queue.length) {
    const c = queue.shift()!;
    for (const k of Object.keys(LEGS) as `${FileColor}>${FileColor}`[]) {
      const [a, b] = k.split('>') as [FileColor, FileColor];
      if (a === c && !prev.has(b)) { prev.set(b, a); queue.push(b) }
    }
  }
  const hops: FileColor[] = [to];
  while (hops[0] !== from) hops.unshift(prev.get(hops[0])!);
  const steps: RouteStep[] = [];
  for (let i = 1; i < hops.length; i++) steps.push(...LEGS[`${hops[i - 1]}>${hops[i]}`]!);
  return steps;
}

/** A looping tour: beam at each colour in `order`, travelling between them as a player would. */
export function buildTour(order: FileColor[]): RouteStep[] {
  const steps: RouteStep[] = [];
  order.forEach((c, i) => {
    steps.push({ beam: c });
    steps.push(...journey(c, order[(i + 1) % order.length]));
  });
  return steps;
}

/** Steps to reach a colour's stand from wherever the loader starts, then the tour. */
export function tourFrom(start: RouteStep[], order: FileColor[]): RouteStep[] {
  return [...start, ...buildTour(order)];
}

/** The original loader: over the pipe to red, then red, blue, green, purple, round again. */
export const TOUR: RouteStep[] = [
  { jumpAt: 540, dir: 1, from: 'floor' },
  { walk: STAND.red.x, on: 'red' },
  ...buildTour(['red', 'blue', 'green', 'purple']),
];

/** Follows TOUR with the same physics and jumps as the player. */
export class RouteRunner {
  i = 0;
  private wait = 0;

  /** Index the tour loops back to (after any lead-in steps). */
  constructor(readonly tour: RouteStep[] = TOUR, readonly loopFrom = 2) {}

  reset(at = 0) { this.i = at; this.wait = 0 }

  /** Returns the move/jump intent for this step, and a colour to beam if due. */
  drive(b: Body, dt: number): { move: number; jump: boolean; beam: FileColor | null } {
    const st = this.tour[this.i];
    const advance = () => { this.i = this.i + 1 < this.tour.length ? this.i + 1 : this.loopFrom };
    if ('beam' in st) {
      if (!b.grounded) return { move: 0, jump: false, beam: null };
      this.wait += dt;
      if (this.wait < 0.3) return { move: 0, jump: false, beam: null };
      this.wait = 0;
      advance();
      return { move: 0, jump: false, beam: st.beam };
    }
    if ('walk' in st) {
      const dx = st.walk - b.x;
      const onIt = !st.on || (b.grounded && b.ground === st.on);
      if (Math.abs(dx) < 8 && onIt) { advance(); return { move: 0, jump: false, beam: null } }
      // Keep walking toward the x; if we've reached it but on the wrong surface, keep the direction.
      return { move: Math.abs(dx) < 8 ? 0 : Math.sign(dx), jump: false, beam: null };
    }
    // jumpAt: walk to the take-off x on the given surface, then jump while moving `dir`.
    if (!b.grounded) return { move: st.dir, jump: false, beam: null };
    if (b.ground !== st.from) {
      // We left the take-off surface without jumping (fell): skip ahead.
      advance();
      return { move: st.dir, jump: false, beam: null };
    }
    const dx = st.jumpAt - b.x;
    if (st.jumpAt < 0 || Math.abs(dx) < 10 || Math.sign(dx) !== st.dir) {
      advance();
      return { move: st.dir, jump: true, beam: null };
    }
    return { move: Math.sign(dx), jump: false, beam: null };
  }
}

/** A loader that runs the player's route on its own and beams at each dispenser. */
export class TourLoader extends AutoLoader {
  runner = new RouteRunner();
  /** Walking pace relative to the player, so a fleet spreads out. */
  pace = 1;
  private jumpHold = 0;

  update(dt: number, tuning: Tuning, solids: Platform[], decks: Platform[], time: number, out: Beamer, counts: boolean, beaming = true) {
    const b = this.body;
    this.power = Math.min(1, Math.max(0, this.power + (this.active ? dt / 0.5 : -dt / 0.8)));
    let move = 0, jumpPressed = false;
    if (this.active) {
      const d = this.runner.drive(b, dt);
      move = d.move * this.pace;
      if (d.jump) { jumpPressed = true; this.jumpHold = 0.3 }
      if (d.beam && beaming) out.beam(d.beam, counts, this);
    }
    this.jumpHold = Math.max(0, this.jumpHold - dt);
    const ev = step(b, tuning, { move, jumpPressed, jumpHeld: this.jumpHold > 0, drop: false }, solids, decks, dt, time);
    if (ev.jumped) this.onJump?.();
    this.view.update(dt, { ...b, carrying: null, piloted: false, power: this.power });
  }
}

/** Each fleet loader runs its own order, from its own deck, at its own pace. */
const FLEET_ORDERS: FileColor[][] = [
  ['green', 'purple', 'red', 'blue'],
  ['green', 'blue', 'red'],
  ['red', 'blue', 'green', 'purple'],
  ['blue', 'green', 'red'],
  ['blue', 'red', 'blue', 'green', 'purple'],
  ['purple', 'green', 'blue', 'red'],
];

export function fleetLoader(home: { x: number; range: number; deck: string }, i: number, _colors: FileColor[]) {
  // Drop in from just above the home deck so each lands on its own deck.
  const body = makeBody(home.x, DECKS[home.deck].y - 150, i % 2 ? -1 : 1);
  body.grounded = false;
  body.ground = null;
  const a = new TourLoader(body, new LoaderView(), home.x, home.x, 1, ALL_COLORS, 0);
  const order = FLEET_ORDERS[i % FLEET_ORDERS.length];
  // Lead-in: walk to the first stand on the home deck, then loop the tour.
  a.runner = new RouteRunner([{ walk: STAND[order[0]].x, on: home.deck }, ...buildTour(order)], 1);
  a.pace = [0.92, 0.84, 1, 0.88, 0.96, 0.8][i % 6];
  return a;
}

// ------------------------------------------------------------ native routes
export type Pt = { x: number; y: number };

export function dispenserMouth(c: FileColor): Pt {
  const d = DISPENSERS[c];
  return { x: d.x - 28, y: DECKS[d.deck].y - 112 };
}

/** Direct tube from a dispenser's feed up to a ceiling lane, across, and down into its slot. */
export function tubeRoute(c: FileColor, lane: number): Pt[] {
  const m = dispenserMouth(c), sx = SLOT_X[c], y = 62 + lane * 13;
  return [m, { x: m.x, y }, { x: sx, y }, { x: sx, y: FLOOR_Y - 100 }];
}

/** PCB trace from the terminal out to a point, Manhattan style with a 45° jog. */
export function traceRoute(to: Pt, lane: number): Pt[] {
  const sx = TERMINAL_X + 14, sy = FLOOR_Y - 96, y = 120 + lane * 9;
  return [{ x: sx, y: sy }, { x: sx, y: y + 20 }, { x: sx + 20, y }, { x: to.x - 12 * Math.sign(to.x - sx || 1), y }, { x: to.x, y: y + 12 }, to];
}

export function routeLength(p: Pt[]) {
  let L = 0;
  for (let i = 1; i < p.length; i++) L += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
  return L;
}

export function pointAt(p: Pt[], u: number): Pt {
  let d = routeLength(p) * Math.min(1, Math.max(0, u));
  for (let i = 1; i < p.length; i++) {
    const l = Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
    if (d <= l) {
      const t = l ? d / l : 0;
      return { x: p[i - 1].x + (p[i].x - p[i - 1].x) * t, y: p[i - 1].y + (p[i].y - p[i - 1].y) * t };
    }
    d -= l;
  }
  return p[p.length - 1];
}

/** Stroke the first `u` of a polyline. */
export function strokePartial(g: CanvasRenderingContext2D, p: Pt[], u: number) {
  if (u <= 0) return;
  let d = routeLength(p) * Math.min(1, u);
  g.beginPath();
  g.moveTo(p[0].x, p[0].y);
  for (let i = 1; i < p.length && d > 0; i++) {
    const l = Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
    const t = Math.min(1, d / (l || 1));
    g.lineTo(p[i - 1].x + (p[i].x - p[i - 1].x) * t, p[i - 1].y + (p[i].y - p[i - 1].y) * t);
    d -= l;
  }
  g.stroke();
}

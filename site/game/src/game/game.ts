// Gameplay shared by every chapter. All progress lives in `store`; the HUD and
// effects read from it. Chapter differences come from CHAPTERS data only.
import { BOARDING_SECONDS, FILE_HEX, INSPECTOR_BODY, LOADER_BODY, type FileColor } from '../rig/api';
import { Audio } from './audio';
import { CaseLine, type FiledCase } from './cases';
import {
  type AutoLoader, TourLoader, dispenserMouth, fleetLoader, pointAt, strokePartial, traceRoute, tubeRoute, type Pt,
} from './automation';
import {
  AUTOPILOT_PATROL, BANK, CHAPTERS, DECKS, DISPENSERS, FLEET_HOMES, FLOOR_Y, OCELOT, PARK_X, SLOT_X, SOLIDS,
  TEA_X, TERMINAL_X, W, type ChapterDef, type Platform,
} from './level';
import { makeBody, step, type Body, type Intent, type Tuning } from './physics';
import {
  backdrop, bubble, drawBank, drawBeam, drawCrystal, drawDispenser, drawOcelot, drawPerch, drawPlatforms,
  drawTeaTable, drawTerminal, floatText, folder, prompt,
} from './scenery';
import { makeViews, type Views } from './views';

export const NAME: Record<FileColor, string> = { red: 'RED', blue: 'BLUE', green: 'GREEN', purple: 'PURPLE' };
const ALL: FileColor[] = ['red', 'blue', 'green', 'purple'];

const INSPECTOR: Tuning = {
  w: INSPECTOR_BODY.w, h: INSPECTOR_BODY.h, speed: 330, accel: 3200, airAccel: 2400,
  gravity: 2300, jumpVelocity: 760, jumpCut: 0.86,
};
const LOADER: Tuning = {
  w: LOADER_BODY.w, h: LOADER_BODY.h, speed: 300, accel: 2200, airAccel: 1700,
  gravity: 2100, jumpVelocity: 690, jumpCut: 0.9,
};

/** Native integration timeline (seconds after the ocelot enters the terminal). */
const NATIVE = { leap: 0.9, traces: 1.8, pivot: 1.2, flowEvery: 0.3, travel: 1.1 };
const FLOW_START = NATIVE.leap + NATIVE.traces + NATIVE.pivot;
/** Chapter 8: the whole fleet parked in a row along the floor on the right. */
const PARKED_X = [730, 815, 900, 985, 1070, 1155, 1240];

type Phase = 'play' | 'boarding' | 'complete' | 'end';
type Mode = 'foot' | 'riding';

interface Effect {
  kind: 'beam' | 'float';
  t: number;
  dur: number;
  color?: FileColor;
  text?: string;
  hex?: string;
  ax: number; ay: number; bx: number; by: number;
  done?: () => void;
  fired?: boolean;
}

export interface Store {
  chapter: number;
  phase: Phase;
  mode: Mode;
  assignmentIndex: number;
  issued: boolean;
  delivered: number;
  counts: Record<FileColor, number>;
  carrying: FileColor | null;
  learned: Set<FileColor>;
  loaderPresent: boolean;
  ocelotOnRoof: boolean;
  busy: boolean;
  speech: { text: string; t: number; dur: number } | null;
  notice: { text: string; t: number; tone: 'bad' | 'good' } | null;
  feed: Partial<Record<FileColor, number>>;
  flash: Partial<Record<FileColor, number>>;
  effects: Effect[];
  boardT: number;
  titleT: number;
  time: number;
  /** Automated chapters. */
  crystal: boolean;
  tea: boolean;
  bootT: number;
  fleetOn: boolean;
  nativeT: number;
  arrived: number[];
  /** Chapter 8: the ocelot on foot. */
  ocelot: { x: number; y: number; mode: 'roof' | 'hop' | 'walk' | 'ground'; t: number; facing: 1 | -1; fromX: number; fromY: number };
  /** Increments on every chapter (re)start, so stale timers do nothing. */
  epoch: number;
  /** Every file is in; the chapter completes once the last full case is filed. */
  finishing: boolean;
}

type TargetKind = 'ocelot' | 'board' | 'dispenser' | 'slot' | 'beam' | 'crystal' | 'tea' | 'terminal' | 'merge';
interface Target { kind: TargetKind; color?: FileColor; label: string; ok: boolean }

export type Listener = (s: Store) => void;

export class Game {
  readonly audio = new Audio();
  readonly views: Views = makeViews();
  store!: Store;
  inspector!: Body;
  loader!: Body;
  /** The original loader when it runs itself (chapters 6–8). */
  auto: AutoLoader | null = null;
  fleet: AutoLoader[] = [];
  /** Each worker's active case, the chain and the crate. */
  cases!: CaseLine;
  /** Completed cases from every chapter played; restarting a chapter replaces only its own. */
  readonly archive: FiledCase[] = [];
  private timers: { at: number; epoch: number; fn: () => void }[] = [];
  private listeners: Listener[] = [];
  private lastTarget: Target | null = null;
  private beamer = { beam: (c: FileColor, counts: boolean, from: AutoLoader) => this.autoBeam(c, counts, from) };

  constructor() {
    this.views.loader.onStomp = () => { if (this.store.mode === 'riding' || this.auto?.active) this.audio.play('stomp', 0.2) };
    this.start(0);
  }

  get def(): ChapterDef { return CHAPTERS[this.store.chapter] }
  get actor(): Body { return this.store.mode === 'riding' ? this.loader : this.inspector }
  get tuning(): Tuning { return this.store.mode === 'riding' ? LOADER : INSPECTOR }
  get requested(): FileColor | null {
    const s = this.store;
    return s.issued ? this.def.assignments[s.assignmentIndex] ?? null : null;
  }
  get decks(): Platform[] { return this.def.decks.map(id => DECKS[id]) }
  get total(): number { return this.def.kind === 'carry' ? this.def.assignments.length : this.def.files ?? 0 }
  get automated(): boolean { return this.def.kind !== 'carry' }

  onChange(fn: Listener) { this.listeners.push(fn) }
  private changed() { for (const fn of this.listeners) fn(this.store) }

  /** Start or restart a chapter from clean state. */
  start(index: number) {
    const def = CHAPTERS[index];
    const prevEpoch = this.store?.epoch ?? 0;
    this.timers = [];
    const riding = def.start === 'riding';
    this.store = {
      chapter: index, phase: 'play', mode: riding ? 'riding' : 'foot',
      assignmentIndex: 0, issued: false, delivered: 0, counts: { red: 0, blue: 0, green: 0, purple: 0 },
      carrying: null, learned: new Set(def.learned), loaderPresent: def.start !== 'foot',
      ocelotOnRoof: riding || def.kind !== 'carry', busy: false, speech: null, notice: null,
      feed: {}, flash: {}, effects: [], boardT: 0, titleT: 0, time: this.store?.time ?? 0, epoch: prevEpoch + 1,
      crystal: def.start === 'tea', tea: def.start === 'tea', bootT: -1, fleetOn: def.kind === 'native',
      nativeT: -1, arrived: [0, 0, 0, 0],
      ocelot: { x: 0, y: 0, mode: 'roof', t: 0, facing: -1, fromX: 0, fromY: 0 }, finishing: false,
    };
    for (let i = this.archive.length - 1; i >= 0; i--) if (this.archive[i].chapter === index) this.archive.splice(i, 1);
    // One cradle per worker: seven in the fleet chapter (the original loader and six more), otherwise one.
    const sfx = (cue: 'blip' | 'pickup' | 'feed' | 'stomp') => this.audio.play(cue, cue === 'blip' ? 0.05 : 0.09);
    this.cases = new CaseLine(def.caseSize, def.kind === 'fleet' ? 1 + FLEET_HOMES.length : 1, this.archive, index,
      def.kind === 'native' ? 0.3 : 1, sfx);
    this.cases.activate(0, 0.35);
    this.inspector = makeBody(riding ? -200 : def.spawnX, FLOOR_Y, def.start === 'handover' ? -1 : 1);
    const loaderX = riding ? def.spawnX : def.kind === 'native' ? PARKED_X[0] : def.start === 'tea' ? 420 : PARK_X;
    this.loader = makeBody(loaderX, FLOOR_Y, def.start === 'parked' || def.start === 'handover' ? -1 : 1);
    this.auto = null;
    this.fleet = [];
    if (this.automated) {
      this.auto = new TourLoader(this.loader, this.views.loader, AUTOPILOT_PATROL.from, AUTOPILOT_PATROL.to, 0.75, ALL, 0.4);
      this.auto.onJump = () => this.audio.play('jump', 0.2);

      if (def.start === 'tea' && def.kind !== 'native') { this.auto.active = true; this.auto.power = 1 }
      this.fleet = FLEET_HOMES.map((h, i) => fleetLoader(h, i, ALL));
      for (const f of this.fleet) f.view.onLand = () => this.audio.play('stomp', 0.08);
      if (def.kind === 'native') {
        // The fleet is parked in a row on the floor, powered down: nothing else moving.
        this.fleet.forEach((f, i) => {
          f.body.x = PARKED_X[i + 1];
          f.body.y = FLOOR_Y; f.body.facing = -1;
          f.body.grounded = true; f.body.ground = 'floor'; f.body.vy = 0;
          f.active = false; f.power = 0;
        });
        this.loader.facing = -1;
      }
    }
    if (riding) this.later(0.9, () => this.issue());
    else if (def.kind !== 'native') this.later(0.5, () => this.say(def.opening ?? 'Ready when you are. E to talk.'));
    this.changed();
  }

  next() {
    if (this.store.chapter + 1 < CHAPTERS.length) this.start(this.store.chapter + 1);
    else { this.store.phase = 'end'; this.changed() }
  }

  private later(sec: number, fn: () => void) {
    this.timers.push({ at: this.store.time + sec, epoch: this.store.epoch, fn });
  }

  say(text: string) {
    this.store.speech = { text, t: 0, dur: 2.0 + text.length * 0.045 };
    this.audio.play('blip');
  }

  private notice(text: string, tone: 'bad' | 'good' = 'bad') {
    this.store.notice = { text, t: 0, tone };
    if (tone === 'bad') this.audio.play('wrong');
  }

  private issue() {
    const s = this.store, color = this.def.assignments[s.assignmentIndex];
    if (!color) return;
    s.issued = true;
    this.say(this.def.lines[s.assignmentIndex] ?? `${NAME[color]}.`);
    this.changed();
  }

  private complete() {
    const s = this.store;
    if (s.phase !== 'play') return;
    s.phase = 'complete';
    s.busy = false;
    this.audio.play('chapter');
    this.changed();
  }

  /** Finish an automated chapter's sequence immediately. */
  skip() {
    const s = this.store, def = this.def;
    if (!this.automated || s.phase !== 'play') return;
    s.crystal = true; s.tea = true;
    if (def.kind === 'fleet') { s.fleetOn = true; s.bootT = 1 }
    if (def.kind === 'native') { s.nativeT = 99; s.ocelotOnRoof = false; s.ocelot.mode = 'ground'; s.bootT = 1 }
    const files = def.files ?? 0;
    ALL.forEach((c, i) => { s.counts[c] = Math.floor(files / 4) + (i < files % 4 ? 1 : 0) });
    s.delivered = files;
    s.effects = [];
    s.finishing = false;
    this.cases.fileAll(Math.floor(files / def.caseSize), ALL);
    this.complete();
  }

  // ---------------------------------------------------------------- targets
  private onDeck(b: Body, deck: string) { return b.grounded && b.ground === deck }

  target(): Target | null {
    const s = this.store, b = this.actor, riding = s.mode === 'riding', def = this.def;
    if (s.phase !== 'play' || s.busy) return null;
    const onFloor = this.onDeck(b, 'floor');

    if (this.automated) {
      if (def.kind === 'autopilot' && !s.crystal && onFloor && Math.abs(b.x - this.loader.x) < 80) {
        return { kind: 'crystal', label: 'Hand over the Memory Crystal', ok: true };
      }
      if (def.kind === 'autopilot' && !s.tea && onFloor && Math.abs(b.x - TEA_X) < 60) {
        return { kind: 'tea', label: 'Make a cup of tea', ok: true };
      }
      if (def.kind === 'fleet' && s.bootT < 0 && onFloor && Math.abs(b.x - TERMINAL_X) < 70) {
        return { kind: 'terminal', label: 'Copy the crystal to the fleet', ok: true };
      }
      if (def.kind === 'native' && s.nativeT < 0 && s.ocelot.mode === 'ground' && onFloor && Math.abs(b.x - TERMINAL_X) < 70) {
        return { kind: 'merge', label: 'Let the ocelot into the system', ok: true };
      }
      return null;
    }

    if (onFloor && b.x < OCELOT.zoneMaxX + (riding ? 30 : 0) && !s.ocelotOnRoof) {
      if (s.loaderPresent && !riding) return { kind: 'ocelot', label: 'Talk', ok: true };
      if (riding) return { kind: 'ocelot', label: 'Invite the ocelot aboard', ok: true };
      const done = s.assignmentIndex >= def.assignments.length;
      return { kind: 'ocelot', label: s.issued ? 'Ask again' : done ? 'Talk' : 'Get assignment', ok: !s.issued && !done };
    }
    const req = this.requested;
    if (!riding && s.loaderPresent && onFloor && Math.abs(b.x - this.loader.x) < 72) {
      return { kind: 'board', label: 'Board the loader', ok: true };
    }
    for (const color of def.stations) {
      const d = DISPENSERS[color];
      if (!this.onDeck(b, d.deck) || Math.abs(b.x - d.x) > (riding ? 92 : 78)) continue;
      // A learned colour beams straight to its slot from the dispenser: no trip back.
      if (riding && s.learned.has(color)) {
        return { kind: 'beam', color, label: `Beam ${NAME[color]} → ${NAME[color]} slot`, ok: req === color && !s.carrying };
      }
      return { kind: 'dispenser', color, label: `Pick up ${NAME[color]}`, ok: req === color && !s.carrying };
    }
    if (onFloor && s.carrying && b.x > BANK.x - 16 && b.x < BANK.x + BANK.w + 16) {
      let best: FileColor | null = null, dist = Infinity;
      for (const c of def.stations) {
        const dd = Math.abs(SLOT_X[c] - b.x);
        if (dd < dist) { dist = dd; best = c }
      }
      // Forgive a near miss: prefer the matching slot when it's close.
      if (Math.abs(SLOT_X[s.carrying] - b.x) < (riding ? 48 : 34)) best = s.carrying;
      if (best) return { kind: 'slot', color: best, label: `Deposit in ${NAME[best]} slot`, ok: s.carrying === best };
    }
    return null;
  }

  interact() {
    const s = this.store;
    if (s.phase === 'complete') { this.next(); return }
    const t = this.target();
    if (!t) return;
    switch (t.kind) {
      case 'ocelot': return this.talk();
      case 'board': return this.board();
      case 'dispenser': return this.useDispenser(t.color!);
      case 'slot': return this.deposit(t.color!);
      case 'beam': {
        if (!t.ok) return this.useDispenser(t.color!);
        return this.beam(t.color!);
      }
      case 'crystal': return this.handOverCrystal();
      case 'tea': return this.makeTea();
      case 'terminal': return this.bootFleet();
      case 'merge': return this.merge();
    }
  }

  private talk() {
    const s = this.store;
    if (s.loaderPresent && s.mode === 'foot') return this.say('Board the loader first. The big amber one.');
    if (s.mode === 'riding' && !s.ocelotOnRoof) {
      s.ocelotOnRoof = true;
      this.audio.play('board');
      this.say('Room on the roof? Splendid.');
      this.later(1.4, () => this.issue());
      this.changed();
      return;
    }
    if (s.assignmentIndex >= this.def.assignments.length) return this.say('All filed. Onwards.');
    if (s.issued) return this.say(`Still waiting on ${NAME[this.requested!]}. ${DISPENSERS[this.requested!].label}.`);
    this.issue();
  }

  private board() {
    const s = this.store;
    s.phase = 'boarding';
    s.boardT = 0;
    this.audio.play('board');
    this.changed();
  }

  private useDispenser(color: FileColor) {
    const s = this.store;
    if (s.carrying) return this.notice(`Hands full. Deliver the ${NAME[s.carrying]} file first.`);
    if (!s.issued) {
      return this.notice(s.ocelotOnRoof || s.mode === 'riding' ? 'Wait for the ocelot.' : 'Ask the ocelot what to fetch first.');
    }
    const req = this.requested!;
    if (color !== req) return this.notice(`Not this one. The ocelot asked for ${NAME[req]}.`);
    s.carrying = color;
    this.refill(color);
    this.audio.play('pickup');
    this.changed();
  }

  private refill(color: FileColor) {
    this.store.feed[color] = 1;
    this.later(0.12, () => this.audio.play('feed', 0.15));
  }

  private beamEffect(color: FileColor, done: () => void, dur = 0.55) {
    const d = DISPENSERS[color], deckY = DECKS[d.deck].y;
    this.refill(color);
    this.audio.play('beam', 0.12);
    this.store.effects.push({
      kind: 'beam', color, t: 0, dur,
      ax: d.x - 28, ay: deckY - 38, bx: SLOT_X[color], by: FLOOR_Y - 74, done,
    });
  }

  private beam(color: FileColor) {
    const s = this.store;
    s.busy = true;
    s.issued = false;
    this.float('+1 ✓', this.loader.x, this.loader.y - LOADER_BODY.h - 34);
    this.beamEffect(color, () => this.delivered(color), 0.45);
    this.changed();
  }

  private autoBeam(color: FileColor, counts: boolean, from: AutoLoader) {
    const worker = from === this.auto ? 0 : 1 + this.fleet.indexOf(from);
    this.beamEffect(color, () => {
      const s = this.store;
      if (!counts || s.phase !== 'play' || s.delivered >= this.total) return;
      this.tally(color, worker);
      if (s.delivered >= this.total) s.finishing = true;
    }, 0.7);
  }

  /** A file reached its slot: count it and send its light to the worker's active case. */
  private tally(color: FileColor, worker = 0) {
    const s = this.store;
    s.flash[color] = 1;
    s.counts[color]++;
    s.delivered++;
    this.cases.add(worker, color);
    this.audio.play('deposit', 0.1);
    this.changed();
  }

  private deposit(color: FileColor) {
    const s = this.store;
    if (!s.carrying) return this.notice('Nothing to deposit. Fetch a file first.');
    if (color !== s.carrying) return this.notice(`Wrong slot. That's ${NAME[color]}; you're holding ${NAME[s.carrying]}.`);
    s.carrying = null;
    const learning = s.mode === 'riding' && !s.learned.has(color);
    this.float('+1 ✓', SLOT_X[color], FLOOR_Y - 140);
    if (learning) {
      s.learned.add(color);
      this.audio.play('learned');
      this.notice(`Memory Core learned ${NAME[color]}: ${DISPENSERS[color].label} → ${NAME[color]} slot`, 'good');
    }
    this.delivered(color);
  }

  /** A requested file reached its matching slot. */
  private delivered(color: FileColor) {
    const s = this.store;
    this.tally(color);
    s.assignmentIndex++;
    s.issued = false;
    s.busy = false;
    const remaining = this.def.assignments.length - s.assignmentIndex;
    if (remaining === 0) s.finishing = true;
    else if (s.ocelotOnRoof) this.later(0.1, () => this.issue());
    else this.say(remaining === 1 ? 'Filed. One more. Come and see me.' : 'Filed. Come back for the next one.');
    this.changed();
  }

  private handOverCrystal() {
    const s = this.store;
    s.crystal = true;
    this.audio.play('learned');
    this.float('Memory Crystal → ocelot', this.loader.x, this.loader.y - LOADER_BODY.h - 50, '#78e6c8');
    this.later(0.5, () => {
      if (!this.auto) return;
      this.auto.active = true;
      this.audio.play('board');
      this.say(s.tea ? "I'll take it from here." : "I'll take it from here. Kettle's on the left.");
    });
    this.changed();
  }

  private makeTea() {
    const s = this.store;
    s.tea = true;
    this.audio.play('pickup');
    this.say(s.crystal ? 'Milk, no sugar. I remembered.' : 'Lovely. Now hand me the crystal.');
    this.changed();
  }

  private bootFleet() {
    const s = this.store;
    s.bootT = 0;
    this.audio.play('learned');
    this.say('Copying the Memory Crystal to every loader…');
    this.changed();
  }

  private merge() {
    const s = this.store;
    s.nativeT = 0;
    s.ocelot.fromX = s.ocelot.x; s.ocelot.fromY = s.ocelot.y;
    s.bootT = 1;
    this.audio.play('board');
    this.say('Hold my tail.');
    this.changed();
  }

  private float(text: string, x: number, y: number, hex?: string) {
    this.store.effects.push({ kind: 'float', text, hex, t: 0, dur: 1.1, ax: x, ay: y, bx: 0, by: 0 });
  }

  // ---------------------------------------------------------------- update
  update(dt: number, intent: Intent, interactPressed: boolean) {
    const s = this.store;
    s.time += dt;
    for (const tm of [...this.timers]) {
      if (tm.epoch !== s.epoch) { this.timers.splice(this.timers.indexOf(tm), 1); continue }
      if (s.time >= tm.at) { this.timers.splice(this.timers.indexOf(tm), 1); tm.fn() }
    }
    s.titleT += dt;
    if (s.speech) { s.speech.t += dt; if (s.speech.t > s.speech.dur) s.speech = null }
    if (s.notice) { s.notice.t += dt; if (s.notice.t > 2.2) s.notice = null }
    for (const k of Object.keys(s.feed) as FileColor[]) s.feed[k] = Math.max(0, (s.feed[k] ?? 0) - dt / 0.5);
    for (const k of Object.keys(s.flash) as FileColor[]) s.flash[k] = Math.max(0, (s.flash[k] ?? 0) - dt / 0.5);
    for (const e of [...s.effects]) {
      e.t += dt;
      if (e.kind === 'beam' && !e.fired && e.t >= e.dur * 0.75) { e.fired = true; e.done?.() }
      if (e.t >= e.dur) s.effects.splice(s.effects.indexOf(e), 1);
    }

    const idle: Intent = { move: 0, jumpPressed: false, jumpHeld: false, drop: false };
    if (s.phase === 'boarding') {
      s.boardT += dt / BOARDING_SECONDS;
      if (s.boardT >= 1) {
        s.phase = 'play';
        s.mode = 'riding';
        s.loaderPresent = false;
        this.inspector.x = -200;
        this.say('Now come and fetch me.');
        this.changed();
      }
    }
    const playing = s.phase === 'play';
    const solids = SOLIDS, decks = this.decks;
    if (s.mode === 'foot') {
      const ev = step(this.inspector, INSPECTOR, playing ? intent : idle, solids, decks, dt, s.time);
      if (ev.jumped) this.audio.play('jump');
    }
    if (this.auto) {
      const native = this.def.kind === 'native';
      if (native) this.auto.active = false;
      this.auto.update(dt, LOADER, solids, decks, s.time, this.beamer, !native && playing, playing);
    } else if (s.mode === 'riding' || s.loaderPresent) {
      const ev = step(this.loader, LOADER, playing && s.mode === 'riding' ? intent : idle, solids, decks, dt, s.time);
      if (ev.jumped) this.audio.play('jump');
      if (ev.landed && ev.landingSpeed > 250) this.audio.play('stomp');
    }
    this.updateAutomation(dt, playing);
    this.cases.update(dt);
    if (s.finishing && playing && !this.cases.busy) { s.finishing = false; this.later(0.35, () => this.complete()) }

    this.views.inspector.update(dt, {
      ...this.inspector, carrying: s.mode === 'foot' ? s.carrying : null, holding: s.tea ? 'tea' : null,
    });
    if (!this.auto) {
      this.views.loader.update(dt, {
        ...this.loader, carrying: s.mode === 'riding' ? s.carrying : null,
        piloted: s.mode === 'riding', power: s.mode === 'riding' ? 1 : s.phase === 'boarding' ? s.boardT : 0,
      });
    }
    if (playing && interactPressed) this.interact();
    else if (s.phase === 'complete' && interactPressed) this.next();
    this.lastTarget = this.target();
  }

  private updateAutomation(dt: number, playing: boolean) {
    const s = this.store, def = this.def;
    if (!this.automated) return;
    if (def.kind === 'fleet' && s.bootT >= 0 && s.bootT < 1) {
      s.bootT = Math.min(1, s.bootT + dt / 1.1);
      if (s.bootT >= 1) {
        s.fleetOn = true;
        this.audio.play('board');
        for (const f of this.fleet) f.active = true;
        this.fleet.forEach((_, i) => this.cases.activate(i + 1, 0.15 + i * 0.09));
        this.later(1.2, () => this.say('Seven loaders. One crystal. Drink your tea.'));
        this.changed();
      }
    }
    if (s.fleetOn) {
      for (const f of this.fleet) {
        if (def.kind === 'native') f.view.update(dt, { ...f.body, carrying: null, piloted: false, power: 0 });
        else f.update(dt, LOADER, SOLIDS, this.decks, s.time, this.beamer, playing, playing);
      }
    }
    if (def.kind === 'native') this.updateOcelot(dt);
    if (def.kind === 'native' && s.nativeT >= 0 && s.nativeT < 99) {
      s.nativeT += dt;
      if (s.nativeT >= NATIVE.leap && s.nativeT - dt < NATIVE.leap) this.audio.play('learned');
      if (s.nativeT >= NATIVE.leap + NATIVE.traces && s.nativeT - dt < NATIVE.leap + NATIVE.traces) {
        this.audio.play('board');
        this.say('Rewired. The systems talk to each other now.');
      }
      // Files flow straight down the tubes; tally each arrival.
      const perRoute = Math.ceil((def.files ?? 0) / 4);
      ALL.forEach((c, r) => {
        const t = s.nativeT - FLOW_START - r * 0.075 - NATIVE.travel;
        const due = t < 0 ? 0 : Math.min(perRoute, Math.floor(t / NATIVE.flowEvery) + 1);
        while (playing && s.arrived[r] < due && s.delivered < this.total) {
          s.arrived[r]++;
          this.tally(c);
        }
      });
      if (playing && s.delivered >= this.total) s.finishing = true;
    }
  }

  /** Chapter 8: the ocelot hops off the parked loader and trots over to the inspector. */
  private updateOcelot(dt: number) {
    const s = this.store, o = s.ocelot;
    o.t += dt;
    if (o.mode === 'roof') {
      const a = this.views.loader.roofAnchor();
      o.x = a.x; o.y = a.y;
      if (o.t > 0.9) { o.mode = 'hop'; o.t = 0; o.fromX = o.x; o.fromY = o.y; s.ocelotOnRoof = false }
    } else if (o.mode === 'hop') {
      const u = Math.min(1, o.t / 0.5), tx = o.fromX - 70;
      o.x = o.fromX + (tx - o.fromX) * u;
      o.y = o.fromY + (FLOOR_Y - o.fromY) * u - Math.sin(u * Math.PI) * 40;
      o.facing = -1;
      if (u >= 1) { o.mode = 'walk'; o.t = 0; this.audio.play('jump') }
    } else if (o.mode === 'walk' || o.mode === 'ground') {
      // Trot to just beside the inspector, then keep them company.
      const target = this.inspector.x + 48 * (o.x >= this.inspector.x ? 1 : -1), dx = target - o.x;
      const speed = o.mode === 'walk' ? 260 : 200;
      if (Math.abs(dx) > 4 && (o.mode === 'walk' || Math.abs(dx) > 60)) {
        o.x += Math.sign(dx) * Math.min(Math.abs(dx), speed * dt);
        o.facing = dx < 0 ? -1 : 1;
      } else if (o.mode === 'walk') {
        o.mode = 'ground';
        o.facing = this.inspector.x < o.x ? -1 : 1;
        this.say(this.def.opening ?? '');
        this.changed();
      }
      o.y = FLOOR_Y;
    }
  }

  // ---------------------------------------------------------------- render
  render(g: CanvasRenderingContext2D) {
    const s = this.store, time = s.time, def = this.def;
    backdrop(g);
    if (def.kind === 'carry') drawPerch(g);
    if (def.kind === 'autopilot') drawTeaTable(g, TEA_X, time, s.tea);
    if (def.kind === 'fleet' || def.kind === 'native') {
      const merged = def.kind === 'native' && s.nativeT >= NATIVE.leap ? Math.min(1, (s.nativeT - NATIVE.leap) / 0.4) : 0;
      drawTerminal(g, TERMINAL_X, time, def.kind === 'native' ? 1 : Math.max(0, s.bootT), merged);
    }
    this.cases.drawBack(g, time);
    drawBank(g, def.stations, s.flash, time, s.counts);
    this.cases.drawFront(g, time);
    if (def.kind === 'native') {
      // Parked under the decks, powered down.
      this.views.loader.draw(g, time);
      for (const f of this.fleet) f.view.draw(g, time);
    }
    drawPlatforms(g, this.decks, SOLIDS);
    if (def.kind === 'native' && s.nativeT >= NATIVE.leap) this.drawTraces(g, s.nativeT - NATIVE.leap);
    for (const color of def.stations) {
      const d = DISPENSERS[color];
      drawDispenser(g, { color, feed: s.feed[color] ?? 0, flash: s.flash[color] ?? 0, active: true, deckY: DECKS[d.deck].y }, time);
    }
    if (def.kind === 'native' && s.nativeT >= NATIVE.leap + NATIVE.traces) this.drawTubes(g, s.nativeT - NATIVE.leap - NATIVE.traces);

    const talking = !!s.speech && s.speech.t < s.speech.text.length / 40 + 0.2;
    let ocelotHead = { x: OCELOT.perchX + 8, y: OCELOT.perchTop - 42 };
    if (def.kind === 'carry' && !s.ocelotOnRoof) drawOcelot(g, OCELOT.perchX + 4, OCELOT.perchTop, time, 1, talking);

    if (s.fleetOn && def.kind !== 'native') for (const f of this.fleet) this.drawFleetLoader(g, f, time);
    if (s.phase === 'boarding') this.views.loader.drawBoarding(g, Math.min(1, s.boardT), this.inspector.x, time);
    else {
      if ((s.mode === 'riding' || s.loaderPresent) && def.kind !== 'native') this.views.loader.draw(g, time);
      if (s.mode === 'foot') this.views.inspector.draw(g, time);
    }
    const roof = this.views.loader.roofAnchor();
    if (s.crystal && this.automated && def.kind !== 'native') drawCrystal(g, roof.x - 22 * this.loader.facing, roof.y - 10, time, 0.8);
    if (def.kind === 'native' && s.nativeT < NATIVE.leap) {
      const o = s.ocelot;
      let { x, y } = o;
      if (s.nativeT >= 0) {
        // Leap from beside the inspector into the terminal screen.
        const u = Math.min(1, s.nativeT / NATIVE.leap), tx = TERMINAL_X, ty = FLOOR_Y - 76;
        x = o.fromX + (tx - o.fromX) * u; y = o.fromY + (ty - o.fromY) * u - Math.sin(u * Math.PI) * 110;
      }
      const trot = o.mode === 'walk' ? Math.abs(Math.sin(time * 16)) * 3 : 0;
      drawOcelot(g, x, y - trot, time, o.facing, talking);
      ocelotHead = { x: x + 4 * o.facing, y: y - 42 };
    } else if (s.ocelotOnRoof) {
      const { x, y } = roof;
      drawOcelot(g, x, y, time, this.loader.facing, talking);
      ocelotHead = { x: x + 4 * this.loader.facing, y: y - 42 };
    } else if (def.kind === 'native' && s.nativeT >= NATIVE.leap) {
      // Merged: the ocelot glows inside the terminal.
      g.save(); g.shadowColor = '#78e6c8'; g.shadowBlur = 18;
      g.translate(TERMINAL_X, FLOOR_Y - 72); g.scale(0.62, 0.62);
      drawOcelot(g, 0, 0, time, 1, talking);
      g.restore();
      ocelotHead = { x: TERMINAL_X + 4, y: FLOOR_Y - 104 };
    }

    for (const e of s.effects) {
      if (e.kind === 'beam') drawBeam(g, e.color!, e.ax, e.ay, e.bx, e.by, e.t / e.dur);
      else floatText(g, e.text!, e.ax, e.ay, e.t / e.dur, e.hex);
    }
    if (def.kind === 'native' && s.nativeT >= FLOW_START) this.drawFlow(g, s.nativeT);
    this.cases.drawPellets(g);

    const b = this.actor, top = b.y - this.tuning.h;
    const lift = s.ocelotOnRoof && s.mode === 'riding' ? 80 : 40;
    if (s.phase === 'play') {
      const t = this.lastTarget;
      if (t) prompt(g, 'E', t.label, b.x, top - lift, t.ok ? 'ok' : 'muted');
    }
    if (s.notice) {
      const u = s.notice.t / 2.2;
      g.save(); g.globalAlpha = u > 0.8 ? (1 - u) / 0.2 : 1;
      g.font = '700 15px Arial, sans-serif'; g.textAlign = 'center';
      const nx = Math.max(220, Math.min(W - 220, b.x)), ny = Math.max(80, top - lift - 20);
      const w = g.measureText(s.notice.text).width + 24;
      g.fillStyle = s.notice.tone === 'bad' ? 'rgba(96,30,30,.92)' : 'rgba(26,74,54,.94)';
      g.beginPath(); g.roundRect(nx - w / 2, ny - 18, w, 26, 5); g.fill();
      g.fillStyle = '#fbf3dc'; g.fillText(s.notice.text, nx, ny);
      g.restore();
    }
    if (s.speech) bubble(g, s.speech.text, ocelotHead.x, ocelotHead.y, s.speech.t * 40);

    if (s.titleT < 2.2 && s.phase === 'play') {
      const a = s.titleT < 0.3 ? s.titleT / 0.3 : s.titleT > 1.7 ? (2.2 - s.titleT) / 0.5 : 1;
      g.save(); g.globalAlpha = Math.max(0, a); g.textAlign = 'center';
      g.fillStyle = 'rgba(16,24,30,.72)'; g.fillRect(W / 2 - 260, 128, 520, 76);
      g.fillStyle = '#ecb44e'; g.font = '800 14px Arial, sans-serif'; g.fillText(`CHAPTER ${def.id}`, W / 2, 156);
      g.fillStyle = '#f1eee2'; g.font = '800 28px Arial, sans-serif'; g.fillText(def.title, W / 2, 190);
      g.restore();
    }
  }

  private drawFleetLoader(g: CanvasRenderingContext2D, f: AutoLoader, time: number) {
    const s = this.store;
    const fade = this.def.kind === 'native' && s.nativeT >= NATIVE.leap + NATIVE.traces
      ? Math.max(0.35, 1 - (s.nativeT - NATIVE.leap - NATIVE.traces) / 1.5) : 1;
    g.save(); g.globalAlpha = fade;
    f.view.draw(g, time);
    const a = f.view.roofAnchor();
    if (f.power > 0.5) drawCrystal(g, a.x, a.y - 8, time + f.body.x, 0.6);
    g.restore();
  }

  /** Multicoloured PCB traces spreading from the terminal to every station. */
  private drawTraces(g: CanvasRenderingContext2D, t: number) {
    const u = Math.min(1, t / NATIVE.traces);
    const targets: { to: Pt; c: FileColor }[] = [];
    ALL.forEach(c => { targets.push({ to: dispenserMouth(c), c }); targets.push({ to: { x: SLOT_X[c], y: FLOOR_Y - 128 }, c }) });
    g.save();
    g.lineJoin = 'round';
    targets.forEach(({ to, c }, i) => {
      const route = traceRoute(to, i), v = u * 1.1 - i * 0.012;
      g.strokeStyle = FILE_HEX[c];
      g.globalAlpha = 0.25; g.lineWidth = 7; strokePartial(g, route, v);
      g.globalAlpha = 0.95; g.lineWidth = 2.5; strokePartial(g, route, v);
      if (v >= 1) { g.globalAlpha = 1; g.fillStyle = FILE_HEX[c]; g.beginPath(); g.arc(to.x, to.y, 4, 0, 7); g.fill() }
    });
    g.restore();
  }

  /** Direct tubes: each segment pivots into place, then snaps on. */
  private drawTubes(g: CanvasRenderingContext2D, t: number) {
    g.save();
    g.lineCap = 'round';
    ALL.forEach((c, r) => {
      const route = tubeRoute(c, r);
      for (let i = 1; i < route.length; i++) {
        const a = route[i - 1], b = route[i];
        const start = r * 0.12 + (i - 1) * 0.18, u = Math.min(1, Math.max(0, (t - start) / 0.35));
        if (u <= 0) continue;
        const ease = 1 - (1 - u) ** 3, ang = (1 - ease) * (Math.PI / 2) * (i % 2 ? 1 : -1);
        const dx = b.x - a.x, dy = b.y - a.y, cs = Math.cos(ang), sn = Math.sin(ang);
        const ex = a.x + dx * cs - dy * sn, ey = a.y + dx * sn + dy * cs;
        g.globalAlpha = Math.min(1, u * 1.5);
        g.strokeStyle = '#17242d'; g.lineWidth = 12; g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(ex, ey); g.stroke();
        g.strokeStyle = '#a8b2b3'; g.lineWidth = 8; g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(ex, ey); g.stroke();
        g.strokeStyle = FILE_HEX[c]; g.lineWidth = 2; g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(ex, ey); g.stroke();
        if (u >= 1) { g.fillStyle = '#17242d'; g.fillRect(b.x - 6, b.y - 6, 12, 12); g.fillStyle = FILE_HEX[c]; g.fillRect(b.x - 3, b.y - 3, 6, 6) }
      }
    });
    g.restore();
  }

  /** Files riding the tubes straight into their receptacles. */
  private drawFlow(g: CanvasRenderingContext2D, now: number) {
    const perRoute = Math.ceil((this.def.files ?? 0) / 4);
    ALL.forEach((c, r) => {
      const route = tubeRoute(c, r);
      for (let k = 0; k < perRoute; k++) {
        const t0 = FLOW_START + r * 0.075 + k * NATIVE.flowEvery, u = (now - t0) / NATIVE.travel;
        if (u < 0 || u >= 1) continue;
        const p = pointAt(route, u);
        folder(g, c, p.x, p.y, 0.7);
      }
    });
  }

  /** Plain snapshot for tests and the HUD. */
  snapshot() {
    const s = this.store, def = this.def;
    return {
      chapter: def.id, kind: def.kind, phase: s.phase, mode: s.mode, assignmentIndex: s.assignmentIndex,
      requested: this.requested, issued: s.issued, delivered: s.delivered, total: this.total,
      counts: { ...s.counts }, carrying: s.carrying, learned: [...s.learned], ocelotOnRoof: s.ocelotOnRoof, busy: s.busy,
      effects: s.effects.length, feed: { ...s.feed }, speech: s.speech?.text ?? null, notice: s.notice?.text ?? null,
      crystal: s.crystal, tea: s.tea, fleetOn: s.fleetOn, nativeT: s.nativeT,
      cases: { filed: this.archive.length, chapter: this.archive.filter(c => c.chapter === s.chapter).length, active: this.cases.active, busy: this.cases.busy },
      actor: { x: this.actor.x, y: this.actor.y, ground: this.actor.ground, grounded: this.actor.grounded },
      target: this.lastTarget, status: this.status(),
    };
  }

  /** One short line for the HUD's request chip. */
  status(): string {
    const s = this.store, def = this.def;
    if (s.phase === 'complete' || s.phase === 'end') return 'Chapter complete';
    switch (def.kind) {
      case 'autopilot':
        if (!s.crystal) return 'Hand the Memory Crystal to the ocelot';
        return s.tea ? 'Autopilot running. Enjoy your tea.' : 'Autopilot running. Make a cup of tea.';
      case 'fleet':
        return s.fleetOn ? 'Fleet running' : s.bootT >= 0 ? 'Copying crystal…' : 'Copy the crystal at terminal T—01';
      case 'native':
        return s.nativeT < 0 ? 'Let the ocelot in at terminal T—01' : s.nativeT < FLOW_START ? 'Rewiring the systems…' : 'Direct delivery';
      default:
        if (s.carrying) return `Carrying ${NAME[s.carrying]} → ${NAME[s.carrying]} slot`;
        if (this.requested) return `Requested: ${NAME[this.requested]}`;
        if (s.mode === 'foot' && def.start === 'parked') return 'Board the loader';
        if (s.mode === 'riding' && !s.ocelotOnRoof) return 'Pick up the ocelot';
        if (s.ocelotOnRoof) return 'Next file coming…';
        return 'Talk to the ocelot';
    }
  }
}

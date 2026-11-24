// Transfer Bay 07: fixed geometry shared by every chapter, plus chapter data.
// Logical space is 1280x720; y grows downward and every `y` below is a surface top.
import type { FileColor } from '../rig/api';

export const W = 1280;
export const H = 720;
export const FLOOR_Y = 640;

export interface Rect { x: number; y: number; w: number; h: number }
export interface Platform extends Rect {
  id: string;
  oneWay: boolean;
  /** Support legs (x positions); each runs down to the next surface below. */
  legs?: number[];
  /** Hung from the roof truss on rods instead of standing on legs. */
  hang?: number[];
}

/** Always present: floor, side walls and the low pipe. */
export const SOLIDS: Platform[] = [
  { id: 'floor', x: -40, y: FLOOR_Y, w: W + 80, h: 80, oneWay: false },
  { id: 'wall-l', x: -40, y: -400, w: 40, h: 1200, oneWay: false },
  { id: 'wall-r', x: W, y: -400, w: 40, h: 1200, oneWay: false },
  { id: 'pipe', x: 612, y: FLOOR_Y - 28, w: 60, h: 28, oneWay: false },
];

/**
 * Decks you can jump up through and stand on. Platforms are horizontally
 * staggered so the mounted loader (with the ocelot on its roof) always has
 * headroom where it stands.
 */
export const DECKS: Record<string, Platform> = {
  red: { id: 'red', x: 712, y: 562, w: 222, h: 18, oneWay: true, legs: [726, 908] },
  blue: { id: 'blue', x: 978, y: 480, w: 302, h: 18, oneWay: true, legs: [994, 1250] },
  step: { id: 'step', x: 880, y: 405, w: 118, h: 16, oneWay: true, hang: [900, 978] },
  green: { id: 'green', x: 570, y: 330, w: 270, h: 18, oneWay: true, legs: [586, 690] },
  purple: { id: 'purple', x: 392, y: 292, w: 158, h: 18, oneWay: true, hang: [404, 536] },
};

export interface Dispenser { color: FileColor; label: string; x: number; deck: string }
export const DISPENSERS: Record<FileColor, Dispenser> = {
  red: { color: 'red', label: 'P—02', x: 806, deck: 'red' },
  blue: { color: 'blue', label: 'P—03', x: 1176, deck: 'blue' },
  green: { color: 'green', label: 'P—04', x: 680, deck: 'green' },
  purple: { color: 'purple', label: 'P—05', x: 458, deck: 'purple' },
};

/** The receptacle bank on the floor, one labelled slot per colour. */
export const BANK = { x: 292, w: 236 };
export const SLOT_X: Record<FileColor, number> = { red: 320, blue: 378, green: 436, purple: 494 };
export const SLOT_GLYPH: Record<FileColor, string> = { red: 'R', blue: 'B', green: 'G', purple: 'P' };

export const OCELOT = { perchX: 78, perchTop: FLOOR_Y - 34, zoneMaxX: 222 };
export const PARK_X = 548;
/** Tea table (chapter 6) and the fleet terminal (chapters 7–8), both on the floor. */
export const TEA_X = 196;
export const TERMINAL_X = 206;

/** Where the fleet's loaders work: each on a deck, patrolling within `range` of `x`. */
export const FLEET_HOMES: { x: number; range: number; deck: string }[] = [
  { x: 622, range: 14, deck: 'green' },
  { x: 788, range: 14, deck: 'green' },
  { x: 790, range: 12, deck: 'red' },
  { x: 1062, range: 30, deck: 'blue' },
  { x: 1206, range: 24, deck: 'blue' },
  { x: 471, range: 8, deck: 'purple' },
];
/** The original loader's autopilot patrol, on the floor in front of the receptacles. */
export const AUTOPILOT_PATROL = { from: 300, to: 540 };

export type Kind = 'carry' | 'autopilot' | 'fleet' | 'native';
export type Start = 'foot' | 'parked' | 'riding' | 'handover' | 'tea';

export interface ChapterDef {
  id: number;
  title: string;
  /** One or two sentences in Power Loader's terms. */
  caption: string;
  kind: Kind;
  start: Start;
  spawnX: number;
  stations: FileColor[];
  decks: string[];
  /** Carry chapters: the ordered requests. */
  assignments: FileColor[];
  /** Automated chapters: how many files must arrive to finish. */
  files?: number;
  /** Files per case: each worker's active case closes and is filed when it holds this many. */
  caseSize: number;
  learned: FileColor[];
  /** Ocelot lines, by assignment index. Falls back to the colour's name. */
  lines: Record<number, string>;
  /** First thing the ocelot says. */
  opening?: string;
}

const ALL: FileColor[] = ['red', 'blue', 'green', 'purple'];
const ALL_DECKS = ['red', 'blue', 'step', 'green', 'purple'];

export const CHAPTERS: ChapterDef[] = [
  {
    id: 1,
    title: 'Manual Transfer', caseSize: 2,
    caption: 'Copying a record by hand: open the page, read it, carry it to the form, type it in.',
    kind: 'carry', start: 'foot', spawnX: 168,
    stations: ['red', 'blue'], decks: ['red', 'blue'],
    assignments: ['red', 'blue'], learned: [],
    opening: 'Morning, inspector. Press E to talk to me.',
    lines: { 0: 'Red first, please! P—02, over the pipe.', 1: 'Now blue. P—03, one step up.' },
  },
  {
    id: 2,
    title: 'More Files', caseSize: 3,
    caption: 'Another page to copy from. Same hands, more trips.',
    kind: 'carry', start: 'foot', spawnX: 168,
    stations: ['red', 'blue', 'green'], decks: ['red', 'blue', 'step', 'green'],
    assignments: ['red', 'blue', 'green'], learned: [],
    lines: { 0: 'Red, as before.', 1: 'Blue.', 2: 'Green. Top deck, past the step.' },
  },
  {
    id: 3,
    title: 'Same Trip Again', caseSize: 4,
    caption: 'The same values, the same forms, again. Every record is one more round trip.',
    kind: 'carry', start: 'foot', spawnX: 168,
    stations: ['red', 'blue', 'green'], decks: ['red', 'blue', 'step', 'green'],
    assignments: ['red', 'blue', 'blue', 'green'], learned: [],
    lines: { 0: 'Red.', 1: 'Blue.', 2: 'Blue again. Yes, the same blue.', 3: 'Green. Then we should talk.' },
  },
  {
    id: 4,
    title: 'Power Loader + Memory Core', caseSize: 3,
    caption:
      'Show the loader each route once and its Memory Core keeps it, like a flow in one bookmark. After that, one press copies and fills.',
    kind: 'carry', start: 'parked', spawnX: 168,
    stations: ['red', 'blue', 'green'], decks: ['red', 'blue', 'step', 'green'],
    assignments: ['red', 'blue', 'green', 'green', 'green', 'green', 'blue', 'blue', 'blue', 'red', 'red', 'red'],
    learned: [],
    opening: 'Board the loader. The big amber one.',
    lines: {
      0: 'Red. Carry it once so the loader learns the route.',
      1: 'Blue. Show it the way.',
      2: 'Green. Last new one.',
      3: 'Green again. The loader knows it: press E at P—04. No walking back.',
      4: 'Green. Press.',
      5: 'And again.',
      6: 'Blue. P—03.',
      8: 'Faster than typing.',
      9: 'Red to finish.',
      11: 'Last one.',
    },
  },
  {
    id: 5,
    title: 'Something New', caseSize: 3,
    caption: 'A new page needs its own step. Show the loader once, then the bookmark handles it.',
    kind: 'carry', start: 'riding', spawnX: 206,
    stations: ALL, decks: ALL_DECKS,
    assignments: ['red', 'red', 'purple', 'purple', 'purple', 'purple'],
    learned: ['red', 'blue', 'green'],
    lines: {
      0: 'Red. You know this one.',
      1: 'Red again.',
      2: 'When you encounter something new, you still need to show the Power Loader how to handle it.',
      3: 'Purple again. Watch.',
      5: 'Last one.',
    },
  },
  {
    id: 6,
    title: 'Autopilot', caseSize: 4,
    caption:
      'Where this is heading: once the routes are learned, nobody needs to press the button. Hand the Memory Crystal to the ocelot and put the kettle on.',
    kind: 'autopilot', start: 'handover', spawnX: 420,
    stations: ALL, decks: ALL_DECKS, assignments: [], files: 8, learned: ALL,
    opening: 'Hand me the Memory Crystal, then go and put the kettle on.',
    lines: {},
  },
  {
    id: 7,
    title: 'Fleet', caseSize: 3,
    caption: 'Where this is heading: the same learned routes, copied to a whole fleet, all working at once.',
    kind: 'fleet', start: 'tea', spawnX: 300,
    stations: ALL, decks: ALL_DECKS, assignments: [], files: 40, learned: ALL,
    opening: 'One loader is nice. Copy the crystal to the fleet at the terminal.',
    lines: {},
  },
  {
    id: 8,
    title: 'Native Integration', caseSize: 4,
    caption:
      'The end goal: fix the underlying systems so they share data directly. No copying, no loaders, nothing to carry.',
    kind: 'native', start: 'tea', spawnX: 300,
    stations: ALL, decks: ALL_DECKS, assignments: [], files: 48, learned: ALL,
    opening: 'Even a fleet is a workaround. Walk me to the terminal. I have an idea.',
    lines: {},
  },
];

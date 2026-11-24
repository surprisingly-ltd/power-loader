// Transfer Bay 07 drawing: backdrop, decks, stations, ocelot, bubbles and effects.
import { FILE_HEX, type FileColor } from '../rig/api';
import { BANK, DISPENSERS, FLOOR_Y, H, OCELOT, SLOT_GLYPH, SLOT_X, W, type Platform } from './level';

const ink = '#17242d', steel = '#40505a', iron = '#283944', light = '#9ba9a7', shade = '#ab7435', gold = '#ecb44e';
const deckTop = '#d9cfb3', deckFace = '#5d6d76', deckDark = '#3b4b55';

export type Ctx = CanvasRenderingContext2D;
export function rect(g: Ctx, c: string, x: number, y: number, w: number, h: number) { g.fillStyle = c; g.fillRect(x, y, w, h) }
export function poly(g: Ctx, c: string, ...p: number[]) {
  g.fillStyle = c; g.beginPath(); g.moveTo(p[0], p[1]);
  for (let i = 2; i < p.length; i += 2) g.lineTo(p[i], p[i + 1]);
  g.closePath(); g.fill();
}
export function disc(g: Ctx, c: string, x: number, y: number, r: number) { g.fillStyle = c; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill() }
export function text(g: Ctx, s: string, x: number, y: number, size: number, c: string, weight = 700, align: CanvasTextAlign = 'left') {
  g.fillStyle = c; g.font = `${weight} ${size}px "Arial Narrow", Arial, sans-serif`; g.textAlign = align; g.fillText(s, x, y); g.textAlign = 'left';
}
export function hazard(g: Ctx, x: number, y: number, w: number, h = 6) {
  rect(g, shade, x, y, w, h);
  g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
  for (let i = -h; i < w; i += 12) poly(g, ink, x + i, y + h, x + i + h, y, x + i + h + 5, y, x + i + 5, y + h);
  g.restore();
}

let cached: HTMLCanvasElement | null = null;
/** Static backdrop: sky, mountains, factory, window frames, truss, signage, floor. */
export function backdrop(g: Ctx) {
  if (!cached) {
    cached = document.createElement('canvas');
    cached.width = W * 2; cached.height = H * 2;
    const b = cached.getContext('2d')!;
    b.scale(2, 2);
    drawBackdrop(b);
  }
  g.drawImage(cached, 0, 0, W, H);
}

function drawBackdrop(g: Ctx) {
  rect(g, '#222f39', 0, 0, W, H);
  // Sky through the bay windows.
  rect(g, '#c9ab9c', 0, 40, 980, 470);
  disc(g, '#f3d39c', 170, 168, 62);
  poly(g, '#8c979c', 0, 300, 120, 250, 250, 290, 420, 200, 560, 270, 720, 170, 860, 230, 980, 190, 980, 500, 0, 500);
  poly(g, '#6f818a', 0, 360, 140, 318, 260, 344, 400, 288, 520, 330, 660, 280, 820, 330, 980, 296, 980, 500, 0, 500);
  // Factory silhouettes.
  g.fillStyle = '#566a75';
  for (let i = 0; i < 14; i++) {
    const x = i * 74 - 20, h = 40 + ((i * 37) % 70);
    g.fillRect(x, 470 - h, 60, h + 40);
    if (i % 3 === 0) g.fillRect(x + 12, 470 - h - 50, 9, 50);
  }
  rect(g, '#4b5e69', 0, 440, 980, 80);
  // Window mullions and the right-hand bay wall.
  for (const x of [0, 300, 640]) rect(g, iron, x + 22, 40, 22, 480);
  rect(g, '#34454f', 980, 40, 300, 540);
  for (let i = 0; i < 2; i++) { rect(g, '#394a54', 1000 + i * 140, 60, 128, 440); rect(g, '#2c3d48', 1000 + i * 140, 60, 3, 440) }
  // Faded signage.
  text(g, '07', 1046, 168, 118, 'rgba(120,138,148,.38)', 800);
  text(g, 'TRANSFER BAY', 1050, 200, 20, 'rgba(150,164,168,.45)', 700);
  // Railing behind the floor.
  rect(g, '#354652', 0, 512, W, 8);
  for (let x = 0; x < W; x += 56) rect(g, '#3a4b55', x, 480, 3, 34);
  rect(g, '#3a4b55', 0, 478, 980, 3);
  // Back wall below windows.
  rect(g, '#2d3e48', 0, 520, W, 120);
  // Overhead truss and task lamps.
  rect(g, ink, 0, 0, W, 44);
  for (let x = -40; x < W; x += 150) {
    poly(g, '#2e404b', x, 44, x + 26, 44, x + 96, 8, x + 70, 8);
    poly(g, '#2e404b', x + 75, 8, x + 100, 8, x + 150, 44, x + 125, 44);
  }
  rect(g, iron, 0, 40, W, 10);
  for (const x of [330, 640, 880]) {
    rect(g, ink, x, 50, 3, 42);
    poly(g, ink, x - 18, 104, x - 9, 92, x + 12, 92, x + 21, 104);
    rect(g, '#e9dcb8', x - 15, 104, 33, 2);
  }
  // Floor: brighter than the backdrop.
  rect(g, '#6a7a82', 0, FLOOR_Y, W, 5);
  rect(g, '#56666f', 0, FLOOR_Y + 5, W, 30);
  for (let x = 0; x < W; x += 160) rect(g, '#4a5a63', x, FLOOR_Y + 5, 2, 30);
  rect(g, '#2a3943', 0, FLOOR_Y + 35, W, H - FLOOR_Y - 35);
  for (let x = 20; x < W; x += 120) poly(g, '#223039', x, FLOOR_Y + 35, x + 60, FLOOR_Y + 35, x + 30, H, x - 10, H);
}

/** Pipe obstacle, decks with legs and hazard edges. */
export function drawPlatforms(g: Ctx, decks: Platform[], solids: Platform[]) {
  const pipe = solids.find(s => s.id === 'pipe');
  if (pipe) {
    const { x, y, w, h } = pipe;
    rect(g, '#7b8a90', x - 6, y + h - 6, 12, 6); rect(g, '#7b8a90', x + w - 6, y + h - 6, 12, 6);
    g.strokeStyle = '#a9b4b5'; g.lineWidth = 12; g.lineCap = 'round';
    g.beginPath(); g.moveTo(x, y + h - 6); g.lineTo(x, y + 8); g.quadraticCurveTo(x, y + 4, x + 8, y + 4); g.lineTo(x + w - 8, y + 4); g.quadraticCurveTo(x + w, y + 4, x + w, y + 8); g.lineTo(x + w, y + h - 6); g.stroke();
    hazard(g, x + 10, y - 1, w - 20, 9);
  }
  for (const d of decks) {
    // Legs run down to the next surface below; hung decks ride on rods from the truss.
    for (const lx of d.legs ?? []) {
      const below = decks.filter(o => o !== d && o.y > d.y && lx >= o.x && lx <= o.x + o.w).map(o => o.y);
      const to = Math.min(FLOOR_Y, ...below);
      rect(g, deckDark, lx - 6, d.y + d.h, 12, to - d.y - d.h);
      rect(g, '#4a5a63', lx - 4, d.y + d.h, 3, to - d.y - d.h);
      rect(g, ink, lx - 9, to - 4, 18, 4);
    }
    for (const hx of d.hang ?? []) {
      rect(g, ink, hx - 2, 48, 4, d.y - 48);
      rect(g, '#5a6a72', hx - 1, 48, 1, d.y - 48);
      rect(g, ink, hx - 7, d.y - 6, 14, 6);
    }
    if ((d.legs?.length ?? 0) > 1) {
      const [l0, l1] = [d.legs![0], d.legs![d.legs!.length - 1]];
      g.strokeStyle = deckDark; g.lineWidth = 5; g.lineCap = 'butt';
      g.beginPath(); g.moveTo(l0 + 6, d.y + d.h + 36); g.lineTo(l0 + 44, d.y + d.h); g.stroke();
      g.beginPath(); g.moveTo(l1 - 6, d.y + d.h + 36); g.lineTo(l1 - 44, d.y + d.h); g.stroke();
    }
    rect(g, deckFace, d.x, d.y, d.w, d.h);
    rect(g, deckTop, d.x, d.y, d.w, 4);
    rect(g, '#46565f', d.x, d.y + d.h - 3, d.w, 3);
    for (let bx = d.x + 10; bx < d.x + d.w - 4; bx += 34) disc(g, '#7d8b90', bx, d.y + 10, 1.6);
    hazard(g, d.x + d.w - 46, d.y + 5, 36, 6);
    if (d.w > 140) hazard(g, d.x + 8, d.y + 5, 30, 6);
  }
}

/** Folder glyph in a colour, with its letter so colour isn't the only cue. */
export function folder(g: Ctx, color: FileColor, x: number, y: number, s = 1, alpha = 1) {
  g.save(); g.globalAlpha *= alpha; g.translate(x, y); g.scale(s, s);
  poly(g, ink, -16, 11, -16, -11, -9, -11, -6, -8, 16, -8, 16, 11);
  poly(g, FILE_HEX[color], -14, 9, -14, -9, -9.5, -9, -6.5, -6, 14, -6, 14, 9);
  rect(g, 'rgba(255,255,255,.28)', -14, -6, 28, 3);
  text(g, SLOT_GLYPH[color], 0, 7, 12, ink, 800, 'center');
  g.restore();
}

export interface DispenserLook { color: FileColor; feed: number; flash: number; active: boolean; deckY: number }

/** A dispenser: feed tube with arrow, conveyor, screen with folder, ID panel. */
export function drawDispenser(g: Ctx, d: DispenserLook, time: number) {
  const def = DISPENSERS[d.color], x = def.x, y = d.deckY, hex = FILE_HEX[d.color];
  // Cabinet with ID panel.
  rect(g, ink, x + 2, y - 86, 58, 86); rect(g, '#46575f', x + 5, y - 83, 52, 80);
  rect(g, ink, x + 11, y - 76, 40, 9); rect(g, hex, x + 15, y - 74, 32, 5);
  text(g, def.label, x + 31, y - 46, 15, '#d4d8cf', 800, 'center');
  for (let i = 0; i < 3; i++) rect(g, iron, x + 13, y - 34 + i * 6, 36, 2);
  // Feed tube curling in from above.
  g.strokeStyle = '#a8b2b3'; g.lineWidth = 11; g.lineCap = 'butt';
  g.beginPath(); g.moveTo(x - 28, y - 66); g.lineTo(x - 28, y - 96); g.quadraticCurveTo(x - 28, y - 112, x - 12, y - 112); g.lineTo(x + 10, y - 112); g.quadraticCurveTo(x + 26, y - 112, x + 26, y - 96); g.lineTo(x + 26, y - 88); g.stroke();
  rect(g, '#7f8a8c', x - 36, y - 70, 16, 6);
  // Screen housing.
  rect(g, ink, x - 58, y - 66, 60, 54); rect(g, '#22313a', x - 54, y - 62, 52, 46);
  const glow = 0.25 + 0.2 * Math.sin(time * 3) + d.flash * 0.6;
  g.fillStyle = hex; g.globalAlpha = Math.min(1, glow); g.fillRect(x - 52, y - 60, 48, 42); g.globalAlpha = 1;
  // Arrow down the tube.
  poly(g, '#e7e6dc', x - 32, y - 84, x - 24, y - 84, x - 28, y - 77);
  // Folder: slides down from the tube while feeding.
  if (d.active) {
    const feedY = d.feed > 0 ? -28 * d.feed : 0;
    g.save(); g.beginPath(); g.rect(x - 54, y - 62, 52, 46); g.clip();
    folder(g, d.color, x - 28, y - 38 + feedY, 1.05);
    g.restore();
  } else {
    rect(g, 'rgba(23,36,45,.6)', x - 54, y - 62, 52, 46);
  }
  // Conveyor.
  rect(g, ink, x - 62, y - 12, 66, 10);
  for (let i = 0; i < 5; i++) disc(g, shade, x - 55 + i * 13, y - 7, 3.2);
  if (!d.active) { g.fillStyle = 'rgba(34,47,57,.55)'; g.fillRect(x - 64, y - 116, 128, 116) }
}

/** Receptacle bank with labelled slots. Inactive slots are capped and dimmed. */
export function drawBank(g: Ctx, active: FileColor[], flash: Partial<Record<FileColor, number>>, time: number, counts: Partial<Record<FileColor, number>> = {}) {
  const x = BANK.x, y = FLOOR_Y, w = BANK.w;
  rect(g, ink, x, y - 128, w, 128); rect(g, '#4a5b63', x + 4, y - 124, w - 8, 120);
  rect(g, ink, x - 18, y - 110, 22, 110); rect(g, '#3f4f58', x - 15, y - 106, 16, 104);
  for (let i = 0; i < 3; i++) rect(g, iron, x - 12, y - 96 + i * 7, 10, 2);
  // Beacon.
  rect(g, ink, x - 16, y - 118, 18, 8); disc(g, '#e8483f', x - 7, y - 120, 5 + Math.sin(time * 5));
  text(g, 'RECEPTACLES', x + w - 10, y - 108, 11, '#b7c0bb', 700, 'right');
  for (const c of ['red', 'blue', 'green', 'purple'] as FileColor[]) {
    const sx = SLOT_X[c], on = active.includes(c), f = flash[c] ?? 0;
    rect(g, ink, sx - 24, y - 98, 48, 48);
    rect(g, on ? '#2a3a43' : '#33424b', sx - 21, y - 95, 42, 42);
    if (on) {
      // An open intake slot, outlined in the receptacle's colour.
      rect(g, '#141f26', sx - 15, y - 80, 30, 8);
      g.strokeStyle = FILE_HEX[c]; g.lineWidth = 2; g.strokeRect(sx - 20, y - 94, 40, 40);
    }
    // Counter: files received this chapter.
    rect(g, ink, sx - 25, y - 45, 50, 24);
    g.fillStyle = on ? FILE_HEX[c] : '#3d4b53'; g.fillRect(sx - 21, y - 41, 42, 16);
    if (on) text(g, `${SLOT_GLYPH[c]} ×${counts[c] ?? 0}`, sx, y - 28.5, 12, ink, 800, 'center');
    if (f > 0) {
      g.save(); g.globalAlpha = f; g.fillStyle = FILE_HEX[c];
      g.fillRect(sx - 26, y - 100, 52, 80);
      g.globalAlpha = f * 0.5; g.fillStyle = '#fff'; g.fillRect(sx - 20, y - 94, 40, 40);
      g.restore();
    }
  }
  hazard(g, x, y - 8, w, 8);
}

/** Small spotted ocelot, sitting. `lit` adds a glow ring. */
export function drawOcelot(g: Ctx, x: number, y: number, time: number, facing: 1 | -1 = 1, talking = false) {
  g.save(); g.translate(x, y); g.scale(facing, 1);
  const fur = '#d9a35a', dark = '#3a2a1c', belly = '#f1d7a8';
  // Tail curling.
  g.strokeStyle = fur; g.lineWidth = 5; g.lineCap = 'round';
  const sw = Math.sin(time * 2) * 4;
  g.beginPath(); g.moveTo(-10, -4); g.quadraticCurveTo(-26, -2, -24 + sw * 0.3, -18 + sw); g.stroke();
  g.strokeStyle = dark; g.lineWidth = 5; g.setLineDash([3, 4]);
  g.beginPath(); g.moveTo(-14, -3); g.quadraticCurveTo(-26, -2, -24 + sw * 0.3, -18 + sw); g.stroke(); g.setLineDash([]);
  // Body.
  g.fillStyle = fur; g.beginPath(); g.ellipse(-2, -14, 13, 14, -0.15, 0, 7); g.fill();
  g.fillStyle = belly; g.beginPath(); g.ellipse(4, -12, 6, 10, -0.1, 0, 7); g.fill();
  for (const [sx, sy] of [[-8, -20], [-11, -11], [-4, -6], [-6, -16], [-12, -4]]) disc(g, dark, sx, sy, 1.9);
  // Front legs.
  rect(g, fur, 2, -8, 4, 8); rect(g, fur, 7, -8, 4, 8); rect(g, belly, 2, -2, 9, 2);
  // Head.
  const bob = talking ? Math.sin(time * 18) * 1 : 0;
  g.translate(4, -30 + bob);
  poly(g, fur, -7, -4, -5, -13, -1, -6); poly(g, fur, 3, -6, 7, -13, 8, -3);
  poly(g, dark, -5.5, -6, -5, -10.5, -2.5, -6.5); poly(g, dark, 4.5, -6.5, 6.5, -10.5, 6.8, -5);
  g.fillStyle = fur; g.beginPath(); g.ellipse(0, 0, 9, 7.5, 0, 0, 7); g.fill();
  g.fillStyle = belly; g.beginPath(); g.ellipse(3, 3, 5, 3.5, 0, 0, 7); g.fill();
  disc(g, dark, -3, -3, 1.2); disc(g, dark, 1, -5, 1.1); disc(g, dark, -6, 1, 1.1);
  disc(g, '#203a2a', 2, -1, 1.6); disc(g, '#203a2a', 7, -1, 1.4); disc(g, '#e9f3a0', 2.4, -1.3, 0.6);
  disc(g, '#6b3a2e', 9, 2.5, 1.2);
  if (talking) rect(g, dark, 5, 4.5, 4, 1.4 + Math.abs(Math.sin(time * 18)) * 1.6);
  g.restore();
}

export function drawPerch(g: Ctx) {
  const x = OCELOT.perchX, top = OCELOT.perchTop;
  rect(g, ink, x - 30, top, 60, FLOOR_Y - top);
  rect(g, '#55656e', x - 27, top + 3, 54, FLOOR_Y - top - 3);
  rect(g, deckTop, x - 30, top, 60, 3);
  rect(g, ink, x - 18, top + 10, 36, 12); rect(g, '#3a4a53', x - 15, top + 13, 30, 6);
  hazard(g, x - 30, FLOOR_Y - 7, 60, 7);
}

/**
 * 90s pixel speech bubble anchored with its tail at (x, y).
 * Text reveals over time; `shown` is the number of characters visible.
 */
export function bubble(g: Ctx, msg: string, x: number, y: number, shown: number) {
  const s = msg.slice(0, Math.max(0, Math.floor(shown)));
  g.font = 'bold 14px "Courier New", Courier, monospace';
  const words = msg.split(' '), lines: string[] = [];
  let line = '';
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (g.measureText(t).width > 260 && line) { lines.push(line); line = w } else line = t;
  }
  lines.push(line);
  const width = Math.ceil(Math.max(...lines.map(l => g.measureText(l).width))) + 22;
  const height = lines.length * 18 + 14;
  let bx = Math.round(x - 24), by = Math.round(y - height - 12);
  bx = Math.max(6, Math.min(W - width - 6, bx));
  by = Math.max(54, by);
  // Stepped pixel border.
  const px = 3;
  rect(g, ink, bx + px, by, width - 2 * px, height);
  rect(g, ink, bx, by + px, width, height - 2 * px);
  rect(g, '#fbf3dc', bx + px, by + px, width - 2 * px, height - 2 * px);
  rect(g, '#fbf3dc', bx + 2 * px, by + 1, width - 4 * px, height - 2);
  rect(g, 'rgba(23,36,45,.18)', bx + px, by + height - 2 * px, width - 2 * px, px);
  // Stepped tail.
  const tx = Math.max(bx + 12, Math.min(bx + width - 24, x - 6));
  rect(g, ink, tx, by + height - 1, 12, 4); rect(g, '#fbf3dc', tx + 3, by + height - 2, 6, 3);
  rect(g, ink, tx + 3, by + height + 3, 6, 4); rect(g, ink, tx + 6, by + height + 7, 3, 3);
  // Text with typewriter reveal.
  g.fillStyle = ink; g.font = 'bold 14px "Courier New", Courier, monospace';
  let left = s.length;
  lines.forEach((l, i) => {
    const part = l.slice(0, Math.max(0, left));
    left -= l.length + 1;
    g.fillText(part, bx + 11, by + 21 + i * 18);
  });
}

/** Small contextual prompt: a key cap and a short label. */
export function prompt(g: Ctx, key: string, label: string, x: number, y: number, tone: 'ok' | 'muted' = 'ok') {
  g.font = '700 13px Arial, sans-serif';
  const w = g.measureText(label).width + 40;
  const bx = Math.round(Math.max(6, Math.min(W - w - 6, x - w / 2))), by = Math.round(Math.max(54, y));
  g.fillStyle = 'rgba(16,24,30,.86)'; g.beginPath(); g.roundRect(bx, by, w, 24, 5); g.fill();
  g.fillStyle = tone === 'ok' ? gold : '#8d999c'; g.beginPath(); g.roundRect(bx + 4, by + 4, 20, 16, 3); g.fill();
  text(g, key, bx + 14, by + 16.5, 11, ink, 800, 'center');
  text(g, label, bx + 30, by + 16.5, 13, tone === 'ok' ? '#f1eee2' : '#b8c1c3', 700);
}

/** Colour-matched beam with a folder riding it. u runs 0..1. */
export function drawBeam(g: Ctx, color: FileColor, ax: number, ay: number, bx: number, by: number, u: number) {
  const hex = FILE_HEX[color];
  const fade = u < 0.75 ? 1 : 1 - (u - 0.75) / 0.25;
  g.save(); g.globalAlpha = fade;
  g.strokeStyle = hex; g.lineWidth = 3; g.setLineDash([10, 7]); g.lineDashOffset = -u * 120;
  g.beginPath(); g.moveTo(ax, ay); g.quadraticCurveTo((ax + bx) / 2, Math.min(ay, by) - 80, bx, by); g.stroke();
  g.setLineDash([]); g.lineWidth = 9; g.globalAlpha = fade * 0.18;
  g.beginPath(); g.moveTo(ax, ay); g.quadraticCurveTo((ax + bx) / 2, Math.min(ay, by) - 80, bx, by); g.stroke();
  g.restore();
  const t = Math.min(1, u / 0.75), cx = (ax + bx) / 2, cy = Math.min(ay, by) - 80;
  const px = (1 - t) ** 2 * ax + 2 * (1 - t) * t * cx + t * t * bx, py = (1 - t) ** 2 * ay + 2 * (1 - t) * t * cy + t * t * by;
  if (t < 1) folder(g, color, px, py, 0.9);
}

export function floatText(g: Ctx, s: string, x: number, y: number, u: number, color = gold) {
  g.save(); g.globalAlpha = 1 - u;
  g.font = '800 18px Arial, sans-serif'; g.textAlign = 'center';
  g.lineWidth = 4; g.strokeStyle = ink; g.strokeText(s, x, y - u * 40);
  g.fillStyle = color; g.fillText(s, x, y - u * 40);
  g.restore();
}

/** Tea table with kettle and tin (chapter 6). */
export function drawTeaTable(g: Ctx, x: number, time: number, brewed: boolean) {
  const y = FLOOR_Y;
  rect(g, ink, x - 34, y - 46, 68, 6); rect(g, '#8a6a4a', x - 32, y - 45, 64, 4);
  rect(g, ink, x - 30, y - 40, 5, 40); rect(g, ink, x + 25, y - 40, 5, 40);
  // Kettle.
  g.fillStyle = '#b9c2c3'; g.beginPath(); g.ellipse(x - 10, y - 58, 13, 12, 0, 0, 7); g.fill();
  rect(g, '#8d989a', x - 18, y - 50, 16, 4); rect(g, ink, x - 14, y - 74, 8, 4);
  g.strokeStyle = '#b9c2c3'; g.lineWidth = 3; g.beginPath(); g.moveTo(x + 2, y - 60); g.lineTo(x + 9, y - 66); g.stroke();
  if (brewed) {
    g.strokeStyle = 'rgba(255,255,255,.5)'; g.lineWidth = 1.5;
    for (let i = 0; i < 2; i++) {
      const o = (time * 0.7 + i * 0.5) % 1;
      g.globalAlpha = 1 - o; g.beginPath(); g.moveTo(x + 9, y - 68 - o * 16); g.quadraticCurveTo(x + 14, y - 74 - o * 16, x + 9, y - 80 - o * 16); g.stroke();
    }
    g.globalAlpha = 1;
  }
  // Tea tin.
  rect(g, '#2f6b52', x + 12, y - 62, 14, 16); rect(g, gold, x + 12, y - 57, 14, 3);
  text(g, 'TEA', x, y - 24, 9, '#c7cdc6', 800, 'center');
}

/** Fleet terminal. `boot` 0..1 lights the screen; `merged` shows the ocelot inside. */
export function drawTerminal(g: Ctx, x: number, time: number, boot: number, merged: number) {
  const y = FLOOR_Y;
  rect(g, ink, x - 30, y - 112, 60, 112); rect(g, '#46575f', x - 27, y - 109, 54, 106);
  rect(g, ink, x - 24, y - 104, 48, 36);
  const glow = boot * (0.7 + 0.3 * Math.sin(time * 6));
  g.fillStyle = `rgba(120,230,200,${0.15 + 0.6 * glow})`; g.fillRect(x - 21, y - 101, 42, 30);
  if (boot > 0 && boot < 1) for (let i = 0; i < 4; i++) rect(g, 'rgba(23,36,45,.5)', x - 21, y - 99 + ((time * 40 + i * 8) % 30), 42, 2);
  if (boot >= 1 && merged <= 0) {
    g.fillStyle = '#17242d'; g.font = '700 8px "Courier New", monospace'; g.textAlign = 'center';
    g.fillText('FLEET', x, y - 88); g.fillText('READY', x, y - 79); g.textAlign = 'left';
  }
  rect(g, ink, x - 22, y - 60, 44, 12);
  for (let i = 0; i < 5; i++) rect(g, i < Math.round(boot * 5) ? '#78e6c8' : '#2a3a43', x - 19 + i * 8, y - 57, 6, 6);
  text(g, 'T—01', x, y - 30, 12, '#d4d8cf', 800, 'center');
  for (let i = 0; i < 2; i++) rect(g, iron, x - 18, y - 22 + i * 6, 36, 2);
  if (merged > 0) {
    g.save();
    for (let r = 0; r < 3; r++) {
      const k = ((time * 0.8 + r / 3) % 1);
      g.globalAlpha = merged * (1 - k) * 0.6;
      g.strokeStyle = ['#e8483f', '#3f8ff0', '#4fcf63', '#9a5cf0'][r % 4]; g.lineWidth = 2;
      g.beginPath(); g.arc(x, y - 86, 22 + k * 46, 0, 7); g.stroke();
    }
    g.restore();
  }
}

/** The glowing Memory Crystal. */
export function drawCrystal(g: Ctx, x: number, y: number, time: number, s = 1) {
  g.save(); g.translate(x, y); g.scale(s, s);
  g.globalAlpha = 0.35 + 0.15 * Math.sin(time * 5);
  disc(g, '#78e6c8', 0, 0, 13);
  g.globalAlpha = 1;
  poly(g, '#bff7e6', 0, -11, 7, -2, 0, 11, -7, -2);
  poly(g, '#5fd3b4', 0, -11, 0, 11, -7, -2);
  g.restore();
}

export const PALETTE = { ink, steel, iron, light, shade, gold };

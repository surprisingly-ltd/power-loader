// Scenery from the motion study: the parallax transfer bay, the P—02 processor and file boxes.
// Native 1280x720 space; the bay floor line is at y = floor (586 in the study).
import { type Ctx, P, poly, rect, disc, beam, label, ink, steel, iron, light, shade, green } from './draw';

/** Scenery is drawn back to front. Each plane has its own camera travel. */
export function environment(g: Ctx, camera: number, floor = 586) {
  const dy = floor - 586;
  g.save(); g.translate(0, dy);
  rect(g, '#222f39', -200, -180, 1800, 1100);
  g.save(); g.translate(-camera * .16, 0);
  rect(g, '#c3afa0', -200, 95, 1120, 370); disc(g, '#f1d6ad', P(318, 230), 47);
  poly(g, '#89959a', -140, 368, 74, 285, 125, 301, 226, 248, 353, 323, 436, 278, 535, 331, 650, 240, 735, 263, 955, 201, 970, 468, -140, 468);
  poly(g, '#687b85', -140, 416, 42, 352, 100, 367, 219, 314, 293, 350, 414, 303, 516, 348, 661, 296, 789, 344, 931, 302, 980, 471, -140, 471);
  for (let i = 0; i < 13; i++) { const x = i * 92 - 160, h = 32 + ((i * 29) % 67); rect(g, '#526671', x, 461 - h, 72, h); rect(g, '#526671', x + 13, 448 - h, 9, 15); }
  g.restore(); g.save(); g.translate(-camera * .40, 0);
  rect(g, '#34454f', 850, 65, 1250, 505);
  for (let i = 0; i < 4; i++) { const x = 874 + i * 305; rect(g, '#394a54', x, 105, 286, 370); rect(g, '#2c3d48', x, 105, 3, 395); }
  label(g, '07', 911, 323, 143, '#50606a', 800); label(g, 'TRANSFER BAY', 922, 351, 16, '#7c898c', 700);
  for (let x = -260; x < 2150; x += 298) { rect(g, iron, x, 74, 14, 410); beam(g, '#34454e', P(x, 392), P(x + 115, 470), 6); }
  rect(g, '#354652', -300, 422, 2680, 11); rect(g, steel, -300, 398, 2680, 3); for (let x = -200; x < 2200; x += 68) rect(g, steel, x, 399, 3, 25);
  rect(g, iron, -300, 452, 2650, 145); rect(g, '#42535c', -300, 460, 2650, 7);
  g.restore();
  // Deep overhead truss and hanging task lamps frame the open bay.
  g.save(); g.translate(-camera * .57, 0); rect(g, ink, -200, -70, 2350, 170);
  for (let x = -290; x < 2080; x += 245) { poly(g, '#2e404b', x, 84, x + 47, 84, x + 138, 161, x + 98, 161); poly(g, iron, x + 112, 157, x + 223, 83, x + 249, 83, x + 142, 157); }
  rect(g, ink, -250, 150, 2350, 14);
  for (let x = 190; x < 2000; x += 580) { rect(g, ink, x, 163, 3, 35); poly(g, ink, x - 17, 203, x - 10, 197, x + 12, 197, x + 19, 203); rect(g, '#cbbfa6', x - 15, 203, 31, 2); }
  g.restore();
  rect(g, '#52616a', -100, 535, 1500, 90); rect(g, '#607079', -100, 536, 1500, 3); rect(g, '#34454e', -100, 586, 1500, 260);
  for (let i = -2; i < 16; i++) { const x = i * 180 - camera; poly(g, '#2b3b45', x, 587, x + 2, 587, x - 94, 790, x - 98, 790); }
  rect(g, '#41535c', -50, 630, 1450, 3); rect(g, ink, -50, 650, 1450, 8); rect(g, '#293842', -50, 659, 1450, 140);
  for (let x = -camera - 100; x < 1400; x += 218) { rect(g, '#1c2a34', x, 667, 172, 6); rect(g, steel, x, 666, 166, 1); }
  g.restore();
}

export function shadow(g: Ctx, x: number, width: number, floor = 586) {
  poly(g, '#344650', x - width, floor - 1, x - width + 20, floor - 6, x + width, floor - 5, x + width + 14, floor);
}

/** Hazard stripe, amber with ink chevrons. */
export function stripe(g: Ctx, x: number, y: number, w: number) {
  rect(g, shade, x, y, w, 7);
  for (let i = 0; i < w - 12; i += 15) poly(g, ink, x + i, y + 7, x + i + 6, y, x + i + 13, y, x + i + 7, y + 7);
}

/** The P—02 file processor; p is the current load cycle progress (0-1). */
export function processor(g: Ctx, p: number, x = 1107, y = 586, id = 'P—02') {
  shadow(g, x + 93, 115, y);
  poly(g, ink, x, y, x, y - 164, x + 22, y - 193, x + 167, y - 193, x + 191, y - 172, x + 191, y);
  poly(g, '#475960', x + 18, y - 165, x + 31, y - 180, x + 159, y - 180, x + 175, y - 164, x + 175, y - 16, x + 18, y - 16);
  rect(g, '#23353f', x + 1, y - 170, 82, 137); rect(g, '#101d26', x + 1, y - 166, 73, 126);
  rect(g, steel, x - 14, y - 43, 107, 10); stripe(g, x - 11, y - 30, 78); rect(g, p > .76 && p < .88 ? '#d8dbc1' : steel, x + 74, y - 145, 5, 102);
  rect(g, ink, x + 98, y - 153, 54, 24); rect(g, p > .84 ? green : '#608880', x + 105, y - 145, 20, 4); rect(g, light, x + 105, y - 137, 35, 1);
  label(g, id, x + 98, y - 100, 17, '#c0c7c1'); for (let i = 0; i < 4; i++) rect(g, iron, x + 101, y - 67 + i * 6, 48, 2);
}

/** A tall archive file box, labelled F / 0<id>. */
export function fileBox(g: Ctx, x: number, y: number, id: number, back = false) {
  const c = back ? '#798483' : '#a6aaa0';
  poly(g, ink, x, y, x, y - 117, x + 7, y - 124, x + 32, y - 124, x + 38, y - 118, x + 59, y - 118, x + 66, y - 112, x + 66, y);
  poly(g, c, x + 3, y - 3, x + 3, y - 115, x + 9, y - 121, x + 30, y - 121, x + 37, y - 115, x + 57, y - 115, x + 57, y - 3);
  rect(g, '#687575', x + 58, y - 111, 6, 108); rect(g, steel, x + 8, y - 98, 41, 19); label(g, 'F / 0' + id, x + 12, y - 85, 9, '#e4dfc8'); rect(g, '#687575', x + 8, y - 14, 41, 2);
}

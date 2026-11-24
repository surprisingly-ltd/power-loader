// Drawing primitives and motion helpers shared by the inspector and loader rigs.
// Every drawing function takes the canvas context explicitly; nothing here holds state.

export type Ctx = CanvasRenderingContext2D;
export interface Pt { x: number; y: number; roll?: number }
export type Keys = ReadonlyArray<readonly [number, number]>;

export const ink = '#17242d', steel = '#40505a', iron = '#283944', light = '#9ba9a7',
  gold = '#ecb44e', shade = '#ab7435', green = '#91e4cb';

/** Bone lengths of the two rigs, at native (unscaled) size. */
export const rig = {
  human: { leg: [27, 27] as const, arm: [21, 20] as const },
  loader: { leg: [52, 55] as const, arm: [59, 59] as const },
};

export const clamp = (x: number) => Math.min(1, Math.max(0, x));
export const smooth = (x: number) => (x = clamp(x), x * x * (3 - 2 * x));
export const ease = (a: number, b: number, t: number) => smooth((t - a) / (b - a));
export const mix = (a: number, b: number, u: number) => a + (b - a) * u;
export function keys(t: number, list: Keys) {
  let v = list[0][1];
  for (let i = 1; i < list.length; i++) v = mix(v, list[i][1], ease(list[i - 1][0], list[i][0], t));
  return v;
}
export const P = (x: number, y: number): Pt => ({ x, y });
export const between = (a: Pt, b: Pt, s: number) => P(mix(a.x, b.x, s), mix(a.y, b.y, s));

export function poly(g: Ctx, color: string, ...p: number[]) {
  g.fillStyle = color; g.beginPath(); g.moveTo(p[0], p[1]);
  for (let i = 2; i < p.length; i += 2) g.lineTo(p[i], p[i + 1]);
  g.closePath(); g.fill();
}
export function rect(g: Ctx, c: string, x: number, y: number, w: number, h: number) {
  g.fillStyle = c; g.fillRect(x, y, w, h);
}
export function disc(g: Ctx, c: string, p: Pt, r: number) {
  g.fillStyle = c; g.beginPath(); g.arc(p.x, p.y, r, 0, 7); g.fill();
}
export function beam(g: Ctx, c: string, a: Pt, b: Pt, w: number, v = w) {
  const d = Math.hypot(b.x - a.x, b.y - a.y) || 1, n = (a.y - b.y) / d, m = (b.x - a.x) / d;
  poly(g, c, a.x + w * n, a.y + w * m, b.x + v * n, b.y + v * m, b.x - v * n, b.y - v * m, a.x - w * n, a.y - w * m);
}
export function label(g: Ctx, s: string, x: number, y: number, size: number, c: string, weight = 600) {
  g.fillStyle = c; g.font = weight + ' ' + size + 'px sans-serif'; g.fillText(s, x, y);
}
export function bolt(g: Ctx, p: Pt, r: number, c: string) {
  disc(g, ink, p, r); disc(g, c, p, r * .64); disc(g, steel, p, r * .25);
}
export function hydraulic(g: Ctx, a: Pt, b: Pt, col: string) {
  beam(g, ink, a, b, 8, 6); const n = between(a, b, .38); beam(g, light, n, b, 3); beam(g, col, a, n, 7, 6);
}
export function limb(g: Ctx, a: Pt, b: Pt, c: string, w: number) {
  beam(g, ink, a, b, w + 2, w * .62 + 2); beam(g, c, a, b, w, w * .62);
}

/** Two-bone IK: the joint between a and b for the given bone lengths; sign picks the bend. */
export function joint(a: Pt, b: Pt, len: readonly [number, number], sign: number) {
  const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1, d = Math.min(L, len[0] + len[1] - .001),
    h = (len[0] ** 2 - len[1] ** 2 + d * d) / (2 * d), k = sign * Math.sqrt(Math.max(0, len[0] ** 2 - h * h));
  return P(a.x + (dx * h - dy * k) / L, a.y + (dy * h + dx * k) / L);
}
// Bend depth disappears in a frontal projection; the side-view IK stays exact.
export function projectedJoint(a: Pt, b: Pt, lengths: readonly [number, number], bend: number, front: number, lateral: number) {
  const j = joint(a, b, lengths, bend);
  if (front) {
    const middle = between(a, b, lengths[0] / (lengths[0] + lengths[1]));
    j.x = mix(j.x, middle.x + lateral, front); j.y = mix(j.y, middle.y, front);
  }
  return j;
}

// Round a closed contour through the midpoints of its control edges.
export function contour(g: Ctx, color: string, points: Pt[]) {
  const last = points[points.length - 1], start = between(last, points[0], .5);
  g.beginPath(); g.moveTo(start.x, start.y);
  for (let i = 0; i < points.length; i++) {
    const p = points[i], end = between(p, points[(i + 1) % points.length], .5);
    g.quadraticCurveTo(p.x, p.y, end.x, end.y);
  }
  g.closePath(); g.fillStyle = color; g.fill();
}
// Shape the soft tissue around the solved bones. Each outline spans its joint.
export function flesh(g: Ctx, color: string, root: Pt, jnt: Pt, tip: Pt, width: readonly number[]) {
  function offset(a: Pt, b: Pt, u: number, w: number) {
    const p = between(a, b, u), dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
    return P(p.x - dy * w / d, p.y + dx * w / d);
  }
  const edge = (sign: number) => [
    offset(root, jnt, -.14, width[0] * .64 * sign),
    offset(root, jnt, .24, width[0] * sign),
    offset(root, jnt, .76, width[1] * 1.16 * sign),
    offset(root, jnt, 1, width[1] * sign),
    offset(jnt, tip, 0, width[1] * sign),
    offset(jnt, tip, .26, width[2] * sign),
    offset(jnt, tip, .73, width[3] * 1.2 * sign),
    offset(jnt, tip, 1.04, width[3] * sign)];
  contour(g, color, [...edge(1), ...edge(-1).reverse()]);
}

export function boot(ank: Pt, angle: number) {
  const cs = Math.cos(angle), sn = Math.sin(angle), corners = [[-4, 0], [-2, -4], [2, -4], [4, 0], [10, 2], [10, 4], [-4, 4]];
  return corners.flatMap(([x, y]) => [ank.x + x * cs - y * sn, ank.y + x * sn + y * cs]);
}

/** Loader body bob over one step. */
export const bob: Keys = [[0, 0], [.15, 1], [.48, -.65], [.78, -1], [1, 0]];

/** Planted stride: the foot position on `side` for hip at x, feet resting on `floor`. */
export function walk(x: number, start: number, stride: number, side: number, heavy: boolean, floor: number) {
  const n = (x - start) / stride + side * .5, i = Math.floor(n), u = n - i, stance = heavy ? .67 : .60,
    s = clamp((u - stance) / (1 - stance)), land = start + (i - side * .5 + stance / 2) * stride;
  return P(land + stride * smooth(s), floor - (heavy ? 20 : 15) * Math.sin(Math.PI * s) ** 1.3);
}

/** Cruise at a steady cadence between short smooth acceleration ramps. */
export function progress(t: number, a: number, b: number, r: number) {
  const d = b - a, z = Math.max(0, Math.min(d, t - a)), area = (v: number) => v * v * v * (1 - v * .5);
  if (z < r) return r * area(z / r) / (d - r);
  if (z > d - r) return 1 - r * area((d - z) / r) / (d - r);
  return (z - r * .5) / (d - r);
}

/** Mirror the drawing about x = cx when facing left. Call inside save/restore. */
export function face(g: Ctx, cx: number, facing: 1 | -1) {
  if (facing < 0) { g.translate(cx, 0); g.scale(-1, 1); g.translate(-cx, 0); }
}

/** A small file folder with a letter, so colour is never the only cue. */
export function folder(g: Ctx, x: number, y: number, hex: string, letter: string, size = 1) {
  g.save(); g.translate(x, y); g.scale(size, size);
  poly(g, ink, -11, 8, -11, -8, -9, -10, -3, -10, -1, -8, 11, -8, 11, 8);
  poly(g, hex, -9.5, 6.5, -9.5, -6.8, -8.3, -8.4, -3.6, -8.4, -1.8, -6.6, 9.5, -6.6, 9.5, 6.5);
  rect(g, 'rgba(255,255,255,.35)', -9.5, -5, 19, 1.5);
  g.fillStyle = ink; g.font = '800 9px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(letter, 0, 1.5);
  g.restore();
}

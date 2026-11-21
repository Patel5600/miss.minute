/**
 * Measured proportions of Miss Minutes.
 *
 * Every number here comes from the owner's reference collection, mainly giphy.gif
 * (578x732, the cleanest on-model vector loop) with the show cutout as a cross-check.
 * Units: the face disc radius, measured to the centre of its outline, is 100.
 * In giphy.gif frame 0 one unit is 2.454 px. Origin: centre of the face disc, y down.
 */
import { cubicPoint, type Vec } from './math';

export const R = 100;
/** Face outline: 6.8 px in the GIF = 0.028 R. */
export const LINE = 2.8;
/** Disc thickness. Frames 0/3/8 of the GIF and the 3D turnaround agree on about 0.3 R. */
export const DISC_DEPTH = 30;
/** Soles sit 180 units below the face centre (GIF frame 0: shoe bottoms at y=722). */
export const GROUND_Y = 180;

/**
 * Dial marks. The references have 16, not 12: thick bars at 12/3/6/9 and three thin marks
 * per quadrant, bunched symmetrically around the diagonal (measured 17.1, 44.6, 72.4 deg).
 * Radii include the rounded caps. Thick bars: 61-88.6, 5.9 wide. Thin: 74.4-87.8, 1.65 wide.
 */
export interface Tick { angle: number; r0: number; r1: number; width: number }
export const TICKS: readonly Tick[] = (() => {
  const out: Tick[] = [];
  for (let q = 0; q < 4; q += 1) {
    out.push({ angle: q * 90, r0: 61.2, r1: 88.6, width: 5.9 });
    for (const a of [17.3, 45, 72.7]) out.push({ angle: q * 90 + a, r0: 74.4, r1: 87.8, width: 1.65 });
  }
  return out;
})();

/** Nose: a dot 0.1 R across, a hair above centre. */
export const NOSE = { x: 0, y: -1.5, r: 4.95 };

/**
 * Eyes: egg / bullet shapes (rounded dome, near-vertical sides, flattened bottom).
 * Interior 38.4 x 53 units (w/h 0.725 after removing the GIF's 3/4 squash); centres 74 apart,
 * 18.5 above the face centre, so their bottoms sit below the nose like the reference.
 * The outline is a symmetric pair of cubics fitted to the measured row widths (RMSE 1.6%).
 */
export const EYE = {
  x: 37,
  y: -18.5,
  /** Half width at the outline centre. */
  a: 20.4,
  /** Height at the outline centre. */
  h: 55.4,
  line: 2.5,
};

/** Normalised right-half control points (x in half widths, y from 0 = top to 1 = bottom). */
const EYE_CURVE = {
  p1: { x: 0.639, y: 0 },
  p2: { x: 1, y: 0.2831 },
  p3: { x: 1, y: 0.7151 },
  q1: { x: 1, y: 0.9711 },
  q2: { x: 0.8927, y: 1 },
};

function eyePoint(nx: number, ny: number, scale: number): Vec {
  return { x: nx * EYE.a * scale, y: (ny - 0.5) * EYE.h * scale };
}

/** Eye outline path in eye-local coordinates. `grow` offsets it outward (used for clipping). */
export function eyePathD(grow = 0): string {
  const s = 1 + grow / EYE.a;
  const p = (nx: number, ny: number) => {
    const v = eyePoint(nx, ny, 1);
    // Uniform growth around the centre approximates an outward offset of `grow` units.
    return `${(v.x * s).toFixed(2)} ${(v.y * (1 + grow / (EYE.h / 2))).toFixed(2)}`;
  };
  const c = EYE_CURVE;
  return [
    `M ${p(0, 0)}`,
    `C ${p(c.p1.x, c.p1.y)} ${p(c.p2.x, c.p2.y)} ${p(c.p3.x, c.p3.y)}`,
    `C ${p(c.q1.x, c.q1.y)} ${p(c.q2.x, c.q2.y)} ${p(0, 1)}`,
    `C ${p(-c.q2.x, c.q2.y)} ${p(-c.q1.x, c.q1.y)} ${p(-c.p3.x, c.p3.y)}`,
    `C ${p(-c.p2.x, c.p2.y)} ${p(-c.p1.x, c.p1.y)} ${p(0, 0)}`,
    'Z',
  ].join(' ');
}

/**
 * Upper and lower boundary of the eye as functions of x, tabulated once.
 * Lids and lashes need them every frame, and a table lookup is far cheaper than solving cubics.
 */
const TABLE_N = 48;
const topTable = new Float64Array(TABLE_N + 1);
const bottomTable = new Float64Array(TABLE_N + 1);
(() => {
  const c = EYE_CURVE;
  const upper: Vec[] = [];
  const lower: Vec[] = [];
  const P0 = eyePoint(0, 0, 1);
  const P1 = eyePoint(c.p1.x, c.p1.y, 1);
  const P2 = eyePoint(c.p2.x, c.p2.y, 1);
  const P3 = eyePoint(c.p3.x, c.p3.y, 1);
  const Q1 = eyePoint(c.q1.x, c.q1.y, 1);
  const Q2 = eyePoint(c.q2.x, c.q2.y, 1);
  const Q3 = eyePoint(0, 1, 1);
  for (let i = 0; i <= 200; i += 1) {
    upper.push(cubicPoint(P0, P1, P2, P3, i / 200));
    lower.push(cubicPoint(P3, Q1, Q2, Q3, i / 200));
  }
  const sample = (pts: Vec[], x: number, pickMin: boolean) => {
    let best = pickMin ? Infinity : -Infinity;
    for (let i = 1; i < pts.length; i += 1) {
      const a = pts[i - 1];
      const b = pts[i];
      const lo = Math.min(a.x, b.x);
      const hi = Math.max(a.x, b.x);
      if (x < lo || x > hi) continue;
      const t = hi === lo ? 0 : (x - a.x) / (b.x - a.x);
      const y = a.y + (b.y - a.y) * t;
      best = pickMin ? Math.min(best, y) : Math.max(best, y);
    }
    return Number.isFinite(best) ? best : P3.y;
  };
  for (let i = 0; i <= TABLE_N; i += 1) {
    const x = (i / TABLE_N) * EYE.a;
    topTable[i] = sample(upper, Math.min(x, EYE.a - 1e-6), true);
    bottomTable[i] = sample(lower, Math.min(x, EYE.a - 1e-6), false);
  }
})();

function lookup(table: Float64Array, x: number): number {
  const ax = Math.min(Math.abs(x), EYE.a);
  const fi = (ax / EYE.a) * TABLE_N;
  const i = Math.min(TABLE_N - 1, Math.floor(fi));
  const t = fi - i;
  return table[i] + (table[i + 1] - table[i]) * t;
}
/** y of the eye's upper outline at x (eye-local). */
export const eyeTopAt = (x: number): number => lookup(topTable, x);
/** y of the eye's lower outline at x (eye-local). */
export const eyeBottomAt = (x: number): number => lookup(bottomTable, x);
/** Half width of the eye at height y (eye-local), by bisection on the monotone side curves. */
export function eyeHalfWidthAt(y: number): number {
  if (y <= -EYE.h / 2 || y >= EYE.h / 2) return 0;
  let lo = 0;
  let hi = EYE.a;
  const below = y > eyeTopAt(EYE.a);
  for (let i = 0; i < 14; i += 1) {
    const mid = (lo + hi) / 2;
    const inside = below ? eyeBottomAt(mid) > y : eyeTopAt(mid) < y;
    if (inside) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Pupils: tall ellipses 0.6 x 0.81 of the eye interior, resting a little low.
 * The highlight is a wedge cut from the upper right (same side on both eyes, as in every
 * reference), given here in pupil-normalised coordinates.
 */
export const PUPIL = {
  rx: 11.4,
  ry: 21.4,
  restX: 0,
  restY: 2,
  inner: { rx: 7.2, ry: 14.2, dx: 1.4, dy: 4.2 },
  notch: [
    { x: 0.33, y: -1.14 },
    { x: 0.88, y: -0.76 },
    { x: 0.02, y: -0.35 },
  ] as const,
  /** Travel before the pupil meets the outline; beyond it the eye shape clips it. */
  travelX: 7.6,
  travelUp: 10.5,
  travelDown: 5.5,
};

/**
 * Four lashes per eye on the top of the dome, fanned outward. (The brief mentions three;
 * giphy.gif, the cutout and the orientation-video close-up all show four.)
 * `x` is the base position as a fraction of the eye half width; `angle` is from vertical.
 */
export const LASHES = [
  { x: -0.5, angle: -38, length: 6.6 },
  { x: -0.21, angle: -11, length: 7.6 },
  { x: 0.21, angle: 11, length: 7.6 },
  { x: 0.5, angle: 38, length: 6.6 },
] as const;
export const LASH_WIDTH = 2.05;

/** Closed-lid arc of the GIF blink (frames 2-4): 57% down the eye, rising 7 units at the middle. */
export const CLOSED_LID = { y: 4.2, arch: 7.4 };

/** Rubber-hose arms: 12-unit orange core inside a 2.5-unit outline (GIF: 31 px + 6 px). */
export const ARM = {
  core: 12,
  line: 2.5,
  /** Hidden pivot behind the disc. */
  shoulderX: 58,
  shoulderY: 28,
};
/** Cuff measured from the wrist back up the arm: 3.6 orange, 3.3 dark, 3.5 orange, 3.3 dark. */
export const CUFF = { tail: 3.6, stripe: 3.3, gap: 3.5 };

/** Legs: 7.8 units (19 px) of solid black, from behind the disc bottom to the shoe collar. */
export const LEG = {
  width: 7.8,
  hipX: 19,
  hipY: 92,
  /** Ankle spacing at rest (half). */
  footX: 21,
  /** Ankle height above the ground. */
  ankle: 27,
};

/** Glove and shoe outlines. */
export const GLOVE_LINE = 2.5;
export const SHOE_LINE = 2.7;

/** Rig view box: wide enough for arms out and a raised wave; ground at y = 180. */
export const VIEW = { x: -215, y: -232, w: 430, h: 440 };

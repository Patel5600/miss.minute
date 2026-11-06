/** Small numeric helpers shared by the rig. Kept dependency-free so the engine stays cheap per frame. */

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number): number => (b === a ? 0 : clamp((v - a) / (b - a), 0, 1));

export const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);
export const easeIn = (t: number): number => t * t * t;
/** Overshoots slightly before settling; reads as a cartoon "snap" into a pose. */
export const easeOutBack = (t: number): number => {
  const c1 = 1.4;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
export const smoothstep = (t: number): number => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

/** Frame-rate independent exponential approach toward a target. */
export const damp = (current: number, target: number, rate: number, dt: number): number =>
  target + (current - target) * Math.exp(-rate * dt);

export const wrapAngle = (a: number): number => {
  let x = (a + 180) % 360;
  if (x < 0) x += 360;
  return x - 180;
};
/** Interpolates angles in degrees along the shortest arc. */
export const lerpAngle = (a: number, b: number, t: number): number => a + wrapAngle(b - a) * t;

/** Two-decimal fixed output keeps attribute strings short and lets unchanged frames compare equal. */
export const f = (v: number): string => {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? '0' : String(r);
};

/** Deterministic PRNG (mulberry32): blink and saccade timing is reproducible for snapshots. */
export function createRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Vec { x: number; y: number }

export const cubicPoint = (p0: Vec, p1: Vec, p2: Vec, p3: Vec, t: number): Vec => {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
};

/** Arc length of a cubic by chord sampling; 12 segments is within 0.3% for arm-like curves. */
export function cubicLength(p0: Vec, p1: Vec, p2: Vec, p3: Vec, segments = 12): number {
  let length = 0;
  let prev = p0;
  for (let i = 1; i <= segments; i += 1) {
    const p = cubicPoint(p0, p1, p2, p3, i / segments);
    length += Math.hypot(p.x - prev.x, p.y - prev.y);
    prev = p;
  }
  return length;
}

/** Applies translate(tx,ty) rotate(deg) scale(sx,sy) to a point, matching SVG transform order. */
export function transformPoint(p: Vec, tx: number, ty: number, deg: number, sx: number, sy: number): Vec {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  const x = p.x * sx;
  const y = p.y * sy;
  return { x: tx + x * c - y * s, y: ty + x * s + y * c };
}

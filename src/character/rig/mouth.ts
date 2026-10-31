/**
 * Parametric mouth. One closed outline (upper lip, lower lip) whose width, openness,
 * roundness, corner lift and skew interpolate continuously, so lip sync and mood changes
 * morph the same shape instead of swapping drawings. Teeth and tongue are clipped to it.
 */
import { clamp, f, lerp } from './math';

export interface MouthShape {
  x: number;
  y: number;
  w: number;
  curve: number;
  open: number;
  round: number;
  skew: number;
  teeth: number;
  tongue: number;
  dimple: number;
}

export interface MouthGeometry {
  outline: string;
  teeth: string;
  tongue: { cx: number; cy: number; rx: number; ry: number };
  dimples: string;
  /** Interior is worth drawing (skip the fill when the lips are together). */
  isOpen: boolean;
}

export function buildMouth(m: MouthShape): MouthGeometry {
  const w = Math.max(6, m.w);
  const open = Math.max(0, m.open);
  const round = clamp(m.round, 0, 1);
  const lx = m.x - w / 2;
  const rx = m.x + w / 2;
  const ly = m.y + m.skew / 2;
  const ry = m.y - m.skew / 2;
  // A round mouth lifts the upper lip into an arch; a lens or smile opens downward only.
  const lift = round * open * 0.45;
  const uy = m.y + m.curve - lift;
  const dy = uy + open;
  const ku = lerp(0.3, 0.12, round);
  // Deeper openings get fuller, rounder bottoms (the "D" of a big smile).
  const kl = lerp(0.3, 0.04, clamp(Math.max(round, open / 13), 0, 1));
  const ucy = (8 * uy - ly - ry) / 6;
  const lcy = (8 * dy - ly - ry) / 6;
  const u1x = lx + w * ku;
  const u2x = rx - w * ku;
  const l1x = rx - w * kl;
  const l2x = lx + w * kl;

  const outline =
    `M ${f(lx)} ${f(ly)} C ${f(u1x)} ${f(ucy)} ${f(u2x)} ${f(ucy)} ${f(rx)} ${f(ry)} ` +
    `C ${f(l1x)} ${f(lcy)} ${f(l2x)} ${f(lcy)} ${f(lx)} ${f(ly)} Z`;

  const th = Math.min(open + 1, 1.6 + open * 0.42) * clamp(m.teeth, 0, 1);
  const teeth =
    `M ${f(lx)} ${f(ly)} C ${f(u1x)} ${f(ucy)} ${f(u2x)} ${f(ucy)} ${f(rx)} ${f(ry)} ` +
    `L ${f(rx)} ${f(ry + th)} C ${f(u2x)} ${f(ucy + th)} ${f(u1x)} ${f(ucy + th)} ${f(lx)} ${f(ly + th)} Z`;

  const tongueAmount = clamp(m.tongue, 0, 1);
  const tongue = {
    cx: m.x + m.skew * 0.12,
    cy: dy - open * 0.12 + 1,
    rx: w * lerp(0.26, 0.2, round) * (0.6 + 0.4 * tongueAmount),
    ry: Math.max(0.01, open * 0.42 * tongueAmount),
  };

  const d = clamp(m.dimple, 0, 1);
  let dimples = '';
  if (d > 0.02) {
    const s = 0.55 + 0.45 * d;
    dimples =
      `M ${f(lx - 0.6 * s)} ${f(ly - 4.2 * s)} Q ${f(lx - 4 * s)} ${f(ly - 0.2)} ${f(lx - 0.4 * s)} ${f(ly + 3.6 * s)} ` +
      `M ${f(rx + 0.6 * s)} ${f(ry - 4.2 * s)} Q ${f(rx + 4 * s)} ${f(ry - 0.2)} ${f(rx + 0.4 * s)} ${f(ry + 3.6 * s)}`;
  }

  return { outline, teeth, tongue, dimples, isOpen: open > 0.35 };
}

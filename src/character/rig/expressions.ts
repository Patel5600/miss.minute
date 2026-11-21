/**
 * Parametric face states for the twelve moods. Each mood is a vector of numbers so the engine
 * can blend between any two of them (and the lip-sync and blink layers) without swapping art.
 * Values are tuned against the references named beside each mood.
 */
import type { Emotion, MouthFrame } from '../../types';

export interface MouthPose {
  /** Centre between the corners, face units. */
  x: number;
  /** Height of the corners. */
  y: number;
  /** Corner to corner. */
  w: number;
  /** Upper-lip middle relative to the corners: + smiles (middle lower), - arches into a frown. */
  curve: number;
  /** Lower-lip drop below the upper lip at the middle. */
  open: number;
  /** 0 lens, 1 round "O". */
  round: number;
  /** Right corner up (+) or down (-): lopsided smirks and pouts. */
  skew: number;
  teeth: number;
  tongue: number;
  /** Corner creases of a big smile (promo art). */
  dimple: number;
}

export interface FacePose {
  /** Upper-lid openness per eye [screen-left, screen-right]: 1 open, 0 closed. */
  open: [number, number];
  /** Lid slope in degrees: + lowers the inner corner (determined), - the outer one (worried). */
  tilt: [number, number];
  /** Lower-lid rise 0..1 (smiling or squinting eyes). */
  lower: [number, number];
  /** Arch of a closed lid: high values give the happy "^" of a wink. */
  arch: [number, number];
  /** Gaze bias in travel units (-1..1) and pupil size. */
  pupil: { x: number; y: number; scale: number };
  lash: { spread: number; length: number };
  eyeScale: number;
  mouth: MouthPose;
  cheeks: number;
  /** Hologram bloom strength (1 = normal). */
  glow: number;
  /** 0 amber, 1 the red Citadel tone. */
  tone: number;
}

const mouth = (m: Partial<MouthPose>): MouthPose => ({
  x: 0, y: 30, w: 28, curve: 0, open: 0, round: 0, skew: 0, teeth: 0, tongue: 0, dimple: 0, ...m,
});

const pose = (p: Partial<Omit<FacePose, 'mouth'>> & { mouth: Partial<MouthPose> }): FacePose => ({
  open: [1, 1],
  tilt: [0, 0],
  lower: [0, 0],
  arch: [7.4, 7.4],
  pupil: { x: 0, y: 0, scale: 1 },
  lash: { spread: 1, length: 1 },
  eyeScale: 1,
  cheeks: 0,
  glow: 1,
  tone: 0,
  ...p,
  mouth: mouth(p.mouth),
});

export const EXPRESSIONS: Record<Emotion, FacePose> = {
  // Lovely_Miss_Minutes / promo: big toothy smile, bright open eyes, smile creases.
  cheerful: pose({
    lower: [0.16, 0.16],
    pupil: { x: 0, y: 0.05, scale: 1 },
    cheeks: 0.1,
    mouth: { y: 27, w: 36, curve: 6.5, open: 8.5, round: 0.05, teeth: 0.62, tongue: 0.25, dimple: 0.85 },
  }),
  // Transparent cutout / MissMinutes.webp: friendly open lens with teeth and tongue.
  talking: pose({
    lower: [0.06, 0.06],
    mouth: { y: 30, w: 31, curve: 1.6, open: 6.8, round: 0.2, teeth: 0.42, tongue: 0.55 },
  }),
  // Closed happy arc on one eye, smirk lifted on the same side.
  winking: pose({
    open: [1, 0],
    lower: [0.22, 0.4],
    arch: [7.4, 10.5],
    pupil: { x: 0.1, y: 0, scale: 1 },
    mouth: { x: 2, y: 28, w: 31, curve: 5, open: 3.2, skew: 3.4, teeth: 0.75, dimple: 0.7 },
  }),
  // BTS3 side-eye: flat half lids, pupils parked at the side, teeth showing in a flat lens.
  suspicious: pose({
    open: [0.6, 0.6],
    tilt: [5, 5],
    lower: [0.14, 0.14],
    pupil: { x: -0.9, y: 0.15, scale: 0.96 },
    lash: { spread: 0.9, length: 0.92 },
    mouth: { x: -2, y: 31, w: 25, curve: 0.4, open: 2.6, skew: -2.2, teeth: 1 },
  }),
  // Citadel: menacing grin, pinpoint pupils, lids cut at the inner corners, red glow.
  scary: pose({
    open: [1, 1],
    tilt: [17, 17],
    lower: [0.12, 0.12],
    pupil: { x: 0, y: 0.1, scale: 0.55 },
    lash: { spread: 1.1, length: 1 },
    glow: 1.45,
    tone: 1,
    mouth: { y: 26, w: 44, curve: 7.5, open: 9.5, round: 0, teeth: 0.85, tongue: 0, dimple: 0.4 },
  }),
  // giphy.gif frames 6-17: eyes rolled up and right, lopsided pout.
  thinking: pose({
    open: [0.96, 0.96],
    tilt: [-3, -3],
    pupil: { x: 0.62, y: -1, scale: 1 },
    mouth: { x: 4, y: 33, w: 19, curve: -1.5, open: 4.2, round: 0.55, skew: 3, teeth: 0.35 },
  }),
  // Reset-charge business face: lowered determined lids, clenched grin.
  pruning: pose({
    open: [0.8, 0.8],
    tilt: [12, 12],
    lower: [0.2, 0.2],
    pupil: { x: 0, y: 0.05, scale: 0.86 },
    glow: 1.2,
    tone: 0.35,
    mouth: { y: 29, w: 34, curve: 3.2, open: 3.4, teeth: 1, dimple: 0.25 },
  }),
  // Miss_Minutes_blushing: pink cheek ovals, shy squint, eyes aside, small closed smile.
  blushing: pose({
    open: [0.86, 0.86],
    tilt: [-4, -4],
    lower: [0.26, 0.26],
    pupil: { x: 0.78, y: 0.35, scale: 0.95 },
    cheeks: 1,
    mouth: { x: 1, y: 29, w: 21, curve: 3.6, open: 0.4, dimple: 0.35 },
  }),
  // Stern_Miss_Minutes: wide flat stare, centred pupils, short flat mouth.
  stern: pose({
    open: [0.9, 0.9],
    tilt: [2, 2],
    lower: [0.06, 0.06],
    pupil: { x: 0, y: -0.05, scale: 0.82 },
    lash: { spread: 0.85, length: 0.85 },
    mouth: { y: 33, w: 19, curve: 0, open: 1.2 },
  }),
  // Miss_Minutes_appears: wide eyes, small pupils, open "D" mouth with tongue.
  surprised: pose({
    eyeScale: 1.07,
    pupil: { x: 0, y: 0, scale: 0.7 },
    lash: { spread: 1.25, length: 1.12 },
    mouth: { y: 29, w: 27, curve: 1.2, open: 12.5, round: 0.55, teeth: 0.4, tongue: 0.6 },
  }),
  // Falling-variant scene: half lids, eyes to the side, lopsided smirk.
  sassy: pose({
    open: [0.72, 0.72],
    tilt: [4, 4],
    lower: [0.18, 0.18],
    pupil: { x: 0.85, y: -0.05, scale: 0.98 },
    mouth: { x: 3, y: 29, w: 26, curve: 4, open: 2.4, skew: 5, teeth: 0.9, dimple: 0.55 },
  }),
  // giphy.gif frame 0: the worried arch with the upper teeth showing.
  worried: pose({
    tilt: [-10, -10],
    pupil: { x: 0.08, y: 0.05, scale: 1 },
    mouth: { x: 1, y: 32.5, w: 29, curve: -5.7, open: 3.6, teeth: 0.85 },
  }),
};

/**
 * Lip-sync targets for the five loudness/viseme frames from voiceService:
 * 0 rest, 1 E/I, 2 O, 3 A (widest), 4 U/W or loudest. Openness 0..1 and roundness 0..1.
 */
export const VISEMES: Record<MouthFrame, { open: number; round: number; wide: number }> = {
  0: { open: 0, round: 0, wide: 0 },
  1: { open: 0.34, round: 0.05, wide: 0.08 },
  2: { open: 0.62, round: 0.6, wide: -0.1 },
  3: { open: 1, round: 0.2, wide: 0.06 },
  4: { open: 0.78, round: 0.75, wide: -0.16 },
};

/** Flat layout used by the engine's damped vector. */
export const FACE_KEYS = [
  'openL', 'openR', 'tiltL', 'tiltR', 'lowerL', 'lowerR', 'archL', 'archR',
  'pupilX', 'pupilY', 'pupilScale', 'lashSpread', 'lashLength', 'eyeScale',
  'mouthX', 'mouthY', 'mouthW', 'mouthCurve', 'mouthOpen', 'mouthRound', 'mouthSkew',
  'teeth', 'tongue', 'dimple', 'cheeks', 'glow', 'tone',
] as const;
export type FaceKey = (typeof FACE_KEYS)[number];
export const FK = Object.fromEntries(FACE_KEYS.map((k, i) => [k, i])) as Record<FaceKey, number>;

export function packFace(p: FacePose, out = new Float64Array(FACE_KEYS.length)): Float64Array {
  out[FK.openL] = p.open[0];
  out[FK.openR] = p.open[1];
  out[FK.tiltL] = p.tilt[0];
  out[FK.tiltR] = p.tilt[1];
  out[FK.lowerL] = p.lower[0];
  out[FK.lowerR] = p.lower[1];
  out[FK.archL] = p.arch[0];
  out[FK.archR] = p.arch[1];
  out[FK.pupilX] = p.pupil.x;
  out[FK.pupilY] = p.pupil.y;
  out[FK.pupilScale] = p.pupil.scale;
  out[FK.lashSpread] = p.lash.spread;
  out[FK.lashLength] = p.lash.length;
  out[FK.eyeScale] = p.eyeScale;
  out[FK.mouthX] = p.mouth.x;
  out[FK.mouthY] = p.mouth.y;
  out[FK.mouthW] = p.mouth.w;
  out[FK.mouthCurve] = p.mouth.curve;
  out[FK.mouthOpen] = p.mouth.open;
  out[FK.mouthRound] = p.mouth.round;
  out[FK.mouthSkew] = p.mouth.skew;
  out[FK.teeth] = p.mouth.teeth;
  out[FK.tongue] = p.mouth.tongue;
  out[FK.dimple] = p.mouth.dimple;
  out[FK.cheeks] = p.cheeks;
  out[FK.glow] = p.glow;
  out[FK.tone] = p.tone;
  return out;
}

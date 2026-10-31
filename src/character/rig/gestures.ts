/**
 * Keyframed arm poses for every gesture, in body coordinates (face centre at the origin,
 * face radius 100). "left"/"right" are screen sides. Each gesture eases in, holds while an
 * oscillator adds the business (waving, wagging, knocking, clapping), then eases back to idle.
 */
import type { Gesture } from '../../types';
import { TAU } from './math';
import type { HandShape } from './hands';

export interface ArmPose {
  /** Wrist position. */
  x: number;
  y: number;
  /** Direction the fingers point, degrees (0 = screen right, 90 = down). */
  hand: number;
  /** Direction the arm leaves the shoulder, degrees. */
  shoulder: number;
  /** Control-arm length as a fraction of shoulder-to-wrist distance (how much the hose bows). */
  reach: number;
  shape: HandShape;
  /** Draw over the face (hand to chin, knocking toward the glass, clapping in front). */
  front: boolean;
  /** Hand scale; > 1 reads as the hand coming toward the viewer. */
  scale: number;
}

export interface BodyOffset {
  roll: number;
  bob: number;
  lean: number;
}

export interface GesturePose {
  left: ArmPose;
  right: ArmPose;
  body: BodyOffset;
}

export interface GestureDef {
  pose: GesturePose;
  enter: number;
  hold: number;
  exit: number;
  /** Overshoot into the pose instead of a plain ease. */
  snap?: boolean;
  /** Adds motion during the hold. `t` is seconds since the hold began. */
  osc?: (t: number, p: GesturePose) => void;
  /** Seconds after the hold began when the hand hits something (knock/clap events). */
  impacts?: readonly number[];
}

const arm = (p: Partial<ArmPose> & Pick<ArmPose, 'x' | 'y' | 'hand' | 'shoulder'>): ArmPose => ({
  reach: 0.42, shape: 'fist', front: false, scale: 1, ...p,
});

/** Screen-left arm as the mirror image of a screen-right pose. */
export const mirrorArm = (p: ArmPose): ArmPose => ({
  ...p, x: -p.x, hand: 180 - p.hand, shoulder: 180 - p.shoulder,
});

const body = (b: Partial<BodyOffset> = {}): BodyOffset => ({ roll: 0, bob: 0, lean: 0, ...b });

/** Arms hanging at the sides with relaxed fists (giphy.gif rest). */
export const IDLE_RIGHT = arm({ x: 84, y: 94, hand: 87, shoulder: 74, reach: 0.4 });
export const IDLE_POSE: GesturePose = { left: mirrorArm(IDLE_RIGHT), right: IDLE_RIGHT, body: body() };

const HIP_RIGHT = arm({ x: 90, y: 60, hand: 158, shoulder: 2, reach: 0.82, shape: 'fist' });

export const GESTURE_DEFS: Record<Exclude<Gesture, 'none'>, GestureDef> = {
  // images (1).jpg "HEY Y'ALL!": open palm raised beside the face, other fist on the hip.
  wave: {
    pose: {
      right: arm({ x: 118, y: -14, hand: -97, shoulder: 4, reach: 0.55, shape: 'open' }),
      left: mirrorArm(HIP_RIGHT),
      body: body({ roll: -3, bob: -1 }),
    },
    enter: 0.32,
    hold: 1.9,
    exit: 0.45,
    snap: true,
    osc: (t, p) => {
      const w = Math.sin(t * TAU * 2.4);
      p.right.hand += 17 * w;
      p.right.x += 4 * Math.sin(t * TAU * 2.4 + 0.6);
      p.body.roll += 1.2 * w;
    },
  },
  // Transparent cutout: arms out to the sides, palms up.
  shrug: {
    pose: {
      right: arm({ x: 140, y: 64, hand: -9, shoulder: 12, reach: 0.5, shape: 'palmUp' }),
      left: mirrorArm(arm({ x: 140, y: 64, hand: -9, shoulder: 12, reach: 0.5, shape: 'palmUp' })),
      body: body({ bob: -4 }),
    },
    enter: 0.34,
    hold: 1.3,
    exit: 0.45,
    snap: true,
    osc: (t, p) => {
      const b = Math.max(0, Math.sin(t * TAU * 0.9));
      p.body.bob -= 1.6 * b;
      p.right.y -= 3 * b;
      p.left.y -= 3 * b;
    },
  },
  // images.jpg "now listen here": index finger up, other fist on the hip.
  point: {
    pose: {
      left: mirrorArm(arm({ x: 116, y: -30, hand: -84, shoulder: 8, reach: 0.55, shape: 'point' })),
      right: HIP_RIGHT,
      body: body({ roll: 2.5 }),
    },
    enter: 0.3,
    hold: 1.7,
    exit: 0.45,
    snap: true,
    osc: (t, p) => {
      p.left.hand += 8 * Math.sin(t * TAU * 2.1);
      p.left.y += 1.5 * Math.sin(t * TAU * 2.1 + 1.2);
    },
  },
  // Falling-variant scene: both fists on the hips, elbows out, a sassy sway.
  hips: {
    pose: { right: HIP_RIGHT, left: mirrorArm(HIP_RIGHT), body: body({ roll: 4 }) },
    enter: 0.35,
    hold: 2.4,
    exit: 0.5,
    osc: (t, p) => {
      p.body.roll += 2.2 * Math.sin(t * TAU * 0.75);
    },
  },
  // Promo art: one arm sweeps out palm up, the other hand raised by the head.
  present: {
    pose: {
      left: mirrorArm(arm({ x: 150, y: 20, hand: -12, shoulder: 6, reach: 0.5, shape: 'palmUp' })),
      right: arm({ x: 110, y: -40, hand: -72, shoulder: 0, reach: 0.6, shape: 'open' }),
      body: body({ roll: -4, lean: -3 }),
    },
    enter: 0.42,
    hold: 1.5,
    exit: 0.5,
    snap: true,
  },
  // Hand to the chin, eyes up (the face side comes from the thinking mood).
  think: {
    pose: {
      right: arm({ x: 46, y: 80, hand: -128, shoulder: 70, reach: 0.62, shape: 'chin', front: true }),
      left: mirrorArm(HIP_RIGHT),
      body: body({ roll: 5 }),
    },
    enter: 0.36,
    hold: 2.4,
    exit: 0.45,
    osc: (t, p) => {
      p.right.y += 1.3 * Math.sin(t * TAU * 1.3);
    },
  },
  // Fourth wall: raps on the screen glass between her and the owner.
  knock: {
    pose: {
      right: arm({ x: 62, y: 16, hand: -82, shoulder: 18, reach: 0.6, shape: 'knock', front: true, scale: 1.32 }),
      left: IDLE_POSE.left,
      body: body({ lean: 2 }),
    },
    enter: 0.3,
    hold: 1.25,
    exit: 0.45,
    impacts: [0.34, 0.58, 0.82],
    osc: (t, p) => {
      // Each rap: the fist swells toward the glass and snaps back.
      let pulse = 0;
      for (const at of [0.34, 0.58, 0.82]) {
        const d = (t - at) / 0.11;
        if (d > -1 && d < 1) pulse = Math.max(pulse, 1 - d * d);
      }
      p.right.scale += 0.16 * pulse;
      p.right.y += 3 * pulse;
      p.body.bob += 0.8 * pulse;
    },
  },
  // Hands meet in front of her: five claps.
  clap: {
    pose: {
      right: arm({ x: 22, y: 74, hand: -96, shoulder: 96, reach: 0.6, shape: 'clap', front: true }),
      left: mirrorArm(arm({ x: 22, y: 74, hand: -96, shoulder: 96, reach: 0.6, shape: 'clap', front: true })),
      body: body(),
    },
    enter: 0.25,
    hold: 1.5,
    exit: 0.4,
    impacts: [0.15, 0.45, 0.75, 1.05, 1.35],
    osc: (t, p) => {
      const c = 0.5 + 0.5 * Math.cos((t - 0.15) * TAU / 0.3);
      const apart = 14 * (1 - c);
      p.right.x += apart;
      p.left.x -= apart;
      p.right.hand -= 10 * (1 - c);
      p.left.hand += 10 * (1 - c);
      p.body.bob += 1.2 * c;
    },
  },
};

/** Total run time of a gesture before it is back at idle. */
export const gestureDuration = (g: Exclude<Gesture, 'none'>): number => {
  const d = GESTURE_DEFS[g];
  return d.enter + d.hold + d.exit;
};

export function copyPose(src: GesturePose, out?: GesturePose): GesturePose {
  if (!out) return { left: { ...src.left }, right: { ...src.right }, body: { ...src.body } };
  Object.assign(out.left, src.left);
  Object.assign(out.right, src.right);
  Object.assign(out.body, src.body);
  return out;
}

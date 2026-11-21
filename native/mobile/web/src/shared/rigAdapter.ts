/**
 * Turns native commands into MissMinutesRig props. Pure and DOM-free so Node tests cover it.
 * Only type imports from the desktop code: the Node tests cannot resolve the `@desktop` alias.
 */
import type { Emotion, Gesture, MouthFrame } from '@desktop/types';
import { BASELINE_CAPABILITIES, CAPABILITY_NAMES, STATES } from './vocabulary.ts';
import type { OverlayState } from './vocabulary.ts';

export type RigLocomotion = 'idle' | 'walk' | 'drag' | 'fall';

export interface RigHandleLike {
  supports?: (name: string) => boolean;
}

/** The names the page reports in `hello`: the baseline plus whatever the rig says it supports. */
export function probeCapabilities(handle: object | null | undefined): string[] {
  const names = new Set<string>(BASELINE_CAPABILITIES);
  const supports = (handle as RigHandleLike | null | undefined)?.supports;
  if (typeof supports === 'function') {
    for (const name of CAPABILITY_NAMES) {
      if (names.has(name)) continue;
      let yes = false;
      try {
        yes = supports.call(handle, name) === true;
      } catch {
        yes = false;
      }
      if (yes) names.add(name);
    }
  }
  return CAPABILITY_NAMES.filter((name) => names.has(name));
}

export interface RigLook {
  emotion: Emotion;
  gesture: Gesture;
}

/** Provisional until the desktop state machine lands (14 states onto today's 12 emotions). */
export const STATE_TO_RIG: Readonly<Record<OverlayState, RigLook>> = {
  IDLE: { emotion: 'cheerful', gesture: 'none' },
  LISTENING: { emotion: 'cheerful', gesture: 'none' },
  THINKING: { emotion: 'thinking', gesture: 'think' },
  SPEAKING: { emotion: 'talking', gesture: 'none' },
  HAPPY: { emotion: 'cheerful', gesture: 'wave' },
  EXCITED: { emotion: 'cheerful', gesture: 'clap' },
  CURIOUS: { emotion: 'suspicious', gesture: 'none' },
  CONFUSED: { emotion: 'worried', gesture: 'shrug' },
  ANNOYED: { emotion: 'stern', gesture: 'hips' },
  SLEEPING: { emotion: 'blushing', gesture: 'none' },
  SURPRISED: { emotion: 'surprised', gesture: 'none' },
  ALERT: { emotion: 'stern', gesture: 'point' },
  ERROR: { emotion: 'worried', gesture: 'none' },
  HIDDEN: { emotion: 'cheerful', gesture: 'none' },
};

export interface RigView {
  emotion: Emotion;
  gesture: Gesture;
  /** Bumped on every gesture command so the same gesture can repeat. */
  gestureKey: number;
  isSpeaking: boolean;
  mouthFrame: MouthFrame;
  facing: -1 | 0 | 1;
  locomotion: RigLocomotion;
  /** Rig view-box units per second. */
  walkSpeed: number;
}

export const INITIAL_VIEW: RigView = {
  emotion: 'cheerful',
  gesture: 'none',
  gestureKey: 0,
  isSpeaking: false,
  mouthFrame: 0,
  facing: 0,
  locomotion: 'idle',
  walkSpeed: 0,
};

export interface RigCommand {
  type: string;
  payload: Record<string, unknown>;
}

const GESTURE_NAMES: readonly string[] = ['wave', 'shrug', 'point', 'hips', 'present', 'think', 'knock', 'clap'];
const EMOTION_NAMES: readonly string[] = [
  'cheerful', 'talking', 'winking', 'suspicious', 'scary', 'thinking', 'pruning',
  'blushing', 'stern', 'surprised', 'sassy', 'worried',
];

/** Today's rig draws four motions; richer native locomotion falls back to the nearest one. */
export function rigLocomotion(native: string): RigLocomotion {
  switch (native) {
    case 'WALK':
    case 'RUN':
      // The SVG rig currently has no separate run cycle; preserve the native speed while using its walk gait.
      return 'walk';
    case 'DRAGGED':
      return 'drag';
    case 'FALL':
    case 'THROWN':
      return 'fall';
    default:
      // Native choreography can be richer than the current four-motion renderer.
      return 'idle';
  }
}

/** Same vowel rule as `frameFor` in src/services/voiceService.ts. */
export function frameForSegment(text: string): MouthFrame {
  const value = text.toLowerCase();
  if (/[wuy]/.test(value)) return 4;
  if (/[o]/.test(value)) return 2;
  if (/[a]/.test(value)) return 3;
  if (/[ei]/.test(value)) return 1;
  return 0;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * `pxPerRigUnit` is the rendered size of one view-box unit in CSS pixels (the page measures it
 * and reports it as `rigScale` in `hello`). Native sends speeds in px/s.
 */
export function applyCommand(view: RigView, command: RigCommand, pxPerRigUnit: number): RigView {
  const p = command.payload;
  switch (command.type) {
    case 'rig.pose': {
      const locomotion = rigLocomotion(typeof p.locomotion === 'string' ? p.locomotion : 'STAND');
      const facingRaw = numberOr(p.facing, view.facing);
      const facing: -1 | 0 | 1 = facingRaw < 0 ? -1 : facingRaw > 0 ? 1 : 0;
      const speed = Math.max(0, numberOr(p.speed, 0));
      const walkSpeed = locomotion === 'walk' && pxPerRigUnit > 0 ? speed / pxPerRigUnit : 0;
      return { ...view, locomotion, facing, walkSpeed };
    }
    case 'rig.cue': {
      let { emotion, gesture } = view;
      if (typeof p.state === 'string' && (STATES as readonly string[]).includes(p.state)) {
        const look = STATE_TO_RIG[p.state as OverlayState];
        emotion = look.emotion;
        gesture = look.gesture;
      }
      if (typeof p.emotion === 'string' && EMOTION_NAMES.includes(p.emotion)) emotion = p.emotion as Emotion;
      if (typeof p.gesture === 'string' && (p.gesture === 'none' || GESTURE_NAMES.includes(p.gesture))) {
        gesture = p.gesture as Gesture;
      }
      const gestureKey = gesture === 'none' ? view.gestureKey : view.gestureKey + 1;
      return { ...view, emotion, gesture, gestureKey };
    }
    case 'rig.speech': {
      const speaking = p.speaking === true;
      const mouthFrame: MouthFrame = speaking
        ? typeof p.segment === 'string'
          ? frameForSegment(p.segment)
          : ([0, 1, 2, 3, 4].includes(numberOr(p.frame, 0)) ? (numberOr(p.frame, 0) as MouthFrame) : 0)
        : 0;
      return { ...view, isSpeaking: speaking, mouthFrame };
    }
    default:
      return view;
  }
}

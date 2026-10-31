/**
 * RigEngine: computes Miss Minutes' pose every frame and writes it straight into the SVG.
 * React renders the markup once; after that nothing re-renders per frame. All state is plain
 * numbers, attribute writes are skipped when the formatted value has not changed, and the shared
 * ticker is told when she is only idling so it can drop the frame rate.
 */
import type { Emotion, Gesture, MouthFrame } from '../../types';
import {
  clamp, createRandom, cubicLength, damp, DEG, easeInOut, easeOutBack, f, lerp, lerpAngle,
  smoothstep, TAU, transformPoint, type Vec,
} from './math';
import {
  ARM, CLOSED_LID, CUFF, DISC_DEPTH, EYE, eyeBottomAt, eyeHalfWidthAt, eyeTopAt, GROUND_Y,
  LASHES, LEG, PUPIL, R,
} from './geometry';
import { EXPRESSIONS, FACE_KEYS, FK, packFace, VISEMES } from './expressions';
import { buildMouth } from './mouth';
import {
  copyPose, GESTURE_DEFS, IDLE_POSE, type ArmPose, type GestureDef, type GesturePose,
} from './gestures';
import { HAND_REACH, HAND_SHAPES, type HandShape } from './hands';
import type { TickResult } from './ticker';

export type Locomotion = 'idle' | 'walk' | 'drag' | 'fall';

export interface RigInputs {
  emotion: Emotion;
  isSpeaking: boolean;
  mouthFrame: MouthFrame;
  /** -1 faces screen left, 1 screen right, 0 keeps the last side at rest. */
  facing: -1 | 0 | 1;
  locomotion: Locomotion;
  /** Ground speed while walking (rig units per second); the stride follows it so feet plant. */
  speed: number;
  reducedMotion: boolean;
}

/** A fixed moment to render instead of live animation (QA sheets, thumbnails). */
export interface RigSnapshot {
  /** Seconds into the idle cycle. */
  time?: number;
  gesture?: Gesture;
  /** Seconds into the gesture (enter + hold + exit). Defaults to the middle of the hold. */
  gestureTime?: number;
  /** 0..1 position in the walk cycle; implies walking. */
  walkPhase?: number;
  /** Disc rotation in degrees: 0 frontal, 90 edge-on, 180 shows the back. */
  yaw?: number;
  /** 0 open, 1 closed. */
  blink?: number;
  /** Gaze direction, -1..1 each axis. */
  gaze?: { x: number; y: number };
  /** 0..1 progress through a hop. */
  hop?: number;
}

export interface EyeEls {
  group: SVGGElement;
  band: SVGPathElement;
  pupil: SVGGElement;
  upperLid: SVGPathElement;
  lowerLid: SVGPathElement;
  lashes: SVGPathElement;
}

export interface ArmCopyEls {
  group: SVGGElement;
  outline: SVGPathElement;
  core: SVGPathElement;
  cuff: SVGPathElement;
  hand: SVGGElement;
  shapes: Partial<Record<HandShape, SVGGElement>>;
}

export interface RigEls {
  shadow: SVGEllipseElement;
  legs: [SVGPathElement, SVGPathElement];
  shoes: [SVGGElement, SVGGElement];
  body: SVGGElement;
  rim: SVGPathElement;
  backCap: SVGEllipseElement;
  face: SVGGElement;
  eyes: [EyeEls, EyeEls];
  mouth: {
    outline: SVGPathElement;
    fill: SVGPathElement;
    clip: SVGPathElement;
    teeth: SVGPathElement;
    tongue: SVGEllipseElement;
    dimples: SVGPathElement;
  };
  cheeks: SVGGElement;
  /** [screen-left, screen-right] x [behind the disc, in front of the face]. */
  arms: [[ArmCopyEls, ArmCopyEls], [ArmCopyEls, ArmCopyEls]];
}

/** Extent in view-box units (origin: face centre at rest; ground at y = 180). */
export interface RigBounds { x: number; y: number; width: number; height: number }
export type RigEvent = { type: 'impact'; gesture: Gesture; x: number; y: number };

const N = FACE_KEYS.length;
const YAW_REST = 0.32;
const YAW_WALK = 0.58;
/** One walk cycle covers two strides of ground. */
const STRIDE = 30;
const CYCLE_TRAVEL = STRIDE * 2;
const STEP_LIFT = 11;
const HOP_DURATION = 0.82;
const LEG_LENGTH = 63;

const facePacks = new Map<Emotion, Float64Array>();
function facePack(e: Emotion): Float64Array {
  let p = facePacks.get(e);
  if (!p) {
    p = packFace(EXPRESSIONS[e] ?? EXPRESSIONS.cheerful);
    facePacks.set(e, p);
  }
  return p;
}

interface ActiveGesture {
  name: Exclude<Gesture, 'none'>;
  def: GestureDef;
  start: number;
  from: GesturePose;
  release: GesturePose | null;
  firedImpacts: number;
}

/** Caches the last value written per element/attribute so unchanged frames cost nothing. */
class AttrWriter {
  private cache = new WeakMap<Element, Record<string, string>>();
  set(el: Element | null | undefined, name: string, value: string): void {
    if (!el) return;
    let c = this.cache.get(el);
    if (!c) {
      c = {};
      this.cache.set(el, c);
    }
    if (c[name] === value) return;
    c[name] = value;
    el.setAttribute(name, value);
  }
}

interface FrameClock {
  t: number;
  dt: number;
  blink: number;
  idleTime: number;
  walkPhase: number;
  reduced: boolean;
}

export class RigEngine {
  private readonly els: RigEls;
  private readonly w = new AttrWriter();
  private inputs: RigInputs;
  private snapshot: RigSnapshot | null = null;
  private snapshotDirty = true;
  private readonly listeners = new Set<(e: RigEvent) => void>();

  private time = 0;
  private readonly face = new Float64Array(N);
  private faceInit = false;
  private readonly rand = createRandom(0x4d4d);

  private blinkT = -1;
  private nextBlink = 1.8;
  private queuedDouble = false;
  private readonly saccade = { x: 0, y: 0, next: 1.2 };
  private pointer: Vec | null = null;
  private pointerAt = -100;
  private anchor: { x: number; y: number; scale: number } | null = null;
  private gaze = { x: 0, y: 0 };
  private vis = { open: 0, round: 0, wide: 0 };

  private yaw = YAW_REST;
  private lastSide: 1 | -1 = 1;
  private walkPhase = 0;
  private walkBlend = 0;
  private dragBlend = 0;
  private fallBlend = 0;
  private readonly shoeDir: [number, number] = [1, 1];
  private squash = { y: 1, v: 0 };
  private hopT = -1;

  private gesture: ActiveGesture | null = null;
  private readonly pose: GesturePose = copyPose(IDLE_POSE);
  private readonly idle: GesturePose = copyPose(IDLE_POSE);
  private readonly handShape: [HandShape, HandShape] = ['fist', 'fist'];
  private readonly armFront: [boolean, boolean] = [false, false];
  private readonly handPop: [number, number] = [0, 0];
  private pendingImpact: { gesture: Gesture; x: number; y: number } | null = null;
  private bounds: RigBounds = { x: -110, y: -105, width: 220, height: 290 };
  private settled = 0;

  constructor(els: RigEls, inputs: RigInputs) {
    this.els = els;
    this.inputs = inputs;
    this.lastSide = inputs.facing === -1 ? -1 : 1;
    this.yaw = this.lastSide * YAW_REST;
    this.shoeDir[0] = this.lastSide;
    this.shoeDir[1] = this.lastSide;
    for (const side of [0, 1] as const) {
      this.applyHandShape(side, 'fist');
      this.applyArmLayer(side, false);
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  setInputs(next: Partial<RigInputs>): void {
    this.inputs = { ...this.inputs, ...next };
    if (next.facing === 1 || next.facing === -1) this.lastSide = next.facing;
    this.settled = 0;
    this.snapshotDirty = true;
  }

  setSnapshot(s: RigSnapshot | null): void {
    this.snapshot = s;
    this.snapshotDirty = true;
    if (!s) {
      this.faceInit = false;
      this.gesture = null;
      this.hopT = -1;
    }
  }

  /** Starts a gesture now (re-triggers if the same one is already running). */
  perform(g: Gesture): void {
    if (this.snapshot) return;
    if (g === 'none') {
      this.releaseGesture();
      return;
    }
    const def = GESTURE_DEFS[g];
    if (!def) return;
    this.gesture = { name: g, def, start: this.time, from: copyPose(this.pose), release: null, firedImpacts: 0 };
    this.settled = 0;
  }

  hop(): void {
    if (this.inputs.reducedMotion || this.snapshot) return;
    this.hopT = 0;
    this.settled = 0;
  }

  /** Cartoon squash on impact (landing after a drop). `amount` 0..1. */
  squashImpact(amount: number): void {
    if (this.inputs.reducedMotion || this.snapshot) return;
    this.squash.y = 1 - 0.24 * clamp(amount, 0, 1);
    this.squash.v = 0;
    this.settled = 0;
  }

  /** Pointer in client pixels (null when unknown). */
  setPointer(p: Vec | null): void {
    this.pointer = p;
    this.pointerAt = this.time;
  }

  /** Face centre on screen (client px) and px per rig unit; used to aim the gaze. */
  setAnchor(a: { x: number; y: number; scale: number } | null): void {
    this.anchor = a;
  }

  onEvent(fn: (e: RigEvent) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  getBounds(): RigBounds {
    return this.bounds;
  }

  get activeGesture(): Gesture {
    return this.gesture?.name ?? 'none';
  }

  // ── Frame ─────────────────────────────────────────────────────────────────

  tick(dt: number): TickResult {
    if (this.snapshot) {
      if (this.snapshotDirty) {
        this.snapshotDirty = false;
        this.renderSnapshot(this.snapshot);
      }
      return 'still';
    }
    const reduced = this.inputs.reducedMotion;
    this.time += dt;
    const t = this.time;
    const inp = this.inputs;

    // Face: damp toward the mood; the mouth reacts faster than the eyes.
    const target = facePack(inp.emotion);
    if (!this.faceInit) {
      this.face.set(target);
      this.faceInit = true;
    }
    let faceMoving = false;
    for (let i = 0; i < N; i += 1) {
      const rate = i >= FK.mouthX && i <= FK.dimple ? 13 : 9;
      const next = damp(this.face[i], target[i], reduced ? rate * 2 : rate, dt);
      if (Math.abs(next - target[i]) > 0.004) faceMoving = true;
      this.face[i] = next;
    }

    // Blinks: random 2-6 s apart, sometimes doubled.
    let blink = 0;
    if (this.blinkT < 0 && t >= this.nextBlink) this.blinkT = 0;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      blink = blinkCurve(this.blinkT);
      if (this.blinkT > 0.17) {
        this.blinkT = -1;
        if (this.queuedDouble) {
          this.queuedDouble = false;
          this.nextBlink = t + 2 + this.rand() * 4.2;
        } else if (this.rand() < 0.16) {
          this.queuedDouble = true;
          this.nextBlink = t + 0.12;
        } else {
          this.nextBlink = t + 2 + this.rand() * 4.2;
        }
      }
    }

    // Gaze: the pointer while it is active, otherwise the owner (straight out), plus saccades.
    let gx = 0;
    let gy = 0;
    if (this.pointer && this.anchor && t - this.pointerAt < 6) {
      const dx = this.pointer.x - this.anchor.x;
      const dy = this.pointer.y - this.anchor.y;
      const dist = Math.hypot(dx, dy);
      const reach = clamp(dist / (160 + 110 * this.anchor.scale), 0, 1);
      if (dist > 1) {
        gx = (dx / dist) * reach;
        gy = (dy / dist) * reach;
      }
    }
    if (!reduced && t >= this.saccade.next) {
      const away = this.rand() < 0.18;
      this.saccade.x = (this.rand() - 0.5) * (away ? 0.9 : 0.3);
      this.saccade.y = (this.rand() - 0.5) * (away ? 0.5 : 0.2);
      this.saccade.next = t + 0.5 + this.rand() * 2.2;
    }
    // Saccades are quick jumps rather than drifts.
    this.gaze.x = damp(this.gaze.x, clamp(gx + this.saccade.x, -1, 1), 26, dt);
    this.gaze.y = damp(this.gaze.y, clamp(gy + this.saccade.y, -1, 1), 26, dt);

    // Lip sync.
    const v = inp.isSpeaking ? VISEMES[inp.mouthFrame] ?? VISEMES[0] : VISEMES[0];
    this.vis.open = damp(this.vis.open, v.open, 30, dt);
    this.vis.round = damp(this.vis.round, v.round, 22, dt);
    this.vis.wide = damp(this.vis.wide, v.wide, 22, dt);

    // Locomotion blends.
    const dragging = inp.locomotion === 'drag' || inp.locomotion === 'fall';
    this.walkBlend = damp(this.walkBlend, inp.locomotion === 'walk' ? 1 : 0, 9, dt);
    this.dragBlend = damp(this.dragBlend, dragging ? 1 : 0, 12, dt);
    this.fallBlend = damp(this.fallBlend, inp.locomotion === 'fall' ? 1 : 0, 10, dt);
    if (inp.locomotion === 'walk') this.walkPhase = (this.walkPhase + (Math.max(0, inp.speed) * dt) / CYCLE_TRAVEL) % 1;

    // Yaw: coin-like turns toward the facing side.
    const side = inp.facing === 0 ? this.lastSide : inp.facing;
    const yawTarget = side * lerp(YAW_REST, YAW_WALK, this.walkBlend);
    this.yaw = damp(this.yaw, yawTarget, reduced ? 30 : 10, dt);

    // Volume-preserving squash spring, excited by impacts.
    const acc = -210 * (this.squash.y - 1) - 13 * this.squash.v;
    this.squash.v += acc * dt;
    this.squash.y += this.squash.v * dt;
    if (this.hopT >= 0) {
      this.hopT += dt;
      if (this.hopT > HOP_DURATION) this.hopT = -1;
    }

    const busy = this.computeAndWrite({ t, dt, blink, idleTime: reduced ? 0 : t, walkPhase: this.walkPhase, reduced });

    const moving = busy || faceMoving || this.blinkT >= 0 || this.walkBlend > 0.01 || this.dragBlend > 0.01 ||
      Math.abs(this.squash.y - 1) > 0.002 || Math.abs(this.squash.v) > 0.01 || inp.isSpeaking ||
      this.vis.open > 0.01 || Math.abs(this.yaw - yawTarget) > 0.01;
    this.settled = moving ? 0 : this.settled + dt;
    if (moving) return 'busy';
    return reduced && this.settled > 1 ? 'still' : 'idle';
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private renderSnapshot(s: RigSnapshot): void {
    this.face.set(facePack(this.inputs.emotion));
    const walking = s.walkPhase !== undefined;
    this.walkBlend = walking ? 1 : 0;
    const loco = this.inputs.locomotion;
    this.dragBlend = loco === 'drag' || loco === 'fall' ? 1 : 0;
    this.fallBlend = loco === 'fall' ? 1 : 0;
    const v = this.inputs.isSpeaking ? VISEMES[this.inputs.mouthFrame] : VISEMES[0];
    this.vis = { ...v };
    this.gaze = { x: s.gaze?.x ?? 0, y: s.gaze?.y ?? 0 };
    const side = this.inputs.facing === -1 ? -1 : 1;
    this.lastSide = side;
    this.yaw = s.yaw !== undefined ? s.yaw * DEG : side * (walking ? YAW_WALK : YAW_REST);
    this.shoeDir[0] = this.shoeDir[1] = 0;
    this.squash = { y: 1, v: 0 };
    this.hopT = s.hop !== undefined ? clamp(s.hop, 0, 1) * HOP_DURATION : -1;
    this.time = 0;
    this.handPop[0] = this.handPop[1] = 0;
    if (s.gesture && s.gesture !== 'none' && GESTURE_DEFS[s.gesture]) {
      const def = GESTURE_DEFS[s.gesture];
      const at = s.gestureTime ?? def.enter + def.hold * 0.5;
      this.gesture = { name: s.gesture, def, start: -at, from: copyPose(IDLE_POSE), release: null, firedImpacts: 99 };
    } else {
      this.gesture = null;
    }
    this.computeAndWrite({
      t: 0,
      dt: 1,
      blink: clamp(s.blink ?? 0, 0, 1),
      idleTime: s.time ?? 0,
      walkPhase: s.walkPhase ?? 0,
      reduced: this.inputs.reducedMotion,
    });
  }

  private releaseGesture(): void {
    const g = this.gesture;
    if (!g || g.release) return;
    // Jump to the start of the exit, blending out of the current pose.
    g.release = copyPose(this.pose);
    g.start = this.time - g.def.enter - g.def.hold;
  }

  private computeAndWrite(o: FrameClock): boolean {
    const w = this.w;
    const els = this.els;
    const reduced = o.reduced;
    const still = reduced ? 0 : 1;
    let busy = false;

    // ── Body motion ───────────────────────────────────────────────────────
    // Idle weight shift after giphy.gif: sway over planted feet, roll, a breathing turn and bob.
    const idleW = (1 - this.walkBlend) * (1 - this.dragBlend) * still;
    const th = (o.idleTime * TAU) / 2.9;
    let sway = 6.5 * Math.sin(th) * idleW;
    let roll = 3.2 * Math.sin(th + 0.7) * idleW;
    let bob = -1.5 * (0.5 - 0.5 * Math.cos(2 * th)) * idleW;
    const yawWobble = 0.085 * Math.sin(th + 1.3) * idleW;
    let stretch = 0.012 * Math.sin(2 * th) * idleW;

    const p = o.walkPhase;
    const wb = this.walkBlend * (reduced ? 0.4 : 1);
    const dir = this.yaw >= 0 ? 1 : -1;
    // Two bobs per cycle: low at each contact, high as the legs pass.
    bob += -3.4 * (0.5 - 0.5 * Math.cos(2 * TAU * p)) * wb;
    roll += (dir * 2.4 + 1.4 * Math.sin(TAU * p)) * wb;

    const db = this.dragBlend;
    stretch += 0.055 * db;
    roll += Math.sin(o.t * 5.2) * 4 * db * still;

    // Speech: small nods on open syllables.
    bob += this.vis.open * 1.1;
    roll += Math.sin(o.t * 2.6) * this.vis.open * 0.7 * still;

    let hopH = 0;
    let hopSy = 1;
    let tuck = 0;
    if (this.hopT >= 0) {
      const h = hopCurve(this.hopT);
      hopH = h.height;
      hopSy = h.sy;
      tuck = h.tuck;
      busy = true;
    }

    // ── Arms (idle + gesture) ─────────────────────────────────────────────
    this.computeIdleArms(roll, o, wb, db);
    if (this.computeGesture(this.snapshot ? 0 : this.time)) busy = true;
    roll += this.pose.body.roll;
    bob += this.pose.body.bob;
    sway += this.pose.body.lean;

    // ── Turn ──────────────────────────────────────────────────────────────
    const yaw = this.yaw + yawWobble;
    const cyaw = Math.cos(yaw);
    const syaw = Math.sin(yaw);
    const front = cyaw >= 0;
    const capRx = Math.max(0.01, R * Math.abs(cyaw));
    const xf = (DISC_DEPTH / 2) * syaw;
    const xb = -xf;

    // Squash and stretch pivot on the disc bottom so the legs stay attached.
    const squashY = this.squash.y * hopSy * (1 + stretch);
    const squashX = 1 + (1 - squashY) * 0.85;
    const bodyTx = sway;
    const bodyTy = -GROUND_Y + bob - hopH;
    w.set(
      els.body,
      'transform',
      `translate(${f(bodyTx)} ${f(bodyTy)}) rotate(${f(roll)}) translate(0 ${R}) scale(${f(squashX)} ${f(squashY)}) translate(0 ${-R})`,
    );
    const bodyPoint = (pt: Vec): Vec =>
      transformPoint({ x: pt.x * squashX, y: (pt.y - R) * squashY + R }, bodyTx, bodyTy, roll, 1, 1);

    // Disc: front and back caps joined by the cylinder side (the rim crescent).
    const xl = Math.min(xf, xb);
    const xr = Math.max(xf, xb);
    w.set(
      els.rim,
      'd',
      `M ${f(xl)} ${-R} L ${f(xr)} ${-R} A ${f(capRx)} ${R} 0 0 1 ${f(xr)} ${R} L ${f(xl)} ${R} A ${f(capRx)} ${R} 0 0 1 ${f(xl)} ${-R} Z`,
    );
    w.set(els.face, 'transform', `translate(${f(xf)} 0) scale(${f(Math.max(0.001, cyaw))} 1)`);
    w.set(els.face, 'display', front ? 'inline' : 'none');
    w.set(els.backCap, 'cx', f(xb));
    w.set(els.backCap, 'rx', f(capRx));
    w.set(els.backCap, 'display', front ? 'none' : 'inline');

    if (front) this.writeFace(o.blink);

    // ── Arms ──────────────────────────────────────────────────────────────
    const shoulderScale = lerp(0.6, 1, Math.abs(cyaw));
    let minX = xl - capRx - 2;
    let maxX = xr + capRx + 2;
    let minY = -R - 2;
    let maxY = R + 2;
    for (const s of [0, 1] as const) {
      const ext = this.writeArm(s, s === 0 ? this.pose.left : this.pose.right, shoulderScale, o.dt);
      minX = Math.min(minX, ext.minX);
      maxX = Math.max(maxX, ext.maxX);
      minY = Math.min(minY, ext.minY);
      maxY = Math.max(maxY, ext.maxY);
    }

    if (this.pendingImpact) {
      const at = bodyPoint(this.pendingImpact);
      const e: RigEvent = { type: 'impact', gesture: this.pendingImpact.gesture, x: at.x, y: at.y + GROUND_Y };
      this.pendingImpact = null;
      for (const fn of this.listeners) fn(e);
    }

    // ── Legs and shoes, in the ground frame ───────────────────────────────
    const legs = this.writeLegs(bodyPoint, lerp(0.62, 1, Math.abs(cyaw)), p, wb, db, o, hopH, tuck);

    const corners = [
      bodyPoint({ x: minX, y: minY }), bodyPoint({ x: maxX, y: minY }),
      bodyPoint({ x: minX, y: maxY }), bodyPoint({ x: maxX, y: maxY }),
    ];
    const bx0 = Math.floor(Math.min(legs.minX, ...corners.map(q => q.x)));
    const bx1 = Math.ceil(Math.max(legs.maxX, ...corners.map(q => q.x)));
    const by0 = Math.floor(Math.min(...corners.map(q => q.y)) + GROUND_Y);
    const by1 = Math.ceil(Math.max(legs.maxY, ...corners.map(q => q.y)) + GROUND_Y);
    this.bounds = { x: bx0, y: by0, width: bx1 - bx0, height: by1 - by0 };

    // The ground shadow shrinks while she is in the air or dangling.
    const shadowScale = clamp(1 - hopH / 120, 0.5, 1) * (1 - 0.35 * db);
    w.set(els.shadow, 'transform', `translate(${f(sway * 0.6)} 0) scale(${f(shadowScale)} 1)`);
    w.set(els.shadow, 'opacity', f(clamp(1 - db * 0.8 - hopH / 160, 0, 1)));

    return busy;
  }

  private computeIdleArms(roll: number, o: FrameClock, wb: number, db: number): void {
    const idle = copyPose(IDLE_POSE, this.idle);
    // Hanging arms lag the body roll as if pulled by gravity.
    const g = -roll * 0.85;
    idle.right.x += g * 0.9;
    idle.left.x += g * 0.9;
    idle.right.hand += g * 0.8;
    idle.left.hand += g * 0.8;
    const breathe = Math.sin((o.idleTime * TAU) / 2.9 + 2.1);
    idle.right.y += breathe * 0.8;
    idle.left.y += breathe * 0.8;

    // Walk: arms swing opposite to the legs.
    if (wb > 0.001) {
      const swing = Math.sin(TAU * o.walkPhase) * wb;
      const dir = this.yaw >= 0 ? 1 : -1;
      idle.right.x += swing * 15 * dir;
      idle.right.y -= Math.abs(swing) * 4;
      idle.right.hand -= swing * 26 * dir;
      idle.left.x -= swing * 15 * dir;
      idle.left.y -= Math.abs(swing) * 4;
      idle.left.hand += swing * 26 * dir;
    }

    // Dragged or falling: arms up with a flail.
    if (db > 0.001) {
      const fl = Math.sin(o.t * 9) * (6 + 6 * this.fallBlend) * (o.reduced ? 0 : 1);
      idle.right.x = lerp(idle.right.x, 112 + fl * 0.4, db);
      idle.right.y = lerp(idle.right.y, -58 - fl, db);
      idle.right.hand = lerpAngle(idle.right.hand, -72 + fl * 2, db);
      idle.right.shoulder = lerpAngle(idle.right.shoulder, -6, db);
      idle.left.x = lerp(idle.left.x, -112 - fl * 0.4, db);
      idle.left.y = lerp(idle.left.y, -58 + fl, db);
      idle.left.hand = lerpAngle(idle.left.hand, 252 - fl * 2, db);
      idle.left.shoulder = lerpAngle(idle.left.shoulder, 186, db);
      if (db > 0.5) {
        idle.right.shape = 'open';
        idle.left.shape = 'open';
      }
    }
  }

  /** Sets this.pose from the active gesture, or idle. Returns true while a gesture runs. */
  private computeGesture(clock: number): boolean {
    const idle = this.idle;
    const g = this.gesture;
    const out = this.pose;
    if (!g) {
      copyPose(idle, out);
      this.syncHands();
      return false;
    }
    const def = g.def;
    const e = clock - g.start;
    const target = copyPose(def.pose);
    if (e < def.enter && !g.release) {
      const u = clamp(e / def.enter, 0, 1);
      blendPose(g.from, target, def.snap ? easeOutBack(u) : easeInOut(u), out);
      pickDiscrete(g.from, target, u >= 0.5, out);
    } else if (e < def.enter + def.hold && !g.release) {
      const ht = e - def.enter;
      if (def.osc) {
        def.osc(ht, target);
        // Fade the oscillator in so the hold starts without a jolt.
        blendPose(def.pose, target, smoothstep(ht / 0.15), out);
      } else {
        copyPose(target, out);
      }
      pickDiscrete(target, target, true, out);
      if (def.impacts && !this.snapshot) {
        while (g.firedImpacts < def.impacts.length && ht >= def.impacts[g.firedImpacts]) {
          g.firedImpacts += 1;
          const hx = g.name === 'clap' ? (out.left.x + out.right.x) / 2 : out.right.x;
          const hy = g.name === 'clap' ? (out.left.y + out.right.y) / 2 - 18 : out.right.y - 22 * out.right.scale;
          this.pendingImpact = { gesture: g.name, x: hx, y: hy };
        }
      }
    } else {
      if (!g.release) {
        const rel = copyPose(def.pose);
        if (def.osc) def.osc(def.hold, rel);
        g.release = rel;
      }
      const u = clamp((e - def.enter - def.hold) / def.exit, 0, 1);
      blendPose(g.release, idle, easeInOut(u), out);
      pickDiscrete(g.release, idle, u >= 0.5, out);
      if (u >= 1 && !this.snapshot) this.gesture = null;
    }
    this.syncHands();
    return true;
  }

  private syncHands(): void {
    const arms = [this.pose.left, this.pose.right];
    for (const s of [0, 1] as const) {
      const a = arms[s];
      if (a.shape !== this.handShape[s]) {
        this.handShape[s] = a.shape;
        this.applyHandShape(s, a.shape);
        // A quick shrink-pop sells the replacement drawing.
        if (!this.snapshot) this.handPop[s] = 1;
      }
      if (a.front !== this.armFront[s]) {
        this.armFront[s] = a.front;
        this.applyArmLayer(s, a.front);
      }
    }
  }

  private applyHandShape(side: 0 | 1, shape: HandShape): void {
    for (const copy of this.els.arms[side]) {
      for (const name of HAND_SHAPES) this.w.set(copy.shapes[name], 'display', name === shape ? 'inline' : 'none');
    }
  }

  private applyArmLayer(side: 0 | 1, front: boolean): void {
    const [back, fore] = this.els.arms[side];
    this.w.set(back.group, 'display', front ? 'none' : 'inline');
    this.w.set(fore.group, 'display', front ? 'inline' : 'none');
  }

  private writeArm(s: 0 | 1, a: ArmPose, shoulderScale: number, dt: number) {
    const w = this.w;
    const sideSign = s === 0 ? -1 : 1;
    const copy = this.els.arms[s][this.armFront[s] ? 1 : 0];
    const S = { x: sideSign * ARM.shoulderX * shoulderScale, y: ARM.shoulderY };
    const W = { x: a.x, y: a.y };
    const c = a.reach * Math.hypot(W.x - S.x, W.y - S.y);
    const P1 = { x: S.x + Math.cos(a.shoulder * DEG) * c, y: S.y + Math.sin(a.shoulder * DEG) * c };
    const P2 = { x: W.x - Math.cos(a.hand * DEG) * c * 0.9, y: W.y - Math.sin(a.hand * DEG) * c * 0.9 };
    const d = `M ${f(S.x)} ${f(S.y)} C ${f(P1.x)} ${f(P1.y)} ${f(P2.x)} ${f(P2.y)} ${f(W.x)} ${f(W.y)}`;
    w.set(copy.outline, 'd', d);
    w.set(copy.core, 'd', d);
    w.set(copy.cuff, 'd', d);
    // Two dark cuff stripes measured back from the wrist, constant width however the hose bends.
    const L = cubicLength(S, P1, P2, W);
    const lead = Math.max(0, L - (CUFF.tail + 1.5 + CUFF.stripe * 2 + CUFF.gap));
    w.set(copy.cuff, 'stroke-dasharray', `0 ${f(lead)} ${CUFF.stripe} ${CUFF.gap} ${CUFF.stripe} 400`);
    this.handPop[s] = this.snapshot ? 0 : damp(this.handPop[s], 0, 16, dt);
    const sc = a.scale * (1 - 0.16 * this.handPop[s]);
    w.set(copy.hand, 'transform', `translate(${f(W.x)} ${f(W.y)}) rotate(${f(a.hand - 90)}) scale(${f(sideSign * sc)} ${f(sc)})`);
    const reach = HAND_REACH[a.shape] * sc;
    return {
      minX: Math.min(S.x, W.x - reach, P1.x),
      maxX: Math.max(S.x, W.x + reach, P1.x),
      minY: Math.min(S.y, W.y - reach, P1.y),
      maxY: Math.max(S.y, W.y + reach, P1.y),
    };
  }

  private writeLegs(
    bodyPoint: (p: Vec) => Vec, hipSpread: number, p: number, wb: number, db: number,
    o: FrameClock, lift: number, tuck: number,
  ) {
    const w = this.w;
    const els = this.els;
    const absCos = Math.abs(Math.cos(this.yaw));
    const dir = this.yaw >= 0 ? 1 : -1;
    let minX = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const i of [0, 1] as const) {
      const sideSign = i === 0 ? -1 : 1;
      const hip = bodyPoint({ x: sideSign * LEG.hipX * hipSpread, y: LEG.hipY });
      // Planted idle stance (ground frame: y = 0 is the floor, the root sits at GROUND_Y).
      let ax = sideSign * LEG.footX * lerp(0.7, 1, absCos) + dir * 2.5;
      let ay = -LEG.ankle;
      let shoeAngle = 0;
      if (wb > 0.001) {
        const q = (p + i * 0.5) % 1;
        let fx: number;
        let fy = 0;
        let ang: number;
        if (q < 0.5) {
          // Stance: the foot slides back at body speed, so it stays planted on the ground.
          const s = q / 0.5;
          fx = STRIDE / 2 - STRIDE * s;
          ang = 15 * smoothstep((s - 0.62) / 0.38);
        } else {
          // Swing: lift, toe up for the heel strike.
          const s = (q - 0.5) / 0.5;
          fx = -STRIDE / 2 + STRIDE * easeInOut(s);
          fy = -STEP_LIFT * Math.sin(Math.PI * s) * (o.reduced ? 0.5 : 1);
          ang = lerp(15, -9, smoothstep(s * 1.4)) * (1 - smoothstep((s - 0.75) / 0.25));
        }
        ax = lerp(ax, dir * fx + sideSign * 7, wb);
        ay = lerp(ay, -LEG.ankle + fy, wb);
        shoeAngle = ang * dir * wb;
      }
      ay -= Math.max(0, lift - tuck * 6);
      if (db > 0.001) {
        // Dangling: pendulum kicks under the hips.
        const kick = Math.sin(o.t * 8 + i * Math.PI) * (o.reduced ? 0 : 12) * (0.6 + 0.6 * this.fallBlend);
        ax = lerp(ax, hip.x + kick * 0.6, db);
        ay = lerp(ay, hip.y + 58 - Math.abs(kick) * 0.3, db);
        shoeAngle = lerp(shoeAngle, kick * 1.2, db);
      }
      // bodyPoint already returns ground-frame coordinates (floor at y = 0).
      const hx = hip.x;
      const hy = hip.y;
      const dx = ax - hx;
      const dy = ay - hy;
      const d = Math.hypot(dx, dy) || 1;
      // Rubber-hose leg: bows so its length stays near LEG_LENGTH, knee toward the facing side.
      const sag = Math.sqrt(Math.max(0, (3 * d * (LEG_LENGTH - d)) / 8)) + 2.4;
      let nx = -dy / d;
      let ny = dx / d;
      if (nx * dir < 0) {
        nx = -nx;
        ny = -ny;
      }
      const ctrlX = (hx + ax) / 2 + nx * sag * 2;
      const ctrlY = (hy + ay) / 2 + ny * sag * 2;
      w.set(els.legs[i], 'd', `M ${f(hx)} ${f(hy)} Q ${f(ctrlX)} ${f(ctrlY)} ${f(ax)} ${f(ay)}`);
      // Shoes point the way she faces; head-on she stands toes-out like the cutout.
      const want = Math.abs(this.yaw) > 0.14 ? dir : sideSign;
      this.shoeDir[i] = this.snapshot ? want : damp(this.shoeDir[i], want, 16, o.dt);
      const sd = this.shoeDir[i];
      const sdx = Math.abs(sd) < 0.2 ? 0.2 * (sd < 0 ? -1 : 1) : sd;
      w.set(els.shoes[i], 'transform', `translate(${f(ax)} ${f(ay)}) rotate(${f(shoeAngle)}) scale(${f(sdx)} 1)`);
      minX = Math.min(minX, ax - 15, hx);
      maxX = Math.max(maxX, ax + 23, hx);
      maxY = Math.max(maxY, ay + LEG.ankle);
    }
    return { minX, maxX, maxY };
  }

  private writeFace(blink: number): void {
    const F = this.face;
    const w = this.w;
    const els = this.els;
    const eyeScale = F[FK.eyeScale];
    const pupilScale = F[FK.pupilScale];
    const lashSpread = F[FK.lashSpread];
    const lashLength = F[FK.lashLength];
    const px = clamp(F[FK.pupilX] + this.gaze.x, -1.15, 1.15);
    const py = clamp(F[FK.pupilY] + this.gaze.y, -1.15, 1.15);

    for (const i of [0, 1] as const) {
      const e = els.eyes[i];
      // Lid tilt is about the inner corner: +x for the screen-left eye, -x for the right one.
      const side = i === 0 ? 1 : -1;
      const open = clamp(i === 0 ? F[FK.openL] : F[FK.openR], 0, 1) * (1 - blink);
      const tilt = i === 0 ? F[FK.tiltL] : F[FK.tiltR];
      const lower = clamp(i === 0 ? F[FK.lowerL] : F[FK.lowerR], 0, 1);
      const arch = i === 0 ? F[FK.archL] : F[FK.archR];
      w.set(e.group, 'transform', `translate(${i === 0 ? -EYE.x : EYE.x} ${EYE.y}) scale(${f(eyeScale)})`);

      // Upper lid: a parabola that drops from above the dome to the closed arc.
      const slope = Math.tan(tilt * DEG) * side;
      const uY = lerp(CLOSED_LID.y, -EYE.h / 2 - 2.5, Math.pow(open, 0.85));
      const uC = lerp(arch, 0, Math.sqrt(open));
      // Lower lid: rises for smiling eyes and meets the upper lid when shut.
      const closure = Math.pow(1 - open, 2);
      const lMood = lerp(EYE.h / 2 + 2.5, CLOSED_LID.y + 7, lower);
      const lY = lerp(lMood, CLOSED_LID.y, closure);
      const lC = lerp(lower * 9, arch, closure);
      const a2 = EYE.a * EYE.a;
      const yu = (x: number) => uY + slope * x - uC * (1 - (x * x) / a2);
      const yl = (x: number) => Math.max(lY + slope * 0.25 * x - lC * (1 - (x * x) / a2), yu(x));
      const X = EYE.a + 6;
      const up = quadThrough(yu, -X, X);
      const lo = quadThrough(yl, -X, X);
      w.set(
        e.band,
        'd',
        `M ${f(-X)} ${f(up.y0)} Q 0 ${f(up.yc)} ${f(X)} ${f(up.y1)} L ${f(X)} ${f(lo.y1)} Q 0 ${f(lo.yc)} ${f(-X)} ${f(lo.y0)} Z`,
      );

      // Lid lines, drawn only between their crossings with the eye outline.
      const upperSpan = lidSpan(yu);
      if (upperSpan) {
        const q = quadThrough(yu, upperSpan[0], upperSpan[1]);
        w.set(e.upperLid, 'd', `M ${f(upperSpan[0])} ${f(q.y0)} Q ${f(q.xm)} ${f(q.yc)} ${f(upperSpan[1])} ${f(q.y1)}`);
        w.set(e.upperLid, 'stroke-width', f(lerp(4.6, EYE.line, Math.min(1, open * 1.6))));
        w.set(e.upperLid, 'display', 'inline');
      } else {
        w.set(e.upperLid, 'display', 'none');
      }
      const lowerSpan = closure > 0.9 ? null : lidSpan(yl);
      if (lowerSpan) {
        const q = quadThrough(yl, lowerSpan[0], lowerSpan[1]);
        w.set(e.lowerLid, 'd', `M ${f(lowerSpan[0])} ${f(q.y0)} Q ${f(q.xm)} ${f(q.yc)} ${f(lowerSpan[1])} ${f(q.y1)}`);
        w.set(e.lowerLid, 'display', 'inline');
      } else {
        w.set(e.lowerLid, 'display', 'none');
      }

      // Pupil: gaze + mood bias, clipped by the eye shape once it reaches the rim.
      const ppx = PUPIL.restX + px * PUPIL.travelX;
      const ppy = PUPIL.restY + (py < 0 ? py * PUPIL.travelUp : py * PUPIL.travelDown);
      w.set(e.pupil, 'transform', `translate(${f(ppx)} ${f(ppy)}) scale(${f(pupilScale)})`);

      // Lashes ride the visible top edge: the dome when open, the lid line when lowered.
      let lashD = '';
      for (const lash of LASHES) {
        let bx = lash.x * EYE.a * 0.98;
        let onLid = yu(bx) > eyeTopAt(bx);
        if (onLid) {
          const hw = eyeHalfWidthAt(yu(0));
          bx = lash.x * Math.max(hw, EYE.a * 0.5) * 1.02;
          onLid = yu(bx) > eyeTopAt(bx);
        }
        const by = Math.max(eyeTopAt(bx), yu(bx));
        const lidAngle = Math.atan(slope + (2 * uC * bx) / a2) / DEG;
        const ang = (lash.angle * lashSpread + (onLid ? lidAngle * 0.8 : 0)) * DEG;
        const len = lash.length * lashLength * (onLid ? lerp(0.85, 1, open) : 1);
        const sx = Math.sin(ang);
        const sy = -Math.cos(ang);
        const b0x = bx - sx * 1.4;
        const b0y = by - sy * 1.4;
        const tx = bx + sx * len;
        const ty = by + sy * len;
        const curl = lash.x < 0 ? -1 : 1;
        const cx = (b0x + tx) / 2 - sy * 1.1 * curl;
        const cy = (b0y + ty) / 2 + sx * 1.1 * curl;
        lashD += `M ${f(b0x)} ${f(b0y)} Q ${f(cx)} ${f(cy)} ${f(tx)} ${f(ty)} `;
      }
      w.set(e.lashes, 'd', lashD.trimEnd());
    }

    // Mouth: the mood's shape, opened and rounded by the lip-sync viseme.
    const vo = this.vis.open;
    const vr = this.vis.round;
    const moodOpen = F[FK.mouthOpen];
    const talkOpen = Math.max(moodOpen, 3) + (13.5 - Math.max(moodOpen, 3)) * vo;
    const open = vo > 0.01 ? lerp(moodOpen, talkOpen, Math.min(1, vo * 1.6)) : moodOpen;
    const round = lerp(F[FK.mouthRound], vr, Math.min(1, vo * 1.4));
    const m = buildMouth({
      x: F[FK.mouthX],
      y: F[FK.mouthY],
      w: F[FK.mouthW] * (1 + this.vis.wide) * (1 - 0.18 * round * vo),
      curve: F[FK.mouthCurve] * (1 - 0.35 * vo),
      open,
      round,
      skew: F[FK.mouthSkew] * (1 - 0.4 * vo),
      teeth: Math.max(F[FK.teeth], 0.45 * Math.min(1, vo * 2)),
      tongue: Math.max(F[FK.tongue], 0.55 * vo),
      dimple: F[FK.dimple] * (1 - vo),
    });
    const mo = els.mouth;
    w.set(mo.outline, 'd', m.outline);
    w.set(mo.fill, 'd', m.outline);
    w.set(mo.clip, 'd', m.outline);
    w.set(mo.fill, 'display', m.isOpen ? 'inline' : 'none');
    w.set(mo.teeth, 'd', m.teeth);
    w.set(mo.teeth, 'display', m.isOpen ? 'inline' : 'none');
    w.set(mo.tongue, 'cx', f(m.tongue.cx));
    w.set(mo.tongue, 'cy', f(m.tongue.cy));
    w.set(mo.tongue, 'rx', f(m.tongue.rx));
    w.set(mo.tongue, 'ry', f(m.tongue.ry));
    w.set(mo.tongue, 'display', m.isOpen && m.tongue.ry > 0.6 ? 'inline' : 'none');
    w.set(mo.dimples, 'd', m.dimples || 'M 0 0');
    w.set(mo.dimples, 'display', m.dimples ? 'inline' : 'none');
    w.set(els.cheeks, 'opacity', f(clamp(F[FK.cheeks], 0, 1)));
  }
}

function hopCurve(t: number): { height: number; sy: number; tuck: number } {
  if (t < 0.12) return { height: 0, sy: 1 - 0.15 * smoothstep(t / 0.12), tuck: 0 };
  if (t < 0.56) {
    const k = (t - 0.12) / 0.44;
    const sy = k < 0.25 ? lerp(0.85, 1.12, k / 0.25) : lerp(1.12, 1, Math.min(1, (k - 0.25) / 0.5));
    return { height: 42 * Math.sin(Math.PI * k), sy, tuck: Math.sin(Math.PI * k) };
  }
  if (t < 0.68) return { height: 0, sy: lerp(1, 0.84, Math.sin(Math.PI * ((t - 0.56) / 0.12) * 0.5)), tuck: 0 };
  return { height: 0, sy: lerp(0.84, 1, easeOutBack(clamp((t - 0.68) / (HOP_DURATION - 0.68), 0, 1))), tuck: 0 };
}

/** Blink: 70 ms down, 20 ms shut, 80 ms up. */
function blinkCurve(t: number): number {
  if (t < 0.07) return smoothstep(t / 0.07);
  if (t < 0.09) return 1;
  return 1 - smoothstep((t - 0.09) / 0.08);
}

/** Quadratic Bezier control for the parabola `fn` between x0 and x1 (exact for parabolas). */
function quadThrough(fn: (x: number) => number, x0: number, x1: number) {
  const y0 = fn(x0);
  const y1 = fn(x1);
  const xm = (x0 + x1) / 2;
  return { y0, y1, xm, yc: 2 * fn(xm) - (y0 + y1) / 2 };
}

/** x-range where a lid curve lies inside the eye outline, or null when it misses the eye. */
function lidSpan(fn: (x: number) => number): [number, number] | null {
  const inside = (x: number) => {
    const y = fn(x);
    return Math.abs(x) <= EYE.a && y > eyeTopAt(x) && y < eyeBottomAt(x);
  };
  let seed: number | null = null;
  for (const x of [0, -6, 6, -11, 11, -15, 15, -18, 18, -19.8, 19.8]) {
    if (inside(x)) {
      seed = x;
      break;
    }
  }
  if (seed === null) return null;
  const edge = (from: number, to: number) => {
    let a = from;
    let b = to;
    for (let i = 0; i < 12; i += 1) {
      const m = (a + b) / 2;
      if (inside(m)) a = m;
      else b = m;
    }
    return a;
  };
  const left = edge(seed, -EYE.a - 0.01);
  const right = edge(seed, EYE.a + 0.01);
  return right - left < 0.8 ? null : [left, right];
}

function blendPose(a: GesturePose, b: GesturePose, k: number, out: GesturePose): void {
  blendArm(a.left, b.left, k, out.left);
  blendArm(a.right, b.right, k, out.right);
  out.body.roll = lerp(a.body.roll, b.body.roll, k);
  out.body.bob = lerp(a.body.bob, b.body.bob, k);
  out.body.lean = lerp(a.body.lean, b.body.lean, k);
}

function blendArm(a: ArmPose, b: ArmPose, k: number, out: ArmPose): void {
  out.x = lerp(a.x, b.x, k);
  out.y = lerp(a.y, b.y, k);
  out.hand = lerpAngle(a.hand, b.hand, k);
  out.shoulder = lerpAngle(a.shoulder, b.shoulder, k);
  out.reach = lerp(a.reach, b.reach, k);
  out.scale = lerp(a.scale, b.scale, k);
}

/** Hand drawings and layer swap at the midpoint of a transition, never mid-blend. */
function pickDiscrete(a: GesturePose, b: GesturePose, second: boolean, out: GesturePose): void {
  const src = second ? b : a;
  out.left.shape = src.left.shape;
  out.right.shape = src.right.shape;
  out.left.front = src.left.front;
  out.right.front = src.right.front;
}

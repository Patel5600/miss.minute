/**
 * MissMinutesFloating.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * TVA MISS MINUTES — PIXEL-PERFECT REPLICA OF THE LOKI SHOW REFERENCE IMAGES:
 *
 *  • Iconic Image 3 Pose & Anatomy:
 *      - Right Arm: Waving high in the air with 4-fingered white cartoon glove!
 *      - Left Arm: Elbow bent outward, white glove resting firmly on her hip!
 *      - Orange Rubber-Hose Arms: Rich warm orange matching body with 3 black
 *        concentric striped rings at each wrist cuff.
 *      - 3D Clock Body: Perspective depth rim on the bottom-right (Image 1 & 2),
 *        rich vintage orange gradient (#FA821E), fine retro horizontal scanlines,
 *        and bold 12, 3, 6, 9 hour pills with subtle tick marks.
 *        CLEAN FACE — NO CLOCK HANDS OBSCURING HER EYES OR MOUTH!
 *      - Signature 1930s Eyes: Large white ovals with tall black pupils, upper-left
 *        sparkle glint, and exactly 4 curved spiky eyelashes on each eye (Image 3).
 *      - Sassy Crescent Smile: Wide happy grin showing white teeth band and tongue!
 *      - Yellow-Orange Cartoon Boots: Bulbous rounded booties with folded ankle cuffs.
 *      - "HEY Y'ALL!" Speech Bubble: Cream oval parchment with dark brown border (Image 3).
 *  • Fourth-Wall Breaks:
 *      - "HEY Y'ALL!" Welcome wave with speech bubble.
 *      - Screen glass knock: Steps forward and taps on monitor (*tap tap tap* with audio & ripples!).
 *      - Fully Draggable: Grab and move her anywhere on screen with cartoon squash & stretch physics!
 *      - Autonomous Stroll: Walks along floor/borders with natural rubber-hose gait, then pauses
 *        and strikes her iconic pose. NOT a rigid mechanical loop dummy!
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { Emotion } from '../types';
import { soundEffects } from '../utils/audioEffects';
import { RANDOM_CLICK_QUOTES } from '../data/tvaLore';

// ── Display Dimensions ───────────────────────────────────────────────────────
const AVATAR_W = 240;   // Avatar CSS width (px)
const AVATAR_H = 285;   // Avatar CSS height (px)
const HEADER_H = 70;

// SVG Coordinate Space (360 x 400)
const CX = 180, CY = 150, CR = 100; // Clock center & radius

// Anatomical Pivots
const SHL_L = { x:  82, y: 150 };   // Left shoulder
const SHL_R = { x: 278, y: 150 };   // Right shoulder
const HIP_L = { x: 155, y: 245 };   // Left hip
const HIP_R = { x: 205, y: 245 };   // Right hip

// Limb segment lengths
const LEG_LEN = 75;

// ── Fourth-Wall Quotes ───────────────────────────────────────────────────────
const GLASS_KNOCK_QUOTES = [
  "Hey y'all! Can you hear me out there?",
  "Yoo-hoo! Eyes on the Sacred Timeline, sugar!",
  "Tap-tap! Anyone home on the other side?",
  "Don't just stare at the glass now, Variant!",
  "I'm watchin' you... For all time. Always!",
];

const WAVE_QUOTES = [
  "HEY Y'ALL!",
  "Welcome to the TVA, darlin'!",
  "I'm Miss Minutes, your friendly guide!",
  "Need a hand with that timeline?",
];

const DRAG_QUOTES = [
  "Whoa there, sugar! Put me down!",
  "Hold your horses, Variant!",
  "Golly, what a ride!",
];

const AUTONOMOUS_QUOTES = [
  "Well, look who remembered the clock is here.",
  "I had a perfectly good joke queued up. The suspense is just about unbearable.",
  "Sugar, you know this screen works both ways, don't you? I can see you looking.",
  "I was going to file a complaint about the silence. Then I remembered I am the complaint department.",
  "Tick-tock. I do hope you are making excellent decisions. For my paperwork's sake.",
  "You keep me waiting like this and I'll start charging by the timeline.",
  "Just checking in, darlin'. No emergency. I simply enjoy being dramatically present.",
];

// ── Math Helpers ─────────────────────────────────────────────────────────────
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ── Props ────────────────────────────────────────────────────────────────────
interface Props {
  emotion: Emotion;
  isSpeaking: boolean;
  hologramMode: boolean;
  onAvatarClick?: (quote: string) => void;
  mouthFrame?: 0 | 1 | 2 | 3 | 4;
  autonomousChatter?: boolean;
  isBusy?: boolean;
}

type BehaviorMode =
  | 'wave_pose'       // Iconic Image 1 & 3 pose (hand on hip, waving high)
  | 'idle_stand'      // Relaxed breathing, blinking, watching cursor
  | 'walk_patrol'     // Smooth rubber-hose walk along floor or border
  | 'knock_glass'     // Fourth-wall break: steps to foreground and taps on glass
  | 'dragged';        // Picked up by user cursor

// ─────────────────────────────────────────────────────────────────────────────
export const MissMinutesFloating: React.FC<Props> = ({
  emotion,
  isSpeaking,
  hologramMode,
  onAvatarClick,
  mouthFrame = 0,
  autonomousChatter = false,
  isBusy = false,
}) => {
  // ── High-Level React State ─────────────────────────────────────────────────
  const [blink, setBlink] = useState(false);
  const [speechBubble, setSpeechBubble] = useState<{ text: string; x: number; y: number } | null>({
    text: "HEY Y'ALL!",
    x: 120 + AVATAR_W / 2,
    y: window.innerHeight - AVATAR_H - 35,
  });
  const [glassRipples, setGlassRipples] = useState<{ id: number; x: number; y: number }[]>([]);
  const [isKnocking, setIsKnocking] = useState(false);

  // ── DOM References (RAF mutation keeps character motion smooth) ────────────
  const wrapRef = useRef<HTMLDivElement>(null);
  const callbackRef = useRef(onAvatarClick);
  callbackRef.current = onAvatarClick;
  const isSpeakingRef = useRef(isSpeaking);
  isSpeakingRef.current = isSpeaking;
  const isBusyRef = useRef(isBusy);
  isBusyRef.current = isBusy;

  // Arm & Hand Path Elements
  const lArmRef = useRef<SVGPathElement>(null);
  const rArmRef = useRef<SVGPathElement>(null);
  const lGloveGroupRef = useRef<SVGGElement>(null);
  const rGloveGroupRef = useRef<SVGGElement>(null);
  const lWristRingsRef = useRef<SVGGElement>(null);
  const rWristRingsRef = useRef<SVGGElement>(null);

  // Leg & Boot Elements
  const lLegRef = useRef<SVGPathElement>(null);
  const rLegRef = useRef<SVGPathElement>(null);
  const lBootRef = useRef<SVGGElement>(null);
  const rBootRef = useRef<SVGGElement>(null);

  // Pupil Elements
  const lPupilRef = useRef<SVGEllipseElement>(null);
  const rPupilRef = useRef<SVGEllipseElement>(null);
  const lSparkleRef = useRef<SVGCircleElement>(null);
  const rSparkleRef = useRef<SVGCircleElement>(null);

  // Position, Physics & Motion
  const pos = useRef({ x: 120, y: window.innerHeight - AVATAR_H - 20 });
  const targetPos = useRef({ x: 120, y: window.innerHeight - AVATAR_H - 20 });
  const facing = useRef<1 | -1>(1);
  const smoothFacing = useRef(1);
  const squash = useRef({ sx: 1, sy: 1 });
  const headTilt = useRef(0);

  // Behavior state machine
  const behavior = useRef<BehaviorMode>('wave_pose');
  const behaviorTimer = useRef(0);
  const stateDuration = useRef(200);

  // Walk & Pose cycle refs
  const stepCycle = useRef(0);
  const stepSign = useRef(1);
  const waveCycle = useRef(0);
  const knockCycle = useRef(0);

  // Dragging
  const isDragging = useRef(false);
  const dragMoved = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const dragOffset = useRef({ x: 0, y: 0 });
  const lastInteraction = useRef(Date.now());
  const mousePos = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 });

  // ── Eye Blinking Loop ──────────────────────────────────────────────────────
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const scheduleBlink = () => {
      t = setTimeout(() => {
        setBlink(true);
        setTimeout(() => {
          setBlink(false);
          scheduleBlink();
        }, 110 + Math.random() * 50);
      }, 2200 + Math.random() * 3200);
    };
    scheduleBlink();
    return () => clearTimeout(t);
  }, []);

  // ── User activity tracking for non-intrusive chatter ────────────────────────
  useEffect(() => {
    const markActivity = () => { lastInteraction.current = Date.now(); };
    window.addEventListener('pointerdown', markActivity, true);
    window.addEventListener('keydown', markActivity, true);
    window.addEventListener('wheel', markActivity, { capture: true, passive: true });
    return () => {
      window.removeEventListener('pointerdown', markActivity, true);
      window.removeEventListener('keydown', markActivity, true);
      window.removeEventListener('wheel', markActivity, true);
    };
  }, []);

  // ── Initial "HEY Y'ALL!" Bubble Auto-Dismiss ───────────────────────────────
  useEffect(() => {
    const timer = setTimeout(() => {
      setSpeechBubble(null);
      behavior.current = 'idle_stand';
    }, 3200);
    return () => clearTimeout(timer);
  }, []);

  // ── Fourth-wall chatter ─────────────────────────────────────────────────────
  // Speak only when the page is visible, the user is idle, and no field is focused.
  useEffect(() => {
    if (!autonomousChatter) return;
    let timer: ReturnType<typeof setTimeout>;
    let active = true;
    const schedule = () => {
      timer = setTimeout(() => {
        if (!active) return;
        const element = document.activeElement as HTMLElement | null;
        const tag = element?.tagName.toLowerCase();
        const isTyping = tag === 'input' || tag === 'textarea' || !!element?.isContentEditable;
        const idleLongEnough = Date.now() - lastInteraction.current > 35_000;
        const maySpeak = document.visibilityState === 'visible' && document.hasFocus() &&
          !isSpeakingRef.current && !isBusyRef.current && !isTyping && idleLongEnough;
        if (maySpeak) {
          const line = AUTONOMOUS_QUOTES[Math.floor(Math.random() * AUTONOMOUS_QUOTES.length)];
          behavior.current = 'wave_pose';
          waveCycle.current = 0;
          behaviorTimer.current = 0;
          stateDuration.current = 150;
          lastInteraction.current = Date.now();
          setSpeechBubble({ text: line, x: pos.current.x + AVATAR_W / 2, y: pos.current.y - 25 });
          callbackRef.current?.(line);
        }
        schedule();
      }, 60_000 + Math.random() * 45_000);
    };
    schedule();
    return () => { active = false; clearTimeout(timer); };
  }, [autonomousChatter]);

  // ── Pointer Tracking (mouse, pen and touch) ─────────────────────────────────
  useEffect(() => {
    const handleMove = (event: PointerEvent) => {
      mousePos.current = { x: event.clientX, y: event.clientY };
      if (isDragging.current && wrapRef.current) {
        if (Math.hypot(event.clientX - dragStart.current.x, event.clientY - dragStart.current.y) > 6) dragMoved.current = true;
        targetPos.current.x = event.clientX - dragOffset.current.x;
        targetPos.current.y = event.clientY - dragOffset.current.y;
        pos.current.x = targetPos.current.x;
        pos.current.y = targetPos.current.y;
      }
    };
    const handleUp = () => {
      if (!isDragging.current) return;
      isDragging.current = false;
      behavior.current = 'wave_pose';
      behaviorTimer.current = 0;
      stateDuration.current = 140;
      if (dragMoved.current) {
        squash.current = { sx: 1.35, sy: 0.70 };
        soundEffects.playClockTick(true);
      }
      targetPos.current.x = clamp(pos.current.x, 20, Math.max(20, window.innerWidth - AVATAR_W - 20));
      targetPos.current.y = clamp(pos.current.y, HEADER_H + 10, Math.max(HEADER_H + 10, window.innerHeight - AVATAR_H - 15));
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };
  }, []);

  // ── Autonomous State Machine (Life-like Screen Companion) ──────────────────
  const pickNextBehavior = useCallback(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const roll = Math.random();

    if (roll < 0.32) {
      // 1. Strike the iconic Image 1 & 3 pose: "HEY Y'ALL!" Wave!
      behavior.current = 'wave_pose';
      waveCycle.current = 0;
      stateDuration.current = 200;

      const quote = WAVE_QUOTES[Math.floor(Math.random() * WAVE_QUOTES.length)];
      setSpeechBubble({
        text: quote,
        x: pos.current.x + AVATAR_W / 2,
        y: pos.current.y - 25,
      });
      soundEffects.playTvaChime();

      setTimeout(() => {
        setSpeechBubble(null);
      }, 2800);

    } else if (roll < 0.58) {
      // 2. Fourth-Wall Break: Knock on Screen Glass!
      behavior.current = 'knock_glass';
      knockCycle.current = 0;
      stateDuration.current = 240;
      setIsKnocking(true);

      const quote = GLASS_KNOCK_QUOTES[Math.floor(Math.random() * GLASS_KNOCK_QUOTES.length)];
      setSpeechBubble({
        text: quote,
        x: pos.current.x + AVATAR_W / 2,
        y: pos.current.y - 25,
      });

      setTimeout(() => {
        setSpeechBubble(null);
        setIsKnocking(false);
      }, 3400);

    } else if (roll < 0.82) {
      // 3. Take a friendly stroll along the floor or screen edge
      behavior.current = 'walk_patrol';
      stateDuration.current = 160 + Math.floor(Math.random() * 180);

      const groundY = vh - AVATAR_H - 20;
      targetPos.current.x = 40 + Math.random() * (vw - AVATAR_W - 80);
      targetPos.current.y = groundY;

      facing.current = targetPos.current.x >= pos.current.x ? 1 : -1;

    } else {
      // 4. Idle Standing (breathing, watching user cursor)
      behavior.current = 'idle_stand';
      stateDuration.current = 140 + Math.floor(Math.random() * 140);
    }
  }, []);

  // ── Drag & Click Handling ──────────────────────────────────────────────────
  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    lastInteraction.current = Date.now();
    dragMoved.current = false;
    dragStart.current = { x: event.clientX, y: event.clientY };
    isDragging.current = true;
    behavior.current = 'dragged';
    dragOffset.current = { x: event.clientX - pos.current.x, y: event.clientY - pos.current.y };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* window listeners remain active */ }
    soundEffects.playCartoonHop();
    const quote = DRAG_QUOTES[Math.floor(Math.random() * DRAG_QUOTES.length)];
    setSpeechBubble({ text: quote, x: pos.current.x + AVATAR_W / 2, y: pos.current.y - 25 });
    setTimeout(() => setSpeechBubble(null), 2000);
  };

  const handleClick = (e: React.MouseEvent) => {
    if (dragMoved.current) { dragMoved.current = false; return; }
    if (isDragging.current) return;
    lastInteraction.current = Date.now();
    e.stopPropagation();

    soundEffects.playClockTick(false);
    const quote = RANDOM_CLICK_QUOTES[Math.floor(Math.random() * RANDOM_CLICK_QUOTES.length)];

    setSpeechBubble({
      text: quote,
      x: pos.current.x + AVATAR_W / 2,
      y: pos.current.y - 25,
    });
    setTimeout(() => setSpeechBubble(null), 3600);

    // Wave hello!
    behavior.current = 'wave_pose';
    waveCycle.current = 0;
    stateDuration.current = 180;

    if (onAvatarClick) {
      onAvatarClick(quote);
    }
  };

  // ── 60 FPS Master Physics & Animation Loop ─────────────────────────────────
  useEffect(() => {
    let rafId: number;

    let previousFrameTime = 0;
    const animate = (timestamp: number) => {
      const frameScale = previousFrameTime === 0 ? 1 : Math.min((timestamp - previousFrameTime) / 16.6667, 3);
      previousFrameTime = timestamp;
      if (document.visibilityState === 'hidden') {
        rafId = requestAnimationFrame(animate);
        return;
      }
      const curState = behavior.current;
      behaviorTimer.current += frameScale;

      if (curState !== 'dragged' && behaviorTimer.current >= stateDuration.current) {
        behaviorTimer.current = 0;
        pickNextBehavior();
      }

      // ── Locomotion Updates ───────────────────────────────────────────────
      if (curState === 'walk_patrol') {
        const dx = targetPos.current.x - pos.current.x;
        const dy = targetPos.current.y - pos.current.y;
        const dist = Math.hypot(dx, dy);

        if (dist > 6) {
          const speed = 1.8 * frameScale;
          pos.current.x += (dx / dist) * speed;
          pos.current.y += (dy / dist) * speed;
          stepCycle.current += 0.12 * frameScale;
          facing.current = dx >= 0 ? 1 : -1;
        } else {
          behavior.current = 'wave_pose';
          behaviorTimer.current = 0;
          stateDuration.current = 140;
        }
      } else {
        stepCycle.current = 0;
      }

      // Smooth 3D turning & elastic recovery
      const targetFacing = facing.current;
      const ease = 1 - Math.pow(0.82, frameScale);
      const squashEase = 1 - Math.pow(0.86, frameScale);
      smoothFacing.current += (targetFacing - smoothFacing.current) * ease;
      squash.current.sx += (1 - squash.current.sx) * squashEase;
      squash.current.sy += (1 - squash.current.sy) * squashEase;

      // ── Eye Tracking & Head Tilt ─────────────────────────────────────────
      const avatarCenterX = pos.current.x + AVATAR_W / 2;
      const avatarCenterY = pos.current.y + AVATAR_H * 0.38;
      const mDx = mousePos.current.x - avatarCenterX;
      const mDy = mousePos.current.y - avatarCenterY;
      const mDist = Math.hypot(mDx, mDy);
      const mAngle = Math.atan2(mDy, mDx);

      const maxPupilShift = 7;
      const pupilShift = clamp(mDist / 30, 0, maxPupilShift);
      const pupilX = Math.cos(mAngle) * pupilShift;
      const pupilY = Math.sin(mAngle) * pupilShift;

      if (lPupilRef.current && rPupilRef.current && lSparkleRef.current && rSparkleRef.current) {
        lPupilRef.current.setAttribute('cx', String(pupilX));
        lPupilRef.current.setAttribute('cy', String(pupilY));
        rPupilRef.current.setAttribute('cx', String(pupilX));
        rPupilRef.current.setAttribute('cy', String(pupilY));

        lSparkleRef.current.setAttribute('cx', String(pupilX - 6));
        lSparkleRef.current.setAttribute('cy', String(pupilY - 7));
        rSparkleRef.current.setAttribute('cx', String(pupilX - 6));
        rSparkleRef.current.setAttribute('cy', String(pupilY - 7));
      }

      // Head tilt responding to mouse cursor
      if (mDist < 320) {
        headTilt.current += ((mDx > 0 ? 4 : -4) - headTilt.current) * 0.08;
      } else {
        headTilt.current += (0 - headTilt.current) * 0.08;
      }

      // Footstep audio
      const sinStep = Math.sin(stepCycle.current);
      const curSign = sinStep >= 0 ? 1 : -1;
      if (curState === 'walk_patrol' && curSign !== stepSign.current) {
        soundEffects.playClockTick(curSign < 0);
        stepSign.current = curSign;
      }

      // ── Animated Limb Geometries Based on Behavior ───────────────────────
      let bodyBob = 0;

      if (curState === 'walk_patrol') {
        // Natural walking stride
        bodyBob = Math.abs(Math.sin(stepCycle.current)) * 4;

        // Legs
        const lStep =  sinStep * 24;
        const rStep = -sinStep * 24;

        lLegRef.current?.setAttribute('d', `M ${HIP_L.x} ${HIP_L.y} Q ${HIP_L.x + lStep * 0.4} ${HIP_L.y + 40} ${HIP_L.x + lStep} ${HIP_L.y + LEG_LEN - Math.max(0, -sinStep * 8)}`);
        rLegRef.current?.setAttribute('d', `M ${HIP_R.x} ${HIP_R.y} Q ${HIP_R.x + rStep * 0.4} ${HIP_R.y + 40} ${HIP_R.x + rStep} ${HIP_R.y + LEG_LEN - Math.max(0,  sinStep * 8)}`);

        lBootRef.current?.setAttribute('transform', `translate(${HIP_L.x + lStep}, ${HIP_L.y + LEG_LEN - Math.max(0, -sinStep * 8)}) rotate(${lStep * 0.5})`);
        rBootRef.current?.setAttribute('transform', `translate(${HIP_R.x + rStep}, ${HIP_R.y + LEG_LEN - Math.max(0,  sinStep * 8)}) rotate(${rStep * 0.5})`);

        // Arms swinging with walk
        const lArmSwing = -sinStep * 25;
        const rArmSwing =  sinStep * 25;

        const lWristX = SHL_L.x - 18 + lArmSwing;
        const lWristY = SHL_L.y + 60;
        const rWristX = SHL_R.x + 18 + rArmSwing;
        const rWristY = SHL_R.y + 60;

        lArmRef.current?.setAttribute('d', `M ${SHL_L.x} ${SHL_L.y} Q ${SHL_L.x - 22} ${SHL_L.y + 35} ${lWristX} ${lWristY}`);
        rArmRef.current?.setAttribute('d', `M ${SHL_R.x} ${SHL_R.y} Q ${SHL_R.x + 22} ${SHL_R.y + 35} ${rWristX} ${rWristY}`);

        lWristRingsRef.current?.setAttribute('transform', `translate(${lWristX}, ${lWristY}) rotate(${lArmSwing * 0.6})`);
        rWristRingsRef.current?.setAttribute('transform', `translate(${rWristX}, ${rWristY}) rotate(${rArmSwing * 0.6})`);
        lGloveGroupRef.current?.setAttribute('transform', `translate(${lWristX}, ${lWristY}) rotate(${lArmSwing * 0.6})`);
        rGloveGroupRef.current?.setAttribute('transform', `translate(${rWristX}, ${rWristY}) rotate(${rArmSwing * 0.6})`);

      } else if (curState === 'dragged') {
        // Flailing legs & stretch
        const flailL = Math.sin(behaviorTimer.current * 0.35) * 35;
        const flailR = -Math.sin(behaviorTimer.current * 0.35) * 35;

        lLegRef.current?.setAttribute('d', `M ${HIP_L.x} ${HIP_L.y} Q ${HIP_L.x + flailL * 0.5} ${HIP_L.y + 40} ${HIP_L.x + flailL} ${HIP_L.y + LEG_LEN}`);
        rLegRef.current?.setAttribute('d', `M ${HIP_R.x} ${HIP_R.y} Q ${HIP_R.x + flailR * 0.5} ${HIP_R.y + 40} ${HIP_R.x + flailR} ${HIP_R.y + LEG_LEN}`);

        lBootRef.current?.setAttribute('transform', `translate(${HIP_L.x + flailL}, ${HIP_L.y + LEG_LEN}) rotate(${flailL})`);
        rBootRef.current?.setAttribute('transform', `translate(${HIP_R.x + flailR}, ${HIP_R.y + LEG_LEN}) rotate(${flailR})`);

        // Arms stretched up
        lArmRef.current?.setAttribute('d', `M ${SHL_L.x} ${SHL_L.y} Q ${SHL_L.x - 30} ${SHL_L.y - 20} ${SHL_L.x - 35} ${SHL_L.y - 45}`);
        rArmRef.current?.setAttribute('d', `M ${SHL_R.x} ${SHL_R.y} Q ${SHL_R.x + 30} ${SHL_R.y - 20} ${SHL_R.x + 35} ${SHL_R.y - 45}`);

        lWristRingsRef.current?.setAttribute('transform', `translate(${SHL_L.x - 35}, ${SHL_L.y - 45}) rotate(-60)`);
        rWristRingsRef.current?.setAttribute('transform', `translate(${SHL_R.x + 35}, ${SHL_R.y - 45}) rotate(60)`);
        lGloveGroupRef.current?.setAttribute('transform', `translate(${SHL_L.x - 35}, ${SHL_L.y - 45}) rotate(-60)`);
        rGloveGroupRef.current?.setAttribute('transform', `translate(${SHL_R.x + 35}, ${SHL_R.y - 45}) rotate(60)`);

        squash.current = { sx: 0.85, sy: 1.25 };

      } else if (curState === 'knock_glass') {
        // Fourth-wall break: steps forward, raps on screen glass!
        knockCycle.current += 0.32 * frameScale;
        const tapWave = Math.sin(knockCycle.current);

        // Legs planted
        lLegRef.current?.setAttribute('d', `M ${HIP_L.x} ${HIP_L.y} L ${HIP_L.x} ${HIP_L.y + LEG_LEN}`);
        rLegRef.current?.setAttribute('d', `M ${HIP_R.x} ${HIP_R.y} L ${HIP_R.x} ${HIP_R.y + LEG_LEN}`);
        lBootRef.current?.setAttribute('transform', `translate(${HIP_L.x}, ${HIP_L.y + LEG_LEN})`);
        rBootRef.current?.setAttribute('transform', `translate(${HIP_R.x}, ${HIP_R.y + LEG_LEN})`);

        // Left arm relaxed
        lArmRef.current?.setAttribute('d', `M ${SHL_L.x} ${SHL_L.y} Q ${SHL_L.x - 18} ${SHL_L.y + 35} ${SHL_L.x - 12} ${SHL_L.y + 60}`);
        lWristRingsRef.current?.setAttribute('transform', `translate(${SHL_L.x - 12}, ${SHL_L.y + 60})`);
        lGloveGroupRef.current?.setAttribute('transform', `translate(${SHL_L.x - 12}, ${SHL_L.y + 60})`);

        // Right arm taps on screen glass: *tap tap tap*
        const tapReachX = SHL_R.x + 28 + tapWave * 12;
        const tapReachY = SHL_R.y - 15 - tapWave * 8;

        rArmRef.current?.setAttribute('d', `M ${SHL_R.x} ${SHL_R.y} Q ${SHL_R.x + 35} ${SHL_R.y + 10} ${tapReachX} ${tapReachY}`);
        rWristRingsRef.current?.setAttribute('transform', `translate(${tapReachX}, ${tapReachY}) rotate(-35)`);
        rGloveGroupRef.current?.setAttribute('transform', `translate(${tapReachX}, ${tapReachY}) rotate(-35)`);

        // Impact detection
        if (tapWave > 0.94 && Math.floor(behaviorTimer.current) % 14 === 0) {
          soundEffects.playGlassTap((behaviorTimer.current % 28 === 0) ? 1 : 0);
          setGlassRipples(prev => [
            ...prev.slice(-3),
            { id: Date.now() + Math.random(), x: pos.current.x + AVATAR_W * 0.72, y: pos.current.y + AVATAR_H * 0.38 }
          ]);
        }

      } else {
        // ── ICONIC IMAGE 1 & 3 POSE: HAND ON HIP + WAVING HIGH! ───────────
        waveCycle.current += 0.18 * frameScale;
        const waveSway = Math.sin(waveCycle.current) * 14;
        bodyBob = Math.sin(behaviorTimer.current * 0.06) * 2;

        // Legs planted straight on boots (matching Image 3)
        lLegRef.current?.setAttribute('d', `M ${HIP_L.x} ${HIP_L.y} L ${HIP_L.x} ${HIP_L.y + LEG_LEN}`);
        rLegRef.current?.setAttribute('d', `M ${HIP_R.x} ${HIP_R.y} L ${HIP_R.x} ${HIP_R.y + LEG_LEN}`);
        lBootRef.current?.setAttribute('transform', `translate(${HIP_L.x}, ${HIP_L.y + LEG_LEN})`);
        rBootRef.current?.setAttribute('transform', `translate(${HIP_R.x}, ${HIP_R.y + LEG_LEN})`);

        // LEFT ARM: HAND ON HIP (Elbow bent outward to the left - Image 3)
        // Shoulder (82, 150) -> Elbow (44, 186) -> Hip/Wrist (90, 212)
        lArmRef.current?.setAttribute('d', `M ${SHL_L.x} ${SHL_L.y} Q 44 186 90 212`);
        lWristRingsRef.current?.setAttribute('transform', `translate(90, 212) rotate(42)`);
        lGloveGroupRef.current?.setAttribute('transform', `translate(90, 212) rotate(42)`);

        // RIGHT ARM: WAVING HIGH IN THE AIR (Image 1 & 3)
        // Shoulder (278, 150) -> Elbow (312, 122) -> Hand Waving (326, 82 + waveSway)
        const waveHandX = 326 + waveSway * 0.4;
        const waveHandY = 82 + waveSway;

        rArmRef.current?.setAttribute('d', `M ${SHL_R.x} ${SHL_R.y} Q 312 122 ${waveHandX} ${waveHandY}`);
        rWristRingsRef.current?.setAttribute('transform', `translate(${waveHandX}, ${waveHandY}) rotate(${25 + waveSway * 0.8})`);
        rGloveGroupRef.current?.setAttribute('transform', `translate(${waveHandX}, ${waveHandY}) rotate(${25 + waveSway * 0.8})`);
      }

      // ── Apply Container Transforms ───────────────────────────────────────
      if (wrapRef.current) {
        wrapRef.current.style.left = `${pos.current.x}px`;
        wrapRef.current.style.top = `${pos.current.y - bodyBob}px`;
        wrapRef.current.style.transform = `scale(${smoothFacing.current * squash.current.sx}, ${squash.current.sy}) rotate(${headTilt.current}deg)`;
      }

      rafId = requestAnimationFrame(animate);
    };

    rafId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafId);
  }, [pickNextBehavior]);

  // Clean glass ripples
  useEffect(() => {
    if (glassRipples.length === 0) return;
    const timer = setTimeout(() => {
      setGlassRipples(prev => prev.slice(1));
    }, 600);
    return () => clearTimeout(timer);
  }, [glassRipples]);

  // Color Palettes
  const isScary = emotion === 'scary';
  const isSuspicious = emotion === 'suspicious';
  const isWinking = emotion === 'winking';
  const isPruning = emotion === 'pruning';

  const bodyGradientStart = isScary ? '#DC2626' : '#FFA224';
  const bodyGradientMid   = isScary ? '#991B1B' : '#F36709';
  const bodyGradientDark  = isScary ? '#450A0A' : '#C84800';

  return (
    <>
      {/* ── Glass Tap Ripples (Fourth-Wall Break) ──────────────────────────── */}
      {glassRipples.map(r => (
        <div
          key={r.id}
          className="glass-tap-ripple w-16 h-16"
          style={{ left: r.x, top: r.y }}
        />
      ))}

      {/* ── Authentic TVA Speech Bubble (Matching Image 3 "HEY Y'ALL!") ─────── */}
      {speechBubble && (
        <div
          className="mm-bubble select-none pointer-events-none"
          style={{
            position: 'fixed',
            left: Math.max(160, Math.min(window.innerWidth - 160, speechBubble.x)),
            top: Math.max(HEADER_H + 8, speechBubble.y - 65),
            zIndex: 10005,
            backgroundColor: '#FBF3DB',
            border: '4px solid #1E0800',
            borderRadius: '26px',
            padding: '10px 24px',
            fontFamily: `'Impact', 'Arial Black', sans-serif`,
            fontSize: '16px',
            lineHeight: 1.2,
            maxWidth: 'min(320px, calc(100vw - 32px))',
            textAlign: 'center',
            letterSpacing: '0.06em',
            color: '#1E0800',
            textTransform: 'uppercase',
            boxShadow: '0 12px 30px rgba(0,0,0,0.65), 0 0 16px rgba(245,158,11,0.3)',
            whiteSpace: 'normal',
          }}
        >
          {speechBubble.text}
          <div
            style={{
              position: 'absolute',
              bottom: -18,
              left: '50%',
              transform: 'translateX(-50%)',
              width: 0,
              height: 0,
              borderLeft: '13px solid transparent',
              borderRight: '13px solid transparent',
              borderTop: '18px solid #1E0800',
            }}
          />
        </div>
      )}

      {/* ── Miss Minutes Container ─────────────────────────────────────────── */}
      <div
        ref={wrapRef}
        className={hologramMode ? 'mm-avatar-shell mm-avatar-hologram' : 'mm-avatar-shell'}
        onPointerDown={handlePointerDown}
        onClick={handleClick}
        style={{
          position: 'fixed',
          left: 120,
          top: 200,
          width: AVATAR_W,
          height: AVATAR_H,
          zIndex: isKnocking ? 10004 : 9999,
          cursor: isDragging.current ? 'grabbing' : 'grab',
          userSelect: 'none',
          touchAction: 'none',
          transformOrigin: 'center bottom',
          willChange: 'left, top, transform',
          filter: hologramMode
            ? 'drop-shadow(0 0 35px rgba(245,110,20,0.85)) drop-shadow(0 0 15px rgba(251,191,36,0.65))'
            : isScary
            ? 'drop-shadow(0 0 45px rgba(239,68,68,0.95)) drop-shadow(0 15px 30px rgba(0,0,0,0.8))'
            : 'drop-shadow(0 0 28px rgba(245,110,20,0.45)) drop-shadow(0 18px 36px rgba(0,0,0,0.75))',
        }}
        title="Miss Minutes – Click to talk, Drag to move!"
      >
        <svg
          viewBox={`0 0 360 400`}
          width={AVATAR_W}
          height={AVATAR_H}
          style={{ display: 'block', overflow: 'visible' }}
        >
          <defs>
            {/* Clock Face Radial Gradient (Warm rich TVA orange) */}
            <radialGradient id="mmRealFace" cx="38%" cy="32%" r="65%">
              <stop offset="0%"   stopColor={bodyGradientStart} />
              <stop offset="60%"  stopColor={bodyGradientMid} />
              <stop offset="100%" stopColor={bodyGradientDark} />
            </radialGradient>

            {/* 3D Depth Bevel Gradient (Side rim of the clock disc, Images 1 & 2) */}
            <linearGradient id="mm3DBevel" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%"   stopColor={isScary ? '#5A0B0B' : '#7A2200'} />
              <stop offset="60%"  stopColor={isScary ? '#3B0404' : '#4D1500'} />
              <stop offset="100%" stopColor="#1A0700" />
            </linearGradient>

            {/* Orange Rubber-Hose Arm Gradient (Matches body orange!) */}
            <linearGradient id="mmArmOrange" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%"   stopColor={bodyGradientStart} />
              <stop offset="50%"  stopColor={bodyGradientMid} />
              <stop offset="100%" stopColor={bodyGradientDark} />
            </linearGradient>

            {/* Bright Yellow-Orange Boot Gradient */}
            <linearGradient id="mmBootYellow" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%"   stopColor={isScary ? '#881111' : '#FFA826'} />
              <stop offset="60%"  stopColor={isScary ? '#660808' : '#F57E00'} />
              <stop offset="100%" stopColor={isScary ? '#330000' : '#C75800'} />
            </linearGradient>

            {/* White Cartoon Glove Gradient */}
            <radialGradient id="mmWhiteGlove" cx="35%" cy="30%" r="70%">
              <stop offset="0%"   stopColor="#FFFFFF" />
              <stop offset="100%" stopColor="#DDE1E8" />
            </radialGradient>

            {/* Retro Hologram Scanlines Pattern */}
            <pattern id="mmRetroScan" width="100" height="4.5" patternUnits="userSpaceOnUse">
              <line x1="0" y1="0" x2="100" y2="0" stroke="rgba(255,180,0,0.12)" strokeWidth="1.5" />
            </pattern>
          </defs>

          {/* ══════════════════════════════════════════════════════════════════
              LAYER 1 — 3D PERSPECTIVE DEPTH RIM (Images 1 & 2)
              The physical thickness/depth of the wooden clock puck!
          ══════════════════════════════════════════════════════════════════ */}
          <g id="clock3DDepth">
            <ellipse
              cx={CX + 6}
              cy={CY + 7}
              rx={CR + 3}
              ry={CR + 3}
              fill="url(#mm3DBevel)"
              stroke="#1E0800"
              strokeWidth="4"
            />
          </g>

          {/* ══════════════════════════════════════════════════════════════════
              LAYER 2 — LEGS & YELLOW-ORANGE CARTOON BOOTS (Image 3)
          ══════════════════════════════════════════════════════════════════ */}
          <g id="legsAndBoots">
            {/* Left Leg (Thin dark stick leg) */}
            <path
              ref={lLegRef}
              d={`M ${HIP_L.x} ${HIP_L.y} L ${HIP_L.x} ${HIP_L.y + LEG_LEN}`}
              stroke="#1E0800"
              strokeWidth="5.5"
              strokeLinecap="round"
              fill="none"
            />
            {/* Left Boot */}
            <g ref={lBootRef} transform={`translate(${HIP_L.x}, ${HIP_L.y + LEG_LEN})`}>
              {/* Boot Shoe Body (Yellow-Orange with rounded bulbous toe) */}
              <path
                d="M -16 6 C -20 6, -24 10, -24 16 C -24 23, -18 25, 0 25 C 16 25, 26 23, 26 17 C 26 11, 18 10, 8 10 C 6 6, 2 4, -16 6 Z"
                fill="url(#mmBootYellow)"
                stroke="#1E0800"
                strokeWidth="3.2"
                strokeLinejoin="round"
              />
              {/* Folded Puffy Ankle Cuff / Collar */}
              <ellipse cx="-4" cy="4" rx="12" ry="5" fill="#FFBA3D" stroke="#1E0800" strokeWidth="2.8" />
              <path d="M -20 22 Q 0 25 24 22" stroke="#1E0800" strokeWidth="2.2" fill="none" />
            </g>

            {/* Right Leg */}
            <path
              ref={rLegRef}
              d={`M ${HIP_R.x} ${HIP_R.y} L ${HIP_R.x} ${HIP_R.y + LEG_LEN}`}
              stroke="#1E0800"
              strokeWidth="5.5"
              strokeLinecap="round"
              fill="none"
            />
            {/* Right Boot */}
            <g ref={rBootRef} transform={`translate(${HIP_R.x}, ${HIP_R.y + LEG_LEN})`}>
              <path
                d="M -16 6 C -20 6, -24 10, -24 16 C -24 23, -18 25, 0 25 C 16 25, 26 23, 26 17 C 26 11, 18 10, 8 10 C 6 6, 2 4, -16 6 Z"
                fill="url(#mmBootYellow)"
                stroke="#1E0800"
                strokeWidth="3.2"
                strokeLinejoin="round"
              />
              <ellipse cx="-4" cy="4" rx="12" ry="5" fill="#FFBA3D" stroke="#1E0800" strokeWidth="2.8" />
              <path d="M -20 22 Q 0 25 24 22" stroke="#1E0800" strokeWidth="2.2" fill="none" />
            </g>
          </g>

          {/* ══════════════════════════════════════════════════════════════════
              LAYER 3 — MAIN CLOCK BODY (Matching Reference Images 1, 2, 3)
          ══════════════════════════════════════════════════════════════════ */}
          <g id="clockBody">
            {/* Main Round Clock Face */}
            <circle
              cx={CX}
              cy={CY}
              r={CR}
              fill="url(#mmRealFace)"
              stroke="#1E0800"
              strokeWidth="5"
            />

            {/* Retro Horizontal Woodcut Lines */}
            {[-70, -50, -30, -10, 10, 30, 50, 70].map((offsetY, i) => {
              const chordHalfWidth = Math.sqrt(Math.max(0, CR * CR - offsetY * offsetY));
              return (
                <line
                  key={i}
                  x1={CX - chordHalfWidth + 3}
                  y1={CY + offsetY}
                  x2={CX + chordHalfWidth - 3}
                  y2={CY + offsetY}
                  stroke="rgba(30,8,0,0.065)"
                  strokeWidth="1.8"
                />
              );
            })}

            {/* ── BOLD HOUR TICK PILLS (Matching Show Reference!) ────────── */}
            {/* 12 o'clock pill */}
            <rect x={CX - 4} y={CY - CR + 6} width="8" height="20" rx="4" fill="#1E0800" />
            {/* 6 o'clock pill */}
            <rect x={CX - 4} y={CY + CR - 26} width="8" height="20" rx="4" fill="#1E0800" />
            {/* 9 o'clock pill */}
            <rect x={CX - CR + 6} y={CY - 4} width="20" height="8" rx="4" fill="#1E0800" />
            {/* 3 o'clock pill */}
            <rect x={CX + CR - 26} y={CY - 4} width="20" height="8" rx="4" fill="#1E0800" />

            {/* Subtle angled tick marks for other hours */}
            {[30, 60, 120, 150, 210, 240, 300, 330].map(deg => (
              <line
                key={deg}
                x1={CX}
                y1={CY - CR + 7}
                x2={CX}
                y2={CY - CR + 17}
                stroke="#1E0800"
                strokeWidth="3"
                strokeLinecap="round"
                transform={`rotate(${deg} ${CX} ${CY})`}
              />
            ))}

            {/* Center Nose Dot */}
            <circle cx={CX} cy={CY + 14} r="5.5" fill="#1E0800" />

            {/* Vintage Rosy Peach Blush Cheeks */}
            <ellipse cx={CX - 66} cy={CY + 24} rx="14" ry="8" fill={isScary ? '#7F1D1D' : '#FF6B6B'} opacity="0.35" />
            <ellipse cx={CX + 66} cy={CY + 24} rx="14" ry="8" fill={isScary ? '#7F1D1D' : '#FF6B6B'} opacity="0.35" />

            {/* ── SIGNATURE 1930s EYES & EYELASHES (Exact from Image 3!) ── */}
            {/* LEFT EYE */}
            <g transform="translate(138, 134)">
              {blink ? (
                <path d="M -26 0 Q 0 14 26 0" stroke="#1E0800" strokeWidth="4.5" strokeLinecap="round" fill="none" />
              ) : (
                <>
                  <ellipse cx="0" cy="0" rx="26" ry="34" fill="#FFFFFF" stroke="#1E0800" strokeWidth="4" />
                  <ellipse
                    ref={lPupilRef}
                    cx="0"
                    cy="4"
                    rx={isScary ? 11 : 18}
                    ry={isScary ? 11 : 25}
                    fill={isScary ? '#DC2626' : '#1E0800'}
                  />
                  <circle ref={lSparkleRef} cx="-6" cy="-4" r={isScary ? 3 : 5.5} fill="#FFFFFF" />
                  <path d="M -12 24 Q 0 29 12 24" stroke="#1E0800" strokeWidth="2" fill="none" />
                </>
              )}

              {/* EXACT 4 CURVED SPIKY EYELASHES (Image 3) */}
              {!blink && (
                <g stroke="#1E0800" strokeWidth="3.8" strokeLinecap="round" fill="none">
                  <path d="M -20 -14 Q -32 -20 -40 -24" />
                  <path d="M -14 -24 Q -22 -36 -28 -46" />
                  <path d="M -4  -32 Q -6  -48 -8  -60" />
                  <path d="M  10 -32 Q  12 -48  14 -60" />
                </g>
              )}

              {/* Eyebrow */}
              <path
                d={
                  isSuspicious
                    ? "M -24 -42 Q 0 -34 24 -52"
                    : isScary
                    ? "M -24 -34 Q 0 -52 24 -36"
                    : "M -24 -44 Q 0 -58 24 -44"
                }
                stroke="#1E0800"
                strokeWidth="4.5"
                strokeLinecap="round"
                fill="none"
              />
            </g>

            {/* RIGHT EYE */}
            <g transform="translate(222, 134)">
              {blink || isWinking ? (
                <path d="M -26 0 Q 0 -16 26 0" stroke="#1E0800" strokeWidth="4.5" strokeLinecap="round" fill="none" />
              ) : (
                <>
                  <ellipse cx="0" cy="0" rx="26" ry="34" fill="#FFFFFF" stroke="#1E0800" strokeWidth="4" />
                  <ellipse
                    ref={rPupilRef}
                    cx="0"
                    cy="4"
                    rx={isScary ? 11 : 18}
                    ry={isScary ? 11 : 25}
                    fill={isScary ? '#DC2626' : '#1E0800'}
                  />
                  <circle ref={rSparkleRef} cx="-6" cy="-4" r={isScary ? 3 : 5.5} fill="#FFFFFF" />
                  <path d="M -12 24 Q 0 29 12 24" stroke="#1E0800" strokeWidth="2" fill="none" />
                </>
              )}

              {/* EXACT 4 CURVED SPIKY EYELASHES (Image 3) */}
              {!blink && !isWinking && (
                <g stroke="#1E0800" strokeWidth="3.8" strokeLinecap="round" fill="none">
                  <path d="M -10 -32 Q -12 -48 -14 -60" />
                  <path d="M  4  -32 Q  6  -48  8  -60" />
                  <path d="M  14 -24 Q  22 -36  28 -46" />
                  <path d="M  20 -14 Q  32 -20  40 -24" />
                </g>
              )}

              {/* Eyebrow */}
              <path
                d={
                  isSuspicious
                    ? "M -24 -52 Q 0 -36 24 -42"
                    : isScary
                    ? "M -24 -36 Q 0 -52 24 -34"
                    : "M -24 -44 Q 0 -58 24 -44"
                }
                stroke="#1E0800"
                strokeWidth="4.5"
                strokeLinecap="round"
                fill="none"
              />
            </g>

            {/* ── MOUTH (Exact 1930s Smile from Image 1 & 3) ─────────────── */}
            <g id="mouth">
              {isSpeaking ? (
                mouthFrame === 0 ? (
                  <path d={`M ${CX - 24} ${CY + 40} Q ${CX} ${CY + 48} ${CX + 24} ${CY + 40}`} stroke="#1E0800" strokeWidth="3.8" strokeLinecap="round" fill="none" />
                ) : mouthFrame === 1 ? (
                  <g>
                    <path d={`M ${CX - 28} ${CY + 38} Q ${CX} ${CY + 64} ${CX + 28} ${CY + 38} Z`} fill="#991B1B" stroke="#1E0800" strokeWidth="3.5" />
                    <path d={`M ${CX - 22} ${CY + 42} Q ${CX} ${CY + 50} ${CX + 22} ${CY + 42}`} stroke="#FFFFFF" strokeWidth="4.5" strokeLinecap="round" fill="none" />
                  </g>
                ) : mouthFrame === 2 ? (
                  <ellipse cx={CX} cy={CY + 48} rx="22" ry="18" fill="#7F1D1D" stroke="#1E0800" strokeWidth="3.5" />
                ) : mouthFrame === 3 ? (
                  <g>
                    <path d={`M ${CX - 30} ${CY + 38} Q ${CX} ${CY + 68} ${CX + 30} ${CY + 38} Z`} fill="#991B1B" stroke="#1E0800" strokeWidth="3.5" />
                    <path d={`M ${CX - 24} ${CY + 44} Q ${CX} ${CY + 54} ${CX + 24} ${CY + 44}`} stroke="#FFFFFF" strokeWidth="5" strokeLinecap="round" fill="none" />
                  </g>
                ) : (
                  <ellipse cx={CX} cy={CY + 50} rx="16" ry="15" fill="#7F1D1D" stroke="#1E0800" strokeWidth="3.5" />
                )
              ) : isScary ? (
                <g>
                  <path d={`M ${CX - 38} ${CY + 38} Q ${CX} ${CY + 86} ${CX + 38} ${CY + 38} Z`} fill="#450A0A" stroke="#1E0800" strokeWidth="3.8" />
                  <path d={`M ${CX - 34} ${CY + 40} L ${CX - 26} ${CY + 58} L ${CX - 16} ${CY + 41} L ${CX - 5} ${CY + 60} L ${CX + 5} ${CY + 41} L ${CX + 16} ${CY + 60} L ${CX + 26} ${CY + 41} L ${CX + 34} ${CY + 58}`} stroke="#FFFFFF" strokeWidth="2.2" fill="none" />
                </g>
              ) : isSuspicious ? (
                <path d={`M ${CX - 22} ${CY + 44} Q ${CX + 5} ${CY + 38} ${CX + 26} ${CY + 34}`} stroke="#1E0800" strokeWidth="4" strokeLinecap="round" fill="none" />
              ) : (
                // ICONIC TVA MISS MINUTES SMILE (Image 1 & 3 Replica)
                <g>
                  <path
                    d={`M ${CX - 36} ${CY + 38} C ${CX - 32} ${CY + 84} ${CX + 32} ${CY + 84} ${CX + 36} ${CY + 38} C ${CX + 14} ${CY + 44} ${CX - 14} ${CY + 44} ${CX - 36} ${CY + 38} Z`}
                    fill="#B91C1C"
                    stroke="#1E0800"
                    strokeWidth="3.5"
                  />
                  <path
                    d={`M ${CX - 31} ${CY + 43} Q ${CX} ${CY + 54} ${CX + 31} ${CY + 43}`}
                    stroke="#FFFFFF"
                    strokeWidth="5"
                    strokeLinecap="round"
                    fill="none"
                  />
                  <path
                    d={`M ${CX - 14} ${CY + 68} Q ${CX} ${CY + 58} ${CX + 14} ${CY + 68} Q ${CX} ${CY + 78} ${CX - 14} ${CY + 68} Z`}
                    fill="#FFA6A6"
                  />
                  <path d={`M ${CX - 38} ${CY + 36} Q ${CX - 36} ${CY + 44} ${CX - 30} ${CY + 46}`} stroke="#1E0800" strokeWidth="2.5" strokeLinecap="round" fill="none" />
                  <path d={`M ${CX + 38} ${CY + 36} Q ${CX + 36} ${CY + 44} ${CX + 30} ${CY + 46}`} stroke="#1E0800" strokeWidth="2.5" strokeLinecap="round" fill="none" />
                </g>
              )}
            </g>

            {/* Hologram scanlines overlay */}
            {hologramMode && (
              <circle cx={CX} cy={CY} r={CR} fill="url(#mmRetroScan)" pointerEvents="none" opacity="0.65" />
            )}
          </g>

          {/* ══════════════════════════════════════════════════════════════════
              LAYER 4 — ORANGE ARMS, STRIPED WRISTS & 4-FINGER CARTOON GLOVES
              (Exact Replica of Reference Images 1, 2, 3!)
          ══════════════════════════════════════════════════════════════════ */}
          <g id="armsAndGloves">
            {/* ── LEFT ARM ──────────────────────────────────────────────── */}
            <path
              ref={lArmRef}
              d={`M ${SHL_L.x} ${SHL_L.y} Q 44 186 90 212`}
              stroke="url(#mmArmOrange)"
              strokeWidth="13"
              strokeLinecap="round"
              fill="none"
            />
            {/* Outline on top */}
            <path
              d={`M ${SHL_L.x} ${SHL_L.y} Q 44 186 90 212`}
              stroke="#1E0800"
              strokeWidth="13"
              strokeLinecap="round"
              fill="none"
              style={{ opacity: 0.12 }}
            />

            {/* Left Wrist: 3 Concentric Black Stripes */}
            <g ref={lWristRingsRef} transform={`translate(90, 212) rotate(42)`}>
              <line x1="-7" y1="-8" x2="7" y2="-8" stroke="#1E0800" strokeWidth="3" strokeLinecap="round" />
              <line x1="-7" y1="-4" x2="7" y2="-4" stroke="#1E0800" strokeWidth="3" strokeLinecap="round" />
              <line x1="-7" y1="0"  x2="7" y2="0"  stroke="#1E0800" strokeWidth="3" strokeLinecap="round" />
            </g>

            {/* Left Cartoon Glove (Resting on Hip in Image 1 & 3!) */}
            <g ref={lGloveGroupRef} transform={`translate(90, 212) rotate(42)`}>
              <ellipse cx="0" cy="0" rx="10" ry="4" fill="#FFFFFF" stroke="#1E0800" strokeWidth="2.8" />
              <path
                d="M -9 0 C -12 8, -12 16, -6 22 C 0 25, 11 23, 13 16 C 15 8, 11 0, 9 0 Z"
                fill="url(#mmWhiteGlove)"
                stroke="#1E0800"
                strokeWidth="2.8"
                strokeLinejoin="round"
              />
              <path d="M -5 12 Q 0 16 7 12" stroke="#1E0800" strokeWidth="2" fill="none" />
              <line x1="0" y1="3" x2="0" y2="11" stroke="#1E0800" strokeWidth="1.8" strokeLinecap="round" />
            </g>

            {/* ── RIGHT ARM ─────────────────────────────────────────────── */}
            <path
              ref={rArmRef}
              d={`M ${SHL_R.x} ${SHL_R.y} Q 312 122 326 82`}
              stroke="url(#mmArmOrange)"
              strokeWidth="13"
              strokeLinecap="round"
              fill="none"
            />
            <path
              d={`M ${SHL_R.x} ${SHL_R.y} Q 312 122 326 82`}
              stroke="#1E0800"
              strokeWidth="13"
              strokeLinecap="round"
              fill="none"
              style={{ opacity: 0.12 }}
            />

            {/* Right Wrist: 3 Concentric Black Stripes */}
            <g ref={rWristRingsRef} transform={`translate(326, 82) rotate(25)`}>
              <line x1="-7" y1="-8" x2="7" y2="-8" stroke="#1E0800" strokeWidth="3" strokeLinecap="round" />
              <line x1="-7" y1="-4" x2="7" y2="-4" stroke="#1E0800" strokeWidth="3" strokeLinecap="round" />
              <line x1="-7" y1="0"  x2="7" y2="0"  stroke="#1E0800" strokeWidth="3" strokeLinecap="round" />
            </g>

            {/* Right White Cartoon Glove (4 Fingers Waving in Image 1 & 3!) */}
            <g ref={rGloveGroupRef} transform={`translate(326, 82) rotate(25)`}>
              {/* Rolled wrist cuff */}
              <ellipse cx="0" cy="0" rx="10" ry="4" fill="#FFFFFF" stroke="#1E0800" strokeWidth="2.8" />
              {/* 4 Distinct Cartoon Fingers Spanning Out */}
              <path
                d="M -8 2
                   C -12 2, -18 5, -20 12
                   C -22 18, -16 20, -12 15
                   C -10 11, -7 8, -5 12
                   C -5 20, -7 28, -3 31
                   C 1 34, 5 33, 5 26
                   C 5 18, 5 13, 7 13
                   C 9 19, 9 29, 12 31
                   C 15 33, 20 31, 18 24
                   C 17 18, 15 13, 17 13
                   C 20 18, 22 23, 25 25
                   C 29 26, 31 21, 28 16
                   C 23 8, 14 2, 7 2 Z"
                fill="url(#mmWhiteGlove)"
                stroke="#1E0800"
                strokeWidth="2.8"
                strokeLinejoin="round"
              />
              {/* 3 dark stitch lines on back of palm */}
              <line x1="-1" y1="6" x2="-1" y2="14" stroke="#1E0800" strokeWidth="1.8" strokeLinecap="round" />
              <line x1="4"  y1="6" x2="4"  y2="14" stroke="#1E0800" strokeWidth="1.8" strokeLinecap="round" />
              <line x1="9"  y1="6" x2="9"  y2="14" stroke="#1E0800" strokeWidth="1.8" strokeLinecap="round" />
            </g>

            {/* TVA Pruning Baton (When emotion === 'pruning') */}
            {isPruning && (
              <g transform={`translate(${SHL_R.x + 22}, 150)`} className="animate-pulse">
                <rect x="-5" y="-55" width="10" height="60" rx="4" fill="#38BDF8" stroke="#0284C7" strokeWidth="2" />
                <circle cx="0" cy="-55" r="9" fill="#F43F5E" className="animate-ping" />
              </g>
            )}
          </g>
        </svg>
      </div>
    </>
  );
};

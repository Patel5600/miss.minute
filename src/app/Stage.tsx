import { useCallback, useEffect, useRef, useState } from 'react';
import { Phone, PhoneOff } from 'lucide-react';
import type { Emotion, Gesture, MouthFrame } from '../types';
import { MissMinutesRig, VIEW_BOX, type MissMinutesRigHandle, type RigSkin } from '../character/MissMinutesRig';
import type { Locomotion } from '../character/MissMinutesRig';
import { BrainDirector, type BrainContext } from './BrainDirector';
import { ThoughtBubble } from '../character/ThoughtBubble';
import { subscribeTick } from '../character/rig/ticker';
import { soundEffects } from '../utils/audioEffects';

export type StageStatus = 'idle' | 'listening' | 'thinking' | 'speaking' | 'working' | 'approval';

export interface StageProps {
  emotion: Emotion;
  gesture: Gesture;
  /** Change to replay the same gesture. */
  gestureKey: number;
  speaking: boolean;
  mouth: MouthFrame;
  status: StageStatus;
  /** What she is saying right now (subtitles). */
  line: string;
  skin: RigSkin;
  onPoke: () => void;
  /** Hands-free conversation: she listens again after every reply. */
  handsFree: boolean;
  onToggleHandsFree: () => void;
  compact?: boolean;
  className?: string;
}

const STATUS_TEXT: Record<StageStatus, string> = {
  idle: 'On air',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Talking',
  working: 'Working',
  approval: 'Needs approval',
};

/**
 * The stage: Miss Minutes projected in a TVA studio, the way the live-action stills show her.
 * Between conversations she lives a little: strolls, turns, glances around and gestures.
 */
export function Stage({
  emotion,
  gesture,
  gestureKey,
  speaking,
  mouth,
  status,
  line,
  skin,
  onPoke,
  handsFree,
  onToggleHandsFree,
  compact = false,
  className = '',
}: StageProps) {
  const rig = useRef<MissMinutesRigHandle>(null);
  const floor = useRef<HTMLDivElement>(null);
  const [x, setX] = useState(0); // horizontal offset in px from centre
  const [walk, setWalk] = useState<{ locomotion: Locomotion; facing: -1 | 0 | 1; speed: number; ms: number }>({
    locomotion: 'idle', facing: 0, speed: 0, ms: 0,
  });
  const [idleGesture, setIdleGesture] = useState<{ g: Gesture; k: number }>({ g: 'none', k: 0 });
  const [brainEmotion, setBrainEmotion] = useState<Emotion>('cheerful');
  const [brainLocomotion, setBrainLocomotion] = useState<Locomotion>('idle');

  const busy = status !== 'idle' || speaking;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const speakingRef = useRef(speaking);
  speakingRef.current = speaking;
  const xRef = useRef(x);
  xRef.current = x;

  const lastInteraction = useRef(Date.now());
  const visibleStart = useRef(Date.now());

  const brain = useRef(new BrainDirector());

  const getContext = useCallback((): BrainContext => {
    const el = floor.current;
    const width = el?.clientWidth ?? 400;
    const height = el?.clientHeight ?? 400;
    const scale = Math.min(width / VIEW_BOX.w, height / VIEW_BOX.h);
    return {
      x: xRef.current,
      width,
      height,
      scale: Math.max(scale, 0.01),
      speaking: speakingRef.current,
      busy: busyRef.current,
      lastInteractionMs: lastInteraction.current,
      visibleMs: Date.now() - visibleStart.current,
    };
  }, []);

  // Wire BrainDirector up to shared animation tick and subscription
  useEffect(() => {
    const unsubBrain = brain.current.subscribe(s => {
      setBrainLocomotion(s.locomotion);
      if (s.emotion) {
        setBrainEmotion(s.emotion);
      }
      if (s.gesture && s.gesture !== 'none') {
        setIdleGesture({ g: s.gesture, k: s.gestureKey });
      }
      if (s.locomotion === 'walk') {
        const distance = Math.abs((s.targetX ?? 0) - xRef.current);
        const ms = (distance / 70) * 1000;
        setWalk({ locomotion: 'walk', facing: s.facing, speed: s.walkSpeed, ms });
        setX(s.targetX);
        xRef.current = s.targetX;
      } else {
        setWalk({ locomotion: s.locomotion, facing: s.facing, speed: s.walkSpeed, ms: 0 });
        if (s.targetX !== undefined && s.targetX !== xRef.current) {
          setX(s.targetX);
          xRef.current = s.targetX;
        }
      }
    });

    const unsubTick = subscribeTick((_now, dt) => {
      const ctx = getContext();
      brain.current.frame(dt, ctx);
      return busyRef.current ? 'busy' : 'idle';
    });

    return () => {
      unsubBrain();
      unsubTick();
    };
  }, [getContext]);

  // Track page visibility changes
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        visibleStart.current = Date.now();
        brain.current.event({ type: 'page_visible' }, getContext());
      } else {
        brain.current.event({ type: 'page_hidden' }, getContext());
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [getContext]);

  // Track user interactions to keep lastInteractionMs fresh
  useEffect(() => {
    const onInteraction = () => {
      lastInteraction.current = Date.now();
    };
    window.addEventListener('pointerdown', onInteraction, { passive: true });
    window.addEventListener('keydown', onInteraction, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', onInteraction);
      window.removeEventListener('keydown', onInteraction);
    };
  }, []);

  // Return to centre when busy
  useEffect(() => {
    if (busy && xRef.current !== 0) {
      setX(0);
      xRef.current = 0;
      setWalk(w => ({ ...w, ms: 0 }));
    }
  }, [busy]);

  // On speaking change
  const prevSpeaking = useRef(speaking);
  useEffect(() => {
    if (prevSpeaking.current !== speaking) {
      prevSpeaking.current = speaking;
      brain.current.event({ type: speaking ? 'speaking_start' : 'speaking_end' }, getContext());
    }
  }, [speaking, getContext]);

  // On busy change
  const prevBusy = useRef(busy);
  useEffect(() => {
    if (prevBusy.current !== busy) {
      prevBusy.current = busy;
      brain.current.event({ type: busy ? 'busy_start' : 'busy_end' }, getContext());
    }
  }, [busy, getContext]);

  // Glass tap ripples for breaking the 4th wall
  const [ripples, setRipples] = useState<Array<{ id: number; x: number; y: number }>>([]);

  const handlePoke = useCallback((e: React.MouseEvent) => {
    lastInteraction.current = Date.now();
    soundEffects.playGlassTap();
    rig.current?.hop();
    brain.current.event({ type: 'poke' }, getContext());

    const rect = e.currentTarget.getBoundingClientRect();
    const rx = e.clientX - rect.left;
    const ry = e.clientY - rect.top;
    const ripId = Date.now() + Math.random();
    setRipples(prev => [...prev.slice(-3), { id: ripId, x: rx, y: ry }]);
    window.setTimeout(() => setRipples(prev => prev.filter(r => r.id !== ripId)), 550);

    onPoke();
  }, [getContext, onPoke]);

  const activeEmotion = emotion !== 'cheerful' ? emotion : brainEmotion;
  const activeGesture = gesture !== 'none' ? gesture : idleGesture.g;
  const activeKey = gesture !== 'none' ? `c${gestureKey}` : `i${idleGesture.k}`;

  return (
    <div
      className={`mm-stage relative flex flex-col overflow-hidden rounded-3xl border border-white/[0.08] bg-[#0B0806] shadow-[0_20px_60px_rgba(0,0,0,0.55)] ${
        compact ? 'h-full min-h-[320px]' : ''
      } ${className}`}
    >
      {/* Volumetric obsidian projection halo */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(68%_58%_at_50%_42%,rgba(255,122,26,0.18),transparent_72%)]" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-[linear-gradient(to_top,rgba(35,18,6,0.55),transparent)]" />

      {/* Top floating controls */}
      <div className="relative z-10 flex items-center justify-between gap-2 px-4 pt-4">
        <div className="inline-flex items-center gap-2 rounded-full border border-white/[0.09] bg-[#14100C]/85 px-3 py-1 text-[11px] font-medium tracking-wide text-[#F5EFE6] backdrop-blur">
          <span
            className={`h-2 w-2 rounded-full ${
              status === 'idle' && !speaking
                ? 'bg-emerald-400'
                : status === 'approval'
                  ? 'bg-red-500 animate-pulse'
                  : 'bg-[#FF7A1A] animate-pulse'
            }`}
          />
          {STATUS_TEXT[speaking ? 'speaking' : status]}
        </div>

        <button
          type="button"
          onClick={onToggleHandsFree}
          aria-pressed={handsFree}
          title={handsFree ? 'End hands-free talk' : 'Talk hands-free: she listens again after every answer'}
          className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium backdrop-blur transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF7A1A] ${
            handsFree
              ? 'border-red-400/70 bg-red-600 text-white hover:bg-red-500'
              : 'border-white/[0.1] bg-[#14100C]/85 text-[#F5EFE6] hover:border-[#FF7A1A]/40 hover:bg-[#1E1812]'
          }`}
        >
          {handsFree ? <PhoneOff className="h-3.5 w-3.5" /> : <Phone className="h-3.5 w-3.5 text-[#FF7A1A]" />}
          {handsFree ? 'End live' : 'Hands-free'}
        </button>
      </div>

      {/* Floor and projector */}
      <div
        ref={floor}
        className={`relative mx-auto w-full ${
          compact ? 'min-h-[240px] flex-1' : 'h-[min(60vh,540px)] min-h-[360px]'
        }`}
      >
        <div className="pointer-events-none absolute bottom-[8%] left-1/2 h-[9%] w-[52%] -translate-x-1/2 rounded-[50%] bg-[radial-gradient(closest-side,rgba(255,140,40,0.4),rgba(255,122,26,0.1)_65%,transparent)]" />
        <div className="pointer-events-none absolute bottom-[6%] left-1/2 h-[3.5%] w-[34%] -translate-x-1/2 rounded-[50%] border border-[#FF7A1A]/35 bg-[#2A1708]/50" />

        <button
          type="button"
          onClick={handlePoke}
          aria-label="Miss Minutes"
          className="absolute inset-x-0 bottom-[5%] top-[2%] mx-auto cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-[#FF7A1A]"
          style={{
            width: '100%',
            transform: `translateX(${x}px)`,
            transition: walk.ms ? `transform ${walk.ms}ms linear` : 'transform 300ms ease-out',
          }}
        >
          {ripples.map(r => (
            <span
              key={r.id}
              className="glass-tap-ripple"
              style={{ left: r.x, top: r.y, width: 80, height: 80 }}
            />
          ))}
          <ThoughtBubble
            visible={brainLocomotion === 'think' || (status === 'thinking' && !speaking)}
            thoughtText={status === 'thinking' ? 'CRUNCHING TIMELINE…' : undefined}
          />
          <MissMinutesRig
            ref={rig}
            emotion={activeEmotion}
            gesture={activeGesture}
            gestureKey={activeKey}
            isSpeaking={speaking}
            mouthFrame={mouth}
            skin={skin}
            facing={walk.facing}
            locomotion={walk.locomotion}
            walkSpeed={walk.speed}
            gaze="pointer"
          />
        </button>
      </div>

      {/* Subtitles */}
      <div className="pointer-events-none relative z-10 flex min-h-[58px] items-end justify-center bg-gradient-to-t from-black/80 via-black/40 to-transparent px-4 pb-4 pt-2">
        {line && (
          <p className="max-w-[94%] text-center text-xs leading-relaxed text-[#F5EFE6] [text-shadow:0_1px_3px_rgba(0,0,0,0.9)] sm:text-sm">
            {line}
          </p>
        )}
      </div>
    </div>
  );
}

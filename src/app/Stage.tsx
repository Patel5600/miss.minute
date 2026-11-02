import { useCallback, useEffect, useRef, useState } from 'react';
import { Phone, PhoneOff } from 'lucide-react';
import type { Emotion, Gesture, MouthFrame } from '../types';
import { MissMinutesRig, VIEW_BOX, type MissMinutesRigHandle, type RigSkin } from '../character/MissMinutesRig';
import type { Locomotion } from '../character/MissMinutesRig';
import { BrainDirector, type BrainContext } from './BrainDirector';
import { ThoughtBubble } from '../character/ThoughtBubble';
import { subscribeTick } from '../character/rig/ticker';

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
}

const STATUS_TEXT: Record<StageStatus, string> = {
  idle: 'On air',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Talking',
  working: 'On it',
  approval: 'Needs your OK',
};

/**
 * The stage: Miss Minutes projected in a TVA room, the way the live-action stills show her.
 * Between conversations she lives a little: strolls, turns, glances around and gestures.
 */
export function Stage({ emotion, gesture, gestureKey, speaking, mouth, status, line, skin, onPoke, handsFree, onToggleHandsFree }: StageProps) {
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

  const handlePoke = useCallback(() => {
    lastInteraction.current = Date.now();
    rig.current?.hop();
    brain.current.event({ type: 'poke' }, getContext());
    onPoke();
  }, [getContext, onPoke]);

  const activeEmotion = emotion !== 'cheerful' ? emotion : brainEmotion;
  const activeGesture = gesture !== 'none' ? gesture : idleGesture.g;
  const activeKey = gesture !== 'none' ? `c${gestureKey}` : `i${idleGesture.k}`;

  return (
    <div className="mm-stage relative overflow-hidden rounded-3xl border border-amber-700/40 bg-[#0b0704] shadow-[0_20px_60px_rgba(0,0,0,0.6)]">
      {/* Room: dark TVA office lit only by her projection. */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(70%_60%_at_50%_40%,rgba(255,140,40,0.20),transparent_70%)]" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-[linear-gradient(to_top,rgba(60,30,8,0.55),transparent)]" />
      <div className="pointer-events-none absolute inset-0 opacity-[0.07] bg-[linear-gradient(to_right,#f59e0b_1px,transparent_1px),linear-gradient(to_bottom,#f59e0b_1px,transparent_1px)] bg-[size:36px_36px]" />

      {/* Status */}
      <div className="absolute left-4 top-4 z-10 flex items-center gap-2 rounded-full border border-amber-700/40 bg-black/50 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-amber-200">
        <span className={`h-2 w-2 rounded-full ${status === 'idle' && !speaking ? 'bg-emerald-400' : status === 'approval' ? 'bg-red-500 animate-pulse' : 'bg-amber-400 animate-pulse'}`} />
        {STATUS_TEXT[speaking ? 'speaking' : status]}
      </div>

      {/* Hands-free talk */}
      <button
        type="button"
        onClick={onToggleHandsFree}
        aria-pressed={handsFree}
        title={handsFree ? 'End hands-free talk' : 'Talk hands-free: she listens again after every answer'}
        className={`absolute right-4 top-4 z-10 flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
          handsFree ? 'border-red-400 bg-red-600 text-white' : 'border-amber-600/60 bg-black/50 text-amber-200 hover:border-amber-400'
        }`}
      >
        {handsFree ? <PhoneOff className="h-3.5 w-3.5" /> : <Phone className="h-3.5 w-3.5" />}
        {handsFree ? 'End talk' : 'Talk hands-free'}
      </button>

      {/* Floor and projector */}
      <div ref={floor} className="relative mx-auto h-[min(62vh,560px)] min-h-[380px] w-full">
        <div className="pointer-events-none absolute bottom-[7%] left-1/2 h-[9%] w-[46%] -translate-x-1/2 rounded-[50%] bg-[radial-gradient(closest-side,rgba(255,160,60,0.45),rgba(255,120,30,0.12)_60%,transparent)]" />
        <div className="pointer-events-none absolute bottom-[5.5%] left-1/2 h-[4%] w-[30%] -translate-x-1/2 rounded-[50%] border border-amber-500/40 bg-amber-900/30" />

        <button
          type="button"
          onClick={handlePoke}
          aria-label="Miss Minutes"
          className="absolute inset-x-0 bottom-[4%] top-[6%] mx-auto cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
          style={{
            width: '100%',
            transform: `translateX(${x}px)`,
            transition: walk.ms ? `transform ${walk.ms}ms linear` : 'transform 300ms ease-out',
          }}
        >
          <ThoughtBubble visible={brainLocomotion === 'think' || (status === 'thinking' && !speaking)} />
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
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex min-h-[64px] items-end justify-center bg-gradient-to-t from-black/80 to-transparent px-6 pb-4">
        {line && (
          <p className="max-w-[90%] text-center text-sm leading-snug text-amber-50 [text-shadow:0_1px_3px_rgba(0,0,0,0.9)]">{line}</p>
        )}
      </div>
    </div>
  );
}

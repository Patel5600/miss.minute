import { useCallback, useEffect, useRef, useState } from 'react';
import { Phone, PhoneOff } from 'lucide-react';
import type { Emotion, Gesture, MouthFrame } from '../types';
import { MissMinutesRig, VIEW_BOX, type MissMinutesRigHandle, type RigSkin } from '../character/MissMinutesRig';
import type { Locomotion } from '../character/MissMinutesRig';

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

const IDLE_GESTURES: Gesture[] = ['wave', 'hips', 'think', 'shrug', 'point', 'present'];

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
  const busy = status !== 'idle' || speaking;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  // Walk back to centre whenever she gets busy, so she faces the owner to talk.
  useEffect(() => {
    if (!busy || x === 0) return;
    strollTo(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  const strollTo = useCallback((target: number) => {
    const el = floor.current;
    if (!el) return;
    const width = el.clientWidth;
    const scale = Math.min(width / VIEW_BOX.w, el.clientHeight / VIEW_BOX.h);
    setX(current => {
      const distance = Math.abs(target - current);
      if (distance < 4) return current;
      const pxPerSec = 70;
      const ms = (distance / pxPerSec) * 1000;
      setWalk({ locomotion: 'walk', facing: target > current ? 1 : -1, speed: pxPerSec / Math.max(scale, 0.1), ms });
      window.setTimeout(() => setWalk({ locomotion: 'idle', facing: 0, speed: 0, ms: 0 }), ms);
      return target;
    });
  }, []);

  // Idle life: every so often she strolls or does a little gesture.
  useEffect(() => {
    let timer = 0;
    const next = () => {
      timer = window.setTimeout(() => {
        if (!busyRef.current && document.visibilityState === 'visible') {
          const el = floor.current;
          const room = el ? Math.max(0, el.clientWidth / 2 - el.clientHeight * 0.35) : 0;
          if (Math.random() < 0.45 && room > 30) strollTo(Math.round((Math.random() * 2 - 1) * room));
          else setIdleGesture(previous => ({ g: IDLE_GESTURES[Math.floor(Math.random() * IDLE_GESTURES.length)], k: previous.k + 1 }));
        }
        next();
      }, 7000 + Math.random() * 9000);
    };
    next();
    return () => window.clearTimeout(timer);
  }, [strollTo]);

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
          onClick={() => { rig.current?.hop(); onPoke(); }}
          aria-label="Miss Minutes"
          className="absolute inset-x-0 bottom-[4%] top-[6%] mx-auto cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
          style={{
            width: '100%',
            transform: `translateX(${x}px)`,
            transition: walk.ms ? `transform ${walk.ms}ms linear` : 'transform 300ms ease-out',
          }}
        >
          <MissMinutesRig
            ref={rig}
            emotion={emotion}
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

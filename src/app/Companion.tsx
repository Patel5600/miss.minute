import { useCallback, useEffect, useRef, useState } from 'react';
import type { Emotion, Gesture, MouthFrame } from '../types';
import { MissMinutesRig, viewToClient, VIEW_BOX, type Locomotion, type MissMinutesRigHandle } from '../character/MissMinutesRig';

export interface CompanionProps {
  emotion: Emotion;
  gesture: Gesture;
  gestureKey: number;
  speaking: boolean;
  mouth: MouthFrame;
  /** Speech bubble text; empty hides it. */
  line: string;
  onPoke(): void;
  /** Her on-screen rectangle in CSS px (the desktop host makes only this area clickable). */
  onBoundsChange?(bounds: { x: number; y: number; width: number; height: number }): void;
  onDraggingChange?(dragging: boolean): void;
}

const W = 210;
const H = 215;
const MARGIN = 12;

/**
 * Miss Minutes living on the desktop: she strolls along the bottom of the screen, can be picked
 * up and dropped anywhere, and drops back to the floor when let go.
 */
export function Companion({ emotion, gesture, gestureKey, speaking, mouth, line, onPoke, onBoundsChange, onDraggingChange }: CompanionProps) {
  const rig = useRef<MissMinutesRigHandle>(null);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(() => ({ x: window.innerWidth - W - 80, y: window.innerHeight - H - MARGIN }));
  const [motion, setMotion] = useState<{ locomotion: Locomotion; facing: -1 | 0 | 1; speed: number; ms: number }>({ locomotion: 'idle', facing: 0, speed: 0, ms: 0 });
  const drag = useRef<{ dx: number; dy: number; startX: number; startY: number; moved: boolean } | null>(null);
  const busyRef = useRef(false);
  busyRef.current = speaking || drag.current !== null;

  const floorY = () => window.innerHeight - H - MARGIN;
  const scale = Math.min(W / VIEW_BOX.w, H / VIEW_BOX.h);

  // Stroll along the floor now and then.
  useEffect(() => {
    let timer = 0;
    const schedule = () => {
      timer = window.setTimeout(() => {
        if (!busyRef.current && document.visibilityState === 'visible') {
          setPos(current => {
            if (Math.abs(current.y - floorY()) > 2) return current;
            const target = Math.round(MARGIN + Math.random() * (window.innerWidth - W - MARGIN * 2));
            const distance = Math.abs(target - current.x);
            if (distance < 40) return current;
            const pxPerSec = 60;
            const ms = (distance / pxPerSec) * 1000;
            setMotion({ locomotion: 'walk', facing: target > current.x ? 1 : -1, speed: pxPerSec / scale, ms });
            window.setTimeout(() => setMotion({ locomotion: 'idle', facing: 0, speed: 0, ms: 0 }), ms);
            return { ...current, x: target };
          });
        }
        schedule();
      }, 14000 + Math.random() * 22000);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [scale]);

  // Keep her on screen when the display changes.
  useEffect(() => {
    const onResize = () => setPos(p => ({ x: Math.min(p.x, window.innerWidth - W - MARGIN), y: floorY() }));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Report the character's real rectangle about ten times a second.
  const reportRef = useRef(onBoundsChange);
  reportRef.current = onBoundsChange;
  useEffect(() => {
    const id = window.setInterval(() => {
      const el = box.current;
      const handle = rig.current;
      if (!el || !handle || !reportRef.current) return;
      const rect = el.getBoundingClientRect();
      const b = handle.getBounds();
      const a = viewToClient(rect, b.x, b.y);
      const c = viewToClient(rect, b.x + b.width, b.y + b.height);
      const pad = 6;
      reportRef.current({ x: a.x - pad, y: a.y - pad, width: c.x - a.x + pad * 2, height: c.y - a.y + pad * 2 });
    }, 100);
    return () => window.clearInterval(id);
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y, startX: e.clientX, startY: e.clientY, moved: false };
  }, [pos]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 6) return;
    if (!d.moved) {
      d.moved = true;
      onDraggingChange?.(true);
      setMotion({ locomotion: 'drag', facing: 0, speed: 0, ms: 0 });
    }
    setPos({
      x: Math.max(0, Math.min(window.innerWidth - W, e.clientX - d.dx)),
      y: Math.max(0, Math.min(floorY(), e.clientY - d.dy)),
    });
  }, [onDraggingChange]);

  const onPointerUp = useCallback(() => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (!d.moved) { rig.current?.hop(); onPoke(); return; }
    onDraggingChange?.(false);
    // Let go: she falls back to the floor and lands with a squash.
    const fallMs = 450;
    setMotion({ locomotion: 'fall', facing: 0, speed: 0, ms: fallMs });
    setPos(p => ({ ...p, y: floorY() }));
    window.setTimeout(() => { setMotion({ locomotion: 'idle', facing: 0, speed: 0, ms: 0 }); rig.current?.squash(0.8); }, fallMs);
  }, [onPoke, onDraggingChange]);

  const transition = motion.locomotion === 'walk'
    ? `left ${motion.ms}ms linear`
    : motion.locomotion === 'fall' ? `top ${motion.ms}ms cubic-bezier(.5,0,1,1)` : 'none';

  return (
    <div
      ref={box}
      className="mm-companion fixed select-none"
      style={{ left: pos.x, top: pos.y, width: W, height: H, transition, pointerEvents: 'auto', touchAction: 'none', cursor: drag.current ? 'grabbing' : 'grab' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {line && (
        <div className="absolute bottom-full left-1/2 mb-1 w-64 -translate-x-1/2 rounded-2xl border-2 border-neutral-900 bg-[#fff6dc] px-3 py-2 text-center text-[13px] font-semibold leading-snug text-neutral-900 shadow-lg">
          {line}
        </div>
      )}
      <MissMinutesRig
        ref={rig}
        emotion={emotion}
        gesture={gesture}
        gestureKey={gestureKey}
        isSpeaking={speaking}
        mouthFrame={mouth}
        skin="hologram"
        facing={motion.facing}
        locomotion={motion.locomotion}
        walkSpeed={motion.speed}
        gaze="pointer"
      />
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { MissMinutesRig, VIEW_BOX } from '@desktop/character/MissMinutesRig';
import type { MissMinutesRigHandle } from '@desktop/character/MissMinutesRig';
import type { Gesture, Locomotion } from '@desktop/character/MissMinutesRig';
import {
  ackKillNotice,
  describeError,
  describeKillNotice,
  describeOverlay,
  LEVEL_DETAILS,
  requestOverlayPermission,
  setSetting,
  startOverlay,
  stopOverlay,
} from '../../shared/nativeApi.ts';
import { ROAMING_LEVELS } from '../../shared/vocabulary.ts';
import { Switch } from '../Switch.tsx';
import { useNativeState } from '../useNative.ts';

type StageGesture = 'wave' | 'shrug' | 'point' | 'hips' | 'present' | 'think' | 'knock' | 'clap';
const STAGE_GESTURES: readonly StageGesture[] = ['wave', 'point', 'present', 'clap', 'hips', 'shrug', 'think', 'knock'];
const IDLE_GESTURES: readonly StageGesture[] = ['wave', 'hips', 'think', 'shrug', 'point', 'present'];

const dateFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

const TONE_DOT = { ok: 'bg-face', warn: 'bg-red-500', idle: 'bg-muted' } as const;

/** A self-contained Stage for the mobile dashboard: TVA-lit room, idle walking, gaze. */
function MobileStage({ tap, onTap }: { tap: number; onTap: () => void }) {
  const rig = useRef<MissMinutesRigHandle | null>(null);
  const floor = useRef<HTMLDivElement | null>(null);
  const [x, setX] = useState(0);
  const [walk, setWalk] = useState<{ locomotion: Locomotion; facing: -1 | 0 | 1; speed: number; ms: number }>({
    locomotion: 'idle', facing: 0, speed: 0, ms: 0,
  });
  const [idleGesture, setIdleGesture] = useState<{ g: Gesture; k: number }>({ g: 'none', k: 0 });
  const busyRef = useRef(false);

  const strollTo = useCallback((target: number) => {
    const el = floor.current;
    if (!el) return;
    const scale = Math.min(el.clientWidth / VIEW_BOX.w, el.clientHeight / VIEW_BOX.h);
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

  // Idle life: strolls and gestures.
  useEffect(() => {
    let timer = 0;
    const next = () => {
      timer = window.setTimeout(() => {
        if (!busyRef.current && document.visibilityState === 'visible') {
          const el = floor.current;
          const room = el ? Math.max(0, el.clientWidth / 2 - el.clientHeight * 0.35) : 0;
          if (Math.random() < 0.4 && room > 20) strollTo(Math.round((Math.random() * 2 - 1) * room));
          else setIdleGesture(prev => ({ g: IDLE_GESTURES[Math.floor(Math.random() * IDLE_GESTURES.length)] as Gesture, k: prev.k + 1 }));
        }
        next();
      }, 6000 + Math.random() * 8000);
    };
    next();
    return () => window.clearTimeout(timer);
  }, [strollTo]);

  const tapGesture: Gesture = tap === 0 ? 'none' : (STAGE_GESTURES[(tap - 1) % STAGE_GESTURES.length] ?? 'none');
  const activeGesture: Gesture = tap > 0 ? tapGesture : idleGesture.g;
  const activeKey = tap > 0 ? `t${tap}` : `i${idleGesture.k}`;

  return (
    /* TVA dark room with amber projection glow */
    <div className="relative overflow-hidden rounded-3xl border border-amber-700/40 bg-[#0b0704] shadow-[0_16px_48px_rgba(0,0,0,0.7)]">
      {/* Radial amber light from her projection */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(65%_55%_at_50%_38%,rgba(255,140,40,0.22),transparent_68%)]" />
      {/* Dark floor vignette */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-[linear-gradient(to_top,rgba(50,25,5,0.6),transparent)]" />
      {/* TVA grid lines */}
      <div className="pointer-events-none absolute inset-0 opacity-[0.06] bg-[linear-gradient(to_right,#f59e0b_1px,transparent_1px),linear-gradient(to_bottom,#f59e0b_1px,transparent_1px)] bg-[size:28px_28px]" />

      {/* Character floor — tap anywhere to poke */}
      <div ref={floor} className="relative h-72 w-full">
        {/* Ground glow ellipse */}
        <div className="pointer-events-none absolute bottom-[8%] left-1/2 h-[7%] w-[44%] -translate-x-1/2 rounded-[50%] bg-[radial-gradient(closest-side,rgba(255,160,60,0.4),rgba(255,120,30,0.10)_60%,transparent)]" />
        {/* Shadow disc */}
        <div className="pointer-events-none absolute bottom-[6%] left-1/2 h-[3%] w-[28%] -translate-x-1/2 rounded-[50%] border border-amber-500/30 bg-amber-900/25" />

        <button
          type="button"
          onClick={() => { rig.current?.hop(); onTap(); }}
          aria-label="Miss Minutes — tap to poke"
          className="absolute inset-x-0 bottom-[4%] top-[4%] mx-auto cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
          style={{
            width: '100%',
            transform: `translateX(${x}px)`,
            transition: walk.ms ? `transform ${walk.ms}ms linear` : 'transform 280ms ease-out',
          }}
        >
          <MissMinutesRig
            ref={rig}
            skin="hologram"
            gaze="pointer"
            emotion="cheerful"
            gesture={activeGesture}
            gestureKey={activeKey}
            facing={walk.facing}
            locomotion={walk.locomotion}
            walkSpeed={walk.speed}
            style={{ width: '100%', height: '100%', display: 'block' }}
          />
        </button>
      </div>

      {/* "Hey y'all" caption */}
      <p className="pb-3 text-center text-[11px] font-medium uppercase tracking-[0.18em] text-amber-400/80">
        Tap to poke her
      </p>
    </div>
  );
}

export function Home() {
  const native = useNativeState();
  const [tap, setTap] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const info = native.info;
  const ready = native.phase === 'ready' && info !== null;
  const runtimeState = info?.overlay.runtime?.state ?? null;
  const transitionPending = runtimeState === 'STARTING' || runtimeState === 'STOPPING' || runtimeState === 'RECOVERING';
  const companionSwitchChecked = runtimeState
    ? runtimeState === 'STARTING' || runtimeState === 'RUNNING' || runtimeState === 'STOPPING' || runtimeState === 'RECOVERING'
    : (info?.overlay.running ?? false);
  const companionSwitchLabel = runtimeState === 'STARTING'
    ? 'Starting Miss Minutes…'
    : runtimeState === 'STOPPING'
      ? 'Stopping Miss Minutes…'
      : runtimeState === 'RECOVERING'
        ? 'Reconnecting Miss Minutes…'
        : 'Show her on my screen';
  const description = info ? describeOverlay(info.overlay) : null;

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (error) {
      setMessage(describeError(error));
    } finally {
      setBusy(false);
      await native.refresh();
    }
  }

  async function turnOn(): Promise<void> {
    const result = await startOverlay();
    if (result.needsOverlayPermission) {
      setMessage('Allow Display over other apps first, then turn her on again.');
    }
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-5">
      {native.phase === 'offline' && (
        <div role="status" className="rounded-xl border border-face/40 bg-face/10 px-4 py-3 text-sm">
          Open this in the Miss Minutes app.
        </div>
      )}

      {info?.killNotice && (
        <section role="status" aria-label="Stopped" className="rounded-2xl border border-face/50 bg-face/10 p-4 text-sm leading-relaxed">
          <p>{describeKillNotice(info.killNotice)}</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(ackKillNotice)}
            className="mt-3 h-12 rounded-xl bg-face px-6 font-semibold text-black disabled:opacity-50"
          >
            Got it
          </button>
        </section>
      )}

      <header>
        <p className="text-sm uppercase tracking-widest text-muted">Today</p>
        <h1 className="text-4xl font-semibold leading-tight text-cream">{dateFormat.format(new Date())}</h1>
      </header>

      {/* Miss Minutes Stage — full TVA presentation */}
      <MobileStage tap={tap} onTap={() => setTap(n => n + 1)} />

      {message && (
        <div role="alert" className="rounded-xl border border-red-500/50 bg-red-500/10 px-4 py-3 text-sm">
          {message}
        </div>
      )}

      <section aria-label="On my screen" className="rounded-2xl border border-line bg-raised px-4 pb-4 pt-2">
        <Switch
          checked={companionSwitchChecked}
          label={companionSwitchLabel}
          disabled={busy || !ready || transitionPending}
          onChange={(next) => void run(next ? turnOn : async () => void (await stopOverlay()))}
        />
        {description && (
          <div role="status" className="flex items-start gap-3 rounded-xl bg-base/60 p-3">
            <span aria-hidden="true" className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${TONE_DOT[description.tone]}`} />
            <div>
              <p className="text-sm font-medium text-cream">{description.headline}</p>
              <p className="text-sm leading-snug text-muted">{description.detail}</p>
            </div>
          </div>
        )}
        {description?.needsOverlayPermission && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(requestOverlayPermission)}
            className="mt-3 h-12 w-full rounded-xl bg-face font-semibold text-black disabled:opacity-50"
          >
            Allow Display over other apps
          </button>
        )}
        {description?.hiddenByTimer && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(async () => void (await setSetting('hidden_until_ms', 0)))}
            className="mt-3 h-12 w-full rounded-xl bg-line font-semibold text-cream disabled:opacity-50"
          >
            Show her now
          </button>
        )}
        {ready && description?.notificationsOff && (
          <p className="mt-3 text-xs leading-snug text-muted">
            Notifications are off, so the Stop button in the notification shade is not shown. You can still stop her from
            the red button above or from her menu.
          </p>
        )}
      </section>

      <section aria-label="Roaming" className="rounded-2xl border border-line bg-raised p-4">
        <h2 className="mb-3 font-semibold text-face">How much she roams</h2>
        <div role="radiogroup" aria-label="Roaming level" className="grid grid-cols-4 gap-2">
          {ROAMING_LEVELS.map((level) => {
            const selected = info?.settings.roaming_level === level;
            return (
              <button
                key={level}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={busy || !ready}
                onClick={() => void run(async () => void (await setSetting('roaming_level', level)))}
                className={`h-12 rounded-xl text-sm font-medium disabled:opacity-50 ${selected ? 'bg-face text-black' : 'bg-line text-cream'}`}
              >
                {LEVEL_DETAILS[level].label}
              </button>
            );
          })}
        </div>
        <p className="mt-3 text-sm leading-snug text-cream/90">
          {info ? LEVEL_DETAILS[info.settings.roaming_level].text : 'Calm is the default.'}
        </p>
        <p className="mt-2 text-xs leading-snug text-muted">
          Right now she can stand, walk, hop and do eight gestures. Running, hanging, climbing, sitting on edges, jumping
          and peeking switch on only when her body can draw them.
        </p>
      </section>

      <section aria-label="When I close the app" className="rounded-2xl border border-line bg-raised px-4 py-1">
        <Switch
          checked={info?.settings.keep_after_close ?? false}
          label="Keep her on screen after I close the app"
          description="Off: swiping the app away from Recents makes her leave. On: she stays until you stop her. Pressing Home never stops her."
          disabled={busy || !ready}
          onChange={(next) => void run(async () => void (await setSetting('keep_after_close', next)))}
        />
      </section>

      <section className="rounded-2xl border border-line bg-raised p-4 text-sm leading-relaxed">
        <h2 className="mb-2 font-semibold text-face">What she can and cannot do</h2>
        <ul className="list-disc space-y-1.5 pl-5 text-cream/90">
          <li>She cannot see other apps' windows, so she roams the edges of your screen instead.</li>
          <li>To appear above other apps she needs "Display over other apps". Without it she stays in this app.</li>
          <li>The red Stop Miss Minutes button, her menu and the notification all stop everything she is doing.</li>
        </ul>
      </section>
    </div>
  );
}

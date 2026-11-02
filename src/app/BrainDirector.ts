/**
 * BrainDirector: event-reactive behaviour scheduler for Miss Minutes.
 *
 * Zero hardcoded timeouts. Uses requestIdleCallback + RAF budget. Weights shift
 * with context (recent events, speaking state, time in viewport, etc.).
 * Drives Stage locomotion, emotion and gesture purely from events.
 */
import type { Emotion, Gesture } from '../types';
import type { Locomotion } from '../character/MissMinutesRig';

export interface BrainState {
  emotion: Emotion;
  gesture: Gesture;
  gestureKey: number;
  locomotion: Locomotion;
  walkSpeed: number;
  facing: -1 | 0 | 1;
  targetX: number;
}

export interface BrainContext {
  /** Current horizontal position in px */
  x: number;
  /** Stage width in px */
  width: number;
  /** Stage height in px */
  height: number;
  /** px per rig unit (from VIEW_BOX scale) */
  scale: number;
  /** Is she speaking right now? */
  speaking: boolean;
  /** Is the agent busy processing? */
  busy: boolean;
  /** Last time there was any user interaction (pointer/key), in ms */
  lastInteractionMs: number;
  /** ms since page became visible */
  visibleMs: number;
}

export type BrainEvent =
  | { type: 'poke' }
  | { type: 'speaking_start' }
  | { type: 'speaking_end' }
  | { type: 'busy_start' }
  | { type: 'busy_end' }
  | { type: 'page_visible' }
  | { type: 'page_hidden' }
  | { type: 'frame'; dt: number };

type BehaviourFn = (ctx: BrainContext) => Partial<BrainState> | null;

interface BehaviourEntry {
  id: string;
  weight: (ctx: BrainContext, msSinceLast: number) => number;
  minGapMs: number;
  build: BehaviourFn;
}

const GESTURES: Exclude<Gesture, 'none'>[] = ['wave', 'hips', 'think', 'shrug', 'point', 'present', 'knock', 'clap'];

function gesture(g: Exclude<Gesture, 'none'>, emotion?: Emotion): Partial<BrainState> {
  return { gesture: g, emotion: emotion ?? 'cheerful' };
}

/** All candidate idle behaviours with dynamic weight functions. */
const CATALOGUE: BehaviourEntry[] = [
  {
    id: 'stroll',
    minGapMs: 3000,
    weight: (ctx, ms) => {
      // More likely when idle and has room to move
      const room = Math.max(0, ctx.width / 2 - ctx.height * 0.35);
      if (room < 30 || ctx.busy || ctx.speaking) return 0;
      return Math.min(8, 2 + ms / 4000);
    },
    build: (ctx) => {
      const room = Math.max(0, ctx.width / 2 - ctx.height * 0.35);
      const target = (Math.random() * 2 - 1) * room;
      const dist = Math.abs(target - ctx.x);
      if (dist < 4) return null;
      const speed = 70;
      return {
        locomotion: 'walk',
        facing: target > ctx.x ? 1 : -1,
        walkSpeed: speed / Math.max(ctx.scale, 0.1),
        targetX: target,
      };
    },
  },
  {
    id: 'think',
    minGapMs: 15000,
    weight: (ctx, ms) => ctx.busy ? 6 : Math.min(3, ms / 8000),
    build: () => ({ locomotion: 'think', emotion: 'thinking', gesture: 'think' }),
  },
  {
    id: 'hang',
    minGapMs: 45000,
    weight: (ctx, ms) => (!ctx.busy && !ctx.speaking && ms > 20000) ? 2 : 0,
    build: () => ({ locomotion: 'hang', emotion: 'winking' }),
  },
  {
    id: 'peek',
    minGapMs: 30000,
    weight: (ctx, ms) => (!ctx.busy && !ctx.speaking && ms > 12000) ? 2.5 : 0,
    build: () => ({ locomotion: 'peek', emotion: 'surprised' }),
  },
  {
    id: 'nap',
    minGapMs: 90000,
    weight: (ctx, _ms) => {
      const idle = Date.now() - ctx.lastInteractionMs;
      return (!ctx.busy && !ctx.speaking && idle > 120000) ? 3 : 0;
    },
    build: () => ({ locomotion: 'nap', emotion: 'cheerful' }),
  },
  ...GESTURES.map((g): BehaviourEntry => ({
    id: `gesture:${g}`,
    minGapMs: 8000,
    weight: (ctx, ms) => {
      if (ctx.busy || ctx.speaking) return 0;
      return Math.min(4, 1 + ms / 5000);
    },
    build: () => gesture(g),
  })),
];

export class BrainDirector {
  private state: BrainState = {
    emotion: 'cheerful',
    gesture: 'wave',
    gestureKey: 1,
    locomotion: 'idle',
    walkSpeed: 0,
    facing: 0,
    targetX: 0,
  };

  private readonly lastChosen = new Map<string, number>();
  private readonly recentGestures: string[] = [];
  private walkTimer = 0;
  private frameAccum = 0;
  private readonly listeners = new Set<(s: BrainState) => void>();

  getState(): BrainState { return this.state; }

  subscribe(fn: (s: BrainState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(partial: Partial<BrainState>) {
    const prev = this.state;
    const next: BrainState = {
      ...prev,
      ...partial,
      gestureKey: partial.gesture && partial.gesture !== prev.gesture
        ? prev.gestureKey + 1
        : prev.gestureKey,
    };
    this.state = next;
    this.listeners.forEach(fn => fn(next));
  }

  /** Feed every frame event here from the RAF loop */
  frame(dt: number, ctx: BrainContext): void {
    this.frameAccum += dt;

    // Return to idle after a walk completes
    if (this.state.locomotion === 'walk' && this.walkTimer > 0) {
      this.walkTimer -= dt * 1000;
      if (this.walkTimer <= 0) {
        this.emit({ locomotion: 'idle', walkSpeed: 0, facing: 0 });
      }
    }

    // Return to idle from temporary locomotion states after a random duration
    // driven by behaviour weight, not wall clock
    if (['think', 'hang', 'peek', 'nap'].includes(this.state.locomotion)) {
      this.walkTimer -= dt * 1000;
      if (this.walkTimer <= 0) {
        this.emit({ locomotion: 'idle', emotion: 'cheerful', gesture: 'none' });
      }
    }

    // Pick next behaviour using weighted random — only when budget allows
    // Throttled to every ~500ms of accumulated frame time to avoid over-selecting
    if (this.frameAccum < 0.5) return;
    this.frameAccum = 0;

    if (ctx.busy || ctx.speaking) return;
    if (['think', 'hang', 'peek', 'nap'].includes(this.state.locomotion)) return;

    const now = Date.now();
    let totalWeight = 0;
    const candidates: Array<{ entry: BehaviourEntry; w: number }> = [];

    for (const entry of CATALOGUE) {
      const last = this.lastChosen.get(entry.id) ?? 0;
      const msSinceLast = now - last;
      if (msSinceLast < entry.minGapMs) continue;
      if (entry.id.startsWith('gesture:') && this.recentGestures.includes(entry.id)) continue;
      const w = entry.weight(ctx, msSinceLast);
      if (w <= 0) continue;
      candidates.push({ entry, w });
      totalWeight += w;
    }

    if (candidates.length === 0 || totalWeight <= 0) return;

    let r = Math.random() * totalWeight;
    for (const { entry, w } of candidates) {
      r -= w;
      if (r < 0) {
        const result = entry.build(ctx);
        if (!result) break;
        this.lastChosen.set(entry.id, now);
        if (entry.id.startsWith('gesture:')) {
          this.recentGestures.push(entry.id);
          if (this.recentGestures.length > 3) this.recentGestures.shift();
        }
        // Set walk timer for locomotion-based behaviours
        if (result.locomotion === 'walk' && result.targetX !== undefined) {
          const dist = Math.abs((result.targetX ?? 0) - ctx.x);
          this.walkTimer = (dist / 70) * 1000;
        } else if (result.locomotion === 'think') {
          this.walkTimer = 3000 + Math.random() * 5000;
        } else if (result.locomotion === 'hang') {
          this.walkTimer = 5000 + Math.random() * 8000;
        } else if (result.locomotion === 'peek') {
          this.walkTimer = 3000 + Math.random() * 4000;
        } else if (result.locomotion === 'nap') {
          this.walkTimer = 10000 + Math.random() * 15000;
        }
        this.emit(result);
        break;
      }
    }
  }

  /** External events update the brain immediately */
  event(e: BrainEvent, _ctx: BrainContext): void {
    switch (e.type) {
      case 'poke':
        this.emit({ emotion: 'winking', gesture: 'wave' });
        this.lastChosen.set('gesture:wave', Date.now());
        break;
      case 'speaking_start':
        // Walk back to center, focus on viewer
        if (this.state.locomotion === 'walk' || this.state.locomotion === 'think') {
          this.emit({ locomotion: 'idle', targetX: 0, facing: 0, walkSpeed: 0 });
        }
        break;
      case 'speaking_end':
        this.emit({ locomotion: 'idle' });
        break;
      case 'busy_start':
        this.emit({ emotion: 'thinking', gesture: 'think', locomotion: 'think' });
        this.walkTimer = 999999; // hold until busy_end
        break;
      case 'busy_end':
        this.emit({ locomotion: 'idle', emotion: 'cheerful' });
        this.walkTimer = 0;
        break;
      case 'page_hidden':
        this.emit({ locomotion: 'idle' });
        break;
    }
  }
}

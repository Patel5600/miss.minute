/**
 * One shared animation loop for every rig on the page (dashboard stage, floating companion,
 * QA sheets). It stops while the document is hidden and drops to about 30 fps whenever every
 * subscriber reports it is only idling, which keeps the all-day desktop overlay cheap.
 */
export type TickResult = 'busy' | 'idle' | 'still';
export type TickFn = (now: number, dt: number) => TickResult;

const subscribers = new Set<TickFn>();
let rafId = 0;
let timeoutId: ReturnType<typeof setTimeout> | undefined;
let last = 0;
let listening = false;

const IDLE_FRAME_MS = 1000 / 30;
const STILL_FRAME_MS = 1000 / 8;

function schedule(delay: number): void {
  if (rafId || timeoutId !== undefined) return;
  if (delay <= 0) {
    rafId = requestAnimationFrame(run);
  } else {
    timeoutId = setTimeout(() => {
      timeoutId = undefined;
      rafId = requestAnimationFrame(run);
    }, delay);
  }
}

function run(now: number): void {
  rafId = 0;
  if (subscribers.size === 0 || document.visibilityState === 'hidden') {
    last = 0;
    return;
  }
  // Clamp long gaps (tab switches, breakpoints) so springs never explode.
  const dt = last === 0 ? 1 / 60 : Math.min(0.1, (now - last) / 1000);
  last = now;
  let busiest: TickResult = 'still';
  for (const fn of subscribers) {
    const r = fn(now, dt);
    if (r === 'busy') busiest = 'busy';
    else if (r === 'idle' && busiest === 'still') busiest = 'idle';
  }
  const spent = performance.now() - now;
  if (busiest === 'busy') schedule(0);
  else schedule(Math.max(0, (busiest === 'idle' ? IDLE_FRAME_MS : STILL_FRAME_MS) - spent - 4));
}

function onVisibility(): void {
  if (document.visibilityState === 'hidden') {
    if (rafId) cancelAnimationFrame(rafId);
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    rafId = 0;
    timeoutId = undefined;
    last = 0;
  } else if (subscribers.size > 0) {
    schedule(0);
  }
}

export function subscribeTick(fn: TickFn): () => void {
  subscribers.add(fn);
  if (!listening) {
    document.addEventListener('visibilitychange', onVisibility);
    listening = true;
  }
  schedule(0);
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0) {
      if (rafId) cancelAnimationFrame(rafId);
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      rafId = 0;
      timeoutId = undefined;
      last = 0;
      document.removeEventListener('visibilitychange', onVisibility);
      listening = false;
    }
  };
}

/** Wakes the loop immediately (e.g. a prop change while it was coasting at idle rate). */
export function wakeTicker(): void {
  if (subscribers.size === 0 || document.visibilityState === 'hidden') return;
  if (timeoutId !== undefined) {
    clearTimeout(timeoutId);
    timeoutId = undefined;
  }
  schedule(0);
}

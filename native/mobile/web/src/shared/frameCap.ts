/**
 * Spaces animation-frame callbacks at least 1000 / fps ms apart. Pure: every dependency is
 * injected, so it is tested with fake timers. The rig's shared ticker calls the global
 * requestAnimationFrame, so the overlay page installs this over the real one (installFrameCap.ts).
 */
export interface FrameCapDeps {
  raf: (cb: (time: number) => void) => number;
  caf: (handle: number) => void;
  now: () => number;
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface FrameCap {
  requestAnimationFrame(cb: (time: number) => void): number;
  cancelAnimationFrame(handle: number): void;
  setFps(fps: number): void;
  getFps(): number;
}

interface Slot {
  cb: (time: number) => void;
  timer: unknown;
  rafHandle: number;
}

/** Roughly one 60 Hz frame: the timer sleeps until this long before the callback is due. */
const LEAD_MS = 17;
/**
 * A frame can only be delivered on a display refresh, so a callback that is due within this many
 * ms is delivered now. Without it a 30 fps cap on a 60 Hz display lands on every third refresh
 * (about 20 fps) whenever the clock is a fraction of a millisecond short. Spacing is therefore at
 * least 1000 / fps - FRAME_TOLERANCE_MS.
 */
export const FRAME_TOLERANCE_MS = 2;

export function createFrameCap(deps: FrameCapDeps, initialFps = 30): FrameCap {
  let fps = initialFps;
  let lastFired = Number.NEGATIVE_INFINITY;
  let nextHandle = 1;
  const slots = new Map<number, Slot>();

  const interval = () => (fps > 0 ? 1000 / fps : Number.POSITIVE_INFINITY);

  function fire(handle: number, slot: Slot): void {
    slots.delete(handle);
    lastFired = deps.now();
    slot.cb(lastFired);
  }

  function arm(handle: number, slot: Slot): void {
    if (fps <= 0) return; // paused: held until setFps raises it
    const wait = lastFired + interval() - deps.now();
    if (wait > LEAD_MS + FRAME_TOLERANCE_MS) {
      // Sleep most of the gap with a timer, then use one real frame for the last stretch.
      slot.timer = deps.setTimeout(() => {
        slot.timer = undefined;
        arm(handle, slot);
      }, wait - LEAD_MS - FRAME_TOLERANCE_MS);
      return;
    }
    slot.rafHandle = deps.raf(() => {
      slot.rafHandle = 0;
      // The cap may have changed, or another callback may have fired, while this frame was pending.
      if (fps <= 0 || lastFired + interval() - deps.now() > FRAME_TOLERANCE_MS) arm(handle, slot);
      else fire(handle, slot);
    });
  }

  return {
    requestAnimationFrame(cb) {
      const handle = nextHandle++;
      const slot: Slot = { cb, timer: undefined, rafHandle: 0 };
      slots.set(handle, slot);
      arm(handle, slot);
      return handle;
    },
    cancelAnimationFrame(handle) {
      const slot = slots.get(handle);
      if (!slot) return;
      slots.delete(handle);
      if (slot.timer !== undefined) deps.clearTimeout(slot.timer);
      if (slot.rafHandle) deps.caf(slot.rafHandle);
    },
    setFps(next) {
      fps = Math.max(0, next);
      for (const [handle, slot] of slots) {
        if (slot.timer !== undefined) {
          deps.clearTimeout(slot.timer);
          slot.timer = undefined;
        }
        if (slot.rafHandle === 0) arm(handle, slot);
      }
    },
    getFps: () => fps,
  };
}

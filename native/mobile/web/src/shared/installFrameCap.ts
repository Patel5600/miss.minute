/**
 * Side-effect module: import it before anything that touches the rig. The rig's shared ticker
 * calls the global requestAnimationFrame at full display speed while she is busy, so this
 * replaces it with a capped version (30 fps by default; native lowers it on battery saver).
 */
import { createFrameCap } from './frameCap.ts';

const realRaf = window.requestAnimationFrame.bind(window);
const realCaf = window.cancelAnimationFrame.bind(window);

const cap = createFrameCap(
  {
    raf: realRaf,
    caf: realCaf,
    now: () => performance.now(),
    setTimeout: (cb, ms) => window.setTimeout(cb, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
  },
  30,
);

window.requestAnimationFrame = (cb) => cap.requestAnimationFrame(cb);
window.cancelAnimationFrame = (handle) => cap.cancelAnimationFrame(handle);

export function setFrameCap(fps: number): void {
  cap.setFps(fps);
}

export function getFrameCap(): number {
  return cap.getFps();
}

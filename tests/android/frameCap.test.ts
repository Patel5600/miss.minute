import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFrameCap, FRAME_TOLERANCE_MS } from '../../native/mobile/web/src/shared/frameCap.ts';

/** A 60 Hz display and a millisecond clock, driven by hand. */
function makeEnv() {
  let t = 1000;
  let nextId = 1;
  const timers = new Map<number, { at: number; cb: () => void }>();
  const rafs = new Map<number, () => void>();
  const deps = {
    raf: (cb: (time: number) => void) => { const id = nextId++; rafs.set(id, () => cb(t)); return id; },
    caf: (id: number) => { rafs.delete(id); },
    now: () => t,
    setTimeout: (cb: () => void, ms: number) => { const id = nextId++; timers.set(id, { at: t + ms, cb }); return id; },
    clearTimeout: (id: unknown) => { timers.delete(id as number); },
  };
  /** Runs `ms` milliseconds in 1 ms steps; a 60 Hz refresh (every 16.67 ms) delivers the queued frames. */
  let vsync = t + 16.6667;
  function run(ms: number) {
    for (let i = 0; i < ms; i += 1) {
      t += 1;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= t) { timers.delete(id); timer.cb(); }
      }
      if (t >= vsync) {
        vsync += 16.6667;
        const due = [...rafs];
        rafs.clear();
        for (const [, cb] of due) cb();
      }
    }
  }
  return { deps, run, pending: () => timers.size + rafs.size };
}

function loop(cap: ReturnType<typeof createFrameCap>, times: number[], now: () => number) {
  const tick = () => { times.push(now()); cap.requestAnimationFrame(tick); };
  cap.requestAnimationFrame(tick);
}

test('callbacks are spaced about 1000/30 ms apart, never faster than the cap allows', () => {
  const env = makeEnv();
  const cap = createFrameCap(env.deps, 30);
  const times: number[] = [];
  loop(cap, times, env.deps.now);
  env.run(2000);
  assert.ok(times.length >= 56 && times.length <= 62, `fired ${times.length} times in 2 s`);
  for (let i = 1; i < times.length; i += 1) assert.ok(times[i]! - times[i - 1]! >= 1000 / 30 - FRAME_TOLERANCE_MS - 1e-9);
});

test('cancel stops a pending callback and clears its timers', () => {
  const env = makeEnv();
  const cap = createFrameCap(env.deps, 30);
  let fired = 0;
  cap.requestAnimationFrame(() => { fired += 1; });
  env.run(100);
  assert.equal(fired, 1);
  const handle = cap.requestAnimationFrame(() => { fired += 1; });
  cap.cancelAnimationFrame(handle);
  env.run(200);
  assert.equal(fired, 1);
  assert.equal(env.pending(), 0);
});

test('lowering the fps spaces callbacks further apart; 0 pauses; raising resumes', () => {
  const env = makeEnv();
  const cap = createFrameCap(env.deps, 30);
  const times: number[] = [];
  loop(cap, times, env.deps.now);
  env.run(500);
  cap.setFps(15);
  const mark = times.length;
  env.run(1000);
  const slow = times.slice(mark);
  assert.ok(slow.length >= 14 && slow.length <= 16, `15 fps fired ${slow.length} times in 1 s`);
  for (let i = 1; i < slow.length; i += 1) assert.ok(slow[i]! - slow[i - 1]! >= 1000 / 15 - FRAME_TOLERANCE_MS - 1e-9);
  cap.setFps(0);
  env.run(100);
  const paused = times.length;
  env.run(1000);
  assert.equal(times.length, paused);
  cap.setFps(30);
  env.run(500);
  assert.ok(times.length > paused + 10);
  assert.equal(cap.getFps(), 30);
});
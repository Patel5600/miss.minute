import assert from 'node:assert/strict';
import test from 'node:test';

import { VoiceService } from '../../src/services/voiceService.ts';

type Handler = (event: { payload: any }) => void;

class FakeEvents {
  listenCalls = 0;
  private pending: Array<{ name: string; handler: Handler; resolve: (stop: () => void) => void }> = [];
  private listeners = new Map<string, Set<Handler>>();

  listen<T>(name: string, handler: (event: { payload: T }) => void): Promise<() => void> {
    this.listenCalls += 1;
    return new Promise(resolve => this.pending.push({ name, handler: handler as Handler, resolve }));
  }

  async resolveAll(): Promise<void> {
    for (const item of this.pending.splice(0)) {
      const set = this.listeners.get(item.name) ?? new Set<Handler>();
      set.add(item.handler);
      this.listeners.set(item.name, set);
      item.resolve(() => set.delete(item.handler));
    }
    await Promise.resolve();
  }

  emit(name: string, payload: unknown): void {
    for (const handler of this.listeners.get(name) ?? []) handler({ payload });
  }

  get listenerCount(): number {
    return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0);
  }
}

class FakeAudioContext {
  static created = 0;
  static starts = 0;
  currentTime = 0;
  state = 'running';
  destination = {};

  constructor() { FakeAudioContext.created += 1; }
  createAnalyser() {
    return {
      fftSize: 0,
      smoothingTimeConstant: 0,
      connect() {},
      getByteTimeDomainData(samples: Uint8Array) { samples.fill(128); },
    };
  }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    return { duration: length / sampleRate, sampleRate, copyToChannel() {} };
  }
  createBufferSource() {
    const source: any = {
      buffer: null,
      onended: null,
      connect() {},
      start() {
        FakeAudioContext.starts += 1;
        queueMicrotask(() => source.onended?.());
      },
    };
    return source;
  }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
}

function fakeWindow(events: FakeEvents): any {
  const domListeners = new Map<string, Set<Function>>();
  return {
    __TAURI__: { event: events },
    addEventListener(name: string, listener: Function) {
      const set = domListeners.get(name) ?? new Set<Function>();
      set.add(listener);
      domListeners.set(name, set);
    },
    removeEventListener(name: string, listener: Function) { domListeners.get(name)?.delete(listener); },
  };
}

function installBrowser(windowValue: any): void {
  Object.defineProperty(globalThis, 'window', { value: windowValue, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'AudioContext', { value: FakeAudioContext, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    value: () => 1,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    value: () => undefined,
    configurable: true,
    writable: true,
  });
}

function pcm(): string {
  return Buffer.from(new Int16Array([1000, -1000, 2000, -2000]).buffer).toString('base64');
}

function chunk(id: string, index: number, owner: 'main' | 'avatar' = 'main') {
  return {
    id,
    index,
    last: false,
    text: 'metadata only',
    sampleRate: 24000,
    pcm16: pcm(),
    playbackOwner: owner,
  };
}

function end(id: string, owner: 'main' | 'avatar' = 'main') {
  return { id, event: 'done', message: null, playbackOwner: owner };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test('attach is shared, late listener resolution is safe, and sequences play exactly once', async () => {
  FakeAudioContext.created = 0;
  FakeAudioContext.starts = 0;
  const events = new FakeEvents();
  const host = fakeWindow(events);
  installBrowser(host);
  const service = new VoiceService();

  const detachFirst = service.attachNativeVoice('main');
  const detachSecond = service.attachNativeVoice('main');
  assert.equal(events.listenCalls, 3, 'two attaches share chunk, end, and metadata listeners');
  detachFirst();
  await events.resolveAll();
  assert.equal(events.listenerCount, 3, 'one reference keeps the late-resolving listeners alive');

  events.emit('miss-minutes:voice-chunk', chunk('ordered', 0));
  events.emit('miss-minutes:voice-chunk', chunk('ordered', 0)); // duplicate
  events.emit('miss-minutes:voice-chunk', chunk('ordered', 2)); // out of order
  events.emit('miss-minutes:voice-chunk', chunk('ordered', 1)); // same PCM is valid at a new index
  events.emit('miss-minutes:voice-end', end('ordered'));
  await settle();
  assert.equal(FakeAudioContext.created, 1);
  assert.equal(FakeAudioContext.starts, 2, 'only sequence 0 and 1 were scheduled');

  detachSecond();
  await settle();
  assert.equal(events.listenerCount, 0, 'final detach removes every resolved listener');
  events.emit('miss-minutes:voice-chunk', chunk('after-detach', 0));
  assert.equal(FakeAudioContext.starts, 2, 'detached listeners cannot replay audio');
});

test('only the selected logical window plays while both observe audio-free activity', async () => {
  FakeAudioContext.created = 0;
  FakeAudioContext.starts = 0;
  const events = new FakeEvents();
  const mainWindow = fakeWindow(events);
  installBrowser(mainWindow);
  const main = new VoiceService();
  let mainActivity = 0;
  main.onNativeActivity(() => { mainActivity += 1; });
  const detachMain = main.attachNativeVoice('main');

  const avatarWindow = fakeWindow(events);
  installBrowser(avatarWindow);
  const avatar = new VoiceService();
  let avatarActivity = 0;
  avatar.onNativeActivity(() => { avatarActivity += 1; });
  const detachAvatar = avatar.attachNativeVoice('avatar');
  await events.resolveAll();

  const activity = { id: 'routed', event: 'chunk', playbackOwner: 'main', index: 0, text: 'metadata only', mouth: 2 };
  events.emit('miss-minutes:voice-activity', activity);
  events.emit('miss-minutes:voice-chunk', chunk('routed', 0, 'main'));
  events.emit('miss-minutes:voice-end', end('routed', 'main'));
  await settle();

  assert.equal(mainActivity, 1);
  assert.equal(avatarActivity, 1, 'the non-owner still observes lifecycle/viseme/subtitle metadata');
  assert.equal(FakeAudioContext.created, 1, 'only the named owner created an output context');
  assert.equal(FakeAudioContext.starts, 1, 'only the named owner scheduled audio');
  detachMain();
  detachAvatar();
});

test('replacement and stop reject every stale chunk', async () => {
  FakeAudioContext.created = 0;
  FakeAudioContext.starts = 0;
  const events = new FakeEvents();
  installBrowser(fakeWindow(events));
  const service = new VoiceService();
  const detach = service.attachNativeVoice('main');
  await events.resolveAll();

  events.emit('miss-minutes:voice-chunk', chunk('old', 0));
  events.emit('miss-minutes:voice-chunk', chunk('new', 0));
  events.emit('miss-minutes:voice-chunk', chunk('old', 1));
  assert.equal(FakeAudioContext.starts, 2, 'late audio from the replaced id is closed');

  service.stop();
  events.emit('miss-minutes:voice-chunk', chunk('new', 1));
  assert.equal(FakeAudioContext.starts, 2, 'stop closes the current id before in-flight chunks arrive');
  detach();
});

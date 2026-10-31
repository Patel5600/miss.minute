/**
 * Gapless playback of streamed 16-bit PCM through Web Audio, with mouth shapes measured from
 * the audio that is actually playing. Cloud speech, the desktop's local voice and Gemini Live
 * all play through this, so they share one lip-sync path and one way to stop.
 *
 * Audio arrives in segments (one per sentence or model turn). Segments play strictly in the
 * order they were opened; a segment's bytes may arrive while earlier ones are still playing
 * and are scheduled the moment the timeline reaches them.
 */
import type { MouthFrame } from '../../types';

/** Maps loudness to one of the five mouth shapes. Shared by every audio engine. */
export function mouthFrameForRms(rms: number): MouthFrame {
  return rms < 0.014 ? 0 : rms < 0.045 ? 1 : rms < 0.095 ? 2 : rms < 0.17 ? 3 : 4;
}

/** Small first-buffer lead so the start is never clipped. */
const LEAD_SECONDS = 0.03;
/** Coalesce tiny network chunks into buffers of at least this long (unless the timeline runs dry). */
const MIN_BUFFER_SECONDS = 0.06;
const FADE_SECONDS = 0.02;

let sharedContext: AudioContext | null = null;
let gestureHooked = false;

/**
 * One AudioContext for all speech output. Browsers keep a context suspended until the page has
 * seen a user gesture, so the first pointer or key press resumes it.
 */
export function speechAudioContext(): AudioContext | null {
  if (typeof window === 'undefined' || typeof AudioContext === 'undefined') return null;
  if (!sharedContext || sharedContext.state === 'closed') {
    sharedContext = new AudioContext({ latencyHint: 'interactive' });
  }
  if (!gestureHooked) {
    gestureHooked = true;
    const resume = () => {
      if (sharedContext?.state === 'suspended') void sharedContext.resume().catch(() => undefined);
    };
    window.addEventListener('pointerdown', resume, { capture: true, passive: true });
    window.addEventListener('keydown', resume, { capture: true });
  }
  if (sharedContext.state === 'suspended') void sharedContext.resume().catch(() => undefined);
  return sharedContext;
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function rmsOf(samples: Float32Array): number {
  let energy = 0;
  for (let i = 0; i < samples.length; i += 1) energy += samples[i] * samples[i];
  return Math.sqrt(energy / Math.max(1, samples.length));
}

export class PcmSegment {
  /** Resolves when the first buffer of this segment is scheduled to play. */
  readonly started: Promise<void>;
  /** Resolves when everything in this segment has played, or it was cancelled or flushed. */
  readonly played: Promise<void>;
  /** Seconds of audio received so far. */
  receivedSeconds = 0;
  /** @internal */ pending: Array<{ samples: Float32Array; rate: number }> = [];
  /** @internal */ pendingSeconds = 0;
  /** @internal */ ended = false;
  /** @internal */ cancelled = false;
  /** @internal */ dequeued = false;
  /** @internal */ playing = 0;
  private carry: number | null = null;
  private resolveStarted!: () => void;
  private resolvePlayed!: () => void;
  private finished = false;
  private hasStarted = false;
  private readonly player: PcmPlayer;

  constructor(player: PcmPlayer) {
    this.player = player;
    this.started = new Promise(resolve => { this.resolveStarted = resolve; });
    this.played = new Promise(resolve => { this.resolvePlayed = resolve; });
  }

  /** Little-endian 16-bit mono PCM. Odd byte counts are carried into the next push. */
  pushPcm16(bytes: Uint8Array, sampleRate: number): void {
    if (this.cancelled || this.ended || bytes.length === 0) return;
    let data = bytes;
    if (this.carry !== null) {
      data = new Uint8Array(bytes.length + 1);
      data[0] = this.carry;
      data.set(bytes, 1);
      this.carry = null;
    }
    const count = data.length >> 1;
    if (data.length & 1) this.carry = data[data.length - 1];
    if (count === 0) return;
    const view = new DataView(data.buffer, data.byteOffset, count * 2);
    const samples = new Float32Array(count);
    for (let i = 0; i < count; i += 1) samples[i] = view.getInt16(i * 2, true) / 32768;
    this.pushFloat(samples, sampleRate);
  }

  pushFloat(samples: Float32Array, sampleRate: number): void {
    if (this.cancelled || this.ended || samples.length === 0) return;
    this.pending.push({ samples, rate: sampleRate });
    this.pendingSeconds += samples.length / sampleRate;
    this.receivedSeconds += samples.length / sampleRate;
    this.player.pump();
  }

  /** No more audio will arrive for this segment. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.carry = null;
    this.player.pump();
    this.settle();
  }

  /** Drops this segment's audio, including anything already playing. */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.pending = [];
    this.pendingSeconds = 0;
    this.player.drop(this);
    this.finish();
  }

  /** @internal */ markStarted(): void {
    if (this.hasStarted) return;
    this.hasStarted = true;
    this.resolveStarted();
  }

  /** @internal */ settle(): void {
    if (this.ended && this.dequeued && this.pending.length === 0 && this.playing === 0) this.finish();
  }

  /** @internal */ finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.resolveStarted();
    this.resolvePlayed();
  }
}

export interface PcmPlayerHooks {
  /** Mouth shape of the audio playing right now; 0 when silent. */
  onMouth(frame: MouthFrame): void;
}

export class PcmPlayer {
  private queue: PcmSegment[] = [];
  private live = new Set<PcmSegment>();
  private sources = new Map<AudioBufferSourceNode, PcmSegment>();
  private gain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private nextStart = 0;
  private mouthLoop = 0;
  private lastMouth: MouthFrame = 0;
  private samples: Float32Array<ArrayBuffer> | null = null;
  private readonly hooks: PcmPlayerHooks;

  constructor(hooks: PcmPlayerHooks) {
    this.hooks = hooks;
  }

  /** True while any audio is scheduled or playing. */
  get busy(): boolean {
    return this.sources.size > 0;
  }

  /** Seconds of audio scheduled ahead of the playhead. */
  get bufferedSeconds(): number {
    const context = sharedContext;
    return context ? Math.max(0, this.nextStart - context.currentTime) : 0;
  }

  segment(): PcmSegment {
    const segment = new PcmSegment(this);
    this.queue.push(segment);
    this.live.add(segment);
    return segment;
  }

  /** Stops all audio now and cancels every open segment. */
  flush(): void {
    const context = sharedContext;
    const gain = this.gain;
    this.gain = null;
    if (context && gain) {
      // A short fade avoids a click when speech is cut mid-word.
      const now = context.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(0, now + FADE_SECONDS);
      setTimeout(() => gain.disconnect(), (FADE_SECONDS + 0.05) * 1000);
    }
    for (const source of this.sources.keys()) {
      source.onended = null;
      try {
        source.stop(context ? context.currentTime + FADE_SECONDS : 0);
      } catch {
        // already stopped
      }
    }
    this.sources.clear();
    const segments = [...this.live];
    this.queue = [];
    this.live.clear();
    segments.forEach(segment => {
      segment.cancelled = true;
      segment.finish();
    });
    this.nextStart = 0;
    this.stopMouth();
  }

  /** @internal Moves audio onto the timeline in segment order. */
  pump(): void {
    while (this.queue.length > 0) {
      const head = this.queue[0];
      if (head.cancelled) {
        this.queue.shift();
        continue;
      }
      if (head.pending.length > 0) {
        const lowWater = this.bufferedSeconds < 0.12;
        if (head.ended || lowWater || head.pendingSeconds >= MIN_BUFFER_SECONDS) this.scheduleNow(head);
      }
      if (head.ended && head.pending.length === 0) {
        this.queue.shift();
        head.dequeued = true;
        head.settle();
        continue;
      }
      return;
    }
  }

  /** @internal */ drop(segment: PcmSegment): void {
    this.queue = this.queue.filter(item => item !== segment);
    this.live.delete(segment);
    for (const [source, owner] of this.sources) {
      if (owner !== segment) continue;
      source.onended = null;
      try {
        source.stop();
      } catch {
        // already stopped
      }
      this.sources.delete(source);
    }
    if (this.sources.size === 0) this.stopMouth();
    this.pump();
  }

  /** @internal Schedules every pending chunk of `segment`, one buffer per run of equal rates. */
  scheduleNow(segment: PcmSegment): void {
    const context = speechAudioContext();
    if (!context || segment.pending.length === 0) return;
    const pending = segment.pending;
    segment.pending = [];
    segment.pendingSeconds = 0;
    let runStart = 0;
    for (let i = 1; i <= pending.length; i += 1) {
      if (i < pending.length && pending[i].rate === pending[runStart].rate) continue;
      const run = pending.slice(runStart, i);
      const total = run.reduce((sum, part) => sum + part.samples.length, 0);
      const merged = new Float32Array(total);
      let offset = 0;
      for (const part of run) {
        merged.set(part.samples, offset);
        offset += part.samples.length;
      }
      this.scheduleBuffer(context, segment, merged, pending[runStart].rate);
      runStart = i;
    }
  }

  private scheduleBuffer(context: AudioContext, segment: PcmSegment, samples: Float32Array<ArrayBuffer>, rate: number): void {
    const buffer = context.createBuffer(1, samples.length, rate);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.output(context));
    const startAt = Math.max(context.currentTime + LEAD_SECONDS, this.nextStart);
    source.start(startAt);
    this.nextStart = startAt + buffer.duration;
    this.sources.set(source, segment);
    segment.playing += 1;
    segment.markStarted();
    source.onended = () => {
      source.disconnect();
      this.sources.delete(source);
      segment.playing -= 1;
      segment.settle();
      if (this.sources.size === 0) this.stopMouth();
    };
    this.startMouth();
  }

  private output(context: AudioContext): AudioNode {
    if (!this.analyser) {
      this.analyser = context.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.6;
      this.analyser.connect(context.destination);
    }
    if (!this.gain) {
      this.gain = context.createGain();
      this.gain.connect(this.analyser);
    }
    return this.gain;
  }

  private startMouth(): void {
    if (this.mouthLoop || !this.analyser || typeof requestAnimationFrame === 'undefined') return;
    const analyser = this.analyser;
    this.samples ??= new Float32Array(analyser.fftSize);
    const tick = () => {
      if (!this.samples) return;
      analyser.getFloatTimeDomainData(this.samples);
      this.setMouth(mouthFrameForRms(rmsOf(this.samples)));
      this.mouthLoop = requestAnimationFrame(tick);
    };
    this.mouthLoop = requestAnimationFrame(tick);
  }

  private stopMouth(): void {
    if (this.mouthLoop) cancelAnimationFrame(this.mouthLoop);
    this.mouthLoop = 0;
    this.setMouth(0);
  }

  private setMouth(frame: MouthFrame): void {
    if (frame === this.lastMouth) return;
    this.lastMouth = frame;
    this.hooks.onMouth(frame);
  }
}

/**
 * Mouth shapes for audio that plays somewhere else (a WebRTC call's remote stream). The stream
 * must also be attached to a playing media element; Chromium delivers silence to Web Audio for
 * remote WebRTC tracks otherwise. Returns a stop function.
 */
export function watchStreamMouth(stream: MediaStream, onMouth: (frame: MouthFrame) => void): () => void {
  const context = speechAudioContext();
  if (!context || stream.getAudioTracks().length === 0) return () => undefined;
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.6;
  source.connect(analyser); // analysis only: the media element does the playing
  const samples = new Float32Array(analyser.fftSize);
  let last: MouthFrame = 0;
  let loop = 0;
  const tick = () => {
    analyser.getFloatTimeDomainData(samples);
    const frame = mouthFrameForRms(rmsOf(samples));
    if (frame !== last) {
      last = frame;
      onMouth(frame);
    }
    loop = requestAnimationFrame(tick);
  };
  loop = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(loop);
    source.disconnect();
    analyser.disconnect();
    if (last !== 0) onMouth(0);
  };
}

/**
 * AudioWorklet processor: microphone audio in, 16-bit mono PCM frames out.
 *
 * Runs on the audio thread. Mixes to mono, resamples to the target rate (16 kHz for Whisper and
 * Gemini Live) with an anti-alias low-pass so consonants survive downsampling, and posts one
 * frame per `frameSize` output samples together with its RMS level for silence detection.
 * Loaded through Vite's `?worker&url` so it is served from this origin (the desktop CSP only
 * allows same-origin scripts).
 */

// AudioWorkletGlobalScope members; the DOM lib that this project compiles against omits them.
declare const sampleRate: number;
declare function registerProcessor(name: string, processor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

interface CaptureOptions {
  targetRate?: number;
  frameSize?: number;
}

/** Second-order Butterworth low-pass section (RBJ cookbook coefficients). */
class Biquad {
  private b0: number;
  private b1: number;
  private b2: number;
  private a1: number;
  private a2: number;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(cutoff: number, rate: number) {
    const w0 = (2 * Math.PI * cutoff) / rate;
    const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
    const cos = Math.cos(w0);
    const a0 = 1 + alpha;
    this.b0 = (1 - cos) / 2 / a0;
    this.b1 = (1 - cos) / a0;
    this.b2 = (1 - cos) / 2 / a0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  step(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

class PcmCaptureProcessor extends AudioWorkletProcessor {
  private readonly step: number;
  private readonly filters: Biquad[];
  private readonly frameSize: number;
  private frame: Int16Array<ArrayBuffer>;
  private filled = 0;
  private energy = 0;
  /** Fractional read position between `previous` and the current input sample. */
  private position = 0;
  private previous = 0;

  constructor(options?: { processorOptions?: CaptureOptions }) {
    super(options);
    const targetRate = options?.processorOptions?.targetRate ?? 16000;
    this.frameSize = options?.processorOptions?.frameSize ?? 320;
    this.step = sampleRate / targetRate;
    // Two cascaded sections give a 4th-order roll-off below the new Nyquist frequency.
    this.filters = this.step > 1
      ? [new Biquad(targetRate * 0.45, sampleRate), new Biquad(targetRate * 0.45, sampleRate)]
      : [];
    this.frame = new Int16Array(this.frameSize);
  }

  process(inputs: Float32Array[][]): boolean {
    const channels = inputs[0];
    if (!channels || channels.length === 0 || channels[0].length === 0) return true;
    const length = channels[0].length;
    for (let i = 0; i < length; i += 1) {
      let sample = 0;
      for (let c = 0; c < channels.length; c += 1) sample += channels[c][i];
      sample /= channels.length;
      for (const filter of this.filters) sample = filter.step(sample);

      if (this.step === 1) {
        this.emit(sample);
        continue;
      }
      // Linear interpolation between the previous and current (filtered) input samples.
      while (this.position <= 1) {
        this.emit(this.previous + (sample - this.previous) * this.position);
        this.position += this.step;
      }
      this.position -= 1;
      this.previous = sample;
    }
    return true;
  }

  private emit(value: number): void {
    const clamped = Math.max(-1, Math.min(1, value));
    this.frame[this.filled] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    this.energy += clamped * clamped;
    this.filled += 1;
    if (this.filled === this.frameSize) {
      const rms = Math.sqrt(this.energy / this.frameSize);
      this.port.postMessage({ pcm: this.frame.buffer, rms }, [this.frame.buffer]);
      this.frame = new Int16Array(this.frameSize);
      this.filled = 0;
      this.energy = 0;
    }
  }
}

registerProcessor('mm-pcm-capture', PcmCaptureProcessor);

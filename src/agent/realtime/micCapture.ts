/**
 * Microphone capture as 16 kHz mono PCM16, for desktop voice input (WebView2 has no working
 * Web Speech recognition) and for Gemini Live calls.
 *
 * The microphone opens only when one of these functions is called, which callers do from an
 * explicit click, and every track is stopped when the capture stops.
 */
import workletUrl from './pcmCapture.worklet.ts?worker&url';

export const CAPTURE_RATE = 16000;
/** 20 ms frames: fine-grained enough for silence detection, cheap to post across threads. */
const FRAME_SAMPLES = 320;
const FRAME_MS = (FRAME_SAMPLES / CAPTURE_RATE) * 1000;

export interface MicFrame {
  pcm: Int16Array;
  rms: number;
}

export interface MicCapture {
  /** Stops capturing and releases the microphone. Safe to call more than once. */
  stop(): void;
}

export class MicrophoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MicrophoneError';
  }
}

function microphoneError(error: unknown): MicrophoneError {
  if (error instanceof MicrophoneError) return error;
  if (error instanceof DOMException) {
    switch (error.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return new MicrophoneError('Microphone access was denied. Allow it for Miss Minutes and try again.');
      case 'NotFoundError':
      case 'OverconstrainedError':
        return new MicrophoneError('No microphone was found.');
      case 'NotReadableError':
      case 'AbortError':
        return new MicrophoneError('The microphone is in use by another app or could not be started.');
      default:
        return new MicrophoneError(error.message || error.name);
    }
  }
  return new MicrophoneError(error instanceof Error ? error.message : String(error));
}

export function microphoneSupported(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function'
    && typeof AudioWorkletNode !== 'undefined';
}

/**
 * Runs `source` through the capture worklet and returns a detach function. The caller owns the
 * context and the source; QA pages use this with decoded files instead of a microphone.
 */
export async function attachPcmCapture(
  context: BaseAudioContext,
  source: AudioNode,
  onFrame: (frame: MicFrame) => void,
): Promise<() => void> {
  await context.audioWorklet.addModule(workletUrl);
  const node = new AudioWorkletNode(context, 'mm-pcm-capture', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { targetRate: CAPTURE_RATE, frameSize: FRAME_SAMPLES },
  });
  node.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
    onFrame({ pcm: new Int16Array(event.data.pcm), rms: event.data.rms });
  };
  source.connect(node);
  // The processor writes nothing to its output; the connection only keeps the graph pulling it.
  node.connect(context.destination);
  return () => {
    node.port.onmessage = null;
    try {
      source.disconnect(node);
    } catch {
      // already disconnected
    }
    node.disconnect();
  };
}

/** Opens the microphone and streams 16 kHz PCM16 frames until stop(). */
export async function openMicrophone(onFrame: (frame: MicFrame) => void, onLost?: (reason: string) => void): Promise<MicCapture> {
  if (!microphoneSupported()) throw new MicrophoneError('This browser cannot record from a microphone.');
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (error) {
    throw microphoneError(error);
  }

  let context: AudioContext | null = null;
  let detach: (() => void) | null = null;
  let stopped = false;
  const release = () => {
    if (stopped) return;
    stopped = true;
    detach?.();
    stream.getTracks().forEach(track => track.stop());
    void context?.close().catch(() => undefined);
  };

  try {
    let source: MediaStreamAudioSourceNode;
    try {
      // A 16 kHz context lets the browser's own high-quality resampler do the work.
      context = new AudioContext({ sampleRate: CAPTURE_RATE, latencyHint: 'interactive' });
      source = context.createMediaStreamSource(stream);
    } catch {
      // Some engines refuse to mix a 48 kHz device into a 16 kHz graph; the worklet resamples.
      void context?.close().catch(() => undefined);
      context = new AudioContext({ latencyHint: 'interactive' });
      source = context.createMediaStreamSource(stream);
    }
    await context.resume().catch(() => undefined);
    detach = await attachPcmCapture(context, source, frame => { if (!stopped) onFrame(frame); });
  } catch (error) {
    release();
    throw microphoneError(error);
  }

  stream.getAudioTracks().forEach(track => {
    track.addEventListener('ended', () => {
      if (stopped) return;
      release();
      onLost?.('The microphone was disconnected.');
    }, { once: true });
  });
  return { stop: release };
}

export type RecordingEnd = 'manual' | 'silence' | 'limit' | 'no-speech' | 'lost';

export interface Recording {
  /** Mono PCM16 at CAPTURE_RATE, with long leading and trailing silence trimmed. */
  pcm: Int16Array;
  /** True when speech-level audio was detected. */
  speech: boolean;
  reason: RecordingEnd;
  seconds: number;
}

export interface RecordOptions {
  /** Stop this long after speech ends. */
  silenceMs?: number;
  /** Give up when nothing louder than the room is heard for this long. */
  noSpeechMs?: number;
  maxSeconds?: number;
  onLevel?(rms: number): void;
}

export interface RecordingSession {
  /** Ends the recording now (a second click); the result still resolves with what was heard. */
  stop(): void;
  readonly result: Promise<Recording>;
}

const KEEP_SILENCE_MS = 300;

/**
 * Records one utterance: opens the microphone, ends on a pause after speech, on stop(), or at
 * the length limit, and always releases the microphone before resolving.
 */
export function recordUtterance(options: RecordOptions = {}): RecordingSession {
  const silenceFrames = Math.round((options.silenceMs ?? 1100) / FRAME_MS);
  const noSpeechFrames = Math.round((options.noSpeechMs ?? 7000) / FRAME_MS);
  const maxFrames = Math.round(((options.maxSeconds ?? 45) * 1000) / FRAME_MS);
  const keepFrames = Math.round(KEEP_SILENCE_MS / FRAME_MS);

  const frames: Int16Array[] = [];
  const voiced: boolean[] = [];
  let capture: MicCapture | null = null;
  let ended: RecordingEnd | null = null;
  let floor = -1;
  let speechRun = 0;
  let silenceRun = 0;
  let speaking = false;
  let heardSpeech = false;
  let resolveResult!: (recording: Recording) => void;
  let rejectResult!: (error: unknown) => void;
  const result = new Promise<Recording>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const finish = (reason: RecordingEnd) => {
    if (ended) return;
    ended = reason;
    capture?.stop();
    capture = null;
    let first = 0;
    let last = frames.length - 1;
    if (heardSpeech) {
      first = Math.max(0, voiced.indexOf(true) - keepFrames);
      last = Math.min(frames.length - 1, voiced.lastIndexOf(true) + keepFrames);
    }
    const kept = frames.slice(first, last + 1);
    const pcm = new Int16Array(kept.reduce((sum, frame) => sum + frame.length, 0));
    let offset = 0;
    for (const frame of kept) {
      pcm.set(frame, offset);
      offset += frame.length;
    }
    resolveResult({ pcm, speech: heardSpeech, reason, seconds: pcm.length / CAPTURE_RATE });
  };

  const onFrame = ({ pcm, rms }: MicFrame) => {
    if (ended) return;
    frames.push(pcm);
    options.onLevel?.(rms);
    // Noise floor: a quick estimate from the first frames, then a slow drift while not speaking.
    if (floor < 0) floor = rms;
    else if (!speaking && rms < floor * 2) floor = floor * 0.95 + rms * 0.05;
    const threshold = Math.max(0.012, floor * 3.2);
    const loud = rms > threshold;
    voiced.push(loud);

    if (loud) {
      speechRun += 1;
      silenceRun = 0;
      if (speechRun >= 4) { // 80 ms of speech-level audio, not a click
        speaking = true;
        heardSpeech = true;
      }
    } else {
      speechRun = 0;
      if (speaking && rms < threshold * 0.8) silenceRun += 1;
    }

    if (heardSpeech && silenceRun >= silenceFrames) finish('silence');
    else if (!heardSpeech && frames.length >= noSpeechFrames) finish('no-speech');
    else if (frames.length >= maxFrames) finish('limit');
  };

  openMicrophone(onFrame, () => finish('lost')).then(
    opened => {
      if (ended) opened.stop(); // stopped before the microphone finished opening
      else capture = opened;
    },
    error => {
      ended = 'lost';
      rejectResult(error);
    },
  );

  return {
    stop: () => finish('manual'),
    result,
  };
}

/** Base64 of little-endian PCM16, in slices so large recordings do not overflow the call stack. */
export function pcm16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

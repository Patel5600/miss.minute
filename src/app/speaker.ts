/**
 * Speaker: one place that turns Miss Minutes' words into sound and mouth movement.
 *
 * Engines (settings.voiceEngine):
 *   local                her cloned voice, rendered on this PC by the voice worker (desktop only);
 *                        audio arrives as host events. A reply is sent sentence by sentence into
 *                        one streamed utterance, so she starts talking while the model still writes.
 *   openai / elevenlabs  streamed cloud speech (PCM) through PcmPlayer, lip sync from the audio
 *   system               the browser / OS voice
 * When the wanted engine cannot speak (not installed, still loading, no key, a failed request)
 * the system voice speaks instead, and `activeVoice()` says so and why. Nothing is presented as
 * her cloned voice unless the worker reports that it is speaking in it.
 *
 * On the desktop her cloned voice becomes the default as soon as it is prepared on this PC, unless
 * the owner has picked an engine themselves (settings.voiceEngineChosen).
 */
import { useEffect, useState } from 'react';
import type { AISettings, MouthFrame, VoiceEngine } from '../types';
import { voiceService } from '../services/voiceService';
import { PcmPlayer } from '../agent/realtime/pcmPlayer';
import { CLOUD_SAMPLE_RATE, HOSTESS_VOICE_INSTRUCTIONS, streamCloudSpeech } from '../agent/realtime/cloudTts';
import { SpeakableStream, speakableText } from '../agent/realtime/speechText';
import { getWebSecret } from '../agent/secrets-web';
import { loadSettings, onSettingsChange, saveSettings } from '../agent/settings';
import {
  invokeNative,
  isClonedVoice,
  isDesktopRuntime,
  listenNative,
  type NativeVoiceActivity,
  type NativeVoiceStatus,
} from '../desktop/bridge';

export interface SpeakerState {
  speaking: boolean;
  mouth: MouthFrame;
  /** Sentence being spoken right now (for subtitles). */
  line: string;
}

export interface Utterance {
  push(delta: string): void;
  end(): void;
  cancel(): void;
}

type Engine = 'system' | 'openai' | 'elevenlabs' | 'local';

/** Which voice speaks right now, in words the owner can check. */
export interface ActiveVoice {
  /** The engine the settings ask for. */
  wanted: VoiceEngine;
  /** The engine that actually speaks. */
  engine: Engine;
  /** True only while the worker speaks in the voice cloned from the prepared reference. */
  cloned: boolean;
  /** e.g. "Her cloned voice (Pocket TTS, on this PC)" or "System voice". */
  label: string;
  /** Why `engine` differs from `wanted`, or why the local engine is not using her cloned voice. */
  reason: string | null;
}

const ENGINE_NAMES: Record<Engine, string> = {
  system: 'System voice',
  openai: 'OpenAI voice',
  elevenlabs: 'ElevenLabs voice',
  local: 'Her cloned voice',
};

const instructions = Array.isArray(HOSTESS_VOICE_INSTRUCTIONS)
  ? (HOSTESS_VOICE_INSTRUCTIONS as readonly string[]).join(' ')
  : String(HOSTESS_VOICE_INSTRUCTIONS);

const FAILURE_HOLD_MS = 30_000;

/**
 * The dashboard window. main.tsx loads this module in the overlay window as well, where the voice
 * commands are not permitted and the overlay plays its own audio, so only the dashboard watches
 * the voice engine.
 */
function isDashboardWindow(): boolean {
  return isDesktopRuntime() && new URLSearchParams(window.location.search).get('overlay') !== '1';
}

function newUtteranceId(): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replace(/-/g, '')
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `say-${random.slice(0, 24)}`;
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

class Speaker {
  private listeners = new Set<(state: SpeakerState) => void>();
  private voiceListeners = new Set<() => void>();
  private state: SpeakerState = { speaking: false, mouth: 0, line: '' };
  private player = new PcmPlayer({ onMouth: frame => this.patch({ mouth: frame }) });
  private generation = 0;
  private systemChain: Promise<void> = Promise.resolve();
  private cloudActive = 0;
  private voiceSpeaking = false;
  private aborts = new Set<AbortController>();
  /** Last status reported by the desktop voice worker host. */
  private native: NativeVoiceStatus | null = null;
  /**
   * The most recent runtime failure of the wanted engine, shown until that engine works again.
   * A local-voice failure sends speech to the system voice for FAILURE_HOLD_MS, then she retries.
   */
  private failure: { engine: Engine; reason: string; at: number } | null = null;
  private adoptionDone = false;
  private syncedPreference: boolean | null = null;
  /** The last voice_cancel request; a new local utterance is sent only after it has landed. */
  private nativeCancel: Promise<void> = Promise.resolve();

  constructor() {
    voiceService.onSpeakingChange(speaking => {
      this.voiceSpeaking = speaking;
      this.patch({ speaking: speaking || this.cloudActive > 0 });
    });
    voiceService.onVisemeChange(frame => {
      if (this.cloudActive === 0) this.patch({ mouth: frame });
    });
    if (isDashboardWindow()) this.watchNativeVoice();
  }

  subscribe(fn: (state: SpeakerState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => { this.listeners.delete(fn); };
  }

  /** Called whenever the answer of `activeVoice()` may have changed. */
  onVoiceChange(fn: () => void): () => void {
    this.voiceListeners.add(fn);
    return () => { this.voiceListeners.delete(fn); };
  }

  get current(): SpeakerState {
    return this.state;
  }

  /** The latest desktop voice-engine status, or null in the browser and before the first report. */
  get nativeStatus(): NativeVoiceStatus | null {
    return this.native;
  }

  private patch(next: Partial<SpeakerState>) {
    const merged = { ...this.state, ...next };
    if (!merged.speaking) merged.mouth = 0;
    if (merged.speaking === this.state.speaking && merged.mouth === this.state.mouth && merged.line === this.state.line) return;
    this.state = merged;
    this.listeners.forEach(fn => fn(merged));
  }

  private voiceChanged() {
    this.voiceListeners.forEach(fn => {
      try { fn(); } catch { /* keep notifying the rest */ }
    });
  }

  // ── Desktop voice engine ────────────────────────────────────────────────────

  private watchNativeVoice() {
    // The host targets PCM at the dashboard and broadcasts only audio-free activity metadata to
    // both windows. This lifetime attachment is idempotent across repeated mounts and HMR.
    voiceService.attachNativeVoice('main');
    voiceService.onNativeActivity((activity: NativeVoiceActivity) => {
      if (activity.playbackOwner === 'main' && activity.event === 'chunk' && activity.text) {
        this.patch({ line: activity.text });
      }
    });
    const apply = (status: NativeVoiceStatus) => {
      this.native = status;
      if (this.failure?.engine === 'local' && isClonedVoice(status)) this.failure = null;
      this.voiceChanged();
      this.adoptClonedVoice(status);
    };
    void invokeNative<NativeVoiceStatus>('voice_status').then(apply).catch(() => undefined);
    void listenNative<NativeVoiceStatus>('miss-minutes:voice-status', apply).catch(() => undefined);
    this.syncPreference(loadSettings());
    onSettingsChange(settings => {
      this.syncPreference(settings);
      this.voiceChanged();
    });
  }

  /**
   * Her cloned voice is the default on the desktop: once a prepared reference with its rights
   * record and an installed engine are reported, and the owner never picked another engine,
   * the setting switches to it. Runs once per app start.
   */
  private adoptClonedVoice(status: NativeVoiceStatus) {
    if (this.adoptionDone) return;
    const settings = loadSettings();
    if (settings.voiceEngineChosen) {
      this.adoptionDone = true;
      return;
    }
    if (!status.installed || !status.configured?.reference) return; // not prepared (yet)
    this.adoptionDone = true;
    if (settings.voiceEngine !== 'local' || !settings.localVoice) {
      saveSettings({ ...settings, voiceEngine: 'local', localVoice: true });
    } else {
      this.syncPreference(settings);
    }
  }

  /**
   * Tells the host whether overlay speech should use the local voice too, and starts the engine
   * when it is wanted, so the first reply does not wait for the models to load.
   */
  private syncPreference(settings: AISettings) {
    const wanted = settings.voiceEngine === 'local';
    if (this.syncedPreference === wanted) return;
    this.syncedPreference = wanted;
    void invokeNative<NativeVoiceStatus>('voice_set_preferred', { enabled: wanted })
      .then(status => {
        this.native = status;
        this.voiceChanged();
      })
      .catch(() => { this.syncedPreference = null; });
  }

  // ── Which engine speaks ─────────────────────────────────────────────────────

  private resolve(settings: AISettings): { engine: Engine; reason: string | null } {
    const wanted = settings.voiceEngine ?? 'system';
    const desktop = isDesktopRuntime();
    if (wanted === 'local') {
      if (!desktop) return { engine: 'system', reason: 'her cloned voice runs only in the desktop app' };
      const status = this.native;
      if (!status) return { engine: 'system', reason: 'checking the voice engine' };
      if (!status.installed) return { engine: 'system', reason: status.detail ?? 'the voice engine is not installed' };
      if (status.starting) return { engine: 'system', reason: 'the voice engine is loading' };
      if (!status.ready) return { engine: 'system', reason: status.lastError ?? 'the voice engine is stopped' };
      if (this.failure?.engine === 'local' && Date.now() - this.failure.at < FAILURE_HOLD_MS) {
        return { engine: 'system', reason: `her cloned voice just failed: ${this.failure.reason}` };
      }
      return { engine: 'local', reason: null };
    }
    if (wanted === 'openai') {
      if (!desktop && !getWebSecret('openai')) return { engine: 'system', reason: 'no OpenAI key is saved' };
    } else if (wanted === 'elevenlabs') {
      if (!settings.elevenLabsVoiceId?.trim()) return { engine: 'system', reason: 'no ElevenLabs voice ID is set' };
      if (!desktop && !getWebSecret('elevenlabs') && !settings.elevenLabsKey) {
        return { engine: 'system', reason: 'no ElevenLabs key is saved' };
      }
    } else {
      return { engine: 'system', reason: null };
    }
    if (this.failure?.engine === wanted) return { engine: wanted, reason: `the last request failed: ${this.failure.reason}` };
    return { engine: wanted, reason: null };
  }

  /** Which voice speaks with these settings, and why when it is not the one asked for. */
  activeVoice(settings: AISettings): ActiveVoice {
    const wanted = settings.voiceEngine ?? 'system';
    const { engine, reason } = this.resolve(settings);
    if (engine === 'local') {
      const status = this.native;
      const where = `${status?.engineLabel ?? 'local engine'}, on this PC`;
      if (isClonedVoice(status)) {
        return { wanted, engine, cloned: true, label: `Her cloned voice (${where})`, reason: null };
      }
      return {
        wanted, engine, cloned: false,
        label: `${status?.engineLabel ?? 'Local engine'} built-in voice (on this PC)`,
        reason: status?.voiceNote ?? 'the cloned voice is not loaded',
      };
    }
    if (engine === 'openai') return { wanted, engine, cloned: false, label: 'OpenAI voice (hostess style)', reason };
    if (engine === 'elevenlabs') return { wanted, engine, cloned: false, label: 'ElevenLabs voice', reason };
    const notReady = wanted === 'local' ? 'cloned voice not ready' : `${ENGINE_NAMES[wanted]} unavailable`;
    return {
      wanted, engine, cloned: false,
      label: reason ? `System voice: ${notReady}` : 'System voice',
      reason,
    };
  }

  private recordFailure(engine: Engine, error: unknown) {
    this.failure = { engine, reason: errorText(error), at: Date.now() };
    this.voiceChanged();
  }

  private clearFailure(engine: Engine) {
    if (this.failure?.engine !== engine) return;
    this.failure = null;
    this.voiceChanged();
  }

  // ── Speaking ────────────────────────────────────────────────────────────────

  /** Stops everything she is saying, on every engine. */
  stop() {
    this.generation += 1;
    this.aborts.forEach(controller => controller.abort());
    this.aborts.clear();
    this.player.flush();
    this.cloudActive = 0;
    voiceService.stop();
    if (isDesktopRuntime()) this.nativeCancel = invokeNative<void>('voice_cancel').catch(() => undefined);
    this.systemChain = Promise.resolve();
    this.patch({ speaking: false, mouth: 0, line: '' });
  }

  /** Speaks a complete line (alarms, previews). Replaces anything already playing. */
  say(text: string, settings: AISettings): void {
    const utterance = this.begin(settings);
    utterance.push(text);
    utterance.end();
  }

  /** Starts a streamed utterance; feed it the model's text as it arrives. */
  begin(settings: AISettings): Utterance {
    this.stop();
    const generation = this.generation;
    if (!settings.voiceEnabled) {
      return { push: () => undefined, end: () => undefined, cancel: () => undefined };
    }
    const { engine } = this.resolve(settings);
    const stream = new SpeakableStream();
    let previous = '';
    const live = () => generation === this.generation;

    // The local voice gets every sentence of this reply as one streamed utterance. Requests are
    // chained so the worker receives the sentences in order.
    const localId = newUtteranceId();
    let localChain: Promise<void> = this.nativeCancel;
    let localStarted = false;
    let localFailed = false;

    const speakLocal = (text: string) => {
      localChain = localChain.then(async () => {
        if (!live()) return;
        if (localFailed) { this.systemSentence(text, settings, generation); return; }
        try {
          await invokeNative<string>('voice_speak', { id: localId, text, style: 'conversational', stream: true });
          localStarted = true;
          this.clearFailure('local');
        } catch (error) {
          localFailed = true;
          if (!live()) return;
          console.warn('[speaker] Local voice failed; using the system voice.', error);
          this.recordFailure('local', error);
          this.systemSentence(text, settings, generation);
        }
      });
    };

    const speakSentence = (sentence: string) => {
      const text = speakableText(sentence);
      if (!text || !live()) return;
      if (engine === 'openai' || engine === 'elevenlabs') this.cloudSentence(engine, text, previous, settings, generation);
      else if (engine === 'local') speakLocal(text);
      else this.systemSentence(text, settings, generation);
      previous = text;
    };

    const finishLocal = () => {
      if (engine !== 'local') return;
      localChain = localChain.then(async () => {
        if (!localStarted || localFailed || !live()) return;
        await invokeNative<void>('voice_speak_end', { id: localId }).catch(() => undefined);
      });
    };

    return {
      push: delta => { if (live()) stream.push(delta).forEach(speakSentence); },
      end: () => {
        if (!live()) return;
        stream.end().forEach(speakSentence);
        finishLocal();
      },
      cancel: () => { if (live()) this.stop(); },
    };
  }

  private systemSentence(text: string, settings: AISettings, generation: number) {
    this.systemChain = this.systemChain.then(async () => {
      if (generation !== this.generation) return;
      this.patch({ line: text });
      await voiceService.speak(text, { pitch: settings.voicePitch, rate: settings.voiceRate });
    }).catch(() => undefined);
  }

  private cloudSentence(engine: 'openai' | 'elevenlabs', text: string, previousText: string, settings: AISettings, generation: number) {
    const segment = this.player.segment();
    const controller = new AbortController();
    this.aborts.add(controller);
    this.cloudActive += 1;
    this.patch({ speaking: true });

    void segment.started.then(() => {
      if (generation === this.generation) this.patch({ line: text, speaking: true });
    });

    void streamCloudSpeech({
      engine,
      text,
      previousText,
      openaiVoice: settings.openaiVoice,
      instructions,
      elevenLabsVoiceId: settings.elevenLabsVoiceId,
      key: isDesktopRuntime() ? undefined : (engine === 'openai' ? getWebSecret('openai') : getWebSecret('elevenlabs') || settings.elevenLabsKey) || undefined,
      signal: controller.signal,
      onAudio: bytes => segment.pushPcm16(bytes, CLOUD_SAMPLE_RATE),
    })
      .then(() => {
        segment.end();
        this.clearFailure(engine);
      })
      .catch((error: unknown) => {
        segment.cancel();
        if (generation === this.generation && !controller.signal.aborted) {
          console.warn(`[speaker] ${engine} voice failed; using the system voice.`, error);
          this.recordFailure(engine, error);
          this.systemSentence(text, settings, generation);
        }
      })
      .finally(() => this.aborts.delete(controller));

    void segment.played.finally(() => {
      this.cloudActive = Math.max(0, this.cloudActive - 1);
      if (generation === this.generation && this.cloudActive === 0 && !this.voiceSpeaking) {
        this.patch({ speaking: false, line: '' });
      }
    });
  }
}

export const speaker = new Speaker();

/** The active voice for these settings, kept current as the engine loads, fails or recovers. */
export function useActiveVoice(settings: AISettings): ActiveVoice {
  const [, setTick] = useState(0);
  useEffect(() => speaker.onVoiceChange(() => setTick(tick => tick + 1)), []);
  return speaker.activeVoice(settings);
}

/**
 * Speaker: one place that turns Miss Minutes' words into sound and mouth movement.
 *
 * Engines (settings.voiceEngine):
 *   openai / elevenlabs  streamed cloud speech (PCM) through PcmPlayer, lip sync from the audio
 *   local                the on-device worker (desktop); audio arrives as host events
 *   system               the browser / OS voice
 * Replies are spoken sentence by sentence while the model is still writing, so she starts
 * talking almost immediately. Any engine failure falls back to the system voice.
 */
import type { AISettings, MouthFrame } from '../types';
import { voiceService } from '../services/voiceService';
import { PcmPlayer } from '../agent/realtime/pcmPlayer';
import { CLOUD_SAMPLE_RATE, HOSTESS_VOICE_INSTRUCTIONS, streamCloudSpeech } from '../agent/realtime/cloudTts';
import { SpeakableStream, speakableText } from '../agent/realtime/speechText';
import { getWebSecret } from '../agent/secrets-web';
import { invokeNative, isDesktopRuntime } from '../desktop/bridge';

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

const instructions = Array.isArray(HOSTESS_VOICE_INSTRUCTIONS)
  ? (HOSTESS_VOICE_INSTRUCTIONS as readonly string[]).join(' ')
  : String(HOSTESS_VOICE_INSTRUCTIONS);

class Speaker {
  private listeners = new Set<(state: SpeakerState) => void>();
  private state: SpeakerState = { speaking: false, mouth: 0, line: '' };
  private player = new PcmPlayer({ onMouth: frame => this.patch({ mouth: frame }) });
  private generation = 0;
  private systemChain: Promise<void> = Promise.resolve();
  private cloudActive = 0;
  private voiceSpeaking = false;
  private aborts = new Set<AbortController>();

  constructor() {
    voiceService.onSpeakingChange(speaking => {
      this.voiceSpeaking = speaking;
      this.patch({ speaking: speaking || this.cloudActive > 0 });
    });
    voiceService.onVisemeChange(frame => {
      if (this.cloudActive === 0) this.patch({ mouth: frame });
    });
  }

  subscribe(fn: (state: SpeakerState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => { this.listeners.delete(fn); };
  }

  get current(): SpeakerState {
    return this.state;
  }

  private patch(next: Partial<SpeakerState>) {
    const merged = { ...this.state, ...next };
    if (!merged.speaking) merged.mouth = 0;
    if (merged.speaking === this.state.speaking && merged.mouth === this.state.mouth && merged.line === this.state.line) return;
    this.state = merged;
    this.listeners.forEach(fn => fn(merged));
  }

  private engineFor(settings: AISettings): Engine {
    const wanted = settings.voiceEngine ?? 'system';
    const desktop = isDesktopRuntime();
    if (wanted === 'local') return desktop ? 'local' : 'system';
    if (wanted === 'openai') return desktop || getWebSecret('openai') ? 'openai' : 'system';
    if (wanted === 'elevenlabs') {
      if (!settings.elevenLabsVoiceId?.trim()) return 'system';
      return desktop || getWebSecret('elevenlabs') || settings.elevenLabsKey ? 'elevenlabs' : 'system';
    }
    return 'system';
  }

  /** Stops everything she is saying, on every engine. */
  stop() {
    this.generation += 1;
    this.aborts.forEach(controller => controller.abort());
    this.aborts.clear();
    this.player.flush();
    this.cloudActive = 0;
    voiceService.stop();
    if (isDesktopRuntime()) void invokeNative('voice_cancel').catch(() => undefined);
    this.systemChain = Promise.resolve();
    this.patch({ speaking: false, mouth: 0, line: '' });
  }

  /** Speaks a complete line (click quotes, alarms). Replaces anything already playing. */
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
    const engine = this.engineFor(settings);
    const stream = new SpeakableStream();
    let previous = '';
    const live = () => generation === this.generation;

    const speakSentence = (sentence: string) => {
      const text = speakableText(sentence);
      if (!text || !live()) return;
      if (engine === 'openai' || engine === 'elevenlabs') this.cloudSentence(engine, text, previous, settings, generation);
      else if (engine === 'local') void invokeNative('voice_speak', { text, style: 'conversational' }).catch(() => this.systemSentence(text, settings, generation));
      else this.systemSentence(text, settings, generation);
      previous = text;
    };

    return {
      push: delta => { if (live()) stream.push(delta).forEach(speakSentence); },
      end: () => { if (live()) stream.end().forEach(speakSentence); },
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
      .then(() => segment.end())
      .catch((error: unknown) => {
        segment.cancel();
        if (generation === this.generation && !controller.signal.aborted) {
          console.warn(`[speaker] ${engine} voice failed; using the system voice.`, error);
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

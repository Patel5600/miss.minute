import type { MouthFrame } from '../types';

/**
 * VoiceService – Multi-Engine TTS for Miss Minutes
 *
 * Priority:
 * 1. ElevenLabs API (highest quality, realistic voice)
 * 2. Browser Web Speech API (improved pitch/rate)
 *
 * Recognition: Web Speech API (Chrome/Edge/Safari)
 */

export interface VoiceConfig {
  pitch?: number;
  rate?: number;
  elevenLabsKey?: string;
  elevenLabsVoiceId?: string;
}

export class VoiceService {
  private synth: SpeechSynthesis | null = null;
  private voice: SpeechSynthesisVoice | null = null;
  private _isSpeaking = false;
  private callbacks: ((s: boolean) => void)[] = [];
  private visemeCallbacks: ((frame: MouthFrame) => void)[] = [];
  private mouthTimer: ReturnType<typeof setInterval> | null = null;
  private currentAudio: HTMLAudioElement | null = null;
  private cleanupAudioPlayback: (() => void) | null = null;
  private cancelWebSpeech: (() => void) | null = null;
  private requestController: AbortController | null = null;
  private playbackGeneration = 0;
  private recognition: any = null;

  constructor() {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      this.synth = window.speechSynthesis;
      this._pickVoice();
      if (this.synth.onvoiceschanged !== undefined) {
        this.synth.onvoiceschanged = () => this._pickVoice();
      }
    }
  }

  private _pickVoice() {
    if (!this.synth) return;
    const voices = this.synth.getVoices();
    if (!voices.length) return;

    const prefs = ['Zira', 'Jenny', 'Aria', 'Sonia', 'Samantha', 'Karen', 'Tessa', 'Victoria', 'Fiona', 'Google US English'];
    let found: SpeechSynthesisVoice | undefined;
    for (const p of prefs) {
      found = voices.find(v => v.name.includes(p) && v.lang.startsWith('en'));
      if (found) break;
    }
    if (!found) found = voices.find(v => v.lang.startsWith('en-'));
    if (!found) found = voices.find(v => v.lang.startsWith('en'));
    this.voice = found ?? voices[0] ?? null;
  }

  onSpeakingChange(cb: (s: boolean) => void) {
    this.callbacks.push(cb);
    return () => { this.callbacks = this.callbacks.filter(listener => listener !== cb); };
  }

  onVisemeChange(cb: (frame: MouthFrame) => void) {
    this.visemeCallbacks.push(cb);
    return () => { this.visemeCallbacks = this.visemeCallbacks.filter(listener => listener !== cb); };
  }

  private _notifyViseme(frame: MouthFrame) {
    this.visemeCallbacks.forEach(cb => cb(frame));
  }

  private _notify(s: boolean) {
    this._isSpeaking = s;
    this.callbacks.forEach(cb => cb(s));
    if (!s) this._notifyViseme(0);
  }

  get isSpeaking() { return this._isSpeaking; }

  private _clean(text: string): string {
    return text
      .replace(/```[\s\S]*?```/g, 'Code block.')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/#+\s/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[🕒⚡💥📜⏳⚠️🎉🎊]/g, '')
      .replace(/\n+/g, '. ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  private async _speakElevenLabs(text: string, key: string, voiceId: string, generation: number): Promise<void> {
    const cleaned = this._clean(text);
    if (!cleaned) return;

    const controller = new AbortController();
    this.requestController = controller;

    try {
      const response = await fetch(
        'https://api.elevenlabs.io/v1/text-to-speech/' + encodeURIComponent(voiceId) + '/stream',
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            Accept: 'audio/mpeg',
            'xi-api-key': key,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text: cleaned,
            model_id: 'eleven_flash_v2_5',
            voice_settings: {
              stability: 0.42,
              similarity_boost: 0.78,
              style: 0.22,
              use_speaker_boost: true,
            },
          }),
        }
      );

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error('ElevenLabs ' + response.status + ': ' + detail.slice(0, 160));
      }

      const blob = await response.blob();
      if (generation !== this.playbackGeneration || controller.signal.aborted) return;

      const audioUrl = URL.createObjectURL(blob);
      const audio = new Audio(audioUrl);
      audio.preload = 'auto';
      this.currentAudio = audio;

      await new Promise<void>((resolve, reject) => {
        let finished = false;
        let animationFrame = 0;
        let audioContext: AudioContext | null = null;

        const finish = (error?: Error) => {
          if (finished) return;
          finished = true;

          if (animationFrame) cancelAnimationFrame(animationFrame);
          if (this.mouthTimer) clearInterval(this.mouthTimer);
          this.mouthTimer = null;

          audio.onplay = null;
          audio.onended = null;
          audio.onerror = null;

          if (this.currentAudio === audio) this.currentAudio = null;
          if (this.cleanupAudioPlayback === cancelPlayback) this.cleanupAudioPlayback = null;

          if (audioContext) void audioContext.close().catch(() => undefined);
          URL.revokeObjectURL(audioUrl);
          this._notify(false);

          if (error) reject(error);
          else resolve();
        };

        const cancelPlayback = () => {
          audio.pause();
          finish();
        };
        this.cleanupAudioPlayback = cancelPlayback;

        const startFallbackMouth = () => {
          const frames: MouthFrame[] = [1, 3, 2, 4, 1, 0, 3, 2, 0];
          let frameIndex = 0;
          this.mouthTimer = setInterval(() => {
            this._notifyViseme(frames[frameIndex++ % frames.length]);
          }, 96);
        };

        const startAudioAnalyser = () => {
          if (!('AudioContext' in window)) {
            startFallbackMouth();
            return;
          }

          try {
            audioContext = new AudioContext();
            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 512;
            analyser.smoothingTimeConstant = 0.72;

            const source = audioContext.createMediaElementSource(audio);
            source.connect(analyser);
            analyser.connect(audioContext.destination);
            void audioContext.resume().catch(() => undefined);

            const samples = new Uint8Array(analyser.fftSize);
            const sampleMouth = () => {
              if (finished) return;
              analyser.getByteTimeDomainData(samples);

              let energy = 0;
              for (let index = 0; index < samples.length; index += 1) {
                const value = (samples[index] - 128) / 128;
                energy += value * value;
              }

              const rms = Math.sqrt(energy / samples.length);
              const frame: MouthFrame =
                rms < 0.014 ? 0 :
                rms < 0.045 ? 1 :
                rms < 0.095 ? 2 :
                rms < 0.17 ? 3 : 4;

              this._notifyViseme(frame);
              animationFrame = requestAnimationFrame(sampleMouth);
            };

            animationFrame = requestAnimationFrame(sampleMouth);
          } catch (error) {
            console.debug('[VoiceService] Audio analysis unavailable; using timed mouth motion.', error);
            if (audioContext) {
              void audioContext.close().catch(() => undefined);
              audioContext = null;
            }
            startFallbackMouth();
          }
        };

        audio.onplay = () => {
          this._notify(true);
          startAudioAnalyser();
        };
        audio.onended = () => finish();
        audio.onerror = () => finish(new Error('Generated voice audio could not be played.'));
        audio.play().catch(error => {
          finish(error instanceof Error ? error : new Error('Audio playback was blocked.'));
        });
      });
    } finally {
      if (this.requestController === controller) this.requestController = null;
    }
  }

  private _speakWebSpeech(text: string, pitch: number, rate: number, generation: number): Promise<void> {
    const frameFor = (segment: string): MouthFrame => {
      const value = segment.toLowerCase();
      if (/[wuy]/.test(value)) return 4;
      if (/[o]/.test(value)) return 2;
      if (/[a]/.test(value)) return 3;
      if (/[ei]/.test(value)) return 1;
      return 0;
    };

    return new Promise(resolve => {
      if (!this.synth || typeof SpeechSynthesisUtterance === 'undefined') {
        this._notify(false);
        resolve();
        return;
      }

      const cleaned = this._clean(text);
      if (!cleaned) {
        this._notify(false);
        resolve();
        return;
      }

      const sentences = cleaned.length > 200
        ? (cleaned.match(/[^.!?]+[.!?]*/g) ?? [cleaned]).map(part => part.trim()).filter(Boolean)
        : [cleaned];

      let sentenceIndex = 0;
      let finished = false;

      const finish = () => {
        if (finished) return;
        finished = true;
        if (this.mouthTimer) clearInterval(this.mouthTimer);
        this.mouthTimer = null;
        if (this.cancelWebSpeech === finish) this.cancelWebSpeech = null;
        this._notify(false);
        resolve();
      };
      this.cancelWebSpeech = finish;

      const speakNext = () => {
        if (finished || generation !== this.playbackGeneration) {
          finish();
          return;
        }
        if (sentenceIndex >= sentences.length) {
          finish();
          return;
        }

        const sentence = sentences[sentenceIndex++];
        const utterance = new SpeechSynthesisUtterance(sentence);
        if (this.voice) utterance.voice = this.voice;
        utterance.lang = this.voice?.lang || 'en-US';
        utterance.pitch = Math.min(2, Math.max(0.5, pitch));
        utterance.rate = Math.min(1.5, Math.max(0.7, rate));
        utterance.volume = 1;

        let cursor = 0;
        utterance.onstart = () => this._notify(true);
        utterance.onboundary = event => {
          cursor = Math.max(0, event.charIndex || 0);
          const segment = sentence.slice(cursor, cursor + Math.max(1, event.charLength || 2));
          this._notifyViseme(frameFor(segment));
        };

        if (this.mouthTimer) clearInterval(this.mouthTimer);
        this.mouthTimer = setInterval(() => {
          if (finished || generation !== this.playbackGeneration || sentence.length === 0) return;
          const segment = sentence.slice(cursor, cursor + 3);
          this._notifyViseme(frameFor(segment));
          cursor = (cursor + 2) % sentence.length;
        }, 105);

        utterance.onend = () => {
          this._notifyViseme(0);
          speakNext();
        };
        utterance.onerror = event => {
          if (event.error !== 'canceled' && event.error !== 'interrupted') {
            console.warn('[VoiceService] Browser speech failed:', event.error);
          }
          finish();
        };

        this.synth?.speak(utterance);
      };

      speakNext();
    });
  }

  async speak(text: string, cfg: VoiceConfig = {}): Promise<void> {
    this.stop();
    const generation = this.playbackGeneration;

    if (cfg.elevenLabsKey?.trim() && cfg.elevenLabsVoiceId?.trim()) {
      try {
        await this._speakElevenLabs(text, cfg.elevenLabsKey, cfg.elevenLabsVoiceId, generation);
        return;
      } catch (error) {
        if (generation !== this.playbackGeneration || (error as Error)?.name === 'AbortError') return;
        console.warn('[VoiceService] ElevenLabs fallback to browser TTS:', error);
      }
    }

    if (generation !== this.playbackGeneration) return;
    await this._speakWebSpeech(text, cfg.pitch ?? 1.12, cfg.rate ?? 1.0, generation);
  }

  stop() {
    this.playbackGeneration += 1;
    this.requestController?.abort();
    this.requestController = null;

    this.cleanupAudioPlayback?.();
    this.cleanupAudioPlayback = null;
    this.cancelWebSpeech?.();
    this.cancelWebSpeech = null;

    if (this.synth) this.synth.cancel();
    if (this.mouthTimer) clearInterval(this.mouthTimer);
    this.mouthTimer = null;

    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio.src = '';
      this.currentAudio = null;
    }

    this._notify(false);
  }

  /** Alias kept for component compatibility */
  startSpeechRecognition(
    onResult: (text: string, isFinal: boolean) => void,
    onError: (msg: string) => void,
    onEnd: () => void
  ): { stop: () => void } | null {
    return this.startListening(onResult, onError, onEnd);
  }

  startListening(
    onResult: (text: string, isFinal: boolean) => void,
    onError: (msg: string) => void,
    onEnd: () => void
  ): { stop: () => void } | null {
    if (typeof window === 'undefined') return null;
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { onError('Speech recognition not supported. Use Chrome, Edge or Safari.'); return null; }

    try {
      const rec = new SR();
      rec.continuous = false;
      rec.interimResults = true;
      rec.lang = 'en-US';

      rec.onresult = (e: any) => {
        let interim = '', final = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = e.results[i][0].transcript;
          if (e.results[i].isFinal) final += t; else interim += t;
        }
        if (final) onResult(final, true);
        else if (interim) onResult(interim, false);
      };

      rec.onerror = (e: any) => onError(e.error || 'Recognition error');
      rec.onend = onEnd;
      rec.start();
      this.recognition = rec;
      return { stop: () => { try { rec.stop(); } catch {} } };
    } catch (e: any) {
      onError(e?.message || 'Failed to start recognition');
      return null;
    }
  }

  stopListening() { try { this.recognition?.stop(); } catch {} }
}

export const voiceService = new VoiceService();

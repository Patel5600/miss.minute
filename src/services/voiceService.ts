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

  private async _speakElevenLabs(text: string, key: string, voiceId: string): Promise<void> {
    const cleaned = this._clean(text);
    if (!cleaned) return;

    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`, {
      method: 'POST',
      headers: {
        'Accept': 'audio/mpeg',
        'xi-api-key': key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: cleaned,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: { stability: 0.52, similarity_boost: 0.78, style: 0.38, use_speaker_boost: true },
      }),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`ElevenLabs ${res.status}: ${err.slice(0, 100)}`);
    }

    const blob = await res.blob();
    const audioUrl = URL.createObjectURL(blob);
    const audio = new Audio(audioUrl);
    this.currentAudio = audio;

    return new Promise((resolve) => {
      const cleanup = () => {
        if (this.mouthTimer) clearInterval(this.mouthTimer);
        this.mouthTimer = null;
        this._notify(false);
        URL.revokeObjectURL(audioUrl);
        this.currentAudio = null;
        resolve();
      };
      audio.onplay = () => {
        this._notify(true);
        const frames: MouthFrame[] = [1, 3, 2, 4, 1, 0, 3, 2, 0];
        let index = 0;
        this.mouthTimer = setInterval(() => this._notifyViseme(frames[index++ % frames.length]), 92);
      };
      audio.onended = cleanup;
      audio.onerror = cleanup;
      audio.play().catch(cleanup);
    });
  }

  private _speakWebSpeech(text: string, pitch: number, rate: number): Promise<void> {
    return new Promise((resolve) => {
      if (!this.synth) { resolve(); return; }
      this.synth.cancel();
      const cleaned = this._clean(text);
      if (!cleaned.trim()) { resolve(); return; }

      // Chrome bug: long utterances cut off. Split into sentences.
      const sentences = cleaned.length > 200
        ? (cleaned.match(/[^.!?]+[.!?]*/g) || [cleaned]).map(s => s.trim()).filter(Boolean)
        : [cleaned];

      let i = 0;
      const speakNext = () => {
        if (i >= sentences.length) { this._notify(false); resolve(); return; }
        const sentence = sentences[i++];
        const utt = new SpeechSynthesisUtterance(sentence);
        if (this.voice) utt.voice = this.voice;
        utt.pitch = pitch;
        utt.rate = rate;
        utt.volume = 1.0;
        if (i === 1) utt.onstart = () => this._notify(true);
        utt.onboundary = event => {
          const fragment = sentence.slice(event.charIndex, event.charIndex + Math.max(1, event.charLength || 2)).toLowerCase();
          const frame: MouthFrame = /[wuy]/.test(fragment) ? 4 : /o/.test(fragment) ? 2 : /a/.test(fragment) ? 3 : /[ei]/.test(fragment) ? 1 : 0;
          this._notifyViseme(frame);
        };
        utt.onend = () => { this._notifyViseme(0); speakNext(); };
        utt.onerror = () => { this._notify(false); resolve(); };
        this.synth!.speak(utt);
      };
      speakNext();
    });
  }

  async speak(text: string, cfg: VoiceConfig = {}): Promise<void> {
    this.stop();

    if (cfg.elevenLabsKey?.trim() && cfg.elevenLabsVoiceId?.trim()) {
      try {
        await this._speakElevenLabs(text, cfg.elevenLabsKey, cfg.elevenLabsVoiceId);
        return;
      } catch (err) {
        console.warn('[VoiceService] ElevenLabs fallback to browser TTS:', err);
      }
    }

    await this._speakWebSpeech(text, cfg.pitch ?? 1.22, cfg.rate ?? 1.08);
  }

  stop() {
    if (this.synth) this.synth.cancel();
    if (this.mouthTimer) clearInterval(this.mouthTimer);
    this.mouthTimer = null;
    if (this.currentAudio) { this.currentAudio.pause(); this.currentAudio = null; }
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

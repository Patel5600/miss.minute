// Web Audio API Synthesizer for TVA Sound Effects

class SoundEffectsManager {
  private ctx: AudioContext | null = null;
  private isMuted: boolean = false;

  private initContext() {
    if (!this.ctx && typeof window !== 'undefined') {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  public setMuted(muted: boolean) {
    this.isMuted = muted;
  }

  public getMuted(): boolean {
    return this.isMuted;
  }

  /**
   * Iconic TVA Elevator / Announcement 3-tone chime
   */
  public playTvaChime() {
    if (this.isMuted) return;
    this.initContext();
    if (!this.ctx) return;

    const notes = [523.25, 659.25, 783.99]; // C5, E5, G5
    const now = this.ctx.currentTime;

    notes.forEach((freq, index) => {
      if (!this.ctx) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now + index * 0.16);

      gain.gain.setValueAtTime(0, now + index * 0.16);
      gain.gain.linearRampToValueAtTime(0.2, now + index * 0.16 + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + index * 0.16 + 0.45);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(now + index * 0.16);
      osc.stop(now + index * 0.16 + 0.5);
    });
  }

  /**
   * Clock tick-tock mechanical sound
   */
  public playClockTick(isTock: boolean = false) {
    if (this.isMuted) return;
    this.initContext();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(isTock ? 600 : 800, now);
    osc.frequency.exponentialRampToValueAtTime(80, now + 0.04);

    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(isTock ? 800 : 1200, now);
    filter.Q.setValueAtTime(5, now);

    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.05);
  }

  /**
   * TVA Pruning Baton / Reset Charge Disintegration Zap
   */
  public playPruneZap() {
    if (this.isMuted) return;
    this.initContext();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;

    // Noise buffer for electric sizzle
    const bufferSize = this.ctx.sampleRate * 0.4;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;

    const noiseFilter = this.ctx.createBiquadFilter();
    noiseFilter.type = 'highpass';
    noiseFilter.frequency.setValueAtTime(1000, now);
    noiseFilter.frequency.linearRampToValueAtTime(4000, now + 0.2);

    const noiseGain = this.ctx.createGain();
    noiseGain.gain.setValueAtTime(0.3, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(this.ctx.destination);

    // High sweep oscillator
    const sweepOsc = this.ctx.createOscillator();
    const sweepGain = this.ctx.createGain();

    sweepOsc.type = 'sawtooth';
    sweepOsc.frequency.setValueAtTime(1200, now);
    sweepOsc.frequency.exponentialRampToValueAtTime(150, now + 0.3);

    sweepGain.gain.setValueAtTime(0.25, now);
    sweepGain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);

    sweepOsc.connect(sweepGain);
    sweepGain.connect(this.ctx.destination);

    noise.start(now);
    sweepOsc.start(now);
    sweepOsc.stop(now + 0.35);
  }

  /**
   * Red Line Alert Siren / Nexus Event warning
   */
  public playNexusAlert() {
    if (this.isMuted) return;
    this.initContext();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(440, now);
    osc.frequency.linearRampToValueAtTime(880, now + 0.15);
    osc.frequency.linearRampToValueAtTime(440, now + 0.3);
    osc.frequency.linearRampToValueAtTime(880, now + 0.45);
    osc.frequency.linearRampToValueAtTime(440, now + 0.6);

    gain.gain.setValueAtTime(0.18, now);
    gain.gain.linearRampToValueAtTime(0.18, now + 0.55);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.65);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.65);
  }

  /**
   * Retro terminal keystroke sound
   */
  public playKeyClick() {
    if (this.isMuted) return;
    this.initContext();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(1200 + Math.random() * 300, now);
    osc.frequency.exponentialRampToValueAtTime(200, now + 0.02);

    gain.gain.setValueAtTime(0.05, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.02);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.025);
  }

  /**
   * Screen glass knock / tap sound (Breaking the 4th wall!)
   */
  public playGlassTap(pitchVariant: number = 0) {
    if (this.isMuted) return;
    this.initContext();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();

    osc.type = 'triangle';
    const baseFreq = 1800 + pitchVariant * 180;
    osc.frequency.setValueAtTime(baseFreq, now);
    osc.frequency.exponentialRampToValueAtTime(320, now + 0.035);

    filter.type = 'highpass';
    filter.frequency.setValueAtTime(1200, now);

    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.045);
  }

  /**
   * Cartoon squeak / pop sound for jumps & stretch
   */
  public playCartoonHop() {
    if (this.isMuted) return;
    this.initContext();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(300, now);
    osc.frequency.exponentialRampToValueAtTime(750, now + 0.1);

    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.12);
  }

  /**
   * Holographic projector glitch / boot sound
   */
  public playHologramGlitch() {
    if (this.isMuted) return;
    this.initContext();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'square';
    osc.frequency.setValueAtTime(320, now);
    osc.frequency.setValueAtTime(580, now + 0.03);
    osc.frequency.setValueAtTime(220, now + 0.06);
    osc.frequency.setValueAtTime(880, now + 0.09);

    gain.gain.setValueAtTime(0.08, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.16);
  }
}

export const soundEffects = new SoundEffectsManager();

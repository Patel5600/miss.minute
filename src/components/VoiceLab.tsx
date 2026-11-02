import { useCallback, useEffect, useState } from 'react';
import { AudioLines, Loader2, Play, Power, Square } from 'lucide-react';
import scenarios from '../../native/voice/scenarios.json';
import { invokeNative, isClonedVoice, isDesktopRuntime } from '../desktop/bridge';
import type { NativeVoiceEnd, NativeVoiceStatus } from '../desktop/bridge';
import { AIService } from '../services/aiService';
import { voiceService } from '../services/voiceService';
import { speaker } from '../app/speaker';
import type { AISettings } from '../types';

type ScenarioKey = keyof typeof scenarios;
const SCENARIO_KEYS = Object.keys(scenarios) as ScenarioKey[];

interface VoiceLabProps {
  settings: AISettings;
  onSettingsChange: (next: AISettings) => void;
  isSpeaking: boolean;
}

const RIGHTS_LABELS: Record<string, string> = {
  'own-voice': 'your own voice',
  licensed: 'a licence you hold',
  'written-permission': "the speaker's written permission",
  'owner-attested': 'your statement that you hold permission',
};

function describe(status: NativeVoiceStatus | null): { tone: 'ok' | 'wait' | 'bad'; text: string } {
  if (!status) return { tone: 'wait', text: 'Checking the voice engine…' };
  if (status.lastError && !status.ready) return { tone: 'bad', text: status.lastError };
  if (!status.installed) return { tone: 'bad', text: status.detail ?? 'The voice engine is not installed.' };
  const engine = status.engineLabel ?? status.configured?.engineLabel ?? 'the local engine';
  if (status.starting) return { tone: 'wait', text: `Loading ${engine} and her cloned voice…` };
  if (!status.ready) return { tone: 'wait', text: `${engine} is installed but stopped.` };
  const loaded = status.loadSeconds ? ` · loaded in ${status.loadSeconds.toFixed(1)} s` : '';
  const first = status.firstChunkMs ? ` · first audio ${Math.round(status.firstChunkMs)} ms` : '';
  if (isClonedVoice(status)) return { tone: 'ok', text: `Ready · her cloned voice · ${engine}, on this PC${first}${loaded}` };
  return { tone: 'wait', text: `Ready · ${engine} built-in voice, not her cloned voice${status.voiceNote ? ` (${status.voiceNote})` : ''}${loaded}` };
}

function measuredLine(status: NativeVoiceStatus | null): string | null {
  const c = status?.configured;
  if (!c?.measured || c.rtf == null) return null;
  const parts = [
    // RTF is synthesis time over audio time, so 1 or more cannot keep up with playback.
    c.rtf < 1
      ? `${(1 / c.rtf).toFixed(1)}× faster than real time (RTF ${c.rtf.toFixed(2)})`
      : `slower than real time (RTF ${c.rtf.toFixed(2)})`,
    c.firstChunkMs != null ? `first audio ${Math.round(c.firstChunkMs)} ms` : null,
    c.similarity != null ? `voice match ${c.similarity.toFixed(2)}${c.similarityNorm != null ? ` (normalized ${c.similarityNorm.toFixed(2)})` : ''}` : null,
    c.wer != null ? `word error ${Math.round(c.wer * 100)}%` : null,
  ].filter(Boolean);
  return `Measured on this PC: ${parts.join(' · ')}.`;
}

export function VoiceLab({ settings, onSettingsChange, isSpeaking }: VoiceLabProps) {
  const [status, setStatus] = useState<NativeVoiceStatus | null>(() => speaker.nativeStatus);
  const [busy, setBusy] = useState<ScenarioKey | 'custom' | null>(null);
  const [custom, setCustom] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let unlistenEnd: (() => void) | undefined;

    void invokeNative<NativeVoiceStatus>('voice_status')
      .then(next => { if (!disposed) setStatus(next); })
      .catch(reason => { if (!disposed) setError(String(reason)); });

    const events = window.__TAURI__?.event;
    void events?.listen<NativeVoiceStatus>('miss-minutes:voice-status', event => setStatus(event.payload))
      .then(stop => { if (disposed) stop(); else unlisten = stop; })
      .catch(() => undefined);
    // A job that fails before producing audio would otherwise leave its button spinning.
    void events?.listen<NativeVoiceEnd>('miss-minutes:voice-end', event => {
      if (event.payload.event === 'error') setError(event.payload.message ?? 'Speech failed.');
      setBusy(null);
    }).then(stop => { if (disposed) stop(); else unlistenEnd = stop; }).catch(() => undefined);

    return () => { disposed = true; unlisten?.(); unlistenEnd?.(); };
  }, []);

  const run = useCallback(async (key: ScenarioKey | 'custom', text: string, style: string) => {
    setError(null);
    setBusy(key);
    try {
      await invokeNative<string>('voice_speak', { text, style });
    } catch (reason) {
      setBusy(null);
      setError(String(reason));
    }
  }, []);

  const stop = useCallback(() => {
    setBusy(null);
    voiceService.stop();
    void invokeNative<void>('voice_cancel').catch(() => undefined);
  }, []);

  // Choosing here is the owner's choice, so the cloned-voice default never overrides it later.
  const setPreferred = useCallback((enabled: boolean) => {
    const next: AISettings = { ...settings, voiceEngine: enabled ? 'local' : 'system', localVoice: enabled, voiceEngineChosen: true };
    AIService.saveSettings(next);
    onSettingsChange(next);
  }, [settings, onSettingsChange]);

  const toggleEngine = useCallback(async () => {
    setError(null);
    try {
      if (status?.ready || status?.starting) {
        stop();
        await invokeNative<void>('voice_shutdown');
      } else if (settings.voiceEngine === 'local') {
        await invokeNative<NativeVoiceStatus>('voice_set_preferred', { enabled: true }); // also starts it
      } else {
        await invokeNative<void>('voice_start');
      }
      setStatus(await invokeNative<NativeVoiceStatus>('voice_status'));
    } catch (reason) {
      setError(String(reason));
    }
  }, [status, stop, settings.voiceEngine]);

  if (!isDesktopRuntime()) return null;

  const summary = describe(status);
  const measured = measuredLine(status);
  const shortfall = status?.configured?.measured ? status.configured.shortfall : [];
  const basis = status?.rightsBasis ?? status?.configured?.rightsBasis ?? null;
  const ready = status?.ready === true;
  const running = ready || status?.starting === true;
  const engine = status?.engine ?? status?.configured?.engine ?? null;
  const toneClass = summary.tone === 'ok' ? 'text-emerald-300' : summary.tone === 'bad' ? 'text-red-300' : 'text-amber-300';

  return (
    <div className="bg-amber-950/40 border border-amber-600/30 rounded-2xl p-4 backdrop-blur-md shadow-xl font-mono text-amber-200 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <AudioLines className="w-4 h-4 text-amber-400" />
          <span className="text-[10px] uppercase font-bold text-amber-400/80 tracking-[0.2em]">Voice Lab</span>
        </div>
        <button
          type="button"
          onClick={() => void toggleEngine()}
          disabled={!status?.installed}
          title={running ? 'Stop the voice engine' : 'Start the voice engine'}
          className="flex items-center gap-1 px-2 py-1 rounded-lg border border-amber-700/40 bg-amber-950/60 text-[10px] uppercase text-amber-300 hover:border-amber-500/60 disabled:opacity-40"
        >
          <Power className="w-3 h-3" /> {running ? 'Stop engine' : 'Start engine'}
        </button>
      </div>

      <p className={`text-[11px] leading-snug ${toneClass}`}>{summary.text}</p>
      {measured && <p className="text-[10px] leading-snug text-amber-300/80">{measured}</p>}
      {shortfall.length > 0 && (
        <p className="text-[10px] leading-snug text-amber-400/80">Below the targets for a live voice: {shortfall.join('; ')}.</p>
      )}
      {status?.configured && !status.configured.reference && (
        <p className="text-[10px] leading-snug text-amber-400/80">
          No prepared reference with a rights record yet, so the engine would use its own voice. Run
          {' '}<code>python -m miss_voice.prepare_reference</code> in native/voice.
        </p>
      )}

      <label className="flex items-center justify-between gap-3 text-[11px] text-amber-200/90 cursor-pointer">
        <span>
          Use her cloned voice
          <span className="block text-[10px] text-amber-400/60">Runs on this PC. Until it is ready the system voice speaks, and Settings says why.</span>
        </span>
        <input
          type="checkbox"
          checked={settings.voiceEngine === 'local'}
          disabled={!status?.installed}
          onChange={event => setPreferred(event.target.checked)}
          className="w-4 h-4 accent-amber-500 rounded cursor-pointer"
        />
      </label>

      <div className="flex flex-col gap-2">
        <span className="text-[10px] uppercase tracking-widest text-amber-500/80">Preview in different scenarios (rendered live)</span>
        {SCENARIO_KEYS.map(key => {
          const scenario = scenarios[key];
          const generating = busy === key;
          return (
            <div key={key} className="rounded-xl border border-amber-800/30 bg-black/30 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-xs font-bold text-amber-300">{scenario.label}</div>
                  <div className="text-[10px] text-amber-400/60">{scenario.blurb}</div>
                </div>
                <button
                  type="button"
                  onClick={() => void run(key, scenario.script, key)}
                  disabled={!ready || busy !== null}
                  aria-label={`Play ${scenario.label} preview`}
                  className="shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-lg bg-amber-500 text-neutral-950 text-[11px] font-bold hover:bg-amber-400 disabled:opacity-40 disabled:hover:bg-amber-500"
                >
                  {generating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                  {generating ? 'Speaking' : 'Play'}
                </button>
              </div>
              <p className="mt-1.5 text-[10px] italic leading-snug text-amber-200/70">“{scenario.script}”</p>
            </div>
          );
        })}
      </div>

      <form
        className="flex items-center gap-2"
        onSubmit={event => {
          event.preventDefault();
          if (custom.trim()) void run('custom', custom.trim(), 'conversational');
        }}
      >
        <input
          type="text"
          value={custom}
          maxLength={600}
          onChange={event => setCustom(event.target.value)}
          placeholder="Type a line for her to say…"
          className="flex-1 min-w-0 bg-black/60 border border-amber-600/40 rounded-lg px-2.5 py-1.5 text-[11px] text-amber-200 placeholder-amber-700/60 focus:outline-none focus:border-amber-400"
        />
        <button
          type="submit"
          disabled={!ready || busy !== null || !custom.trim()}
          className="px-2.5 py-1.5 rounded-lg bg-amber-600/30 border border-amber-500/40 text-[11px] text-amber-100 hover:bg-amber-600/50 disabled:opacity-40"
        >
          {busy === 'custom' ? 'Speaking' : 'Speak'}
        </button>
        <button
          type="button"
          onClick={stop}
          disabled={!isSpeaking && busy === null}
          aria-label="Stop speaking"
          className="p-1.5 rounded-lg border border-amber-700/40 text-amber-300 hover:border-amber-500/60 disabled:opacity-40"
        >
          <Square className="w-3 h-3" />
        </button>
      </form>

      {error && <p className="text-[11px] text-red-300 bg-red-950/40 border border-red-700/40 rounded px-2 py-1">{error}</p>}

      <p className="text-[10px] leading-snug text-amber-500/70">
        Everything is generated on this PC and never uploaded. Clone only a voice you own or are licensed to use.
        {basis && <> Cloning basis on record: {RIGHTS_LABELS[basis] ?? basis}.</>}
        {engine === 'chatterbox' && ' Chatterbox clips carry an inaudible watermark marking them as synthetic.'}
      </p>
    </div>
  );
}

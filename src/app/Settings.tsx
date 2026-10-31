import { useEffect, useState } from 'react';
import { CheckCircle2, ExternalLink, KeyRound, Link2, Loader2, LogOut, RefreshCw, Trash2, X, XCircle } from 'lucide-react';
import type { AIProvider, AISettings, VoiceEngine } from '../types';
import { brain, startOpenRouterPairing, type ModelOption } from '../agent/brain';
import {
  PROVIDERS, PROVIDER_LABELS, defaultModelFor, hasProviderKey, isKeyProvider, providerNeedsKey, removeProviderKey, saveProviderKey,
} from '../agent/settings';
import { canRememberWebSecrets } from '../agent/secrets-web';
import { OPENAI_TTS_VOICES } from '../agent/realtime/cloudTts';
import { invokeNative, isDesktopRuntime, type ChatGptAccount } from '../desktop/bridge';
import { wipeAll } from '../store/db';
import { DesktopCompanionPanel } from '../components/DesktopCompanionPanel';
import { VoiceLab } from '../components/VoiceLab';
import { speaker } from './speaker';

export interface SettingsProps {
  open: boolean;
  settings: AISettings;
  onChange(next: AISettings): void;
  onClose(): void;
}

type Tab = 'brain' | 'voice' | 'behavior' | 'desktop' | 'data';

const PROVIDER_HELP: Record<AIProvider, string> = {
  'tva-offline': 'Built in. No account or key. Still runs timers, reminders, schedule, notes, weather and search.',
  chatgpt: 'Use your ChatGPT Plus or Pro plan. Sign in once in your browser; no API key.',
  openrouter: 'Pair your OpenRouter account in your browser. One key for hundreds of models.',
  openai: 'Your OpenAI API key.',
  gemini: 'Your Google AI Studio API key.',
  anthropic: 'Your Anthropic API key.',
  ollama: 'Models running on this computer through Ollama.',
};

const field = 'w-full rounded-lg border border-amber-700/50 bg-black/50 px-3 py-2 text-sm text-amber-50 outline-none focus:border-amber-400';

export function Settings({ open, settings, onChange, onClose }: SettingsProps) {
  const [tab, setTab] = useState<Tab>('brain');
  if (!open) return null;
  const desktop = isDesktopRuntime();
  const set = (patch: Partial<AISettings>) => onChange({ ...settings, ...patch });
  const tabs: Array<[Tab, string]> = [['brain', 'Brain'], ['voice', 'Voice'], ['behavior', 'Behavior'], ...(desktop ? [['desktop', 'Desktop'] as [Tab, string]] : []), ['data', 'Data']];

  return (
    <div className="fixed inset-0 z-[10040] flex justify-end bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <aside className="flex h-full w-full max-w-xl flex-col border-l border-amber-700/50 bg-[#140d07] shadow-2xl" onClick={e => e.stopPropagation()} aria-label="Settings">
        <div className="flex items-center justify-between border-b border-amber-800/40 px-5 py-4">
          <h2 className="text-base font-bold uppercase tracking-[0.2em] text-amber-300">Settings</h2>
          <button type="button" onClick={onClose} aria-label="Close settings" className="rounded-lg p-1.5 text-amber-300 hover:bg-amber-900/40"><X className="h-5 w-5" /></button>
        </div>
        <div className="flex gap-1 border-b border-amber-800/40 px-4 py-2">
          {tabs.map(([id, label]) => (
            <button key={id} type="button" onClick={() => setTab(id)} className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${tab === id ? 'bg-amber-500 text-neutral-950' : 'text-amber-300 hover:bg-amber-900/40'}`}>{label}</button>
          ))}
        </div>
        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5 text-sm text-amber-100">
          {tab === 'brain' && <BrainSettings settings={settings} set={set} />}
          {tab === 'voice' && <VoiceSettings settings={settings} set={set} />}
          {tab === 'behavior' && <BehaviorSettings settings={settings} set={set} />}
          {tab === 'desktop' && desktop && (
            <div className="space-y-4">
              <DesktopCompanionPanel />
              <VoiceLab settings={settings} onSettingsChange={onChange} isSpeaking={false} />
            </div>
          )}
          {tab === 'data' && <DataSettings />}
        </div>
      </aside>
    </div>
  );
}

function Section({ title, children, hint }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-[11px] font-bold uppercase tracking-[0.2em] text-amber-400">{title}</h3>
      {hint && <p className="text-xs text-amber-300/70">{hint}</p>}
      {children}
    </section>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange(v: boolean): void }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 rounded-xl border border-amber-800/40 bg-black/30 px-3 py-2.5">
      <span>
        <span className="block text-sm text-amber-100">{label}</span>
        {hint && <span className="block text-xs text-amber-400/70">{hint}</span>}
      </span>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} className="mt-1 h-4 w-4 accent-amber-500" />
    </label>
  );
}

function BrainSettings({ settings, set }: { settings: AISettings; set(p: Partial<AISettings>): void }) {
  const desktop = isDesktopRuntime();
  const provider = settings.provider;
  const [key, setKey] = useState('');
  const [remember, setRemember] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [account, setAccount] = useState<ChatGptAccount | null>(null);
  const [pairCode, setPairCode] = useState('');
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTest(null); setError(null); setKey('');
    if (isKeyProvider(provider)) void hasProviderKey(provider).then(setHasKey).catch(() => setHasKey(false));
    else setHasKey(false);
    if (provider === 'chatgpt' && desktop) void invokeNative<ChatGptAccount>('chatgpt_account').then(setAccount).catch(() => setAccount(null));
  }, [provider, desktop]);

  const refreshModels = async () => {
    setLoadingModels(true);
    try { setModels(await brain.listModels(settings)); } finally { setLoadingModels(false); }
  };
  useEffect(() => { void refreshModels(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [provider, hasKey, account?.signedIn]);

  const saveKey = async () => {
    if (!isKeyProvider(provider) || !key.trim()) return;
    setBusy('key'); setError(null);
    try { await saveProviderKey(provider, key.trim(), { remember }); setKey(''); setHasKey(true); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };

  const signInChatGpt = async () => {
    setBusy('chatgpt'); setError(null);
    try { setAccount(await invokeNative<ChatGptAccount>('chatgpt_sign_in')); }
    catch (e) { setError(String(e)); }
    finally { setBusy(null); }
  };

  const pairOpenRouter = async (mode: 'loopback' | 'code') => {
    setError(null);
    if (!desktop) { startOpenRouterPairing(); return; }
    setBusy('openrouter');
    try {
      await invokeNative('openrouter_pair_start', { mode });
      if (mode === 'loopback') { await invokeNative('openrouter_pair_complete', { code: null }); setHasKey(true); }
      else setPairing(true);
    } catch (e) { setError(String(e)); }
    finally { setBusy(null); }
  };

  const finishCode = async () => {
    setBusy('openrouter'); setError(null);
    try { await invokeNative('openrouter_pair_complete', { code: pairCode.trim() }); setHasKey(true); setPairing(false); setPairCode(''); }
    catch (e) { setError(String(e)); }
    finally { setBusy(null); }
  };

  return (
    <>
      <Section title="Who powers her" hint="Pick where her thinking happens. You can switch any time.">
        <div className="grid grid-cols-2 gap-2">
          {PROVIDERS.map(p => (
            <button key={p} type="button" onClick={() => set({ provider: p, model: defaultModelFor(p) })}
              className={`rounded-xl border px-3 py-2 text-left ${p === provider ? 'border-amber-400 bg-amber-600/20' : 'border-amber-800/40 bg-black/30 hover:border-amber-600/60'}`}>
              <span className="block text-sm font-semibold text-amber-100">{PROVIDER_LABELS[p]}</span>
              {p === 'chatgpt' && !desktop && <span className="text-[10px] text-amber-500">desktop app</span>}
            </button>
          ))}
        </div>
        <p className="text-xs text-amber-300/80">{PROVIDER_HELP[provider]}</p>
      </Section>

      {provider === 'chatgpt' && (
        <Section title="ChatGPT plan">
          {!desktop ? (
            <p className="text-xs text-amber-300/80">Sign in with ChatGPT needs the Miss Minutes desktop app, so your sign-in tokens stay out of the browser.</p>
          ) : account?.signedIn ? (
            <div className="flex items-center justify-between rounded-xl border border-emerald-700/50 bg-emerald-950/30 px-3 py-2">
              <span className="text-xs">{account.email ?? 'Signed in'} · {account.planUsage ? 'using your ChatGPT plan' : 'plan usage not allowed'}</span>
              <button type="button" onClick={() => void invokeNative('chatgpt_sign_out').then(() => setAccount({ signedIn: false, email: null, planUsage: false, expiresAtUnixMs: null }))} className="flex items-center gap-1 text-xs text-amber-300 hover:text-amber-100"><LogOut className="h-3.5 w-3.5" /> Sign out</button>
            </div>
          ) : (
            <button type="button" onClick={signInChatGpt} disabled={busy === 'chatgpt'} className="flex items-center gap-2 rounded-xl bg-black px-4 py-2.5 text-sm font-semibold text-white ring-1 ring-white/20 hover:bg-neutral-900 disabled:opacity-50">
              {busy === 'chatgpt' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />} Continue with ChatGPT
            </button>
          )}
          <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-amber-400 hover:text-amber-200">Manage usage <ExternalLink className="h-3 w-3" /></a>
        </Section>
      )}

      {provider === 'openrouter' && (
        <Section title="Pair OpenRouter" hint="Sign in on OpenRouter and approve Miss Minutes. The key is created for you and saved securely.">
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void pairOpenRouter('loopback')} disabled={busy === 'openrouter'} className="flex items-center gap-2 rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-neutral-950 hover:bg-amber-400 disabled:opacity-50">
              {busy === 'openrouter' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />} Pair in browser
            </button>
            {desktop && <button type="button" onClick={() => void pairOpenRouter('code')} className="rounded-xl border border-amber-700/50 px-4 py-2 text-sm text-amber-200 hover:bg-amber-900/40">Use a pairing code</button>}
          </div>
          {pairing && (
            <div className="flex gap-2">
              <input value={pairCode} onChange={e => setPairCode(e.target.value)} placeholder="Paste the code OpenRouter shows" className={field} />
              <button type="button" onClick={finishCode} disabled={!pairCode.trim()} className="rounded-lg bg-amber-500 px-3 text-sm font-semibold text-neutral-950 disabled:opacity-40">Pair</button>
            </div>
          )}
          {hasKey && <p className="flex items-center gap-1 text-xs text-emerald-300"><CheckCircle2 className="h-3.5 w-3.5" /> Paired</p>}
        </Section>
      )}

      {providerNeedsKey(provider) && provider !== 'chatgpt' && (
        <Section title={provider === 'openrouter' ? 'Or paste a key' : 'API key'} hint={desktop ? 'Saved in the Windows Credential Manager. The app window never sees it again.' : 'Kept in memory for this session unless you choose to remember it (encrypted on this device).'}>
          <div className="flex gap-2">
            <input type="password" value={key} onChange={e => setKey(e.target.value)} placeholder={hasKey ? 'A key is saved. Paste a new one to replace it.' : 'Paste your key'} className={field} autoComplete="off" />
            <button type="button" onClick={saveKey} disabled={!key.trim() || busy === 'key'} className="flex items-center gap-1 rounded-lg bg-amber-500 px-3 text-sm font-semibold text-neutral-950 disabled:opacity-40"><KeyRound className="h-4 w-4" /> Save</button>
          </div>
          {!desktop && canRememberWebSecrets() && <Toggle label="Remember on this device" checked={remember} onChange={setRemember} />}
          {hasKey && isKeyProvider(provider) && (
            <button type="button" onClick={() => void removeProviderKey(provider).then(() => setHasKey(false))} className="text-xs text-red-300 hover:text-red-200">Remove saved key</button>
          )}
        </Section>
      )}

      {provider === 'ollama' && (
        <Section title="Ollama address">
          <input value={settings.customEndpoint ?? ''} onChange={e => set({ customEndpoint: e.target.value })} placeholder="http://localhost:11434/v1" className={field} />
        </Section>
      )}

      {provider !== 'tva-offline' && (
        <Section title="Model">
          <div className="flex gap-2">
            {models.length > 0 ? (
              <select value={settings.model} onChange={e => set({ model: e.target.value })} className={field}>
                {!models.some(m => m.id === settings.model) && settings.model && <option value={settings.model}>{settings.model}</option>}
                {models.map(m => <option key={m.id} value={m.id}>{m.label}{m.vision ? ' · sees images' : ''}</option>)}
              </select>
            ) : (
              <input value={settings.model} onChange={e => set({ model: e.target.value })} placeholder="Model id" className={field} />
            )}
            <button type="button" onClick={refreshModels} aria-label="Refresh models" className="rounded-lg border border-amber-700/50 px-2 text-amber-300 hover:bg-amber-900/40">
              {loadingModels ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </button>
          </div>
        </Section>
      )}

      <Section title="Check the connection">
        <button type="button" onClick={async () => { setBusy('test'); setTest(await brain.testConnection(settings)); setBusy(null); }} className="flex items-center gap-2 rounded-xl border border-amber-700/50 px-4 py-2 text-sm text-amber-200 hover:bg-amber-900/40">
          {busy === 'test' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Test
        </button>
        {test && <p className={`flex items-start gap-1.5 text-xs ${test.ok ? 'text-emerald-300' : 'text-red-300'}`}>{test.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}{test.message}</p>}
        {error && <p className="text-xs text-red-300">{error}</p>}
      </Section>
    </>
  );
}

function VoiceSettings({ settings, set }: { settings: AISettings; set(p: Partial<AISettings>): void }) {
  const desktop = isDesktopRuntime();
  const engine = settings.voiceEngine ?? 'system';
  const [elKey, setElKey] = useState('');
  const engines: Array<[VoiceEngine, string, string]> = [
    ['system', 'System voice', 'Built into Windows / your browser. Free, works offline.'],
    ['openai', 'OpenAI voice', 'Natural, expressive speech. Uses your OpenAI key.'],
    ['elevenlabs', 'ElevenLabs', 'Your own ElevenLabs voice (one you own or are licensed to use).'],
    ...(desktop ? [['local', 'On this PC', 'Private on-device engine. Slow on this laptop; best for short lines.'] as [VoiceEngine, string, string]] : []),
  ];
  return (
    <>
      <Toggle label="She talks out loud" checked={settings.voiceEnabled} onChange={v => set({ voiceEnabled: v })} />
      <Section title="Voice engine">
        <div className="space-y-2">
          {engines.map(([id, label, hint]) => (
            <button key={id} type="button" onClick={() => set({ voiceEngine: id })} className={`w-full rounded-xl border px-3 py-2 text-left ${engine === id ? 'border-amber-400 bg-amber-600/20' : 'border-amber-800/40 bg-black/30 hover:border-amber-600/60'}`}>
              <span className="block text-sm font-semibold">{label}</span>
              <span className="block text-xs text-amber-400/70">{hint}</span>
            </button>
          ))}
        </div>
      </Section>
      {engine === 'openai' && (
        <Section title="OpenAI voice" hint="Needs an OpenAI API key (Brain tab, OpenAI). The style is an original 1950s cartoon hostess.">
          <select value={settings.openaiVoice ?? 'coral'} onChange={e => set({ openaiVoice: e.target.value })} className={field}>
            {OPENAI_TTS_VOICES.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </Section>
      )}
      {engine === 'elevenlabs' && (
        <Section title="ElevenLabs">
          <div className="flex gap-2">
            <input type="password" value={elKey} onChange={e => setElKey(e.target.value)} placeholder="ElevenLabs API key" className={field} autoComplete="off" />
            <button type="button" disabled={!elKey.trim()} onClick={() => void saveProviderKey('elevenlabs', elKey.trim()).then(() => setElKey(''))} className="rounded-lg bg-amber-500 px-3 text-sm font-semibold text-neutral-950 disabled:opacity-40">Save</button>
          </div>
          <input value={settings.elevenLabsVoiceId ?? ''} onChange={e => set({ elevenLabsVoiceId: e.target.value.trim() })} placeholder="Voice ID from your ElevenLabs account" className={field} />
        </Section>
      )}
      {engine === 'system' && (
        <Section title="System voice tuning">
          <label className="block text-xs text-amber-300">Pitch {settings.voicePitch.toFixed(2)}
            <input type="range" min={0.6} max={1.8} step={0.02} value={settings.voicePitch} onChange={e => set({ voicePitch: Number(e.target.value) })} className="w-full accent-amber-500" />
          </label>
          <label className="block text-xs text-amber-300">Speed {settings.voiceRate.toFixed(2)}
            <input type="range" min={0.7} max={1.4} step={0.02} value={settings.voiceRate} onChange={e => set({ voiceRate: Number(e.target.value) })} className="w-full accent-amber-500" />
          </label>
        </Section>
      )}
      <button type="button" onClick={() => speaker.say("Well hey there, sugar! This is how I sound. Ain't that just peachy?", { ...settings, voiceEnabled: true })} className="rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-neutral-950 hover:bg-amber-400">Hear her</button>
    </>
  );
}

function BehaviorSettings({ settings, set }: { settings: AISettings; set(p: Partial<AISettings>): void }) {
  return (
    <>
      <Toggle label="Hologram look" hint="Glowing projection like in the show. Off for the flat cartoon." checked={settings.hologramMode} onChange={v => set({ hologramMode: v })} />
      <Toggle label="Remember things about me" hint="She learns your name, places, people and preferences from conversation. You can edit or wipe it in the Dossier." checked={settings.memoryEnabled !== false} onChange={v => set({ memoryEnabled: v })} />
      <Toggle label="Always ask first" hint="Ask before every action, even timers and notes. Files, commands and PC control always ask." checked={settings.strictApprovals === true} onChange={v => set({ strictApprovals: v })} />
      <Toggle label="Chatter" hint="Occasional remarks when you have been quiet for a while." checked={settings.ambientChatter !== false} onChange={v => set({ ambientChatter: v })} />
      <Toggle label="Sound effects" checked={settings.soundEffects} onChange={v => set({ soundEffects: v })} />
      <Section title="Home city" hint="For weather and local time.">
        <input value={settings.homeCity ?? ''} onChange={e => set({ homeCity: e.target.value })} placeholder="e.g. Pune" className={field} />
      </Section>
      <Section title="Her personality">
        <textarea rows={6} value={settings.systemPrompt} onChange={e => set({ systemPrompt: e.target.value })} className={`${field} font-mono text-xs`} />
      </Section>
    </>
  );
}

function DataSettings() {
  const [confirm, setConfirm] = useState(false);
  const [done, setDone] = useState(false);
  return (
    <Section title="Your data" hint="Conversations, memories, schedule, to-dos, timers and notes live only on this device.">
      {!confirm ? (
        <button type="button" onClick={() => setConfirm(true)} className="flex items-center gap-2 rounded-xl border border-red-700/60 px-4 py-2 text-sm text-red-200 hover:bg-red-950/40"><Trash2 className="h-4 w-4" /> Erase everything</button>
      ) : (
        <div className="space-y-2 rounded-xl border border-red-700/60 bg-red-950/30 p-3">
          <p className="text-xs text-red-200">This deletes every conversation, memory, reminder, timer, to-do and note on this device. It cannot be undone.</p>
          <div className="flex gap-2">
            <button type="button" onClick={() => void wipeAll().then(() => { setDone(true); setConfirm(false); })} className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white">Erase</button>
            <button type="button" onClick={() => setConfirm(false)} className="rounded-lg border border-amber-700/50 px-3 py-1.5 text-sm text-amber-200">Cancel</button>
          </div>
        </div>
      )}
      {done && <p className="text-xs text-emerald-300">Done. Everything is erased.</p>}
    </Section>
  );
}

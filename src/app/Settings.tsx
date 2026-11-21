import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Database,
  ExternalLink,
  Fingerprint,
  KeyRound,
  Link2,
  Loader2,
  Lock,
  LogOut,
  Mic,
  Monitor,
  PhoneCall,
  Plus,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  Trash2,
  Volume2,
  X,
  XCircle,
} from 'lucide-react';
import type { AIProvider, AISettings, VoiceEngine } from '../types';
import { brain, startOpenRouterPairing, type ModelOption } from '../agent/brain';
import {
  PROVIDERS, PROVIDER_LABELS, defaultModelFor, hasProviderKey, isKeyProvider, providerNeedsKey, removeProviderKey, saveProviderKey,
} from '../agent/settings';
import { canRememberWebSecrets } from '../agent/secrets-web';
import { OPENAI_TTS_VOICES } from '../agent/realtime/cloudTts';
import {
  DEFAULT_QUIET_END_MIN,
  DEFAULT_QUIET_START_MIN,
  isValidE164,
} from '../agent/tools/calling';
import { feedWakeScore, invokeNative, isDesktopRuntime, type ChatGptAccount, type DesktopOwnerStatus, type WakeOutcome } from '../desktop/bridge';
import { wipeAll } from '../store/db';
import { DesktopCompanionPanel } from '../components/DesktopCompanionPanel';
import { VoiceLab } from '../components/VoiceLab';
import { speaker, useActiveVoice } from './speaker';

export interface SettingsProps {
  open: boolean;
  settings: AISettings;
  onChange(next: AISettings): void;
  onClose(): void;
  ownerStatus?: DesktopOwnerStatus | null;
  onOwnerStatusChange?: (status: DesktopOwnerStatus) => void;
  ownerDataReady?: boolean;
  initialTab?: Tab;
}

export type SettingsTab = Tab;
type Tab = 'brain' | 'voice' | 'behavior' | 'desktop' | 'security' | 'data';

const PROVIDER_HELP: Record<AIProvider, string> = {
  'tva-offline': 'Built in. No account or key. Still runs timers, reminders, schedule, notes, weather and search.',
  chatgpt: 'Use your ChatGPT Plus or Pro plan. Sign in once in your browser; no API key.',
  openrouter: 'Pair your OpenRouter account in your browser. One key for hundreds of models.',
  openai: 'Your OpenAI API key.',
  gemini: 'Your Google AI Studio API key.',
  anthropic: 'Your Anthropic API key.',
  ollama: 'Models running on this computer through Ollama.',
};

const field =
  'w-full rounded-xl border border-white/[0.12] bg-[#0B0908] px-3.5 py-2.5 text-sm text-[#F5EFE6] placeholder:text-[#786B5E] outline-none transition-colors focus:border-[#FF7A1A]/70 focus-visible:ring-2 focus-visible:ring-[#FF7A1A]/30';

export function Settings({
  open,
  settings,
  onChange,
  onClose,
  ownerStatus,
  onOwnerStatusChange,
  ownerDataReady = true,
  initialTab,
}: SettingsProps) {
  const [tab, setTab] = useState<Tab>(initialTab ?? 'brain');

  useEffect(() => {
    if (open && initialTab) setTab(initialTab);
  }, [open, initialTab]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const desktop = isDesktopRuntime();
  const authenticated = !desktop || ownerStatus?.authenticated === true;
  const desktopLocked = desktop && (!authenticated || !ownerDataReady);
  const set = (patch: Partial<AISettings>) => onChange({ ...settings, ...patch });

  const tabs: Array<{ id: Tab; label: string; icon: typeof Sparkles }> = [
    { id: 'brain', label: 'Brain & models', icon: Sparkles },
    { id: 'voice', label: 'Voice', icon: Volume2 },
    { id: 'behavior', label: 'Behavior', icon: SlidersHorizontal },
    ...(desktop
      ? [
          { id: 'desktop' as const, label: 'Desktop', icon: Monitor },
          { id: 'security' as const, label: 'Owner security', icon: ShieldCheck },
        ]
      : []),
    { id: 'data', label: 'Data', icon: Database },
  ];

  const renderLockedNotice = (sectionName: string) => (
    <div className="space-y-3 rounded-2xl border border-white/[0.08] bg-[#17120E] p-6 text-center">
      <div className="mx-auto grid h-11 w-11 place-items-center rounded-2xl bg-[#FF7A1A]/15 text-[#FF9240]">
        <Lock className="h-5 w-5" />
      </div>
      <div>
        <p className="text-sm font-semibold text-[#FFF8EE]">
          {authenticated ? 'Unlocking encrypted owner data…' : `${sectionName} requires owner verification`}
        </p>
        <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-[#9D9082]">
          {authenticated
            ? 'Preparing your local encrypted SQLCipher vault before loading owner settings.'
            : ownerStatus?.enrolled
              ? 'Verify identity with Windows Hello in Owner security before viewing or modifying owner settings.'
              : 'Enroll this desktop in Owner security first to protect provider settings, keys, and local owner data.'}
        </p>
      </div>
      {!authenticated && (
        <button
          type="button"
          onClick={() => setTab('security')}
          className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-xl bg-[#FF7A1A] px-4 text-xs font-semibold text-[#110C07] transition-colors hover:bg-[#FF903B]"
        >
          <Fingerprint className="h-4 w-4" />
          Open Owner security
        </button>
      )}
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-[10040] flex items-center justify-center bg-black/75 p-3 backdrop-blur-sm sm:p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={e => e.stopPropagation()}
        className="flex h-[min(88vh,740px)] w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-white/[0.1] bg-[#120E0B] shadow-[0_24px_80px_rgba(0,0,0,0.85)] sm:flex-row"
      >
        {/* Left Navigation Rail (Desktop) / Top Horizontal Pills (<sm) */}
        <aside className="flex shrink-0 flex-col border-b border-white/[0.06] bg-[#0E0B09] sm:w-56 sm:border-b-0 sm:border-r">
          <div className="flex items-center justify-between px-4 py-3.5 sm:px-5 sm:pt-5 sm:pb-3">
            <h2 className="text-base font-semibold tracking-tight text-[#FFF8EE]">Settings</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close settings"
              className="grid h-8 w-8 cursor-pointer place-items-center rounded-xl text-[#9D9082] transition-colors hover:bg-white/[0.06] hover:text-[#FFF8EE] sm:hidden"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <nav
            aria-label="Settings categories"
            className="flex gap-1 overflow-x-auto px-3 pb-3 sm:flex-col sm:gap-0.5 sm:overflow-visible sm:px-3"
          >
            {tabs.map(({ id, label, icon: Icon }) => {
              const selected = tab === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTab(id)}
                  className={`flex shrink-0 cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF7A1A] ${
                    selected
                      ? 'bg-white/[0.09] text-[#FFF8EE]'
                      : 'text-[#9D9082] hover:bg-white/[0.04] hover:text-[#F5EFE6]'
                  }`}
                >
                  <Icon className={`h-4 w-4 shrink-0 ${selected ? 'text-[#FF9240]' : 'text-[#8E8172]'}`} />
                  <span className="whitespace-nowrap">{label}</span>
                </button>
              );
            })}
          </nav>
        </aside>

        {/* Right Detail Content */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <header className="hidden h-14 shrink-0 items-center justify-between border-b border-white/[0.06] px-6 sm:flex">
            <span className="text-sm font-semibold text-[#FFF8EE]">
              {tabs.find(t => t.id === tab)?.label}
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close settings"
              className="grid h-8 w-8 cursor-pointer place-items-center rounded-xl text-[#9D9082] transition-colors hover:bg-white/[0.06] hover:text-[#FFF8EE] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF7A1A]"
            >
              <X className="h-4 w-4" />
            </button>
          </header>

          <div className="flex-1 space-y-5 overflow-y-auto px-4 py-5 text-sm text-[#F5EFE6] sm:px-6">
            {tab === 'brain' && (desktopLocked ? renderLockedNotice('AI & provider configuration') : <BrainSettings settings={settings} set={set} />)}
            {tab === 'voice' && (desktopLocked ? renderLockedNotice('Voice configuration') : <VoiceSettings settings={settings} set={set} onSettingsChange={onChange} />)}
            {tab === 'behavior' && (desktopLocked ? renderLockedNotice('Behavior & personal notes') : <BehaviorSettings settings={settings} set={set} />)}
            {tab === 'desktop' && desktop && (
              desktopLocked ? renderLockedNotice('Desktop companion') : (
                <div className="space-y-4">
                  <DesktopCompanionPanel authenticated={authenticated && ownerDataReady} />
                </div>
              )
            )}
            {tab === 'security' && desktop && (
              <DesktopOwnerSecurity initialStatus={ownerStatus} onStatusChange={onOwnerStatusChange} />
            )}
            {tab === 'data' && (desktopLocked ? renderLockedNotice('Owner data management') : <DataSettings />)}
          </div>
        </div>
      </div>
    </div>
  );
}

function DesktopOwnerSecurity({
  initialStatus,
  onStatusChange,
}: {
  initialStatus?: DesktopOwnerStatus | null;
  onStatusChange?: (status: DesktopOwnerStatus) => void;
}) {
  const [status, setStatus] = useState<DesktopOwnerStatus | null>(initialStatus ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pairRequest, setPairRequest] = useState('');
  const [pairReceipt, setPairReceipt] = useState('');
  const [recoveryMaterial, setRecoveryMaterial] = useState('');
  const [recoveryPassphrase, setRecoveryPassphrase] = useState('');

  useEffect(() => {
    if (initialStatus !== undefined) setStatus(initialStatus);
  }, [initialStatus]);

  const applyStatus = (next: DesktopOwnerStatus) => {
    setStatus(next);
    onStatusChange?.(next);
  };

  const refresh = async () => {
    const next = await invokeNative<DesktopOwnerStatus>('owner_status');
    applyStatus(next);
    return next;
  };
  useEffect(() => { void refresh().catch(e => setError(errorText(e))); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const perform = async (operation: string, action: () => Promise<DesktopOwnerStatus | void>, success: string) => {
    setBusy(operation); setError(null); setNotice(null);
    try {
      const result = await action();
      if (result) applyStatus(result);
      else await refresh();
      setNotice(success);
    } catch (e) {
      setError(errorText(e));
      try { await refresh(); } catch { /* preserve the primary operation error */ }
    } finally { setBusy(null); }
  };

  const authenticated = status?.authenticated === true;
  const enrolled = status?.enrolled === true;
  const ownerCandidate = status?.mode === 'owner_candidate';
  const modeLabel = status
    ? status.mode === 'owner_mode'
      ? 'Owner Mode'
      : status.mode === 'owner_candidate'
        ? 'Owner Candidate'
        : 'Guest Mode'
    : 'Checking…';

  return (
    <div className="space-y-5">
      <Section title="Owner identity" hint="Desktop owner authority is protected by Windows Hello through the platform WebAuthn API. Recognition signals prepare Owner Candidate mode; Windows Hello establishes the authenticated Owner session.">
        <div className="rounded-2xl border border-white/[0.08] bg-[#16120E] p-4">
          <div className="flex items-start gap-3">
            <div className="rounded-xl bg-[#FF7A1A]/15 p-2.5 text-[#FF9240]"><ShieldCheck className="h-5 w-5" /></div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <strong className="text-[#FFF8EE]">
                  {status ? authenticated ? 'Owner session active' : ownerCandidate ? 'Owner candidate detected' : enrolled ? 'Owner locked' : 'Owner not enrolled' : 'Checking owner status…'}
                </strong>
                <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                  authenticated
                    ? 'bg-emerald-500/15 text-emerald-300'
                    : ownerCandidate
                      ? 'bg-[#FF7A1A]/20 text-[#FFD9B3]'
                      : 'bg-white/[0.07] text-[#CBBEB0]'
                }`}>
                  {modeLabel}
                </span>
              </div>
              <p className="mt-1 break-words text-xs text-[#9D9082]">
                Platform: {status?.platform ?? '—'}
                {authenticated && status?.sessionId ? ` · Session ${status.sessionId.slice(0, 8)}…` : ''}
                {ownerCandidate && status ? ` · Confidence ${Math.round(status.candidateConfidence * 100)}% (verification needed)` : ''}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void refresh().catch(e => setError(errorText(e)))}
              aria-label="Refresh owner status"
              className="cursor-pointer rounded-xl p-2 text-[#9D9082] transition-colors hover:bg-white/[0.06] hover:text-[#FFF8EE]"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {!enrolled ? (
              <button
                type="button"
                disabled={!!busy}
                onClick={() => void perform('enroll', () => invokeNative<DesktopOwnerStatus>('owner_enroll'), 'Owner credential enrolled and protected locally.')}
                className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl bg-[#FF7A1A] px-4 py-2 text-sm font-semibold text-[#110C07] transition-colors hover:bg-[#FF903B] disabled:opacity-50"
              >
                <Fingerprint className="h-4 w-4" />
                {busy === 'enroll' ? 'Waiting for Windows Hello…' : 'Enroll this desktop'}
              </button>
            ) : authenticated ? (
              <button
                type="button"
                disabled={!!busy}
                onClick={() => void perform('lock', () => invokeNative<DesktopOwnerStatus>('owner_lock'), 'Owner session locked.')}
                className="min-h-11 cursor-pointer rounded-xl border border-white/[0.12] bg-white/[0.04] px-4 py-2 text-sm font-medium text-[#FFF8EE] transition-colors hover:bg-white/[0.08] disabled:opacity-50"
              >
                {busy === 'lock' ? 'Locking…' : 'Lock owner session'}
              </button>
            ) : (
              <button
                type="button"
                disabled={!!busy}
                onClick={() => void perform('authenticate', () => invokeNative<DesktopOwnerStatus>('owner_authenticate'), 'Windows Hello verified. Owner session is active.')}
                className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl bg-[#FF7A1A] px-4 py-2 text-sm font-semibold text-[#110C07] transition-colors hover:bg-[#FF903B] disabled:opacity-50"
              >
                <Fingerprint className="h-4 w-4" />
                {busy === 'authenticate' ? 'Waiting for Windows Hello…' : 'Verify owner'}
              </button>
            )}
          </div>
        </div>
      </Section>

      {enrolled && (
        <Section title="Pair Android device" hint="On Android, create an owner pairing request and transfer its JSON here. Confirm the displayed fingerprint on both devices before importing the signed receipt on Android.">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-[#CBBEB0]">Android pairing request</span>
            <textarea
              value={pairRequest}
              onChange={e => setPairRequest(e.target.value)}
              rows={4}
              spellCheck={false}
              autoCapitalize="off"
              className={`${field} resize-y font-mono text-xs`}
              placeholder="Paste the pairing request JSON from Android"
            />
          </label>
          <button
            type="button"
            disabled={!authenticated || !!busy || !pairRequest.trim()}
            onClick={() => void perform('pair', async () => {
              const receipt = await invokeNative<string>('owner_pair_android', { requestJson: pairRequest.trim() });
              setPairReceipt(receipt);
              return;
            }, 'Pairing receipt signed. Import it on the Android device to finish pairing.')}
            className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-white/[0.12] bg-white/[0.04] px-4 py-2 text-sm font-medium text-[#FFF8EE] transition-colors hover:bg-white/[0.08] disabled:opacity-40"
          >
            <Smartphone className="h-4 w-4" />
            {busy === 'pair' ? 'Waiting for approval…' : 'Approve Android pairing'}
          </button>
          {!authenticated && <p className="text-xs text-[#9D9082]">Verify the owner first to approve a device.</p>}
          {pairReceipt && (
            <div className="space-y-2 rounded-2xl border border-emerald-600/35 bg-emerald-950/20 p-3.5">
              <p className="text-xs font-semibold text-emerald-200">Signed pairing receipt</p>
              {pairingFingerprint(pairReceipt) && (
                <p className="break-all rounded-xl bg-black/40 p-2 font-mono text-xs text-emerald-300">
                  Compare on both devices: {pairingFingerprint(pairReceipt)}
                </p>
              )}
              <textarea readOnly value={pairReceipt} rows={5} aria-label="Signed pairing receipt" className={`${field} resize-y font-mono text-xs`} />
              <button
                type="button"
                onClick={() => void navigator.clipboard.writeText(pairReceipt).then(() => setNotice('Pairing receipt copied.')).catch(e => setError(errorText(e)))}
                className="cursor-pointer text-xs font-medium text-[#FF9240] underline"
              >
                Copy receipt for Android
              </button>
            </div>
          )}
        </Section>
      )}

      {!enrolled && (
        <Section title="Recovery" hint="For a clean desktop installation only. Import the offline recovery kit created on an already enrolled Android device. Recovery registers a new Windows Hello credential and does not restore an owner session.">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-[#CBBEB0]">Recovery kit</span>
            <textarea
              value={recoveryMaterial}
              onChange={e => setRecoveryMaterial(e.target.value)}
              rows={4}
              spellCheck={false}
              autoCapitalize="off"
              className={`${field} resize-y font-mono text-xs`}
              placeholder="Paste the encrypted recovery kit"
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-[#CBBEB0]">Kit passphrase</span>
            <input type="password" autoComplete="off" value={recoveryPassphrase} onChange={e => setRecoveryPassphrase(e.target.value)} className={field} />
          </label>
          <button
            type="button"
            disabled={!!busy || !recoveryMaterial.trim() || recoveryPassphrase.length < 8}
            onClick={() => void perform('recover', async () => {
              const recovered = await invokeNative<DesktopOwnerStatus>('owner_recover_android_kit', { material: recoveryMaterial.trim(), passphrase: recoveryPassphrase });
              setRecoveryMaterial('');
              setRecoveryPassphrase('');
              return recovered;
            }, 'Recovery completed. Verify with Windows Hello to unlock owner capabilities.')}
            className="min-h-11 cursor-pointer rounded-xl border border-white/[0.12] bg-white/[0.04] px-4 py-2 text-sm font-medium text-[#FFF8EE] transition-colors hover:bg-white/[0.08] disabled:opacity-40"
          >
            {busy === 'recover' ? 'Recovering…' : 'Recover desktop owner'}
          </button>
        </Section>
      )}

      {error && <div role="alert" className="rounded-xl border border-red-500/40 bg-red-950/30 px-3.5 py-2.5 text-xs text-red-200">{error}</div>}
      {notice && <div role="status" className="rounded-xl border border-emerald-500/35 bg-emerald-950/25 px-3.5 py-2.5 text-xs text-emerald-200">{notice}</div>}
    </div>
  );
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function pairingFingerprint(receipt: string): string | null {
  try {
    const value: unknown = JSON.parse(receipt);
    if (value && typeof value === 'object' && 'sourceFingerprint' in value && typeof value.sourceFingerprint === 'string') return value.sourceFingerprint;
  } catch { /* receipt validation remains authoritative in Android's importer */ }
  return null;
}

function Section({ title, children, hint }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2.5">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[#FF9240]">{title}</h3>
        {hint && <p className="mt-0.5 text-xs leading-relaxed text-[#9D9082]">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange(v: boolean): void }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 rounded-2xl border border-white/[0.08] bg-[#16120E] px-4 py-3 transition-colors hover:border-white/[0.14]">
      <span>
        <span className="block text-sm font-medium text-[#FFF8EE]">{label}</span>
        {hint && <span className="mt-0.5 block text-xs leading-snug text-[#9D9082]">{hint}</span>}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 shrink-0 cursor-pointer accent-[#FF7A1A]"
      />
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
      <Section title="AI Provider" hint="Pick where her thinking happens. You can switch any time.">
        <div className="grid grid-cols-2 gap-2">
          {PROVIDERS.map(p => (
            <button
              key={p}
              type="button"
              onClick={() => set({ provider: p, model: defaultModelFor(p) })}
              className={`cursor-pointer rounded-2xl border px-3.5 py-2.5 text-left transition-colors ${
                p === provider
                  ? 'border-[#FF7A1A]/70 bg-[#FF7A1A]/15 text-[#FFF8EE]'
                  : 'border-white/[0.08] bg-[#16120E] text-[#CBBEB0] hover:border-white/[0.16] hover:text-[#FFF8EE]'
              }`}
            >
              <span className="block text-sm font-medium">{PROVIDER_LABELS[p]}</span>
              {p === 'chatgpt' && !desktop && <span className="text-[10px] text-[#9D9082]">desktop app</span>}
            </button>
          ))}
        </div>
        <p className="text-xs leading-relaxed text-[#9D9082]">{PROVIDER_HELP[provider]}</p>
      </Section>

      {provider === 'chatgpt' && (
        <Section title="ChatGPT plan">
          {!desktop ? (
            <p className="text-xs text-[#9D9082]">Sign in with ChatGPT needs the Miss Minutes desktop app, so your sign-in tokens stay out of the browser.</p>
          ) : account?.signedIn ? (
            <div className="flex items-center justify-between rounded-2xl border border-emerald-500/35 bg-emerald-950/20 px-3.5 py-2.5">
              <span className="text-xs text-emerald-100">{account.email ?? 'Signed in'} · {account.planUsage ? 'using your ChatGPT plan' : 'plan usage not allowed'}</span>
              <button
                type="button"
                onClick={() => void invokeNative('chatgpt_sign_out').then(() => setAccount({ signedIn: false, email: null, planUsage: false, expiresAtUnixMs: null }))}
                className="flex cursor-pointer items-center gap-1 text-xs text-[#CBBEB0] hover:text-[#FFF8EE]"
              >
                <LogOut className="h-3.5 w-3.5" /> Sign out
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={signInChatGpt}
              disabled={busy === 'chatgpt'}
              className="flex cursor-pointer items-center gap-2 rounded-xl bg-black px-4 py-2.5 text-sm font-semibold text-white ring-1 ring-white/20 transition-colors hover:bg-neutral-900 disabled:opacity-50"
            >
              {busy === 'chatgpt' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />} Continue with ChatGPT
            </button>
          )}
          <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-[#FF9240] hover:underline">
            Manage usage <ExternalLink className="h-3 w-3" />
          </a>
        </Section>
      )}

      {provider === 'openrouter' && (
        <Section title="Pair OpenRouter" hint="Sign in on OpenRouter and approve Miss Minutes. The key is created for you and saved securely.">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void pairOpenRouter('loopback')}
              disabled={busy === 'openrouter'}
              className="flex cursor-pointer items-center gap-2 rounded-xl bg-[#FF7A1A] px-4 py-2 text-sm font-semibold text-[#110C07] transition-colors hover:bg-[#FF903B] disabled:opacity-50"
            >
              {busy === 'openrouter' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />} Pair in browser
            </button>
            {desktop && (
              <button
                type="button"
                onClick={() => void pairOpenRouter('code')}
                className="cursor-pointer rounded-xl border border-white/[0.12] bg-white/[0.04] px-4 py-2 text-sm text-[#F5EFE6] transition-colors hover:bg-white/[0.08]"
              >
                Use a pairing code
              </button>
            )}
          </div>
          {pairing && (
            <div className="flex gap-2">
              <input value={pairCode} onChange={e => setPairCode(e.target.value)} placeholder="Paste the code OpenRouter shows" className={field} />
              <button type="button" onClick={finishCode} disabled={!pairCode.trim()} className="cursor-pointer rounded-xl bg-[#FF7A1A] px-3.5 text-sm font-semibold text-[#110C07] disabled:opacity-40">Pair</button>
            </div>
          )}
          {hasKey && <p className="flex items-center gap-1.5 text-xs text-emerald-300"><CheckCircle2 className="h-3.5 w-3.5" /> Paired</p>}
        </Section>
      )}

      {providerNeedsKey(provider) && provider !== 'chatgpt' && (
        <Section
          title={provider === 'openrouter' ? 'Or paste a key' : 'API key'}
          hint={desktop ? 'Saved in the Windows Credential Manager. The app window never sees it again.' : 'Kept in memory for this session unless you choose to remember it (encrypted on this device).'}
        >
          <div className="flex gap-2">
            <input type="password" value={key} onChange={e => setKey(e.target.value)} placeholder={hasKey ? 'A key is saved. Paste a new one to replace it.' : 'Paste your key'} className={field} autoComplete="off" />
            <button
              type="button"
              onClick={saveKey}
              disabled={!key.trim() || busy === 'key'}
              className="flex cursor-pointer items-center gap-1.5 rounded-xl bg-[#FF7A1A] px-4 text-sm font-semibold text-[#110C07] transition-colors hover:bg-[#FF903B] disabled:opacity-40"
            >
              <KeyRound className="h-4 w-4" /> Save
            </button>
          </div>
          {!desktop && canRememberWebSecrets() && <Toggle label="Remember on this device" checked={remember} onChange={setRemember} />}
          {hasKey && isKeyProvider(provider) && (
            <button type="button" onClick={() => void removeProviderKey(provider).then(() => setHasKey(false))} className="cursor-pointer text-xs text-red-300 hover:underline">
              Remove saved key
            </button>
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
            <button
              type="button"
              onClick={refreshModels}
              aria-label="Refresh models"
              className="cursor-pointer rounded-xl border border-white/[0.1] bg-white/[0.03] px-3 text-[#CBBEB0] transition-colors hover:bg-white/[0.08] hover:text-[#FFF8EE]"
            >
              {loadingModels ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </button>
          </div>
        </Section>
      )}

      <Section title="Check the connection">
        <button
          type="button"
          onClick={async () => { setBusy('test'); setTest(await brain.testConnection(settings)); setBusy(null); }}
          className="flex cursor-pointer items-center gap-2 rounded-xl border border-white/[0.12] bg-white/[0.04] px-4 py-2 text-sm text-[#FFF8EE] transition-colors hover:bg-white/[0.08]"
        >
          {busy === 'test' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4 text-[#FF9240]" />} Test connection
        </button>
        {test && (
          <p className={`flex items-start gap-1.5 text-xs ${test.ok ? 'text-emerald-300' : 'text-red-300'}`}>
            {test.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
            {test.message}
          </p>
        )}
        {error && <p className="text-xs text-red-300">{error}</p>}
      </Section>
    </>
  );
}

function fmtMins(mins: number): string {
  const clamped = ((Math.round(mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`;
}

function parseMins(text: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function VoiceSettings({ settings, set, onSettingsChange }: { settings: AISettings; set(p: Partial<AISettings>): void; onSettingsChange(next: AISettings): void }) {
  const desktop = isDesktopRuntime();
  const engine = settings.voiceEngine ?? 'system';
  const active = useActiveVoice(settings);
  const [elKey, setElKey] = useState('');
  const [hasElKey, setHasElKey] = useState(false);

  useEffect(() => {
    let activeMount = true;
    const check = () => {
      void hasProviderKey('elevenlabs')
        .then(v => { if (activeMount) setHasElKey(v); })
        .catch(() => { if (activeMount) setHasElKey(false); });
    };
    check();
    window.addEventListener('miss-minutes:keys-changed', check);
    return () => {
      activeMount = false;
      window.removeEventListener('miss-minutes:keys-changed', check);
    };
  }, []);

  const engines: Array<[VoiceEngine, string, string]> = [
    ...(desktop ? [['local', 'Her cloned voice', 'Cloned from the prepared reference and rendered on this PC. Nothing is uploaded.'] as [VoiceEngine, string, string]] : []),
    ['system', 'System voice', 'Built into Windows / your browser. Free, works offline.'],
    ['openai', 'OpenAI voice', 'Natural, expressive speech in an original 1950s hostess style. Uses your OpenAI key.'],
    ['elevenlabs', 'ElevenLabs', 'Your own ElevenLabs voice (one you own or are licensed to use).'],
  ];
  return (
    <>
      <Toggle label="She talks out loud" checked={settings.voiceEnabled} onChange={v => set({ voiceEnabled: v })} />
      <div role="status" className={`rounded-2xl border px-4 py-3 ${active.reason ? 'border-[#FF7A1A]/40 bg-[#FF7A1A]/10' : 'border-emerald-500/35 bg-emerald-950/20'}`}>
        <span className="block text-[10px] font-semibold uppercase tracking-wider text-[#9D9082]">Speaking with</span>
        <span className="mt-0.5 block text-sm font-semibold text-[#FFF8EE]">{active.label}</span>
        {active.reason && <span className="mt-0.5 block text-xs text-[#FFD9B3]">Why: {active.reason}</span>}
      </div>
      <Section title="Voice engine">
        <div className="space-y-2">
          {engines.map(([id, label, hint]) => (
            <button
              key={id}
              type="button"
              onClick={() => set({ voiceEngine: id, voiceEngineChosen: true, localVoice: id === 'local' })}
              className={`w-full cursor-pointer rounded-2xl border px-4 py-2.5 text-left transition-colors ${
                engine === id
                  ? 'border-[#FF7A1A]/70 bg-[#FF7A1A]/15 text-[#FFF8EE]'
                  : 'border-white/[0.08] bg-[#16120E] text-[#CBBEB0] hover:border-white/[0.16]'
              }`}
            >
              <span className="block text-sm font-medium text-[#FFF8EE]">{label}</span>
              <span className="mt-0.5 block text-xs text-[#9D9082]">{hint}</span>
            </button>
          ))}
        </div>
      </Section>
      {desktop && <VoiceLab settings={settings} onSettingsChange={onSettingsChange} isSpeaking={false} />}
      {engine === 'openai' && (
        <Section title="OpenAI voice" hint="Needs an OpenAI API key (Brain & models tab). The style is an original 1950s cartoon hostess.">
          <select value={settings.openaiVoice ?? 'coral'} onChange={e => set({ openaiVoice: e.target.value })} className={field}>
            {OPENAI_TTS_VOICES.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </Section>
      )}
      {engine === 'elevenlabs' && (
        <Section title="ElevenLabs">
          <div className="flex gap-2">
            <input
              type="password"
              value={elKey}
              onChange={e => setElKey(e.target.value)}
              placeholder={hasElKey ? 'A key is saved. Paste to replace.' : 'ElevenLabs API key'}
              className={field}
              autoComplete="off"
            />
            <button
              type="button"
              disabled={!elKey.trim()}
              onClick={() => void saveProviderKey('elevenlabs', elKey.trim()).then(() => { setElKey(''); setHasElKey(true); })}
              className="cursor-pointer rounded-xl bg-[#FF7A1A] px-4 text-sm font-semibold text-[#110C07] disabled:opacity-40"
            >
              Save
            </button>
          </div>
          {hasElKey && (
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5 text-emerald-300">
                <CheckCircle2 className="h-3.5 w-3.5" /> ElevenLabs key saved
              </span>
              <button
                type="button"
                onClick={() => void removeProviderKey('elevenlabs').then(() => setHasElKey(false))}
                className="cursor-pointer text-red-300 hover:underline"
              >
                Remove saved key
              </button>
            </div>
          )}
          <input value={settings.elevenLabsVoiceId ?? ''} onChange={e => set({ elevenLabsVoiceId: e.target.value.trim() })} placeholder="Voice ID from your ElevenLabs account" className={field} />
        </Section>
      )}
      {engine === 'system' && (
        <Section title="System voice tuning">
          <label className="block text-xs text-[#CBBEB0]">
            Pitch <span className="font-mono text-[#FFF8EE]">{settings.voicePitch.toFixed(2)}</span>
            <input type="range" min={0.6} max={1.8} step={0.02} value={settings.voicePitch} onChange={e => set({ voicePitch: Number(e.target.value) })} className="mt-1 w-full accent-[#FF7A1A]" />
          </label>
          <label className="block text-xs text-[#CBBEB0]">
            Speed <span className="font-mono text-[#FFF8EE]">{settings.voiceRate.toFixed(2)}</span>
            <input type="range" min={0.7} max={1.4} step={0.02} value={settings.voiceRate} onChange={e => set({ voiceRate: Number(e.target.value) })} className="mt-1 w-full accent-[#FF7A1A]" />
          </label>
        </Section>
      )}
      <button
        type="button"
        onClick={() => speaker.say("Well hello there! This is how I sound. Ready when you are!", { ...settings, voiceEnabled: true })}
        className="cursor-pointer rounded-xl bg-[#FF7A1A] px-4 py-2 text-sm font-semibold text-[#110C07] transition-colors hover:bg-[#FF903B]"
      >
        Hear her voice
      </button>
    </>
  );
}

function BehaviorSettings({ settings, set }: { settings: AISettings; set(p: Partial<AISettings>): void }) {
  const desktop = isDesktopRuntime();
  const [newPhrase, setNewPhrase] = useState('');
  const [wakeStatusText, setWakeStatusText] = useState<string | null>(null);
  const [newDnc, setNewDnc] = useState('');
  const [dncError, setDncError] = useState<string | null>(null);

  const customPhrases = settings.customWakePhrases ?? [];
  const dncList = settings.dncNumbers ?? [];

  const addPhrase = () => {
    const clean = newPhrase.trim();
    if (!clean) return;
    if (customPhrases.some(p => p.toLowerCase() === clean.toLowerCase())) {
      setNewPhrase('');
      return;
    }
    set({ customWakePhrases: [...customPhrases, clean].slice(0, 16) });
    setNewPhrase('');
  };

  const addDncNumber = () => {
    const clean = newDnc.trim();
    if (!isValidE164(clean)) {
      setDncError('Enter strict E.164 format, e.g. +12025550199');
      return;
    }
    setDncError(null);
    if (!dncList.includes(clean)) {
      set({ dncNumbers: [...dncList, clean] });
    }
    setNewDnc('');
  };

  return (
    <>
      <Toggle label="Hologram look" hint="Glowing projection like in the show. Off for the flat cartoon." checked={settings.hologramMode} onChange={v => set({ hologramMode: v })} />
      <Toggle label="Remember things about me" hint="She learns your name, places, people and preferences from conversation. You can edit or wipe it in the Dossier." checked={settings.memoryEnabled !== false} onChange={v => set({ memoryEnabled: v })} />
      <Toggle label="Always ask first" hint="Ask before every action, even timers and notes. Files, commands and PC control always ask." checked={settings.strictApprovals === true} onChange={v => set({ strictApprovals: v })} />
      <Toggle label="Chatter" hint="Occasional remarks when you have been quiet for a while." checked={settings.ambientChatter !== false} onChange={v => set({ ambientChatter: v })} />
      <Toggle label="Sound effects" checked={settings.soundEffects} onChange={v => set({ soundEffects: v })} />

      <Section title="Wake-word engine" hint="Custom wake phrases raise Owner Candidate presence locally; Windows Hello is still required to unlock privileged controls.">
        <Toggle
          label="Enable wake-word listening"
          hint="Built-in phrases ('Hey Miss Minutes', 'Miss Minutes', 'Hey Miss', 'Hey Minute') are always checked locally."
          checked={settings.wakeWordEnabled === true}
          onChange={v => set({ wakeWordEnabled: v })}
        />
        <div className="flex gap-2">
          <input
            value={newPhrase}
            onChange={e => setNewPhrase(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addPhrase(); } }}
            placeholder="Add custom wake phrase"
            className={field}
          />
          <button
            type="button"
            onClick={addPhrase}
            disabled={!newPhrase.trim() || customPhrases.length >= 16}
            className="inline-flex cursor-pointer items-center gap-1 rounded-xl border border-white/[0.12] bg-white/[0.04] px-3.5 text-xs font-medium text-[#FFF8EE] hover:bg-white/[0.09] disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" /> Add
          </button>
        </div>
        {customPhrases.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {customPhrases.map(phrase => (
              <span key={phrase} className="inline-flex items-center gap-1.5 rounded-full border border-[#FF7A1A]/35 bg-[#FF7A1A]/10 px-3 py-1 text-xs text-[#FFD9B3]">
                {phrase}
                <button
                  type="button"
                  onClick={() => set({ customWakePhrases: customPhrases.filter(p => p !== phrase) })}
                  aria-label={`Remove ${phrase}`}
                  className="cursor-pointer hover:text-white"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        {desktop && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                void feedWakeScore({
                  confidence: 0.92,
                  transcript: customPhrases[0] ?? 'hey miss minutes',
                  customPhrases,
                })
                  .then(r => {
                    const outcome: WakeOutcome = r.outcome;
                    const label = typeof outcome === 'string'
                      ? outcome
                      : 'triggered' in outcome
                        ? `triggered · "${outcome.triggered.phrase}"`
                        : 'accumulating' in outcome
                          ? `accumulating (${outcome.accumulating.hits}/${outcome.accumulating.required})`
                          : `emergency_stop · "${outcome.emergency_stop.phrase}"`;
                    setWakeStatusText(`${label} · ${r.ownerStatus.mode}`);
                  })
                  .catch(e => setWakeStatusText(errorText(e)));
              }}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-white/[0.12] bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-[#F5EFE6] hover:bg-white/[0.09]"
            >
              <Mic className="h-3.5 w-3.5 text-[#FF9240]" /> Test desktop wake pulse
            </button>
            {wakeStatusText && <span className="text-xs text-[#CBBEB0]">{wakeStatusText}</span>}
          </div>
        )}
      </Section>

      <Section title="Outbound calling guard" hint="Enforces Miss Minutes voice ONLY, mandatory upfront AI identity disclosure, quiet hours, and local Do-Not-Call list.">
        <Toggle
          label="Enforce quiet hours"
          hint="Blocks outbound calling during your configured quiet window (supports overnight wrap)."
          checked={settings.callQuietHoursEnabled !== false}
          onChange={v => set({ callQuietHoursEnabled: v })}
        />
        <div className="grid grid-cols-2 gap-2.5">
          <label className="block text-xs text-[#9D9082]">
            Quiet starts
            <input
              type="time"
              value={fmtMins(settings.callQuietStartMin ?? DEFAULT_QUIET_START_MIN)}
              onChange={e => {
                const parsed = parseMins(e.target.value);
                if (parsed !== null) set({ callQuietStartMin: parsed });
              }}
              className={`${field} mt-1`}
            />
          </label>
          <label className="block text-xs text-[#9D9082]">
            Quiet ends
            <input
              type="time"
              value={fmtMins(settings.callQuietEndMin ?? DEFAULT_QUIET_END_MIN)}
              onChange={e => {
                const parsed = parseMins(e.target.value);
                if (parsed !== null) set({ callQuietEndMin: parsed });
              }}
              className={`${field} mt-1`}
            />
          </label>
        </div>
        <div className="flex gap-2">
          <input
            value={newDnc}
            onChange={e => setNewDnc(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addDncNumber(); } }}
            placeholder="Add Do-Not-Call E.164 (e.g. +12025550199)"
            className={field}
          />
          <button
            type="button"
            onClick={addDncNumber}
            disabled={!newDnc.trim()}
            className="inline-flex cursor-pointer items-center gap-1 rounded-xl border border-white/[0.12] bg-white/[0.04] px-3.5 text-xs font-medium text-[#FFF8EE] hover:bg-white/[0.09] disabled:opacity-40"
          >
            <PhoneCall className="h-3.5 w-3.5 text-[#FF9240]" /> Block
          </button>
        </div>
        {dncError && <p className="text-xs text-red-300">{dncError}</p>}
        {dncList.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {dncList.map(num => (
              <span key={num} className="inline-flex items-center gap-1.5 rounded-full border border-red-500/35 bg-red-950/25 px-3 py-1 font-mono text-[11px] text-red-200">
                {num}
                <button
                  type="button"
                  onClick={() => set({ dncNumbers: dncList.filter(n => n !== num) })}
                  aria-label={`Remove ${num}`}
                  className="cursor-pointer hover:text-white"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </Section>

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
        <button
          type="button"
          onClick={() => setConfirm(true)}
          className="flex cursor-pointer items-center gap-2 rounded-xl border border-red-500/40 bg-red-950/25 px-4 py-2 text-sm text-red-200 transition-colors hover:bg-red-950/45"
        >
          <Trash2 className="h-4 w-4" /> Erase everything
        </button>
      ) : (
        <div className="space-y-3 rounded-2xl border border-red-500/45 bg-red-950/30 p-4">
          <p className="text-xs leading-relaxed text-red-200">
            This deletes every conversation, memory, reminder, timer, to-do and note on this device. It cannot be undone.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void wipeAll().then(() => { setDone(true); setConfirm(false); })}
              className="cursor-pointer rounded-xl bg-red-600 px-3.5 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-red-500"
            >
              Erase
            </button>
            <button
              type="button"
              onClick={() => setConfirm(false)}
              className="cursor-pointer rounded-xl border border-white/[0.12] bg-white/[0.04] px-3.5 py-1.5 text-sm text-[#F5EFE6] transition-colors hover:bg-white/[0.08]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {done && <p className="text-xs text-emerald-300">Done. Everything is erased.</p>}
    </Section>
  );
}

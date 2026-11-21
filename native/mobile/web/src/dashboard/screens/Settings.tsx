import { useEffect, useState } from 'react';
import {
  Brain,
  Check,
  CheckCircle2,
  Copy,
  Fingerprint,
  KeyRound,
  Link2,
  Loader2,
  Lock,
  Mic,
  PhoneCall,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Trash2,
  Volume2,
  X,
  XCircle,
} from 'lucide-react';
import type { AIProvider, AISettings, VoiceEngine } from '@desktop/types';
import { brain, listModelsWithStatus, resetChatGptCache, type ModelOption } from '@desktop/agent/brain';
import { createOpenRouterPkceChallenge } from '@desktop/agent/brain/pairing/openrouterWeb';
import { pairingSourceFingerprint } from '@desktop/agent/identityFingerprint';
import {
  PROVIDERS,
  PROVIDER_LABELS,
  defaultModelFor,
  hasProviderKey,
  isKeyProvider,
  isProviderKeyRemembered,
  providerNeedsKey,
  removeProviderKey,
  saveProviderKey,
  setProviderKeyRemembered,
  defaultSettings,
  initializeSettings,
  loadSettings,
  saveSettings,
} from '@desktop/agent/settings';
import { OPENAI_TTS_VOICES } from '@desktop/agent/realtime/cloudTts';
import {
  DEFAULT_QUIET_END_MIN,
  DEFAULT_QUIET_START_MIN,
  isValidE164,
} from '@desktop/agent/tools/calling';
import {
  androidWakeFeed,
  androidWakeStart,
  androidWakeStatus,
  androidWakeStop,
  type PlatformWakeStatus,
} from '@desktop/agent/platform';
import { wipeAll } from '@desktop/store/db';
import { speaker, useActiveVoice } from '@desktop/app/speaker';
import {
  authenticateOwner,
  chatGptAccount,
  chatGptSignIn,
  chatGptSignOut,
  describeError,
  formatMinutes,
  MODE_DETAILS,
  openMetadataWatcher,
  openRouterExchange,
  parseTimeInput,
  setMode,
  setSetting,
} from '../../shared/nativeApi.ts';
import type { ChatGptAccount } from '../../shared/nativeApi.ts';
import { MODES } from '../../shared/vocabulary.ts';
import { Switch } from '../Switch.tsx';
import { useNativeState } from '../useNative.ts';
import { request as requestNative } from '../../shared/bridge.ts';

export type SettingsTab = 'brain' | 'voice' | 'behavior' | 'android' | 'owner' | 'data';

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string; icon: typeof Brain }> = [
  { id: 'brain', label: 'Brain', icon: Brain },
  { id: 'voice', label: 'Voice', icon: Volume2 },
  { id: 'behavior', label: 'Behavior', icon: SlidersHorizontal },
  { id: 'owner', label: 'Owner & devices', icon: KeyRound },
  { id: 'android', label: 'Android', icon: Smartphone },
  { id: 'data', label: 'Data', icon: Trash2 },
];

const PROVIDER_HELP: Record<AIProvider, string> = {
  'tva-offline': 'Built in. No account or key. Runs timers, reminders, schedule, notes, weather and search locally.',
  chatgpt: 'Connect your ChatGPT account in the Android app. Sign-in stays in the system browser; tokens stay in Android Keystore-backed storage.',
  openrouter: 'Pair your OpenRouter account with PKCE or paste an API key. Access hundreds of open & commercial models.',
  openai: 'Your OpenAI API key. Powers GPT-6.1 Terra plus compatible OpenAI chat and TTS voices.',
  gemini: 'Your Google AI Studio API key. Fast multimodal inference with Gemini 3.8 Flash and Pro models.',
  anthropic: 'Your Anthropic API key. Powers Claude Sonnet 5.5 and Claude Haiku models.',
  ollama: 'Custom endpoint (e.g. localhost or private local network instance).',
};

const inputClass =
  'min-h-11 w-full rounded-2xl border border-white/[0.12] bg-[#0B0908] px-3.5 py-2.5 text-sm text-cream placeholder:text-[#786B5E] outline-none transition-colors focus:border-face';

export function Settings({
  ownerDataReady = true,
  initialTab,
}: {
  ownerDataReady?: boolean;
  initialTab?: SettingsTab;
} = {}) {
  const native = useNativeState();
  const ownerUnlocked = ownerDataReady && native.phase === 'ready' && native.info?.ownerAuthenticated === true;
  const ownerCandidate =
    !native.info?.ownerAuthenticated
    && (native.info?.operatingMode === 'OWNER_CANDIDATE' || native.info?.ownerCandidate === true);
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? 'brain');
  const [aiSettings, setAiSettings] = useState<AISettings>(() => defaultSettings());
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState('');

  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);

  async function unlock(): Promise<void> {
    setUnlocking(true);
    setUnlockError('');
    try {
      await authenticateOwner();
      await native.refresh();
    } catch (error) {
      setUnlockError(error instanceof Error ? error.message : 'Owner verification failed.');
    } finally {
      setUnlocking(false);
    }
  }

  useEffect(() => {
    if (!ownerUnlocked) {
      setAiSettings(defaultSettings());
      return;
    }
    let active = true;
    void initializeSettings().then(settled => {
      if (active) setAiSettings(settled);
    }).catch(() => {
      if (active) setAiSettings(loadSettings());
    });
    return () => { active = false; };
  }, [ownerUnlocked]);

  const updateAiSettings = (patch: Partial<AISettings>) => {
    const next = { ...aiSettings, ...patch };
    setAiSettings(saveSettings(next));
  };

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-lg flex-col gap-4 pb-6">
      {!ownerUnlocked ? (
        <section className="rounded-3xl border border-white/[0.08] bg-[#14100C] p-6 shadow-[0_16px_44px_rgba(0,0,0,0.45)]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-face">
              <Lock className="h-3.5 w-3.5" /> Control room
            </p>
            {ownerCandidate ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-face/40 bg-face/15 px-3 py-1 text-[11px] font-semibold text-[#FFD9B3]">
                <ShieldAlert className="h-3.5 w-3.5" /> Owner Candidate
              </span>
            ) : native.info?.ownerEnrolled && !native.info?.ownerAuthenticated ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.1] bg-[#0B0908] px-3 py-1 text-[11px] font-semibold text-muted">
                <Lock className="h-3 w-3" /> Guest Mode
              </span>
            ) : null}
          </div>
          <h1 className="mt-3 text-xl font-semibold text-[#FFF8EE]">
            {!ownerDataReady && !native.info?.ownerAuthenticated
              ? 'Owner verification needed'
              : !ownerDataReady
                ? 'Securing saved data'
                : 'Owner settings are locked'}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-[#CBBEB0]">
            {!ownerDataReady && !native.info?.ownerAuthenticated
              ? 'Verify this device to migrate saved records and open private settings. Home controls and temporary guest chat remain available.'
              : !ownerDataReady
                ? 'Provider, voice, memory and security settings stay private until saved records finish migrating. Home controls are available now.'
                : 'Verify on this device to change providers, voice, behavior, memory and security settings.'}
          </p>
          {native.info?.ownerEnrolled && !native.info.ownerAuthenticated && (
            <button
              type="button"
              disabled={unlocking}
              onClick={() => void unlock()}
              className="mt-5 inline-flex min-h-12 cursor-pointer items-center gap-2 rounded-2xl bg-face px-5 text-sm font-semibold text-[#110C07] transition-colors hover:brightness-110 disabled:opacity-60"
            >
              <Fingerprint className="h-4 w-4" />
              {unlocking ? 'Waiting for device verification…' : 'Verify Identity'}
            </button>
          )}
          {unlockError && (
            <p role="alert" className="mt-3 rounded-xl border border-red-500/40 bg-red-950/25 px-3 py-2 text-xs text-red-200">
              {unlockError}
            </p>
          )}
        </section>
      ) : (
        <>
          <header className="flex flex-wrap items-center justify-between gap-2 px-1">
            <h1 className="text-2xl font-semibold tracking-tight text-[#FFF8EE]">Settings</h1>
            {native.info?.ownerAuthenticated ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/35 bg-emerald-950/25 px-3 py-1 text-xs font-semibold text-emerald-300">
                <ShieldCheck className="h-3.5 w-3.5" /> Owner Mode
              </span>
            ) : ownerCandidate ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-face/40 bg-face/15 px-3 py-1 text-xs font-semibold text-[#FFD9B3]">
                <ShieldAlert className="h-3.5 w-3.5" /> Owner Candidate
              </span>
            ) : native.info?.ownerEnrolled ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.1] bg-[#16120E] px-3 py-1 text-xs font-semibold text-muted">
                <Lock className="h-3.5 w-3.5" /> Guest Mode
              </span>
            ) : null}
          </header>

          {/* Segmented sub-tabs with >=44px touch targets */}
          <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Settings categories">
            {SETTINGS_TABS.map(({ id, label, icon: Icon }) => {
              const selected = tab === id;
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setTab(id)}
                  className={`flex min-h-11 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-2xl border px-3.5 py-2 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-face ${
                    selected
                      ? 'border-face/70 bg-face/15 text-[#FFF8EE]'
                      : 'border-white/[0.08] bg-[#16120E] text-muted hover:border-white/[0.16] hover:text-cream'
                  }`}
                >
                  <Icon className={`h-4 w-4 ${selected ? 'text-face' : 'text-muted'}`} />
                  <span>{label}</span>
                </button>
              );
            })}
          </div>

          {tab === 'brain' && <BrainSettingsTab settings={aiSettings} set={updateAiSettings} ownerUnlocked={ownerUnlocked} />}
          {tab === 'voice' && <VoiceSettingsTab settings={aiSettings} set={updateAiSettings} />}
          {tab === 'behavior' && <BehaviorSettingsTab settings={aiSettings} set={updateAiSettings} />}
          {tab === 'owner' && <OwnerDevicesTab showIdentity />}
          {tab === 'android' && <AndroidSettingsTab />}
          {tab === 'data' && <DataSettingsTab />}
        </>
      )}
      {!native.info?.ownerEnrolled && <OwnerDevicesTab showIdentity={false} />}
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-3xl border border-white/[0.08] bg-[#16120E] p-4 shadow-[0_12px_32px_rgba(0,0,0,0.3)]">
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-face">{title}</h2>
        {hint && <p className="mt-1 text-xs leading-relaxed text-muted">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function SettingToggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex min-h-12 cursor-pointer items-start justify-between gap-4 rounded-2xl border border-white/[0.08] bg-[#16120E] px-4 py-3 transition-colors hover:border-white/[0.16]">
      <span>
        <span className="block text-sm font-medium text-[#FFF8EE]">{label}</span>
        {hint && <span className="mt-0.5 block text-xs leading-snug text-muted">{hint}</span>}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        className="mt-1 h-5 w-5 shrink-0 cursor-pointer accent-[#FF7A1A]"
      />
    </label>
  );
}

function OwnerDevicesTab({ showIdentity }: { showIdentity: boolean }) {
  const native = useNativeState();
  const [identity, setIdentity] = useState<{
    ownerId?: string;
    deviceId?: string;
    recoveryConfigured?: boolean;
    devices?: Array<{ deviceId: string; platform: string; revoked: boolean; current: boolean }>;
  } | null>(null);
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [request, setRequest] = useState('');
  const [requestToApprove, setRequestToApprove] = useState('');
  const [receipt, setReceipt] = useState('');
  const [receiptToImport, setReceiptToImport] = useState('');
  const [sourceFingerprint, setSourceFingerprint] = useState('');
  const [fingerprintConfirmed, setFingerprintConfirmed] = useState(false);
  const [recoveryPassphrase, setRecoveryPassphrase] = useState('');
  const [recoveryConfirmation, setRecoveryConfirmation] = useState('');
  const [recoveryKit, setRecoveryKit] = useState('');
  const [recoveryMaterial, setRecoveryMaterial] = useState('');
  const [recoveryImportPassphrase, setRecoveryImportPassphrase] = useState('');
  const [confirmRecoveryRotation, setConfirmRecoveryRotation] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!showIdentity) return;
    let active = true;
    void requestNative('owner.identity.summary', {}, 15_000).then(value => {
      if (active) setIdentity(value as typeof identity);
    }).catch(error => {
      if (active) setStatus({ ok: false, text: describeError(error) ?? 'Could not read the device identity.' });
    });
    return () => { active = false; };
  }, [showIdentity]);

  useEffect(() => {
    let active = true;
    setSourceFingerprint('');
    setFingerprintConfirmed(false);
    try {
      const parsed = JSON.parse(receiptToImport) as {
        ownerId?: string;
        sourceDeviceId?: string;
        sourcePublicKey?: string;
        sourcePlatform?: string;
      };
      if (parsed.sourcePlatform === 'windows' && parsed.ownerId && parsed.sourceDeviceId && parsed.sourcePublicKey) {
        void pairingSourceFingerprint(parsed.ownerId, parsed.sourceDeviceId, parsed.sourcePublicKey)
          .then(value => { if (active) setSourceFingerprint(value); })
          .catch(() => { if (active) setSourceFingerprint('Invalid receipt identity'); });
      }
    } catch { /* Input is incomplete while the user pastes it. */ }
    return () => { active = false; };
  }, [receiptToImport]);

  const createRequest = async () => {
    setBusy('create'); setStatus(null);
    try {
      const result = await requestNative('owner.pairing.request.create', {}, 30_000) as { request?: string };
      if (!result.request) throw new Error('The app returned no pairing request.');
      setRequest(result.request);
      setStatus({ ok: true, text: 'Request created on this phone. Transfer it to the currently enrolled device.' });
    } catch (error) { setStatus({ ok: false, text: describeError(error) ?? 'Could not create the pairing request.' }); }
    finally { setBusy(null); }
  };

  const revokeDevice = async (deviceId: string) => {
    setConfirmRevokeId(null);
    setBusy(`revoke:${deviceId}`); setStatus(null);
    try {
      const result = await requestNative('owner.device.revoke', { deviceId }, 120_000) as { status?: string };
      if (result.status !== 'revoked') throw new Error('The Rust authority did not confirm device revocation.');
      const updated = await requestNative('owner.identity.summary', {}, 15_000);
      setIdentity(updated as typeof identity);
      setStatus({
        ok: true,
        text: 'Device revoked on this phone after fresh biometric verification. Other offline devices will not learn about the revocation until you update their trusted-device registries.',
      });
    } catch (error) { setStatus({ ok: false, text: describeError(error) ?? 'Could not revoke the device.' }); }
    finally { setBusy(null); }
  };

  const approveRequest = async () => {
    setBusy('approve'); setStatus(null); setReceipt('');
    try {
      const result = await requestNative('owner.pairing.request.approve', { request: requestToApprove.trim() }, 120_000) as { receipt?: string };
      if (!result.receipt) throw new Error('The app returned no signed pairing receipt.');
      setReceipt(result.receipt);
      const details = JSON.parse(result.receipt) as { sourceDeviceId?: string; targetDeviceId?: string };
      setStatus({
        ok: true,
        text: `Approved ${details.targetDeviceId ?? 'new device'} from enrolled device ${details.sourceDeviceId ?? 'this phone'}. Compare the source device ID on both screens before importing.`,
      });
    } catch (error) { setStatus({ ok: false, text: describeError(error) ?? 'Could not approve the pairing request.' }); }
    finally { setBusy(null); }
  };

  const importReceipt = async () => {
    setBusy('import'); setStatus(null);
    try {
      const result = await requestNative('owner.pairing.receipt.import', { receipt: receiptToImport.trim() }, 30_000) as { status?: string };
      if (result.status !== 'paired') throw new Error('The receipt was not accepted.');
      setReceiptToImport('');
      setStatus({ ok: true, text: 'This phone is paired. It must authenticate with its own protected device credential.' });
    } catch (error) { setStatus({ ok: false, text: describeError(error) ?? 'Could not import the pairing receipt.' }); }
    finally { setBusy(null); }
  };

  const createRecoveryKit = async () => {
    setBusy('recovery-create'); setStatus(null); setRecoveryKit('');
    if (recoveryPassphrase.length < 12 || recoveryPassphrase !== recoveryConfirmation) {
      setStatus({ ok: false, text: 'Enter matching recovery passphrases of at least 12 printable ASCII characters.' });
      setBusy(null);
      return;
    }
    try {
      const result = await requestNative('owner.recovery.create', { passphrase: recoveryPassphrase }, 180_000) as { material?: string };
      if (!result.material) throw new Error('The encrypted recovery kit was not returned.');
      setRecoveryKit(result.material);
      setRecoveryPassphrase('');
      setRecoveryConfirmation('');
      setConfirmRecoveryRotation(false);
      await native.refresh();
      setStatus({ ok: true, text: 'Recovery kit created. Save it offline and keep its passphrase separately; the private recovery key cannot be downloaded again.' });
    } catch (error) { setStatus({ ok: false, text: describeError(error) ?? 'Could not create the recovery kit.' }); }
    finally { setBusy(null); }
  };

  const restoreRecoveryKit = async () => {
    setBusy('recovery-restore'); setStatus(null);
    try {
      const result = await requestNative('owner.recovery.restore', {
        material: recoveryMaterial.trim(),
        passphrase: recoveryImportPassphrase,
      }, 180_000) as { status?: string };
      if (result.status !== 'recovered') throw new Error('The recovery kit was not accepted.');
      setRecoveryMaterial('');
      setRecoveryImportPassphrase('');
      await native.refresh();
      setStatus({ ok: true, text: 'Device recovered and enrolled. It is still locked; verify with this device’s biometric before accessing owner data.' });
    } catch (error) { setStatus({ ok: false, text: describeError(error) ?? 'Could not restore the recovery kit.' }); }
    finally { setBusy(null); }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setStatus({ ok: true, text: 'Copied. Transfer it directly to your other device over a channel you control.' });
    } catch {
      setStatus({ ok: false, text: 'Clipboard is unavailable. Select the text and copy it manually.' });
    }
  };

  const transferArea = 'min-h-28 w-full resize-y rounded-2xl border border-white/[0.12] bg-[#0B0908] p-3 font-mono text-[11px] leading-5 text-cream outline-none focus:border-face';
  const action = 'min-h-12 cursor-pointer rounded-2xl bg-face px-4 py-2 text-sm font-semibold text-[#110C07] transition hover:brightness-110 disabled:cursor-wait disabled:opacity-50';
  const subAction = 'min-h-11 cursor-pointer rounded-xl border border-white/[0.12] bg-white/[0.04] px-3.5 py-2 text-xs font-medium text-cream hover:border-face/60';
  const claimedSourceId = (() => {
    try { return receiptToImport ? (JSON.parse(receiptToImport) as { sourceDeviceId?: string }).sourceDeviceId ?? null : null; }
    catch { return null; }
  })();
  const needsFingerprintCheck = (() => {
    try { return (JSON.parse(receiptToImport) as { sourcePlatform?: string }).sourcePlatform === 'windows'; }
    catch { return false; }
  })();

  return (
    <div className="space-y-4">
      <Section title="Pair a device" hint="Offline pairing. Each device keeps its own hardware-backed private key; this flow transfers only public credentials and a signed challenge.">
        <div className="space-y-3.5">
          {showIdentity && identity?.deviceId && (
            <div className="rounded-2xl border border-face/35 bg-face/10 p-3.5">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-face">This enrolled device</p>
              <p className="mt-1 break-all font-mono text-xs text-cream" aria-label="Current owner device ID">{identity.deviceId}</p>
              <p className="mt-1 text-[11px] text-muted">Confirm that the signed receipt names this exact source device before importing it on another phone.</p>
              <button type="button" className="mt-2 min-h-10 cursor-pointer text-xs font-semibold text-face underline" onClick={() => void copy(identity.deviceId!)}>
                Copy device ID
              </button>
            </div>
          )}

          {showIdentity && !!identity?.devices?.length && (
            <div className="rounded-2xl border border-white/[0.08] bg-[#0E0B08] p-3.5">
              <h3 className="text-sm font-semibold text-cream">Trusted devices</h3>
              <ul className="mt-2 space-y-2">
                {identity.devices.map(device => (
                  <li key={device.deviceId} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/[0.08] bg-[#16120E] p-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-cream">
                        {device.current ? 'This device' : `${device.platform} device`} · {device.revoked ? 'Revoked here' : 'Trusted here'}
                      </p>
                      <p className="mt-1 break-all font-mono text-[10px] text-muted">{device.deviceId}</p>
                    </div>
                    {!device.current && !device.revoked && (
                      confirmRevokeId === device.deviceId ? (
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={busy !== null}
                            onClick={() => void revokeDevice(device.deviceId)}
                            className="min-h-10 cursor-pointer rounded-xl bg-red-600 px-3 text-xs font-semibold text-white"
                          >
                            Confirm revoke
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmRevokeId(null)}
                            className={subAction}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className={subAction}
                          disabled={busy !== null}
                          onClick={() => setConfirmRevokeId(device.deviceId)}
                        >
                          {busy === `revoke:${device.deviceId}` ? 'Verifying…' : 'Revoke'}
                        </button>
                      )
                    )}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] leading-5 text-muted">
                Revocation is stored on this device. Offline devices cannot receive it until their registries are updated.
              </p>
            </div>
          )}

          <div className="rounded-2xl border border-white/[0.08] bg-[#0E0B08] p-3.5">
            <p className="text-sm font-semibold text-cream">1 · New phone: create a request</p>
            <p className="mt-1 text-xs leading-5 text-muted">On the new phone, tap below and send its request to the already enrolled device.</p>
            <button type="button" className={`${action} mt-3`} disabled={busy !== null} onClick={() => void createRequest()}>
              {busy === 'create' ? 'Creating request…' : 'Create request on this phone'}
            </button>
            {request && (
              <div className="mt-3 space-y-2">
                <textarea aria-label="Pairing request" readOnly value={request} className={transferArea} onFocus={event => event.currentTarget.select()} />
                <button type="button" className={subAction} onClick={() => void copy(request)}>Copy request</button>
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-white/[0.08] bg-[#0E0B08] p-3.5">
            <p className="text-sm font-semibold text-cream">2 · Enrolled phone: verify and approve</p>
            <p className="mt-1 text-xs leading-5 text-muted">
              Paste the request here. Android will require a fresh device biometric before committing trust. Compare the source device ID in the signed receipt before importing.
            </p>
            <textarea
              aria-label="Pairing request to approve"
              value={requestToApprove}
              onChange={event => setRequestToApprove(event.target.value)}
              placeholder="Paste request from the new phone"
              className={`${transferArea} mt-3`}
            />
            <button
              type="button"
              className={`${action} mt-2.5`}
              disabled={!requestToApprove.trim() || busy !== null}
              onClick={() => void approveRequest()}
            >
              {busy === 'approve' ? 'Waiting for device verification…' : 'Verify and approve'}
            </button>
            {receipt && (
              <div className="mt-3 space-y-2">
                <textarea aria-label="Signed pairing receipt" readOnly value={receipt} className={transferArea} onFocus={event => event.currentTarget.select()} />
                <button type="button" className={subAction} onClick={() => void copy(receipt)}>Copy signed receipt</button>
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-white/[0.08] bg-[#0E0B08] p-3.5">
            <p className="text-sm font-semibold text-cream">3 · New phone: import the signed receipt</p>
            <textarea
              aria-label="Signed receipt to import"
              value={receiptToImport}
              onChange={event => setReceiptToImport(event.target.value)}
              placeholder="Paste receipt from your enrolled phone or Windows desktop"
              className={`${transferArea} mt-3`}
            />
            {claimedSourceId && (
              <p className="mt-2 break-all text-xs text-[#FFD9B3]">
                Receipt claims source device <span className="font-mono">{claimedSourceId}</span>. Compare this ID with the enrolled device before importing.
              </p>
            )}
            {sourceFingerprint && (
              <div className="mt-2 space-y-2 rounded-2xl border border-face/45 bg-face/10 p-3">
                <p className="text-xs text-cream">Compare this pairing code with the one shown on the Windows desktop that approved this request:</p>
                <p className="font-mono text-base font-bold tracking-widest text-[#FFD9B3]">{sourceFingerprint}</p>
                <label className="flex min-h-10 cursor-pointer items-start gap-2.5 text-xs leading-5 text-cream">
                  <input
                    type="checkbox"
                    checked={fingerprintConfirmed}
                    onChange={event => setFingerprintConfirmed(event.target.checked)}
                    className="mt-1 h-4 w-4 accent-[#FF7A1A]"
                  />
                  <span>The code matches the Windows desktop in front of me.</span>
                </label>
              </div>
            )}
            <button
              type="button"
              className={`${action} mt-2.5`}
              disabled={!receiptToImport.trim() || busy !== null || (needsFingerprintCheck && (!sourceFingerprint || sourceFingerprint === 'Invalid receipt identity' || !fingerprintConfirmed))}
              onClick={() => void importReceipt()}
            >
              {busy === 'import' ? 'Verifying signature…' : 'Verify receipt and pair'}
            </button>
          </div>
        </div>
        {status && (
          <p
            role={status.ok ? 'status' : 'alert'}
            className={`rounded-2xl border px-3.5 py-2.5 text-xs leading-5 ${
              status.ok
                ? 'border-emerald-500/35 bg-emerald-950/25 text-emerald-200'
                : 'border-red-500/40 bg-red-950/30 text-red-200'
            }`}
          >
            {status.text}
          </p>
        )}
        <p className="text-[11px] leading-5 text-muted">
          Keep transfer text private and use it promptly. Pairing does not synchronize biometric profiles, conversation data, or secrets.
        </p>
      </Section>

      {showIdentity ? (
        <Section title="Offline recovery kit" hint="A recovery key can enroll a replacement device if every paired device is lost. The encrypted kit is never retained by Miss Minutes; its passphrase is separate from the kit.">
          <div className="space-y-3">
            <p className="text-xs leading-5 text-muted">
              {identity?.recoveryConfigured
                ? 'A recovery credential is configured. Replacing it invalidates the previous kit.'
                : 'No recovery credential is configured yet. Set one up and keep the kit offline.'}
            </p>
            {identity?.recoveryConfigured && (
              <label className="flex min-h-10 cursor-pointer items-start gap-2.5 text-xs leading-5 text-[#FFD9B3]">
                <input
                  type="checkbox"
                  checked={confirmRecoveryRotation}
                  onChange={event => setConfirmRecoveryRotation(event.target.checked)}
                  className="mt-1 h-4 w-4 accent-[#FF7A1A]"
                />
                <span>I understand that replacing the recovery kit invalidates the previous one.</span>
              </label>
            )}
            <label className="block text-xs text-muted">
              New recovery passphrase
              <input
                type="password"
                autoComplete="new-password"
                value={recoveryPassphrase}
                onChange={event => setRecoveryPassphrase(event.target.value)}
                minLength={12}
                maxLength={256}
                className={`${inputClass} mt-1.5`}
                placeholder="12–256 printable ASCII characters"
              />
            </label>
            <label className="block text-xs text-muted">
              Confirm recovery passphrase
              <input
                type="password"
                autoComplete="new-password"
                value={recoveryConfirmation}
                onChange={event => setRecoveryConfirmation(event.target.value)}
                minLength={12}
                maxLength={256}
                className={`${inputClass} mt-1.5`}
              />
            </label>
            <button
              type="button"
              className={action}
              disabled={busy !== null || recoveryPassphrase.length < 12 || recoveryPassphrase !== recoveryConfirmation || (!!identity?.recoveryConfigured && !confirmRecoveryRotation)}
              onClick={() => void createRecoveryKit()}
            >
              {busy === 'recovery-create' ? 'Verifying and creating kit…' : identity?.recoveryConfigured ? 'Verify and replace recovery kit' : 'Verify and create recovery kit'}
            </button>
            {recoveryKit && (
              <div className="space-y-2 rounded-2xl border border-face/40 bg-face/10 p-3.5">
                <p className="text-xs font-semibold text-[#FFF4E4]">Save this encrypted kit now</p>
                <textarea aria-label="Encrypted offline recovery kit" readOnly value={recoveryKit} className={transferArea} onFocus={event => event.currentTarget.select()} />
                <button type="button" className={subAction} onClick={() => void copy(recoveryKit)}>Copy recovery kit</button>
                <p className="text-[11px] leading-5 text-[#CBBEB0]">
                  Store it offline. Keep the passphrase separate. Anyone with both can enroll a replacement device. This kit is displayed only once.
                </p>
              </div>
            )}
          </div>
        </Section>
      ) : (
        <Section title="Recover a device" hint="Restore from your offline encrypted recovery kit. This creates a new device-bound key and requires the kit plus its separate passphrase.">
          <div className="space-y-3">
            <textarea
              aria-label="Encrypted recovery kit to import"
              value={recoveryMaterial}
              onChange={event => setRecoveryMaterial(event.target.value)}
              placeholder="Paste recovery kit"
              className={transferArea}
            />
            <label className="block text-xs text-muted">
              Recovery passphrase
              <input
                type="password"
                autoComplete="current-password"
                value={recoveryImportPassphrase}
                onChange={event => setRecoveryImportPassphrase(event.target.value)}
                minLength={12}
                maxLength={256}
                className={`${inputClass} mt-1.5`}
              />
            </label>
            <button
              type="button"
              className={action}
              disabled={busy !== null || !recoveryMaterial.trim() || recoveryImportPassphrase.length < 12}
              onClick={() => void restoreRecoveryKit()}
            >
              {busy === 'recovery-restore' ? 'Verifying offline recovery proof…' : 'Verify kit and recover this device'}
            </button>
            <p className="text-[11px] leading-5 text-muted">
              Recovery is offline. A valid signature enrolls only this device; you must authenticate here afterward. It does not copy biometric profiles or owner data.
            </p>
          </div>
        </Section>
      )}
    </div>
  );
}

function BrainSettingsTab({ settings, set, ownerUnlocked }: { settings: AISettings; set: (p: Partial<AISettings>) => void; ownerUnlocked: boolean }) {
  const provider = settings.provider;
  const [key, setKey] = useState('');
  const [remember, setRemember] = useState(true);
  const [hasKey, setHasKey] = useState(false);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chatGpt, setChatGpt] = useState<ChatGptAccount | null>(null);
  const [pairingMessage, setPairingMessage] = useState('');
  const [orPkce, setOrPkce] = useState<{ authorizeUrl: string; state: string; verifier: string } | null>(null);
  const [orCallbackInput, setOrCallbackInput] = useState('');
  const [orCopied, setOrCopied] = useState(false);

  useEffect(() => {
    const onPairing = (event: Event) => {
      const detail = (event as CustomEvent<{ ok?: boolean; message?: string }>).detail;
      setPairingMessage(detail?.ok ? 'OpenRouter is paired and its key is stored natively.' : detail?.message ?? 'OpenRouter pairing failed.');
    };
    window.addEventListener('miss-minutes:openrouter-pairing', onPairing);
    return () => window.removeEventListener('miss-minutes:openrouter-pairing', onPairing);
  }, []);

  useEffect(() => {
    setTest(null);
    setError(null);
    setKey('');
    setPairingMessage('');
    if (isKeyProvider(provider)) {
      let active = true;
      void hasProviderKey(provider).then(v => { if (active) setHasKey(v); }).catch(() => { if (active) setHasKey(false); });
      void isProviderKeyRemembered(provider).then(r => { if (active) setRemember(r); }).catch(() => undefined);
      return () => { active = false; };
    } else {
      setHasKey(false);
    }
  }, [provider]);

  useEffect(() => {
    let active = true;
    setChatGpt(null);
    if (provider === 'chatgpt' && ownerUnlocked) {
      void chatGptAccount().then(account => { if (active) setChatGpt(account); })
        .catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    }
    return () => { active = false; };
  }, [provider, ownerUnlocked]);

  const refreshModels = async () => {
    setLoadingModels(true);
    try {
      const catalog = await listModelsWithStatus(settings);
      setModels(catalog.models);
      setError(catalog.error ?? null);
      if (!settings.model && catalog.models[0]) set({ model: catalog.models[0].id });
    } catch (e) {
      setModels([]);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingModels(false);
    }
  };

  useEffect(() => {
    void refreshModels();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [provider, hasKey]);

  const saveKey = async () => {
    if (!isKeyProvider(provider) || !key.trim()) return;
    setBusy('key');
    setError(null);
    try {
      await saveProviderKey(provider, key.trim(), { remember });
      setKey('');
      setHasKey(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const toggleRememberKey = async (next: boolean) => {
    setRemember(next);
    if (!hasKey || !isKeyProvider(provider)) return;
    setBusy('remember');
    setError(null);
    try {
      const updated = await setProviderKeyRemembered(provider, next);
      setRemember(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update key persistence.');
    } finally {
      setBusy(null);
    }
  };

  const startOrPkce = async () => {
    setBusy('openrouter-start');
    setError(null);
    setPairingMessage('');
    try {
      const pkce = await createOpenRouterPkceChallenge();
      setOrPkce(pkce);
      setOrCallbackInput('');
      setOrCopied(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start OpenRouter PKCE challenge.');
    } finally {
      setBusy(null);
    }
  };

  const completeOrPkce = async () => {
    if (!orPkce) return;
    const raw = orCallbackInput.trim();
    if (!raw) return;
    setBusy('openrouter-exchange');
    setError(null);
    setPairingMessage('');
    try {
      let code = raw;
      let returnedState: string | null = null;
      if (raw.startsWith('http://') || raw.startsWith('https://')) {
        const parsed = new URL(raw);
        code = parsed.searchParams.get('code') ?? '';
        returnedState = parsed.searchParams.get('state');
      } else if (raw.includes('code=')) {
        const params = new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw);
        code = params.get('code') ?? '';
        returnedState = params.get('state');
      }
      if (returnedState !== null && returnedState !== orPkce.state) {
        throw new Error('OpenRouter callback state did not match this pairing request.');
      }
      code = code.trim();
      if (!/^[\w.-]{8,512}$/.test(code)) {
        throw new Error('Paste the redirected OpenRouter URL (containing ?code=...) or a valid OpenRouter pairing code.');
      }
      const res = await openRouterExchange(code, orPkce.verifier, remember);
      setOrPkce(null);
      setOrCallbackInput('');
      setHasKey(res.present);
      setRemember(res.remembered);
      setPairingMessage(res.present ? 'OpenRouter is paired and stored natively.' : 'OpenRouter did not return an active key.');
    } catch (e) {
      const msg = describeError(e) ?? 'OpenRouter pairing exchange failed.';
      setError(msg);
    } finally {
      setBusy(null);
    }
  };

  const connectChatGpt = async () => {
    setBusy('chatgpt');
    setError(null);
    try {
      const account = await chatGptSignIn();
      resetChatGptCache();
      setChatGpt(account);
      const catalog = await listModelsWithStatus(settings);
      setModels(catalog.models);
      setError(catalog.error ?? null);
      if (!settings.model && catalog.models[0]) set({ model: catalog.models[0].id });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const disconnectChatGpt = async () => {
    setBusy('chatgpt');
    setError(null);
    try {
      await chatGptSignOut();
      resetChatGptCache();
      setChatGpt({ signedIn: false, email: null, planUsage: false, expiresAtUnixMs: null });
      setModels([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Section title="AI Provider" hint="Select the AI brain powering Miss Minutes. You can switch any time.">
        <div className="grid grid-cols-2 gap-2">
          {PROVIDERS.map(p => (
            <button
              key={p}
              type="button"
              onClick={() => set({ provider: p, model: defaultModelFor(p) })}
              className={`min-h-12 cursor-pointer rounded-2xl border p-3 text-left transition-colors ${
                p === provider
                  ? 'border-face/70 bg-face/15 text-[#FFF8EE]'
                  : 'border-white/[0.08] bg-[#0E0B08] text-muted hover:border-face/40 hover:text-cream'
              }`}
            >
              <span className="block text-sm font-semibold">{PROVIDER_LABELS[p]}</span>
            </button>
          ))}
        </div>
        <p className="text-xs leading-relaxed text-muted">{PROVIDER_HELP[provider]}</p>
      </Section>

      {provider === 'chatgpt' && (
        <Section title="ChatGPT account" hint="Authorize Miss Minutes to use eligible ChatGPT plan usage. Android keeps access and refresh tokens out of the WebView and encrypts them with hardware-backed Android Keystore.">
          {chatGpt?.signedIn ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-500/35 bg-emerald-950/20 p-3.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-cream">{chatGpt.email ?? 'ChatGPT account connected'}</p>
                <p className="text-xs text-muted">{chatGpt.planUsage ? 'Plan usage permission is active.' : 'This login did not grant plan usage.'}</p>
              </div>
              <button
                type="button"
                onClick={() => void disconnectChatGpt()}
                disabled={busy === 'chatgpt'}
                className="min-h-11 cursor-pointer rounded-xl border border-white/[0.12] bg-white/[0.04] px-3.5 text-xs font-medium text-cream disabled:opacity-50"
              >
                Disconnect
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => void connectChatGpt()}
              disabled={busy === 'chatgpt'}
              className="flex min-h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-2xl bg-face py-2.5 text-sm font-semibold text-[#110C07] disabled:opacity-50"
            >
              {busy === 'chatgpt' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
              Continue with ChatGPT
            </button>
          )}
          <p className="text-xs leading-relaxed text-muted">
            ChatGPT is the active brain only when ChatGPT is selected above and a model appears below. Returning from sign-in keeps this device session available unless you lock the owner or lock the phone.
          </p>
        </Section>
      )}

      {provider === 'openrouter' && (
        <Section title="Pair OpenRouter" hint="Generate an OAuth PKCE pairing link without navigating out of Miss Minutes, approve in your browser, and exchange the callback code natively.">
          <button
            type="button"
            disabled={busy === 'openrouter-start' || busy === 'openrouter-exchange'}
            onClick={() => void startOrPkce()}
            className="flex min-h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-2xl bg-face py-2.5 text-sm font-semibold text-[#110C07] transition hover:brightness-110 disabled:opacity-50"
          >
            {busy === 'openrouter-start' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
            {orPkce ? 'Regenerate OpenRouter PKCE Link' : 'Generate OpenRouter PKCE Link'}
          </button>

          {orPkce && (
            <div className="space-y-2.5 rounded-2xl border border-face/35 bg-[#0E0B08] p-3">
              <p className="text-xs leading-relaxed text-[#CBBEB0]">
                1. Copy this authorize URL and open it in your browser to approve Miss Minutes:
              </p>
              <div className="flex gap-2">
                <input
                  readOnly
                  aria-label="OpenRouter PKCE authorize URL"
                  value={orPkce.authorizeUrl}
                  onFocus={e => e.currentTarget.select()}
                  className={`${inputClass} font-mono text-xs`}
                />
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(orPkce.authorizeUrl).then(() => {
                      setOrCopied(true);
                      window.setTimeout(() => setOrCopied(false), 1800);
                    }).catch(() => undefined);
                  }}
                  aria-label="Copy OpenRouter PKCE link"
                  className="grid min-h-11 w-11 shrink-0 cursor-pointer place-items-center rounded-2xl border border-white/[0.12] bg-[#16120E] text-cream hover:border-face"
                >
                  {orCopied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
                </button>
              </div>
              <p className="text-xs leading-relaxed text-[#CBBEB0]">
                2. After approval, paste the redirected URL (or <span className="font-mono">code</span> parameter) below:
              </p>
              <div className="flex gap-2">
                <input
                  value={orCallbackInput}
                  onChange={e => setOrCallbackInput(e.target.value)}
                  placeholder="Paste https://openrouter.ai/?code=... or code"
                  className={inputClass}
                  autoComplete="off"
                />
                <button
                  type="button"
                  disabled={!orCallbackInput.trim() || busy === 'openrouter-exchange'}
                  onClick={() => void completeOrPkce()}
                  className="min-h-11 shrink-0 cursor-pointer rounded-2xl bg-face px-4 text-xs font-semibold text-[#110C07] disabled:opacity-40"
                >
                  {busy === 'openrouter-exchange' ? 'Pairing…' : 'Complete'}
                </button>
              </div>
            </div>
          )}
          {pairingMessage && <p role="status" className="text-xs text-emerald-300">{pairingMessage}</p>}
        </Section>
      )}

      {providerNeedsKey(provider) && (
        <Section
          title="API Key"
          hint="Stored in encrypted app-private storage protected by Android Keystore. The key is not returned to this screen after saving."
        >
          <div className="flex gap-2">
            <input
              type="password"
              value={key}
              onChange={e => setKey(e.target.value)}
              placeholder={hasKey ? 'Key is saved. Paste to replace.' : 'Paste API key'}
              className={inputClass}
              autoComplete="off"
            />
            <button
              type="button"
              onClick={saveKey}
              disabled={!key.trim() || busy === 'key'}
              className="flex min-h-11 shrink-0 cursor-pointer items-center gap-1 rounded-2xl bg-face px-4 text-sm font-semibold text-[#110C07] disabled:opacity-40"
            >
              <KeyRound className="h-4 w-4" /> Save
            </button>
          </div>
          <SettingToggle
            label="Remember key on this device"
            hint="Persist encrypted key in Android Keystore across app restarts"
            checked={remember}
            onChange={v => void toggleRememberKey(v)}
          />
          {hasKey && (
            <div className="flex items-center justify-between pt-1">
              <span className="flex items-center gap-1.5 text-xs text-emerald-400">
                <CheckCircle2 className="h-3.5 w-3.5" /> Key saved
              </span>
              <button
                type="button"
                onClick={() => {
                  if (!isKeyProvider(provider)) return;
                  void removeProviderKey(provider).then(() => setHasKey(false)).catch(e => setError(e instanceof Error ? e.message : 'Could not remove the saved key.'));
                }}
                className="min-h-10 cursor-pointer text-xs text-red-400 hover:underline"
              >
                Remove saved key
              </button>
            </div>
          )}
        </Section>
      )}

      {provider === 'ollama' && (
        <Section title="Ollama Endpoint" hint="Ollama must be running on this Android device; network hosts are blocked by the native provider boundary.">
          <input
            value={settings.customEndpoint ?? ''}
            onChange={e => set({ customEndpoint: e.target.value })}
            placeholder="http://localhost:11434/v1"
            className={inputClass}
          />
        </Section>
      )}

      {provider !== 'tva-offline' && (
        <Section title="Model Selection">
          <div className="flex gap-2">
            {models.length > 0 ? (
              <select
                value={settings.model}
                onChange={e => set({ model: e.target.value })}
                className={inputClass}
              >
                {!models.some(m => m.id === settings.model) && settings.model && (
                  <option value={settings.model}>{settings.model}</option>
                )}
                {models.map(m => (
                  <option key={m.id} value={m.id}>
                    {m.label} {m.vision ? '· Vision' : ''}
                  </option>
                ))}
              </select>
            ) : (
              <div role="status" className={`${inputClass} flex items-center text-muted`}>
                {loadingModels ? 'Loading available models…' : error ?? 'No models are available for this provider account. Refresh the catalog or check the connection.'}
              </div>
            )}
            <button
              type="button"
              onClick={refreshModels}
              aria-label="Refresh models"
              className="grid min-h-11 w-11 shrink-0 cursor-pointer place-items-center rounded-2xl border border-white/[0.12] bg-[#0B0908] text-muted transition-colors hover:border-face hover:text-cream"
            >
              {loadingModels ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </button>
          </div>
        </Section>
      )}

      <Section title="Connection Test">
        <button
          type="button"
          onClick={async () => {
            setBusy('test');
            setTest(null);
            try {
              setTest(await brain.testConnection(settings));
            } catch (e) {
              setTest({ ok: false, message: describeError(e) ?? 'The provider connection test failed.' });
            } finally {
              setBusy(null);
            }
          }}
          disabled={busy === 'test'}
          className="flex min-h-11 cursor-pointer items-center gap-2 rounded-2xl border border-white/[0.12] bg-[#0B0908] px-4 py-2 text-sm font-medium text-cream transition-colors hover:border-face disabled:opacity-50"
        >
          {busy === 'test' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4 text-face" />}
          Test Connection
        </button>
        {test && (
          <p className={`flex items-start gap-1.5 text-xs ${test.ok ? 'text-emerald-400' : 'text-red-400'}`}>
            {test.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
            {test.message}
          </p>
        )}
        {error && <p className="text-xs text-red-400">{error}</p>}
      </Section>
    </>
  );
}

function VoiceSettingsTab({ settings, set }: { settings: AISettings; set: (p: Partial<AISettings>) => void }) {
  const engine = settings.voiceEngine ?? 'system';
  const active = useActiveVoice(settings);
  const [elKey, setElKey] = useState('');
  const [hasElKey, setHasElKey] = useState(false);
  const [elRemember, setElRemember] = useState(true);
  const [elError, setElError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const syncEl = () => {
      void hasProviderKey('elevenlabs')
        .then(v => { if (mounted) setHasElKey(v); })
        .catch(() => { if (mounted) setHasElKey(false); });
      void isProviderKeyRemembered('elevenlabs')
        .then(r => { if (mounted) setElRemember(r); })
        .catch(() => undefined);
    };
    syncEl();
    window.addEventListener('miss-minutes:keys-changed', syncEl);
    return () => {
      mounted = false;
      window.removeEventListener('miss-minutes:keys-changed', syncEl);
    };
  }, []);

  const engines: Array<[VoiceEngine, string, string]> = [
    ['system', 'System Voice', 'Built into Android / browser. Works completely offline.'],
    ['openai', 'OpenAI Voice', 'Natural expressive 1950s hostess speech. Requires OpenAI API key.'],
    ['elevenlabs', 'ElevenLabs', 'Custom ElevenLabs cloned voice synthesis.'],
  ];

  return (
    <>
      <SettingToggle
        label="She talks out loud"
        hint="Speaks responses aloud whenever she replies"
        checked={settings.voiceEnabled}
        onChange={v => set({ voiceEnabled: v })}
      />

      <div
        role="status"
        className={`rounded-3xl border p-4 ${
          active.reason ? 'border-face/40 bg-face/10' : 'border-emerald-500/35 bg-emerald-950/20'
        }`}
      >
        <span className="block text-[10px] font-semibold uppercase tracking-wider text-muted">Currently Active</span>
        <span className="mt-0.5 block text-sm font-semibold text-cream">{active.label}</span>
        {active.reason && <span className="mt-1 block text-xs text-[#FFD9B3]">Status: {active.reason}</span>}
      </div>

      <Section title="Voice Engine" hint="Choose how Miss Minutes synthesizes speech.">
        <div className="space-y-2">
          {engines.map(([id, label, hint]) => (
            <button
              key={id}
              type="button"
              onClick={() => set({ voiceEngine: id, voiceEngineChosen: true })}
              className={`min-h-12 w-full cursor-pointer rounded-2xl border p-3.5 text-left transition-colors ${
                engine === id
                  ? 'border-face/70 bg-face/15 text-[#FFF8EE]'
                  : 'border-white/[0.08] bg-[#0E0B08] text-muted hover:border-face/40 hover:text-cream'
              }`}
            >
              <span className="block text-sm font-semibold">{label}</span>
              <span className="mt-0.5 block text-xs text-muted">{hint}</span>
            </button>
          ))}
        </div>
      </Section>

      {engine === 'openai' && (
        <Section title="OpenAI Voice" hint="Select the voice style (Coral is the default hostess voice).">
          <select
            value={settings.openaiVoice ?? 'coral'}
            onChange={e => set({ openaiVoice: e.target.value })}
            className={inputClass}
          >
            {OPENAI_TTS_VOICES.map(v => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </Section>
      )}

      {engine === 'elevenlabs' && (
        <Section
          title="ElevenLabs Settings"
          hint="Stored natively inside encrypted Android Keystore-backed storage."
        >
          <div className="flex gap-2">
            <input
              type="password"
              value={elKey}
              onChange={e => setElKey(e.target.value)}
              placeholder={hasElKey ? 'Key saved. Paste to replace.' : 'ElevenLabs API Key'}
              className={inputClass}
              autoComplete="off"
            />
            <button
              type="button"
              disabled={!elKey.trim()}
              onClick={() => {
                setElError(null);
                void saveProviderKey('elevenlabs', elKey.trim(), { remember: elRemember })
                  .then(() => {
                    setElKey('');
                    setHasElKey(true);
                  })
                  .catch(e => setElError(e instanceof Error ? e.message : 'Could not save ElevenLabs key.'));
              }}
              className="min-h-11 cursor-pointer rounded-2xl bg-face px-4 text-sm font-semibold text-[#110C07] disabled:opacity-40"
            >
              Save
            </button>
          </div>
          <SettingToggle
            label="Remember key on this device"
            hint="Persist encrypted ElevenLabs key in Android Keystore across app restarts"
            checked={elRemember}
            onChange={next => {
              setElRemember(next);
              if (hasElKey) {
                void setProviderKeyRemembered('elevenlabs', next)
                  .then(updated => setElRemember(updated))
                  .catch(e => setElError(e instanceof Error ? e.message : 'Could not update key persistence.'));
              }
            }}
          />
          {hasElKey && (
            <div className="flex items-center justify-between pt-1">
              <span className="flex items-center gap-1.5 text-xs text-emerald-400">
                <CheckCircle2 className="h-3.5 w-3.5" /> Key saved
              </span>
              <button
                type="button"
                onClick={() => {
                  setElError(null);
                  void removeProviderKey('elevenlabs')
                    .then(() => setHasElKey(false))
                    .catch(e => setElError(e instanceof Error ? e.message : 'Could not remove saved key.'));
                }}
                className="min-h-10 cursor-pointer text-xs text-red-400 hover:underline"
              >
                Remove saved key
              </button>
            </div>
          )}
          {elError && <p className="text-xs text-red-400">{elError}</p>}
          <input
            value={settings.elevenLabsVoiceId ?? ''}
            onChange={e => set({ elevenLabsVoiceId: e.target.value.trim() })}
            placeholder="Voice ID from ElevenLabs"
            className={inputClass}
          />
        </Section>
      )}

      {engine === 'system' && (
        <Section title="System Voice Tuning">
          <label className="block space-y-1 text-xs text-muted">
            <div className="flex justify-between">
              <span>Pitch</span>
              <span className="font-mono text-cream">{settings.voicePitch.toFixed(2)}</span>
            </div>
            <input
              type="range"
              min={0.6}
              max={1.8}
              step={0.02}
              value={settings.voicePitch}
              onChange={e => set({ voicePitch: Number(e.target.value) })}
              className="w-full accent-[#FF7A1A]"
            />
          </label>
          <label className="block space-y-1 pt-2 text-xs text-muted">
            <div className="flex justify-between">
              <span>Speed</span>
              <span className="font-mono text-cream">{settings.voiceRate.toFixed(2)}</span>
            </div>
            <input
              type="range"
              min={0.7}
              max={1.4}
              step={0.02}
              value={settings.voiceRate}
              onChange={e => set({ voiceRate: Number(e.target.value) })}
              className="w-full accent-[#FF7A1A]"
            />
          </label>
        </Section>
      )}

      <button
        type="button"
        onClick={() =>
          speaker.say("Good to have you back, Boss. I checked the obvious things; they're behaving.", {
            ...settings,
            voiceEnabled: true,
          })
        }
        className="min-h-12 w-full cursor-pointer rounded-2xl bg-face py-3 text-sm font-semibold text-[#110C07] transition hover:brightness-110"
      >
        Hear Her Voice
      </button>
    </>
  );
}

function BehaviorSettingsTab({ settings, set }: { settings: AISettings; set: (p: Partial<AISettings>) => void }) {
  const [newPhrase, setNewPhrase] = useState('');
  const [wakeInfo, setWakeInfo] = useState<PlatformWakeStatus | null>(null);
  const [wakeMsg, setWakeMsg] = useState<string | null>(null);
  const [newDnc, setNewDnc] = useState('');
  const [dncError, setDncError] = useState<string | null>(null);

  const customPhrases = settings.customWakePhrases ?? [];
  const dncList = settings.dncNumbers ?? [];

  useEffect(() => {
    let active = true;
    void androidWakeStatus()
      .then(s => { if (active) setWakeInfo(s); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  const addPhrase = () => {
    const clean = newPhrase.trim();
    if (!clean) return;
    if (!customPhrases.some(p => p.toLowerCase() === clean.toLowerCase())) {
      set({ customWakePhrases: [...customPhrases, clean].slice(0, 16) });
    }
    setNewPhrase('');
  };

  const addDnc = () => {
    const clean = newDnc.trim();
    if (!isValidE164(clean)) {
      setDncError('Use strict E.164 format (e.g. +12025550199).');
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
      <SettingToggle
        label="Hologram look"
        hint="Glowing projection aesthetic like in the show. Off for flat cartoon look."
        checked={settings.hologramMode}
        onChange={v => set({ hologramMode: v })}
      />
      <SettingToggle
        label="Remember things about me"
        hint="Learns your preferences, routines and info into the Dossier file."
        checked={settings.memoryEnabled !== false}
        onChange={v => set({ memoryEnabled: v })}
      />
      <SettingToggle
        label="Always ask first"
        hint="Require manual approval before every action (even timers and notes)."
        checked={settings.strictApprovals === true}
        onChange={v => set({ strictApprovals: v })}
      />
      <SettingToggle
        label="Ambient chatter"
        hint="Occasional spontaneous remarks when things have been quiet."
        checked={settings.ambientChatter !== false}
        onChange={v => set({ ambientChatter: v })}
      />
      <SettingToggle
        label="Sound effects"
        hint="TVA clock ticks and UI audio feedback"
        checked={settings.soundEffects}
        onChange={v => set({ soundEffects: v })}
      />

      <Section
        title="Wake-Word Engine"
        hint="Wake phrases raise Owner Candidate presence locally; Android BiometricPrompt still guards privileged owner controls."
      >
        <SettingToggle
          label="Enable wake-word listening"
          hint="Detects 'Hey Miss Minutes', 'Miss Minutes', 'Hey Miss', 'Hey Minute', and custom phrases."
          checked={settings.wakeWordEnabled === true}
          onChange={v => set({ wakeWordEnabled: v })}
        />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              const call = wakeInfo?.listening ? androidWakeStop() : androidWakeStart();
              void call
                .then(async res => {
                  setWakeMsg(res.listening ? 'Wake listener started.' : 'Wake listener stopped.');
                  setWakeInfo(await androidWakeStatus());
                })
                .catch(e => setWakeMsg(describeError(e)));
            }}
            className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-2xl bg-face px-4 text-xs font-semibold text-[#110C07]"
          >
            <Mic className="h-4 w-4" />
            {wakeInfo?.listening ? 'Stop Android Wake' : 'Start Android Wake'}
          </button>
          <button
            type="button"
            onClick={() => {
              void androidWakeFeed(customPhrases[0] ?? 'hey miss minutes', 0.92)
                .then(res => setWakeMsg(`${res.status}${res.phrase ? ` · "${res.phrase}"` : ''}`))
                .catch(e => setWakeMsg(describeError(e)));
            }}
            className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-2xl border border-white/[0.12] bg-[#0B0908] px-3.5 text-xs font-medium text-cream hover:border-face"
          >
            Test Wake Pulse
          </button>
        </div>
        {wakeInfo && (
          <p className="text-[11px] text-muted">
            Native status: {wakeInfo.listening ? 'Listening' : 'Idle'} · Mode {wakeInfo.mode} · Mic permission {wakeInfo.micPermission ? 'granted' : 'not granted'}
          </p>
        )}
        {wakeMsg && <p className="text-xs text-[#FFD9B3]">{wakeMsg}</p>}
        <div className="flex gap-2">
          <input
            value={newPhrase}
            onChange={e => setNewPhrase(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addPhrase(); } }}
            placeholder="Add custom wake phrase"
            className={inputClass}
          />
          <button
            type="button"
            onClick={addPhrase}
            disabled={!newPhrase.trim() || customPhrases.length >= 16}
            className="inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-1 rounded-2xl border border-white/[0.12] bg-[#0B0908] px-3.5 text-xs font-medium text-cream disabled:opacity-40"
          >
            <Plus className="h-4 w-4 text-face" /> Add
          </button>
        </div>
        {customPhrases.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {customPhrases.map(phrase => (
              <span key={phrase} className="inline-flex items-center gap-1.5 rounded-full border border-face/40 bg-face/10 px-3 py-1 text-xs text-[#FFD9B3]">
                {phrase}
                <button
                  type="button"
                  onClick={() => set({ customWakePhrases: customPhrases.filter(p => p !== phrase) })}
                  aria-label={`Remove ${phrase}`}
                  className="cursor-pointer hover:text-white"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
            ))}
          </div>
        )}
      </Section>

      <Section
        title="Outbound Calling Guard"
        hint="Miss Minutes brand voice ONLY, mandatory upfront AI identity disclosure, quiet hours, and local Do-Not-Call list."
      >
        <SettingToggle
          label="Enforce Calling Quiet Hours"
          hint="Blocks outbound calling during the configured window (supports midnight crossover)."
          checked={settings.callQuietHoursEnabled !== false}
          onChange={v => set({ callQuietHoursEnabled: v })}
        />
        <div className="flex gap-3">
          <label className="flex flex-1 flex-col gap-1 text-xs text-muted">
            Quiet Starts
            <input
              type="time"
              value={formatMinutes(settings.callQuietStartMin ?? DEFAULT_QUIET_START_MIN)}
              onChange={e => {
                const parsed = parseTimeInput(e.target.value);
                if (parsed !== null) set({ callQuietStartMin: parsed });
              }}
              className="min-h-11 rounded-2xl border border-white/[0.12] bg-[#0B0908] px-3 text-cream"
            />
          </label>
          <label className="flex flex-1 flex-col gap-1 text-xs text-muted">
            Quiet Ends
            <input
              type="time"
              value={formatMinutes(settings.callQuietEndMin ?? DEFAULT_QUIET_END_MIN)}
              onChange={e => {
                const parsed = parseTimeInput(e.target.value);
                if (parsed !== null) set({ callQuietEndMin: parsed });
              }}
              className="min-h-11 rounded-2xl border border-white/[0.12] bg-[#0B0908] px-3 text-cream"
            />
          </label>
        </div>
        <div className="flex gap-2">
          <input
            value={newDnc}
            onChange={e => setNewDnc(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addDnc(); } }}
            placeholder="Do-Not-Call E.164 (e.g. +12025550199)"
            className={inputClass}
          />
          <button
            type="button"
            onClick={addDnc}
            disabled={!newDnc.trim()}
            className="inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-1 rounded-2xl border border-white/[0.12] bg-[#0B0908] px-3.5 text-xs font-medium text-cream disabled:opacity-40"
          >
            <PhoneCall className="h-4 w-4 text-face" /> Block
          </button>
        </div>
        {dncError && <p className="text-xs text-red-400">{dncError}</p>}
        {dncList.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {dncList.map(num => (
              <span key={num} className="inline-flex items-center gap-1.5 rounded-full border border-red-500/40 bg-red-950/25 px-3 py-1 font-mono text-[11px] text-red-200">
                {num}
                <button
                  type="button"
                  onClick={() => set({ dncNumbers: dncList.filter(n => n !== num) })}
                  aria-label={`Remove ${num}`}
                  className="cursor-pointer hover:text-white"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
            ))}
          </div>
        )}
      </Section>

      <Section title="Home City" hint="Used for weather reports and local time calculations.">
        <input
          value={settings.homeCity ?? ''}
          onChange={e => set({ homeCity: e.target.value })}
          placeholder="e.g. Pune or New York"
          className={inputClass}
        />
      </Section>

      <Section title="Her Personality" hint="Custom instructions and system prompt passed to the AI model.">
        <textarea
          rows={5}
          value={settings.systemPrompt}
          onChange={e => set({ systemPrompt: e.target.value })}
          placeholder="Optional style notes. The core Miss Minutes personality stays in effect."
          className={`${inputClass} font-mono text-xs`}
        />
      </Section>
    </>
  );
}

function AndroidSettingsTab() {
  const native = useNativeState();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  const info = native.info;
  const ready = native.phase === 'ready' && info !== null;

  async function run(action: () => Promise<unknown>, pendingMessage = 'Applying Android setting…'): Promise<void> {
    setBusy(true);
    setMessage(null);
    setProgress(pendingMessage);
    try {
      await action();
    } catch (error) {
      setMessage(describeError(error));
    } finally {
      setBusy(false);
      setProgress(null);
      await native.refresh();
    }
  }

  return (
    <>
      {native.phase === 'offline' && (
        <div role="status" className="rounded-2xl border border-face/40 bg-face/10 px-4 py-3 text-sm text-cream">
          Open this in the Miss Minutes app.
        </div>
      )}

      {message && (
        <div role="alert" className="rounded-2xl border border-red-500/45 bg-red-950/25 px-4 py-3 text-sm text-red-200">
          {message}
        </div>
      )}
      {progress && (
        <div role="status" aria-live="polite" className="flex items-center gap-2 rounded-2xl border border-face/30 bg-face/10 px-4 py-3 text-sm text-cream">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-face" />
          <span>{progress}</span>
        </div>
      )}

      <Section
        title="Permission Mode"
        hint="How much freedom she has to execute actions autonomously on this Android device."
      >
        <div role="radiogroup" aria-label="Mode" className="flex flex-col gap-2">
          {MODES.map(mode => {
            const selected = info?.mode === mode;
            return (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={busy || !ready}
                onClick={() => {
                  const raising = info?.mode != null && MODES.indexOf(mode) > MODES.indexOf(info.mode);
                  void run(
                    () => setMode(mode),
                    raising
                      ? 'Waiting for strong biometric verification, then saving the permission mode…'
                      : 'Saving the stricter permission mode…',
                  );
                }}
                className={`min-h-12 cursor-pointer rounded-2xl border px-4 py-3 text-left transition-colors disabled:opacity-50 ${
                  selected ? 'border-face/70 bg-face/15' : 'border-white/[0.08] bg-[#0E0B08] hover:border-face/35'
                }`}
              >
                <span className={`block text-sm font-semibold ${selected ? 'text-face' : 'text-cream'}`}>
                  {MODE_DETAILS[mode].label}
                </span>
                <span className="mt-0.5 block text-xs leading-snug text-muted">
                  {MODE_DETAILS[mode].text}
                </span>
              </button>
            );
          })}
        </div>
      </Section>

      <Section title="Reactions & Gestures">
        <Switch
          checked={info?.settings.proactive ?? false}
          label="React on her own"
          description="Spontaneous small emotions and gestures when events occur. Never speaks unprompted."
          disabled={busy || !ready}
          onChange={next => void run(
            () => setSetting('proactive', next),
            next ? 'Waiting for strong biometric verification, then enabling spontaneous reactions…'
              : 'Disabling spontaneous reactions…',
          )}
        />
      </Section>

      <Section title="Quiet Hours" hint="She automatically leaves the screen during these hours.">
        <Switch
          checked={info?.settings.quiet_hours_enabled ?? false}
          label="Enable Quiet Hours"
          disabled={busy || !ready}
          onChange={next => void run(() => setSetting('quiet_hours_enabled', next))}
        />
        <div className="flex gap-3 pt-1">
          <label className="flex flex-1 flex-col gap-1 text-xs text-muted">
            From
            <input
              type="time"
              value={formatMinutes(info?.settings.quiet_hours_start ?? 23 * 60)}
              disabled={busy || !ready}
              onChange={event => {
                const minutes = parseTimeInput(event.target.value);
                if (minutes !== null) void run(() => setSetting('quiet_hours_start', minutes));
              }}
              className="min-h-11 rounded-2xl border border-white/[0.12] bg-[#0B0908] px-3 text-cream disabled:opacity-50"
            />
          </label>
          <label className="flex flex-1 flex-col gap-1 text-xs text-muted">
            Until
            <input
              type="time"
              value={formatMinutes(info?.settings.quiet_hours_end ?? 7 * 60)}
              disabled={busy || !ready}
              onChange={event => {
                const minutes = parseTimeInput(event.target.value);
                if (minutes !== null) void run(() => setSetting('quiet_hours_end', minutes));
              }}
              className="min-h-11 rounded-2xl border border-white/[0.12] bg-[#0B0908] px-3 text-cream disabled:opacity-50"
            />
          </label>
        </div>
      </Section>

      <Section
        title="Folder Metadata Watcher"
        hint="Records names, sizes and dates of files in one folder you choose. Never reads file contents."
      >
        <button
          type="button"
          disabled={busy || !ready}
          onClick={() => void run(openMetadataWatcher)}
          className="min-h-12 w-full cursor-pointer rounded-2xl border border-white/[0.12] bg-white/[0.06] font-semibold text-cream transition-colors hover:bg-white/[0.1] disabled:opacity-50"
        >
          Open Folder Watcher
        </button>
      </Section>

      {info && (
        <p className="text-center text-xs text-muted">
          Miss Minutes v{info.version} (Android API {info.sdk})
        </p>
      )}
    </>
  );
}

function DataSettingsTab() {
  const [confirm, setConfirm] = useState(false);
  const [done, setDone] = useState(false);

  return (
    <Section
      title="Local Data"
      hint="Conversations, memories, schedules, to-dos, timers and notes stay in the encrypted Android owner database. The WebView cannot read them without an active owner session."
    >
      {!confirm ? (
        <button
          type="button"
          onClick={() => setConfirm(true)}
          className="flex min-h-12 cursor-pointer items-center gap-2 rounded-2xl border border-red-500/40 bg-red-950/25 px-4 py-2.5 text-sm font-medium text-red-200 transition-colors hover:bg-red-950/45"
        >
          <Trash2 className="h-4 w-4" /> Erase All Local Data
        </button>
      ) : (
        <div className="space-y-3 rounded-2xl border border-red-500/45 bg-red-950/30 p-4">
          <p className="text-xs leading-relaxed text-red-200">
            This permanently deletes all chats, memories, reminders, timers, to-dos and notes on this phone. It cannot be undone.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() =>
                void wipeAll().then(() => {
                  setDone(true);
                  setConfirm(false);
                })
              }
              className="min-h-11 cursor-pointer rounded-xl bg-red-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-red-500"
            >
              Confirm Erase
            </button>
            <button
              type="button"
              onClick={() => setConfirm(false)}
              className="min-h-11 cursor-pointer rounded-xl border border-white/[0.12] bg-white/[0.04] px-4 py-2 text-xs font-medium text-cream hover:bg-white/[0.08]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {done && <p className="text-xs text-emerald-400">All data has been successfully erased.</p>}
    </Section>
  );
}

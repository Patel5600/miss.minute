/**
 * Unified Security, Kill Switch, Audit Hash Chain, Offline Recovery Kit, Wake Engine & Latency Telemetry Console.
 * Works across both Windows Desktop (Tauri) and Android (WebView bridge).
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  Check,
  Copy,
  Cpu,
  KeyRound,
  Lock,
  Mic,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Zap,
} from 'lucide-react';
import type { AISettings } from '../types';
import { detectWakePhrase } from '../agent/wakePhrases';
import { getCombinedTelemetrySnapshot } from '../agent/telemetry';
import {
  emergencyKillSwitch,
  exportRecoveryKit,
  feedWakeScore,
  invokeNative,
  isDesktopRuntime,
  listAuditEntries,
  listenNative,
  verifyAuditChain,
  type AuditEntry,
  type DesktopOwnerStatus,
  type TelemetrySnapshot,
  type WakeFeedResult,
} from '../desktop/bridge';
import {
  androidCreateOwnerRecovery,
  androidEmergencyKillOwner,
  androidListOwnerAudit,
  androidVerifyAuditChain,
  androidWakeFeed,
  androidWakeStart,
  androidWakeStatus,
  androidWakeStop,
  isAndroidApp,
  onAndroidEvent,
  type PlatformWakeFeedResult,
  type PlatformWakeStatus,
} from '../agent/platform';
import { Button, ConfirmButton, Empty, ErrorLine, MicroLabel, PanelShell, Tabs, inputClass } from './ui';

export interface SecurityConsolePanelProps {
  className?: string;
  settings?: Pick<AISettings, 'wakeWordEnabled' | 'customWakePhrases'>;
  onUpdateWakeSettings?: (patch: Partial<Pick<AISettings, 'wakeWordEnabled' | 'customWakePhrases'>>) => void;
  onStateChanged?: () => void | Promise<void>;
}

interface UnifiedAuditRow {
  sequence: number;
  event: string;
  mode: string;
  detail: string;
  prevHash: string;
  entryHash: string;
}

function formatOutcome(result: WakeFeedResult | null): string {
  if (!result) return '';
  const o = result.outcome;
  if (typeof o === 'string') return `${o} (speech: ${result.speechActive ? 'yes' : 'no'})`;
  if ('triggered' in o) return `Triggered "${o.triggered.phrase}" (${Math.round(o.triggered.confidence * 100)}%)`;
  if ('accumulating' in o) return `Accumulating ${o.accumulating.hits}/${o.accumulating.required}`;
  if ('emergency_stop' in o) return `Emergency stop phrase "${o.emergency_stop.phrase}" executed kill switch`;
  return 'Processed';
}

export function SecurityConsolePanel({
  className,
  settings,
  onUpdateWakeSettings,
  onStateChanged,
}: SecurityConsolePanelProps) {
  const desktop = isDesktopRuntime();
  const android = isAndroidApp();

  const [tab, setTab] = useState<'controls' | 'audit' | 'telemetry'>('controls');
  const [desktopStatus, setDesktopStatus] = useState<DesktopOwnerStatus | null>(null);
  const [androidWake, setAndroidWake] = useState<PlatformWakeStatus | null>(null);
  const [telemetry, setTelemetry] = useState<TelemetrySnapshot | null>(null);

  const [auditValid, setAuditValid] = useState<boolean | null>(null);
  const [auditStatusLabel, setAuditStatusLabel] = useState('');
  const [auditRows, setAuditRows] = useState<UnifiedAuditRow[]>([]);

  const [wakeTranscript, setWakeTranscript] = useState('hey miss minutes');
  const [wakeConfidence, setWakeConfidence] = useState(0.92);
  const [wakeFeedback, setWakeFeedback] = useState('');
  const [newPhrase, setNewPhrase] = useState('');

  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [recoveryKit, setRecoveryKit] = useState('');
  const [copiedKit, setCopiedKit] = useState(false);

  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const customPhrases = settings?.customWakePhrases ?? [];
  const wakeEnabled = settings?.wakeWordEnabled === true;

  const refreshAll = useCallback(async () => {
    try {
      const snap = await getCombinedTelemetrySnapshot();
      setTelemetry(snap);
    } catch {
      // ignore telemetry refresh failure
    }
    if (desktop) {
      try {
        const status = await invokeNative<DesktopOwnerStatus>('owner_status');
        setDesktopStatus(status);
      } catch {
        // non-fatal when locked
      }
      try {
        const [valid, entries] = await Promise.all([verifyAuditChain(), listAuditEntries(40)]);
        setAuditValid(valid);
        setAuditStatusLabel(valid ? `Verified (${entries.length} entries)` : 'Tamper detected');
        setAuditRows(
          entries.map((e: AuditEntry) => ({
            sequence: e.sequence,
            event: e.event,
            mode: e.mode,
            detail: e.detail,
            prevHash: e.prev_hash,
            entryHash: e.entry_hash,
          })).reverse(),
        );
      } catch {
        // Audit read requires owner capability when unlocked.
      }
    } else if (android) {
      try {
        const wake = await androidWakeStatus();
        setAndroidWake(wake);
      } catch {
        // ignore if unavailable
      }
      try {
        const [v, list] = await Promise.all([androidVerifyAuditChain(), androidListOwnerAudit(40)]);
        setAuditValid(v.valid);
        setAuditStatusLabel(`${v.status} (${v.count} entries)`);
        setAuditRows(
          list.entries.map((raw, idx) => ({
            sequence: typeof raw.sequence === 'number' ? raw.sequence : idx + 1,
            event: typeof raw.event === 'string' ? raw.event : 'event',
            mode: typeof raw.mode === 'string' ? raw.mode : '—',
            detail: typeof raw.detail === 'string' ? raw.detail : JSON.stringify(raw),
            prevHash: typeof raw.prev_hash === 'string' ? raw.prev_hash : typeof raw.prevHash === 'string' ? raw.prevHash : '',
            entryHash: typeof raw.entry_hash === 'string' ? raw.entry_hash : typeof raw.entryHash === 'string' ? raw.entryHash : '',
          })).reverse(),
        );
      } catch {
        // Audit requires unlocked owner session on Android.
      }
    }
  }, [desktop, android]);

  useEffect(() => {
    void refreshAll();
    const timer = window.setInterval(() => {
      void getCombinedTelemetrySnapshot().then(setTelemetry).catch(() => undefined);
    }, 5000);
    let stopDesktopOwner: (() => void) | undefined;
    let stopDesktopKill: (() => void) | undefined;
    if (desktop) {
      void listenNative<DesktopOwnerStatus>('miss-minutes:owner-state', s => {
        setDesktopStatus(s);
        void refreshAll();
      }).then(u => { stopDesktopOwner = u; });
      void listenNative('miss-minutes:killed', () => {
        setNotice('Emergency kill switch activated — owner session revoked and voice/tasks halted.');
        void refreshAll();
      }).then(u => { stopDesktopKill = u; });
    }
    const stopAndroidKill = android
      ? onAndroidEvent('kill.happened', () => {
          setNotice('Emergency kill switch activated on Android.');
          void refreshAll();
        })
      : () => undefined;
    const stopAndroidWake = android
      ? onAndroidEvent('wake.state', () => {
          void androidWakeStatus().then(setAndroidWake).catch(() => undefined);
        })
      : () => undefined;
    return () => {
      window.clearInterval(timer);
      stopDesktopOwner?.();
      stopDesktopKill?.();
      stopAndroidKill();
      stopAndroidWake();
    };
  }, [desktop, android, refreshAll]);

  const handleEmergencyKill = async () => {
    setBusy('kill');
    setError(null);
    setNotice(null);
    try {
      if (desktop) {
        const next = await emergencyKillSwitch('security_console_kill');
        setDesktopStatus(next);
        setNotice('Kill switch executed. Owner authority returned to locked Guest Mode.');
      } else if (android) {
        const res = await androidEmergencyKillOwner();
        setNotice(res.killed ? `Kill switch executed. Mode is now ${res.mode}.` : 'Kill signal sent.');
      } else {
        setNotice('No native authority attached in browser preview mode.');
      }
      await onStateChanged?.();
      await refreshAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const handleTestWake = async () => {
    setBusy('wake-feed');
    setError(null);
    try {
      if (desktop) {
        const res = await feedWakeScore({
          confidence: wakeConfidence,
          transcript: wakeTranscript,
          customPhrases,
        });
        setDesktopStatus(res.ownerStatus);
        setWakeFeedback(formatOutcome(res));
      } else if (android) {
        const res: PlatformWakeFeedResult = await androidWakeFeed(wakeTranscript, wakeConfidence);
        setWakeFeedback(
          res.phrase
            ? `${res.status}: "${res.phrase}" (${Math.round((res.confidence ?? wakeConfidence) * 100)}%)`
            : `${res.status}${res.hits !== undefined ? ` (${res.hits}/${res.required ?? '?'})` : ''}`,
        );
      } else {
        const match = detectWakePhrase(wakeTranscript);
        setWakeFeedback(match.matched ? `Matched phrase "${match.phrase}"` : 'No wake phrase matched locally');
      }
      await refreshAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const handleExportRecovery = async () => {
    setError(null);
    setNotice(null);
    if (passphrase.length < 12 || passphrase !== confirmPassphrase) {
      setError('Enter matching passphrases of 12–256 printable ASCII characters.');
      return;
    }
    setBusy('recovery');
    try {
      let kit = '';
      if (desktop) {
        kit = await exportRecoveryKit(passphrase);
      } else if (android) {
        kit = (await androidCreateOwnerRecovery(passphrase)).material;
      } else {
        throw new Error('Recovery kit generation requires Desktop or Android native hardware keystore.');
      }
      setRecoveryKit(kit);
      setPassphrase('');
      setConfirmPassphrase('');
      setNotice('Encrypted offline recovery kit generated. Store it offline away from its passphrase.');
      await refreshAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const addCustomPhrase = () => {
    const clean = newPhrase.trim();
    if (!clean || !onUpdateWakeSettings) return;
    if (!customPhrases.some(p => p.toLowerCase() === clean.toLowerCase())) {
      onUpdateWakeSettings({ customWakePhrases: [...customPhrases, clean] });
    }
    setNewPhrase('');
  };

  const modeLabel = desktop
    ? desktopStatus?.mode === 'owner_mode'
      ? 'Owner Mode'
      : desktopStatus?.mode === 'owner_candidate'
        ? 'Owner Candidate'
        : 'Guest Mode'
    : android
      ? androidWake?.mode === 'OWNER_MODE'
        ? 'Owner Mode'
        : androidWake?.mode === 'OWNER_CANDIDATE'
          ? 'Owner Candidate'
          : 'Guest Mode'
      : 'Browser Session';

  const histogramEntries = Object.entries(telemetry?.histograms ?? {});
  const counterEntries = Object.entries(telemetry?.counters ?? {});
  const queueEntries = Object.entries(telemetry?.queue_depths ?? {});

  return (
    <PanelShell
      title="Security & Runtime Console"
      icon={<ShieldCheck className="h-4 w-4" />}
      className={className}
      subtitle={modeLabel}
      actions={
        <Button tone="ghost" onClick={() => void refreshAll()} className="min-h-11" label="Refresh security state">
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </Button>
      }
    >
      <ErrorLine message={error} />
      {notice && (
        <p role="status" className="rounded-xl border border-emerald-500/35 bg-emerald-950/25 px-3 py-2 text-xs text-emerald-200">
          {notice}
        </p>
      )}

      <Tabs
        idPrefix="security"
        label="Security console sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'controls', label: 'Kill, Wake & Recovery' },
          { id: 'audit', label: 'Audit Chain', count: auditRows.length },
          { id: 'telemetry', label: 'Telemetry', count: histogramEntries.length + counterEntries.length },
        ]}
      />

      {tab === 'controls' && (
        <div
          id="security-panel-controls"
          role="tabpanel"
          aria-labelledby="security-tab-controls"
          className="space-y-4"
        >
          {/* Emergency Kill Switch */}
          <div className="space-y-2.5 rounded-2xl border border-red-500/40 bg-red-950/20 p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-red-300" />
                <span className="text-sm font-semibold text-[#FFF8EE]">Emergency Kill Switch</span>
              </div>
              <span className="rounded-full border border-white/[0.12] bg-black/40 px-2.5 py-0.5 text-[10px] font-semibold uppercase text-[#FFD9B3]">
                {modeLabel}
              </span>
            </div>
            <p className="text-xs leading-relaxed text-[#CBBEB0]">
              Immediately halts active voice output, cancels running provider streams, locks owner storage, and returns Miss Minutes to Guest Mode.
            </p>
            <ConfirmButton
              question="Revoke active owner session & halt companion?"
              confirmLabel={busy === 'kill' ? 'Halting…' : 'Execute Kill'}
              tone="danger"
              onConfirm={handleEmergencyKill}
            >
              <Zap className="h-4 w-4" /> Trigger Emergency Kill Switch
            </ConfirmButton>
          </div>

          {/* Wake Word Engine */}
          <div className="space-y-3 rounded-2xl border border-white/[0.08] bg-[#16120E] p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Mic className="h-4 w-4 text-[#FF9240]" />
                <span className="text-sm font-semibold text-[#FFF8EE]">Local Wake Engine</span>
              </div>
              {android && androidWake && (
                <span className={`rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase ${
                  androidWake.listening
                    ? 'border-emerald-500/40 bg-emerald-950/35 text-emerald-300'
                    : 'border-white/[0.1] bg-white/[0.04] text-[#9D9082]'
                }`}>
                  {androidWake.listening ? 'Listening' : 'Idle'}
                </span>
              )}
            </div>

            {onUpdateWakeSettings && (
              <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-[#0E0B08] px-3 py-2 text-xs text-[#F5EFE6]">
                <span>Listen for wake phrases locally (raises Candidate mode only)</span>
                <input
                  type="checkbox"
                  checked={wakeEnabled}
                  onChange={e => onUpdateWakeSettings({ wakeWordEnabled: e.target.checked })}
                  className="h-4 w-4 accent-[#FF7A1A]"
                />
              </label>
            )}

            {android && (
              <div className="flex flex-wrap gap-2">
                <Button
                  tone="solid"
                  disabled={busy !== null}
                  onClick={() => void androidWakeStart().then(r => setAndroidWake(prev => prev ? { ...prev, listening: r.listening } : prev)).then(refreshAll).catch(e => setError(String(e)))}
                  className="min-h-11"
                >
                  Start Wake Listener
                </Button>
                <Button
                  tone="ghost"
                  disabled={busy !== null}
                  onClick={() => void androidWakeStop().then(r => setAndroidWake(prev => prev ? { ...prev, listening: r.listening } : prev)).then(refreshAll).catch(e => setError(String(e)))}
                  className="min-h-11"
                >
                  Stop Listener
                </Button>
              </div>
            )}

            {onUpdateWakeSettings && (
              <div className="space-y-2">
                <MicroLabel>Custom Wake Phrases</MicroLabel>
                <div className="flex gap-2">
                  <input
                    value={newPhrase}
                    onChange={e => setNewPhrase(e.target.value)}
                    placeholder="e.g. hey clockwork"
                    className={`${inputClass} min-h-11 flex-1`}
                  />
                  <Button tone="ghost" onClick={addCustomPhrase} disabled={!newPhrase.trim()} className="min-h-11">
                    <Plus className="h-3.5 w-3.5" /> Add
                  </Button>
                </div>
                {customPhrases.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {customPhrases.map(p => (
                      <span key={p} className="inline-flex items-center gap-1.5 rounded-xl border border-white/[0.1] bg-black/30 px-2.5 py-1 text-xs text-[#F5EFE6]">
                        {p}
                        <button
                          type="button"
                          aria-label={`Remove wake phrase ${p}`}
                          onClick={() => onUpdateWakeSettings({ customWakePhrases: customPhrases.filter(x => x !== p) })}
                          className="cursor-pointer text-[#9D9082] hover:text-red-300"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="space-y-2 border-t border-white/[0.06] pt-2.5">
              <MicroLabel>Score Wake Transcript (Two-Hit Verification)</MicroLabel>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_7rem_auto]">
                <input
                  value={wakeTranscript}
                  onChange={e => setWakeTranscript(e.target.value)}
                  placeholder="Transcript to test"
                  aria-label="Test wake transcript"
                  className={`${inputClass} min-h-11`}
                />
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={wakeConfidence}
                  onChange={e => setWakeConfidence(Math.min(1, Math.max(0, Number(e.target.value) || 0)))}
                  aria-label="Wake confidence score"
                  className={`${inputClass} min-h-11 font-mono`}
                />
                <Button tone="amber" onClick={() => void handleTestWake()} disabled={busy === 'wake-feed'} className="min-h-11 justify-center">
                  Test Wake
                </Button>
              </div>
              {wakeFeedback && <p className="text-xs text-[#FFD9B3]">{wakeFeedback}</p>}
            </div>
          </div>

          {/* Offline Recovery Kit Export */}
          {(desktop || android) && (
            <div className="space-y-2.5 rounded-2xl border border-white/[0.08] bg-[#16120E] p-3.5">
              <div className="flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-[#FF9240]" />
                <span className="text-sm font-semibold text-[#FFF8EE]">Offline Recovery Kit Export</span>
              </div>
              <p className="text-xs leading-relaxed text-[#9D9082]">
                Requires fresh owner authentication and a separate 12–256 character ASCII passphrase. Displayed only once.
              </p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <input
                  type="password"
                  autoComplete="new-password"
                  value={passphrase}
                  onChange={e => setPassphrase(e.target.value)}
                  placeholder="New passphrase (12+ chars)"
                  className={`${inputClass} min-h-11`}
                />
                <input
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassphrase}
                  onChange={e => setConfirmPassphrase(e.target.value)}
                  placeholder="Confirm passphrase"
                  className={`${inputClass} min-h-11`}
                />
              </div>
              <Button
                tone="solid"
                disabled={busy === 'recovery' || passphrase.length < 12 || passphrase !== confirmPassphrase}
                onClick={() => void handleExportRecovery()}
                className="min-h-11"
              >
                <Lock className="h-3.5 w-3.5" />
                {busy === 'recovery' ? 'Verifying & Sealing Kit…' : 'Verify Owner & Export Recovery Kit'}
              </Button>
              {recoveryKit && (
                <div className="space-y-2 rounded-xl border border-[#FF7A1A]/40 bg-black/40 p-3">
                  <textarea
                    readOnly
                    rows={4}
                    value={recoveryKit}
                    aria-label="Encrypted offline recovery kit"
                    className={`${inputClass} w-full font-mono text-[11px]`}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      tone="ghost"
                      onClick={() => void navigator.clipboard.writeText(recoveryKit).then(() => setCopiedKit(true))}
                      className="min-h-11"
                    >
                      {copiedKit ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                      {copiedKit ? 'Copied' : 'Copy Kit'}
                    </Button>
                    <Button tone="ghost" onClick={() => setRecoveryKit('')} className="min-h-11">
                      Hide Kit
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {tab === 'audit' && (
        <div
          id="security-panel-audit"
          role="tabpanel"
          aria-labelledby="security-tab-audit"
          className="space-y-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-white/[0.08] bg-[#16120E] px-3.5 py-2.5 text-xs">
            <span className="flex items-center gap-2 font-semibold text-[#FFF8EE]">
              <ShieldCheck className={`h-4 w-4 ${auditValid === false ? 'text-red-400' : 'text-emerald-400'}`} />
              Hash Chain Integrity
            </span>
            <span className={auditValid === false ? 'text-red-300' : 'text-emerald-300'}>
              {auditStatusLabel || 'Not verified'}
            </span>
          </div>

          {auditRows.length === 0 ? (
            <Empty>No tamper-evident audit entries recorded yet.</Empty>
          ) : (
            <ul className="space-y-2">
              {auditRows.map(entry => (
                <li
                  key={`${entry.sequence}-${entry.entryHash}`}
                  className="space-y-1 rounded-2xl border border-white/[0.08] bg-[#16120E] p-3 text-xs"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono font-semibold text-[#FFF8EE]">
                      #{entry.sequence} · {entry.event}
                    </span>
                    <span className="rounded-full border border-white/[0.1] bg-black/30 px-2 py-0.5 text-[10px] text-[#FFD9B3]">
                      {entry.mode}
                    </span>
                  </div>
                  {entry.detail && <p className="break-words text-[#CBBEB0]">{entry.detail}</p>}
                  {(entry.entryHash || entry.prevHash) && (
                    <p className="truncate font-mono text-[10px] text-[#786B5E]">
                      prev: {entry.prevHash.slice(0, 14)}… → hash: {entry.entryHash.slice(0, 14)}…
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {tab === 'telemetry' && (
        <div
          id="security-panel-telemetry"
          role="tabpanel"
          aria-labelledby="security-tab-telemetry"
          className="space-y-3"
        >
          <div className="space-y-2">
            <MicroLabel>Latency Histograms (μs, bounded 512-sample ring)</MicroLabel>
            {histogramEntries.length === 0 ? (
              <Empty>No latency samples recorded yet. Send a chat message or trigger wake evaluation.</Empty>
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {histogramEntries.map(([name, h]) => (
                  <div key={name} className="space-y-1.5 rounded-2xl border border-white/[0.08] bg-[#16120E] p-3 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 truncate font-mono font-semibold text-[#FFF8EE]">
                        <Activity className="h-3.5 w-3.5 shrink-0 text-[#FF9240]" />
                        {name}
                      </span>
                      <span className="text-[10px] text-[#9D9082]">n={h.count}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-1 font-mono text-[11px] text-[#CBBEB0]">
                      <span>p50: {(h.p50_us / 1000).toFixed(2)}ms</span>
                      <span>p95: {(h.p95_us / 1000).toFixed(2)}ms</span>
                      <span>p99: {(h.p99_us / 1000).toFixed(2)}ms</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="space-y-2 rounded-2xl border border-white/[0.08] bg-[#16120E] p-3">
              <MicroLabel>Runtime Counters</MicroLabel>
              {counterEntries.length === 0 ? (
                <Empty>No counters incremented yet.</Empty>
              ) : (
                <ul className="space-y-1 text-xs">
                  {counterEntries.map(([k, v]) => (
                    <li key={k} className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-[#CBBEB0]">{k}</span>
                      <span className="font-mono font-semibold text-[#FFF8EE]">{v}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="space-y-2 rounded-2xl border border-white/[0.08] bg-[#16120E] p-3">
              <MicroLabel>Queue Depths</MicroLabel>
              {queueEntries.length === 0 ? (
                <Empty>All runtime queues at 0.</Empty>
              ) : (
                <ul className="space-y-1 text-xs">
                  {queueEntries.map(([k, v]) => (
                    <li key={k} className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 truncate font-mono text-[#CBBEB0]">
                        <Cpu className="h-3 w-3 text-[#FF9240]" /> {k}
                      </span>
                      <span className="font-mono font-semibold text-[#FFF8EE]">{v}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </PanelShell>
  );
}

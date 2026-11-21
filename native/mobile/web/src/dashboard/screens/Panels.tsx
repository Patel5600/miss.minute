import { useEffect, useState } from 'react';
import {
  Activity,
  BookUser,
  CalendarClock,
  Fingerprint,
  GitBranch,
  Lock,
  PhoneCall,
  Plug,
  Radar,
  ShieldAlert,
  ShieldCheck,
  Timer,
} from 'lucide-react';
import type { AISettings } from '@desktop/types';
import { SacredTimeline } from '@desktop/panels/SacredTimeline';
import { Toolbelt } from '@desktop/panels/Toolbelt';
import { Dossier } from '@desktop/panels/Dossier';
import { MissionsPanel } from '@desktop/panels/MissionsPanel';
import { OffersPanel } from '@desktop/panels/OffersPanel';
import { CallingPanel } from '@desktop/panels/CallingPanel';
import { ConnectorsPanel } from '@desktop/panels/ConnectorsPanel';
import { SecurityConsolePanel } from '@desktop/panels/SecurityConsolePanel';
import { ActivityLog } from '@desktop/panels/ActivityLog';
import {
  defaultSettings,
  initializeSettings,
  loadSettings,
  onSettingsChange,
  saveSettings,
} from '@desktop/agent/settings';
import { authenticateOwner, describeError } from '../../shared/nativeApi.ts';
import { useNativeState } from '../useNative.ts';

type SubPanel =
  | 'timeline'
  | 'toolbelt'
  | 'dossier'
  | 'missions'
  | 'offers'
  | 'calling'
  | 'connectors'
  | 'security'
  | 'activity';

const SUB_PANELS: Array<{ id: SubPanel; label: string; icon: typeof Timer }> = [
  { id: 'timeline', label: 'Timeline', icon: CalendarClock },
  { id: 'toolbelt', label: 'Tools', icon: Timer },
  { id: 'dossier', label: 'Dossier', icon: BookUser },
  { id: 'missions', label: 'Missions', icon: GitBranch },
  { id: 'offers', label: 'Offers', icon: Radar },
  { id: 'calling', label: 'Calling', icon: PhoneCall },
  { id: 'connectors', label: 'Connectors', icon: Plug },
  { id: 'security', label: 'Security', icon: ShieldCheck },
  { id: 'activity', label: 'Activity', icon: Activity },
];

export function Panels({ ownerDataReady = true, onOpenSetup }: { ownerDataReady?: boolean; onOpenSetup?: () => void } = {}) {
  const native = useNativeState();
  const ownerAuthenticated = native.phase === 'ready' && native.info?.ownerAuthenticated === true;
  const ownerCandidate =
    !ownerAuthenticated
    && native.phase === 'ready'
    && (native.info?.operatingMode === 'OWNER_CANDIDATE' || native.info?.ownerCandidate === true);
  const ownerUnlocked = ownerDataReady && ownerAuthenticated;

  const [active, setActive] = useState<SubPanel>('timeline');
  const [aiSettings, setAiSettings] = useState<AISettings>(() => defaultSettings());
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);

  useEffect(() => {
    if (!ownerUnlocked) {
      setAiSettings(defaultSettings());
      return;
    }
    let activeMount = true;
    const stopListener = onSettingsChange(next => {
      if (activeMount) setAiSettings(next);
    });
    void initializeSettings()
      .then((s) => {
        if (activeMount) setAiSettings(s);
      })
      .catch(() => {
        if (activeMount) setAiSettings(loadSettings());
      });
    return () => {
      activeMount = false;
      stopListener();
    };
  }, [ownerUnlocked]);

  const updateAiSettings = (patch: Partial<AISettings>) => {
    if (!ownerUnlocked) return;
    const current = loadSettings();
    setAiSettings(saveSettings({ ...current, ...patch }));
  };

  const handleVerify = async () => {
    if (unlocking) return;
    setUnlocking(true);
    setUnlockError(null);
    try {
      await authenticateOwner();
      await native.refresh();
    } catch (error) {
      const msg = describeError(error);
      if (msg) setUnlockError(msg);
    } finally {
      setUnlocking(false);
    }
  };

  if (!ownerUnlocked) {
    return (
      <div className="mx-auto flex w-full min-w-0 max-w-lg flex-col gap-4 pb-4">
        <section className="rounded-3xl border border-white/[0.08] bg-[#14100C] p-6 shadow-[0_16px_44px_rgba(0,0,0,0.45)]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-face">
              <Lock className="h-3.5 w-3.5" /> Private Workspace
            </p>
            {ownerCandidate ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-face/40 bg-face/15 px-3 py-1 text-[11px] font-semibold text-[#FFD9B3]">
                <ShieldAlert className="h-3.5 w-3.5" /> Owner Candidate
              </span>
            ) : native.info?.ownerEnrolled && !ownerAuthenticated ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.1] bg-[#0B0908] px-3 py-1 text-[11px] font-semibold text-muted">
                <Lock className="h-3 w-3" /> Guest Mode
              </span>
            ) : null}
          </div>
          <h1 className="mt-3 text-xl font-semibold text-[#FFF8EE]">
            {ownerAuthenticated && !ownerDataReady
              ? 'Preparing encrypted owner data'
              : ownerCandidate
                ? 'Owner candidate recognized — verification needed'
                : native.info?.ownerEnrolled
                  ? 'Private owner workspace is locked'
                  : 'Set up owner access first'}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-[#CBBEB0]">
            {ownerAuthenticated && !ownerDataReady
              ? 'Sacred Timeline, Toolbelt, Dossier, and Activity stay locked until your encrypted owner store finishes preparing.'
              : ownerCandidate
                ? 'Local recognition suggests you are nearby, but private records remain sealed in SQLCipher until you verify on this device.'
                : native.info?.ownerEnrolled
                  ? 'Verify on this device to open Sacred Timeline, timers, reminders, notes, memory dossier, and activity logs.'
                  : 'Complete first-time Owner Setup in the Companion Hub before storing private timeline, notes, or memories.'}
          </p>
          {native.info?.ownerEnrolled && !ownerAuthenticated && (
            <button
              type="button"
              disabled={unlocking}
              onClick={() => void handleVerify()}
              className="mt-5 inline-flex min-h-12 cursor-pointer items-center gap-2 rounded-2xl bg-face px-5 text-sm font-semibold text-[#110C07] transition-colors hover:brightness-110 disabled:opacity-60"
            >
              <Fingerprint className="h-4 w-4" />
              {unlocking ? 'Waiting for device verification…' : 'Verify Identity'}
            </button>
          )}
          {!native.info?.ownerEnrolled && onOpenSetup && (
            <button
              type="button"
              onClick={onOpenSetup}
              className="mt-5 inline-flex min-h-12 cursor-pointer items-center gap-2 rounded-2xl bg-face px-5 text-sm font-semibold text-[#110C07] transition-colors hover:brightness-110"
            >
              <Fingerprint className="h-4 w-4" />
              Go to Companion Hub
            </button>
          )}
          {unlockError && (
            <p role="alert" className="mt-3 rounded-xl border border-red-500/40 bg-red-950/25 px-3 py-2 text-xs text-red-200">
              {unlockError}
            </p>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-2xl flex-col gap-3.5 pb-4">
      <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Workspace panels">
        {SUB_PANELS.map(({ id, label, icon: Icon }) => {
          const selected = active === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setActive(id)}
              className={`flex min-h-11 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-2xl border px-4 py-2 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-face ${
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

      <div className="w-full min-w-0">
        {active === 'timeline' && <SacredTimeline />}
        {active === 'toolbelt' && <Toolbelt />}
        {active === 'dossier' && (
          <Dossier homeCity={aiSettings.homeCity} onHomeCityChange={city => updateAiSettings({ homeCity: city })} />
        )}
        {active === 'missions' && <MissionsPanel />}
        {active === 'offers' && <OffersPanel />}
        {active === 'calling' && (
          <CallingPanel settings={aiSettings} onUpdateCallingSettings={patch => updateAiSettings(patch)} />
        )}
        {active === 'connectors' && <ConnectorsPanel />}
        {active === 'security' && (
          <SecurityConsolePanel
            settings={aiSettings}
            onUpdateWakeSettings={patch => updateAiSettings(patch)}
            onStateChanged={() => native.refresh()}
          />
        )}
        {active === 'activity' && <ActivityLog />}
      </div>
    </div>
  );
}

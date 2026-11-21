import { useState } from 'react';
import {
  Fingerprint,
  Info,
  LoaderCircle,
  Lock,
  MessageSquare,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import type { Emotion, Gesture, MouthFrame } from '@desktop/types';
import { MissMinutesRig } from '@desktop/character/MissMinutesRig';
import {
  ackKillNotice,
  authenticateOwner,
  consentToLocalSensors,
  describeError,
  describeKillNotice,
  describeOverlay,
  LEVEL_DETAILS,
  requestOverlayPermission,
  setupFaceProfile,
  setupOwnerDevice,
  setupPresenceCalibration,
  setupSpeakerProfile,
  setSetting,
  startOverlay,
  stopOverlay,
} from '../../shared/nativeApi.ts';
import { ROAMING_LEVELS } from '../../shared/vocabulary.ts';
import { Switch } from '../Switch.tsx';
import { useNativeState } from '../useNative.ts';

const dateFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
const TONE_DOT = { ok: 'bg-face', warn: 'bg-red-500', idle: 'bg-muted' } as const;

export interface MobileHomeProps {
  onSetupComplete?: () => void;
  onOpenChat?: () => void;
  onPoke?: () => void;
  rigEmotion?: Emotion;
  rigGesture?: { g: Gesture; k: number };
  rigSpeaking?: boolean;
  rigMouth?: MouthFrame;
  hologramMode?: boolean;
}

export function Home({
  onSetupComplete,
  onOpenChat,
  onPoke,
  rigEmotion = 'cheerful',
  rigGesture = { g: 'none', k: 0 },
  rigSpeaking = false,
  rigMouth = 0,
  hologramMode = false,
}: MobileHomeProps = {}) {
  const native = useNativeState();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [skippedProfiles, setSkippedProfiles] = useState<{ face: boolean; voice: boolean; presence: boolean }>(() => {
    try {
      return {
        face: localStorage.getItem('mm-setup-skip-face') === '1',
        voice: localStorage.getItem('mm-setup-skip-voice') === '1',
        presence: localStorage.getItem('mm-setup-skip-presence') === '1',
      };
    } catch { return { face: false, voice: false, presence: false }; }
  });

  const info = native.info;
  const ready = native.phase === 'ready' && info !== null;
  const runtimeState = info?.overlay.runtime?.state ?? null;
  const transitionPending = runtimeState === 'STARTING' || runtimeState === 'STOPPING' || runtimeState === 'RECOVERING';
  const companionSwitchChecked = runtimeState
    ? runtimeState === 'STARTING' || runtimeState === 'RUNNING' || runtimeState === 'STOPPING' || runtimeState === 'RECOVERING'
    : (info?.overlay.running ?? false);
  const companionSwitchLabel = runtimeState === 'STARTING'
    ? 'Starting Miss Minutes…'
    : runtimeState === 'STOPPING'
      ? 'Stopping Miss Minutes…'
      : runtimeState === 'RECOVERING'
        ? 'Reconnecting Miss Minutes…'
        : 'Show her on my screen';
  const description = info ? describeOverlay(info.overlay) : null;
  const setupStep = !info?.sensorConsentGiven ? 'consent'
    : !info.faceProfileEnrolled && !info.faceProfilePending && !skippedProfiles.face ? 'face'
      : !info.speakerProfileEnrolled && !info.speakerProfilePending && !skippedProfiles.voice ? 'voice'
        : !skippedProfiles.presence ? 'presence'
          : (!info.ownerEnrolled || info.ownerClaimPending) ? 'device' : 'complete';

  function skipProfile(kind: 'face' | 'voice' | 'presence'): void {
    const next = { ...skippedProfiles, [kind]: true };
    setSkippedProfiles(next);
    try { localStorage.setItem(`mm-setup-skip-${kind}`, '1'); } catch { /* Skip affects onboarding only; authorization is native. */ }
  }

  async function run(action: () => Promise<void>, requiresOwner = true): Promise<void> {
    setBusy(true);
    setMessage(null);
    setActionStatus(requiresOwner && info?.ownerEnrolled && !info.ownerAuthenticated
      ? 'Waiting for device verification…'
      : 'Applying your change…');
    try {
      if (requiresOwner && info && !info.ownerEnrolled) {
        throw new Error('Set up owner access with the Owner setup step below before changing companion settings.');
      }
      if (requiresOwner && info?.ownerEnrolled && !info.ownerAuthenticated) await authenticateOwner();
      await action();
      setActionStatus('Done. Android confirmed the request.');
    } catch (error) {
      setMessage(describeError(error));
      setActionStatus(null);
    } finally {
      setBusy(false);
      await native.refresh();
    }
  }

  async function turnOn(): Promise<void> {
    const result = await startOverlay();
    if (result.needsOverlayPermission) {
      setMessage('Allow Display over other apps first, then turn her on again.');
    }
  }

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-lg flex-col gap-4 pb-4">
      {native.phase === 'offline' && (
        <div role="status" className="rounded-2xl border border-face/40 bg-face/10 px-4 py-3 text-sm text-cream">
          Open this inside the Miss Minutes Android app to control the floating companion.
        </div>
      )}

      {info?.killNotice && (
        <section role="status" aria-label="Stopped" className="rounded-3xl border border-face/45 bg-face/10 p-4 text-sm leading-relaxed">
          <p className="text-cream">{describeKillNotice(info.killNotice)}</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(ackKillNotice)}
            className="mt-3 min-h-12 cursor-pointer rounded-2xl bg-face px-6 text-sm font-semibold text-[#110C07] transition-colors hover:brightness-110 disabled:opacity-50"
          >
            Got it
          </button>
        </section>
      )}

      {/* Companion Hub Hero Card */}
      <header className="relative overflow-hidden rounded-3xl border border-white/[0.08] bg-[radial-gradient(ellipse_at_top_right,rgba(255,122,26,0.16),transparent_60%),#14100C] p-5 shadow-[0_16px_44px_rgba(0,0,0,0.45)]">
        <div className="relative z-10 flex items-center gap-4">
          <button
            type="button"
            onClick={onPoke}
            aria-label="Poke Miss Minutes"
            className="grid h-24 w-24 shrink-0 cursor-pointer place-items-center rounded-3xl border border-face/20 bg-radial from-face/15 via-transparent to-transparent p-1 transition-transform active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-face"
          >
            <MissMinutesRig
              emotion={rigEmotion}
              gesture={rigGesture.g}
              gestureKey={rigGesture.k}
              isSpeaking={rigSpeaking}
              mouthFrame={rigMouth}
              skin={hologramMode ? 'hologram' : 'classic'}
              gaze="none"
              style={{ width: '100%', height: '100%' }}
            />
          </button>

          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-face">
                <Sparkles className="h-3.5 w-3.5" /> Companion Hub
              </p>
              <span
                className={`h-2.5 w-2.5 shrink-0 rounded-full ring-4 ring-black/30 ${description ? TONE_DOT[description.tone] : 'bg-muted'}`}
                aria-label={description?.headline ?? 'Checking status'}
              />
            </div>
            <h1 className="mt-1 text-xl font-semibold tracking-tight text-[#FFF8EE]">
              Miss Minutes
            </h1>
            <p className="mt-0.5 text-xs text-muted">{dateFormat.format(new Date())}</p>
            {onOpenChat && (
              <button
                type="button"
                onClick={onOpenChat}
                className="mt-2.5 inline-flex min-h-10 cursor-pointer items-center gap-1.5 rounded-full border border-white/[0.1] bg-white/[0.04] px-3 py-1 text-xs font-medium text-cream transition-colors hover:bg-white/[0.08]"
              >
                <MessageSquare className="h-3.5 w-3.5 text-face" /> Back to chat
              </button>
            )}
          </div>
        </div>

        <div className="relative z-10 mt-5 grid grid-cols-2 gap-2.5">
          <div className="rounded-2xl border border-white/[0.06] bg-[#0B0908]/65 px-3.5 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Runtime</p>
            <p className="mt-1 truncate text-sm font-semibold text-[#FFF8EE]">
              {description?.headline ?? 'Checking status'}
            </p>
          </div>
          <div className="rounded-2xl border border-white/[0.06] bg-[#0B0908]/65 px-3.5 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Authority</p>
            {info?.ownerAuthenticated ? (
              <p className="mt-1 flex items-center gap-1.5 text-sm font-semibold text-emerald-400">
                <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">Owner Mode</span>
              </p>
            ) : !info?.ownerAuthenticated && (info?.operatingMode === 'OWNER_CANDIDATE' || info?.ownerCandidate) ? (
              <p className="mt-1 flex items-center gap-1.5 text-sm font-semibold text-amber-300">
                <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">Candidate</span>
              </p>
            ) : info?.ownerEnrolled ? (
              <p className="mt-1 flex items-center gap-1.5 text-sm font-semibold text-muted">
                <Lock className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">Guest Mode</span>
              </p>
            ) : (
              <p className="mt-1 text-sm font-semibold text-muted">Not set up</p>
            )}
          </div>
        </div>

        <div className="relative z-10 mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
          <span>Mode: {info?.settings.roaming_level?.toLowerCase() ?? 'loading'}</span>
          <span>{info?.overlay.runtimeState === 'RUNNING' ? 'Overlay active' : info?.overlay.runtimeState?.toLowerCase() ?? 'checking connection'}</span>
        </div>
      </header>

      {!info?.ownerAuthenticated && info?.ownerEnrolled && (info.operatingMode === 'OWNER_CANDIDATE' || info.ownerCandidate) && (
        <section aria-label="Owner verification prompt" className="rounded-3xl border border-face/40 bg-[#1C140C] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-[#FFF4E4]">Owner candidate recognized</p>
              <p className="mt-0.5 text-xs leading-relaxed text-[#CBBEB0]">
                Local recognition signals suggest you are nearby. Verify on this device to unlock private memory, settings, and owner controls.
              </p>
            </div>
            <button
              type="button"
              disabled={busy || !ready}
              onClick={() => void run(authenticateOwner, false)}
              className="inline-flex min-h-12 shrink-0 cursor-pointer items-center gap-2 rounded-2xl bg-face px-4 text-sm font-semibold text-[#110C07] transition-colors hover:brightness-110 disabled:opacity-50"
            >
              <Fingerprint className="h-4 w-4" />
              Verify Identity
            </button>
          </div>
        </section>
      )}

      {info && setupStep !== 'complete' && (
        <section aria-label="First-time owner setup" className="rounded-3xl border border-face/35 bg-[#19130D] p-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-face">
            First-time setup · {setupStep === 'consent' ? '1 of 5' : setupStep === 'face' ? '2 of 5' : setupStep === 'voice' ? '3 of 5' : setupStep === 'presence' ? '4 of 5' : '5 of 5'}
          </p>
          <h2 className="mt-1.5 text-lg font-semibold text-[#FFF8EE]">
            {setupStep === 'consent' ? 'Choose local sensor setup'
              : setupStep === 'face' ? 'Enroll face presence'
                : setupStep === 'voice' ? 'Enroll your voice'
                  : setupStep === 'presence' ? 'Calibrate attention'
                    : 'Verify the owner claim'}
          </h2>
          <p className="mt-1.5 text-sm leading-relaxed text-[#CBBEB0]">
            {setupStep === 'consent'
              ? 'Review what camera and microphone use means. You can decline, skip either profile, or revoke Android permissions later.'
              : setupStep === 'face'
                ? info.faceProfilePending
                  ? 'Face samples are staged locally. They stay inactive until Android verifies the owner claim.'
                  : 'Capture several local samples. Face matching can suggest presence, but cannot unlock private data.'
                : setupStep === 'voice'
                  ? info.speakerProfilePending
                    ? 'Voice samples are staged locally. They stay inactive until Android verifies the owner claim.'
                    : 'Record short natural samples. Speaker matching can suggest who is speaking, but cannot grant authority.'
                  : setupStep === 'presence'
                    ? 'Optional gaze and head-pose calibration supports interaction only. It is foreground-only and does not identify or authenticate you.'
                    : 'Android will verify the initial owner claim and create this device’s protected signing key. This activates any staged profiles.'}
          </p>
          <button
            type="button"
            disabled={busy || !ready}
            onClick={() => void run(
              setupStep === 'consent' ? consentToLocalSensors
                : setupStep === 'face' ? setupFaceProfile
                  : setupStep === 'voice' ? setupSpeakerProfile
                    : setupStep === 'presence' ? async () => { await setupPresenceCalibration(); skipProfile('presence'); }
                      : setupOwnerDevice,
              false,
            )}
            className="mt-4 min-h-12 w-full cursor-pointer rounded-2xl bg-face px-4 text-sm font-semibold text-[#110C07] transition-colors hover:brightness-110 disabled:opacity-55"
          >
            {setupStep === 'consent' ? 'Review sensor disclosure'
              : setupStep === 'device' ? 'Verify and activate owner'
                : setupStep === 'face' ? 'Set up face presence'
                  : setupStep === 'voice' ? 'Set up speaker profile'
                    : 'Open presence calibration'}
          </button>
          {setupStep === 'consent' && (
            <p className="mt-2.5 text-xs text-muted">
              No background camera or microphone session is started by this step. Android asks separately when each enrollment opens.
            </p>
          )}
          {setupStep === 'face' && (
            <>
              <p className="mt-2.5 text-xs text-muted">
                Camera starts only after you open face setup. Face recognition is optional and cannot unlock owner access.
              </p>
              <button
                type="button"
                onClick={() => skipProfile('face')}
                className="mt-2 min-h-12 w-full cursor-pointer rounded-2xl border border-white/[0.1] bg-white/[0.03] text-sm font-medium text-[#CBBEB0] hover:bg-white/[0.06]"
              >
                Skip face for now
              </button>
            </>
          )}
          {setupStep === 'voice' && (
            <>
              <p className="mt-2.5 text-xs text-muted">
                Microphone permission is requested only when you start voice enrollment. Samples are processed locally for the profile.
              </p>
              <button
                type="button"
                onClick={() => skipProfile('voice')}
                className="mt-2 min-h-12 w-full cursor-pointer rounded-2xl border border-white/[0.1] bg-white/[0.03] text-sm font-medium text-[#CBBEB0] hover:bg-white/[0.06]"
              >
                Skip voice for now
              </button>
            </>
          )}
          {setupStep === 'presence' && (
            <button
              type="button"
              onClick={() => skipProfile('presence')}
              className="mt-2.5 min-h-12 w-full cursor-pointer rounded-2xl border border-white/[0.1] bg-white/[0.03] text-sm font-medium text-[#CBBEB0] hover:bg-white/[0.06]"
            >
              Skip calibration
            </button>
          )}
        </section>
      )}

      {info && setupStep === 'complete' && (
        <section aria-label="Owner setup complete" className="flex flex-wrap items-center justify-between gap-3 rounded-3xl border border-emerald-500/35 bg-emerald-950/20 p-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-[#FFF8EE]">Owner setup is ready</h2>
            <p className="mt-0.5 text-xs text-[#CBBEB0]">
              Device verification is the authority anchor. Skipped local profiles can be added later.
            </p>
          </div>
          {onSetupComplete && (
            <button
              type="button"
              onClick={onSetupComplete}
              className="min-h-12 cursor-pointer rounded-2xl bg-face px-4 text-sm font-semibold text-[#110C07]"
            >
              Continue to settings
            </button>
          )}
        </section>
      )}

      <section aria-label="Live status" className="rounded-3xl border border-white/[0.08] bg-[#16120E] px-4 py-3.5">
        <p className="text-sm font-medium text-[#FFF8EE]">
          {description?.detail ?? 'Reading the Android service state.'}
        </p>
      </section>

      {message && (
        <div role="alert" className="rounded-2xl border border-red-500/45 bg-red-950/25 px-4 py-3 text-sm text-red-200">
          {message}
        </div>
      )}

      <section aria-label="On my screen" className="rounded-3xl border border-white/[0.08] bg-[#16120E] px-4 pb-4 pt-2">
        <Switch
          checked={companionSwitchChecked}
          label={companionSwitchLabel}
          disabled={busy || !ready || transitionPending}
          onChange={(next) => void run(next ? turnOn : async () => void (await stopOverlay()))}
        />
        {description?.needsOverlayPermission && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(requestOverlayPermission)}
            className="mt-3 min-h-12 w-full cursor-pointer rounded-2xl bg-face px-4 text-sm font-semibold text-[#110C07] transition-colors hover:brightness-110 disabled:opacity-50"
          >
            Allow Display over other apps
          </button>
        )}
        {description?.hiddenByTimer && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(async () => void (await setSetting('hidden_until_ms', 0)))}
            className="mt-3 min-h-12 w-full cursor-pointer rounded-2xl border border-white/[0.12] bg-white/[0.05] px-4 text-sm font-semibold text-cream disabled:opacity-50"
          >
            Show her now
          </button>
        )}
        {ready && description?.notificationsOff && (
          <p className="mt-3 text-xs leading-snug text-muted">
            Notifications are off, so the Stop button in the notification shade is not shown. You can still stop her from the red button above or from her menu.
          </p>
        )}
      </section>

      <section aria-label="Roaming" className="rounded-3xl border border-white/[0.08] bg-[#16120E] p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-face">How much she roams</h2>
          {info?.ownerEnrolled && !info.ownerAuthenticated && (
            <span className="rounded-full border border-face/35 bg-face/10 px-2.5 py-0.5 text-[11px] font-medium text-[#FFD9B3]">
              Verify to change
            </span>
          )}
        </div>
        <div role="radiogroup" aria-label="Roaming level" aria-busy={busy} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {ROAMING_LEVELS.map((level) => {
            const selected = info?.settings.roaming_level === level;
            return (
              <button
                key={level}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={busy || !ready}
                onClick={() => void run(async () => {
                  const updated = await setSetting('roaming_level', level);
                  if (updated.roaming_level !== level) throw new Error('Android did not confirm the selected roaming mode.');
                })}
                className={`min-h-12 cursor-pointer rounded-2xl border px-3 text-sm font-semibold transition active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-face disabled:cursor-wait disabled:opacity-55 ${
                  selected
                    ? 'border-face bg-face text-[#110C07] shadow-md shadow-face/15'
                    : 'border-white/[0.08] bg-[#0E0B08] text-cream hover:border-face/50'
                }`}
              >
                {LEVEL_DETAILS[level].label}
              </button>
            );
          })}
        </div>
        {busy && (
          <p role="status" className="mt-3 flex min-h-6 items-center gap-2 text-xs text-face">
            <LoaderCircle className="h-4 w-4 animate-spin" />
            {actionStatus}
          </p>
        )}
        {!busy && actionStatus && <p role="status" className="mt-3 text-xs text-emerald-300">{actionStatus}</p>}
        <p className="mt-3 text-sm leading-snug text-cream/90">
          {info ? LEVEL_DETAILS[info.settings.roaming_level].text : 'Calm is the default.'}
        </p>
        {info && (
          <p role="status" className="mt-2 text-xs leading-snug text-muted">
            {info.overlay.runtimeState === 'RUNNING'
              ? info.overlay.appliedRoamingLevel === info.settings.roaming_level
                ? `${info.settings.roaming_level[0]}${info.settings.roaming_level.slice(1).toLowerCase()} is active in the companion runtime.`
                : `Saved ${info.settings.roaming_level.toLowerCase()}; the runtime currently applies ${info.overlay.appliedRoamingLevel?.toLowerCase() ?? 'its safe limit'}.`
              : 'Saved. The selected mode applies when the companion starts.'}
          </p>
        )}
        <p className="mt-2 text-xs leading-snug text-muted">
          Right now she can stand, walk, hop and do eight gestures. Running, hanging, climbing, sitting on edges, jumping and peeking switch on only when her body can draw them.
        </p>
      </section>

      <section aria-label="When I close the app" className="rounded-3xl border border-white/[0.08] bg-[#16120E] px-4 py-1">
        <Switch
          checked={info?.settings.keep_after_close ?? false}
          label="Keep her on screen after I close the app"
          description="Off: swiping the app away from Recents makes her leave. On: she stays until you stop her. Pressing Home never stops her."
          disabled={busy || !ready}
          onChange={(next) => void run(async () => void (await setSetting('keep_after_close', next)))}
        />
      </section>

      <section className="rounded-3xl border border-white/[0.08] bg-[#16120E] p-4 text-sm leading-relaxed">
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-face">
          <Info className="h-4 w-4" /> What she can and cannot do
        </h2>
        <ul className="list-disc space-y-1.5 pl-5 text-xs leading-relaxed text-[#CBBEB0]">
          <li>She cannot see other apps&apos; windows, so she roams the edges of your screen instead.</li>
          <li>To appear above other apps she needs &ldquo;Display over other apps&rdquo;. Without it she stays in this app.</li>
          <li>The red Stop Miss Minutes button, her menu and the notification all stop everything she is doing.</li>
        </ul>
      </section>
    </div>
  );
}

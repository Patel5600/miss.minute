import { useState } from 'react';
import { LoaderCircle, Sparkles } from 'lucide-react';
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

export function Home({ onSetupComplete }: { onSetupComplete?: () => void } = {}) {
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
        throw new Error('Set up owner access with the Owner setup button above before changing companion settings.');
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
    <div className="mx-auto flex max-w-md flex-col gap-5">
      {native.phase === 'offline' && (
        <div role="status" className="rounded-xl border border-face/40 bg-face/10 px-4 py-3 text-sm">
          Open this in the Miss Minutes app.
        </div>
      )}

      {info?.killNotice && (
        <section role="status" aria-label="Stopped" className="rounded-2xl border border-face/50 bg-face/10 p-4 text-sm leading-relaxed">
          <p>{describeKillNotice(info.killNotice)}</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(ackKillNotice)}
            className="mt-3 h-12 rounded-xl bg-face px-6 font-semibold text-black disabled:opacity-50"
          >
            Got it
          </button>
        </section>
      )}

      <header className="relative overflow-hidden rounded-3xl border border-face/25 bg-[radial-gradient(ellipse_at_top_right,rgba(255,113,28,0.18),transparent_55%),linear-gradient(145deg,#21150c,#120d08_65%)] p-5 shadow-xl shadow-black/20">
        <div className="relative z-10 flex items-start justify-between gap-4">
          <div>
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-face"><Sparkles className="h-4 w-4" /> Miss Minutes</p>
            <h1 className="mt-2 text-2xl font-semibold leading-tight text-cream">Your companion, at a glance.</h1>
            <p className="mt-1 text-sm text-muted">{dateFormat.format(new Date())}</p>
          </div>
          <span className={`mt-1 h-3 w-3 shrink-0 rounded-full ring-4 ring-black/20 ${description ? TONE_DOT[description.tone] : 'bg-muted'}`} aria-label={description?.headline ?? 'Checking status'} />
        </div>
        <div className="relative z-10 mt-5 grid grid-cols-2 gap-2">
          <div className="rounded-2xl border border-white/5 bg-black/20 px-3 py-2.5">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted">Runtime</p>
            <p className="mt-1 truncate text-sm font-semibold text-cream">{description?.headline ?? 'Checking status'}</p>
          </div>
          <div className="rounded-2xl border border-white/5 bg-black/20 px-3 py-2.5">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted">Authority</p>
            {info?.ownerAuthenticated ? (
              <p className="mt-1 flex items-center gap-1.5 text-sm font-semibold text-emerald-400">
                <span className="inline-block h-2 w-2 rounded-full bg-emerald-400 ring-2 ring-emerald-400/25" />
                Boss · Authenticated
              </p>
            ) : info?.ownerCandidate ? (
              <p className="mt-1 flex items-center gap-1.5 text-sm font-semibold text-amber-400">
                <span className="inline-block h-2 w-2 rounded-full bg-amber-400 ring-2 ring-amber-400/25" />
                Boss Candidate
              </p>
            ) : info?.ownerEnrolled ? (
              <p className="mt-1 flex items-center gap-1.5 text-sm font-semibold text-muted">
                <span className="inline-block h-2 w-2 rounded-full bg-muted ring-2 ring-muted/25" />
                Guest Mode
              </p>
            ) : (
              <p className="mt-1 text-sm font-semibold text-muted">Not set up</p>
            )}
          </div>
        </div>
        <div className="relative z-10 mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
          <span>Mode: {info?.settings.roaming_level?.toLowerCase() ?? 'loading'}</span>
          <span>{info?.overlay.runtimeState === 'RUNNING' ? 'Runtime connected' : info?.overlay.runtimeState?.toLowerCase() ?? 'checking connection'}</span>
        </div>
      </header>

      {info && setupStep !== 'complete' && (
        <section aria-label="First-time owner setup" className="rounded-2xl border border-face/40 bg-face/10 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-face">First-time setup · {setupStep === 'consent' ? '1 of 5' : setupStep === 'face' ? '2 of 5' : setupStep === 'voice' ? '3 of 5' : setupStep === 'presence' ? '4 of 5' : '5 of 5'}</p>
          <h2 className="mt-1 text-lg font-semibold text-cream">
            {setupStep === 'consent' ? 'Choose local sensor setup' : setupStep === 'face' ? 'Enroll face presence' : setupStep === 'voice' ? 'Enroll your voice' : setupStep === 'presence' ? 'Calibrate attention' : 'Verify the owner claim'}
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-muted">
            {setupStep === 'consent'
              ? 'Review what camera and microphone use means. You can decline, skip either profile, or revoke Android permissions later.'
              : setupStep === 'face'
                ? info.faceProfilePending ? 'Face samples are staged locally. They stay inactive until Android verifies the owner claim.' : 'Capture several local samples. Face matching can suggest presence, but cannot unlock private data.'
                : setupStep === 'voice'
                  ? info.speakerProfilePending ? 'Voice samples are staged locally. They stay inactive until Android verifies the owner claim.' : 'Record short natural samples. Speaker matching can suggest who is speaking, but cannot grant authority.'
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
            className="mt-3 min-h-12 w-full rounded-xl bg-face px-4 font-semibold text-black disabled:opacity-55"
          >
            {setupStep === 'consent' ? 'Review sensor disclosure' : setupStep === 'device' ? 'Verify and activate owner' : setupStep === 'face' ? 'Set up face presence' : setupStep === 'voice' ? 'Set up speaker profile' : 'Open presence calibration'}
          </button>
          {setupStep === 'consent' && <p className="mt-2 text-xs text-muted">No background camera or microphone session is started by this step. Android asks separately when each enrollment opens.</p>}
          {setupStep === 'face' && <>
            <p className="mt-2 text-xs text-muted">Camera starts only after you open face setup. Face recognition is optional and cannot unlock owner access.</p>
            <button type="button" onClick={() => skipProfile('face')} className="mt-2 min-h-11 w-full rounded-xl border border-line text-sm text-muted">Skip face for now</button>
          </>}
          {setupStep === 'voice' && <>
            <p className="mt-2 text-xs text-muted">Microphone permission is requested only when you start voice enrollment. Samples are processed locally for the profile.</p>
            <button type="button" onClick={() => skipProfile('voice')} className="mt-2 min-h-11 w-full rounded-xl border border-line text-sm text-muted">Skip voice for now</button>
          </>}
          {setupStep === 'presence' && <button type="button" onClick={() => skipProfile('presence')} className="mt-2 min-h-11 w-full rounded-xl border border-line text-sm text-muted">Skip calibration</button>}
        </section>
      )}
      {info && setupStep === 'complete' && (
        <section aria-label="Owner setup complete" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-700/40 bg-emerald-950/20 p-4">
          <div><h2 className="font-semibold text-cream">Owner setup is ready</h2><p className="mt-1 text-sm text-muted">Device verification is the authority anchor. Skipped local profiles can be added later.</p></div>
          <button type="button" onClick={onSetupComplete} className="min-h-12 rounded-xl bg-face px-4 font-semibold text-black">Continue to settings</button>
        </section>
      )}

      {/* Miss Minutes Stage — full TVA presentation */}

      <section aria-label="Live status" className="rounded-2xl border border-line bg-raised px-4 py-3">
        <p className="text-sm font-semibold text-cream">{description?.detail ?? 'Reading the Android service state.'}</p>
      </section>

      {message && (
        <div role="alert" className="rounded-xl border border-red-500/50 bg-red-500/10 px-4 py-3 text-sm">
          {message}
        </div>
      )}

      <section aria-label="On my screen" className="rounded-2xl border border-line bg-raised px-4 pb-4 pt-2">
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
            className="mt-3 h-12 w-full rounded-xl bg-face font-semibold text-black disabled:opacity-50"
          >
            Allow Display over other apps
          </button>
        )}
        {description?.hiddenByTimer && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(async () => void (await setSetting('hidden_until_ms', 0)))}
            className="mt-3 h-12 w-full rounded-xl bg-line font-semibold text-cream disabled:opacity-50"
          >
            Show her now
          </button>
        )}
        {ready && description?.notificationsOff && (
          <p className="mt-3 text-xs leading-snug text-muted">
            Notifications are off, so the Stop button in the notification shade is not shown. You can still stop her from
            the red button above or from her menu.
          </p>
        )}
      </section>

      <section aria-label="Roaming" className="rounded-2xl border border-line bg-raised p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="font-semibold text-face">How much she roams</h2>
          {info?.ownerEnrolled && !info.ownerAuthenticated && <span className="rounded-full border border-amber-700/40 bg-amber-950/40 px-2.5 py-1 text-xs text-amber-200">Verify to change</span>}
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
                className={`min-h-12 rounded-xl border px-3 text-sm font-semibold transition active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-face focus-visible:ring-offset-2 focus-visible:ring-offset-base disabled:cursor-wait disabled:opacity-55 ${selected ? 'border-face bg-face text-black shadow-md shadow-face/15' : 'border-line bg-line/70 text-cream hover:border-face/50'}`}
              >
                {LEVEL_DETAILS[level].label}
              </button>
            );
          })}
        </div>
        {busy && <p role="status" className="mt-3 flex min-h-6 items-center gap-2 text-sm text-face"><LoaderCircle className="h-4 w-4 animate-spin" />{actionStatus}</p>}
        {!busy && actionStatus && <p role="status" className="mt-3 text-sm text-emerald-300">{actionStatus}</p>}
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
          Right now she can stand, walk, hop and do eight gestures. Running, hanging, climbing, sitting on edges, jumping
          and peeking switch on only when her body can draw them.
        </p>
      </section>

      <section aria-label="When I close the app" className="rounded-2xl border border-line bg-raised px-4 py-1">
        <Switch
          checked={info?.settings.keep_after_close ?? false}
          label="Keep her on screen after I close the app"
          description="Off: swiping the app away from Recents makes her leave. On: she stays until you stop her. Pressing Home never stops her."
          disabled={busy || !ready}
          onChange={(next) => void run(async () => void (await setSetting('keep_after_close', next)))}
        />
      </section>

      <section className="rounded-2xl border border-line bg-raised p-4 text-sm leading-relaxed">
        <h2 className="mb-2 font-semibold text-face">What she can and cannot do</h2>
        <ul className="list-disc space-y-1.5 pl-5 text-cream/90">
          <li>She cannot see other apps' windows, so she roams the edges of your screen instead.</li>
          <li>To appear above other apps she needs "Display over other apps". Without it she stays in this app.</li>
          <li>The red Stop Miss Minutes button, her menu and the notification all stop everything she is doing.</li>
        </ul>
      </section>
    </div>
  );
}

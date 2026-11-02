import { useState } from 'react';
import {
  describeError,
  formatMinutes,
  MODE_DETAILS,
  openMetadataWatcher,
  parseTimeInput,
  setMode,
  setSetting,
} from '../../shared/nativeApi.ts';
import { MODES } from '../../shared/vocabulary.ts';
import { Switch } from '../Switch.tsx';
import { useNativeState } from '../useNative.ts';

export function Settings() {
  const native = useNativeState();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const info = native.info;
  const ready = native.phase === 'ready' && info !== null;

  /** Runs one native action. Loosening something shows a native dialog first; Cancel there is not an error. */
  async function run(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (error) {
      setMessage(describeError(error));
    } finally {
      setBusy(false);
      await native.refresh();
    }
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-5">
      <header>
        <h1 className="text-3xl font-semibold leading-tight text-cream">Settings</h1>
      </header>

      {native.phase === 'offline' && (
        <div role="status" className="rounded-xl border border-face/40 bg-face/10 px-4 py-3 text-sm">
          Open this in the Miss Minutes app.
        </div>
      )}

      {message && (
        <div role="alert" className="rounded-xl border border-red-500/50 bg-red-500/10 px-4 py-3 text-sm">
          {message}
        </div>
      )}

      <section aria-label="How much she may do" className="rounded-2xl border border-line bg-raised p-4">
        <h2 className="mb-1 font-semibold text-face">How much she may do</h2>
        <p className="mb-3 text-sm leading-snug text-muted">
          Giving her more freedom asks you in a dialog drawn by the app. Going back to a stricter mode never asks.
        </p>
        <div role="radiogroup" aria-label="Mode" className="flex flex-col gap-2">
          {MODES.map((mode) => {
            const selected = info?.mode === mode;
            return (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={busy || !ready}
                onClick={() => void run(() => setMode(mode))}
                className={`rounded-xl border px-4 py-3 text-left disabled:opacity-50 ${selected ? 'border-face bg-face/10' : 'border-line bg-base/40'}`}
              >
                <span className={`block font-medium ${selected ? 'text-face' : 'text-cream'}`}>{MODE_DETAILS[mode].label}</span>
                <span className="mt-0.5 block text-sm leading-snug text-muted">{MODE_DETAILS[mode].text}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section aria-label="Her own reactions" className="rounded-2xl border border-line bg-raised px-4 py-1">
        <Switch
          checked={info?.settings.proactive ?? false}
          label="Let her react on her own"
          description="Small emotions and gestures when something happens, never text or speech. Off by default and after every stop."
          disabled={busy || !ready}
          onChange={(next) => void run(() => setSetting('proactive', next))}
        />
      </section>

      <section aria-label="Quiet hours" className="rounded-2xl border border-line bg-raised px-4 py-1">
        <Switch
          checked={info?.settings.quiet_hours_enabled ?? false}
          label="Quiet hours"
          description="She leaves the screen during these hours."
          disabled={busy || !ready}
          onChange={(next) => void run(() => setSetting('quiet_hours_enabled', next))}
        />
        <div className="flex gap-4 pb-3">
          <label className="flex flex-1 flex-col gap-1 text-sm text-muted">
            From
            <input
              type="time"
              value={formatMinutes(info?.settings.quiet_hours_start ?? 23 * 60)}
              disabled={busy || !ready}
              onChange={(event) => {
                const minutes = parseTimeInput(event.target.value);
                if (minutes !== null) void run(() => setSetting('quiet_hours_start', minutes));
              }}
              className="h-12 rounded-xl border border-line bg-base px-3 text-cream disabled:opacity-50"
            />
          </label>
          <label className="flex flex-1 flex-col gap-1 text-sm text-muted">
            Until
            <input
              type="time"
              value={formatMinutes(info?.settings.quiet_hours_end ?? 7 * 60)}
              disabled={busy || !ready}
              onChange={(event) => {
                const minutes = parseTimeInput(event.target.value);
                if (minutes !== null) void run(() => setSetting('quiet_hours_end', minutes));
              }}
              className="h-12 rounded-xl border border-line bg-base px-3 text-cream disabled:opacity-50"
            />
          </label>
        </div>
      </section>

      <section aria-label="Folder metadata watcher" className="rounded-2xl border border-line bg-raised p-4">
        <h2 className="mb-1 font-semibold text-face">Folder metadata watcher</h2>
        <p className="mb-3 text-sm leading-snug text-muted">
          A separate screen that records the names, sizes and dates of the files in one folder you choose. It never reads
          file contents.
        </p>
        <button
          type="button"
          disabled={busy || !ready}
          onClick={() => void run(openMetadataWatcher)}
          className="h-12 w-full rounded-xl bg-line font-semibold text-cream disabled:opacity-50"
        >
          Open the folder watcher
        </button>
      </section>

      {info && (
        <p className="pb-2 text-center text-xs text-muted">
          Miss Minutes {info.version} on Android {info.sdk}
        </p>
      )}
    </div>
  );
}

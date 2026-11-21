/**
 * Ethical AI-Disclosed Outbound Calling panel.
 * Enforces E.164 format, DNC registry, quiet hours, 5/day cap, typed fact hygiene (1..=8),
 * Miss Minutes brand voice ONLY, and mandatory upfront AI disclosure.
 */
import { useEffect, useMemo, useState } from 'react';
import { Clock, Mic, PhoneCall, PhoneOff, Plus, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react';
import type { AISettings } from '../types';
import { useDbList, useNow } from '../store/useDb';
import {
  androidCallsHangup,
  isAndroidApp,
  onAndroidEvent,
  type PlatformCallFact,
  type PlatformCallFactKind,
} from '../agent/platform';
import {
  DEFAULT_MAX_CALLS_PER_DAY,
  DEFAULT_QUIET_END_MIN,
  DEFAULT_QUIET_START_MIN,
  MAX_CALL_FACTS,
  MAX_FACT_LENGTH,
  buildDisclosureOpening,
  isQuietHour,
  isValidE164,
  prepareAndOptionallyStartCall,
  validateCallFact,
} from '../agent/tools/calling';
import { formatWhen } from '../agent/tools/time';
import { Button, ConfirmButton, Empty, ErrorLine, MicroLabel, PanelShell, inputClass } from './ui';
import { useAction } from './useAction';

export interface CallingPanelProps {
  className?: string;
  settings?: Pick<AISettings, 'dncNumbers' | 'callQuietHoursEnabled' | 'callQuietStartMin' | 'callQuietEndMin'>;
  onUpdateCallingSettings?: (
    patch: Partial<Pick<AISettings, 'dncNumbers' | 'callQuietHoursEnabled' | 'callQuietStartMin' | 'callQuietEndMin'>>,
  ) => void;
}

const FACT_KIND_OPTIONS: Array<{ kind: PlatformCallFactKind; label: string; placeholder: string }> = [
  { kind: 'scheduled_window', label: 'Scheduled window', placeholder: 'Tomorrow 2:00 PM - 4:00 PM' },
  { kind: 'booking_name', label: 'Booking name', placeholder: 'Alex' },
  { kind: 'callback_number', label: 'Callback E.164', placeholder: '+12025550199' },
  { kind: 'reference_code', label: 'Reference code', placeholder: 'TVA-4821' },
  { kind: 'brief_topic', label: 'Brief topic', placeholder: 'Confirming appointment slot' },
];

export function CallingPanel({ className, settings, onUpdateCallingSettings }: CallingPanelProps) {
  const android = isAndroidApp();
  const now = useNow(30_000);
  const { data: history = [], loading, error: loadError } = useDbList(
    'calls',
    rows => [...rows].sort((a, b) => b.createdAt - a.createdAt),
  );
  const action = useAction();

  const [destination, setDestination] = useState('+12025550111');
  const [ownerName, setOwnerName] = useState('');
  const [facts, setFacts] = useState<PlatformCallFact[]>([
    { kind: 'brief_topic', value: 'Confirming tomorrow afternoon appointment' },
  ]);
  const [factKind, setFactKind] = useState<PlatformCallFactKind>('scheduled_window');
  const [factValue, setFactValue] = useState('');
  const [factError, setFactError] = useState<string | null>(null);
  const [placeCallOnAndroid, setPlaceCallOnAndroid] = useState(false);
  const [liveCallStatus, setLiveCallStatus] = useState<string | null>(null);
  const [newDnc, setNewDnc] = useState('');

  useEffect(() => {
    if (!android) return;
    return onAndroidEvent('calls.state', payload => {
      const state = typeof payload.state === 'string' ? payload.state : 'updated';
      const dest = typeof payload.destinationE164 === 'string' ? payload.destinationE164 : '';
      setLiveCallStatus(dest ? `Active call state: ${state} (${dest})` : `Active call state: ${state}`);
    });
  }, [android]);

  const quietEnabled = settings?.callQuietHoursEnabled !== false;
  const quietStart = settings?.callQuietStartMin ?? DEFAULT_QUIET_START_MIN;
  const quietEnd = settings?.callQuietEndMin ?? DEFAULT_QUIET_END_MIN;
  const dncNumbers = useMemo(() => settings?.dncNumbers ?? [], [settings?.dncNumbers]);

  const currentDate = new Date(now);
  const minuteOfDay = currentDate.getHours() * 60 + currentDate.getMinutes();
  const quietActive = isQuietHour(minuteOfDay, {
    quietStartMin: quietStart,
    quietEndMin: quietEnd,
    enabled: quietEnabled,
  });

  const placedToday = useMemo(() => {
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const startMs = dayStart.getTime();
    return history.filter(
      row => row.createdAt >= startMs && !row.dryRun && row.state !== 'draft' && row.state !== 'aborted',
    ).length;
  }, [history, now]);

  const destClean = destination.trim();
  const e164Ok = isValidE164(destClean);
  const dncBlocked = dncNumbers.includes(destClean);
  const disclosurePreview = buildDisclosureOpening(ownerName);

  const addFact = () => {
    if (facts.length >= MAX_CALL_FACTS) {
      setFactError(`Maximum ${MAX_CALL_FACTS} facts allowed per call.`);
      return;
    }
    try {
      const checked = validateCallFact({ kind: factKind, value: factValue });
      setFacts(prev => [...prev, checked]);
      setFactValue('');
      setFactError(null);
    } catch (err) {
      setFactError(err instanceof Error ? err.message : String(err));
    }
  };

  const handlePrepare = () => {
    action.run(() =>
      prepareAndOptionallyStartCall(
        {
          destinationE164: destClean,
          ownerFirstName: ownerName,
          facts,
          dncNumbers,
          placeCall: android && placeCallOnAndroid,
        },
        {
          settings,
          ownerConfirmed: true,
        },
      ),
    );
  };

  const addDncNumber = () => {
    const clean = newDnc.trim();
    if (!isValidE164(clean) || !onUpdateCallingSettings) return;
    if (dncNumbers.includes(clean)) {
      setNewDnc('');
      return;
    }
    onUpdateCallingSettings({ dncNumbers: [...dncNumbers, clean] });
    setNewDnc('');
  };

  return (
    <PanelShell
      title="Ethical Calling Guard"
      icon={<PhoneCall className="h-4 w-4" />}
      className={className}
      subtitle={`${placedToday}/${DEFAULT_MAX_CALLS_PER_DAY} placed today`}
      actions={
        android ? (
          <Button
            tone="danger"
            onClick={() => action.run(() => androidCallsHangup())}
            className="min-h-11"
          >
            <PhoneOff className="h-3.5 w-3.5" /> Hang Up Active
          </Button>
        ) : undefined
      }
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div className="flex items-center gap-2 rounded-2xl border border-white/[0.08] bg-[#16120E] px-3 py-2.5 text-xs">
          <Mic className="h-4 w-4 shrink-0 text-[#FF9240]" />
          <div className="min-w-0">
            <span className="block text-[10px] uppercase tracking-wider text-[#9D9082]">Brand Voice</span>
            <span className="truncate font-semibold text-[#FFF8EE]">Miss Minutes (TVA)</span>
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-2xl border border-white/[0.08] bg-[#16120E] px-3 py-2.5 text-xs">
          <Clock className={`h-4 w-4 shrink-0 ${quietActive ? 'text-red-300' : 'text-emerald-400'}`} />
          <div className="min-w-0">
            <span className="block text-[10px] uppercase tracking-wider text-[#9D9082]">Quiet Hours</span>
            <span className={`truncate font-semibold ${quietActive ? 'text-red-200' : 'text-emerald-300'}`}>
              {quietActive ? 'Active (Blocked)' : quietEnabled ? 'Open Window' : 'Disabled'}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-2xl border border-white/[0.08] bg-[#16120E] px-3 py-2.5 text-xs">
          <ShieldCheck className="h-4 w-4 shrink-0 text-[#FF9240]" />
          <div className="min-w-0">
            <span className="block text-[10px] uppercase tracking-wider text-[#9D9082]">Daily Cap</span>
            <span className="truncate font-mono font-semibold text-[#FFF8EE]">
              {placedToday} / {DEFAULT_MAX_CALLS_PER_DAY} calls
            </span>
          </div>
        </div>
      </div>

      {liveCallStatus && (
        <div role="status" className="rounded-xl border border-[#FF7A1A]/40 bg-[#FF7A1A]/10 px-3 py-2 text-xs text-[#FFD9B3]">
          {liveCallStatus}
        </div>
      )}

      <div className="space-y-3 rounded-2xl border border-white/[0.08] bg-[#16120E] p-3.5">
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <label className="space-y-1 text-xs">
            <MicroLabel htmlFor="call-dest-e164">Destination (Strict E.164)</MicroLabel>
            <input
              id="call-dest-e164"
              value={destination}
              onChange={e => setDestination(e.target.value)}
              placeholder="+12025550111"
              className={`${inputClass} min-h-11 w-full font-mono`}
            />
            {!e164Ok && (
              <span className="block text-[11px] text-red-300">Must match +[country][number] (7–15 digits).</span>
            )}
            {dncBlocked && (
              <span className="block text-[11px] text-red-300">Number is on your Do-Not-Call list.</span>
            )}
          </label>
          <label className="space-y-1 text-xs">
            <MicroLabel htmlFor="call-owner-name">Owner First Name (Disclosure)</MicroLabel>
            <input
              id="call-owner-name"
              value={ownerName}
              onChange={e => setOwnerName(e.target.value)}
              placeholder="e.g. Alex"
              className={`${inputClass} min-h-11 w-full`}
            />
          </label>
        </div>

        <div className="space-y-1 rounded-2xl border border-[#FF7A1A]/30 bg-black/35 p-3">
          <span className="block text-[10px] font-semibold uppercase tracking-wider text-[#FF9240]">
            Mandatory Upfront AI Identity Disclosure
          </span>
          <p className="text-xs leading-relaxed text-[#FFF8EE]">“{disclosurePreview}”</p>
        </div>

        <div className="space-y-2">
          <MicroLabel>Authorized Facts ({facts.length}/{MAX_CALL_FACTS})</MicroLabel>
          {facts.length > 0 && (
            <ul className="space-y-1.5">
              {facts.map((fact, idx) => (
                <li
                  key={`${fact.kind}-${idx}`}
                  className="flex items-center justify-between gap-2 rounded-xl border border-white/[0.08] bg-[#0E0B08] px-3 py-2 text-xs"
                >
                  <div className="min-w-0 flex-1">
                    <span className="mr-2 font-mono text-[10px] text-[#FF9240]">{fact.kind}</span>
                    <span className="break-words text-[#FFF8EE]">{fact.value}</span>
                  </div>
                  <button
                    type="button"
                    aria-label={`Remove fact ${fact.kind}`}
                    onClick={() => setFacts(prev => prev.filter((_, i) => i !== idx))}
                    className="min-h-9 min-w-9 cursor-pointer rounded-lg text-[#9D9082] hover:bg-white/[0.06] hover:text-red-300"
                  >
                    <Trash2 className="mx-auto h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[11rem_1fr_auto]">
            <select
              aria-label="New call fact kind"
              value={factKind}
              onChange={e => setFactKind(e.target.value as PlatformCallFactKind)}
              className={`${inputClass} min-h-11`}
            >
              {FACT_KIND_OPTIONS.map(o => (
                <option key={o.kind} value={o.kind}>{o.label}</option>
              ))}
            </select>
            <input
              value={factValue}
              onChange={e => setFactValue(e.target.value)}
              maxLength={MAX_FACT_LENGTH}
              placeholder={FACT_KIND_OPTIONS.find(o => o.kind === factKind)?.placeholder ?? 'Fact value'}
              aria-label="New call fact value"
              className={`${inputClass} min-h-11`}
            />
            <Button tone="ghost" onClick={addFact} disabled={facts.length >= MAX_CALL_FACTS} className="min-h-11 justify-center">
              <Plus className="h-3.5 w-3.5" /> Add
            </Button>
          </div>
          <ErrorLine message={factError} />
        </div>

        {android && (
          <label className="flex min-h-11 cursor-pointer items-start gap-2.5 rounded-xl border border-white/[0.08] bg-[#0E0B08] px-3 py-2 text-xs text-[#CBBEB0]">
            <input
              type="checkbox"
              checked={placeCallOnAndroid}
              onChange={e => setPlaceCallOnAndroid(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[#FF7A1A]"
            />
            <span>
              Place live Android Telecom call after confirming native disclosure dialog (unchecked = dry-run validation).
            </span>
          </label>
        )}

        <ConfirmButton
          question={android && placeCallOnAndroid ? 'Confirm upfront disclosure & open native dialer?' : 'Confirm disclosure & validate call?'}
          confirmLabel={android && placeCallOnAndroid ? 'Prepare & Dial' : 'Prepare Dry-Run'}
          tone="solid"
          onConfirm={handlePrepare}
        >
          <PhoneCall className="h-4 w-4" />
          {android && placeCallOnAndroid ? 'Prepare & Dial (Owner Confirm)' : 'Prepare AI-Disclosed Call'}
        </ConfirmButton>
        <ErrorLine message={action.error} />
      </div>

      {onUpdateCallingSettings && (
        <div className="space-y-2.5 rounded-2xl border border-white/[0.08] bg-[#16120E] p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <MicroLabel>Do-Not-Call (DNC) & Quiet Hours</MicroLabel>
            <label className="flex cursor-pointer items-center gap-2 text-xs text-[#CBBEB0]">
              <input
                type="checkbox"
                checked={quietEnabled}
                onChange={e => onUpdateCallingSettings({ callQuietHoursEnabled: e.target.checked })}
                className="h-4 w-4 accent-[#FF7A1A]"
              />
              Enforce quiet hours
            </label>
          </div>
          <div className="flex gap-2">
            <input
              value={newDnc}
              onChange={e => setNewDnc(e.target.value)}
              placeholder="+12025550199"
              aria-label="Add DNC E.164 number"
              className={`${inputClass} min-h-11 flex-1 font-mono`}
            />
            <Button tone="ghost" onClick={addDncNumber} disabled={!isValidE164(newDnc.trim())} className="min-h-11">
              <Plus className="h-3.5 w-3.5" /> Add DNC
            </Button>
          </div>
          {dncNumbers.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {dncNumbers.map(num => (
                <span key={num} className="inline-flex items-center gap-1.5 rounded-xl border border-red-500/35 bg-red-950/25 px-2.5 py-1 font-mono text-xs text-red-200">
                  {num}
                  <button
                    type="button"
                    aria-label={`Remove ${num} from DNC`}
                    onClick={() => onUpdateCallingSettings({ dncNumbers: dncNumbers.filter(x => x !== num) })}
                    className="cursor-pointer text-red-300 hover:text-white"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <ErrorLine message={loadError} />

      <div className="space-y-2">
        <MicroLabel>Call Log ({history.length})</MicroLabel>
        {loading ? (
          <Empty>Loading outbound call log…</Empty>
        ) : history.length === 0 ? (
          <Empty>No outbound calls prepared yet.</Empty>
        ) : (
          <ul className="space-y-2.5">
            {history.map(call => (
              <li key={call.id} className="space-y-1.5 rounded-2xl border border-white/[0.08] bg-[#16120E] p-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono font-semibold text-[#FFF8EE]">{call.destinationE164}</span>
                    <span className="rounded-full border border-[#FF7A1A]/35 bg-[#FF7A1A]/15 px-2 py-0.5 text-[10px] font-semibold uppercase text-[#FFD9B3]">
                      {call.state}
                    </span>
                    <span className="rounded-full border border-white/[0.1] bg-white/[0.04] px-2 py-0.5 text-[10px] text-[#CBBEB0]">
                      {call.dryRun !== false ? 'Dry Run' : 'Telecom'}
                    </span>
                  </div>
                  <span className="text-[11px] text-[#9D9082]">{formatWhen(call.createdAt)}</span>
                </div>
                <p className="text-[#CBBEB0]">“{call.disclosureOpening}”</p>
                <div className="flex flex-wrap gap-1.5 text-[11px] text-[#9D9082]">
                  <span className="inline-flex items-center gap-1 font-mono text-[#FF9240]">
                    <ShieldAlert className="h-3 w-3" /> {call.voice}
                  </span>
                  <span>· {call.allowedFacts.length} fact(s)</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </PanelShell>
  );
}

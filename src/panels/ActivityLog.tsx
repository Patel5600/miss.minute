/**
 * Activity log: what Miss Minutes did on her own (tool runs), what the owner approved or
 * denied, alarms that rang or were missed, and errors. Newest first, live.
 */
import { useState } from 'react';
import { Activity, AlarmClock, Check, ShieldCheck, Trash, TriangleAlert, Wrench } from 'lucide-react';
import { useDbList, useNow } from '../store/useDb';
import { clearStore, type ActivityRecord } from '../store/db';
import { clip } from '../agent/tools/args';
import { formatDayRelative, formatTime, isSameDay } from '../agent/tools/time';
import { ConfirmButton, Empty, ErrorLine, PanelShell, focusRing } from './ui';
import { useAction } from './useAction';

export interface ActivityLogProps {
  className?: string;
  /** How many entries to show. Default 100. */
  limit?: number;
}

type Filter = 'all' | ActivityRecord['kind'];

const KIND_STYLE: Record<ActivityRecord['kind'], { label: string; tone: string; icon: typeof Activity }> = {
  tool: { label: 'Tool', tone: 'text-amber-200 border-amber-600/50 bg-amber-900/30', icon: Wrench },
  approval: { label: 'Approval', tone: 'text-emerald-200 border-emerald-600/50 bg-emerald-950/40', icon: ShieldCheck },
  alarm: { label: 'Alarm', tone: 'text-sky-200 border-sky-600/50 bg-sky-950/40', icon: AlarmClock },
  error: { label: 'Error', tone: 'text-red-200 border-red-600/50 bg-red-950/40', icon: TriangleAlert },
};

function detailText(detail: unknown): string | null {
  if (detail === undefined || detail === null) return null;
  try {
    return clip(JSON.stringify(detail, null, 2), 1500);
  } catch {
    return null;
  }
}

function Row({ entry, now }: { entry: ActivityRecord; now: number }) {
  const style = KIND_STYLE[entry.kind];
  const Icon = style.icon;
  const detail = detailText(entry.detail);
  const denied = entry.kind === 'approval' && entry.summary.startsWith('Denied');
  const when = isSameDay(entry.at, now) ? formatTime(entry.at, true) : `${formatDayRelative(entry.at, now)} ${formatTime(entry.at)}`;
  const body = (
    <span className="flex items-start gap-2 min-w-0">
      <span className="text-[10px] text-amber-400/60 tabular-nums w-[5.5rem] flex-shrink-0 pt-px">{when}</span>
      <span className={`inline-flex items-center gap-1 px-1.5 rounded border text-[9px] uppercase tracking-widest flex-shrink-0 ${denied ? KIND_STYLE.error.tone : style.tone}`}>
        <Icon className="w-2.5 h-2.5" aria-hidden="true" />{denied ? 'Denied' : style.label}
      </span>
      <span className={`text-[11px] break-words min-w-0 ${entry.kind === 'error' ? 'text-red-200' : 'text-amber-100'}`}>{entry.summary}</span>
    </span>
  );
  if (!detail) return <li className="px-2 py-1 rounded hover:bg-amber-900/20">{body}</li>;
  return (
    <li className="rounded hover:bg-amber-900/20">
      <details>
        <summary className={`list-none cursor-pointer px-2 py-1 rounded ${focusRing}`}>{body}</summary>
        <pre className="mx-2 mb-1.5 p-2 text-[10px] leading-snug text-amber-300/80 bg-black/50 border border-amber-900/50 rounded overflow-x-auto whitespace-pre-wrap break-words">{detail}</pre>
      </details>
    </li>
  );
}

export function ActivityLog({ className, limit = 100 }: ActivityLogProps) {
  const now = useNow(30_000);
  const action = useAction();
  const [filter, setFilter] = useState<Filter>('all');
  const { data: entries = [], loading, error } = useDbList('activity', rows => [...rows].sort((a, b) => b.at - a.at));
  const counts: Record<Filter, number> = { all: entries.length, tool: 0, approval: 0, alarm: 0, error: 0 };
  for (const entry of entries) counts[entry.kind] += 1;
  const shown = (filter === 'all' ? entries : entries.filter(entry => entry.kind === filter)).slice(0, limit);
  const filters: Array<{ id: Filter; label: string }> = [
    { id: 'all', label: 'All' }, { id: 'tool', label: 'Tools' }, { id: 'approval', label: 'Approvals' },
    { id: 'alarm', label: 'Alarms' }, { id: 'error', label: 'Errors' },
  ];

  return (
    <PanelShell
      title="Activity Log"
      icon={<Activity className="w-4 h-4" />}
      className={className}
      subtitle={entries.length > 0 ? `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}` : undefined}
      actions={entries.length > 0 ? (
        <ConfirmButton question="Clear the whole log?" confirmLabel="Clear" tone="ghost" onConfirm={() => action.run(() => clearStore('activity'))}>
          <Trash className="w-3 h-3" /> Clear
        </ConfirmButton>
      ) : null}
    >
      <div role="group" aria-label="Filter the log" className="flex flex-wrap gap-1">
        {filters.map(option => (
          <button
            key={option.id}
            type="button"
            aria-pressed={filter === option.id}
            onClick={() => setFilter(option.id)}
            className={`px-2 py-0.5 text-[11px] rounded border transition-colors ${focusRing} ${filter === option.id ? 'bg-amber-600/40 border-amber-400/50 text-amber-100' : 'border-amber-800/40 text-amber-400/70 hover:text-amber-200'}`}
          >
            {option.label} ({counts[option.id]})
          </button>
        ))}
      </div>
      <ErrorLine message={action.error ?? (error ? `Could not read the log: ${error}` : null)} />
      {loading ? <Empty>Reading the log...</Empty> : null}
      {!loading && shown.length === 0 ? (
        <Empty>{filter === 'all' ? 'Nothing yet. Tool runs, approvals and alarms will show up here.' : `No ${filters.find(f => f.id === filter)?.label.toLowerCase()} yet.`}</Empty>
      ) : null}
      <ol className="flex flex-col max-h-80 overflow-y-auto pr-1" aria-label="Activity entries, newest first">
        {shown.map(entry => <Row key={entry.id} entry={entry} now={now} />)}
      </ol>
      {entries.length > 0 && shown.length === limit ? (
        <p className="text-[10px] text-amber-400/60 flex items-center gap-1"><Check className="w-3 h-3" aria-hidden="true" />Showing the newest {limit}. The log keeps the last 500.</p>
      ) : null}
    </PanelShell>
  );
}

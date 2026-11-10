/**
 * The owner's real day drawn as the Sacred Timeline: events are glowing segments on the beam,
 * reminders and alarms are nodes, a NOW marker moves across it, and nexus events (conflicts,
 * overdue reminders, finished timers) branch off in red toward the red line. The deviation
 * gauge is computed from real load only.
 */
import { useId, useMemo, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import {
  AlarmClock, Bell, CalendarDays, Check, Clock, MapPin, Plus, Repeat, RotateCcw, ShieldCheck, Timer, Trash, TriangleAlert, X,
} from 'lucide-react';
import { useDbList, useNow } from '../store/useDb';
import { RED_LINE, type AgendaEntry, type DeviationReport } from '../agent/tools/agenda';
import { ToolInputError } from '../agent/tools/args';
import {
  EVENT_DEFAULT_MS, createEvent, createReminder, deleteScheduleItem, recurrenceText, setAlarmEnabled, setScheduleDone,
  skipNextOccurrence, snoozeScheduleItem,
} from '../agent/tools/schedule';
import {
  HOUR, MINUTE, clock24, formatDay, formatDayRelative, formatDuration, formatTime, formatWhen, localDate, parseDateTime,
} from '../agent/tools/time';
import { addTimerTime, clearTimer } from '../agent/tools/timers';
import type { Recurrence } from '../store/db';
import { useReducedMotion } from './motion';
import { buildView, type DayModel, type NexusEvent, type TimelineView } from './timelineModel';
import { Button, ConfirmButton, Empty, ErrorLine, MicroLabel, PanelShell, focusRing, inputClass } from './ui';
import { useAction } from './useAction';

export interface SacredTimelineProps {
  className?: string;
  /** Initial view. Default 'today'. */
  defaultView?: TimelineView;
}

type Selection = { type: 'entry' | 'nexus'; key: string } | null;

const W = 1000;
const PAD_L = 26;
const PAD_R = 26;
const BEAM_Y = 150;
const RED_TOP = 40;
const RED_BOTTOM = 238;
const AXIS_Y = 262;
const H = 272;

const COLORS = {
  beam: '#FBBF24',
  glow: '#F59E0B',
  past: '#92400E',
  event: '#F59E0B',
  eventPast: '#78350F',
  done: '#57534E',
  reminder: '#FB923C',
  alarm: '#FDE68A',
  red: '#EF4444',
  timer: '#38BDF8',
  now: '#FEF3C7',
};

function svgId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '');
}

function activate(event: KeyboardEvent, action: () => void): void {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    action();
  }
}

function laneOffset(lane: number): number {
  return -lane * 24;
}

function entryAria(entry: AgendaEntry, now: number): string {
  const time = entry.kind === 'event'
    ? entry.allDay ? `${formatDay(entry.start, now)}, all day` : `${formatWhen(entry.start, now)} to ${formatTime(entry.end)}`
    : formatWhen(entry.start, now);
  const status = entry.status === 'upcoming' ? '' : `, ${entry.status}`;
  return `${entry.kind} ${entry.title}, ${time}${status}`;
}

function clipText(text: string, chars: number): string {
  if (chars <= 1) return '';
  return text.length <= chars ? text : `${text.slice(0, Math.max(1, chars - 1))}…`;
}

// ── Deviation gauge ─────────────────────────────────────────────────────────────────────

function DeviationGauge({ report, peakLabel }: { report: DeviationReport; peakLabel?: string }) {
  const color = report.level === 'critical' ? 'bg-red-500' : report.level === 'elevated' ? 'bg-amber-400' : 'bg-emerald-400';
  const text = report.level === 'critical' ? 'text-red-300' : report.level === 'elevated' ? 'text-amber-300' : 'text-emerald-300';
  const label = report.level === 'critical' ? 'Nexus event imminent' : report.level === 'elevated' ? 'Elevated deviation' : 'Timeline stable';
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-widest">
        <span className={`font-bold ${text}`}>{label}{peakLabel ? ` · peak ${peakLabel}` : ''}</span>
        <span className={text}>Deviation {report.score}%</span>
      </div>
      <div
        role="meter"
        aria-label="Timeline deviation"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={report.score}
        aria-valuetext={`${report.score}%, ${label}${report.parts.length ? `: ${report.parts.map(part => part.label).join(', ')}` : ''}`}
        className="relative h-2.5 rounded-full bg-black/60 border border-amber-800/40 overflow-hidden"
      >
        <div className={`h-full ${color} transition-[width] duration-500`} style={{ width: `${report.score}%` }} />
        <div className="absolute top-0 bottom-0 w-0.5 bg-red-500" style={{ left: `${RED_LINE}%` }} aria-hidden="true" />
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-amber-400/70">
        {report.parts.length === 0
          ? <span>No conflicts, nothing overdue, plenty of room.</span>
          : report.parts.map(part => <span key={part.label}>{part.label} <span className="text-amber-300">+{part.points}</span></span>)}
        <span className="text-red-400/80">Red line {RED_LINE}%</span>
      </div>
    </div>
  );
}

// ── Beam (single day) ───────────────────────────────────────────────────────────────────

interface BeamProps {
  model: DayModel;
  now: number;
  selected: Selection;
  onSelect: (selection: Selection) => void;
}

function DayBeam({ model, now, selected, onSelect }: BeamProps) {
  const rawId = useId();
  const glowId = `glow-${svgId(rawId)}`;
  const redGlowId = `red-${svgId(rawId)}`;
  const scanId = `scan-${svgId(rawId)}`;
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const still = useReducedMotion();
  const span = model.to - model.from;
  const x = (t: number) => PAD_L + ((Math.min(model.to, Math.max(model.from, t)) - model.from) / span) * (W - PAD_L - PAD_R);
  const hours = Math.round(span / HOUR);
  const labelEvery = hours > 16 ? 3 : 2;
  const nowX = model.isToday ? x(now) : null;
  const conflictKeys = new Set(model.nexus.filter(n => n.type === 'conflict' && !n.resolved).flatMap(n => n.entries?.map(e => e.key) ?? []));
  const isSelected = (type: 'entry' | 'nexus', key: string) => selected?.type === type && selected.key === key;

  // Node labels below the beam, placed in the first row where they do not collide.
  const rowEnds: number[] = [];
  const nodeLabels = new Map<string, { x: number; row: number; text: string }>();
  for (const entry of model.entries.filter(e => e.kind !== 'event')) {
    const nx = x(entry.start);
    const text = clipText(`${clock24(entry.start)} ${entry.title}`, 26);
    const width = text.length * 6.1 + 8;
    let row = rowEnds.findIndex(end => end < nx - 4);
    if (row === -1 && rowEnds.length < 3) row = rowEnds.length;
    if (row === -1) continue;
    rowEnds[row] = nx + width;
    nodeLabels.set(entry.key, { x: nx, row, text });
  }

  const focusProps = (key: string) => ({
    onFocus: () => setFocusKey(key),
    onBlur: () => setFocusKey(current => (current === key ? null : current)),
  });

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block select-none" role="group" aria-label={`Sacred Timeline for ${formatDayRelative(model.dayStart, now)}`}>
      <defs>
        <filter id={glowId} x="-20%" y="-200%" width="140%" height="500%">
          <feGaussianBlur stdDeviation="3.5" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <filter id={redGlowId} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2.5" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <pattern id={scanId} width="4" height="4" patternUnits="userSpaceOnUse">
          <rect width="4" height="1.5" fill="rgba(0,0,0,0.18)" />
        </pattern>
      </defs>

      <rect x="0" y="0" width={W} height={H} fill="rgba(0,0,0,0.55)" />
      {/* CRT grid: hour lines and faint horizontals */}
      {Array.from({ length: hours + 1 }, (_, index) => {
        const t = model.from + index * HOUR;
        const gx = x(t);
        const hour = new Date(t).getHours();
        return (
          <g key={`h${index}`}>
            <line x1={gx} x2={gx} y1={RED_TOP - 8} y2={RED_BOTTOM + 6} stroke="rgba(217,119,6,0.12)" strokeWidth="1" />
            {hour % labelEvery === 0 && index < hours ? (
              <text x={gx} y={AXIS_Y} fill="rgba(251,191,36,0.6)" fontSize="11" textAnchor="middle">{String(hour).padStart(2, '0')}</text>
            ) : null}
          </g>
        );
      })}
      {[70, 100, 200, 220].map(gy => <line key={gy} x1={PAD_L} x2={W - PAD_R} y1={gy} y2={gy} stroke="rgba(217,119,6,0.07)" />)}

      {/* Red lines */}
      <line x1={0} x2={W} y1={RED_TOP} y2={RED_TOP} stroke={COLORS.red} strokeOpacity={model.deviation.level === 'critical' ? 0.9 : 0.45} strokeWidth="2" strokeDasharray="6 6" />
      <line x1={0} x2={W} y1={RED_BOTTOM} y2={RED_BOTTOM} stroke={COLORS.red} strokeOpacity="0.35" strokeWidth="2" strokeDasharray="6 6" />
      <text x={PAD_L} y={RED_TOP - 8} fill="rgba(248,113,113,0.85)" fontSize="10" letterSpacing="2">RED LINE</text>

      {/* The beam: past dim, future glowing */}
      {nowX !== null && nowX > PAD_L ? (
        <line x1={PAD_L} x2={nowX} y1={BEAM_Y} y2={BEAM_Y} stroke={COLORS.past} strokeWidth="3" strokeLinecap="round" />
      ) : null}
      <line
        x1={nowX !== null ? Math.max(PAD_L, nowX) : PAD_L}
        x2={W - PAD_R}
        y1={BEAM_Y}
        y2={BEAM_Y}
        stroke={COLORS.beam}
        strokeWidth="3.5"
        strokeLinecap="round"
        filter={`url(#${glowId})`}
      />

      {/* Running timers: a countdown bracket just above the beam */}
      {model.runningTimers.map(timer => {
        const x1 = x(now);
        const x2 = x(timer.endsAt);
        return (
          <g key={timer.id} aria-hidden="true">
            <line x1={x1} x2={Math.max(x1 + 2, x2)} y1={BEAM_Y - 12} y2={BEAM_Y - 12} stroke={COLORS.timer} strokeWidth="2" strokeDasharray="3 3" />
            <circle cx={x2} cy={BEAM_Y - 12} r="3.5" fill={COLORS.timer} />
          </g>
        );
      })}

      {/* Events: segments on the beam; overlapping ones stack upward in lanes */}
      {model.entries.filter(entry => entry.kind === 'event').map(entry => {
        const lane = model.lanes.get(entry.key) ?? 0;
        const y = BEAM_Y + laneOffset(lane);
        const x1 = x(entry.start);
        const width = Math.max(5, x(entry.end) - x1);
        const fill = entry.status === 'done' ? COLORS.done : entry.status === 'past' ? COLORS.eventPast : COLORS.event;
        const clash = conflictKeys.has(entry.key);
        const chosen = isSelected('entry', entry.key);
        const chars = Math.floor((width - 8) / 6.2);
        const select = () => onSelect({ type: 'entry', key: entry.key });
        return (
          <g
            key={entry.key}
            role="button"
            tabIndex={0}
            aria-label={entryAria(entry, now)}
            aria-pressed={chosen}
            className="cursor-pointer outline-none"
            onClick={select}
            onKeyDown={event => activate(event, select)}
            {...focusProps(entry.key)}
          >
            {lane > 0 ? (
              <path d={`M ${x1} ${BEAM_Y} C ${x1} ${BEAM_Y - 8}, ${x1} ${y + 10}, ${x1 + 2} ${y + 7}`} stroke={clash ? COLORS.red : COLORS.glow} strokeOpacity="0.7" strokeWidth="1.5" fill="none" />
            ) : null}
            <rect
              x={x1}
              y={y - 7}
              width={width}
              height={14}
              rx={3}
              fill={fill}
              fillOpacity={entry.status === 'upcoming' ? 0.92 : 0.75}
              stroke={chosen || focusKey === entry.key ? COLORS.now : clash ? COLORS.red : 'none'}
              strokeWidth={chosen || focusKey === entry.key ? 2 : 1.5}
              filter={entry.status === 'upcoming' ? `url(#${glowId})` : undefined}
            />
            {chars >= 3 ? (
              <text x={x1 + 4} y={y + 3.6} fontSize="10" fill={entry.status === 'upcoming' ? '#1C1917' : '#FDE68A'} fontWeight="bold" pointerEvents="none">
                {clipText(entry.title, chars)}
              </text>
            ) : null}
          </g>
        );
      })}

      {/* Reminders (diamonds) and alarms (rings) as nodes on the beam */}
      {model.entries.filter(entry => entry.kind !== 'event').map(entry => {
        const nx = x(entry.start);
        const chosen = isSelected('entry', entry.key) || focusKey === entry.key;
        const faded = entry.status === 'past' || entry.status === 'done' || entry.status === 'off';
        const color = entry.status === 'overdue' ? COLORS.red : entry.kind === 'alarm' ? COLORS.alarm : COLORS.reminder;
        const label = nodeLabels.get(entry.key);
        const select = () => onSelect({ type: 'entry', key: entry.key });
        return (
          <g
            key={entry.key}
            role="button"
            tabIndex={0}
            aria-label={entryAria(entry, now)}
            aria-pressed={isSelected('entry', entry.key)}
            className="cursor-pointer outline-none"
            onClick={select}
            onKeyDown={event => activate(event, select)}
            {...focusProps(entry.key)}
          >
            <rect x={nx - 9} y={BEAM_Y - 10} width={18} height={20} fill="transparent" />
            {entry.kind === 'alarm' ? (
              <circle cx={nx} cy={BEAM_Y} r={5.5} fill="#1C1917" stroke={color} strokeWidth={2.5} strokeDasharray={entry.status === 'off' ? '2 2' : undefined} opacity={faded ? 0.55 : 1} />
            ) : (
              <rect
                x={nx - 5}
                y={BEAM_Y - 5}
                width={10}
                height={10}
                transform={`rotate(45 ${nx} ${BEAM_Y})`}
                fill={color}
                stroke={entry.status === 'snoozed' ? COLORS.now : '#1C1917'}
                strokeDasharray={entry.status === 'snoozed' ? '2 2' : undefined}
                strokeWidth={1.5}
                opacity={faded ? 0.55 : 1}
              />
            )}
            {chosen ? <circle cx={nx} cy={BEAM_Y} r={10} fill="none" stroke={COLORS.now} strokeWidth={1.5} strokeDasharray="3 2" /> : null}
            {label ? (
              <>
                <line x1={nx} x2={nx} y1={BEAM_Y + 7} y2={BEAM_Y + 15 + label.row * 13} stroke={color} strokeOpacity="0.35" />
                <text x={nx + 3} y={BEAM_Y + 25 + label.row * 13} fontSize="10" fill={faded ? 'rgba(253,230,138,0.5)' : '#FDE68A'} pointerEvents="none">
                  {label.text}
                </text>
              </>
            ) : null}
          </g>
        );
      })}

      {/* Nexus events branch off toward the red lines */}
      {model.nexus.map((nexus, index) => {
        const bx = x(nexus.at);
        const up = nexus.type !== 'timer';
        const reach = up
          ? BEAM_Y - (BEAM_Y - RED_TOP) * nexus.severity - (nexus.severity >= 1 ? 12 : 0)
          : BEAM_Y + (RED_BOTTOM - BEAM_Y) * nexus.severity;
        const flip = bx > W - 170;
        const dx = (flip ? -1 : 1) * (48 + (index % 3) * 22);
        const ex = bx + dx;
        const ey = reach + (up ? (index % 2) * 8 : -(index % 2) * 8);
        const chosen = isSelected('nexus', nexus.key) || focusKey === nexus.key;
        const opacity = nexus.resolved ? 0.4 : 1;
        const tag = nexus.type === 'conflict' ? 'CONFLICT' : nexus.type === 'overdue' ? 'OVERDUE' : 'TIMER DONE';
        const select = () => onSelect({ type: 'nexus', key: nexus.key });
        return (
          <g
            key={nexus.key}
            role="button"
            tabIndex={0}
            aria-label={`Nexus event: ${tag.toLowerCase()}, ${nexus.title}. ${nexus.detail}`}
            aria-pressed={isSelected('nexus', nexus.key)}
            className="cursor-pointer outline-none"
            onClick={select}
            onKeyDown={event => activate(event, select)}
            {...focusProps(nexus.key)}
            opacity={opacity}
          >
            <path
              d={`M ${bx} ${BEAM_Y} C ${bx + dx * 0.35} ${BEAM_Y}, ${bx + dx * 0.55} ${ey}, ${ex} ${ey}`}
              stroke={COLORS.red}
              strokeWidth={chosen ? 3 : 2.2}
              fill="none"
              filter={nexus.resolved ? undefined : `url(#${redGlowId})`}
            />
            <circle cx={ex} cy={ey} r={chosen ? 6.5 : 5} fill={COLORS.red} filter={`url(#${redGlowId})`}>
              {!nexus.resolved && !still ? <animate attributeName="r" values={chosen ? '6.5;8;6.5' : '5;6.5;5'} dur="1.6s" repeatCount="indefinite" /> : null}
            </circle>
            <text x={ex + (flip ? -9 : 9)} y={ey - 3} fontSize="10" fontWeight="bold" fill="#FCA5A5" textAnchor={flip ? 'end' : 'start'} letterSpacing="1">{tag}</text>
            <text x={ex + (flip ? -9 : 9)} y={ey + 9} fontSize="10" fill="#FECACA" textAnchor={flip ? 'end' : 'start'}>{clipText(nexus.title, 24)}</text>
          </g>
        );
      })}

      {/* NOW marker */}
      {nowX !== null ? (
        <g aria-hidden="true">
          <line x1={nowX} x2={nowX} y1={RED_TOP - 16} y2={RED_BOTTOM} stroke={COLORS.now} strokeOpacity="0.7" strokeWidth="1.5" strokeDasharray="4 3" />
          <circle cx={nowX} cy={BEAM_Y} r={4.5} fill={COLORS.now}>
            {!still ? <animate attributeName="opacity" values="1;0.35;1" dur="2s" repeatCount="indefinite" /> : null}
          </circle>
          <text x={Math.min(W - 60, Math.max(40, nowX))} y={RED_TOP - 20} fontSize="11" fontWeight="bold" fill={COLORS.now} textAnchor="middle" letterSpacing="1">
            NOW {clock24(now)}
          </text>
        </g>
      ) : null}

      <rect x="0" y="0" width={W} height={H} fill={`url(#${scanId})`} pointerEvents="none" />
    </svg>
  );
}

// ── Week: one strand per day ────────────────────────────────────────────────────────────

const ROW_H = 34;
const WEEK_TOP = 14;
const LABEL_W = 64;
const SCORE_W = 46;

function WeekBeams({ days, now, selected, onSelect }: { days: DayModel[]; now: number; selected: Selection; onSelect: (selection: Selection) => void }) {
  const rawId = useId();
  const glowId = `wglow-${svgId(rawId)}`;
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const startHour = Math.min(...days.map(day => new Date(day.from).getHours()));
  const height = WEEK_TOP + days.length * ROW_H + 24;
  const x = (day: DayModel, t: number) => {
    const from = day.dayStart + startHour * HOUR;
    const span = day.to - from;
    return LABEL_W + ((Math.min(day.to, Math.max(from, t)) - from) / span) * (W - LABEL_W - SCORE_W - 10);
  };
  const ticks = Array.from({ length: Math.floor((24 - startHour) / 3) + 1 }, (_, index) => startHour + index * 3).filter(hour => hour <= 24);
  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="w-full h-auto block select-none" role="group" aria-label="Sacred Timeline for the next 7 days">
      <defs>
        <filter id={glowId} x="-20%" y="-300%" width="140%" height="700%">
          <feGaussianBlur stdDeviation="2.5" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <rect x="0" y="0" width={W} height={height} fill="rgba(0,0,0,0.55)" />
      {ticks.map(hour => {
        const tx = x(days[0], days[0].dayStart + hour * HOUR);
        return (
          <g key={hour}>
            <line x1={tx} x2={tx} y1={WEEK_TOP - 4} y2={height - 20} stroke="rgba(217,119,6,0.12)" />
            <text x={tx} y={height - 6} fontSize="11" fill="rgba(251,191,36,0.6)" textAnchor="middle">{String(hour % 24).padStart(2, '0')}</text>
          </g>
        );
      })}
      {days.map((day, row) => {
        const cy = WEEK_TOP + row * ROW_H + ROW_H / 2;
        const level = day.deviation.level;
        const scoreColor = level === 'critical' ? '#F87171' : level === 'elevated' ? '#FBBF24' : '#34D399';
        const nowX = day.isToday ? x(day, now) : null;
        const conflictKeys = new Set(day.nexus.filter(n => n.type === 'conflict').flatMap(n => n.entries?.map(e => e.key) ?? []));
        return (
          <g key={day.dayStart}>
            <text x={8} y={cy + 4} fontSize="11" fontWeight={day.isToday ? 'bold' : 'normal'} fill={day.isToday ? '#FDE68A' : 'rgba(253,230,138,0.7)'} letterSpacing="1">
              {new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric' }).format(day.dayStart).toUpperCase()}
            </text>
            <line x1={LABEL_W} x2={W - SCORE_W - 10} y1={cy} y2={cy} stroke={COLORS.beam} strokeOpacity={day.isToday ? 1 : 0.7} strokeWidth="2.5" filter={`url(#${glowId})`} />
            {nowX !== null ? <line x1={nowX} x2={nowX} y1={cy - 13} y2={cy + 13} stroke={COLORS.now} strokeWidth="1.5" strokeDasharray="3 2" /> : null}
            {day.allDay.length > 0 ? (
              <text x={LABEL_W} y={cy - 9} fontSize="9" fill="rgba(253,230,138,0.65)">{clipText(`ALL DAY: ${day.allDay.map(e => e.title).join(', ')}`, 70)}</text>
            ) : null}
            {day.entries.map(entry => {
              const ex = x(day, entry.start);
              const chosen = (selected?.type === 'entry' && selected.key === entry.key) || focusKey === entry.key;
              const select = () => onSelect({ type: 'entry', key: entry.key });
              const common = {
                role: 'button',
                tabIndex: 0,
                'aria-label': entryAria(entry, now),
                className: 'cursor-pointer outline-none',
                onClick: select,
                onKeyDown: (event: KeyboardEvent) => activate(event, select),
                onFocus: () => setFocusKey(entry.key),
                onBlur: () => setFocusKey(current => (current === entry.key ? null : current)),
              } as const;
              if (entry.kind === 'event') {
                const width = Math.max(4, x(day, entry.end) - ex);
                const lane = Math.min(2, day.lanes.get(entry.key) ?? 0);
                return (
                  <g key={entry.key} {...common}>
                    <rect
                      x={ex}
                      y={cy - 4 - lane * 9}
                      width={width}
                      height={8}
                      rx={2}
                      fill={entry.status === 'done' ? COLORS.done : entry.status === 'past' ? COLORS.eventPast : COLORS.event}
                      stroke={chosen ? COLORS.now : conflictKeys.has(entry.key) ? COLORS.red : 'none'}
                      strokeWidth={chosen ? 2 : 1.5}
                    />
                  </g>
                );
              }
              const color = entry.status === 'overdue' ? COLORS.red : entry.kind === 'alarm' ? COLORS.alarm : COLORS.reminder;
              return (
                <g key={entry.key} {...common}>
                  <rect x={ex - 7} y={cy - 9} width={14} height={18} fill="transparent" />
                  {entry.kind === 'alarm'
                    ? <circle cx={ex} cy={cy} r={3.8} fill="#1C1917" stroke={color} strokeWidth={2} opacity={entry.status === 'off' ? 0.5 : 1} />
                    : <rect x={ex - 3.5} y={cy - 3.5} width={7} height={7} transform={`rotate(45 ${ex} ${cy})`} fill={color} opacity={entry.status === 'past' ? 0.55 : 1} />}
                  {chosen ? <circle cx={ex} cy={cy} r={8} fill="none" stroke={COLORS.now} strokeDasharray="2 2" /> : null}
                </g>
              );
            })}
            {day.nexus.map(nexus => {
              const nx = x(day, nexus.at);
              const chosen = (selected?.type === 'nexus' && selected.key === nexus.key) || focusKey === nexus.key;
              const select = () => onSelect({ type: 'nexus', key: nexus.key });
              const up = nexus.type !== 'timer';
              return (
                <g
                  key={nexus.key}
                  role="button"
                  tabIndex={0}
                  aria-label={`Nexus event: ${nexus.type}, ${nexus.title}. ${nexus.detail}`}
                  className="cursor-pointer outline-none"
                  onClick={select}
                  onKeyDown={event => activate(event, select)}
                  onFocus={() => setFocusKey(nexus.key)}
                  onBlur={() => setFocusKey(current => (current === nexus.key ? null : current))}
                  opacity={nexus.resolved ? 0.45 : 1}
                >
                  <path d={`M ${nx} ${cy} Q ${nx + 6} ${cy + (up ? -12 : 12)} ${nx + 14} ${cy + (up ? -14 : 14)}`} stroke={COLORS.red} strokeWidth={chosen ? 2.5 : 1.8} fill="none" />
                  <circle cx={nx + 14} cy={cy + (up ? -14 : 14)} r={chosen ? 4 : 3} fill={COLORS.red} />
                </g>
              );
            })}
            <text x={W - 8} y={cy + 4} fontSize="11" textAnchor="end" fill={scoreColor} fontWeight="bold">{day.deviation.score}%</text>
          </g>
        );
      })}
    </svg>
  );
}

// ── Details and actions ─────────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col">
      <MicroLabel>{label}</MicroLabel>
      <span className="text-[11px] text-amber-100 break-words">{children}</span>
    </div>
  );
}

function EntryDetails({ entry, now, conflicts, onClose, onSelectEntry }: {
  entry: AgendaEntry;
  now: number;
  conflicts: AgendaEntry[];
  onClose: () => void;
  onSelectEntry: (key: string) => void;
}) {
  const action = useAction();
  const item = entry.item;
  const recurring = item.recurrence !== 'none';
  const when = entry.kind === 'event'
    ? entry.allDay ? `${formatDay(entry.start, now)} (all day)` : `${formatWhen(entry.start, now)} to ${formatTime(entry.end)} (${formatDuration(entry.end - entry.start)})`
    : formatWhen(entry.start, now);
  const statusText: Record<AgendaEntry['status'], string> = {
    upcoming: 'Upcoming', past: entry.kind === 'event' ? 'Finished' : 'Fired', overdue: 'Overdue', snoozed: 'Snoozed', off: 'Off', done: 'Done',
  };
  const kindIcon = entry.kind === 'event' ? <CalendarDays className="w-3.5 h-3.5" /> : entry.kind === 'alarm' ? <AlarmClock className="w-3.5 h-3.5" /> : <Bell className="w-3.5 h-3.5" />;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <h4 className="text-xs font-bold text-amber-100 flex items-center gap-1.5 uppercase tracking-wider">
          <span className="text-amber-400" aria-hidden="true">{kindIcon}</span>{entry.title}
        </h4>
        <Button tone="quiet" onClick={onClose} label="Close details"><X className="w-3.5 h-3.5" /></Button>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Field label="When">{when}</Field>
        <Field label="Status">{statusText[entry.status]}{item.snoozedUntil && item.snoozedUntil > now ? ` until ${formatTime(item.snoozedUntil)}` : ''}</Field>
        <Field label="Repeats">{recurring ? recurrenceText(item.recurrence, item.startAt) : 'No'}</Field>
        <Field label="Added">{formatDay(item.createdAt, now)} via {item.source === 'chat' ? 'Miss Minutes' : 'the panel'}</Field>
        {entry.location ? <Field label="Where"><MapPin className="inline w-3 h-3 mr-0.5" aria-hidden="true" />{entry.location}</Field> : null}
        {entry.notes ? <div className="col-span-2 sm:col-span-4"><Field label="Notes">{entry.notes}</Field></div> : null}
      </div>
      {conflicts.length > 0 ? (
        <p className="text-[11px] text-red-300 flex flex-wrap items-center gap-1">
          <TriangleAlert className="w-3.5 h-3.5" aria-hidden="true" /> Overlaps
          {conflicts.map(other => (
            <button key={other.key} type="button" onClick={() => onSelectEntry(other.key)} className={`underline decoration-dotted hover:text-red-100 rounded ${focusRing}`}>
              {other.title} ({formatTime(other.start)}-{formatTime(other.end)})
            </button>
          ))}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        {entry.kind === 'event' ? (
          <Button onClick={() => action.run(() => setScheduleDone(item.id, !item.done))} disabled={action.busy}>
            {item.done ? <><RotateCcw className="w-3 h-3" /> Re-open</> : <><Check className="w-3 h-3" /> Mark done</>}
          </Button>
        ) : null}
        {entry.kind === 'reminder' && !recurring && !item.done ? (
          <Button onClick={() => action.run(() => setScheduleDone(item.id, true))} disabled={action.busy}><Check className="w-3 h-3" /> Done</Button>
        ) : null}
        {entry.kind === 'reminder' && !recurring && item.done ? (
          <Button onClick={() => action.run(() => setScheduleDone(item.id, false))} disabled={action.busy}><RotateCcw className="w-3 h-3" /> Re-open</Button>
        ) : null}
        {entry.kind !== 'event' && recurring && !item.done ? (
          <Button onClick={() => action.run(() => skipNextOccurrence(item.id))} disabled={action.busy}><Repeat className="w-3 h-3" /> Skip next</Button>
        ) : null}
        {entry.kind === 'reminder' && recurring ? (
          <Button onClick={() => action.run(() => setScheduleDone(item.id, !item.done))} disabled={action.busy}>
            {item.done ? <><RotateCcw className="w-3 h-3" /> Resume repeating</> : <><X className="w-3 h-3" /> Stop repeating</>}
          </Button>
        ) : null}
        {entry.kind === 'alarm' ? (
          <Button onClick={() => action.run(() => setAlarmEnabled(item.id, item.done))} disabled={action.busy}>
            <AlarmClock className="w-3 h-3" /> {item.done ? 'Turn on' : 'Turn off'}
          </Button>
        ) : null}
        {entry.kind !== 'event' ? (
          <>
            <Button onClick={() => action.run(() => snoozeScheduleItem(item.id, 10))} disabled={action.busy}><Clock className="w-3 h-3" /> Snooze 10 min</Button>
            <Button onClick={() => action.run(() => snoozeScheduleItem(item.id, 60))} disabled={action.busy}>Snooze 1 h</Button>
          </>
        ) : null}
        <ConfirmButton
          question={recurring ? 'Delete it and all repeats?' : 'Delete it?'}
          confirmLabel="Delete"
          tone="danger"
          onConfirm={() => action.run(() => deleteScheduleItem(item.id), onClose)}
        >
          <Trash className="w-3 h-3" /> Delete
        </ConfirmButton>
      </div>
      <ErrorLine message={action.error} />
    </div>
  );
}

function NexusDetails({ nexus, now, onClose, onSelectEntry }: { nexus: NexusEvent; now: number; onClose: () => void; onSelectEntry: (key: string) => void }) {
  const action = useAction();
  const tag = nexus.type === 'conflict' ? 'Scheduling conflict' : nexus.type === 'overdue' ? 'Overdue reminder' : 'Finished timer';
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <h4 className="text-xs font-bold text-red-200 flex items-center gap-1.5 uppercase tracking-wider">
          <TriangleAlert className="w-3.5 h-3.5 text-red-400" aria-hidden="true" />Nexus event: {tag}
        </h4>
        <Button tone="quiet" onClick={onClose} label="Close details"><X className="w-3.5 h-3.5" /></Button>
      </div>
      <p className="text-[11px] text-red-100">{nexus.title}. {nexus.detail}{nexus.resolved ? ' (already past)' : ''}.</p>
      <div className="flex flex-wrap items-center gap-1.5">
        {nexus.type === 'conflict' && nexus.entries ? nexus.entries.map(entry => (
          <Button key={entry.key} tone="ghost" onClick={() => onSelectEntry(entry.key)}>
            <CalendarDays className="w-3 h-3" /> {entry.title} {formatTime(entry.start)}-{formatTime(entry.end)}
          </Button>
        )) : null}
        {nexus.type === 'overdue' && nexus.item ? (
          <>
            <Button onClick={() => action.run(() => setScheduleDone(nexus.item?.id ?? '', true))} disabled={action.busy}><Check className="w-3 h-3" /> Done</Button>
            <Button onClick={() => action.run(() => snoozeScheduleItem(nexus.item?.id ?? '', 10))} disabled={action.busy}><Clock className="w-3 h-3" /> Snooze 10 min</Button>
            <Button onClick={() => action.run(() => snoozeScheduleItem(nexus.item?.id ?? '', 60))} disabled={action.busy}>Snooze 1 h</Button>
            <ConfirmButton question="Delete this reminder?" confirmLabel="Delete" tone="danger" onConfirm={() => action.run(() => deleteScheduleItem(nexus.item?.id ?? ''), onClose)}>
              <Trash className="w-3 h-3" /> Delete
            </ConfirmButton>
          </>
        ) : null}
        {nexus.type === 'timer' && nexus.timer ? (
          <>
            <Button onClick={() => action.run(() => addTimerTime(nexus.timer?.id ?? '', MINUTE))} disabled={action.busy}><Timer className="w-3 h-3" /> Restart for 1 min</Button>
            <Button tone="ghost" onClick={() => action.run(() => clearTimer(nexus.timer?.id ?? ''), onClose)} disabled={action.busy}><X className="w-3 h-3" /> Clear</Button>
          </>
        ) : null}
      </div>
      {nexus.type === 'overdue' && nexus.item?.notes ? <p className="text-[11px] text-amber-200/80">{nexus.item.notes}</p> : null}
      {nexus.type === 'overdue' && nexus.item ? (
        <p className="text-[10px] text-amber-400/60">Added {formatDay(nexus.item.createdAt, now)}{nexus.item.recurrence !== 'none' ? `, repeats ${recurrenceText(nexus.item.recurrence)}` : ''}.</p>
      ) : null}
      <ErrorLine message={action.error} />
    </div>
  );
}

// ── Quick add ───────────────────────────────────────────────────────────────────────────

const DURATIONS: Array<{ label: string; minutes: number }> = [
  { label: '15 min', minutes: 15 }, { label: '30 min', minutes: 30 }, { label: '45 min', minutes: 45 },
  { label: '1 h', minutes: 60 }, { label: '1.5 h', minutes: 90 }, { label: '2 h', minutes: 120 }, { label: '3 h', minutes: 180 },
  { label: 'All day', minutes: 0 },
];

function QuickAdd({ day, now, onAdded }: { day: number; now: number; onAdded: (message: string) => void }) {
  const ids = useId();
  const action = useAction();
  const [kind, setKind] = useState<'event' | 'reminder'>('event');
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(() => localDate(day));
  const [time, setTime] = useState(() => {
    const base = localDate(day) === localDate(now) ? now + HOUR : day + 9 * HOUR;
    const top = new Date(base);
    top.setMinutes(0, 0, 0);
    return clock24(top.getTime());
  });
  const [minutes, setMinutes] = useState(EVENT_DEFAULT_MS / MINUTE);
  const [recurrence, setRecurrence] = useState<Recurrence>('none');
  const [location, setLocation] = useState('');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    action.run(async () => {
      if (!title.trim()) throw new ToolInputError('Give it a title.');
      if (kind === 'event' && minutes === 0) {
        const start = parseDateTime(date, 'date');
        const { item } = await createEvent({ title, start: start.ms, allDay: true, recurrence, location, source: 'manual' });
        onAdded(`Added "${item.title}" on ${formatDay(item.startAt)} (all day).`);
      } else {
        if (!time) throw new ToolInputError('Pick a time.');
        const at = parseDateTime(`${date}T${time}`, 'time');
        if (kind === 'event') {
          const { item, conflicts } = await createEvent({ title, start: at.ms, end: at.ms + minutes * MINUTE, recurrence, location, source: 'manual' });
          onAdded(`Added "${item.title}" ${formatWhen(item.startAt)}-${formatTime(item.endAt ?? item.startAt)}${conflicts.length ? `, overlapping ${conflicts.map(c => `"${c.title}"`).join(', ')}` : ''}.`);
        } else {
          const { item, rolled } = await createReminder({ title, at: at.ms, recurrence, source: 'manual' });
          onAdded(`Reminder set: "${item.title}" ${formatWhen(item.startAt)}${rolled ? ' (first repeat already passed)' : ''}.`);
        }
      }
      setTitle('');
      setLocation('');
    });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 bg-black/30 border border-amber-800/30 rounded-lg p-2.5" aria-label="Add to the timeline">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-0.5">
          <MicroLabel>Type</MicroLabel>
          <div className="flex gap-1" role="radiogroup" aria-label="Type">
            {(['event', 'reminder'] as const).map(option => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={kind === option}
                onClick={() => setKind(option)}
                className={`px-2 py-1 text-[11px] rounded border ${focusRing} ${kind === option ? 'bg-amber-600/40 border-amber-400/60 text-amber-100' : 'border-amber-800/50 text-amber-400/80 hover:text-amber-200'}`}
              >
                {option === 'event' ? 'Event' : 'Reminder'}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-0.5 flex-1 min-w-[10rem]">
          <MicroLabel htmlFor={`${ids}-title`}>Title</MicroLabel>
          <input id={`${ids}-title`} className={inputClass} value={title} onChange={event => setTitle(event.target.value)} maxLength={200} placeholder={kind === 'event' ? 'Design review' : 'Call Mom'} required />
        </div>
        <div className="flex flex-col gap-0.5">
          <MicroLabel htmlFor={`${ids}-date`}>Date</MicroLabel>
          <input id={`${ids}-date`} type="date" className={inputClass} value={date} onChange={event => setDate(event.target.value)} required />
        </div>
        {!(kind === 'event' && minutes === 0) ? (
          <div className="flex flex-col gap-0.5">
            <MicroLabel htmlFor={`${ids}-time`}>Time</MicroLabel>
            <input id={`${ids}-time`} type="time" className={inputClass} value={time} onChange={event => setTime(event.target.value)} required />
          </div>
        ) : null}
        {kind === 'event' ? (
          <div className="flex flex-col gap-0.5">
            <MicroLabel htmlFor={`${ids}-length`}>Length</MicroLabel>
            <select id={`${ids}-length`} className={inputClass} value={minutes} onChange={event => setMinutes(Number(event.target.value))}>
              {DURATIONS.map(option => <option key={option.minutes} value={option.minutes}>{option.label}</option>)}
            </select>
          </div>
        ) : null}
        <div className="flex flex-col gap-0.5">
          <MicroLabel htmlFor={`${ids}-repeat`}>Repeat</MicroLabel>
          <select id={`${ids}-repeat`} className={inputClass} value={recurrence} onChange={event => setRecurrence(event.target.value as Recurrence)}>
            <option value="none">Never</option>
            <option value="daily">Daily</option>
            <option value="weekdays">Weekdays</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </div>
        {kind === 'event' ? (
          <div className="flex flex-col gap-0.5 min-w-[8rem]">
            <MicroLabel htmlFor={`${ids}-where`}>Where</MicroLabel>
            <input id={`${ids}-where`} className={inputClass} value={location} onChange={event => setLocation(event.target.value)} maxLength={200} placeholder="Optional" />
          </div>
        ) : null}
        <Button type="submit" tone="solid" disabled={action.busy}><Plus className="w-3.5 h-3.5" /> Add</Button>
      </div>
      <ErrorLine message={action.error} />
    </form>
  );
}

// ── Branch log (keyboard / screen-reader friendly list of everything in view) ─────────────

function BranchLog({ days, now, selected, onSelect }: { days: DayModel[]; now: number; selected: Selection; onSelect: (selection: Selection) => void }) {
  const rows = days.flatMap(day => {
    const items: Array<{ key: string; at: number; type: 'entry' | 'nexus'; text: string; meta: string; tone: string; icon: ReactNode }> = [];
    for (const entry of [...day.allDay, ...day.entries]) {
      const time = entry.allDay ? 'all day' : entry.kind === 'event' ? `${clock24(entry.start)}-${clock24(entry.end)}` : clock24(entry.start);
      items.push({
        key: entry.key, at: entry.start, type: 'entry', text: entry.title,
        meta: `${days.length > 1 ? `${formatDayRelative(day.dayStart, now)} ` : ''}${time}${entry.status === 'upcoming' ? '' : ` · ${entry.status}`}`,
        tone: entry.status === 'overdue' ? 'text-red-300' : entry.status === 'past' || entry.status === 'done' || entry.status === 'off' ? 'text-amber-400/50' : 'text-amber-100',
        icon: entry.kind === 'event' ? <CalendarDays className="w-3 h-3" /> : entry.kind === 'alarm' ? <AlarmClock className="w-3 h-3" /> : <Bell className="w-3 h-3" />,
      });
    }
    for (const nexus of day.nexus) {
      items.push({
        key: nexus.key, at: nexus.at, type: 'nexus', text: nexus.title, meta: `${nexus.type === 'conflict' ? 'conflict' : nexus.type === 'overdue' ? 'overdue' : 'timer done'} · ${nexus.detail}`,
        tone: nexus.resolved ? 'text-red-300/50' : 'text-red-300', icon: <TriangleAlert className="w-3 h-3" />,
      });
    }
    return items.sort((a, b) => a.at - b.at);
  });
  if (rows.length === 0) return null;
  return (
    <details className="group">
      <summary className={`cursor-pointer text-[10px] uppercase tracking-widest text-amber-500 hover:text-amber-300 rounded ${focusRing}`}>
        Branch log ({rows.length})
      </summary>
      <ul className="mt-1.5 max-h-48 overflow-y-auto pr-1 flex flex-col gap-0.5">
        {rows.map(row => (
          <li key={`${row.type}:${row.key}`}>
            <button
              type="button"
              onClick={() => onSelect({ type: row.type, key: row.key })}
              aria-pressed={selected?.type === row.type && selected.key === row.key}
              className={`w-full text-left flex items-center gap-2 px-2 py-1 rounded text-[11px] hover:bg-amber-900/30 ${focusRing} ${row.tone} ${selected?.key === row.key ? 'bg-amber-900/40' : ''}`}
            >
              <span aria-hidden="true">{row.icon}</span>
              <span className="truncate flex-1">{row.text}</span>
              <span className="text-[10px] text-amber-400/60 truncate max-w-[50%]">{row.meta}</span>
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}

// ── Panel ───────────────────────────────────────────────────────────────────────────────

const VIEWS: Array<{ id: TimelineView; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'tomorrow', label: 'Tomorrow' },
  { id: 'week', label: 'Week' },
];

export function SacredTimeline({ className, defaultView = 'today' }: SacredTimelineProps) {
  const now = useNow(15_000);
  const schedule = useDbList('schedule');
  const timers = useDbList('timers');
  const todos = useDbList('todos');
  const [view, setView] = useState<TimelineView>(defaultView);
  const [selection, setSelection] = useState<Selection>(null);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const model = useMemo(
    () => buildView({ view, items: schedule.data ?? [], timers: timers.data ?? [], todos: todos.data ?? [], now }),
    [view, schedule.data, timers.data, todos.data, now],
  );
  const loading = schedule.loading || timers.loading || todos.loading;
  const error = schedule.error ?? timers.error ?? todos.error;

  const entries = model.days.flatMap(day => [...day.allDay, ...day.entries]);
  const nexusAll = model.days.flatMap(day => day.nexus);
  const selectedEntry = selection?.type === 'entry' ? entries.find(entry => entry.key === selection.key) : undefined;
  const selectedNexus = selection?.type === 'nexus' ? nexusAll.find(nexus => nexus.key === selection.key) : undefined;
  const conflictsFor = (entry: AgendaEntry) => nexusAll
    .filter(nexus => nexus.type === 'conflict' && nexus.entries?.some(e => e.key === entry.key))
    .flatMap(nexus => nexus.entries?.filter(e => e.key !== entry.key) ?? []);
  const live = nexusAll.filter(nexus => !nexus.resolved).length;
  const critical = model.deviation.level === 'critical';
  const single = model.days.length === 1 ? model.days[0] : undefined;
  const firstDay = model.days[0]?.dayStart ?? now;

  return (
    <PanelShell
      title="Sacred Timeline"
      icon={<ShieldCheck className="w-4 h-4" />}
      alert={critical}
      className={className}
      subtitle={live > 0 ? `${live} nexus event${live === 1 ? '' : 's'}` : undefined}
      actions={(
        <>
          <div role="group" aria-label="Timeline range" className="flex gap-1">
            {VIEWS.map(option => (
              <button
                key={option.id}
                type="button"
                aria-pressed={view === option.id}
                onClick={() => { setView(option.id); setSelection(null); }}
                className={`px-2.5 py-1 text-xs rounded transition-colors ${focusRing} ${view === option.id ? 'bg-amber-600/40 text-amber-100 font-semibold' : 'text-amber-400/70 hover:text-amber-200'}`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <Button tone={adding ? 'ghost' : 'amber'} onClick={() => setAdding(value => !value)} pressed={adding}>
            {adding ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />} {adding ? 'Close' : 'Add'}
          </Button>
        </>
      )}
    >
      <DeviationGauge report={model.deviation} peakLabel={view === 'week' ? formatDayRelative(model.peakDay, now) : undefined} />

      {single && single.allDay.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <MicroLabel>All day</MicroLabel>
          {single.allDay.map(entry => (
            <button
              key={entry.key}
              type="button"
              onClick={() => setSelection({ type: 'entry', key: entry.key })}
              aria-pressed={selection?.key === entry.key}
              className={`px-2 py-0.5 rounded-full border border-amber-500/40 bg-amber-600/20 text-amber-100 hover:bg-amber-600/40 ${focusRing}`}
            >
              {entry.title}
            </button>
          ))}
        </div>
      ) : null}

      <div className={`relative rounded-lg overflow-hidden border ${critical ? 'border-red-600/60' : 'border-amber-700/50'} bg-black/60 shadow-inner`}>
        {single
          ? <DayBeam model={single} now={now} selected={selection} onSelect={setSelection} />
          : <WeekBeams days={model.days} now={now} selected={selection} onSelect={setSelection} />}
        {!loading && entries.length === 0 && nexusAll.length === 0 ? (
          <p className="absolute inset-x-0 top-[27%] text-center text-[11px] text-amber-300/80 pointer-events-none">
            Nothing on the timeline {view === 'week' ? 'this week' : formatDayRelative(firstDay, now)}. All quiet, sugar.
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[9px] uppercase tracking-widest text-amber-400/70 -mt-1" aria-hidden="true">
        <span><span className="inline-block w-2.5 h-1.5 bg-amber-500 mr-1 align-middle" />event</span>
        <span><span className="inline-block w-1.5 h-1.5 bg-orange-400 rotate-45 mr-1 align-middle" />reminder</span>
        <span><span className="inline-block w-2 h-2 rounded-full border-2 border-amber-200 mr-1 align-middle" />alarm</span>
        <span className="text-sky-400"><span className="inline-block w-2.5 h-0.5 bg-sky-400 mr-1 align-middle" />timer</span>
        <span className="text-red-400"><span className="inline-block w-2 h-2 rounded-full bg-red-500 mr-1 align-middle" />nexus event</span>
        <span className="ml-auto normal-case tracking-normal">Click or press Enter on anything for details</span>
      </div>

      {error ? <ErrorLine message={`Could not read the schedule: ${error}`} /> : null}
      {notice ? (
        <p role="status" className="text-[11px] text-emerald-300 flex items-center gap-1.5">
          <Check className="w-3.5 h-3.5" aria-hidden="true" />{notice}
          <button type="button" className={`ml-auto text-amber-400/70 hover:text-amber-200 rounded ${focusRing}`} onClick={() => setNotice(null)} aria-label="Dismiss">
            <X className="w-3 h-3" />
          </button>
        </p>
      ) : null}

      {adding ? <QuickAdd key={`${view}-${firstDay}`} day={firstDay} now={now} onAdded={setNotice} /> : null}

      <div aria-live="polite">
        {selectedEntry ? (
          <EntryDetails
            entry={selectedEntry}
            now={now}
            conflicts={conflictsFor(selectedEntry)}
            onClose={() => setSelection(null)}
            onSelectEntry={key => setSelection({ type: 'entry', key })}
          />
        ) : selectedNexus ? (
          <NexusDetails nexus={selectedNexus} now={now} onClose={() => setSelection(null)} onSelectEntry={key => setSelection({ type: 'entry', key })} />
        ) : loading ? (
          <Empty>Reading the timeline...</Empty>
        ) : null}
      </div>

      <BranchLog days={model.days} now={now} selected={selection} onSelect={setSelection} />
    </PanelShell>
  );
}

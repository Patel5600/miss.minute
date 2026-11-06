/**
 * Pure schedule logic shared by the tools, the scheduler, the model context and the Sacred
 * Timeline: recurrence expansion, when reminders and alarms fire next, overlaps (conflicts),
 * back-to-back runs and the deviation (load) gauge. Nothing here touches storage.
 *
 * Semantics:
 *   - Events keep `startAt` as the anchor of their series; occurrences are expanded.
 *   - Reminders and alarms keep `startAt` as their next due time. When a recurring one fires,
 *     the scheduler rolls `startAt` forward. A one-off reminder that fired stays "overdue" until
 *     it is marked done or snoozed; a one-off alarm switches itself off (`done`).
 */
import type { Recurrence, ScheduleItem, ScheduleKind, TimerRecord, TodoRecord } from '../../store/db';
import { DAY, MINUTE, addDays, calendarDaysBetween, daysInMonth, isWeekend, startOfDay } from './time';

export const RECURRENCES: readonly Recurrence[] = ['none', 'daily', 'weekdays', 'weekly', 'monthly'];

/** The n-th step of a series anchored at `start` (n may be negative). Month ends are clamped. */
export function nthOccurrence(start: number, recurrence: Recurrence, n: number): number {
  const date = new Date(start);
  switch (recurrence) {
    case 'daily':
    case 'weekdays':
      date.setDate(date.getDate() + n);
      return date.getTime();
    case 'weekly':
      date.setDate(date.getDate() + 7 * n);
      return date.getTime();
    case 'monthly': {
      const day = date.getDate();
      date.setDate(1);
      date.setMonth(date.getMonth() + n);
      date.setDate(Math.min(day, daysInMonth(date.getFullYear(), date.getMonth())));
      return date.getTime();
    }
    default:
      return start;
  }
}

/** A step index at or slightly before the one that reaches `target`, so loops start close by. */
function indexNear(start: number, recurrence: Recurrence, target: number): number {
  const days = calendarDaysBetween(start, target);
  switch (recurrence) {
    case 'daily':
    case 'weekdays':
      return days - 1;
    case 'weekly':
      return Math.floor(days / 7) - 1;
    case 'monthly': {
      const a = new Date(start);
      const b = new Date(target);
      return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()) - 1;
    }
    default:
      return 0;
  }
}

function counts(recurrence: Recurrence, ms: number): boolean {
  return recurrence !== 'weekdays' || !isWeekend(ms);
}

/**
 * Occurrence starts of the series anchored at `start` that overlap [from, to).
 * Point items (length 0) match when from <= s < to; longer ones when they intersect.
 */
export function occurrenceStarts(
  start: number,
  recurrence: Recurrence,
  from: number,
  to: number,
  options: { length?: number; limit?: number } = {},
): number[] {
  const length = Math.max(0, options.length ?? 0);
  const limit = options.limit ?? 500;
  const hit = (s: number) => (length > 0 ? s < to && s + length > from : s >= from && s < to);
  if (recurrence === 'none') return hit(start) ? [start] : [];
  const out: number[] = [];
  let n = Math.max(0, indexNear(start, recurrence, from - length));
  for (let guard = 0; guard < 5000 && out.length < limit; guard += 1, n += 1) {
    const s = nthOccurrence(start, recurrence, n);
    if (s >= to) break;
    if (counts(recurrence, s) && hit(s)) out.push(s);
  }
  return out;
}

/** First occurrence strictly after `after`, or undefined for a one-off that has passed. */
export function nextOccurrenceAfter(start: number, recurrence: Recurrence, after: number): number | undefined {
  if (recurrence === 'none') return start > after ? start : undefined;
  let n = Math.max(0, indexNear(start, recurrence, after));
  for (let guard = 0; guard < 5000; guard += 1, n += 1) {
    const s = nthOccurrence(start, recurrence, n);
    if (s > after && counts(recurrence, s)) return s;
  }
  return undefined;
}

/** Latest occurrence at or before `at`, or undefined when the series starts later. */
export function occurrenceAtOrBefore(start: number, recurrence: Recurrence, at: number): number | undefined {
  if (start > at) return undefined;
  if (recurrence === 'none') return start;
  // Start a few steps early so a weekend gap (weekdays) cannot hide the latest match.
  let n = Math.max(0, indexNear(start, recurrence, at) - 3);
  let best: number | undefined;
  for (let guard = 0; guard < 5000; guard += 1, n += 1) {
    const s = nthOccurrence(start, recurrence, n);
    if (s > at) break;
    if (counts(recurrence, s)) best = s;
  }
  return best;
}

/** When a reminder or alarm fires next. Undefined when it is off, done, or waiting to be acknowledged. */
export function nextFireAt(item: ScheduleItem): number | undefined {
  if (item.kind === 'event' || item.done) return undefined;
  const fired = item.lastFiredAt ?? Number.NEGATIVE_INFINITY;
  if (item.snoozedUntil !== undefined && item.snoozedUntil > fired) return item.snoozedUntil;
  if (fired >= item.startAt) return undefined;
  return item.startAt;
}

/** A one-off reminder whose time has passed and that nobody marked done or snoozed. */
export function isOverdue(item: ScheduleItem, now: number): boolean {
  if (item.kind !== 'reminder' || item.done || item.recurrence !== 'none') return false;
  if (item.snoozedUntil !== undefined && item.snoozedUntil > now) return false;
  return item.startAt <= now;
}

export function isSnoozed(item: ScheduleItem, now: number): boolean {
  return !item.done && item.snoozedUntil !== undefined && item.snoozedUntil > now
    && item.snoozedUntil > (item.lastFiredAt ?? Number.NEGATIVE_INFINITY);
}

/** Timed, not done events alert at each occurrence's start. Returns the due occurrence, if any. */
export function dueEventOccurrence(item: ScheduleItem, now: number): number | undefined {
  if (item.kind !== 'event' || item.done || item.allDay) return undefined;
  const baseline = Math.max(item.lastFiredAt ?? Number.NEGATIVE_INFINITY, item.createdAt - MINUTE);
  const due = occurrenceAtOrBefore(item.startAt, item.recurrence, now);
  return due !== undefined && due > baseline ? due : undefined;
}

export function nextEventAlert(item: ScheduleItem, now: number): number | undefined {
  if (item.kind !== 'event' || item.done || item.allDay) return undefined;
  const after = Math.max(now, item.lastFiredAt ?? Number.NEGATIVE_INFINITY, item.createdAt - MINUTE);
  return nextOccurrenceAfter(item.startAt, item.recurrence, after);
}

export type EntryStatus = 'upcoming' | 'past' | 'overdue' | 'snoozed' | 'off' | 'done';

export interface AgendaEntry {
  /** Unique per occurrence: `${id}@${start}`. */
  key: string;
  id: string;
  kind: ScheduleKind;
  title: string;
  start: number;
  /** Equal to `start` for reminders and alarms. */
  end: number;
  allDay: boolean;
  location?: string;
  notes?: string;
  recurrence: Recurrence;
  status: EntryStatus;
  item: ScheduleItem;
}

function eventLength(item: ScheduleItem): number {
  if (item.allDay) return Math.max(DAY, (item.endAt ?? item.startAt + DAY) - item.startAt);
  return Math.max(0, (item.endAt ?? item.startAt) - item.startAt);
}

/**
 * Concrete agenda entries overlapping [from, to), sorted by start. Includes past repeats of
 * recurring reminders/alarms (as 'past') so a day view shows what already fired.
 */
export function expandAgenda(
  items: ScheduleItem[],
  from: number,
  to: number,
  now: number,
  options: { includeOff?: boolean; kinds?: ScheduleKind[] } = {},
): AgendaEntry[] {
  const out: AgendaEntry[] = [];
  for (const item of items) {
    if (options.kinds && !options.kinds.includes(item.kind)) continue;
    const base = {
      id: item.id,
      kind: item.kind,
      title: item.title,
      allDay: item.allDay ?? false,
      location: item.location,
      notes: item.notes,
      recurrence: item.recurrence,
      item,
    };
    if (item.kind === 'event') {
      const length = eventLength(item);
      for (const start of occurrenceStarts(item.startAt, item.recurrence, from, to, { length, limit: 200 })) {
        const end = start + length;
        const status: EntryStatus = item.done ? 'done' : end <= now ? 'past' : 'upcoming';
        out.push({ ...base, key: `${item.id}@${start}`, start, end, status });
      }
      continue;
    }

    if (item.kind === 'alarm' && item.done && !options.includeOff) continue;
    const pending = nextFireAt(item);
    const snoozed = isSnoozed(item, now);
    const overdue = isOverdue(item, now);
    const seen = new Set<number>();
    const push = (start: number, status: EntryStatus) => {
      if (start < from || start >= to || seen.has(start)) return;
      seen.add(start);
      out.push({ ...base, key: `${item.id}@${start}`, start, end: start, status });
    };

    if (item.recurrence === 'none') {
      if (snoozed && item.snoozedUntil !== undefined) push(item.snoozedUntil, 'snoozed');
      else push(item.startAt, item.done ? (item.kind === 'alarm' ? 'off' : 'done') : overdue ? 'overdue' : item.startAt <= now ? 'past' : 'upcoming');
      continue;
    }

    // Earlier repeats (already fired) between the item's creation and its current due time.
    for (let n = -1, guard = 0; guard < 400; n -= 1, guard += 1) {
      const s = nthOccurrence(item.startAt, item.recurrence, n);
      if (s < from || s < item.createdAt - MINUTE) break;
      if (counts(item.recurrence, s)) push(s, 'past');
    }
    if (snoozed && item.snoozedUntil !== undefined) push(item.snoozedUntil, 'snoozed');
    const status: EntryStatus = item.done ? 'off' : 'upcoming';
    for (const start of occurrenceStarts(item.startAt, item.recurrence, from, to, { limit: 200 })) {
      push(start, start === pending || start > now ? status : 'past');
    }
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end || a.title.localeCompare(b.title));
}

export interface Conflict {
  a: AgendaEntry;
  b: AgendaEntry;
  start: number;
  end: number;
}

/** Overlapping timed events (not all-day, not done), each pair once. */
export function findOverlaps(entries: AgendaEntry[]): Conflict[] {
  const timed = entries
    .filter(entry => entry.kind === 'event' && !entry.allDay && entry.status !== 'done' && entry.end > entry.start)
    .sort((x, y) => x.start - y.start);
  const out: Conflict[] = [];
  for (let i = 0; i < timed.length; i += 1) {
    for (let j = i + 1; j < timed.length; j += 1) {
      const a = timed[i];
      const b = timed[j];
      if (b.start >= a.end) break;
      out.push({ a, b, start: Math.max(a.start, b.start), end: Math.min(a.end, b.end) });
    }
  }
  return out;
}

/** Consecutive timed events with less than `gapMs` between them (but not overlapping). */
export function backToBack(entries: AgendaEntry[], gapMs = 10 * MINUTE): Array<{ first: AgendaEntry; second: AgendaEntry; gap: number }> {
  const timed = entries
    .filter(entry => entry.kind === 'event' && !entry.allDay && entry.status !== 'done' && entry.end > entry.start)
    .sort((x, y) => x.start - y.start);
  const out: Array<{ first: AgendaEntry; second: AgendaEntry; gap: number }> = [];
  for (let i = 1; i < timed.length; i += 1) {
    const gap = timed[i].start - timed[i - 1].end;
    if (gap >= 0 && gap < gapMs) out.push({ first: timed[i - 1], second: timed[i], gap });
  }
  return out;
}

/** Minutes of timed events inside [from, to), with overlaps counted once. */
export function bookedMinutes(entries: AgendaEntry[], from: number, to: number): number {
  const spans = entries
    .filter(entry => entry.kind === 'event' && !entry.allDay && entry.status !== 'done')
    .map(entry => [Math.max(from, entry.start), Math.min(to, entry.end)] as const)
    .filter(([s, e]) => e > s)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cursorStart = Number.NaN;
  let cursorEnd = Number.NaN;
  for (const [s, e] of spans) {
    if (Number.isNaN(cursorStart) || s > cursorEnd) {
      if (!Number.isNaN(cursorStart)) total += cursorEnd - cursorStart;
      cursorStart = s;
      cursorEnd = e;
    } else {
      cursorEnd = Math.max(cursorEnd, e);
    }
  }
  if (!Number.isNaN(cursorStart)) total += cursorEnd - cursorStart;
  return Math.round(total / MINUTE);
}

export interface DeviationPart {
  label: string;
  points: number;
}

export interface DeviationReport {
  /** 0 to 100. */
  score: number;
  parts: DeviationPart[];
  level: 'stable' | 'elevated' | 'critical';
}

/** The red line on the Sacred Timeline gauge. */
export const RED_LINE = 80;

/**
 * Deviation from a calm day, from real load only: conflicts, overdue reminders and to-dos,
 * finished timers nobody cleared, back-to-back meetings and how booked the waking window is.
 */
export function computeDeviation(input: {
  conflicts: number;
  overdueReminders: number;
  overdueTodos: number;
  finishedTimers: number;
  backToBack: number;
  bookedMinutes: number;
  windowMinutes: number;
}): DeviationReport {
  const parts: DeviationPart[] = [];
  const add = (label: string, points: number) => {
    if (points > 0) parts.push({ label, points: Math.round(points) });
  };
  add(`${input.conflicts} conflict${input.conflicts === 1 ? '' : 's'}`, Math.min(55, input.conflicts * 22));
  add(`${input.overdueReminders} overdue reminder${input.overdueReminders === 1 ? '' : 's'}`, Math.min(36, input.overdueReminders * 12));
  add(`${input.overdueTodos} overdue to-do${input.overdueTodos === 1 ? '' : 's'}`, Math.min(18, input.overdueTodos * 6));
  add(`${input.finishedTimers} finished timer${input.finishedTimers === 1 ? '' : 's'}`, Math.min(10, input.finishedTimers * 5));
  add(`${input.backToBack} back-to-back`, Math.min(21, input.backToBack * 7));
  if (input.windowMinutes > 0 && input.bookedMinutes > 0) {
    const ratio = Math.min(1, input.bookedMinutes / input.windowMinutes);
    add(`${Math.round(ratio * 100)}% booked`, ratio * 30);
  }
  const score = Math.max(0, Math.min(100, parts.reduce((sum, part) => sum + part.points, 0)));
  return { score, parts, level: score >= RED_LINE ? 'critical' : score >= 40 ? 'elevated' : 'stable' };
}

/** Waking window used for the "booked" ratio: 08:00 to 22:00, starting no earlier than now. */
export function wakingWindow(day: number, now: number): { from: number; to: number } {
  const dayStart = startOfDay(day);
  const from = Math.max(dayStart + 8 * 60 * MINUTE, Math.min(now, dayStart + 22 * 60 * MINUTE));
  const to = dayStart + 22 * 60 * MINUTE;
  return { from: Math.min(from, to), to };
}

export function overdueTodos(todos: TodoRecord[], now: number): TodoRecord[] {
  return todos.filter(todo => !todo.done && todo.dueAt !== undefined && todo.dueAt < now);
}

/** Timers that finished and were not cleared, within the last `withinMs`. */
export function finishedTimers(timers: TimerRecord[], now: number, withinMs = DAY): TimerRecord[] {
  return timers.filter(timer => timer.state === 'done' && now - (timer.firedAt ?? timer.endsAt) <= withinMs);
}

/** Day boundaries [start, end) for a day offset from today. */
export function dayRange(now: number, offsetDays = 0): { from: number; to: number } {
  const from = addDays(startOfDay(now), offsetDays);
  return { from, to: addDays(from, 1) };
}

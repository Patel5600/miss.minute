/**
 * Pure model behind the Sacred Timeline: which agenda entries a view shows, event lanes,
 * nexus events (conflicts, overdue reminders, finished timers) and the deviation gauge.
 */
import type { ScheduleItem, TimerRecord, TodoRecord } from '../store/db';
import {
  backToBack, bookedMinutes, computeDeviation, expandAgenda, finishedTimers, findOverlaps, isOverdue, overdueTodos,
  wakingWindow, type AgendaEntry, type DeviationReport,
} from '../agent/tools/agenda';
import { timerName } from '../agent/tools/timers';
import { HOUR, MINUTE, addDays, formatDuration, formatTime, formatWhen, startOfDay } from '../agent/tools/time';

export type TimelineView = 'today' | 'tomorrow' | 'week';

export interface NexusEvent {
  key: string;
  type: 'conflict' | 'overdue' | 'timer';
  /** Where the branch leaves the beam. */
  at: number;
  title: string;
  detail: string;
  /** 0..1: how far the branch reaches toward the red line (1 crosses it). */
  severity: number;
  /** Past conflicts are history: drawn faint and not counted in the gauge. */
  resolved: boolean;
  entries?: [AgendaEntry, AgendaEntry];
  item?: ScheduleItem;
  timer?: TimerRecord;
}

export interface DayModel {
  dayStart: number;
  /** Visible window on the beam. */
  from: number;
  to: number;
  isToday: boolean;
  /** Timed events, reminders and alarms. */
  entries: AgendaEntry[];
  allDay: AgendaEntry[];
  /** Event key -> lane (0 on the beam, then alternating above/below). */
  lanes: Map<string, number>;
  nexus: NexusEvent[];
  runningTimers: TimerRecord[];
  deviation: DeviationReport;
}

function assignLanes(entries: AgendaEntry[]): Map<string, number> {
  const lanes = new Map<string, number>();
  const laneEnds: number[] = [];
  const events = entries.filter(entry => entry.kind === 'event').sort((a, b) => a.start - b.start || b.end - a.end);
  for (const event of events) {
    let lane = laneEnds.findIndex(end => end <= event.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(event.end);
    } else {
      laneEnds[lane] = event.end;
    }
    lanes.set(event.key, Math.min(lane, 4));
  }
  return lanes;
}

export function buildDay(input: {
  items: ScheduleItem[];
  timers: TimerRecord[];
  todos: TodoRecord[];
  day: number;
  now: number;
}): DayModel {
  const { items, timers, todos, now } = input;
  const dayStart = startOfDay(input.day);
  const dayEnd = addDays(dayStart, 1);
  const isToday = dayStart === startOfDay(now);
  const all = expandAgenda(items, dayStart, dayEnd, now, { includeOff: true });
  const allDay = all.filter(entry => entry.allDay);
  const entries = all.filter(entry => !entry.allDay);

  const earliest = Math.min(
    ...entries.map(entry => entry.start),
    isToday ? now : Number.POSITIVE_INFINITY,
    dayStart + 6 * HOUR,
  );
  const from = Math.max(dayStart, Math.min(dayStart + 6 * HOUR, dayStart + Math.floor((earliest - dayStart) / HOUR) * HOUR));

  const nexus: NexusEvent[] = [];
  for (const conflict of findOverlaps(entries)) {
    const minutes = Math.round((conflict.end - conflict.start) / MINUTE);
    nexus.push({
      key: `conflict:${conflict.a.key}|${conflict.b.key}`,
      type: 'conflict',
      at: conflict.start,
      title: `${conflict.a.title} × ${conflict.b.title}`,
      detail: `Overlap of ${formatDuration(minutes * MINUTE)}, ${formatTime(conflict.start)} to ${formatTime(conflict.end)}`,
      severity: 1,
      resolved: conflict.end <= now,
      entries: [conflict.a, conflict.b],
    });
  }
  const finished = isToday ? finishedTimers(timers, now, 12 * HOUR) : [];
  if (isToday) {
    for (const item of items.filter(candidate => isOverdue(candidate, now))) {
      const hours = (now - item.startAt) / HOUR;
      nexus.push({
        key: `overdue:${item.id}`,
        type: 'overdue',
        at: Math.max(from, item.startAt),
        title: item.title,
        detail: `Overdue since ${formatWhen(item.startAt, now)}`,
        severity: Math.min(1, 0.55 + hours / 12),
        resolved: false,
        item,
      });
    }
    for (const timer of finished) {
      nexus.push({
        key: `timer:${timer.id}`,
        type: 'timer',
        at: Math.max(from, timer.endsAt),
        title: timerName(timer),
        detail: `Finished at ${formatTime(timer.endsAt)}`,
        severity: 0.65,
        resolved: false,
        timer,
      });
    }
  }
  nexus.sort((a, b) => a.at - b.at);

  // Load: for today only what is still ahead counts; other days count in full.
  const window = isToday ? wakingWindow(dayStart, now) : wakingWindow(dayStart, dayStart);
  const ahead = isToday ? entries.filter(entry => entry.end > now || entry.start > now) : entries;
  const liveConflicts = nexus.filter(event => event.type === 'conflict' && !event.resolved).length;
  const deviation = computeDeviation({
    conflicts: liveConflicts,
    overdueReminders: nexus.filter(event => event.type === 'overdue').length,
    overdueTodos: isToday ? overdueTodos(todos, now).length : 0,
    finishedTimers: finished.length,
    backToBack: backToBack(ahead).length,
    bookedMinutes: bookedMinutes(ahead, window.from, window.to),
    windowMinutes: Math.max(0, (window.to - window.from) / MINUTE),
  });

  return {
    dayStart,
    from,
    to: dayEnd,
    isToday,
    entries,
    allDay,
    lanes: assignLanes(entries),
    nexus,
    runningTimers: isToday ? timers.filter(timer => timer.state === 'running' && timer.endsAt <= dayEnd) : [],
    deviation,
  };
}

export function buildView(input: {
  view: TimelineView;
  items: ScheduleItem[];
  timers: TimerRecord[];
  todos: TodoRecord[];
  now: number;
}): { days: DayModel[]; deviation: DeviationReport; peakDay: number } {
  const count = input.view === 'week' ? 7 : 1;
  const offset = input.view === 'tomorrow' ? 1 : 0;
  const today = startOfDay(input.now);
  const days = Array.from({ length: count }, (_, index) =>
    buildDay({ items: input.items, timers: input.timers, todos: input.todos, day: addDays(today, offset + index), now: input.now }));
  let peak = days[0];
  for (const day of days) if (day.deviation.score > peak.deviation.score) peak = day;
  return { days, deviation: peak.deviation, peakDay: peak.dayStart };
}

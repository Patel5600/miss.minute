/**
 * The owner's schedule: alarms, reminders and events, with conflict detection. Domain
 * functions are exported for the panels; the tools wrap them with strict argument parsing.
 */
import { deleteRecord, getRecord, listAll, newId, putRecord, type Recurrence, type ScheduleItem, type ScheduleKind } from '../../store/db';
import { primeNotifications } from '../notify';
import {
  ToolInputError, clip, optionalBoolean, optionalEnum, optionalNumber, optionalText, requiredText, type RawArgs,
} from './args';
import {
  RECURRENCES, backToBack, expandAgenda, findOverlaps, isOverdue, nextFireAt, nextOccurrenceAfter, type AgendaEntry,
} from './agenda';
import { makeTool } from './define';
import { findRecord } from './lookup';
import {
  DAY, MINUTE, addDays, clock24, formatDay, formatDayRelative, formatDuration, formatTime, formatWhen, isWeekend,
  localDate, localIso, nextClockTime, parseClock, parseDateTime, startOfDay, type ParsedDateTime,
} from './time';

export const KIND_LABEL: Record<ScheduleKind, string> = { event: 'event', reminder: 'reminder', alarm: 'alarm' };
export const EVENT_DEFAULT_MS = 60 * MINUTE;
const MAX_EVENT_MS = 31 * DAY;
const MAX_TITLE = 200;
const MAX_NOTES = 2000;

export type AlarmDays = 'once' | 'daily' | 'weekdays' | 'weekly';
export const ALARM_DAYS: readonly AlarmDays[] = ['once', 'daily', 'weekdays', 'weekly'];

const ALARM_RECURRENCE: Record<AlarmDays, Recurrence> = { once: 'none', daily: 'daily', weekdays: 'weekdays', weekly: 'weekly' };

export function recurrenceText(recurrence: Recurrence, anchor?: number): string {
  switch (recurrence) {
    case 'daily': return 'every day';
    case 'weekdays': return 'on weekdays';
    case 'weekly': return anchor === undefined ? 'every week' : `every ${new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(anchor)}`;
    case 'monthly': return anchor === undefined ? 'every month' : `monthly on day ${new Date(anchor).getDate()}`;
    default: return 'once';
  }
}

function checkTitle(title: string): string {
  const clean = title.replace(/\s+/g, ' ').trim();
  if (!clean) throw new ToolInputError('A title is required.');
  if (clean.length > MAX_TITLE) throw new ToolInputError(`The title is too long (limit ${MAX_TITLE} characters).`);
  return clean;
}

function cleanOptional(text: string | undefined, max: number): string | undefined {
  const clean = text?.trim();
  if (!clean) return undefined;
  if (clean.length > max) throw new ToolInputError(`Text is too long (limit ${max} characters).`);
  return clean;
}

/** Next time an alarm at hour:minute with this repeat rule rings, strictly after `after`. */
export function nextAlarmTime(hour: number, minute: number, recurrence: Recurrence, after: number): number {
  let at = nextClockTime(hour, minute, after);
  if (recurrence === 'weekdays') {
    for (let guard = 0; guard < 7 && isWeekend(at); guard += 1) at = nextClockTime(hour, minute, at);
  }
  return at;
}

// ── Domain functions (used by tools and panels) ──────────────────────────────────────────

export async function createReminder(input: {
  title: string; at: number; recurrence?: Recurrence; notes?: string; source?: ScheduleItem['source'];
}, now = Date.now()): Promise<{ item: ScheduleItem; existing: boolean; rolled: boolean }> {
  const title = checkTitle(input.title);
  const recurrence = input.recurrence ?? 'none';
  let at = input.at;
  let rolled = false;
  if (at <= now) {
    if (recurrence === 'none') {
      throw new ToolInputError(`That time (${formatWhen(at, now)}) has already passed; it is now ${formatTime(now)}. Pick a future time.`);
    }
    at = nextOccurrenceAfter(at, recurrence, now) ?? at;
    rolled = true;
  }
  const all = await listAll('schedule');
  const duplicate = all.find(item => item.kind === 'reminder' && !item.done
    && item.title.toLowerCase() === title.toLowerCase() && Math.abs(item.startAt - at) < MINUTE);
  if (duplicate) return { item: duplicate, existing: true, rolled };
  const item: ScheduleItem = {
    id: newId(), kind: 'reminder', title, notes: cleanOptional(input.notes, MAX_NOTES), startAt: at, recurrence,
    done: false, createdAt: now, updatedAt: now, source: input.source ?? 'chat',
  };
  await putRecord('schedule', item);
  void primeNotifications();
  return { item, existing: false, rolled };
}

export async function createEvent(input: {
  title: string; start: number; end?: number; allDay?: boolean; location?: string; notes?: string;
  recurrence?: Recurrence; source?: ScheduleItem['source'];
}, now = Date.now()): Promise<{ item: ScheduleItem; existing: boolean; conflicts: AgendaEntry[] }> {
  const title = checkTitle(input.title);
  const allDay = input.allDay ?? false;
  const startAt = allDay ? startOfDay(input.start) : input.start;
  let endAt: number;
  if (allDay) {
    endAt = input.end !== undefined ? Math.max(startAt + DAY, input.end) : startAt + DAY;
  } else {
    endAt = input.end ?? startAt + EVENT_DEFAULT_MS;
    if (endAt <= startAt) throw new ToolInputError(`The end (${formatWhen(endAt, now)}) must be after the start (${formatWhen(startAt, now)}).`);
  }
  if (endAt - startAt > MAX_EVENT_MS) throw new ToolInputError('Events can last at most 31 days.');
  const all = await listAll('schedule');
  const duplicate = all.find(item => item.kind === 'event' && item.startAt === startAt
    && item.title.toLowerCase() === title.toLowerCase());
  const item: ScheduleItem = duplicate ?? {
    id: newId(), kind: 'event', title, startAt, endAt, allDay: allDay || undefined,
    location: cleanOptional(input.location, 200), notes: cleanOptional(input.notes, MAX_NOTES),
    recurrence: input.recurrence ?? 'none', done: false, createdAt: now, updatedAt: now, source: input.source ?? 'chat',
  };
  if (!duplicate) await putRecord('schedule', item);
  return { item, existing: Boolean(duplicate), conflicts: allDay ? [] : await conflictsWith(item, now) };
}

/** Other timed events overlapping the first occurrence of `item`. */
async function conflictsWith(item: ScheduleItem, now: number): Promise<AgendaEntry[]> {
  const end = item.endAt ?? item.startAt;
  const others = (await listAll('schedule')).filter(other => other.kind === 'event' && other.id !== item.id);
  return expandAgenda(others, item.startAt, end, now).filter(entry => !entry.allDay && entry.status !== 'done' && entry.end > item.startAt && entry.start < end);
}

export async function createAlarm(input: {
  hour: number; minute: number; label?: string; days?: AlarmDays; source?: ScheduleItem['source'];
}, now = Date.now()): Promise<{ item: ScheduleItem; existing: boolean }> {
  const recurrence = ALARM_RECURRENCE[input.days ?? 'once'];
  const label = cleanOptional(input.label, 80);
  const all = await listAll('schedule');
  const sameTime = all.find(item => item.kind === 'alarm' && item.recurrence === recurrence
    && clock24(item.startAt) === `${String(input.hour).padStart(2, '0')}:${String(input.minute).padStart(2, '0')}`
    && (!label || item.title.toLowerCase() === label.toLowerCase()));
  const startAt = nextAlarmTime(input.hour, input.minute, recurrence, now);
  if (sameTime && !sameTime.done) return { item: sameTime, existing: true };
  const item: ScheduleItem = sameTime
    ? { ...sameTime, done: false, startAt, snoozedUntil: undefined, updatedAt: now }
    : {
        id: newId(), kind: 'alarm', title: label ?? 'Alarm', startAt, recurrence, done: false,
        createdAt: now, updatedAt: now, source: input.source ?? 'chat',
      };
  await putRecord('schedule', item);
  void primeNotifications();
  return { item, existing: false };
}

async function loadItem(id: string): Promise<ScheduleItem> {
  const item = await getRecord('schedule', id);
  if (!item) throw new ToolInputError('That schedule item no longer exists.');
  return item;
}

/** Re-arms an alarm or repeating reminder whose due time has passed. */
function rearm(item: ScheduleItem, now: number): number {
  if (item.startAt > now) return item.startAt;
  if (item.kind === 'alarm') {
    const d = new Date(item.startAt);
    return nextAlarmTime(d.getHours(), d.getMinutes(), item.recurrence, now);
  }
  return nextOccurrenceAfter(item.startAt, item.recurrence, now) ?? item.startAt;
}

/**
 * done=true: events and one-off reminders are completed; alarms switch off; repeating reminders
 * stop repeating. done=false re-opens, re-arming alarms and repeating reminders for their next time.
 */
export function applyDone(item: ScheduleItem, done: boolean, now: number): ScheduleItem {
  if (done) return { ...item, done: true, snoozedUntil: undefined, updatedAt: now };
  const reopened: ScheduleItem = { ...item, done: false, snoozedUntil: undefined, updatedAt: now };
  if (item.kind === 'alarm' || (item.kind === 'reminder' && item.recurrence !== 'none')) reopened.startAt = rearm(item, now);
  return reopened;
}

export async function setScheduleDone(id: string, done: boolean): Promise<ScheduleItem> {
  const item = await loadItem(id);
  return putRecord('schedule', applyDone(item, done, Date.now()));
}

export function applySnooze(item: ScheduleItem, minutes: number, now: number): ScheduleItem {
  if (item.kind === 'event') throw new ToolInputError('Events cannot be snoozed. Change the start time instead.');
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) throw new ToolInputError('Snooze between 1 and 1440 minutes.');
  const pending = item.done ? undefined : nextFireAt(item);
  const base = pending !== undefined && pending > now ? pending : now;
  return { ...item, done: false, snoozedUntil: base + Math.round(minutes) * MINUTE, updatedAt: now };
}

export async function snoozeScheduleItem(id: string, minutes: number): Promise<ScheduleItem> {
  const item = await loadItem(id);
  return putRecord('schedule', applySnooze(item, minutes, Date.now()));
}

/** Skips the next occurrence of a repeating reminder or alarm. */
export async function skipNextOccurrence(id: string): Promise<ScheduleItem> {
  const item = await loadItem(id);
  if (item.kind === 'event' || item.recurrence === 'none') throw new ToolInputError('Only repeating reminders and alarms can skip a time.');
  const now = Date.now();
  const current = Math.max(item.startAt, now);
  const next = nextOccurrenceAfter(item.startAt, item.recurrence, current) ?? item.startAt;
  return putRecord('schedule', { ...item, startAt: next, snoozedUntil: undefined, done: false, updatedAt: now });
}

export async function setAlarmEnabled(id: string, enabled: boolean): Promise<ScheduleItem> {
  const item = await loadItem(id);
  if (item.kind !== 'alarm') throw new ToolInputError('That item is not an alarm.');
  return putRecord('schedule', applyDone(item, !enabled, Date.now()));
}

export async function deleteScheduleItem(id: string): Promise<void> {
  await deleteRecord('schedule', id);
}

export interface SchedulePatch {
  title?: string;
  start?: ParsedDateTime;
  end?: ParsedDateTime;
  done?: boolean;
  snoozeMinutes?: number;
}

/** Applies a patch with the same rules as the tools. Returns the saved item and what changed. */
export async function updateScheduleItem(id: string, patch: SchedulePatch, now = Date.now()): Promise<{ item: ScheduleItem; changes: string[] }> {
  let item = await loadItem(id);
  const changes: string[] = [];
  if (patch.title !== undefined) {
    item = { ...item, title: checkTitle(patch.title) };
    changes.push(`renamed to "${item.title}"`);
  }
  if (patch.end !== undefined && item.kind !== 'event') throw new ToolInputError("Only events have an 'end'.");
  if (patch.start !== undefined) {
    const start = patch.start;
    if (item.kind === 'event') {
      const length = Math.max(0, (item.endAt ?? item.startAt) - item.startAt);
      if (start.dateOnly) {
        const startAt = startOfDay(start.ms);
        item = { ...item, startAt, endAt: startAt + (item.allDay ? Math.max(DAY, length) : DAY), allDay: true };
      } else {
        item = { ...item, startAt: start.ms, endAt: start.ms + (item.allDay ? EVENT_DEFAULT_MS : length || EVENT_DEFAULT_MS), allDay: undefined };
      }
      item.lastFiredAt = undefined;
      changes.push(`moved to ${item.allDay ? formatDay(item.startAt, now) : formatWhen(item.startAt, now)}`);
    } else {
      if (start.dateOnly) throw new ToolInputError(`A ${item.kind} needs a time of day, e.g. "${localDate(start.ms)}T09:00".`);
      if (start.ms <= now) {
        throw new ToolInputError(`That time (${formatWhen(start.ms, now)}) has already passed; it is now ${formatTime(now)}.`);
      }
      item = { ...item, startAt: start.ms, snoozedUntil: undefined, done: false };
      changes.push(`now ${formatWhen(item.startAt, now)}`);
    }
  }
  if (patch.end !== undefined) {
    const end = patch.end;
    let endAt: number;
    if (item.allDay) {
      if (!end.dateOnly) throw new ToolInputError(`This is an all-day event; give 'end' as a date like "${localDate(item.startAt)}".`);
      endAt = addDays(startOfDay(end.ms), 1);
    } else {
      if (end.dateOnly) throw new ToolInputError(`Give 'end' with a time, e.g. "${localDate(item.startAt)}T${clock24(item.startAt + EVENT_DEFAULT_MS)}".`);
      endAt = end.ms;
    }
    if (endAt <= item.startAt) throw new ToolInputError(`The end must be after the start (${formatWhen(item.startAt, now)}).`);
    if (endAt - item.startAt > MAX_EVENT_MS) throw new ToolInputError('Events can last at most 31 days.');
    item = { ...item, endAt };
    changes.push(item.allDay ? `ends ${formatDay(endAt - 1, now)}` : `ends ${formatTime(endAt)}`);
  }
  if (patch.done !== undefined) {
    item = applyDone(item, patch.done, now);
    if (patch.done) {
      changes.push(item.kind === 'alarm' ? 'switched off' : item.recurrence !== 'none' && item.kind === 'reminder' ? 'stopped repeating' : 'marked done');
    } else {
      changes.push(item.kind === 'alarm' ? `switched on (next ${formatWhen(item.startAt, now)})` : 're-opened');
    }
  }
  if (patch.snoozeMinutes !== undefined) {
    item = applySnooze(item, patch.snoozeMinutes, now);
    changes.push(`snoozed until ${formatWhen(item.snoozedUntil ?? now, now)}`);
  }
  if (changes.length === 0) throw new ToolInputError('Nothing to change. Pass title, start, end, done or snooze_minutes.');
  item = { ...item, updatedAt: now };
  await putRecord('schedule', item);
  return { item, changes };
}

// ── Model views ──────────────────────────────────────────────────────────────────────────

function entryView(entry: AgendaEntry) {
  return {
    id: entry.id,
    kind: entry.kind,
    title: clip(entry.title, 120),
    start: entry.allDay ? localDate(entry.start) : localIso(entry.start),
    ...(entry.kind === 'event' && !entry.allDay ? { end: localIso(entry.end) } : {}),
    ...(entry.allDay ? { all_day: true, last_day: localDate(entry.end - 1) } : {}),
    ...(entry.location ? { location: clip(entry.location, 80) } : {}),
    ...(entry.recurrence !== 'none' ? { repeats: entry.recurrence } : {}),
    ...(entry.status !== 'upcoming' ? { status: entry.status } : {}),
    ...(entry.notes ? { notes: clip(entry.notes, 100) } : {}),
  };
}

function itemView(item: ScheduleItem, now: number) {
  return {
    id: item.id,
    kind: item.kind,
    title: clip(item.title, 120),
    start: item.allDay ? localDate(item.startAt) : localIso(item.startAt),
    ...(item.kind === 'event' && item.endAt !== undefined ? { end: item.allDay ? localDate(item.endAt - 1) : localIso(item.endAt) } : {}),
    ...(item.allDay ? { all_day: true } : {}),
    ...(item.location ? { location: item.location } : {}),
    ...(item.recurrence !== 'none' ? { repeats: item.recurrence } : {}),
    ...(item.snoozedUntil !== undefined && item.snoozedUntil > now ? { snoozed_until: localIso(item.snoozedUntil) } : {}),
    ...(item.kind === 'alarm' ? { enabled: !item.done } : { done: item.done }),
    ...(isOverdue(item, now) ? { overdue: true } : {}),
  };
}

function entryText(entry: AgendaEntry, now: number): string {
  if (entry.allDay) return `"${entry.title}" (${formatDay(entry.start, now)}, all day)`;
  if (entry.kind === 'event') return `"${entry.title}" ${formatTime(entry.start)}-${formatTime(entry.end)}`;
  return `"${entry.title}" ${formatTime(entry.start)}`;
}

// ── Argument parsing helpers ─────────────────────────────────────────────────────────────

function optionalDateTime(args: RawArgs, key: string, now: number): ParsedDateTime | undefined {
  return args[key] === undefined || args[key] === '' ? undefined : parseDateTime(args[key], key, now);
}

function requiredDateTime(args: RawArgs, key: string, now: number): ParsedDateTime {
  if (args[key] === undefined || args[key] === '') throw new ToolInputError(`'${key}' is required (ISO 8601 local time).`);
  return parseDateTime(args[key], key, now);
}

const RECURRENCE_SCHEMA = {
  type: 'string' as const,
  enum: [...RECURRENCES],
  description: 'Repeat rule. Default none.',
};

// ── Tools ────────────────────────────────────────────────────────────────────────────────

interface AlarmArgs { hour: number; minute: number; label?: string; days: AlarmDays }
interface ReminderArgs { title: string; at: ParsedDateTime; recurrence: Recurrence; notes?: string }
interface EventArgs { title: string; start: ParsedDateTime; end?: ParsedDateTime; location?: string; notes?: string; recurrence: Recurrence }
interface ListArgs { from: number; to: number; kind: ScheduleKind | 'all' }
interface UpdateArgs { id: string; patch: SchedulePatch }
interface IdArgs { id: string }
interface ConflictArgs { day: number }

async function findItem(id: string): Promise<ScheduleItem> {
  return findRecord('schedule', id, { noun: 'schedule item', listTool: 'list_schedule', nameOf: item => item.title });
}

export const scheduleTools = [
  makeTool<AlarmArgs>({
    name: 'set_alarm',
    description:
      'Sets an alarm clock for a time of day (24-hour "HH:MM"). It rings with a chime, a notification and her voice. '
      + 'days: once (default; the next time that clock time comes round), daily, weekdays (Mon-Fri) or weekly (same weekday '
      + 'as the first ring). Setting the same time again re-enables the existing alarm instead of duplicating it.',
    parameters: {
      type: 'object',
      properties: {
        time: { type: 'string', description: '24-hour local time "HH:MM", e.g. "06:45".' },
        label: { type: 'string', description: 'What the alarm is for, e.g. "Gym".' },
        days: { type: 'string', enum: [...ALARM_DAYS], description: 'Repeat rule. Default once.' },
      },
      required: ['time'],
    },
    policy: 'auto',
    failure: "Couldn't set the alarm",
    parse(args) {
      const { hour, minute } = parseClock(args.time, 'time');
      return { hour, minute, label: optionalText(args, 'label', 80), days: optionalEnum(args, 'days', ALARM_DAYS) ?? 'once' };
    },
    describe(args) {
      const time = `${String(args.hour).padStart(2, '0')}:${String(args.minute).padStart(2, '0')}`;
      return `Set an alarm for ${time}${args.days === 'once' ? '' : ` (${args.days})`}${args.label ? `: ${args.label}` : ''}`;
    },
    async run(args) {
      const now = Date.now();
      const { item, existing } = await createAlarm({ hour: args.hour, minute: args.minute, label: args.label, days: args.days }, now);
      const repeat = item.recurrence === 'none' ? '' : ` ${recurrenceText(item.recurrence, item.startAt)}`;
      const summary = existing
        ? `An alarm for ${formatTime(item.startAt)}${repeat} already exists (next ${formatWhen(item.startAt, now)})`
        : `Alarm set for ${formatTime(item.startAt)}${repeat}${item.title !== 'Alarm' ? ` (${item.title})` : ''}: rings ${formatWhen(item.startAt, now)}, in ${formatDuration(item.startAt - now)}`;
      return { ok: true, summary, data: { ...itemView(item, now), already_existed: existing || undefined } };
    },
  }),

  makeTool<ReminderArgs>({
    name: 'add_reminder',
    description:
      'Schedules a reminder that fires at a specific local date-time with a chime, a notification and her voice. '
      + "'at' must be ISO 8601 local time in the future, e.g. \"2026-11-02T09:30\". Repeating reminders whose first time "
      + 'already passed start at the next repeat. For a countdown use set_timer; for a wake-up use set_alarm.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What to remind about, phrased for the owner, e.g. "Call Mom".' },
        at: { type: 'string', description: 'ISO 8601 local date-time, e.g. "2026-11-02T09:30".' },
        recurrence: RECURRENCE_SCHEMA,
        notes: { type: 'string', description: 'Optional details.' },
      },
      required: ['title', 'at'],
    },
    policy: 'auto',
    failure: "Couldn't add the reminder",
    parse(args) {
      const now = Date.now();
      const at = requiredDateTime(args, 'at', now);
      if (at.dateOnly) throw new ToolInputError(`'at' needs a time of day too, e.g. "${localDate(at.ms)}T09:00".`);
      return {
        title: requiredText(args, 'title', MAX_TITLE),
        at,
        recurrence: optionalEnum(args, 'recurrence', RECURRENCES) ?? 'none',
        notes: optionalText(args, 'notes', MAX_NOTES, { multiline: true }),
      };
    },
    describe(args) {
      return `Remind "${args.title}" ${formatWhen(args.at.ms)}${args.recurrence === 'none' ? '' : ` (${recurrenceText(args.recurrence, args.at.ms)})`}`;
    },
    async run(args) {
      const now = Date.now();
      const { item, existing, rolled } = await createReminder({ title: args.title, at: args.at.ms, recurrence: args.recurrence, notes: args.notes }, now);
      const repeat = item.recurrence === 'none' ? '' : `, ${recurrenceText(item.recurrence, item.startAt)}`;
      const summary = existing
        ? `Already reminding "${item.title}" ${formatWhen(item.startAt, now)}`
        : `Reminder set: "${item.title}" ${formatWhen(item.startAt, now)}${repeat}${rolled ? ' (first time had passed, so it starts at the next repeat)' : ''}`;
      return { ok: true, summary, data: { ...itemView(item, now), already_existed: existing || undefined } };
    },
  }),

  makeTool<EventArgs>({
    name: 'add_event',
    description:
      'Adds an event to the owner\'s calendar. start/end are ISO 8601 local date-times ("2026-11-03T15:00"); a date '
      + 'alone ("2026-11-05") makes an all-day event (end date inclusive). Without end, timed events last 1 hour. '
      + 'Returns any overlapping events so you can warn the owner about conflicts.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Event name.' },
        start: { type: 'string', description: 'ISO 8601 local date-time, or a date for all-day.' },
        end: { type: 'string', description: 'ISO 8601 local date-time (or date for all-day). Optional.' },
        location: { type: 'string', description: 'Where it happens.' },
        notes: { type: 'string', description: 'Optional details.' },
        recurrence: RECURRENCE_SCHEMA,
      },
      required: ['title', 'start'],
    },
    policy: 'auto',
    failure: "Couldn't add the event",
    parse(args) {
      const now = Date.now();
      const start = requiredDateTime(args, 'start', now);
      const end = optionalDateTime(args, 'end', now);
      if (end && end.dateOnly !== start.dateOnly) {
        throw new ToolInputError(start.dateOnly
          ? "For an all-day event give 'end' as a date too (inclusive), or give 'start' a time."
          : `Give 'end' with a time, e.g. "${localDate(start.ms)}T${clock24(start.ms + EVENT_DEFAULT_MS)}".`);
      }
      return {
        title: requiredText(args, 'title', MAX_TITLE),
        start,
        end,
        location: optionalText(args, 'location', 200),
        notes: optionalText(args, 'notes', MAX_NOTES, { multiline: true }),
        recurrence: optionalEnum(args, 'recurrence', RECURRENCES) ?? 'none',
      };
    },
    describe(args) {
      if (args.start.dateOnly) return `Add all-day event "${args.title}" on ${formatDay(args.start.ms)}`;
      const end = args.end?.ms ?? args.start.ms + EVENT_DEFAULT_MS;
      return `Add "${args.title}" ${formatWhen(args.start.ms)}-${formatTime(end)}`;
    },
    async run(args) {
      const now = Date.now();
      const allDay = args.start.dateOnly;
      const end = args.end ? (allDay ? addDays(startOfDay(args.end.ms), 1) : args.end.ms) : undefined;
      const { item, existing, conflicts } = await createEvent({
        title: args.title, start: args.start.ms, end, allDay, location: args.location, notes: args.notes, recurrence: args.recurrence,
      }, now);
      const when = item.allDay
        ? `${formatDay(item.startAt, now)}${(item.endAt ?? 0) - item.startAt > DAY ? ` to ${formatDay((item.endAt ?? item.startAt) - 1, now)}` : ''} (all day)`
        : `${formatWhen(item.startAt, now)}-${formatTime(item.endAt ?? item.startAt)}${args.end ? '' : ' (1 h default)'}`;
      const repeat = item.recurrence === 'none' ? '' : `, ${recurrenceText(item.recurrence, item.startAt)}`;
      const clash = conflicts.length > 0 ? `; overlaps ${conflicts.slice(0, 3).map(entry => entryText(entry, now)).join(', ')}` : '';
      const summary = existing ? `"${item.title}" is already on the calendar ${when}` : `Added "${item.title}" ${when}${repeat}${clash}`;
      return {
        ok: true,
        summary,
        data: {
          ...itemView(item, now),
          ...(existing ? { already_existed: true } : {}),
          conflicts: conflicts.slice(0, 5).map(entryView),
        },
      };
    },
  }),

  makeTool<ListArgs>({
    name: 'list_schedule',
    description:
      'Lists events, reminders and alarms between two local times, expanding repeats. Defaults to today through '
      + 'the next 7 days. from/to accept a date ("2026-11-02", whole day) or a date-time. Overdue reminders are '
      + 'always included. Use the returned ids with update_schedule_item or delete_schedule_item.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start (ISO 8601 local date or date-time). Default: start of today.' },
        to: { type: 'string', description: 'End (date = through the end of that day). Default: 7 days after from.' },
        kind: { type: 'string', enum: ['event', 'reminder', 'alarm', 'all'], description: 'Filter. Default all.' },
      },
    },
    policy: 'auto',
    failure: "Couldn't read the schedule",
    parse(args) {
      const now = Date.now();
      const from = optionalDateTime(args, 'from', now);
      const to = optionalDateTime(args, 'to', now);
      const fromMs = from ? (from.dateOnly ? startOfDay(from.ms) : from.ms) : startOfDay(now);
      const toMs = to ? (to.dateOnly ? addDays(startOfDay(to.ms), 1) : to.ms) : addDays(startOfDay(fromMs), 7);
      if (toMs <= fromMs) throw new ToolInputError("'to' must be after 'from'.");
      if (toMs - fromMs > 92 * DAY) throw new ToolInputError('List at most 92 days at a time.');
      return {
        from: fromMs,
        to: toMs,
        kind: optionalEnum(args, 'kind', ['event', 'reminder', 'alarm', 'all'] as const) ?? 'all',
      };
    },
    describe(args) {
      return `List ${args.kind === 'all' ? 'the schedule' : `${args.kind}s`} from ${formatDay(args.from)} to ${formatDay(args.to - 1)}`;
    },
    async run(args) {
      const now = Date.now();
      const items = await listAll('schedule');
      const kinds = args.kind === 'all' ? undefined : [args.kind];
      const entries = expandAgenda(items, args.from, args.to, now, { kinds, includeOff: args.kind === 'alarm' });
      const overdue = args.from <= now
        ? items.filter(item => isOverdue(item, now) && item.startAt < args.from && (!kinds || kinds.includes(item.kind)))
        : [];
      const limit = 60;
      const shown = entries.slice(0, limit);
      const range = `${formatDay(args.from, now)} to ${formatDay(args.to - 1, now)}`;
      const parts = [`${entries.length} item${entries.length === 1 ? '' : 's'} ${range}`];
      if (overdue.length > 0) parts.push(`${overdue.length} overdue`);
      return {
        ok: true,
        summary: parts.join(', '),
        data: {
          from: localIso(args.from),
          to: localIso(args.to),
          items: shown.map(entryView),
          ...(entries.length > limit ? { truncated: entries.length - limit } : {}),
          ...(overdue.length > 0 ? { overdue: overdue.slice(0, 10).map(item => itemView(item, now)) } : {}),
        },
      };
    },
  }),

  makeTool<UpdateArgs>({
    name: 'update_schedule_item',
    description:
      'Changes an event, reminder or alarm by id: rename, move (start), change an event\'s end, mark done, or snooze. '
      + 'done=true completes an event or one-off reminder, switches an alarm off, and stops a repeating reminder; '
      + 'done=false re-opens it. snooze_minutes pushes a reminder or alarm back (from now, or from its due time if '
      + 'that is later). Moving an event keeps its length.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Item id from list_schedule.' },
        title: { type: 'string', description: 'New title.' },
        start: { type: 'string', description: 'New start / due time, ISO 8601 local.' },
        end: { type: 'string', description: 'Events only: new end, ISO 8601 local.' },
        done: { type: 'boolean', description: 'Mark done (true) or re-open (false).' },
        snooze_minutes: { type: 'integer', minimum: 1, maximum: 1440, description: 'Reminders/alarms: snooze by this many minutes.' },
      },
      required: ['id'],
    },
    policy: 'auto',
    failure: "Couldn't update the schedule",
    parse(args) {
      const now = Date.now();
      const patch: SchedulePatch = {
        title: optionalText(args, 'title', MAX_TITLE),
        start: optionalDateTime(args, 'start', now),
        end: optionalDateTime(args, 'end', now),
        done: optionalBoolean(args, 'done'),
        snoozeMinutes: optionalNumber(args, 'snooze_minutes', { min: 1, max: 1440, round: true, unit: 'minutes' }),
      };
      if (Object.values(patch).every(value => value === undefined)) {
        throw new ToolInputError('Nothing to change. Pass title, start, end, done or snooze_minutes.');
      }
      return { id: requiredText(args, 'id', 80), patch };
    },
    describe(args) {
      const parts: string[] = [];
      if (args.patch.title) parts.push(`rename to "${args.patch.title}"`);
      if (args.patch.start) parts.push(`move to ${args.patch.start.dateOnly ? formatDay(args.patch.start.ms) : formatWhen(args.patch.start.ms)}`);
      if (args.patch.end) parts.push(`end ${args.patch.end.dateOnly ? formatDay(args.patch.end.ms) : formatTime(args.patch.end.ms)}`);
      if (args.patch.done !== undefined) parts.push(args.patch.done ? 'mark done' : 're-open');
      if (args.patch.snoozeMinutes) parts.push(`snooze ${args.patch.snoozeMinutes} min`);
      return `Update schedule item ${args.id}: ${parts.join(', ')}`;
    },
    async run(args) {
      const now = Date.now();
      const target = await findItem(args.id);
      const { item, changes } = await updateScheduleItem(target.id, args.patch, now);
      return { ok: true, summary: `"${item.title}": ${changes.join(', ')}`, data: itemView(item, now) };
    },
  }),

  makeTool<IdArgs>({
    name: 'delete_schedule_item',
    description: 'Deletes an event, reminder or alarm by id (a repeating item is deleted with all its repeats). Asks the owner first.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Item id from list_schedule.' } },
      required: ['id'],
    },
    policy: 'confirm',
    failure: "Couldn't delete the item",
    parse(args) {
      return { id: requiredText(args, 'id', 80) };
    },
    describe(args) {
      return `Delete schedule item ${args.id}`;
    },
    async prepare(args) {
      const item = await findItem(args.id);
      const now = Date.now();
      const when = item.allDay ? formatDay(item.startAt, now) : formatWhen(item.startAt, now);
      const repeat = item.recurrence === 'none' ? '' : ` and all its repeats (${recurrenceText(item.recurrence, item.startAt)})`;
      return { text: `Delete the ${KIND_LABEL[item.kind]} "${item.title}" (${when})${repeat}.`, risk: 'low', token: item.id };
    },
    async run(args, _ctx, prepared) {
      const id = prepared?.token ?? (await findItem(args.id)).id;
      const item = await getRecord('schedule', id);
      if (!item) return { ok: true, summary: 'That item was already gone', data: { id, deleted: false } };
      await deleteScheduleItem(id);
      return { ok: true, summary: `Deleted the ${KIND_LABEL[item.kind]} "${item.title}"`, data: { id, deleted: true } };
    },
  }),

  makeTool<ConflictArgs>({
    name: 'find_conflicts',
    description:
      'Checks one day for overlapping events and back-to-back runs (less than 10 minutes between). '
      + "date is YYYY-MM-DD in local time; default today.",
    parameters: {
      type: 'object',
      properties: { date: { type: 'string', description: 'Local date "YYYY-MM-DD". Default today.' } },
    },
    policy: 'auto',
    failure: "Couldn't check for conflicts",
    parse(args) {
      const now = Date.now();
      const parsed = optionalDateTime(args, 'date', now);
      return { day: startOfDay(parsed ? parsed.ms : now) };
    },
    describe(args) {
      return `Check ${formatDayRelative(args.day)} for conflicts`;
    },
    async run(args) {
      const now = Date.now();
      const entries = expandAgenda(await listAll('schedule'), args.day, addDays(args.day, 1), now, { kinds: ['event'] });
      const conflicts = findOverlaps(entries);
      const tight = backToBack(entries);
      const dayText = formatDayRelative(args.day, now);
      const summary = conflicts.length === 0
        ? `No conflicts ${dayText}${tight.length > 0 ? ` (${tight.length} back-to-back)` : ''}`
        : `${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'} ${dayText}: ${conflicts.slice(0, 3)
          .map(conflict => `"${conflict.a.title}" overlaps "${conflict.b.title}" by ${formatDuration(conflict.end - conflict.start)}`).join('; ')}`;
      return {
        ok: true,
        summary,
        data: {
          date: localDate(args.day),
          events: entries.length,
          conflicts: conflicts.slice(0, 10).map(conflict => ({
            first: entryView(conflict.a),
            second: entryView(conflict.b),
            overlap_minutes: Math.round((conflict.end - conflict.start) / MINUTE),
          })),
          back_to_back: tight.slice(0, 10).map(pair => ({
            first: pair.first.title, second: pair.second.title, gap_minutes: Math.round(pair.gap / MINUTE),
          })),
        },
      };
    },
  }),
];

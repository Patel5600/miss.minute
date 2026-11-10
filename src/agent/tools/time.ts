/**
 * Local date/time parsing and formatting shared by tools, the scheduler, the model context and
 * the panels. The model speaks ISO 8601 in the owner's local time; the owner reads locale text.
 */
import { ToolInputError } from './args';

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** "+05:30" for a minutes-east-of-UTC offset. */
export function formatOffset(minutesEast: number): string {
  const sign = minutesEast < 0 ? '-' : '+';
  const absolute = Math.abs(Math.round(minutesEast));
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

export function localOffsetMinutes(ms: number): number {
  return -new Date(ms).getTimezoneOffset();
}

export function weekdayName(ms: number): string {
  return WEEKDAYS[new Date(ms).getDay()];
}

export function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Calendar-day arithmetic that keeps the wall-clock time across DST changes. */
export function addDays(ms: number, days: number): number {
  const date = new Date(ms);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

export function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

/** Whole calendar days from a's date to b's date (local), ignoring time of day. */
export function calendarDaysBetween(a: number, b: number): number {
  const da = new Date(a);
  const db = new Date(b);
  return Math.round(
    (Date.UTC(db.getFullYear(), db.getMonth(), db.getDate()) - Date.UTC(da.getFullYear(), da.getMonth(), da.getDate())) / DAY,
  );
}

export function isSameDay(a: number, b: number): boolean {
  return calendarDaysBetween(a, b) === 0;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** "2026-10-31" in local time. */
export function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "2026-10-31T17:30" (local, no offset). Seconds are included only when non-zero. */
export function localIso(ms: number): string {
  const d = new Date(ms);
  const seconds = d.getSeconds() ? `:${pad(d.getSeconds())}` : '';
  return `${localDate(ms)}T${pad(d.getHours())}:${pad(d.getMinutes())}${seconds}`;
}

/** "17:30" (24 h) for model-facing data. */
export function clock24(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const timeWithSecondsFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const dayYearFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const longDayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

/** Owner-facing clock time in their locale, e.g. "05:30 pm" or "17:30". */
export function formatTime(ms: number, withSeconds = false): string {
  return (withSeconds ? timeWithSecondsFormat : timeFormat).format(ms);
}

/** "Sat 31 Oct" (adds the year when it is not the current one). */
export function formatDay(ms: number, now = Date.now()): string {
  return (new Date(ms).getFullYear() === new Date(now).getFullYear() ? dayFormat : dayYearFormat).format(ms);
}

export function formatLongDay(ms: number): string {
  return longDayFormat.format(ms);
}

/** "today 17:30", "tomorrow 09:00", "Mon 2 Nov 09:00". */
export function formatWhen(ms: number, now = Date.now()): string {
  const days = calendarDaysBetween(now, ms);
  const time = formatTime(ms);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  if (days === -1) return `yesterday ${time}`;
  return `${formatDay(ms, now)} ${time}`;
}

/** "today", "tomorrow", "Mon 2 Nov". */
export function formatDayRelative(ms: number, now = Date.now()): string {
  const days = calendarDaysBetween(now, ms);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return formatDay(ms, now);
}

/** "45 s", "5 min", "1 min 30 s", "2 h 5 min", "3 days 2 h". */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / SECOND));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days} day${days === 1 ? '' : 's'}`);
  if (hours) parts.push(`${hours} h`);
  if (minutes) parts.push(`${minutes} min`);
  if (seconds && !days && !hours) parts.push(`${seconds} s`);
  return parts.length > 0 ? parts.slice(0, 2).join(' ') : '0 s';
}

/** Countdown text: "4:59", "1:02:03". */
export function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / SECOND));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

export interface ParsedDateTime {
  ms: number;
  /** The input had no time of day ("2026-11-02"). */
  dateOnly: boolean;
}

const ISO_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/** Example + current local time, so a model that sent "tomorrow 5pm" can fix the call. */
export function isoHint(now = Date.now()): string {
  return `Use ISO 8601 local time like "${localDate(addDays(now, 1))}T17:30" (it is now ${localIso(now - (now % MINUTE))}, ${weekdayName(now)}).`;
}

/**
 * Parses ISO 8601 date or date-time. Without an offset the value is the owner's local time;
 * with "Z" or "+05:30" it is converted to local. Rejects impossible dates instead of letting
 * Date roll "2026-02-31" into March.
 */
export function parseDateTime(value: unknown, field: string, now = Date.now()): ParsedDateTime {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ToolInputError(`'${field}' must be a date-time string. ${isoHint(now)}`);
  }
  const match = ISO_PATTERN.exec(value.trim());
  if (!match) throw new ToolInputError(`'${field}' is not ISO 8601 ("${value}"). ${isoHint(now)}`);
  const [, ys, mos, ds, hs, mis, ss, fraction, zone] = match;
  const year = Number(ys);
  const month = Number(mos);
  const day = Number(ds);
  if (year < 1970 || year > 2200) throw new ToolInputError(`'${field}' has an implausible year (${year}). ${isoHint(now)}`);
  if (month < 1 || month > 12) throw new ToolInputError(`'${field}' has an invalid month (${mos}).`);
  if (day < 1 || day > daysInMonth(year, month - 1)) {
    throw new ToolInputError(`'${field}': ${ys}-${mos} has no day ${ds}.`);
  }
  if (hs === undefined) {
    if (zone) throw new ToolInputError(`'${field}' has a time zone but no time of day.`);
    return { ms: new Date(year, month - 1, day).getTime(), dateOnly: true };
  }
  let hour = Number(hs);
  const minute = Number(mis);
  const second = ss === undefined ? 0 : Math.min(59, Number(ss));
  const millis = fraction ? Math.floor(Number(`0.${fraction}`) * 1000) : 0;
  let dayShift = 0;
  if (hour === 24 && minute === 0 && second === 0) {
    hour = 0;
    dayShift = 1;
  }
  if (hour > 23) throw new ToolInputError(`'${field}' has an invalid hour (${hs}).`);
  if (minute > 59) throw new ToolInputError(`'${field}' has an invalid minute (${mis}).`);

  if (zone) {
    let offsetMinutes = 0;
    if (zone.toUpperCase() !== 'Z') {
      const digits = zone.slice(1).replace(':', '');
      offsetMinutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || '0');
      if (zone.startsWith('-')) offsetMinutes = -offsetMinutes;
    }
    const utc = Date.UTC(year, month - 1, day + dayShift, hour, minute, second, millis) - offsetMinutes * MINUTE;
    return { ms: utc, dateOnly: false };
  }
  // Times inside a DST gap (e.g. 02:30 on spring-forward night) are moved forward by the
  // engine; callers echo the resolved time so the shift is visible to the owner.
  return { ms: new Date(year, month - 1, day + dayShift, hour, minute, second, millis).getTime(), dateOnly: false };
}

/** Parses "HH:MM" (24 h). Also accepts "7:05" and "07:05:00". */
export function parseClock(value: unknown, field: string): { hour: number; minute: number } {
  if (typeof value !== 'string') throw new ToolInputError(`'${field}' must be a 24-hour time like "07:30".`);
  const match = /^(\d{1,2}):(\d{2})(?::00)?$/.exec(value.trim());
  if (!match) throw new ToolInputError(`'${field}' must be a 24-hour time like "07:30" (got "${value}").`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new ToolInputError(`'${field}' is not a valid time of day ("${value}").`);
  return { hour, minute };
}

/** Next moment strictly after `after` with this wall-clock time (today or a later day). */
export function nextClockTime(hour: number, minute: number, after: number): number {
  const date = new Date(after);
  date.setHours(hour, minute, 0, 0);
  if (date.getTime() <= after) date.setDate(date.getDate() + 1);
  // Re-apply in case the day change crossed a DST boundary.
  date.setHours(hour, minute, 0, 0);
  return date.getTime();
}

export function isWeekend(ms: number): boolean {
  const day = new Date(ms).getDay();
  return day === 0 || day === 6;
}

/** Date-only due dates are stored as the last millisecond of that local day. */
export function endOfDayMs(ms: number): number {
  const date = new Date(ms);
  date.setHours(23, 59, 59, 999);
  return date.getTime();
}

export function isEndOfDay(ms: number): boolean {
  const date = new Date(ms);
  return date.getHours() === 23 && date.getMinutes() === 59 && date.getSeconds() === 59 && date.getMilliseconds() === 999;
}

/** Due date text: date only for end-of-day dues, otherwise date and time. */
export function formatDue(ms: number, now = Date.now()): string {
  return isEndOfDay(ms) ? formatDayRelative(ms, now) : formatWhen(ms, now);
}

/** Model-facing due value: "2026-11-02" for date-only dues, else local ISO. */
export function dueIso(ms: number): string {
  return isEndOfDay(ms) ? localDate(ms) : localIso(ms);
}

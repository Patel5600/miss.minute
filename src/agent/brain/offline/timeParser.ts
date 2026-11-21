/**
 * Natural-language times for the offline engine, resolved in the owner's local time zone:
 * "in 20 minutes", "at 5", "5pm", "17:30", "half past 6", "tomorrow at 9", "on Friday at 3",
 * "next Friday", "Nov 3 at 2pm", "3rd of November", "the 15th", "tonight", "noon", "midnight",
 * "next week", "this weekend", "every weekday at 7".
 *
 * Ambiguous hours ("at 5") resolve to the next time that clock shows; with a named day they
 * follow waking hours (1 to 6 means afternoon, 7 to 11 morning).
 */
import type { Recurrence } from '../../../store/db';
import { DURATION_SOURCE, NUMBER_WORD, durationSeconds, parseQuantity } from './numbers';

export interface Span {
  start: number;
  end: number;
}

export type RangeKind = 'day' | 'week' | 'weekend' | 'month';

export interface WhenResult {
  date: Date;
  /** A calendar day was named (today, tomorrow, Friday, Nov 3...). */
  hasDate: boolean;
  /** A clock time, a part of the day or a relative offset was given. */
  hasTime: boolean;
  /** "in 20 minutes" style. */
  relative: boolean;
  recurrence: Recurrence;
  /** Set when the phrase names a period rather than a moment ("next week"). */
  range?: RangeKind;
  /** Character ranges of the input that expressed the time (for cutting titles). */
  spans: Span[];
}

export interface WhenOptions {
  /** Hour used when only a day is named. Default 9. */
  defaultHour?: number;
  /** Override locale detection for numeric dates like 3/11. */
  dayFirst?: boolean;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAY_ABBR: Record<string, number> = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, weds: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_SOURCE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const WEEKDAY_SOURCE = '(sunday|monday|tuesday|wednesday|thursday|friday|saturday)';
const ABBR_SOURCE = '(sun|mon|tues?|weds?|thur?s?|fri|sat)';
const MERIDIEM = '(a\\.?\\s?m\\.?|p\\.?\\s?m\\.?)';
// Prepositions need a space after them, or "afternoon" would read as "after noon".
const PREP = '(?:(?:at|by|around|about|for|before|after|until|till|from|to)\\s+|@\\s*)?';

type Part = 'morning' | 'afternoon' | 'evening' | 'night' | 'tonight';
const PART_HOUR: Record<Part, number> = { morning: 9, afternoon: 15, evening: 18, night: 21, tonight: 20 };

function monthIndex(word: string): number {
  return MONTHS.indexOf(word.slice(0, 3).toLowerCase());
}

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

let cachedDayFirst: boolean | null = null;
function localeDayFirst(): boolean {
  if (cachedDayFirst !== null) return cachedDayFirst;
  try {
    const parts = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'numeric', year: 'numeric' }).formatToParts(new Date(2001, 10, 3));
    const order = parts.filter(part => part.type === 'day' || part.type === 'month').map(part => part.type);
    cachedDayFirst = order[0] === 'day';
  } catch {
    cachedDayFirst = false;
  }
  return cachedDayFirst;
}

/** Clock word ("five" -> 5) or digits; null when not 0..59. */
function clockNumber(raw: string): number | null {
  const value = parseQuantity(raw);
  return value === null || !Number.isInteger(value) || value < 0 || value > 59 ? null : value;
}

interface Clock {
  hour: number;
  minute: number;
  meridiem?: 'am' | 'pm';
  /** Written as 24-hour time (13:00, 07:30, 0:15). */
  h24: boolean;
  /** "midnight": the start of the following day. */
  midnight?: boolean;
  span: Span;
}

function meridiemOf(raw: string | undefined): 'am' | 'pm' | undefined {
  if (!raw) return undefined;
  return raw.toLowerCase().startsWith('a') ? 'am' : 'pm';
}

function findClock(lower: string): Clock | null {
  const at = (m: RegExpExecArray): Span => ({ start: m.index, end: m.index + m[0].length });
  let m: RegExpExecArray | null;

  m = new RegExp(`\\b${PREP}(noon|midday)\\b`).exec(lower);
  if (m) return { hour: 12, minute: 0, meridiem: 'pm', h24: false, span: at(m) };
  m = new RegExp(`\\b${PREP}midnight\\b`).exec(lower);
  if (m) return { hour: 0, minute: 0, h24: true, midnight: true, span: at(m) };

  // 5pm, 5:30 pm, 5.30pm, 11 a.m.
  m = new RegExp(`(?<![\\w:.])${PREP}(\\d{1,2})(?:[:.](\\d{2}))?\\s*${MERIDIEM}(?![a-z])`).exec(lower);
  if (m) {
    const hour = Number(m[1]);
    const minute = m[2] ? Number(m[2]) : 0;
    if (hour >= 1 && hour <= 12 && minute < 60) return { hour, minute, meridiem: meridiemOf(m[3]), h24: false, span: at(m) };
  }
  // five pm, five thirty pm
  m = new RegExp(`\\b${PREP}(${NUMBER_WORD})(?:\\s+(${NUMBER_WORD}|o'?clock))?\\s*${MERIDIEM}(?![a-z])`).exec(lower);
  if (m) {
    const hour = clockNumber(m[1]);
    const minute = m[2] && !/clock/.test(m[2]) ? clockNumber(m[2]) : 0;
    if (hour !== null && hour >= 1 && hour <= 12 && minute !== null) return { hour, minute, meridiem: meridiemOf(m[3]), h24: false, span: at(m) };
  }
  // The time half of an ISO date-time ("2026-11-03T14:00"); the date half is usually masked by now.
  m = /(?:\b\d{4}-\d{2}-\d{2}|(?:^|\s))t(\d{2}):(\d{2})(?!\d)/.exec(lower);
  if (m) {
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour < 24 && minute < 60) {
      const timeStart = m.index + m[0].length - 6;
      return { hour, minute, h24: true, span: { start: timeStart, end: timeStart + 6 } };
    }
  }
  // 17:30, 7:05, 17h30
  m = new RegExp(`(?<![\\w:.])${PREP}(\\d{1,2})[:h](\\d{2})(?![\\d:])`).exec(lower);
  if (m) {
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour < 24 && minute < 60) return { hour, minute, h24: hour > 12 || hour === 0 || m[1].length === 2 && m[1].startsWith('0'), span: at(m) };
  }
  // at 5.30
  m = /\b(?:at|by|around|@)\s*(\d{1,2})\.(\d{2})(?!\d)/.exec(lower);
  if (m) {
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour < 24 && minute < 60) return { hour, minute, h24: hour > 12, span: at(m) };
  }
  // half past five, quarter to 6, ten past 4, 20 to 5
  m = new RegExp(`\\b${PREP}(half|quarter|\\d{1,2}|${NUMBER_WORD})\\s+(past|after|to|till|before)\\s+(\\d{1,2}|${NUMBER_WORD})\\b`).exec(lower);
  if (m) {
    const minutes = m[1] === 'half' ? 30 : m[1] === 'quarter' ? 15 : clockNumber(m[1]);
    const base = clockNumber(m[3]);
    if (minutes !== null && base !== null && base >= 0 && base <= 23 && minutes > 0 && minutes < 60) {
      const forward = m[2] === 'past' || m[2] === 'after';
      let hour = forward ? base : base - 1;
      let minute = forward ? minutes : 60 - minutes;
      if (hour < 0) hour += 12;
      if (minute === 60) { minute = 0; hour += 1; }
      return { hour, minute, h24: base > 12, span: at(m) };
    }
  }
  // five thirty, 5 thirty, five o'clock, 5 o'clock
  m = new RegExp(`\\b${PREP}(\\d{1,2}|${NUMBER_WORD})\\s*(o'?\\s?clock|oh\\s+(?:${NUMBER_WORD})|${NUMBER_WORD})\\b`).exec(lower);
  if (m && (/clock/.test(m[2]) || /^(at|by|around|@)/.test(m[0]))) {
    const hour = clockNumber(m[1]);
    let minute: number | null = 0;
    if (!/clock/.test(m[2])) minute = clockNumber(m[2].replace(/^oh\s+/, ''));
    if (hour !== null && hour >= 1 && hour <= 12 && minute !== null && (minute >= 10 || /clock|^oh/.test(m[2]))) {
      return { hour, minute, h24: false, span: at(m) };
    }
  }
  // at 5, at five, by 9 (bare hour)
  m = new RegExp(`\\b(?:at|by|around|@)\\s*(\\d{1,2}|${NUMBER_WORD})(?![\\w:./%-])(?!\\s*(?:minutes?|mins?|hours?|hrs?|seconds?|secs?|days?|weeks?|people|persons?|times?|items?|percent|%|degrees?|st\\b|nd\\b|rd\\b|th\\b))`).exec(lower);
  if (m) {
    const hour = clockNumber(m[1]);
    if (hour !== null && hour <= 23) return { hour, minute: 0, h24: hour > 12 || hour === 0, span: at(m) };
  }
  return null;
}

interface DayMatch {
  day: Date;
  span: Span;
  part?: Part;
  range?: RangeKind;
  /** For weekdays named without "next": move a week ahead if the time already passed today. */
  weekdayToday?: boolean;
}

function weekdayOffset(now: Date, target: number, modifier: string | undefined): number {
  const today = now.getDay();
  let diff = (target - today + 7) % 7;
  if (modifier === 'next') {
    // "next Friday" is Friday of next week (weeks run Monday to Sunday).
    const isoToday = (today + 6) % 7;
    const isoTarget = (target + 6) % 7;
    if (diff === 0) diff = 7;
    else if (isoTarget > isoToday) diff += 7;
  }
  return diff;
}

function findDay(lower: string, now: Date, dayFirst: boolean): DayMatch | null {
  const at = (m: RegExpExecArray): Span => ({ start: m.index, end: m.index + m[0].length });
  const today = startOfDay(now);
  let m: RegExpExecArray | null;

  m = /\b(?:the\s+)?day\s+after\s+tomorrow\b/.exec(lower);
  if (m) return { day: addDays(today, 2), span: at(m) };
  m = /\b(?:tomorrow|tmrw|tmr|tomorow)(?:\s+(morning|afternoon|evening|night))?\b/.exec(lower);
  if (m) return { day: addDays(today, 1), span: at(m), part: m[1] as Part | undefined };
  m = /\btonight\b/.exec(lower);
  if (m) return { day: today, span: at(m), part: 'tonight' };
  m = /\bthis\s+(morning|afternoon|evening)\b/.exec(lower);
  if (m) return { day: today, span: at(m), part: m[1] as Part };
  m = /\btoday\b/.exec(lower);
  if (m) return { day: today, span: at(m) };

  m = /\b(?:the\s+)?(?:next|coming)\s+week\b/.exec(lower);
  if (m) return { day: addDays(today, weekdayOffset(now, 1, 'next')), span: at(m), range: 'week' };
  m = /\bthis\s+week\b/.exec(lower);
  if (m) return { day: today, span: at(m), range: 'week' };
  m = /\b(?:this|the|next|coming)?\s*weekend\b/.exec(lower);
  if (m) {
    const next = /next/.test(m[0]);
    let offset = weekdayOffset(now, 6, undefined);
    if (now.getDay() === 0) offset = 0;
    if (next) offset += 7;
    return { day: addDays(today, offset), span: at(m), range: 'weekend' };
  }
  m = /\bnext\s+month\b/.exec(lower);
  if (m) {
    const d = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    d.setDate(Math.min(today.getDate(), daysInMonth(d.getFullYear(), d.getMonth())));
    return { day: d, span: at(m), range: 'month' };
  }
  m = /\bthis\s+month\b/.exec(lower);
  if (m) return { day: today, span: at(m), range: 'month' };

  m = new RegExp(`\\b(?:(next|this|coming|on|by|until|till)\\s+)?${WEEKDAY_SOURCE}\\b(?:\\s+(morning|afternoon|evening|night))?`).exec(lower);
  if (m) {
    const modifier = m[1] === 'next' ? 'next' : undefined;
    const offset = weekdayOffset(now, WEEKDAYS.indexOf(m[2]), modifier);
    return { day: addDays(today, offset), span: at(m), part: m[3] as Part | undefined, weekdayToday: offset === 0 && !modifier };
  }
  m = new RegExp(`\\b(next|this|coming|on|by|until|till)\\s+${ABBR_SOURCE}\\.?(?![a-z])`).exec(lower);
  if (m) {
    const modifier = m[1] === 'next' ? 'next' : undefined;
    const offset = weekdayOffset(now, WEEKDAY_ABBR[m[2]], modifier);
    return { day: addDays(today, offset), span: at(m), weekdayToday: offset === 0 && !modifier };
  }

  const resolveMonthDay = (month: number, dayOfMonth: number, year: number | undefined, m2: RegExpExecArray): DayMatch | null => {
    if (month < 0 || dayOfMonth < 1) return null;
    let y = year ?? now.getFullYear();
    if (dayOfMonth > daysInMonth(y, month)) return null;
    let d = new Date(y, month, dayOfMonth);
    if (year === undefined && addDays(d, 1).getTime() <= now.getTime()) {
      y += 1;
      if (dayOfMonth > daysInMonth(y, month)) return null;
      d = new Date(y, month, dayOfMonth);
    }
    return { day: d, span: at(m2) };
  };

  // Nov 3, November 3rd, 2026
  m = new RegExp(`\\b(?:on\\s+)?${MONTH_SOURCE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`).exec(lower);
  if (m) {
    const r = resolveMonthDay(monthIndex(m[1]), Number(m[2]), m[3] ? Number(m[3]) : undefined, m);
    if (r) return r;
  }
  // 3 Nov, 3rd of November 2026
  m = new RegExp(`\\b(?:on\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_SOURCE}\\.?(?:,?\\s+(\\d{4}))?\\b`).exec(lower);
  if (m) {
    const r = resolveMonthDay(monthIndex(m[2]), Number(m[1]), m[3] ? Number(m[3]) : undefined, m);
    if (r) return r;
  }
  // 2026-11-03 (also the date part of 2026-11-03T14:00)
  m = /\b(\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(lower);
  if (m) {
    const r = resolveMonthDay(Number(m[2]) - 1, Number(m[3]), Number(m[1]), m);
    if (r) return r;
  }
  // 3/11 or 11/3 (locale order), optional year
  m = /(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?(?![\d/])/.exec(lower);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    let day = dayFirst ? a : b;
    let month = dayFirst ? b : a;
    if (month > 12 && day <= 12) [day, month] = [month, day];
    const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : undefined;
    const r = resolveMonthDay(month - 1, day, year, m);
    if (r) return r;
  }
  // the 15th, on the 3rd
  m = /\b(?:on\s+)?the\s+(\d{1,2})(st|nd|rd|th)\b/.exec(lower);
  if (m) {
    const dayOfMonth = Number(m[1]);
    for (let add = 0; add < 3; add += 1) {
      const y = today.getFullYear();
      const month = today.getMonth() + add;
      const probe = new Date(y, month, 1);
      if (dayOfMonth > daysInMonth(probe.getFullYear(), probe.getMonth())) continue;
      const d = new Date(probe.getFullYear(), probe.getMonth(), dayOfMonth);
      if (addDays(d, 1).getTime() > now.getTime()) return { day: d, span: at(m) };
    }
  }
  return null;
}

function findPart(lower: string): { part: Part; span: Span } | null {
  const m = /\b(?:in\s+the\s+|this\s+|at\s+|tomorrow\s+)?(morning|afternoon|evening|night|tonight)\b/.exec(lower);
  if (!m) return null;
  return { part: m[1] as Part, span: { start: m.index, end: m.index + m[0].length } };
}

function findRecurrence(lower: string): { recurrence: Recurrence; weekday?: number; part?: Part; span: Span } | null {
  const at = (m: RegExpExecArray): Span => ({ start: m.index, end: m.index + m[0].length });
  let m: RegExpExecArray | null;
  m = /\b(?:every\s+(?:single\s+)?(?:week\s?day|work\s?day)s?|(?:on\s+)?weekdays|monday\s+(?:to|through|thru|-)\s+friday)\b/.exec(lower);
  if (m) return { recurrence: 'weekdays', span: at(m) };
  m = new RegExp(`\\b(?:every\\s+${WEEKDAY_SOURCE}|(?:on\\s+)?(sundays|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays))\\b`).exec(lower);
  if (m) {
    const name = (m[1] ?? m[2]).replace(/s$/, '');
    return { recurrence: 'weekly', weekday: WEEKDAYS.indexOf(name), span: at(m) };
  }
  m = /\b(?:every\s+week|weekly|once\s+a\s+week)\b/.exec(lower);
  if (m) return { recurrence: 'weekly', span: at(m) };
  m = /\b(?:every\s+month|monthly|once\s+a\s+month)\b/.exec(lower);
  if (m) return { recurrence: 'monthly', span: at(m) };
  m = /\b(?:every\s*(?:single\s+)?day|daily|each\s+day|once\s+a\s+day|every\s+(morning|afternoon|evening|night))\b/.exec(lower);
  if (m) return { recurrence: 'daily', part: m[1] as Part | undefined, span: at(m) };
  return null;
}

function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

function hour24(clock: Clock, part: Part | undefined): { hour: number; ambiguous: boolean } {
  if (clock.midnight) return { hour: 0, ambiguous: false };
  if (clock.meridiem === 'am') return { hour: clock.hour % 12, ambiguous: false };
  if (clock.meridiem === 'pm') return { hour: (clock.hour % 12) + 12, ambiguous: false };
  if (clock.h24 || clock.hour > 12) return { hour: clock.hour, ambiguous: false };
  if (part === 'morning') return { hour: clock.hour % 12, ambiguous: false };
  if (part === 'night' && clock.hour <= 4) return { hour: clock.hour % 12, ambiguous: false };
  if (part) return { hour: (clock.hour % 12) + 12, ambiguous: false };
  return { hour: clock.hour, ambiguous: true };
}

function at(day: Date, hour: number, minute: number): Date {
  const d = new Date(day);
  d.setHours(hour, minute, 0, 0);
  return d;
}

/** Finds a time or date in free text. Returns null when the text names none. */
export function parseWhen(text: string, now: Date, options: WhenOptions = {}): WhenResult | null {
  const lower = text.toLowerCase();
  const defaultHour = options.defaultHour ?? 9;
  const dayFirst = options.dayFirst ?? localeDayFirst();

  const relative = new RegExp(`\\b(?:in|within|after)\\s+(?:about\\s+|around\\s+|roughly\\s+|approximately\\s+|another\\s+|like\\s+|just\\s+)?(${DURATION_SOURCE})(?![\\w])`).exec(lower)
    ?? new RegExp(`(?<![\\w.])(${DURATION_SOURCE})\\s+(?:from\\s+now|later)\\b`).exec(lower);
  if (relative) {
    const seconds = durationSeconds(relative[1]);
    if (seconds !== null && seconds > 0) {
      return {
        date: new Date(now.getTime() + seconds * 1000),
        hasDate: seconds >= 86_400,
        hasTime: true,
        relative: true,
        recurrence: 'none',
        spans: [{ start: relative.index, end: relative.index + relative[0].length }],
      };
    }
  }

  const spans: Span[] = [];
  const recur = findRecurrence(lower);
  if (recur) spans.push(recur.span);
  const masked = (span: Span) => lower.slice(0, span.start) + ' '.repeat(span.end - span.start) + lower.slice(span.end);
  const afterRecur = recur ? masked(recur.span) : lower;

  const dayMatch = findDay(afterRecur, now, dayFirst);
  if (dayMatch) spans.push(dayMatch.span);
  const afterDay = dayMatch ? afterRecur.slice(0, dayMatch.span.start) + ' '.repeat(dayMatch.span.end - dayMatch.span.start) + afterRecur.slice(dayMatch.span.end) : afterRecur;

  const clock = findClock(afterDay);
  if (clock) spans.push(clock.span);
  let part: Part | undefined = dayMatch?.part ?? recur?.part;
  if (!part) {
    const found = findPart(clock ? afterDay.slice(0, clock.span.start) + ' '.repeat(clock.span.end - clock.span.start) + afterDay.slice(clock.span.end) : afterDay);
    if (found && !spans.some(span => overlaps(span, found.span))) {
      part = found.part;
      spans.push(found.span);
    }
  }

  if (!recur && !dayMatch && !clock && !part) return null;

  const recurrence: Recurrence = recur?.recurrence ?? 'none';
  const today = startOfDay(now);
  let day: Date | undefined = dayMatch?.day;
  if (!day && recur?.weekday !== undefined) {
    day = addDays(today, weekdayOffset(now, recur.weekday, undefined));
  }
  const hasDate = !!dayMatch;
  const hasTime = !!clock || !!part;
  const range = dayMatch?.range;

  const passed = (d: Date) => d.getTime() <= now.getTime();
  // Weekly cues ("every Monday", "on Friday" said on a Friday) skip a week once the time passed.
  const weekStep = recur?.weekday !== undefined || !!dayMatch?.weekdayToday;
  const isToday = (d: Date | undefined) => !d || d.getTime() === today.getTime();

  let date: Date;
  if (clock) {
    const { hour, ambiguous } = hour24(clock, part);
    const minute = clock.minute;
    if (clock.midnight) {
      date = at(addDays(day ?? today, 1), 0, minute);
    } else if (recurrence !== 'none' || !isToday(day) || dayMatch?.weekdayToday) {
      // A named day or a repeating schedule: ambiguous hours follow waking hours.
      date = at(day ?? today, ambiguous ? wakingHour(clock.hour) : hour, minute);
      if (passed(date)) date = addDays(date, weekStep ? 7 : 1);
    } else {
      // Today, said or implied: the next time the clock shows this.
      const candidates = ambiguous ? [clock.hour % 12, (clock.hour % 12) + 12] : [hour];
      const upcoming = candidates.map(h => at(today, h, minute)).find(d => !passed(d));
      if (upcoming) date = upcoming;
      else if (dayMatch) date = at(today, ambiguous ? (clock.hour % 12) + 12 : hour, minute); // "today at 9" at 22:00 stays in the past
      else date = at(addDays(today, 1), ambiguous ? clock.hour % 12 : hour, minute);
    }
  } else if (part) {
    date = at(day ?? today, PART_HOUR[part], 0);
    if (passed(date)) {
      if (weekStep) {
        date = addDays(date, 7);
      } else if (isToday(day) && (part === 'tonight' || part === 'night' || part === 'evening') && recurrence === 'none') {
        const soon = new Date(now.getTime() + 60 * 60_000);
        soon.setMinutes(Math.ceil(soon.getMinutes() / 15) * 15, 0, 0);
        date = soon.getDate() === now.getDate() ? soon : at(addDays(today, 1), PART_HOUR[part], 0);
      } else {
        date = at(addDays(today, 1), PART_HOUR[part], 0);
      }
    }
  } else if (day) {
    date = at(day, defaultHour, 0);
    if (passed(date) && weekStep && !range) date = addDays(date, 7);
  } else {
    // Only a repeat ("every day"): the next default-hour slot.
    date = at(today, defaultHour, 0);
    if (passed(date)) date = addDays(date, 1);
  }
  if (recurrence === 'weekdays') {
    while (date.getDay() === 0 || date.getDay() === 6) date = addDays(date, 1);
  }

  return { date, hasDate, hasTime, relative: false, recurrence, range, spans };
}

function wakingHour(hour: number): number {
  if (hour === 12) return 12;
  return hour <= 6 ? hour + 12 : hour;
}

/** Agenda window for questions like "what's on tomorrow" or "anything this weekend". */
export function rangeFor(text: string, now: Date): { from: Date; to: Date; label: string } {
  const when = parseWhen(text, now, { defaultHour: 0 });
  const today = startOfDay(now);
  if (!when || when.relative) return { from: today, to: addDays(today, 1), label: 'today' };
  const day = startOfDay(when.date);
  if (when.range === 'week') {
    const isThisWeek = day.getTime() === today.getTime();
    const from = isThisWeek ? today : day;
    const nextMonday = addDays(isThisWeek ? today : day, isThisWeek ? weekdayOffset(now, 1, 'next') : 7);
    return { from, to: nextMonday, label: isThisWeek ? 'this week' : 'next week' };
  }
  if (when.range === 'weekend') {
    const from = day;
    const to = addDays(from, from.getDay() === 0 ? 1 : 2);
    return { from, to, label: 'this weekend' };
  }
  if (when.range === 'month') {
    if (day.getTime() === today.getTime()) return { from: today, to: new Date(today.getFullYear(), today.getMonth() + 1, 1), label: 'this month' };
    const first = new Date(day.getFullYear(), day.getMonth(), 1);
    return { from: first, to: new Date(first.getFullYear(), first.getMonth() + 1, 1), label: 'next month' };
  }
  const offset = Math.round((day.getTime() - today.getTime()) / 86_400_000);
  const label = offset === 0 ? 'today' : offset === 1 ? 'tomorrow' : day.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  return { from: day, to: addDays(day, 1), label };
}

/** Removes the time phrases from text and tidies what's left ("call mom at 5" -> "call mom"). */
export function withoutSpans(text: string, spans: Span[]): string {
  const sorted = [...spans].sort((a, b) => b.start - a.start);
  let out = text;
  for (const span of sorted) out = `${out.slice(0, span.start)} ${out.slice(span.end)}`;
  return out
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/\b(?:at|on|in|by|for|from|around|about)\s*(?=[,.!?;:]|$)/gi, '')
    .replace(/^[\s,;:.-]+|[\s,;:-]+$/g, '')
    .trim();
}

export function localIso(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function clockText(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** "today at 5:00 PM", "tomorrow at 9:00 AM", "Friday, November 6 at 3:00 PM". */
export function describeWhen(date: Date, now: Date, withTime = true): string {
  const days = Math.round((startOfDay(date).getTime() - startOfDay(now).getTime()) / 86_400_000);
  const dayText = days === 0 ? 'today' : days === 1 ? 'tomorrow' : days > 1 && days < 7
    ? date.toLocaleDateString(undefined, { weekday: 'long' })
    : date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  return withTime ? `${dayText} at ${clockText(date)}` : dayText;
}

/**
 * Busy-interval merging and free calendar slot extraction backed by the owner's Sacred Timeline.
 * Mirrors `crates/mm-mission/src/availability.rs`.
 */
import {
  findAvailability,
  isDesktopRuntime,
  type AvailabilitySummary,
  type BusyInterval,
  type FreeSlot,
} from '../../desktop/bridge.ts';
import { listAll } from '../../store/db.ts';
import { expandAgenda } from './agenda.ts';
import { optionalNumber, optionalText, ToolInputError } from './args.ts';
import { makeTool } from './define.ts';
import { addDays, formatDayRelative, formatDuration, localIso, MINUTE, parseDateTime, startOfDay } from './time.ts';
import type { ToolContext } from './types.ts';

export function mergeBusyIntervals(intervals: readonly BusyInterval[]): BusyInterval[] {
  const valid = intervals
    .filter(iv => iv.end_epoch_min > iv.start_epoch_min)
    .map(iv => ({ ...iv }))
    .sort((a, b) => a.start_epoch_min - b.start_epoch_min || a.end_epoch_min - b.end_epoch_min);

  const merged: BusyInterval[] = [];
  for (const iv of valid) {
    const last = merged[merged.length - 1];
    if (last && iv.start_epoch_min <= last.end_epoch_min) {
      if (iv.end_epoch_min > last.end_epoch_min) {
        last.end_epoch_min = iv.end_epoch_min;
      }
      continue;
    }
    merged.push(iv);
  }
  return merged;
}

export function findFreeSlotsLocal(
  busy: readonly BusyInterval[],
  windowStartMin: number,
  windowEndMin: number,
  minDurationMin: number,
): AvailabilitySummary {
  if (windowEndMin <= windowStartMin || minDurationMin <= 0) {
    return {
      free_slots: [],
      summary_sentence: 'No valid scheduling window was provided.',
    };
  }

  const merged = mergeBusyIntervals(busy);
  let cursor = windowStartMin;
  const free: FreeSlot[] = [];

  for (const iv of merged) {
    if (iv.end_epoch_min <= windowStartMin) continue;
    if (iv.start_epoch_min >= windowEndMin) break;
    const clippedStart = Math.max(iv.start_epoch_min, windowStartMin);
    const clippedEnd = Math.min(iv.end_epoch_min, windowEndMin);
    if (clippedStart > cursor) {
      const dur = clippedStart - cursor;
      if (dur >= minDurationMin) {
        free.push({
          start_epoch_min: cursor,
          end_epoch_min: clippedStart,
          duration_minutes: dur,
        });
      }
    }
    cursor = Math.max(cursor, clippedEnd);
  }

  if (windowEndMin > cursor) {
    const dur = windowEndMin - cursor;
    if (dur >= minDurationMin) {
      free.push({
        start_epoch_min: cursor,
        end_epoch_min: windowEndMin,
        duration_minutes: dur,
      });
    }
  }

  const summarySentence = free.length === 0
    ? `No openings of at least ${minDurationMin} minutes exist in that window.`
    : `Found ${free.length} open window(s) totaling ${free.reduce((s, slot) => s + slot.duration_minutes, 0)} minutes (longest opening: ${Math.max(...free.map(slot => slot.duration_minutes))} minutes).`;

  return {
    free_slots: free,
    summary_sentence: summarySentence,
  };
}

export async function computeScheduleAvailability(params: {
  fromMs: number;
  toMs: number;
  minDurationMin: number;
  now?: number;
}): Promise<AvailabilitySummary & {
  slotsLocal: Array<{ start: string; end: string; duration_minutes: number }>;
  busyCount: number;
}> {
  const now = params.now ?? Date.now();
  const items = await listAll('schedule');
  const agenda = expandAgenda(items, params.fromMs, params.toMs, now, { kinds: ['event'] });
  const busy: BusyInterval[] = agenda
    .filter(entry => !entry.allDay && entry.status !== 'done' && entry.end > entry.start)
    .map(entry => ({
      start_epoch_min: Math.floor(entry.start / MINUTE),
      end_epoch_min: Math.ceil(entry.end / MINUTE),
      label: entry.title,
    }));

  const windowStartMin = Math.floor(params.fromMs / MINUTE);
  const windowEndMin = Math.floor(params.toMs / MINUTE);

  const summary = isDesktopRuntime()
    ? await findAvailability({
        busy,
        windowStartMin,
        windowEndMin,
        minDurationMin: params.minDurationMin,
      })
    : findFreeSlotsLocal(busy, windowStartMin, windowEndMin, params.minDurationMin);

  return {
    ...summary,
    busyCount: busy.length,
    slotsLocal: summary.free_slots.map(slot => ({
      start: localIso(slot.start_epoch_min * MINUTE),
      end: localIso(slot.end_epoch_min * MINUTE),
      duration_minutes: slot.duration_minutes,
    })),
  };
}

interface AvailabilityArgs {
  fromMs: number;
  toMs: number;
  minDurationMin: number;
}

export const availabilityTools = [
  makeTool<AvailabilityArgs>({
    name: 'find_availability',
    description:
      'Finds open calendar windows across the owner\'s Sacred Timeline events by merging busy blocks and finding '
      + 'free gaps of at least min_duration_minutes. Defaults to 08:00-22:00 today. Owner only.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Window start (ISO 8601 local date or date-time). Default 08:00 today.' },
        to: { type: 'string', description: 'Window end (ISO 8601 local date or date-time). Default 22:00 on the start day.' },
        min_duration_minutes: { type: 'integer', minimum: 5, maximum: 1440, description: 'Minimum slot length in minutes. Default 30.' },
      },
    },
    policy: 'auto',
    failure: "Couldn't check availability",
    available: (ctx: ToolContext) => !ctx.guestMode,
    parse(args) {
      const now = Date.now();
      const fromText = optionalText(args, 'from', 60);
      const toText = optionalText(args, 'to', 60);
      const parsedFrom = fromText ? parseDateTime(fromText, 'from', now) : undefined;
      const fromMs = parsedFrom
        ? (parsedFrom.dateOnly ? startOfDay(parsedFrom.ms) + 8 * 60 * MINUTE : parsedFrom.ms)
        : startOfDay(now) + 8 * 60 * MINUTE;

      const parsedTo = toText ? parseDateTime(toText, 'to', now) : undefined;
      const toMs = parsedTo
        ? (parsedTo.dateOnly ? startOfDay(parsedTo.ms) + 22 * 60 * MINUTE : parsedTo.ms)
        : startOfDay(fromMs) + 22 * 60 * MINUTE;

      if (toMs <= fromMs) {
        const nextEnd = addDays(startOfDay(fromMs), 1) - 2 * 60 * MINUTE;
        if (toText) throw new ToolInputError("'to' must be after 'from'.");
        return {
          fromMs,
          toMs: Math.max(nextEnd, fromMs + 60 * MINUTE),
          minDurationMin: optionalNumber(args, 'min_duration_minutes', { min: 5, max: 1440, round: true, unit: 'minutes' }) ?? 30,
        };
      }
      if (toMs - fromMs > 31 * 24 * 60 * MINUTE) {
        throw new ToolInputError('Availability scan window can span at most 31 days.');
      }
      const minDurationMin = optionalNumber(args, 'min_duration_minutes', {
        min: 5,
        max: 1440,
        round: true,
        unit: 'minutes',
      }) ?? 30;
      return { fromMs, toMs, minDurationMin };
    },
    describe(args) {
      return `Find >= ${args.minDurationMin} min openings on ${formatDayRelative(args.fromMs)}`;
    },
    async run(args) {
      const res = await computeScheduleAvailability({
        fromMs: args.fromMs,
        toMs: args.toMs,
        minDurationMin: args.minDurationMin,
      });
      return {
        ok: true,
        summary: res.summary_sentence,
        data: {
          from: localIso(args.fromMs),
          to: localIso(args.toMs),
          min_duration_minutes: args.minDurationMin,
          busy_event_count: res.busyCount,
          free_slots: res.slotsLocal,
          longest_opening: res.free_slots.length > 0
            ? formatDuration(Math.max(...res.free_slots.map(s => s.duration_minutes)) * MINUTE)
            : '0 min',
        },
      };
    },
  }),
];

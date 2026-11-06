/**
 * get_time: the owner's local time, or the time anywhere (world clock) through Intl with IANA
 * zones. Cities resolve to zones through Open-Meteo geocoding.
 */
import { ToolInputError, optionalText } from './args';
import { makeTool } from './define';
import { geocode } from './geo';
import { formatDuration, formatOffset, localIso, localOffsetMinutes, localTimeZone, weekdayName, MINUTE } from './time';

/** Canonical IANA name, or a ToolInputError naming the problem. */
export function checkTimeZone(zone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    throw new ToolInputError(`"${zone}" is not an IANA time zone. Use a name like "Europe/London" or "America/New_York", or pass 'city' instead.`);
  }
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
}

export function zonedParts(ms: number, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'long', hourCycle: 'h23',
  }).formatToParts(ms);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: get('weekday'),
  };
}

/** Minutes east of UTC for a zone at an instant. */
export function zoneOffsetMinutes(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / MINUTE);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function relativeOffset(diffMinutes: number): string {
  if (diffMinutes === 0) return 'same time as you';
  const text = formatDuration(Math.abs(diffMinutes) * MINUTE);
  return diffMinutes > 0 ? `${text} ahead of you` : `${text} behind you`;
}

interface GetTimeArgs {
  city?: string;
  timezone?: string;
}

export const clockTools = [
  makeTool<GetTimeArgs>({
    name: 'get_time',
    description:
      "Current date and time. With no arguments: the owner's local time and time zone. With 'city' or an IANA "
      + "'timezone' it works as a world clock and also says how far ahead or behind the owner that place is. "
      + 'Use it before answering any question about the time somewhere else.',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City name, optionally with region/country, e.g. "Tokyo" or "Portland, Oregon".' },
        timezone: { type: 'string', description: 'IANA time zone, e.g. "Europe/London". Takes precedence over city.' },
      },
    },
    policy: 'auto',
    failure: "Couldn't get the time",
    parse(args) {
      return { city: optionalText(args, 'city', 120), timezone: optionalText(args, 'timezone', 64) };
    },
    describe(args) {
      if (args.timezone) return `Check the time in ${args.timezone}`;
      if (args.city) return `Check the time in ${args.city}`;
      return 'Check the local time';
    },
    async run(args, ctx) {
      const now = Date.now();
      const ownerZone = localTimeZone();
      const ownerOffset = localOffsetMinutes(now);
      let place: string | undefined;
      let zone = ownerZone;
      if (args.timezone) {
        zone = checkTimeZone(args.timezone);
        place = args.city;
      } else if (args.city) {
        const found = await geocode(args.city, ctx.signal);
        zone = checkTimeZone(found.timezone);
        place = found.label;
      }
      const p = zonedParts(now, zone);
      const offset = zoneOffsetMinutes(now, zone);
      const localTime = `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
      const display = new Intl.DateTimeFormat(undefined, {
        timeZone: zone, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
      }).format(now);
      const isOwner = !args.timezone && !args.city;
      const difference = offset - ownerOffset;
      const data = {
        place: place ?? (isOwner ? 'owner (local)' : undefined),
        timezone: zone,
        local_time: isOwner ? localIso(now - (now % MINUTE)) : localTime,
        weekday: isOwner ? weekdayName(now) : p.weekday,
        utc_offset: formatOffset(offset),
        ...(isOwner ? {} : { difference_from_owner: relativeOffset(difference) }),
      };
      const where = place ?? zone;
      const summary = isOwner
        ? `It's ${display} (${zone}, UTC${formatOffset(offset)})`
        : `${where}: ${display} (${zone}, ${relativeOffset(difference)})`;
      return { ok: true, summary, data };
    },
  }),
];

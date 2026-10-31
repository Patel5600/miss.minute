/**
 * get_weather: Open-Meteo forecast (no key), current conditions plus daily highs/lows, in the
 * owner's locale units. Defaults to the home city from settings. Cached for ten minutes.
 */
import { ToolInputError, optionalNumber, optionalText } from './args';
import { makeTool } from './define';
import { geocode, type Place } from './geo';
import { fetchJson } from './net';
import { knownHomeCity } from './settingsCache';
import { MINUTE } from './time';

const WMO: Record<number, string> = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'light freezing drizzle', 57: 'freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'light freezing rain', 67: 'freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'light showers', 81: 'showers', 82: 'violent showers', 85: 'light snow showers', 86: 'snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with heavy hail',
};

export function describeWeatherCode(code: number | undefined): string {
  return code === undefined ? 'unknown' : WMO[code] ?? `weather code ${code}`;
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

function compass(degrees: number | undefined): string | undefined {
  if (degrees === undefined || !Number.isFinite(degrees)) return undefined;
  return COMPASS[Math.round((((degrees % 360) + 360) % 360) / 22.5) % 16];
}

interface Units {
  temperature: 'celsius' | 'fahrenheit';
  wind: 'kmh' | 'mph';
  precipitation: 'mm' | 'inch';
}

const FAHRENHEIT_REGIONS = new Set(['US', 'LR', 'MM', 'BS', 'BZ', 'KY', 'PW', 'FM', 'MH', 'PR', 'GU', 'VI', 'AS', 'MP']);
const MPH_REGIONS = new Set([...FAHRENHEIT_REGIONS, 'GB', 'IM', 'JE', 'GG']);

/** Units from the owner's locale region (Intl.Locale maximizes "en" to "en-Latn-US"). */
export function localeUnits(): Units {
  let region = '';
  try {
    const language = typeof navigator !== 'undefined' ? navigator.language : 'en-US';
    region = new Intl.Locale(language).maximize().region ?? '';
  } catch {
    region = '';
  }
  return {
    temperature: FAHRENHEIT_REGIONS.has(region) ? 'fahrenheit' : 'celsius',
    wind: MPH_REGIONS.has(region) ? 'mph' : 'kmh',
    precipitation: FAHRENHEIT_REGIONS.has(region) ? 'inch' : 'mm',
  };
}

interface ForecastResponse {
  timezone?: string;
  current_units?: Record<string, string>;
  daily_units?: Record<string, string>;
  current?: {
    time?: string;
    temperature_2m?: number;
    apparent_temperature?: number;
    relative_humidity_2m?: number;
    is_day?: number;
    precipitation?: number;
    weather_code?: number;
    wind_speed_10m?: number;
    wind_direction_10m?: number;
    wind_gusts_10m?: number;
  };
  daily?: {
    time?: string[];
    weather_code?: number[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_probability_max?: Array<number | null>;
    precipitation_sum?: number[];
    sunrise?: string[];
    sunset?: string[];
    uv_index_max?: Array<number | null>;
    wind_speed_10m_max?: number[];
  };
}

const cache = new Map<string, { at: number; data: ForecastResponse }>();
const CACHE_MS = 10 * MINUTE;

async function forecast(place: Place, days: number, units: Units, signal?: AbortSignal): Promise<ForecastResponse> {
  const key = `${place.latitude.toFixed(3)},${place.longitude.toFixed(3)}|${days}|${units.temperature}|${units.wind}|${units.precipitation}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const params = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,is_day,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,sunrise,sunset,uv_index_max,wind_speed_10m_max',
    timezone: 'auto',
    forecast_days: String(days),
    temperature_unit: units.temperature,
    wind_speed_unit: units.wind,
    precipitation_unit: units.precipitation,
  });
  const data = await fetchJson<ForecastResponse>(`https://api.open-meteo.com/v1/forecast?${params.toString()}`, {
    service: 'Open-Meteo', signal,
  });
  cache.set(key, { at: Date.now(), data });
  return data;
}

function round(value: number | null | undefined, digits = 0): number | undefined {
  if (value === null || value === undefined || !Number.isFinite(value)) return undefined;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function timeOf(iso: string | undefined): string | undefined {
  return iso && iso.length >= 16 ? iso.slice(11, 16) : undefined;
}

interface WeatherArgs {
  city?: string;
  days: number;
}

export const weatherTools = [
  makeTool<WeatherArgs>({
    name: 'get_weather',
    description:
      'Current weather and a daily forecast (1 to 7 days, default 3) from Open-Meteo, in the owner\'s units. '
      + 'city defaults to the owner\'s home city; pass "City, Country" to disambiguate. Returns conditions, '
      + 'temperature, feels-like, humidity, wind, and per day high/low, rain chance, sunrise/sunset and UV.',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City, optionally "City, Region/Country". Default: home city.' },
        days: { type: 'integer', minimum: 1, maximum: 7, description: 'Forecast days including today. Default 3.' },
      },
    },
    policy: 'auto',
    failure: "Couldn't get the weather",
    parse(args) {
      return { city: optionalText(args, 'city', 120), days: optionalNumber(args, 'days', { min: 1, max: 7, integer: true }) ?? 3 };
    },
    describe(args) {
      return `Check the weather${args.city ? ` in ${args.city}` : ' at home'} (${args.days} day${args.days === 1 ? '' : 's'})`;
    },
    async run(args, ctx) {
      const city = args.city || ctx.settings?.homeCity?.trim() || knownHomeCity();
      if (!city) {
        throw new ToolInputError('No city was given and no home city is set. Ask the owner which city (they can also set a home city in the Dossier or Settings).');
      }
      const place = await geocode(city, ctx.signal);
      const units = localeUnits();
      const data = await forecast(place, args.days, units, ctx.signal);
      const tempUnit = data.current_units?.temperature_2m ?? (units.temperature === 'fahrenheit' ? '°F' : '°C');
      const windUnit = data.current_units?.wind_speed_10m ?? (units.wind === 'mph' ? 'mph' : 'km/h');
      const rainUnit = data.daily_units?.precipitation_sum ?? units.precipitation;
      const current = data.current ?? {};
      const daily = data.daily ?? {};
      const dayRows = (daily.time ?? []).slice(0, args.days).map((date, index) => ({
        date,
        conditions: describeWeatherCode(daily.weather_code?.[index]),
        high: round(daily.temperature_2m_max?.[index]),
        low: round(daily.temperature_2m_min?.[index]),
        rain_chance: round(daily.precipitation_probability_max?.[index]),
        precipitation: round(daily.precipitation_sum?.[index], 1),
        max_wind: round(daily.wind_speed_10m_max?.[index]),
        sunrise: timeOf(daily.sunrise?.[index]),
        sunset: timeOf(daily.sunset?.[index]),
        uv_max: round(daily.uv_index_max?.[index], 1),
      }));
      const now = {
        observed: current.time,
        temperature: round(current.temperature_2m),
        feels_like: round(current.apparent_temperature),
        humidity: round(current.relative_humidity_2m),
        conditions: describeWeatherCode(current.weather_code),
        wind: round(current.wind_speed_10m),
        wind_from: compass(current.wind_direction_10m),
        gusts: round(current.wind_gusts_10m),
        precipitation: round(current.precipitation, 1),
        daylight: current.is_day === undefined ? undefined : current.is_day === 1,
      };
      const today = dayRows[0];
      const pieces = [`${place.name}: ${now.temperature ?? '?'}${tempUnit}, ${now.conditions}`];
      if (now.feels_like !== undefined && now.temperature !== undefined && Math.abs(now.feels_like - now.temperature) >= 2) {
        pieces[0] += ` (feels ${now.feels_like}${tempUnit})`;
      }
      if (today) {
        const rain = today.rain_chance !== undefined ? `, ${today.rain_chance}% rain` : '';
        pieces.push(`today ${today.high ?? '?'}/${today.low ?? '?'}${tempUnit}${rain}`);
      }
      return {
        ok: true,
        summary: pieces.join('; '),
        data: {
          location: place.label,
          timezone: data.timezone ?? place.timezone,
          units: { temperature: tempUnit, wind: windUnit, precipitation: rainUnit },
          current: now,
          daily: dayRows,
          source: 'Open-Meteo',
        },
      };
    },
  }),
];

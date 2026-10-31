/**
 * City lookup through Open-Meteo's free geocoding API (no key). Returns coordinates and the
 * IANA time zone. "City, Region, Country" input is split: the API searches the city name and
 * the qualifiers pick among same-named places. Results are cached in memory and in IndexedDB
 * because places do not move.
 */
import { kvGet, kvSet } from '../../store/db';
import { ToolInputError } from './args';
import { fetchJson } from './net';

export interface Place {
  name: string;
  /** "Pune, Maharashtra, India" */
  label: string;
  latitude: number;
  longitude: number;
  timezone: string;
  country?: string;
  countryCode?: string;
  admin1?: string;
}

interface GeocodingResult {
  name: string;
  latitude: number;
  longitude: number;
  timezone?: string;
  country?: string;
  country_code?: string;
  admin1?: string;
  admin2?: string;
  feature_code?: string;
  population?: number;
}

const memory = new Map<string, Place>();

function fold(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function labelOf(result: GeocodingResult): string {
  const parts = [result.name];
  if (result.admin1 && fold(result.admin1) !== fold(result.name)) parts.push(result.admin1);
  if (result.country) parts.push(result.country);
  return parts.join(', ');
}

function rank(result: GeocodingResult, name: string): number {
  const exact = fold(result.name) === fold(name) ? 1_000_000_000 : 0;
  const capital = result.feature_code === 'PPLC' ? 50_000_000 : result.feature_code === 'PPLA' ? 10_000_000 : 0;
  return exact + capital + (result.population ?? 0);
}

function matchesQualifier(result: GeocodingResult, qualifier: string): boolean {
  const q = fold(qualifier);
  return [result.country, result.country_code, result.admin1, result.admin2]
    .filter((value): value is string => typeof value === 'string')
    .some(value => {
      const v = fold(value);
      return v === q || v.startsWith(q) || (q.length >= 4 && v.includes(q));
    });
}

export async function geocode(query: string, signal?: AbortSignal): Promise<Place> {
  const cleaned = query.replace(/\s+/g, ' ').trim();
  if (!cleaned) throw new ToolInputError('A city name is required.');
  if (cleaned.length > 120) throw new ToolInputError('The city name is too long.');
  const key = fold(cleaned);
  const cached = memory.get(key) ?? (await kvGet<Place>(`geo:${key}`).catch(() => undefined));
  if (cached) {
    memory.set(key, cached);
    return cached;
  }

  const [name, ...qualifiers] = cleaned.split(',').map(part => part.trim()).filter(Boolean);
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=10&language=en&format=json`;
  const response = await fetchJson<{ results?: GeocodingResult[] }>(url, { service: 'Open-Meteo geocoding', signal });
  const results = (response.results ?? []).filter(result =>
    Number.isFinite(result.latitude) && Number.isFinite(result.longitude) && typeof result.timezone === 'string');
  if (results.length === 0) {
    throw new ToolInputError(`No place called "${name}" was found. Check the spelling or try a nearby larger city.`);
  }
  const candidates = qualifiers.length > 0
    ? results.filter(result => qualifiers.every(qualifier => matchesQualifier(result, qualifier)))
    : results;
  if (candidates.length === 0) {
    const closest = [...results].sort((a, b) => rank(b, name) - rank(a, name))[0];
    throw new ToolInputError(`No "${name}" in ${qualifiers.join(', ')} was found. The closest match is ${labelOf(closest)}.`);
  }
  const best = [...candidates].sort((a, b) => rank(b, name) - rank(a, name))[0];
  const place: Place = {
    name: best.name,
    label: labelOf(best),
    latitude: best.latitude,
    longitude: best.longitude,
    timezone: best.timezone as string,
    country: best.country,
    countryCode: best.country_code,
    admin1: best.admin1,
  };
  memory.set(key, place);
  void kvSet(`geo:${key}`, place).catch(() => undefined);
  return place;
}

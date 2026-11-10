/**
 * The last settings the brain handed to a tool context. `buildDynamicContext(now)` has no
 * settings parameter (shared contract), so the home city is read from here, falling back to
 * the settings the app persisted in this browser profile.
 */
import type { AISettings } from '../../types';

const STORED_SETTINGS_KEY = 'miss_minutes_settings';

let latest: AISettings | undefined;

export function rememberSettings(settings: AISettings | undefined): void {
  if (settings) latest = settings;
}

export function knownHomeCity(): string | undefined {
  const fromContext = latest?.homeCity?.trim();
  if (fromContext) return fromContext;
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORED_SETTINGS_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { homeCity?: unknown };
    return typeof parsed.homeCity === 'string' && parsed.homeCity.trim() ? parsed.homeCity.trim() : undefined;
  } catch {
    return undefined;
  }
}

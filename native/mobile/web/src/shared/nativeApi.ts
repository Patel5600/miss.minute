/**
 * Typed calls to the native side for the dashboard, plus the pure helpers that turn native answers
 * into text. Everything a screen shows about her overlay, the kill notice and the settings comes from
 * native; nothing here pretends. A missing field falls back to the safe reading ("off", "no").
 */
import { request } from './bridge.ts';
import type { Payload } from './protocol.ts';
import { MODES, ROAMING_LEVELS } from './vocabulary.ts';
import type { Mode, RoamingLevel } from './vocabulary.ts';

export type OverlayVisibility = 'ACTIVE' | 'DOCKED' | 'PAUSED' | 'HIDDEN' | 'NONE';
const VISIBILITIES: readonly OverlayVisibility[] = ['ACTIVE', 'DOCKED', 'PAUSED', 'HIDDEN', 'NONE'];

export type RuntimeState = 'STOPPED' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'FAILED' | 'PERMISSION_BLOCKED' | 'RECOVERING';

export interface RuntimeStatus {
  eventId: string;
  serviceInstanceId: string | null;
  revision: number;
  monotonicTimestampNanos: number;
  state: RuntimeState;
  reason: string | null;
}

const RUNTIME_STATES: readonly RuntimeState[] = [
  'STOPPED', 'STARTING', 'RUNNING', 'STOPPING', 'FAILED', 'PERMISSION_BLOCKED', 'RECOVERING',
];

export interface OverlayStatus {
  runtime: RuntimeStatus | null;
  running: boolean;
  windowShown: boolean;
  pageReady: boolean;
  visibility: OverlayVisibility;
  overlayPermission: boolean;
  notificationPermission: boolean;
  desiredRunning: boolean;
  hiddenUntilMs: number;
  killed: boolean;
}

export interface SettingsValues {
  roaming_level: RoamingLevel;
  keep_after_close: boolean;
  hide_in_fullscreen: boolean;
  quiet_hours_enabled: boolean;
  quiet_hours_start: number;
  quiet_hours_end: number;
  roaming_enabled: boolean;
  hidden_until_ms: number;
  proactive: boolean;
  share_system_with_remote: boolean;
}

export interface KillNotice {
  atMs: number;
  path: string;
}

export interface HelloInfo {
  mode: Mode;
  proactive: boolean;
  version: string;
  sdk: number;
  overlay: OverlayStatus;
  settings: SettingsValues;
  killNotice: KillNotice | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function parseRuntimeStatus(raw: unknown): RuntimeStatus | null {
  if (!isObject(raw) || !(RUNTIME_STATES as readonly unknown[]).includes(raw.state)) return null;
  return {
    eventId: typeof raw.eventId === 'string' ? raw.eventId : '',
    serviceInstanceId: typeof raw.serviceInstanceId === 'string' ? raw.serviceInstanceId : null,
    revision: Math.max(0, num(raw.revision, 0)),
    monotonicTimestampNanos: Math.max(0, num(raw.monotonicTimestampNanos, 0)),
    state: raw.state as RuntimeState,
    reason: typeof raw.reason === 'string' ? raw.reason : null,
  };
}

export function parseOverlayStatus(raw: unknown): OverlayStatus {
  const p: Record<string, unknown> = isObject(raw) ? raw : {};
  const runtime = parseRuntimeStatus(p.runtime);
  const visibility = (VISIBILITIES as readonly unknown[]).includes(p.visibility) ? (p.visibility as OverlayVisibility) : 'NONE';
  const running = runtime ? runtime.state === 'RUNNING' : bool(p.running, false);
  return {
    runtime,
    running,
    windowShown: bool(p.windowShown, false),
    pageReady: bool(p.pageReady, false),
    visibility,
    overlayPermission: bool(p.overlayPermission, false),
    notificationPermission: bool(p.notificationPermission, false),
    desiredRunning: bool(p.desiredRunning, false),
    hiddenUntilMs: Math.max(0, num(p.hiddenUntilMs, 0)),
    killed: bool(p.killed, false),
  };
}

export function parseSettings(raw: unknown): SettingsValues {
  const p: Record<string, unknown> = isObject(raw) ? raw : {};
  const level = (ROAMING_LEVELS as readonly unknown[]).includes(p.roaming_level) ? (p.roaming_level as RoamingLevel) : 'CALM';
  return {
    roaming_level: level,
    keep_after_close: bool(p.keep_after_close, false),
    hide_in_fullscreen: bool(p.hide_in_fullscreen, true),
    quiet_hours_enabled: bool(p.quiet_hours_enabled, false),
    quiet_hours_start: clampMinute(num(p.quiet_hours_start, 23 * 60)),
    quiet_hours_end: clampMinute(num(p.quiet_hours_end, 7 * 60)),
    roaming_enabled: bool(p.roaming_enabled, true),
    hidden_until_ms: Math.max(0, num(p.hidden_until_ms, 0)),
    proactive: bool(p.proactive, false),
    share_system_with_remote: bool(p.share_system_with_remote, false),
  };
}

export function parseKillNotice(raw: unknown): KillNotice | null {
  if (!isObject(raw)) return null;
  return { atMs: Math.max(0, num(raw.atMs, 0)), path: typeof raw.path === 'string' ? raw.path : 'external' };
}

export function parseHello(raw: Payload): HelloInfo {
  const mode = (MODES as readonly unknown[]).includes(raw.mode) ? (raw.mode as Mode) : 'OBSERVE';
  return {
    mode,
    proactive: bool(raw.proactive, false),
    version: typeof raw.version === 'string' ? raw.version : '',
    sdk: num(raw.sdk, 0),
    overlay: parseOverlayStatus(raw.overlay),
    settings: parseSettings(raw.settings),
    killNotice: parseKillNotice(raw.killNotice),
  };
}

// ---- calls ---------------------------------------------------------------------------------

/** The dashboard's hello. The answer carries the whole current state, so screens use it to refresh. */
export async function getHello(): Promise<HelloInfo> {
  return parseHello(await request('hello', { role: 'dashboard' }));
}

export interface StartResult {
  started: boolean;
  needsOverlayPermission: boolean;
  status: OverlayStatus;
}

export async function startOverlay(): Promise<StartResult> {
  const p = await request('overlay.start');
  return { started: p.started === true, needsOverlayPermission: p.needs === 'overlay_permission', status: parseOverlayStatus(p) };
}

export async function stopOverlay(): Promise<OverlayStatus> {
  return parseOverlayStatus(await request('overlay.stop'));
}

export async function requestOverlayPermission(): Promise<void> {
  await request('overlay.requestPermission');
}

export async function setSetting(key: keyof SettingsValues, value: boolean | number | string): Promise<SettingsValues> {
  const p = await request('settings.set', { key, value });
  return parseSettings(p.settings);
}

export async function setMode(mode: Mode): Promise<Mode> {
  const p = await request('permissions.setMode', { mode });
  return (MODES as readonly unknown[]).includes(p.mode) ? (p.mode as Mode) : 'OBSERVE';
}

export async function requestKill(): Promise<void> {
  await request('kill.request');
}

export async function ackKillNotice(): Promise<void> {
  await request('kill.ackNotice');
}

export async function openMetadataWatcher(): Promise<void> {
  await request('app.openMetadataWatcher');
}

// ---- text helpers (pure) -------------------------------------------------------------------

/**
 * Words for a failed native call, or null when nothing should be shown: "cancelled" means the owner
 * tapped Cancel in a native dialog, which is an answer and not an error.
 */
export function describeError(error: unknown): string | null {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : '';
  if (code === 'cancelled') return null;
  if (code === 'unavailable') return 'Open this in the Miss Minutes app.';
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong.';
}

export function clampMinute(minute: number): number {
  const whole = Math.round(minute);
  return whole >= 0 && whole < 24 * 60 ? whole : 0;
}

/** 1380 becomes "23:00". */
export function formatMinutes(minute: number): string {
  const m = clampMinute(minute);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** "23:00" becomes 1380; null when the text is not a time of day. */
export function parseTimeInput(text: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

const defaultClock = (ms: number): string =>
  new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(ms));

export type Tone = 'ok' | 'warn' | 'idle';

export interface OverlayDescription {
  headline: string;
  detail: string;
  tone: Tone;
  /** Show the "Allow Display over other apps" button. */
  needsOverlayPermission: boolean;
  /** Show a "Show her now" button: she is hidden by "hide for an hour". */
  hiddenByTimer: boolean;
  /** Tell the owner the notification Stop button is not visible. */
  notificationsOff: boolean;
}

/** What Home says about her overlay, from native facts only. `now` and `clock` are injectable for tests. */
export function describeOverlay(status: OverlayStatus, now: number = Date.now(), clock: (ms: number) => string = defaultClock): OverlayDescription {
  const base = {
    needsOverlayPermission: false,
    hiddenByTimer: false,
    notificationsOff: !status.notificationPermission,
  };
  switch (status.runtime?.state) {
    case 'STARTING':
      return { ...base, headline: 'Starting Miss Minutes', detail: 'Android accepted the start request. Waiting for the foreground service and overlay to become ready.', tone: 'idle' };
    case 'STOPPING':
      return { ...base, headline: 'Stopping Miss Minutes', detail: 'The foreground service is shutting down.', tone: 'idle' };
    case 'RECOVERING':
      return { ...base, headline: 'Reconnecting Miss Minutes', detail: 'The companion service is recovering after process interruption.', tone: 'idle' };
    case 'FAILED':
      return { ...base, headline: 'Miss Minutes could not start', detail: status.runtime.reason ?? 'The Android service reported a startup failure.', tone: 'warn' };
    case 'PERMISSION_BLOCKED':
      return {
        ...base,
        headline: 'Display permission required',
        detail: status.runtime.reason ?? 'Android blocked the overlay service because a required permission is missing.',
        tone: 'warn',
        needsOverlayPermission: true,
      };
    default:
      break;
  }
  if (!status.running) {
    if (!status.overlayPermission) {
      return {
        ...base,
        headline: 'She can only live inside the app',
        detail: 'Allow Display over other apps and she can walk around your screen.',
        tone: 'warn',
        needsOverlayPermission: true,
      };
    }
    if (status.killed) {
      return { ...base, headline: 'Stopped', detail: 'She stays off until you turn her on.', tone: 'idle' };
    }
    return { ...base, headline: 'She is not on your screen', detail: 'Turn her on to let her roam.', tone: 'idle' };
  }
  if (!status.pageReady) {
    return { ...base, headline: 'Starting', detail: 'Loading her picture.', tone: 'idle' };
  }
  switch (status.visibility) {
    case 'DOCKED':
      return { ...base, headline: 'She is standing still on your screen', detail: 'Roaming is off or set to Docked.', tone: 'ok' };
    case 'PAUSED':
      return { ...base, headline: 'Paused', detail: 'She rests while the screen is off or locked.', tone: 'idle' };
    case 'HIDDEN': {
      if (status.hiddenUntilMs > now) {
        return { ...base, headline: `Hidden until ${clock(status.hiddenUntilMs)}`, detail: 'You asked her to step aside for a while.', tone: 'idle', hiddenByTimer: true };
      }
      return { ...base, headline: 'Hidden for now', detail: 'Quiet hours or a very low battery keep her off the screen.', tone: 'idle' };
    }
    case 'ACTIVE':
      return { ...base, headline: 'She is on your screen', detail: 'Touch and hold her for a menu with a Stop button.', tone: 'ok' };
    default:
      return { ...base, headline: 'Starting', detail: 'Getting ready.', tone: 'idle' };
  }
}

const NOTICE_SOURCE: Readonly<Record<string, string>> = {
  'notification': 'by the Stop button in the notification',
  'app-button': 'by the Stop button in the app',
  'overlay-menu': 'from her menu',
  'external': 'from outside the app',
};

/** The banner shown after a kill, until the owner acknowledges it. */
export function describeKillNotice(notice: KillNotice, clock: (ms: number) => string = defaultClock): string {
  const source = NOTICE_SOURCE[notice.path] ?? NOTICE_SOURCE.external;
  const when = notice.atMs > 0 ? ` at ${clock(notice.atMs)}` : '';
  return `Miss Minutes was stopped${when} ${source}. She is in Observe mode with her own reactions off, and nothing runs until you say so.`;
}

export const MODE_DETAILS: Readonly<Record<Mode, { label: string; text: string }>> = {
  OBSERVE: { label: 'Observe', text: 'She watches and answers. Nothing runs unless you tap it.' },
  SUGGEST: { label: 'Suggest', text: 'Low-risk helpers such as timers and notes run by themselves. Anything else asks first.' },
  AUTHORIZED: { label: 'Authorized', text: 'She may use what you have granted without asking each time, up to 20 automatic actions an hour.' },
};

export const LEVEL_DETAILS: Readonly<Record<RoamingLevel, { label: string; text: string }>> = {
  DOCKED: { label: 'Docked', text: 'Stays in one spot and does small gestures.' },
  CALM: { label: 'Calm', text: 'Walks along the bottom of the screen and hops now and then.' },
  LIVELY: { label: 'Lively', text: 'Adds running, sitting on edges, hanging and climbing once her body can draw them.' },
  WILD: { label: 'Wild', text: 'Adds jumps and peeking, with shorter pauses between moves.' },
};

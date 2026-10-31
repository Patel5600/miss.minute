/**
 * The alarm clock: fires timers, alarms, reminders and event starts.
 *
 * - One window leads (Web Locks), so several tabs or the overlay never fire the same alert twice.
 * - A 1 s tick (worker-driven when possible) plus wake-up hooks. After sleep or a frozen tab it
 *   catches up: anything due in the last 10 minutes fires late; older alerts are recorded as
 *   missed without a sound.
 * - Recurring reminders and alarms roll forward when they fire; one-off alarms switch off;
 *   one-off reminders stay overdue until done or snoozed.
 * - Desktop: the next 48 h of alerts are synced to the host (schedule_sync), which shows the
 *   notification and makes the avatar speak even while the dashboard is hidden. For alerts the
 *   host was told about, this side only updates state, so nothing fires twice.
 *
 * Mount it once, in the dashboard window.
 */
import type { CharacterCue } from '../types';
import { invokeNative, isDesktopRuntime } from '../desktop/bridge';
import { getRecord, listAll, logActivity, onDbChange, putRecord, type ScheduleItem, type TimerRecord } from '../store/db';
import { playAlertChime, showSystemNotification } from './notify';
import { dueEventOccurrence, nextEventAlert, nextFireAt, nextOccurrenceAfter, occurrenceStarts } from './tools/agenda';
import { errorMessage } from './tools/args';
import { recurrenceText, setScheduleDone, snoozeScheduleItem } from './tools/schedule';
import { HOUR, MINUTE, formatDuration, formatTime } from './tools/time';
import { addTimerTime, clearTimer } from './tools/timers';

export type AlertKind = 'timer' | 'alarm' | 'reminder' | 'event';

export interface SchedulerAlert {
  /** Stable per occurrence: `${kind}:${itemId}:${dueAt}` (the same id the host receives). */
  id: string;
  kind: AlertKind;
  /** Timer id or schedule item id. */
  itemId: string;
  title: string;
  body: string;
  /** What Miss Minutes says. */
  speech: string;
  cue: CharacterCue;
  dueAt: number;
  firedAt: number;
  /** Fired during catch-up (more than a minute late, at most ten). */
  late: boolean;
  /** Older than ten minutes when noticed: recorded, not announced. */
  missed: boolean;
  /** 'host' when the desktop app already showed the notification and spoke. */
  deliveredBy: 'web' | 'host';
  /** Reminders and alarms can be snoozed; timers can be restarted (see snoozeAlert). */
  snoozable: boolean;
}

export interface SchedulerOptions {
  /** Speak through the current voice and move the character. Not called for host-delivered or missed alerts. */
  speak(text: string, cue: CharacterCue): void;
  /** Every fired or missed alert, for an in-app banner. */
  onAlert(alert: SchedulerAlert): void;
}

/** Shape expected by `schedule_sync` (native/desktop/src-tauri/src/scheduler.rs). */
interface HostAlert {
  id: string;
  title: string;
  body: string;
  kind: AlertKind;
  atUnixMs: number;
  speech: string;
}

const CATCH_UP_MS = 10 * MINUTE;
const LATE_MS = MINUTE;
const HOST_HORIZON_MS = 48 * HOUR;
const HOST_RESYNC_MS = 10 * MINUTE;
const MAX_HOST_ALERTS = 200;
const LOCK_NAME = 'miss-minutes-scheduler';

// ── Alert wording ───────────────────────────────────────────────────────────────────────

interface Copy {
  title: string;
  body: string;
  speech: string;
  cue: CharacterCue;
}

function timerCopy(timer: TimerRecord): Copy {
  const label = timer.label.trim();
  const name = label ? `${label} timer` : `${formatDuration(timer.durationMs)} timer`;
  return {
    title: label ? `Timer done: ${label}` : 'Timer done',
    body: `${formatDuration(timer.durationMs)} timer finished at ${formatTime(timer.endsAt)}`,
    speech: `Ding ding! Your ${name} is done, sugar.`,
    cue: { emotion: 'surprised', gesture: 'knock' },
  };
}

function itemCopy(item: ScheduleItem, at: number): Copy {
  const time = formatTime(at);
  if (item.kind === 'alarm') {
    const labelled = item.title.trim() && item.title !== 'Alarm';
    return {
      title: labelled ? `Alarm: ${item.title}` : `Alarm ${time}`,
      body: labelled ? `${time}${item.recurrence === 'none' ? '' : `, ${recurrenceText(item.recurrence, item.startAt)}`}` : 'Time to get moving.',
      speech: labelled ? `It's ${time}, sugar. ${item.title}!` : `Rise and shine, it's ${time}!`,
      cue: { emotion: 'cheerful', gesture: 'wave' },
    };
  }
  if (item.kind === 'event') {
    const end = item.endAt !== undefined ? at + (item.endAt - item.startAt) : undefined;
    return {
      title: `Starting now: ${item.title}`,
      body: `${time}${end !== undefined && end > at ? ` to ${formatTime(end)}` : ''}${item.location ? `, ${item.location}` : ''}`,
      speech: `${item.title} is starting now${item.location ? ` at ${item.location}` : ''}.`,
      cue: { emotion: 'cheerful', gesture: 'present' },
    };
  }
  return {
    title: `Reminder: ${item.title}`,
    body: item.notes?.trim() || `Due ${time}`,
    speech: `Friendly reminder, sugar: ${item.title}.`,
    cue: { emotion: 'talking', gesture: 'point' },
  };
}

function lateSpeech(copy: Copy, dueAt: number): Copy {
  return {
    ...copy,
    speech: `I'm a little late with this one, it was due at ${formatTime(dueAt)}. ${copy.speech}`,
    cue: { emotion: 'worried', gesture: 'shrug' },
  };
}

function hostAlert(kind: AlertKind, itemId: string, at: number, copy: Copy): HostAlert {
  return { id: `${kind}:${itemId}:${at}`, title: copy.title, body: copy.body, kind, atUnixMs: at, speech: copy.speech };
}

/** Upcoming alerts in (now, until], as the host's alarm clock needs them. */
async function upcomingAlerts(now: number, until: number): Promise<HostAlert[]> {
  const [timers, items] = await Promise.all([listAll('timers'), listAll('schedule')]);
  const out: HostAlert[] = [];
  for (const timer of timers) {
    if (timer.state === 'running' && timer.endsAt > now && timer.endsAt <= until) {
      out.push(hostAlert('timer', timer.id, timer.endsAt, timerCopy(timer)));
    }
  }
  for (const item of items) {
    if (item.done) continue;
    if (item.kind === 'event') {
      if (item.allDay) continue;
      const floor = Math.max(item.lastFiredAt ?? Number.NEGATIVE_INFINITY, item.createdAt - MINUTE);
      for (const start of occurrenceStarts(item.startAt, item.recurrence, now + 1, until + 1, { limit: 20 })) {
        if (start > floor) out.push(hostAlert('event', item.id, start, itemCopy(item, start)));
      }
      continue;
    }
    const times = new Set<number>();
    const pending = nextFireAt(item);
    if (pending !== undefined && pending > now && pending <= until) times.add(pending);
    if (item.recurrence !== 'none') {
      for (const start of occurrenceStarts(item.startAt, item.recurrence, now + 1, until + 1, { limit: 20 })) {
        // The current occurrence counts unless a snooze postponed it past its own time.
        const valid = start > item.startAt || pending === undefined || pending <= item.startAt;
        if (valid && start > (item.lastFiredAt ?? Number.NEGATIVE_INFINITY)) times.add(start);
      }
    }
    for (const at of times) out.push(hostAlert(item.kind, item.id, at, itemCopy(item, at)));
  }
  return out.sort((a, b) => a.atUnixMs - b.atUnixMs).slice(0, MAX_HOST_ALERTS);
}

// ── Scheduler ────────────────────────────────────────────────────────────────────────────

export function startScheduler(options: SchedulerOptions): () => void {
  const desktop = isDesktopRuntime();
  let stopped = false;
  let leader = false;
  let scanning = false;
  let rescan = false;
  let dirty = true;
  let nextDueAt = 0;
  let lastTick = Date.now();
  const cleanups: Array<() => void> = [];

  // Desktop host sync state.
  let hostIds = new Set<string>();
  let hostHealthy = false;
  let warnedSync = false;
  let syncTimer: ReturnType<typeof setTimeout> | undefined;
  let syncing = false;
  let resync = false;

  const lockAbort = new AbortController();
  let releaseLock: (() => void) | undefined;

  function deliver(alert: SchedulerAlert): void {
    const announce = !alert.missed && alert.deliveredBy === 'web';
    if (announce) {
      playAlertChime(alert.kind);
      showSystemNotification(alert.title, alert.body, alert.id);
      try {
        options.speak(alert.speech, alert.cue);
      } catch (error) {
        console.warn('[scheduler] speak failed:', errorMessage(error));
      }
    }
    const suffix = alert.missed
      ? ` (due ${formatTime(alert.dueAt)})`
      : alert.late
        ? ` (${formatDuration(alert.firedAt - alert.dueAt)} late)`
        : alert.deliveredBy === 'host' ? ' (desktop alarm clock)' : '';
    void logActivity('alarm', `${alert.missed ? 'Missed: ' : ''}${alert.title}${suffix}`, {
      kind: alert.kind, itemId: alert.itemId, dueAt: alert.dueAt, late: alert.late, missed: alert.missed, deliveredBy: alert.deliveredBy,
    }).catch(() => undefined);
    try {
      options.onAlert(alert);
    } catch (error) {
      console.warn('[scheduler] onAlert failed:', errorMessage(error));
    }
  }

  function makeAlert(kind: AlertKind, itemId: string, dueAt: number, now: number, copy: Copy, snoozable: boolean): SchedulerAlert {
    const id = `${kind}:${itemId}:${dueAt}`;
    const byHost = desktop && hostHealthy && hostIds.has(id);
    const late = !byHost && now - dueAt > LATE_MS;
    const missed = !byHost && now - dueAt > CATCH_UP_MS;
    const words = late && !missed ? lateSpeech(copy, dueAt) : copy;
    return {
      id, kind, itemId, title: words.title, body: words.body, speech: words.speech, cue: words.cue,
      dueAt, firedAt: now, late, missed, deliveredBy: byHost ? 'host' : 'web', snoozable,
    };
  }

  async function fireTimer(timer: TimerRecord, now: number): Promise<SchedulerAlert | undefined> {
    const fresh = await getRecord('timers', timer.id);
    if (!fresh || fresh.state !== 'running' || fresh.endsAt > now) return undefined;
    await putRecord('timers', { ...fresh, state: 'done', firedAt: now, remainingMs: 0 });
    return makeAlert('timer', fresh.id, fresh.endsAt, now, timerCopy(fresh), true);
  }

  async function fireItem(item: ScheduleItem, at: number, now: number): Promise<SchedulerAlert | undefined> {
    const fresh = await getRecord('schedule', item.id);
    if (!fresh || fresh.updatedAt !== item.updatedAt) return undefined;
    const next: ScheduleItem = { ...fresh, lastFiredAt: now, snoozedUntil: undefined, updatedAt: now };
    if (fresh.recurrence !== 'none') {
      if (fresh.startAt <= now) next.startAt = nextOccurrenceAfter(fresh.startAt, fresh.recurrence, now) ?? fresh.startAt;
    } else if (fresh.kind === 'alarm') {
      next.done = true;
    }
    await putRecord('schedule', next);
    return makeAlert(fresh.kind, fresh.id, at, now, itemCopy(fresh, at), true);
  }

  async function fireEvent(item: ScheduleItem, due: number, now: number): Promise<SchedulerAlert | undefined> {
    const fresh = await getRecord('schedule', item.id);
    if (!fresh || fresh.updatedAt !== item.updatedAt) return undefined;
    // Bookkeeping only: updatedAt stays, because the owner did not change the event.
    await putRecord('schedule', { ...fresh, lastFiredAt: due });
    const alert = makeAlert('event', fresh.id, due, now, itemCopy(fresh, due), false);
    // A missed event start is not worth a "missed" notice; the event itself is on the calendar.
    return alert.missed ? undefined : alert;
  }

  async function scanOnce(): Promise<void> {
    const now = Date.now();
    const [timers, items] = await Promise.all([listAll('timers'), listAll('schedule')]);
    let next = Number.POSITIVE_INFINITY;
    const fired: SchedulerAlert[] = [];
    for (const timer of timers) {
      if (timer.state !== 'running') continue;
      if (timer.endsAt > now) {
        next = Math.min(next, timer.endsAt);
        continue;
      }
      const alert = await fireTimer(timer, now);
      if (alert) fired.push(alert);
    }
    for (const item of items) {
      if (item.kind === 'event') {
        const due = dueEventOccurrence(item, now);
        if (due !== undefined) {
          const alert = await fireEvent(item, due, now);
          if (alert) fired.push(alert);
        }
        const upcoming = nextEventAlert(item, now);
        if (upcoming !== undefined) next = Math.min(next, upcoming);
        continue;
      }
      const at = nextFireAt(item);
      if (at === undefined) continue;
      if (at > now) {
        next = Math.min(next, at);
        continue;
      }
      const alert = await fireItem(item, at, now);
      if (alert) fired.push(alert);
    }
    nextDueAt = next;
    fired.sort((a, b) => a.dueAt - b.dueAt).forEach(deliver);
    if (fired.length > 0) requestSync();
  }

  async function scan(): Promise<void> {
    if (scanning) {
      rescan = true;
      return;
    }
    scanning = true;
    try {
      do {
        rescan = false;
        dirty = false;
        await scanOnce();
      } while (rescan && !stopped && leader);
    } catch (error) {
      dirty = true;
      console.warn('[scheduler] scan failed:', errorMessage(error));
    } finally {
      scanning = false;
    }
  }

  function tick(): void {
    if (stopped || !leader) return;
    const now = Date.now();
    const jumped = now - lastTick > 5000;
    lastTick = now;
    if (jumped && desktop) requestSync(0);
    if (dirty || jumped || now >= nextDueAt) void scan();
  }

  async function syncHost(): Promise<void> {
    if (syncing) {
      resync = true;
      return;
    }
    syncing = true;
    try {
      do {
        resync = false;
        const now = Date.now();
        const alerts = await upcomingAlerts(now, now + HOST_HORIZON_MS);
        await invokeNative<void>('schedule_sync', { alerts });
        hostIds = new Set(alerts.map(alert => alert.id));
        hostHealthy = true;
        warnedSync = false;
      } while (resync && !stopped);
    } catch (error) {
      hostHealthy = false;
      if (!warnedSync) console.warn('[scheduler] schedule_sync failed; alerts will fire from this window instead:', errorMessage(error));
      warnedSync = true;
    } finally {
      syncing = false;
    }
  }

  function requestSync(delay = 400): void {
    if (!desktop || stopped || !leader) return;
    if (syncTimer !== undefined) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncTimer = undefined;
      void syncHost();
    }, delay);
  }

  function startTicking(): void {
    let worker: Worker | undefined;
    try {
      worker = new Worker(new URL('./tools/schedulerTick.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = tick;
      worker.onerror = () => {
        worker?.terminate();
        worker = undefined;
      };
    } catch {
      worker = undefined;
    }
    // The interval also covers environments where the worker cannot start (strict CSP, tests).
    const interval = setInterval(() => {
      if (!worker) tick();
    }, 1000);
    const resync = setInterval(() => requestSync(0), HOST_RESYNC_MS);
    const wake = () => {
      dirty = true;
      tick();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') wake();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', wake);
    window.addEventListener('pageshow', wake);
    window.addEventListener('online', wake);
    const stopSchedule = onDbChange('schedule', () => {
      dirty = true;
      requestSync();
    });
    const stopTimers = onDbChange('timers', () => {
      dirty = true;
      requestSync();
    });
    cleanups.push(() => {
      worker?.terminate();
      clearInterval(interval);
      clearInterval(resync);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', wake);
      window.removeEventListener('pageshow', wake);
      window.removeEventListener('online', wake);
      stopSchedule();
      stopTimers();
    });
  }

  async function becomeLeader(): Promise<void> {
    if (stopped) return;
    leader = true;
    if (desktop) {
      // Tell the host what is coming before the first scan, so the two never both announce.
      await Promise.race([syncHost(), new Promise(resolve => setTimeout(resolve, 3000))]);
      if (stopped) return;
    }
    startTicking();
    dirty = true;
    tick();
  }

  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (locks && typeof locks.request === 'function') {
    locks
      .request(LOCK_NAME, { signal: lockAbort.signal }, () => new Promise<void>(resolve => {
        if (stopped) {
          resolve();
          return;
        }
        releaseLock = resolve;
        void becomeLeader();
      }))
      .catch(() => undefined);
  } else {
    void becomeLeader();
  }

  return () => {
    stopped = true;
    leader = false;
    lockAbort.abort();
    releaseLock?.();
    if (syncTimer !== undefined) clearTimeout(syncTimer);
    cleanups.splice(0).forEach(cleanup => cleanup());
  };
}

// ── Actions for an alert banner ──────────────────────────────────────────────────────────

/** Snoozes a reminder or alarm, or restarts a finished timer, for `minutes`. */
export async function snoozeAlert(alert: Pick<SchedulerAlert, 'kind' | 'itemId'>, minutes = 10): Promise<void> {
  if (alert.kind === 'timer') await addTimerTime(alert.itemId, minutes * MINUTE);
  else if (alert.kind === 'reminder' || alert.kind === 'alarm') await snoozeScheduleItem(alert.itemId, minutes);
}

/** Marks a one-off reminder done, or clears a finished timer. Alarms and events need nothing. */
export async function completeAlert(alert: Pick<SchedulerAlert, 'kind' | 'itemId'>): Promise<void> {
  if (alert.kind === 'timer') {
    await clearTimer(alert.itemId);
  } else if (alert.kind === 'reminder') {
    const item = await getRecord('schedule', alert.itemId);
    if (item && item.recurrence === 'none' && !item.done) await setScheduleDone(item.id, true);
  }
}

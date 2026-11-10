/**
 * Countdown timers: set_timer, list_timers, control_timer, plus the domain functions the
 * Toolbelt panel uses so both paths share one set of rules. The scheduler fires them.
 */
import { getRecord, listAll, newId, putRecord, deleteRecord, type TimerRecord } from '../../store/db';
import { primeNotifications } from '../notify';
import { ToolInputError, optionalNumber, optionalText, requiredEnum, requiredNumber } from './args';
import { makeTool } from './define';
import { findRecord } from './lookup';
import { HOUR, SECOND, clock24, formatCountdown, formatDuration, formatTime } from './time';

export const MAX_TIMER_MS = 24 * HOUR;

export function timerName(timer: Pick<TimerRecord, 'label' | 'durationMs'>): string {
  return timer.label.trim() || `${formatDuration(timer.durationMs)} timer`;
}

export function timerRemaining(timer: TimerRecord, now = Date.now()): number {
  if (timer.state === 'paused') return Math.max(0, timer.remainingMs ?? 0);
  if (timer.state === 'running') return Math.max(0, timer.endsAt - now);
  return 0;
}

export function isActiveTimer(timer: TimerRecord): boolean {
  return timer.state === 'running' || timer.state === 'paused';
}

function checkDuration(ms: number): void {
  if (!Number.isFinite(ms) || ms < SECOND) throw new ToolInputError('A timer needs at least 1 second.');
  if (ms > MAX_TIMER_MS) throw new ToolInputError('Timers can run for at most 24 hours. Use add_reminder for anything longer.');
}

export async function createTimer(durationMs: number, label = ''): Promise<TimerRecord> {
  checkDuration(durationMs);
  const now = Date.now();
  const timer: TimerRecord = {
    id: newId(),
    label: label.trim().slice(0, 80),
    durationMs: Math.round(durationMs),
    startedAt: now,
    endsAt: now + Math.round(durationMs),
    state: 'running',
    createdAt: now,
  };
  await putRecord('timers', timer);
  void primeNotifications();
  return timer;
}

async function load(id: string): Promise<TimerRecord> {
  const timer = await getRecord('timers', id);
  if (!timer) throw new ToolInputError('That timer no longer exists.');
  return timer;
}

export async function pauseTimer(id: string): Promise<TimerRecord> {
  const timer = await load(id);
  if (timer.state === 'paused') return timer;
  if (timer.state !== 'running') throw new ToolInputError(`"${timerName(timer)}" is not running (it is ${timer.state}).`);
  const next: TimerRecord = { ...timer, state: 'paused', remainingMs: Math.max(0, timer.endsAt - Date.now()) };
  return putRecord('timers', next);
}

export async function resumeTimer(id: string): Promise<TimerRecord> {
  const timer = await load(id);
  if (timer.state === 'running') return timer;
  if (timer.state !== 'paused') throw new ToolInputError(`"${timerName(timer)}" cannot be resumed (it is ${timer.state}).`);
  const remaining = Math.max(SECOND, timer.remainingMs ?? 0);
  const next: TimerRecord = { ...timer, state: 'running', endsAt: Date.now() + remaining, remainingMs: undefined };
  return putRecord('timers', next);
}

export async function cancelTimer(id: string): Promise<TimerRecord> {
  const timer = await load(id);
  if (timer.state === 'cancelled') return timer;
  if (timer.state === 'done') throw new ToolInputError(`"${timerName(timer)}" already finished.`);
  return putRecord('timers', { ...timer, state: 'cancelled', remainingMs: timerRemaining(timer) });
}

/** Adds time to a running or paused timer. A finished timer restarts with the added time. */
export async function addTimerTime(id: string, ms: number): Promise<TimerRecord> {
  checkDuration(ms);
  const timer = await load(id);
  const now = Date.now();
  let next: TimerRecord;
  if (timer.state === 'running') {
    if (timer.endsAt - now + ms > MAX_TIMER_MS) throw new ToolInputError('That would run past 24 hours.');
    next = { ...timer, endsAt: timer.endsAt + ms, durationMs: timer.durationMs + ms };
  } else if (timer.state === 'paused') {
    const remaining = (timer.remainingMs ?? 0) + ms;
    if (remaining > MAX_TIMER_MS) throw new ToolInputError('That would run past 24 hours.');
    next = { ...timer, remainingMs: remaining, durationMs: timer.durationMs + ms };
  } else if (timer.state === 'done') {
    next = { ...timer, state: 'running', startedAt: now, endsAt: now + ms, durationMs: ms, firedAt: undefined, remainingMs: undefined };
  } else {
    throw new ToolInputError(`"${timerName(timer)}" was cancelled. Set a new timer instead.`);
  }
  return putRecord('timers', next);
}

/** Removes a finished or cancelled timer from the list. */
export async function clearTimer(id: string): Promise<void> {
  await deleteRecord('timers', id);
}

function modelView(timer: TimerRecord, now: number) {
  const remaining = timerRemaining(timer, now);
  return {
    id: timer.id,
    label: timerName(timer),
    state: timer.state,
    remaining: formatCountdown(remaining),
    remaining_seconds: Math.ceil(remaining / SECOND),
    ...(timer.state === 'running' ? { ends_at: clock24(timer.endsAt) } : {}),
    ...(timer.state === 'done' ? { finished_at: clock24(timer.firedAt ?? timer.endsAt) } : {}),
    duration: formatDuration(timer.durationMs),
  };
}

async function pickTimer(id: string | undefined, label: string | undefined, allowFinished: boolean): Promise<TimerRecord> {
  if (id) return findRecord('timers', id, { noun: 'timer', listTool: 'list_timers', nameOf: timerName });
  const now = Date.now();
  const all = await listAll('timers');
  const pool = all.filter(timer => isActiveTimer(timer) || (allowFinished && timer.state === 'done' && now - (timer.firedAt ?? timer.endsAt) < HOUR));
  const names = (timers: TimerRecord[]) => timers.map(timer => `"${timerName(timer)}" (${timer.id})`).join(', ');
  if (label) {
    const wanted = label.toLowerCase();
    const exact = pool.filter(timer => timerName(timer).toLowerCase() === wanted);
    const loose = exact.length > 0 ? exact : pool.filter(timer => timerName(timer).toLowerCase().includes(wanted));
    if (loose.length === 1) return loose[0];
    if (loose.length === 0) {
      throw new ToolInputError(pool.length > 0 ? `No active timer matches "${label}". Active: ${names(pool)}.` : 'There are no active timers.');
    }
    throw new ToolInputError(`Several timers match "${label}": ${names(loose)}. Pass the id.`);
  }
  const active = pool.filter(isActiveTimer);
  if (active.length === 1) return active[0];
  if (active.length === 0) {
    if (pool.length === 1) return pool[0];
    throw new ToolInputError('There are no active timers.');
  }
  throw new ToolInputError(`There are ${active.length} active timers: ${names(active)}. Pass id or label.`);
}

interface SetTimerArgs {
  durationMs: number;
  label?: string;
}

interface ControlArgs {
  action: 'pause' | 'resume' | 'cancel' | 'add_time';
  id?: string;
  label?: string;
  seconds?: number;
}

const ACTIONS = ['pause', 'resume', 'cancel', 'add_time'] as const;

export const timerTools = [
  makeTool<SetTimerArgs>({
    name: 'set_timer',
    description:
      'Starts a countdown timer that chimes, notifies and announces itself when it ends. Convert spoken '
      + 'durations to seconds (e.g. "2 and a half minutes" = 150). For a specific clock time use set_alarm or '
      + 'add_reminder instead. Returns the timer id and end time.',
    parameters: {
      type: 'object',
      properties: {
        duration_seconds: { type: 'integer', minimum: 1, maximum: 86400, description: 'Length in seconds (1 to 86400).' },
        label: { type: 'string', description: 'Short name, e.g. "tea" or "pasta".' },
      },
      required: ['duration_seconds'],
    },
    policy: 'auto',
    failure: "Couldn't set the timer",
    parse(args) {
      const seconds = requiredNumber(args, 'duration_seconds', { min: 1, max: 86400, round: true, unit: 'seconds' });
      return { durationMs: seconds * SECOND, label: optionalText(args, 'label', 80) };
    },
    describe(args) {
      return `Set a ${formatDuration(args.durationMs)} timer${args.label ? ` for ${args.label}` : ''}`;
    },
    async run(args) {
      const timer = await createTimer(args.durationMs, args.label);
      const name = args.label ? `${args.label} timer` : 'Timer';
      return {
        ok: true,
        summary: `${name} set for ${formatDuration(timer.durationMs)} (ends ${formatTime(timer.endsAt)})`,
        data: modelView(timer, timer.startedAt),
      };
    },
  }),

  makeTool<Record<string, never>>({
    name: 'list_timers',
    description: 'Lists running and paused timers with time left, plus timers that finished in the last hour.',
    parameters: { type: 'object', properties: {} },
    policy: 'auto',
    failure: "Couldn't list timers",
    parse: () => ({}),
    describe: () => 'List timers',
    async run() {
      const now = Date.now();
      const timers = (await listAll('timers'))
        .filter(timer => isActiveTimer(timer) || (timer.state === 'done' && now - (timer.firedAt ?? timer.endsAt) < HOUR))
        .sort((a, b) => timerRemaining(a, now) - timerRemaining(b, now) || b.createdAt - a.createdAt);
      const active = timers.filter(isActiveTimer);
      const summary = active.length === 0
        ? 'No timers running'
        : `${active.length} timer${active.length === 1 ? '' : 's'}: ${active.map(timer => `${timerName(timer)} ${formatCountdown(timerRemaining(timer, now))}${timer.state === 'paused' ? ' (paused)' : ''}`).join(', ')}`;
      return { ok: true, summary, data: { timers: timers.slice(0, 20).map(timer => modelView(timer, now)) } };
    },
  }),

  makeTool<ControlArgs>({
    name: 'control_timer',
    description:
      'Pauses, resumes, cancels or adds time to a timer. Identify it by id (from list_timers) or label; with '
      + 'neither, the only active timer is used. add_time needs seconds and also restarts a timer that just finished.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...ACTIONS], description: 'What to do.' },
        id: { type: 'string', description: 'Timer id from list_timers.' },
        label: { type: 'string', description: 'Timer label, if no id.' },
        seconds: { type: 'integer', minimum: 1, maximum: 86400, description: 'For add_time: seconds to add.' },
      },
      required: ['action'],
    },
    policy: 'auto',
    failure: "Couldn't change the timer",
    parse(args) {
      const action = requiredEnum(args, 'action', ACTIONS);
      const seconds = optionalNumber(args, 'seconds', { min: 1, max: 86400, round: true, unit: 'seconds' });
      if (action === 'add_time' && seconds === undefined) throw new ToolInputError("add_time needs 'seconds'.");
      if (action !== 'add_time' && seconds !== undefined) throw new ToolInputError(`'seconds' only applies to add_time.`);
      return { action, id: optionalText(args, 'id', 80), label: optionalText(args, 'label', 80), seconds };
    },
    describe(args) {
      const target = args.label ? `the ${args.label} timer` : args.id ? `timer ${args.id}` : 'the active timer';
      if (args.action === 'add_time') return `Add ${formatDuration((args.seconds ?? 0) * SECOND)} to ${target}`;
      return `${args.action[0].toUpperCase()}${args.action.slice(1)} ${target}`;
    },
    async run(args) {
      const target = await pickTimer(args.id, args.label, args.action === 'add_time');
      const name = timerName(target);
      let updated: TimerRecord;
      let summary: string;
      const now = Date.now();
      switch (args.action) {
        case 'pause':
          updated = await pauseTimer(target.id);
          summary = target.state === 'paused'
            ? `"${name}" was already paused (${formatCountdown(timerRemaining(updated, now))} left)`
            : `Paused "${name}" with ${formatDuration(timerRemaining(updated, now))} left`;
          break;
        case 'resume':
          updated = await resumeTimer(target.id);
          summary = target.state === 'running'
            ? `"${name}" is already running`
            : `Resumed "${name}" (ends ${formatTime(updated.endsAt)})`;
          break;
        case 'cancel':
          updated = await cancelTimer(target.id);
          summary = `Cancelled "${name}"`;
          break;
        default: {
          const ms = (args.seconds ?? 0) * SECOND;
          updated = await addTimerTime(target.id, ms);
          summary = target.state === 'done'
            ? `Restarted "${name}" for ${formatDuration(ms)} (ends ${formatTime(updated.endsAt)})`
            : `Added ${formatDuration(ms)} to "${name}" (${formatDuration(timerRemaining(updated, Date.now()))} left)`;
        }
      }
      return { ok: true, summary, data: modelView(updated, Date.now()) };
    },
  }),
];

/**
 * Miss Minutes' toolbelt: live timers, alarms, to-dos and notes, backed by the same domain
 * functions her tools use, so the panel and the chat always agree.
 */
import { useId, useMemo, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  AlarmClock, Hourglass, ListTodo, Pause, Pencil, Play, Plus, Save, Search, StickyNote, Timer, Trash, Wrench, X,
} from 'lucide-react';
import { useDbList, useNow } from '../store/useDb';
import type { NoteRecord, ScheduleItem, TimerRecord, TodoRecord } from '../store/db';
import { ToolInputError } from '../agent/tools/args';
import { evaluate } from '../agent/tools/calc';
import { createNote, deleteNote, searchNotes, updateNote } from '../agent/tools/notes';
import { ALARM_DAYS, createAlarm, deleteScheduleItem, nextAlarmTime, recurrenceText, setAlarmEnabled, type AlarmDays } from '../agent/tools/schedule';
import {
  HOUR, MINUTE, SECOND, endOfDayMs, formatCountdown, formatDue, formatDuration, formatTime, formatWhen, localDate, parseClock, parseDateTime,
} from '../agent/tools/time';
import { addTimerTime, cancelTimer, clearTimer, createTimer, pauseTimer, resumeTimer, timerName, timerRemaining } from '../agent/tools/timers';
import { PRIORITIES, createTodo, deleteTodo, setTodoDone, sortTodos, updateTodo, type Priority } from '../agent/tools/todos';
import { Button, ConfirmButton, Empty, ErrorLine, IconButton, MicroLabel, PanelShell, Tabs, focusRing, inputClass } from './ui';
import { useAction } from './useAction';

export interface ToolbeltProps {
  className?: string;
  defaultTab?: ToolbeltTab;
}

export type ToolbeltTab = 'timers' | 'alarms' | 'todos' | 'notes';

const RECENT_DONE_MS = 6 * HOUR;

// ── Timers ──────────────────────────────────────────────────────────────────────────────

/** "5" = 5 min, "4:30" = 4 min 30 s, "1:05:00" = 1 h 5 min, or units like "90s" / "1h 15m". */
function parseTimerInput(raw: string): number {
  const text = raw.trim().toLowerCase();
  if (!text) throw new ToolInputError('Enter a length, e.g. 5, 4:30 or 1h 15m.');
  let ms: number;
  const clock = /^(\d+):([0-5]\d)(?::([0-5]\d))?$/.exec(text);
  if (clock) {
    ms = clock[3] !== undefined
      ? (Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3])) * SECOND
      : (Number(clock[1]) * 60 + Number(clock[2])) * SECOND;
  } else if (/^\d+(\.\d+)?$/.test(text)) {
    ms = Number(text) * MINUTE;
  } else {
    const result = evaluate(text);
    if (result.kind !== 'duration' || result.seconds === undefined) throw new ToolInputError('Use a length like 5, 4:30 or 1h 15m.');
    ms = result.seconds * SECOND;
  }
  return Math.round(ms);
}

function TimerRow({ timer, now }: { timer: TimerRecord; now: number }) {
  const action = useAction();
  const remaining = timerRemaining(timer, now);
  const done = timer.state === 'done';
  const progress = done ? 1 : Math.min(1, Math.max(0, 1 - remaining / Math.max(1, timer.durationMs)));
  const name = timerName(timer);
  return (
    <li className={`rounded-lg border p-2.5 flex flex-col gap-1.5 ${done ? 'border-red-600/40 bg-red-950/25' : 'border-amber-700/40 bg-black/30'}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-amber-100 truncate">{name}</p>
          <p className="text-[10px] uppercase tracking-widest text-amber-500">
            {done ? `Done at ${formatTime(timer.firedAt ?? timer.endsAt)}` : timer.state === 'paused' ? 'Paused' : `Ends ${formatTime(timer.endsAt)}`}
            {' · '}{formatDuration(timer.durationMs)}
          </p>
        </div>
        <p
          className={`font-mono text-2xl tabular-nums ${done ? 'text-red-300' : timer.state === 'paused' ? 'text-amber-400/70' : 'text-amber-200'}`}
          aria-label={done ? `${name} finished` : `${formatDuration(remaining)} left`}
          role="timer"
        >
          {done ? '0:00' : formatCountdown(remaining)}
        </p>
      </div>
      <div className="h-1.5 rounded-full bg-black/60 overflow-hidden" aria-hidden="true">
        <div className={`h-full ${done ? 'bg-red-500' : timer.state === 'paused' ? 'bg-amber-700' : 'bg-amber-400'}`} style={{ width: `${progress * 100}%` }} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {timer.state === 'running' ? (
          <Button onClick={() => action.run(() => pauseTimer(timer.id))} disabled={action.busy} label={`Pause ${name}`}><Pause className="w-3 h-3" /> Pause</Button>
        ) : null}
        {timer.state === 'paused' ? (
          <Button onClick={() => action.run(() => resumeTimer(timer.id))} disabled={action.busy} label={`Resume ${name}`}><Play className="w-3 h-3" /> Resume</Button>
        ) : null}
        <Button onClick={() => action.run(() => addTimerTime(timer.id, MINUTE))} disabled={action.busy} label={done ? `Restart ${name} for 1 minute` : `Add 1 minute to ${name}`}>
          <Plus className="w-3 h-3" /> {done ? 'Restart 1 min' : '1 min'}
        </Button>
        {done ? (
          <Button tone="ghost" onClick={() => action.run(() => clearTimer(timer.id))} disabled={action.busy} label={`Clear ${name}`}><X className="w-3 h-3" /> Clear</Button>
        ) : (
          <Button tone="ghost" onClick={() => action.run(() => cancelTimer(timer.id))} disabled={action.busy} label={`Cancel ${name}`}><X className="w-3 h-3" /> Cancel</Button>
        )}
      </div>
      <ErrorLine message={action.error} />
    </li>
  );
}

const PRESETS = [1, 3, 5, 10, 15, 25, 60];

function TimersTab() {
  const ids = useId();
  const now = useNow(250);
  const action = useAction();
  const { data: timers = [], loading } = useDbList('timers');
  const [length, setLength] = useState('');
  const [label, setLabel] = useState('');
  const active = timers
    .filter(timer => timer.state === 'running' || timer.state === 'paused')
    .sort((a, b) => timerRemaining(a, now) - timerRemaining(b, now));
  const finished = timers
    .filter(timer => timer.state === 'done' && now - (timer.firedAt ?? timer.endsAt) < RECENT_DONE_MS)
    .sort((a, b) => (b.firedAt ?? b.endsAt) - (a.firedAt ?? a.endsAt));
  const stale = timers.filter(timer => timer.state === 'cancelled' || (timer.state === 'done' && now - (timer.firedAt ?? timer.endsAt) >= RECENT_DONE_MS));

  const start = (ms: number) => action.run(async () => {
    await createTimer(ms, label);
    setLength('');
    setLabel('');
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    action.run(async () => {
      await createTimer(parseTimerInput(length), label);
      setLength('');
      setLabel('');
    });
  };

  return (
    <div className="flex flex-col gap-2.5">
      <form onSubmit={submit} className="flex flex-col gap-2 bg-black/30 border border-amber-800/30 rounded-lg p-2.5" aria-label="Start a timer">
        <div className="flex flex-wrap gap-1" role="group" aria-label="Quick timers">
          {PRESETS.map(minutes => (
            <Button key={minutes} tone="ghost" onClick={() => start(minutes * MINUTE)} disabled={action.busy} label={`Start a ${minutes} minute timer`}>
              {minutes < 60 ? `${minutes}m` : '1h'}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-0.5 w-28">
            <MicroLabel htmlFor={`${ids}-length`}>Length</MicroLabel>
            <input id={`${ids}-length`} className={inputClass} value={length} onChange={event => setLength(event.target.value)} placeholder="4:30 or 1h 15m" />
          </div>
          <div className="flex flex-col gap-0.5 flex-1 min-w-[8rem]">
            <MicroLabel htmlFor={`${ids}-label`}>Label</MicroLabel>
            <input id={`${ids}-label`} className={inputClass} value={label} onChange={event => setLabel(event.target.value)} maxLength={80} placeholder="Tea, pasta, focus..." />
          </div>
          <Button type="submit" tone="solid" disabled={action.busy}><Timer className="w-3.5 h-3.5" /> Start</Button>
        </div>
        <ErrorLine message={action.error} />
      </form>
      {loading ? <Empty>Loading timers...</Empty> : null}
      {!loading && active.length === 0 && finished.length === 0 ? <Empty>No timers running. Pick a length above or ask Miss Minutes.</Empty> : null}
      <ul className="flex flex-col gap-2" aria-label="Timers">
        {[...active, ...finished].map(timer => <TimerRow key={timer.id} timer={timer} now={now} />)}
      </ul>
      {stale.length > 0 ? (
        <div className="flex justify-end">
          <Button tone="quiet" onClick={() => action.run(() => Promise.all(stale.map(timer => clearTimer(timer.id))))}>
            Clear {stale.length} old timer{stale.length === 1 ? '' : 's'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// ── Alarms ──────────────────────────────────────────────────────────────────────────────

const DAYS_LABEL: Record<AlarmDays, string> = { once: 'Once', daily: 'Daily', weekdays: 'Weekdays', weekly: 'Weekly' };

function AlarmRow({ alarm, now }: { alarm: ScheduleItem; now: number }) {
  const action = useAction();
  const enabled = !alarm.done;
  const snoozed = enabled && alarm.snoozedUntil !== undefined && alarm.snoozedUntil > now;
  const label = alarm.title !== 'Alarm' ? alarm.title : '';
  const name = `${formatTime(alarm.startAt)} alarm${label ? ` ${label}` : ''}`;
  return (
    <li className={`rounded-lg border p-2.5 flex items-center gap-3 ${enabled ? 'border-amber-700/40 bg-black/30' : 'border-neutral-800 bg-neutral-950/40'}`}>
      <div className="flex-1 min-w-0">
        <p className={`font-mono text-2xl tabular-nums ${enabled ? 'text-amber-200' : 'text-neutral-500'}`}>{formatTime(alarm.startAt)}</p>
        <p className="text-[11px] text-amber-100 truncate">{label || 'Alarm'}</p>
        <p className="text-[10px] uppercase tracking-widest text-amber-500">
          {recurrenceText(alarm.recurrence, alarm.startAt)}
          {enabled ? ` · ${snoozed ? `snoozed to ${formatTime(alarm.snoozedUntil ?? now)}` : `next ${formatWhen(alarm.startAt, now)}`}` : ' · off'}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={`${name} ${enabled ? 'on' : 'off'}`}
        onClick={() => action.run(() => setAlarmEnabled(alarm.id, !enabled))}
        disabled={action.busy}
        className={`relative w-10 h-5 rounded-full border transition-colors ${focusRing} ${enabled ? 'bg-amber-500/80 border-amber-300' : 'bg-neutral-800 border-neutral-600'}`}
      >
        <span className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-neutral-950 transition-all ${enabled ? 'left-5' : 'left-0.5'}`} />
      </button>
      <ConfirmButton iconOnly label={`Delete ${name}`} question="Delete?" confirmLabel="Delete" onConfirm={() => action.run(() => deleteScheduleItem(alarm.id))}>
        <Trash className="w-3.5 h-3.5" />
      </ConfirmButton>
      {action.error ? <span className="sr-only" role="alert">{action.error}</span> : null}
    </li>
  );
}

function AlarmsTab() {
  const ids = useId();
  const now = useNow(30_000);
  const action = useAction();
  const { data: alarms = [], loading } = useDbList('schedule', rows => rows.filter(item => item.kind === 'alarm'));
  const [time, setTime] = useState('07:00');
  const [label, setLabel] = useState('');
  const [days, setDays] = useState<AlarmDays>('once');
  const sorted = [...alarms].sort((a, b) => {
    const ta = new Date(a.startAt);
    const tb = new Date(b.startAt);
    return ta.getHours() * 60 + ta.getMinutes() - (tb.getHours() * 60 + tb.getMinutes()) || a.createdAt - b.createdAt;
  });
  const preview = useMemo(() => {
    try {
      const { hour, minute } = parseClock(time, 'time');
      const recurrence = days === 'once' ? 'none' : days;
      return `Rings ${formatWhen(nextAlarmTime(hour, minute, recurrence, now), now)}`;
    } catch {
      return '';
    }
  }, [time, days, now]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    action.run(async () => {
      const { hour, minute } = parseClock(time, 'time');
      await createAlarm({ hour, minute, label, days, source: 'manual' });
      setLabel('');
    });
  };

  return (
    <div className="flex flex-col gap-2.5">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2 bg-black/30 border border-amber-800/30 rounded-lg p-2.5" aria-label="Set an alarm">
        <div className="flex flex-col gap-0.5">
          <MicroLabel htmlFor={`${ids}-time`}>Time</MicroLabel>
          <input id={`${ids}-time`} type="time" className={inputClass} value={time} onChange={event => setTime(event.target.value)} required />
        </div>
        <div className="flex flex-col gap-0.5 flex-1 min-w-[8rem]">
          <MicroLabel htmlFor={`${ids}-label`}>Label</MicroLabel>
          <input id={`${ids}-label`} className={inputClass} value={label} onChange={event => setLabel(event.target.value)} maxLength={80} placeholder="Wake up, gym..." />
        </div>
        <div className="flex flex-col gap-0.5">
          <MicroLabel htmlFor={`${ids}-days`}>Repeat</MicroLabel>
          <select id={`${ids}-days`} className={inputClass} value={days} onChange={event => setDays(event.target.value as AlarmDays)}>
            {ALARM_DAYS.map(option => <option key={option} value={option}>{DAYS_LABEL[option]}</option>)}
          </select>
        </div>
        <Button type="submit" tone="solid" disabled={action.busy}><AlarmClock className="w-3.5 h-3.5" /> Set</Button>
        {preview ? <p className="w-full text-[10px] text-amber-400/70">{preview}</p> : null}
        <div className="w-full"><ErrorLine message={action.error} /></div>
      </form>
      {loading ? <Empty>Loading alarms...</Empty> : null}
      {!loading && sorted.length === 0 ? <Empty>No alarms set.</Empty> : null}
      <ul className="flex flex-col gap-2" aria-label="Alarms">
        {sorted.map(alarm => <AlarmRow key={alarm.id} alarm={alarm} now={now} />)}
      </ul>
    </div>
  );
}

// ── To-dos ──────────────────────────────────────────────────────────────────────────────

const PRIORITY_STYLE: Record<Priority, string> = {
  high: 'border-red-500/60 text-red-200 bg-red-950/40',
  normal: 'border-amber-600/50 text-amber-200 bg-amber-950/40',
  low: 'border-neutral-600 text-neutral-400 bg-neutral-900/40',
};

function nextPriority(priority: Priority): Priority {
  return PRIORITIES[(PRIORITIES.indexOf(priority) + 1) % PRIORITIES.length];
}

function dueFromInput(value: string): number | undefined {
  if (!value) return undefined;
  return endOfDayMs(parseDateTime(value, 'due').ms);
}

function TodoRow({ todo, now }: { todo: TodoRecord; now: number }) {
  const ids = useId();
  const action = useAction();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(todo.text);
  const [due, setDue] = useState(todo.dueAt !== undefined ? localDate(todo.dueAt) : '');
  const overdue = !todo.done && todo.dueAt !== undefined && todo.dueAt < now;

  const save = () => action.run(async () => {
    await updateTodo(todo.id, { text, dueAt: due ? (dueFromInput(due) ?? null) : null });
    setEditing(false);
  });
  const startEdit = () => {
    setText(todo.text);
    setDue(todo.dueAt !== undefined ? localDate(todo.dueAt) : '');
    setEditing(true);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') setEditing(false);
  };

  if (editing) {
    return (
      <li className="rounded-lg border border-amber-600/50 bg-black/40 p-2 flex flex-wrap items-end gap-2" onKeyDown={onKey}>
        <div className="flex flex-col gap-0.5 flex-1 min-w-[10rem]">
          <MicroLabel htmlFor={`${ids}-text`}>To-do</MicroLabel>
          <input id={`${ids}-text`} className={inputClass} value={text} onChange={event => setText(event.target.value)} maxLength={300} autoFocus />
        </div>
        <div className="flex flex-col gap-0.5">
          <MicroLabel htmlFor={`${ids}-due`}>Due</MicroLabel>
          <input id={`${ids}-due`} type="date" className={inputClass} value={due} onChange={event => setDue(event.target.value)} />
        </div>
        <Button tone="solid" onClick={save} disabled={action.busy}><Save className="w-3 h-3" /> Save</Button>
        <Button tone="ghost" onClick={() => { setEditing(false); setText(todo.text); }}>Cancel</Button>
        <div className="w-full"><ErrorLine message={action.error} /></div>
      </li>
    );
  }

  return (
    <li className={`rounded-lg border px-2 py-1.5 flex items-center gap-2 ${todo.done ? 'border-neutral-800 bg-neutral-950/30' : overdue ? 'border-red-700/50 bg-red-950/20' : 'border-amber-800/40 bg-black/25'}`}>
      <input
        id={`${ids}-done`}
        type="checkbox"
        checked={todo.done}
        onChange={event => action.run(() => setTodoDone(todo.id, event.target.checked))}
        className={`w-4 h-4 accent-amber-500 cursor-pointer ${focusRing}`}
      />
      <label htmlFor={`${ids}-done`} className={`flex-1 min-w-0 text-[12px] cursor-pointer ${todo.done ? 'line-through text-neutral-500' : 'text-amber-100'}`}>
        <span className="break-words">{todo.text}</span>
        {todo.dueAt !== undefined ? (
          <span className={`block text-[10px] ${overdue ? 'text-red-300' : 'text-amber-400/70'}`}>
            {overdue ? 'Overdue: ' : 'Due '}{formatDue(todo.dueAt, now)}
          </span>
        ) : null}
        {todo.done && todo.completedAt ? <span className="block text-[10px] text-neutral-500">Done {formatWhen(todo.completedAt, now)}</span> : null}
      </label>
      {!todo.done ? (
        <button
          type="button"
          onClick={() => action.run(() => updateTodo(todo.id, { priority: nextPriority(todo.priority) }))}
          className={`px-1.5 py-0.5 rounded border text-[10px] uppercase tracking-wider ${PRIORITY_STYLE[todo.priority]} ${focusRing}`}
          aria-label={`Priority ${todo.priority}. Change to ${nextPriority(todo.priority)}`}
          title="Change priority"
        >
          {todo.priority}
        </button>
      ) : null}
      {!todo.done ? <IconButton label={`Edit ${todo.text}`} onClick={startEdit}><Pencil className="w-3.5 h-3.5" /></IconButton> : null}
      <ConfirmButton iconOnly label={`Delete ${todo.text}`} question="Delete?" confirmLabel="Delete" onConfirm={() => action.run(() => deleteTodo(todo.id))}>
        <Trash className="w-3.5 h-3.5" />
      </ConfirmButton>
      {action.error ? <span className="sr-only" role="alert">{action.error}</span> : null}
    </li>
  );
}

function TodosTab() {
  const ids = useId();
  const now = useNow(60_000);
  const action = useAction();
  const { data: todos = [], loading } = useDbList('todos', rows => sortTodos(rows));
  const [text, setText] = useState('');
  const [priority, setPriority] = useState<Priority>('normal');
  const [due, setDue] = useState('');
  const [showDone, setShowDone] = useState(false);
  const open = todos.filter(todo => !todo.done);
  const done = todos.filter(todo => todo.done);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    action.run(async () => {
      const { existing } = await createTodo({ text, priority, dueAt: dueFromInput(due) });
      if (existing) throw new ToolInputError('That is already on the list.');
      setText('');
      setDue('');
      setPriority('normal');
    });
  };

  return (
    <div className="flex flex-col gap-2.5">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2 bg-black/30 border border-amber-800/30 rounded-lg p-2.5" aria-label="Add a to-do">
        <div className="flex flex-col gap-0.5 flex-1 min-w-[10rem]">
          <MicroLabel htmlFor={`${ids}-text`}>To-do</MicroLabel>
          <input id={`${ids}-text`} className={inputClass} value={text} onChange={event => setText(event.target.value)} maxLength={300} placeholder="Renew passport" required />
        </div>
        <div className="flex flex-col gap-0.5">
          <MicroLabel htmlFor={`${ids}-priority`}>Priority</MicroLabel>
          <select id={`${ids}-priority`} className={inputClass} value={priority} onChange={event => setPriority(event.target.value as Priority)}>
            {PRIORITIES.map(option => <option key={option} value={option}>{option}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-0.5">
          <MicroLabel htmlFor={`${ids}-due`}>Due</MicroLabel>
          <input id={`${ids}-due`} type="date" className={inputClass} value={due} onChange={event => setDue(event.target.value)} />
        </div>
        <Button type="submit" tone="solid" disabled={action.busy}><Plus className="w-3.5 h-3.5" /> Add</Button>
        <div className="w-full"><ErrorLine message={action.error} /></div>
      </form>
      {loading ? <Empty>Loading to-dos...</Empty> : null}
      {!loading && open.length === 0 ? <Empty>Nothing to do. Enjoy it while it lasts.</Empty> : null}
      <ul className="flex flex-col gap-1.5" aria-label="Open to-dos">
        {open.map(todo => <TodoRow key={todo.id} todo={todo} now={now} />)}
      </ul>
      {done.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <Button tone="quiet" onClick={() => setShowDone(value => !value)} pressed={showDone} className="self-start">
            {showDone ? 'Hide' : 'Show'} completed ({done.length})
          </Button>
          {showDone ? (
            <ul className="flex flex-col gap-1.5" aria-label="Completed to-dos">
              {done.slice(0, 50).map(todo => <TodoRow key={todo.id} todo={todo} now={now} />)}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ── Notes ───────────────────────────────────────────────────────────────────────────────

interface Draft {
  title: string;
  body: string;
  /** The note version the edits started from, to detect changes made elsewhere. */
  base: number;
}

function NoteEditor({ note, onClose }: { note: NoteRecord; onClose: () => void }) {
  const ids = useId();
  const action = useAction();
  // No draft means the editor shows the stored note, so edits made by Miss Minutes appear live.
  const [draft, setDraft] = useState<Draft | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const title = draft?.title ?? note.title;
  const body = draft?.body ?? note.body;
  const dirty = draft !== null && (draft.title !== note.title || draft.body !== note.body);
  const changedElsewhere = draft !== null && draft.base !== note.updatedAt;
  const edit = (patch: Partial<Pick<Draft, 'title' | 'body'>>) =>
    setDraft(current => ({ title: current?.title ?? note.title, body: current?.body ?? note.body, base: current?.base ?? note.updatedAt, ...patch }));
  const setTitle = (value: string) => edit({ title: value });
  const setBody = (value: string) => edit({ body: value });

  const save = () => action.run(async () => {
    const saved = await updateNote(note.id, { title, body });
    setSavedAt(saved.updatedAt);
    setDraft(null);
  });
  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (dirty) save();
    }
    if (event.key === 'Escape' && !dirty) onClose();
  };

  return (
    <div className="flex flex-col gap-2" onKeyDown={onKeyDown}>
      <div className="flex flex-col gap-0.5">
        <MicroLabel htmlFor={`${ids}-title`}>Title</MicroLabel>
        <input id={`${ids}-title`} className={inputClass} value={title} onChange={event => setTitle(event.target.value)} maxLength={200} />
      </div>
      <div className="flex flex-col gap-0.5">
        <MicroLabel htmlFor={`${ids}-body`}>Note</MicroLabel>
        <textarea
          id={`${ids}-body`}
          className={`${inputClass} min-h-[10rem] resize-y leading-relaxed`}
          value={body}
          onChange={event => setBody(event.target.value)}
          maxLength={50_000}
        />
      </div>
      {changedElsewhere ? (
        <p role="alert" className="text-[11px] text-amber-200 bg-amber-900/40 border border-amber-600/40 rounded px-2 py-1 flex flex-wrap items-center gap-2">
          This note changed elsewhere (maybe Miss Minutes added to it). Saving replaces that version.
          <Button tone="ghost" onClick={() => setDraft(null)}>Load the latest</Button>
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button tone="solid" onClick={save} disabled={!dirty || action.busy}><Save className="w-3 h-3" /> Save</Button>
        <Button tone="ghost" onClick={onClose}>{dirty ? 'Discard changes' : 'Close'}</Button>
        <span className="text-[10px] text-amber-400/70" role="status">
          {dirty ? 'Unsaved changes (Ctrl+S saves)' : savedAt ? `Saved ${formatTime(savedAt)}` : `Last edited ${formatWhen(note.updatedAt)}`}
        </span>
        <span className="ml-auto">
          <ConfirmButton question="Delete this note?" confirmLabel="Delete" tone="danger" onConfirm={() => action.run(() => deleteNote(note.id), onClose)}>
            <Trash className="w-3 h-3" /> Delete
          </ConfirmButton>
        </span>
      </div>
      <ErrorLine message={action.error} />
    </div>
  );
}

function NotesTab() {
  const ids = useId();
  const now = useNow(60_000);
  const action = useAction();
  const { data: notes = [], loading } = useDbList('notes');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const shown = query.trim() ? searchNotes(notes, query) : [...notes].sort((a, b) => b.updatedAt - a.updatedAt);
  const open = openId ? notes.find(note => note.id === openId) : undefined;

  if (open) return <NoteEditor key={open.id} note={open} onClose={() => setOpenId(null)} />;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-0.5 flex-1 min-w-[10rem]">
          <MicroLabel htmlFor={`${ids}-search`}>Search notes</MicroLabel>
          <div className="relative">
            <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-amber-500" aria-hidden="true" />
            <input id={`${ids}-search`} type="search" className={`${inputClass} w-full pl-6`} value={query} onChange={event => setQuery(event.target.value)} placeholder="Words in title or text" />
          </div>
        </div>
        <Button
          tone="solid"
          onClick={() => action.run(async () => {
            const note = await createNote(query.trim() || `Note ${formatWhen(Date.now())}`, '');
            setQuery('');
            setOpenId(note.id);
          })}
          disabled={action.busy}
        >
          <Plus className="w-3.5 h-3.5" /> New note
        </Button>
      </div>
      <ErrorLine message={action.error} />
      {loading ? <Empty>Loading notes...</Empty> : null}
      {!loading && shown.length === 0 ? <Empty>{query.trim() ? `No notes contain "${query.trim()}".` : 'No notes yet.'}</Empty> : null}
      <ul className="flex flex-col gap-1.5" aria-label="Notes">
        {shown.slice(0, 100).map(note => (
          <li key={note.id}>
            <button
              type="button"
              onClick={() => setOpenId(note.id)}
              className={`w-full text-left rounded-lg border border-amber-800/40 bg-black/25 hover:bg-amber-900/30 px-2.5 py-1.5 ${focusRing}`}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="text-[12px] font-semibold text-amber-100 truncate">{note.title}</span>
                <span className="text-[10px] text-amber-400/60 flex-shrink-0">{formatWhen(note.updatedAt, now)}</span>
              </span>
              <span className="block text-[11px] text-amber-300/70 truncate">{note.body.replace(/\s+/g, ' ').trim() || 'Empty note'}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Panel ───────────────────────────────────────────────────────────────────────────────

export function Toolbelt({ className, defaultTab = 'timers' }: ToolbeltProps) {
  const ids = useId();
  const [tab, setTab] = useState<ToolbeltTab>(defaultTab);
  const timers = useDbList('timers', rows => rows.filter(timer => timer.state === 'running' || timer.state === 'paused').length);
  const alarms = useDbList('schedule', rows => rows.filter(item => item.kind === 'alarm' && !item.done).length);
  const todos = useDbList('todos', rows => rows.filter(todo => !todo.done).length);
  const notes = useDbList('notes', rows => rows.length);
  const tabs: Array<{ id: ToolbeltTab; label: string; count?: number }> = [
    { id: 'timers', label: 'Timers', count: timers.data },
    { id: 'alarms', label: 'Alarms', count: alarms.data },
    { id: 'todos', label: 'To-dos', count: todos.data },
    { id: 'notes', label: 'Notes', count: notes.data },
  ];
  const subtitle = tab === 'timers' ? <Hourglass className="w-3 h-3 inline" /> : tab === 'alarms' ? <AlarmClock className="w-3 h-3 inline" /> : tab === 'todos' ? <ListTodo className="w-3 h-3 inline" /> : <StickyNote className="w-3 h-3 inline" />;

  return (
    <PanelShell title="TemPad Toolbelt" icon={<Wrench className="w-4 h-4" />} className={className} subtitle={<span aria-hidden="true">{subtitle}</span>}>
      <Tabs tabs={tabs} value={tab} onChange={setTab} label="Toolbelt sections" idPrefix={ids} />
      <div role="tabpanel" id={`${ids}-panel-${tab}`} aria-labelledby={`${ids}-tab-${tab}`} className="flex flex-col gap-2">
        {tab === 'timers' ? <TimersTab /> : tab === 'alarms' ? <AlarmsTab /> : tab === 'todos' ? <TodosTab /> : <NotesTab />}
      </div>
    </PanelShell>
  );
}

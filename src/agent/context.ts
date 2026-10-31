/**
 * Live, factual context the brain adds to every turn: local time, today's agenda, running
 * timers, due reminders and open to-dos. Shared contract: keep the signature stable.
 *
 * Kept under about 1200 characters: lists are capped and shortened until the text fits.
 * Times are 24-hour local; dates are ISO so the model can reuse them in tool calls.
 */
import { listAll, type ScheduleItem } from '../store/db';
import { expandAgenda, findOverlaps, isOverdue, isSnoozed, nextFireAt, type AgendaEntry } from './tools/agenda';
import { clip } from './tools/args';
import { knownHomeCity } from './tools/settingsCache';
import { DAY, addDays, clock24, dueIso, formatCountdown, formatOffset, localDate, localOffsetMinutes, localTimeZone, startOfDay, weekdayName } from './tools/time';
import { timerRemaining } from './tools/timers';
import { sortTodos } from './tools/todos';

const BUDGET = 1200;

interface Section {
  label: string;
  /** Text before the list, e.g. "5 open, 1 overdue". */
  lead?: string;
  /** Name for the list after the lead, e.g. "high priority". */
  listLabel?: string;
  items: string[];
  /** Shown when there is neither lead nor items; omit to drop the line. */
  empty?: string;
  /** Lower drops items first when over budget. */
  priority: number;
}

function quoted(text: string): string {
  return `"${clip(text.replace(/"/g, "'"), 40)}"`;
}

function when(at: number, now: number): string {
  return localDate(at) === localDate(now) ? `today ${clock24(at)}` : `${localDate(at)} ${clock24(at)}`;
}

function entryLine(entry: AgendaEntry, conflicts: Map<string, string[]>, now: number): string {
  const time = entry.allDay ? 'all day' : entry.kind === 'event' ? `${clock24(entry.start)}-${clock24(entry.end)}` : clock24(entry.start);
  const kind = entry.kind === 'event' ? '' : `${entry.kind} `;
  const where = entry.location ? ` @ ${clip(entry.location, 24)}` : '';
  const clash = conflicts.get(entry.key);
  const tags = [
    entry.kind === 'event' && !entry.allDay && entry.start <= now && entry.end > now ? 'in progress' : '',
    entry.status === 'snoozed' ? 'snoozed' : '',
    clash ? `CONFLICT with ${clash.map(quoted).join(', ')}` : '',
  ].filter(Boolean);
  return `${time} ${kind}${quoted(entry.title)}${where}${tags.length ? ` [${tags.join('; ')}]` : ''}`;
}

function render(header: string, sections: Array<Section & { hidden: number }>): string {
  const lines = [header];
  for (const section of sections) {
    const items = section.hidden > 0 ? [...section.items, `+${section.hidden} more`] : section.items;
    const parts: string[] = [];
    if (section.lead) parts.push(section.lead);
    if (items.length > 0) parts.push(section.listLabel ? `${section.listLabel}: ${items.join('; ')}` : items.join('; '));
    if (parts.length === 0) {
      if (section.empty) lines.push(`${section.label}: ${section.empty}.`);
      continue;
    }
    lines.push(`${section.label}: ${parts.join('; ')}.`);
  }
  return lines.join('\n');
}

/** Drops list items, lowest-priority section first, until the text fits. */
function fit(header: string, sections: Section[]): string {
  const working = sections.map(section => ({ ...section, items: [...section.items], hidden: 0 }));
  let output = render(header, working);
  while (output.length > BUDGET) {
    const candidate = working
      .filter(section => section.items.length > 0)
      .sort((a, b) => a.priority - b.priority || b.items.length - a.items.length)[0];
    if (!candidate) break;
    candidate.items.pop();
    candidate.hidden += 1;
    output = render(header, working);
  }
  return output.length > BUDGET ? `${output.slice(0, BUDGET - 1)}…` : output;
}

export async function buildDynamicContext(now: Date = new Date()): Promise<string> {
  const at = now.getTime();
  const home = knownHomeCity();
  const header = `Now: ${weekdayName(at)} ${localDate(at)} ${clock24(at)} (${localTimeZone()}, UTC${formatOffset(localOffsetMinutes(at))}). `
    + `Home city: ${home ? clip(home, 60) : 'not set'}.`;
  try {
    const [items, timers, todos] = await Promise.all([listAll('schedule'), listAll('timers'), listAll('todos')]);
    const dayStart = startOfDay(at);
    const dayEnd = addDays(dayStart, 1);

    const rest = expandAgenda(items, dayStart, dayEnd, at).filter(entry => {
      if (entry.status === 'done' || entry.status === 'off' || entry.status === 'overdue') return false;
      if (entry.allDay) return true;
      return entry.kind === 'event' ? entry.end > at : entry.start >= at;
    });
    const conflicts = new Map<string, string[]>();
    for (const conflict of findOverlaps(expandAgenda(items, dayStart, dayEnd, at, { kinds: ['event'] }))) {
      if (conflict.end <= at) continue;
      conflicts.set(conflict.a.key, [...(conflicts.get(conflict.a.key) ?? []), conflict.b.title]);
      conflicts.set(conflict.b.key, [...(conflicts.get(conflict.b.key) ?? []), conflict.a.title]);
    }

    const activeTimers = timers
      .filter(timer => timer.state === 'running' || timer.state === 'paused')
      .sort((a, b) => timerRemaining(a, at) - timerRemaining(b, at))
      .map(timer => {
        const name = timer.label.trim() ? quoted(timer.label) : 'unnamed';
        const left = formatCountdown(timerRemaining(timer, at));
        return timer.state === 'paused' ? `${name} paused with ${left} left` : `${name} ${left} left (ends ${clock24(timer.endsAt)})`;
      });

    const overdue = items
      .filter(item => isOverdue(item, at))
      .sort((a, b) => a.startAt - b.startAt)
      .map(item => `${quoted(item.title)} (was due ${when(item.startAt, at)})`);

    const upcoming = items
      .filter(item => item.kind === 'reminder' && !item.done)
      .map(item => ({ item, fire: nextFireAt(item) }))
      .filter((entry): entry is { item: ScheduleItem; fire: number } =>
        entry.fire !== undefined && entry.fire > at && entry.fire < at + 7 * DAY)
      .sort((a, b) => a.fire - b.fire)
      .slice(0, 4)
      .map(({ item, fire }) => `${quoted(item.title)} ${when(fire, at)}${isSnoozed(item, at) ? ' (snoozed)' : ''}`);

    const open = sortTodos(todos.filter(todo => !todo.done));
    const high = open.filter(todo => todo.priority === 'high');
    const lateTodos = open.filter(todo => todo.dueAt !== undefined && todo.dueAt < at).length;

    const sections: Section[] = [
      { label: 'Rest of today', items: rest.slice(0, 10).map(entry => entryLine(entry, conflicts, at)), empty: 'nothing scheduled', priority: 5 },
      { label: 'Timers', items: activeTimers.slice(0, 5), priority: 4 },
      { label: 'Overdue reminders', items: overdue.slice(0, 5), priority: 4 },
      { label: 'Next reminders', items: upcoming, priority: 1 },
      {
        label: 'To-dos',
        lead: open.length === 0 ? 'none open' : `${open.length} open${lateTodos ? `, ${lateTodos} overdue` : ''}`,
        listLabel: 'high priority',
        items: high.slice(0, 5).map(todo => `${quoted(todo.text)}${todo.dueAt !== undefined ? ` (due ${dueIso(todo.dueAt)})` : ''}`),
        priority: 2,
      },
    ];
    return fit(header, sections);
  } catch (error) {
    // The time line alone is still worth sending if storage is unavailable.
    return `${header}\n(Schedule unavailable: ${error instanceof Error ? error.message : 'storage error'}.)`;
  }
}

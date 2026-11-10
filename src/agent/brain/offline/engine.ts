/**
 * The TVA offline engine: no model, real work. A deterministic intent matcher turns the
 * owner's words into tool calls from the registry (timers, alarms, reminders, events, agenda,
 * to-dos, notes, clocks, weather, search, memory, arithmetic), runs them through the same
 * approval policy as model turns, and answers in Miss Minutes' voice from the tool results.
 */
import type { AISettings, ChatMessage, Emotion, Gesture } from '../../../types';
import type { MemoryCategory, MemoryRecord } from '../../../store/db';
import { OFFLINE_LORE_RESPONSES } from '../../../data/tvaLore';
import type { ToolOutcome } from '../toolRunner';
import { containsSecret } from '../../memory/sensitive';
import { findDuration } from './numbers';
import { describeWhen, localIso, parseWhen, rangeFor, withoutSpans, type WhenResult } from './timeParser';
import { evaluate, extractExpression, formatNumber } from './math';
import { LINES, OFFLINE_HELP, partOfDayGreeting, pick } from './voice';

export type Intent =
  | { kind: 'tool'; topic: string; tool: string; args: Record<string, unknown>; detail?: string }
  | { kind: 'agenda'; args: Record<string, unknown>; label: string }
  | { kind: 'ask'; question: string; emotion?: Emotion }
  | { kind: 'remember'; fact: string; category: MemoryCategory; reply: string }
  | { kind: 'memory-list' }
  | { kind: 'memory-name' }
  | { kind: 'forget'; query: string }
  | { kind: 'note-read'; query: string }
  | { kind: 'math'; expression: string }
  | { kind: 'lore'; text: string; emotion: Emotion }
  | { kind: 'say'; text: string; emotion: Emotion; gesture: Gesture }
  | { kind: 'fallback' };

export interface OfflineReply {
  text: string;
  emotion: Emotion;
  gesture: Gesture;
  /** 'action' when a tool was run (or attempted), 'question' when more detail is needed. */
  kind: 'action' | 'info' | 'question' | 'chat' | 'fallback';
}

export interface OfflineDeps {
  now: Date;
  settings: AISettings;
  history: ChatMessage[];
  tools: {
    has(name: string): boolean;
    run(name: string, args: Record<string, unknown>): Promise<ToolOutcome>;
  };
  memory: {
    list(): Promise<MemoryRecord[]>;
    search(query: string): Promise<MemoryRecord[]>;
    /** Used when the remember tool isn't registered. */
    save(fact: string, category: MemoryCategory): Promise<void>;
  };
  /** Options passed to the time parser (tests pin the date order). */
  dayFirst?: boolean;
}

// ── Text helpers ────────────────────────────────────────────────────────────────

const WAKE_NAME = /^(?:(?:hey|hi|hello|ok(?:ay)?|yo|so)\s*,?\s+)?miss\s+minutes?\b[\s,!.:]*/i;
const WAKE_WORD = /^(?:hey|hi|hello|ok(?:ay)?|yo|so|um+|uh+)\s*[,!.]\s*(?=\S)/i;

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Strips "hey Miss Minutes," and "please" so patterns see the request itself. */
export function normalizeRequest(text: string): string {
  let s = clean(text);
  const stripped = s.replace(WAKE_NAME, '').replace(WAKE_WORD, '');
  if (stripped.trim()) s = stripped;
  s = s.replace(/^(?:please|pls|kindly)\s+/i, '').replace(/[\s,]+(?:please|pls|thanks|thank you)[.!?]*$/i, '');
  s = s.replace(/^(?:can|could|would|will)\s+you\s+(?:please\s+)?/i, '').replace(/^i(?:'d| would)\s+like\s+(?:you\s+)?to\s+/i, '');
  s = s.replace(/^(?:i\s+(?:want|need)\s+(?:you\s+)?to\s+)(?=set|add|make|create|start|remind|schedule|put|take|write)/i, '');
  return s.trim();
}

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function titleCase(text: string): string {
  return text.split(/\s+/).map(word => (word.length > 2 || /^[a-z]{1,2}$/i.test(word) ? capitalize(word) : word)).join(' ');
}

function trimTitle(text: string): string {
  return clean(text)
    .replace(/^(?:to|that|about|of|for|me to|me that|me about|me of|i need to|i have to|i should)\s+/i, '')
    .replace(/[\s,.;:!?-]+$/g, '')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .trim();
}

const CITY_STOP = /^(?:the\s+)?(?:morning|afternoon|evening|night|week|weekend|today|tomorrow|now|here|there|home|outside|general|advance|a\s+bit|a\s+while|the\s+area|my\s+area|my\s+city|my\s+location)$/i;

function cityFrom(text: string): string | undefined {
  const m = /\b(?:in|for|at)\s+([a-z][a-z .'-]{1,60}?)(?:\s+(?:right\s+now|now|currently|today|tomorrow|tonight|this\s+week(?:end)?|next\s+week|later|this\s+morning|this\s+evening|over\s+the\s+weekend))*\s*\??$/i.exec(text);
  if (!m) return undefined;
  const city = m[1].replace(/\s+(?:please|thanks)$/i, '').trim();
  if (!city || CITY_STOP.test(city)) return undefined;
  return titleCase(city);
}

function whenOptions(deps: { dayFirst?: boolean }) {
  return deps.dayFirst === undefined ? {} : { dayFirst: deps.dayFirst };
}

// ── Pending questions ───────────────────────────────────────────────────────────

const ASK_REMINDER = /When should I remind you (?:to|about) (.+?)\?/;
const ASK_EVENT = /What day and time is "(.+?)"\?/;
const ASK_TIMER = /How long should I set the timer for\?/;
const ASK_ALARM = /What time should I set the alarm for\?/;

function lastAssistantText(history: ChatMessage[]): string {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].sender === 'miss_minute') return history[i].text;
    if (history[i].sender === 'user') return '';
  }
  return '';
}

function continuation(text: string, now: Date, history: ChatMessage[], deps: { dayFirst?: boolean }): Intent | null {
  const previous = lastAssistantText(history);
  if (!previous) return null;
  const reminder = ASK_REMINDER.exec(previous);
  if (reminder) {
    const when = parseWhen(text, now, whenOptions(deps));
    if (when && (when.hasTime || when.hasDate)) return reminderIntent(reminder[1], when);
    return null;
  }
  const event = ASK_EVENT.exec(previous);
  if (event) {
    const split = splitTimeRange(text);
    const when = parseWhen(split.body, now, whenOptions(deps));
    if (when) return eventIntent(event[1], when, now, split.end);
    return null;
  }
  if (ASK_TIMER.test(previous)) {
    const duration = findDuration(text) ?? bareMinutes(text);
    if (duration) return timerIntent(duration.seconds, '');
    return null;
  }
  if (ASK_ALARM.test(previous)) {
    const when = parseWhen(text, now, whenOptions(deps));
    if (when && when.hasTime && !when.relative) return alarmIntent(when, '');
  }
  return null;
}

function bareMinutes(text: string): { seconds: number } | null {
  const m = /^(?:for\s+)?(\d{1,3})\s*$/.exec(text.trim()) ?? /\btimer\s+(?:for\s+)?(\d{1,3})(?!\s*[:\d])\b/i.exec(text);
  return m ? { seconds: Number(m[1]) * 60 } : null;
}

// ── Intent builders ─────────────────────────────────────────────────────────────

function timerIntent(seconds: number, label: string): Intent {
  if (seconds > 86_400) {
    return { kind: 'ask', question: "Timers top out at 24 hours, sugar. Want a reminder instead? Tell me when, like \"remind me Friday at 9 to...\"" };
  }
  const args: Record<string, unknown> = { duration_seconds: Math.max(1, Math.round(seconds)) };
  if (label) args.label = label;
  return { kind: 'tool', topic: 'timer', tool: 'set_timer', args };
}

function reminderIntent(title: string, when: WhenResult): Intent {
  const args: Record<string, unknown> = { title: capitalize(trimTitle(title)) || 'Reminder', at: localIso(when.date) };
  if (when.recurrence !== 'none') args.recurrence = when.recurrence;
  return { kind: 'tool', topic: 'reminder', tool: 'add_reminder', args };
}

function alarmIntent(when: WhenResult, label: string): Intent {
  const hh = String(when.date.getHours()).padStart(2, '0');
  const mm = String(when.date.getMinutes()).padStart(2, '0');
  const days = when.recurrence === 'daily' ? 'daily' : when.recurrence === 'weekdays' ? 'weekdays' : when.recurrence === 'weekly' ? 'weekly' : 'once';
  const args: Record<string, unknown> = { time: `${hh}:${mm}`, days };
  if (label) args.label = label;
  return { kind: 'tool', topic: 'alarm', tool: 'set_alarm', args, detail: describeWhen(when.date, new Date()) };
}

const EVENT_WORDS = /\b(?:event|meeting|appointment|calendar|schedule|call|lunch|dinner|breakfast|brunch|interview|party|class|session|game|flight|date|visit|reservation|standup|stand-up|sync|review|checkup|check-up|dentist|doctor|haircut|gym|practice|rehearsal|concert|movie|webinar|conference|trip|birthday|anniversary|deadline|exam|test)\b/i;

const TIME_RANGE = /\b(?:from\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|to|until|till)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?![\w:])/i;
const EVENT_LENGTH = /\bfor\s+((?:an?|\d+(?:\.\d+)?|half|one|two|three|four)\s*(?:and\s+a\s+half\s+)?(?:hours?|hrs?|minutes?|mins?)(?:\s+and\s+a\s+half)?(?:\s+(?:and\s+)?\d+\s*(?:minutes?|mins?))?)\b/i;

/**
 * "from 2 to 3pm" / "2-3pm": rewrites the range as its start ("at 14:00") so the time parser
 * reads the start, and returns the end clock separately.
 */
function splitTimeRange(body: string): { body: string; end?: { hour: number; minute: number } } {
  const m = TIME_RANGE.exec(body);
  if (!m) return { body };
  const sRaw = Number(m[1]);
  const eRaw = Number(m[4]);
  if (sRaw > 23 || eRaw > 23) return { body };
  let sMer = m[3]?.toLowerCase();
  let eMer = m[6]?.toLowerCase();
  if (!sMer && eMer) sMer = sRaw % 12 <= eRaw % 12 ? eMer : eMer === 'pm' ? 'am' : 'pm';
  if (!eMer && sMer) eMer = eRaw % 12 >= sRaw % 12 ? sMer : sMer === 'am' ? 'pm' : 'am';
  const to24 = (h: number, mer: string | undefined) => (mer === 'am' ? h % 12 : mer === 'pm' ? (h % 12) + 12 : h);
  let sh = to24(sRaw, sMer);
  let eh = to24(eRaw, eMer);
  if (!sMer && !eMer) {
    if (sh >= 1 && sh <= 6) sh += 12;
    if (eh >= 1 && eh <= 6) eh += 12;
    if (eh <= sh && eh + 12 < 24) eh += 12;
  }
  const sm = m[2] ? Number(m[2]) : 0;
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    body: `${body.slice(0, m.index)} at ${pad(sh)}:${pad(sm)} ${body.slice(m.index + m[0].length)}`,
    end: { hour: eh, minute: m[5] ? Number(m[5]) : 0 },
  };
}

function eventIntent(rawTitle: string, when: WhenResult, now: Date, end?: { hour: number; minute: number }, lengthSeconds?: number): Intent {
  let title = rawTitle;
  let location: string | undefined;
  const loc = /\bat\s+((?:the\s+)?[A-Z][\w'&.-]*(?:\s+(?:[A-Z][\w'&.-]*|of|de|la|and|&))*)/.exec(title);
  if (loc && !/^(?:noon|midnight|night|home|work)$/i.test(loc[1])) {
    location = loc[1].trim();
    title = title.replace(loc[0], ' ');
  }
  title = capitalize(trimTitle(title.replace(/^(?:an?|the)\s+(?:event|meeting)\s+(?:called|named|titled)\s+/i, '')));
  if (!title) title = 'Event';

  const start = when.date;
  let finish: Date | undefined;
  if (end && when.hasTime) {
    finish = new Date(start);
    finish.setHours(end.hour, end.minute, 0, 0);
    if (finish <= start) finish = new Date(finish.getTime() + 86_400_000);
  } else if (lengthSeconds && when.hasTime) {
    finish = new Date(start.getTime() + lengthSeconds * 1000);
  }

  const args: Record<string, unknown> = {
    title,
    start: when.hasTime ? localIso(start) : localIso(start).slice(0, 10),
  };
  if (finish) args.end = localIso(finish);
  if (location) args.location = location;
  if (when.recurrence !== 'none') args.recurrence = when.recurrence;
  return { kind: 'tool', topic: 'event', tool: 'add_event', args, detail: describeWhen(start, now, when.hasTime) };
}

const KEEP_VERB = /^(?:can|can't|cannot|could|couldn't|will|won't|would|wouldn't|should|shouldn't|must|might|may)$/i;
const IRREGULAR: Record<string, string> = { go: 'goes', do: 'does', "don't": "doesn't", have: 'has', am: 'is', was: 'was' };

/** "I like jazz" -> "Likes jazz."; "my wife's name is Sara" -> "Wife's name is Sara." */
export function ownerFact(raw: string): string {
  let fact = clean(raw).replace(/[.!?]+$/, '');
  fact = fact
    .replace(/^i am\s+/i, 'is ')
    .replace(/^i'm\s+/i, 'is ')
    .replace(/^i've\s+/i, 'has ')
    .replace(/^i (?:really\s+)?(\S+)/i, (whole, verb: string) => {
      const lower = verb.toLowerCase();
      const adverb = /\breally\b/i.test(whole) ? 'really ' : '';
      if (KEEP_VERB.test(lower)) return `${adverb}${verb}`;
      if (IRREGULAR[lower]) return `${adverb}${IRREGULAR[lower]}`;
      if (/(?:s|sh|ch|x|z|o)$/.test(lower)) return `${adverb}${verb}es`;
      if (/[^aeiou]y$/.test(lower)) return `${adverb}${verb.slice(0, -1)}ies`;
      return `${adverb}${verb}s`;
    })
    .replace(/^my\s+/i, '')
    .replace(/\bmy\b/gi, 'their')
    .replace(/\bme\b/gi, 'them')
    .replace(/\bi\b/g, 'they');
  return `${capitalize(fact)}.`;
}

// ── Detection ───────────────────────────────────────────────────────────────────

function detectTimer(s: string, lower: string): Intent | null {
  if (!/\b(?:timer|countdown|count down)\b/.test(lower) && !/^(?:wake me|ping me|buzz me|tell me)\s+in\b/.test(lower)) return null;
  // Control and status first: "pause the timer", "add 5 minutes to the timer", "how long is left".
  const labelMatch = /\b(?:the|my)\s+([a-z][\w-]*)\s+timer\b/.exec(lower);
  const label = labelMatch && !/^(?:current|active|running|last|first|second|other)$/.test(labelMatch[1]) ? labelMatch[1] : undefined;
  const withLabel = (args: Record<string, unknown>) => (label ? { ...args, label } : args);
  const add = /\badd\s+(.+?)\s+(?:more\s+)?(?:to|on(?:to)?)\s+(?:the|my)\b/.exec(lower);
  if (add) {
    const duration = findDuration(add[1]);
    if (duration) return { kind: 'tool', topic: 'timer-control', tool: 'control_timer', args: withLabel({ action: 'add_time', seconds: duration.seconds }) };
  }
  if (/\b(?:pause|hold|freeze)\b/.test(lower)) return { kind: 'tool', topic: 'timer-control', tool: 'control_timer', args: withLabel({ action: 'pause' }) };
  if (/\b(?:resume|unpause|continue|restart)\b/.test(lower)) return { kind: 'tool', topic: 'timer-control', tool: 'control_timer', args: withLabel({ action: 'resume' }) };
  if (/\b(?:cancel|stop|kill|delete|remove|turn off|end|clear|dismiss)\b/.test(lower)) return { kind: 'tool', topic: 'timer-control', tool: 'control_timer', args: withLabel({ action: 'cancel' }) };
  if (/\b(?:how (?:much|long)|time left|left on|remaining|status|check|list|show|what timers|any timers|which timers)\b/.test(lower) && !/\b(?:set|start|create|make)\b/.test(lower)) {
    return { kind: 'tool', topic: 'timers', tool: 'list_timers', args: {} };
  }
  const found = findDuration(s);
  const bare = found ? null : bareMinutes(s);
  const seconds = found?.seconds ?? bare?.seconds;
  if (!seconds) return { kind: 'ask', question: 'How long should I set the timer for?' };
  let rest = found ? `${s.slice(0, found.start)} ${s.slice(found.end)}` : s.replace(/\b\d{1,3}\b/, ' ');
  rest = rest
    .replace(/\b(?:set|start|create|make|run|begin|put on|put|give me|i need|i want|a|an|the|my|timer|countdown|count down|for|of|on|please|wake me|ping me|buzz me|tell me|in|minute|minutes|second|seconds|hour|hours)\b/gi, ' ')
    .replace(/[^\w' -]/g, ' ');
  const timerLabel = clean(rest).split(' ').slice(0, 3).join(' ').trim();
  return timerIntent(seconds, timerLabel);
}

function detectAlarm(s: string, lower: string, now: Date, deps: { dayFirst?: boolean }): Intent | null {
  if (!/\b(?:alarm|wake me(?: up)?|wake-up call|get me up)\b/.test(lower)) return null;
  if (/\b(?:cancel|delete|remove|turn off|switch off|disable|stop)\b/.test(lower)) {
    return { kind: 'say', text: "To switch an alarm off, open the Sacred Timeline panel and tap it, sugar. I can only add alarms while I'm offline.", emotion: 'talking', gesture: 'point' };
  }
  if (/\b(?:what|which|list|show|any)\b.*\balarms?\b/.test(lower)) {
    return { kind: 'agenda', args: { kind: 'alarm' }, label: 'alarms' };
  }
  const when = parseWhen(s, now, whenOptions(deps));
  if (!when || !when.hasTime) return { kind: 'ask', question: 'What time should I set the alarm for?' };
  if (when.relative) {
    const seconds = Math.round((when.date.getTime() - now.getTime()) / 1000);
    return timerIntent(seconds, 'wake up');
  }
  let label = withoutSpans(s, when.spans)
    .replace(/\b(?:set|create|make|add|an?|alarm|wake me(?: up)?|wake-up call|get me up|for|at|please|me|up|called|labeled|labelled|named)\b/gi, ' ');
  label = clean(label.replace(/[^\w' -]/g, ' '));
  return alarmIntent(when, label ? capitalize(label) : '');
}

function detectReminder(s: string, lower: string, now: Date, deps: { dayFirst?: boolean }): Intent | null {
  const m = /\b(?:remind me|set (?:me )?(?:a |an )?reminder|add (?:a )?reminder|create (?:a )?reminder|reminder|don'?t let me forget|remember to)\b\s*(?:to|about|that|of|for)?\s*(.*)$/i.exec(s);
  if (!m || /^(?:what|who|how)\b/.test(lower)) return null;
  const rest = m[1] ?? '';
  const when = parseWhen(rest, now, whenOptions(deps));
  const title = trimTitle(when ? withoutSpans(rest, when.spans) : rest);
  if (!when || (!when.hasTime && !when.hasDate)) {
    return { kind: 'ask', question: title ? `When should I remind you to ${title}?` : 'What should I remind you about, and when?' };
  }
  if (!title) return { kind: 'ask', question: 'What should I remind you about?' };
  if (!when.relative && when.recurrence === 'none' && when.date.getTime() <= now.getTime()) {
    return { kind: 'ask', question: `That time has already passed today, sugar. When should I remind you to ${title}?` };
  }
  return reminderIntent(title, when);
}

function detectTodo(s: string, lower: string, now: Date, deps: { dayFirst?: boolean }): Intent | null {
  const listWords = '(?:to-?\\s?do(?:\\s+list)?|todos?(?:\\s+list)?|task(?:\\s+list)?s?|shopping\\s+list|grocery\\s+list|groceries|list)';
  const add = new RegExp(`^(?:add|put|stick|throw|write|jot)\\s+(.+?)\\s+(?:to|on|onto|in|into)\\s+(?:my|the|our)\\s+${listWords}\\b(.*)$`, 'i').exec(s)
    ?? /^(?:add\s+(?:a\s+)?(?:new\s+)?)?(?:to-?\s?do|todo|task)\s*[:,-]?\s+(.+)$/i.exec(s);
  if (add) {
    let text = add[1];
    let tail = add[2] ?? '';
    const shopping = /\b(?:shopping|grocery|groceries)\b/i.test(s);
    let priority: string | undefined;
    const combined = `${text} ${tail}`;
    if (/\b(?:high priority|urgent|important|asap)\b/i.test(combined)) priority = 'high';
    else if (/\blow priority\b/i.test(combined)) priority = 'low';
    text = text.replace(/\b(?:high|low) priority\b|\burgent\b|\basap\b|\bimportant\b/gi, ' ');
    tail = tail.replace(/\b(?:high|low) priority\b|\burgent\b|\basap\b|\bimportant\b/gi, ' ');
    let due: string | undefined;
    const dueSource = /\b(?:by|due|before|for)\s+(.+)$/i.exec(`${text} ${tail}`);
    if (dueSource) {
      const when = parseWhen(dueSource[1], now, whenOptions(deps));
      if (when) {
        due = when.hasTime ? localIso(when.date) : localIso(when.date).slice(0, 10);
        text = text.replace(dueSource[0], ' ');
      }
    }
    let item = trimTitle(text);
    if (!item) return { kind: 'ask', question: 'What should I put on your list?' };
    if (shopping && !/^buy\b/i.test(item)) item = `Buy ${item}`;
    const args: Record<string, unknown> = { text: capitalize(item) };
    if (priority) args.priority = priority;
    if (due) args.due = due;
    return { kind: 'tool', topic: 'todo-add', tool: 'add_todo', args };
  }
  if (/\b(?:what'?s|what is|what are|show|list|read|check|tell me|go over)\b.*\b(?:to-?\s?do|todos|tasks|task list|shopping list)\b/i.test(lower)
    || /^(?:my\s+)?(?:to-?\s?do|todo|task)s?(?:\s+list)?\??$/i.test(lower)
    || /\bwhat do i (?:need|have) to do\b/i.test(lower)) {
    return { kind: 'tool', topic: 'todos', tool: 'list_todos', args: {} };
  }
  const done = /^(?:mark|check off|cross off|tick off|complete|finish(?:ed)?|done with|i (?:finished|did|completed|have done|'ve done|'ve finished|have finished))\s+(.+?)(?:\s+(?:as\s+)?(?:done|complete|completed|finished))?(?:\s+(?:on|from|off)\s+(?:my|the)\s+(?:to-?\s?do|task|shopping)?\s*list)?[.!]?$/i.exec(s);
  if (done) {
    const text = trimTitle(done[1].replace(/^(?:the|my)\s+/i, ''));
    if (text && !/\b(?:timer|alarm|reminder)\b/i.test(text)) return { kind: 'tool', topic: 'todo-done', tool: 'complete_todo', args: { text } };
  }
  return null;
}

function detectNote(s: string, lower: string): Intent | null {
  const create = /^(?:take|make|write|create|add|jot|save|start)\s+(?:down\s+)?(?:a\s+|me\s+a\s+|new\s+)?note\b\s*(.*)$/i.exec(s)
    ?? /^(?:note|jot down|write down|note down|note to self)\s*[:,-]?\s+(.+)$/i.exec(s);
  if (create && !/^(?:s\b|book)/i.test(create[1] ?? '')) {
    let rest = clean(create[1] ?? '');
    let title = '';
    const named = /^(?:called|titled|named)\s+["“]?(.+?)["”]?\s*(?:[:\-–]|\bsaying\b|\bthat says\b|\bwith\b)\s*(.+)$/i.exec(rest);
    if (named) {
      title = named[1];
      rest = named[2];
    } else {
      rest = rest.replace(/^(?:that|saying|about|:|-)\s*/i, '');
      const colon = /^([^:]{2,60}):\s*(.+)$/.exec(rest);
      if (colon && colon[1].split(' ').length <= 6) {
        title = colon[1];
        rest = colon[2];
      }
    }
    const body = rest.trim();
    if (!body) return { kind: 'ask', question: 'What should the note say, sugar?' };
    if (!title) title = body.split(/\s+/).slice(0, 6).join(' ').replace(/[,.;:!?]+$/, '');
    return { kind: 'tool', topic: 'note', tool: 'create_note', args: { title: capitalize(title.trim()), body: capitalize(body) } };
  }
  const read = /\b(?:read|open|show)\s+(?:me\s+)?(?:my\s+|the\s+)?note\s+(?:about|on|called|titled|named|for)?\s*(.+)$/i.exec(s);
  if (read) return { kind: 'note-read', query: trimTitle(read[1]) };
  if (/\bnotes\b/.test(lower) && /\b(?:show|list|what|read|find|search|any|my|all)\b/.test(lower)) {
    const q = /\bnotes?\s+(?:about|on|for|with|containing|mentioning|that mention)\s+(.+)$/i.exec(s);
    const query = q ? trimTitle(q[1]) : undefined;
    return { kind: 'tool', topic: 'notes', tool: 'list_notes', args: query ? { query } : {} };
  }
  return null;
}

function detectEvent(s: string, now: Date, deps: { dayFirst?: boolean }): Intent | null {
  const command = /^(?:add|schedule|put|create|book|set up|make|plan|pencil in|log)\b\s*(?:in\s+)?(?:an?\s+)?(?:new\s+)?(.*)$/i.exec(s);
  const statement = /^(?:i (?:have|'ve got|got)|there'?s)\s+(?:an?\s+)?(.*\b(?:meeting|appointment|call|interview|dinner|lunch|class|date|party|flight|exam|dentist|doctor)\b.*)$/i.exec(s);
  const source = command ?? statement;
  if (!source) return null;
  let body = source[1] ?? '';
  if (command && !EVENT_WORDS.test(body) && !/\b(?:on|to|in) (?:my|the) (?:calendar|schedule)\b/i.test(s)) return null;
  body = body
    .replace(/\b(?:to|on|in|into)\s+(?:my|the)\s+(?:calendar|schedule|agenda|timeline)\b/gi, ' ')
    .replace(/^(?:an?\s+)?(?:event|calendar entry|entry)\s+(?:for\s+)?/i, '');
  const length = EVENT_LENGTH.exec(body);
  const lengthSeconds = length ? findDuration(length[1])?.seconds : undefined;
  if (length) body = body.replace(length[0], ' ');
  const split = splitTimeRange(body);
  const when = parseWhen(split.body, now, whenOptions(deps));
  const title = trimTitle(when ? withoutSpans(split.body, when.spans) : split.body);
  if (!when) return { kind: 'ask', question: `What day and time is "${capitalize(title || 'it')}"?` };
  return eventIntent(title, when, now, split.end, lengthSeconds);
}

function detectAgenda(s: string, lower: string, now: Date): Intent | null {
  const asks = (/\b(?:my|the)\s+(?:schedule|calendar|agenda|day|week|weekend|timeline)\b/.test(lower)
      && /\b(?:what|show|check|read|how|anything|tell|look|give|whats|what's|go over|run through)\b/.test(lower))
    || /\bwhat'?s\s+(?:on|up|happening|planned|scheduled|going on)\s+(?:for\s+|on\s+)?(?:today|tomorrow|tonight|this|next|my|the|on|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(lower)
    || /\bwhat'?s\s+on\b\s*\??$/.test(lower)
    || /\b(?:what|anything)\s+(?:do i have|have i got|is planned|is scheduled|am i doing|'?s planned)\b/.test(lower)
    || /\b(?:do i have|have i got)\s+(?:anything|any\s+\w+|something|plans|meetings?|appointments?)\b/.test(lower)
    || /\bam i (?:free|busy|booked)\b/.test(lower)
    || (/\b(?:any|my|upcoming|next)\s+(?:meetings?|appointments?|events?|reminders?)\b/.test(lower) && /\?|\b(?:what|when|show|list|any|do i)\b/.test(lower));
  if (!asks) return null;
  const range = rangeFor(s, now);
  const kind = /\breminders?\b/.test(lower) ? 'reminder' : /\balarms?\b/.test(lower) ? 'alarm' : /\b(?:meetings?|events?|appointments?)\b/.test(lower) ? 'event' : 'all';
  return { kind: 'agenda', args: { from: localIso(range.from), to: localIso(range.to), kind }, label: range.label };
}

function detectTime(s: string, lower: string): Intent | null {
  if (/\b(?:what(?:'s| is)?\s+(?:the\s+)?time|what time is it|time is it|current time|tell me the time|got the time|the time (?:in|at|over in)|time (?:in|at) [a-z]|time now|local time)\b/.test(lower)) {
    const city = cityFrom(s);
    return { kind: 'tool', topic: 'time', tool: 'get_time', args: city ? { city } : {} };
  }
  if (/\b(?:what(?:'s| is)\s+(?:the\s+|today'?s\s+)?date|what day is (?:it|today)|what'?s today|today'?s date|which day is it|what is today)\b/.test(lower)) {
    return { kind: 'tool', topic: 'date', tool: 'get_time', args: {} };
  }
  return null;
}

function detectWeather(s: string, lower: string): Intent | null {
  if (!/\b(?:weather|forecast|temperature|rain(?:ing|y)?|snow(?:ing|y)?|umbrella|sunny|humid(?:ity)?|windy|storm(?:y|s)?|how (?:hot|cold|warm|chilly) is it|degrees (?:outside|out))\b/.test(lower)) return null;
  let days = 1;
  const next = /\bnext\s+(\d)\s+days\b/.exec(lower);
  if (next) days = Math.min(7, Number(next[1]) + 1);
  else if (/\b(?:week|weekend|next few days|coming days|forecast)\b/.test(lower)) days = 7;
  else if (/\btomorrow\b/.test(lower)) days = 2;
  const city = cityFrom(s);
  const args: Record<string, unknown> = {};
  if (city) args.city = city;
  if (days > 1) args.days = days;
  return { kind: 'tool', topic: /\btomorrow\b/.test(lower) ? 'weather-tomorrow' : 'weather', tool: 'get_weather', args };
}

function detectSearch(s: string, explicitOnly: boolean): Intent | null {
  const m = /^(?:search|look\s*up|google|lookup|research|find out|find info(?:rmation)? (?:on|about))\s+(?:the\s+web\s+|online\s+|the\s+internet\s+|google\s+)?(?:for\s+|about\s+|on\s+)?(.+)$/i.exec(s);
  if (m) return { kind: 'tool', topic: 'search', tool: 'web_search', args: { query: trimTitle(m[1]).replace(/\?$/, '') } };
  if (explicitOnly) return null;
  const q = /^(?:who|what|when|where|why|how)\s+(?:is|are|was|were|did|does|do|many|much|far|old|tall|big)\b.{3,}$/i.exec(s)
    ?? /^(?:tell me about|what do you know about)\s+(?!me\b|yourself\b)(.{3,})$/i.exec(s);
  if (q) return { kind: 'tool', topic: 'search', tool: 'web_search', args: { query: s.replace(/^(?:tell me about|what do you know about)\s+/i, '').replace(/\?+$/, '') } };
  return null;
}

function detectMemory(s: string, lower: string): Intent | null {
  if (/\b(?:what do you (?:know|remember) about me|what have you (?:learned|remembered)|what do you know of me|tell me (?:about myself|what you know)|what do you have on (?:me|file)|my (?:dossier|case file|file|profile))\b/.test(lower)) {
    return { kind: 'memory-list' };
  }
  if (/\b(?:what'?s my name|who am i|do you know my name|what do you call me|do you know who i am)\b/.test(lower)) return { kind: 'memory-name' };
  const forget = /^(?:please\s+)?forget\s+(?:that\s+|about\s+|what i said about\s+)?(.+)$/i.exec(s);
  if (forget && !/^(?:it|everything|all of it)\b/i.test(forget[1])) return { kind: 'forget', query: trimTitle(forget[1]) };
  if (forget) return { kind: 'say', text: 'To clear my memory wholesale, open the Dossier panel, sugar. Tell me one thing to forget and I\'ll find it.', emotion: 'talking', gesture: 'point' };

  const name = /\b(?:my name is|my name's|call me|you can call me|i go by|the name'?s|i'm called|i am called)\s+([A-Za-z][\w'-]*(?:\s+[A-Z][\w'-]*)?)/i.exec(s);
  if (name) {
    const value = titleCase(name[1].replace(/\b(?:please|thanks)\b/gi, '').trim());
    const callMe = /\b(?:call me|go by)\b/i.test(name[0]);
    return {
      kind: 'remember',
      fact: callMe ? `Prefers to be called ${value}.` : `Name is ${value}.`,
      category: 'identity',
      reply: `Pleased to meet you, ${value}! I'll remember that.`,
    };
  }
  const place = /\b(?:i live in|i'm based in|i am based in|i moved to|i just moved to|i'm living in|i am living in|i reside in|my home(?:town)? is)\s+([A-Za-z][\w .'-]{1,60}?)(?:\s+(?:now|these days|since\b.*))?[.!]?$/i.exec(s);
  if (place) {
    const city = titleCase(place[1].trim());
    return { kind: 'remember', fact: `Lives in ${city}.`, category: 'place', reply: `${city}, noted. I'll keep that in your dossier.` };
  }
  const remember = /^(?:remember|don'?t forget|keep in mind|make a note that|note that)\s+(?:that\s+)?(.{3,})$/i.exec(s);
  if (remember && !/^to\b/i.test(remember[1])) {
    const fact = ownerFact(remember[1]);
    return { kind: 'remember', fact, category: 'other', reply: `${pick(s, LINES.remembered)}` };
  }
  return null;
}

const LORE = OFFLINE_LORE_RESPONSES.filter(entry => !entry.triggers.includes('help'));

function detectSmallTalk(s: string, lower: string, now: Date): Intent | null {
  if (/^(?:help|what can you do|what do you do|commands|features|how do (?:i|you) (?:use|work)|what are your (?:features|abilities|skills)|what can i (?:ask|say))\b/.test(lower) || lower === '?') {
    return { kind: 'say', text: OFFLINE_HELP, emotion: 'cheerful', gesture: 'present' };
  }
  if (/\b(?:who are you|what are you|what is your name|what'?s your name|are you (?:real|an? ai|a robot|alive))\b/.test(lower)) {
    const intro = OFFLINE_LORE_RESPONSES.find(entry => entry.triggers.includes('who are you'));
    return { kind: 'lore', text: intro?.text ?? "I'm Miss Minutes, sugar.", emotion: intro?.emotion ?? 'cheerful' };
  }
  if (/^(?:hi|hello|hey|howdy|hiya|yo|greetings|good\s+(?:morning|afternoon|evening|day)|sup|what'?s\s+up|heya)\b[\s!.,?]*(?:there|y'?all|miss\s+minutes?|sugar)?[\s!.,?]*$/.test(lower)) {
    return { kind: 'say', text: `${pick(s, LINES.greeting)} ${partOfDayGreeting(now)} What can I do for you?`, emotion: 'cheerful', gesture: 'wave' };
  }
  if (/\b(?:thanks|thank you|thx|thank u|ty|cheers|much obliged|appreciate it)\b/.test(lower) && lower.length < 60) {
    return { kind: 'say', text: pick(s, LINES.thanks), emotion: 'blushing', gesture: 'none' };
  }
  if (/\bhow (?:are|r) (?:you|ya|u)\b|\bhow'?s it going\b|\bhow are things\b|\bhow do you do\b|\bhow have you been\b/.test(lower)) {
    return { kind: 'say', text: pick(s, LINES.howAreYou), emotion: 'cheerful', gesture: 'none' };
  }
  if (/^(?:bye|goodbye|good night|goodnight|see you|see ya|later|farewell|talk to you later|ttyl|i'?m off|gotta go)\b/.test(lower)) {
    return { kind: 'say', text: pick(s, LINES.bye), emotion: 'winking', gesture: 'wave' };
  }
  for (const entry of LORE) {
    if (entry.triggers.some(trigger => new RegExp(`\\b${trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(lower))) {
      if (entry.triggers.includes('hello')) continue;
      return { kind: 'lore', text: entry.text, emotion: entry.emotion };
    }
  }
  return null;
}

/** Classifies a request without side effects. */
export function detectIntent(text: string, now: Date, history: ChatMessage[] = [], deps: { dayFirst?: boolean } = {}): Intent {
  const s = normalizeRequest(text);
  const lower = s.toLowerCase();
  if (!s) return { kind: 'say', text: `${pick(text, LINES.greeting)} What can I do for you?`, emotion: 'cheerful', gesture: 'wave' };
  return continuation(s, now, history, deps)
    ?? detectHelp(lower)
    ?? detectMemory(s, lower)
    ?? detectReminder(s, lower, now, deps)
    ?? detectTimer(s, lower)
    ?? detectAlarm(s, lower, now, deps)
    ?? detectTodo(s, lower, now, deps)
    ?? detectNote(s, lower)
    ?? detectAgenda(s, lower, now)
    ?? detectEvent(s, now, deps)
    ?? detectTime(s, lower)
    ?? detectWeather(s, lower)
    ?? mathIntent(s)
    ?? detectSearch(s, true)
    ?? detectSmallTalk(s, lower, now)
    ?? detectSearch(s, false)
    ?? { kind: 'fallback' };
}

function detectHelp(lower: string): Intent | null {
  if (/^(?:help|what can you do|what do you do|commands|features|what can i (?:ask|say))\b/.test(lower)) {
    return { kind: 'say', text: OFFLINE_HELP, emotion: 'cheerful', gesture: 'present' };
  }
  return null;
}

function mathIntent(s: string): Intent | null {
  const expression = extractExpression(s);
  return expression ? { kind: 'math', expression } : null;
}

// ── Execution and replies ─────────────────────────────────────────────────────────

function asDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const d = new Date(value.length === 10 ? `${value}T00:00` : value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function firstString(item: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

const LIST_KEYS = ['items', 'entries', 'events', 'agenda', 'schedule', 'todos', 'tasks', 'timers', 'notes', 'results', 'memories', 'facts', 'days', 'forecast', 'alarms', 'reminders'];

function findList(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  for (const key of LIST_KEYS) if (Array.isArray(record[key])) return record[key] as unknown[];
  return null;
}

/** One readable line per item for list results (agenda, to-dos, notes, timers, search results). */
export function renderItems(data: unknown, now: Date, max = 8): string[] {
  const list = findList(data);
  if (!list) return [];
  return list.slice(0, max).map(entry => {
    if (typeof entry === 'string') return entry;
    if (!entry || typeof entry !== 'object') return String(entry);
    const item = entry as Record<string, unknown>;
    const title = firstString(item, ['title', 'text', 'label', 'name', 'fact', 'summary', 'query']) ?? 'Untitled';
    const url = firstString(item, ['url', 'link']);
    const snippet = firstString(item, ['snippet', 'extract', 'description']);
    if (url || snippet) {
      const head = url && /^https?:\/\//.test(url) ? `[${title}](${url})` : title;
      return snippet ? `${head}: ${snippet.length > 180 ? `${snippet.slice(0, 179)}…` : snippet}` : head;
    }
    const whenRaw = firstString(item, ['when', 'start', 'at', 'due', 'starts', 'time', 'date']);
    const when = asDate(whenRaw);
    const timeText = when ? describeWhen(when, now, !/^\d{4}-\d{2}-\d{2}$/.test(whenRaw ?? '')) : whenRaw;
    const remaining = firstString(item, ['remaining']);
    const bits = [title];
    if (timeText) bits.push(timeText);
    if (remaining) bits.push(`${remaining} left`);
    if (typeof item.location === 'string' && item.location) bits.push(`at ${item.location}`);
    if (item.done === true) bits.push('(done)');
    if (typeof item.state === 'string' && item.state !== 'running') bits.push(`(${item.state})`);
    if (typeof item.status === 'string' && /overdue|snoozed|off/.test(item.status)) bits.push(`(${item.status})`);
    if (typeof item.priority === 'string' && item.priority === 'high') bits.push('(high priority)');
    return bits.join(', ');
  });
}

function reply(text: string, emotion: Emotion, gesture: Gesture, kind: OfflineReply['kind']): OfflineReply {
  return { text, emotion, gesture, kind };
}

function sentence(text: string): string {
  const t = text.trim();
  return /[.!?…)]$/.test(t) ? t : `${t}.`;
}

function outcomeProblem(outcome: ToolOutcome, seed: string): OfflineReply | null {
  if (outcome.record.status === 'denied') return reply(pick(seed, LINES.denied), 'cheerful', 'none', 'action');
  if (outcome.record.status === 'error') {
    const error = outcome.record.error ?? outcome.result?.summary ?? 'something went wrong';
    return reply(`${pick(seed, LINES.failed)} ${sentence(error)}`, 'worried', 'shrug', 'action');
  }
  return null;
}

function unavailable(tool: string, seed: string): OfflineReply {
  return reply(`${pick(seed, LINES.unavailable)} (The ${tool} tool isn't available here.)`, 'worried', 'shrug', 'info');
}

const TOPIC_LINES: Record<string, readonly string[]> = {
  timer: LINES.timer,
  'timer-control': LINES.done,
  reminder: LINES.reminder,
  alarm: LINES.alarm,
  event: LINES.event,
  'todo-add': LINES.todo,
  'todo-done': LINES.done,
  note: LINES.note,
};

function toolSuccessReply(intent: Extract<Intent, { kind: 'tool' }>, outcome: ToolOutcome, seed: string, now: Date): OfflineReply {
  const summary = outcome.result?.summary?.trim() ?? '';
  const data = outcome.result?.data;
  switch (intent.topic) {
    case 'timers':
    case 'todos':
    case 'notes': {
      const items = renderItems(data, now);
      const lead = summary ? sentence(summary) : 'Here you go.';
      if (items.length === 0) return reply(lead, 'cheerful', 'present', 'info');
      // Summaries that already list items don't need the bullets repeated.
      const listed = items.every(item => summary.includes(item.split(',')[0]));
      return reply(listed ? lead : `${lead}\n${items.map(item => `- ${item}`).join('\n')}`, 'cheerful', 'present', 'info');
    }
    case 'time':
    case 'date':
      return reply(sentence(summary || 'I checked the clock, sugar'), 'cheerful', 'none', 'info');
    case 'weather':
    case 'weather-tomorrow':
      return reply(sentence(summary || 'Here is the weather'), 'cheerful', 'present', 'info');
    case 'search': {
      const items = renderItems(data, now, 3);
      const lead = summary ? sentence(summary) : 'Here is what I found.';
      return reply(items.length ? `${lead}\n${items.map(item => `- ${item}`).join('\n')}` : lead, 'thinking', 'present', 'info');
    }
    default: {
      const opener = pick(seed, TOPIC_LINES[intent.topic] ?? LINES.done);
      return reply(summary ? `${opener} ${sentence(summary)}` : opener, intent.topic === 'alarm' ? 'winking' : 'cheerful', intent.topic === 'reminder' ? 'point' : 'present', 'action');
    }
  }
}

async function runTool(intent: Extract<Intent, { kind: 'tool' }>, deps: OfflineDeps, seed: string): Promise<OfflineReply> {
  if (!deps.tools.has(intent.tool)) return unavailable(intent.tool, seed);
  const outcome = await deps.tools.run(intent.tool, intent.args);
  return outcomeProblem(outcome, seed) ?? toolSuccessReply(intent, outcome, seed, deps.now);
}

async function memoryList(deps: OfflineDeps): Promise<OfflineReply> {
  const memories = await deps.memory.list();
  if (memories.length === 0) {
    return reply("Your dossier's empty so far, sugar. Tell me things like \"my name is Sam\" or \"remember that I like jazz\" and I'll keep them.", 'thinking', 'shrug', 'info');
  }
  const lines = memories.slice(0, 10).map(memory => `- ${memory.text}`);
  const more = memories.length > 10 ? `\n…and ${memories.length - 10} more in the Dossier panel.` : '';
  return reply(`Here's what's in your file, darlin':\n${lines.join('\n')}${more}`, 'winking', 'present', 'info');
}

async function memoryName(deps: OfflineDeps): Promise<OfflineReply> {
  const memories = await deps.memory.list();
  const fact = memories.find(memory => memory.category === 'identity' && /\b(?:name|called|goes by)\b/i.test(memory.text));
  if (!fact) return reply("I don't have your name on file yet, sugar. What should I call you?", 'thinking', 'shrug', 'question');
  const name = /(?:called|name is|goes by|named)\s+([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)?)/.exec(fact.text)?.[1];
  return reply(name ? `You're ${name}, of course. I never forget a variant, darlin'.` : `My file says: ${fact.text}`, 'winking', 'none', 'info');
}

async function remember(intent: Extract<Intent, { kind: 'remember' }>, deps: OfflineDeps, seed: string): Promise<OfflineReply> {
  if (containsSecret(intent.fact)) {
    return reply("I don't keep passwords, keys or card numbers in my dossier, sugar. A password manager is the place for those.", 'stern', 'point', 'info');
  }
  if (deps.tools.has('remember')) {
    const outcome = await deps.tools.run('remember', { fact: intent.fact, category: intent.category });
    const problem = outcomeProblem(outcome, seed);
    if (problem) return problem;
  } else {
    await deps.memory.save(intent.fact, intent.category);
  }
  return reply(intent.reply, 'winking', 'none', 'action');
}

async function forget(intent: Extract<Intent, { kind: 'forget' }>, deps: OfflineDeps, seed: string): Promise<OfflineReply> {
  const matches = await deps.memory.search(intent.query);
  if (matches.length === 0) return reply(`I don't have anything on file about "${intent.query}", sugar.`, 'thinking', 'shrug', 'info');
  if (!deps.tools.has('forget')) return unavailable('forget', seed);
  const target = matches[0];
  const outcome = await deps.tools.run('forget', { id: target.id });
  const problem = outcomeProblem(outcome, seed);
  if (problem) return problem;
  return reply(`Gone from the record: "${target.text}" It never happened, as far as the TVA's concerned.`, 'winking', 'none', 'action');
}

async function readNote(intent: Extract<Intent, { kind: 'note-read' }>, deps: OfflineDeps, seed: string): Promise<OfflineReply> {
  if (!deps.tools.has('list_notes') || !deps.tools.has('read_note')) return unavailable('notes', seed);
  const list = await deps.tools.run('list_notes', intent.query ? { query: intent.query } : {});
  const problem = outcomeProblem(list, seed);
  if (problem) return problem;
  const notes = findList(list.result?.data) as Array<Record<string, unknown>> | null;
  const first = notes?.find(note => note && typeof note.id === 'string');
  if (!first) return reply(`I couldn't find a note about "${intent.query}", sugar.`, 'thinking', 'shrug', 'info');
  const note = await deps.tools.run('read_note', { id: first.id as string });
  const readProblem = outcomeProblem(note, seed);
  if (readProblem) return readProblem;
  const data = (note.result?.data ?? {}) as Record<string, unknown>;
  const title = firstString(data, ['title']) ?? firstString(first, ['title']) ?? 'Your note';
  const body = firstString(data, ['body', 'text', 'content']) ?? note.result?.summary ?? '';
  return reply(`**${title}**\n\n${body}`, 'talking', 'present', 'info');
}

async function math(intent: Extract<Intent, { kind: 'math' }>, deps: OfflineDeps, seed: string): Promise<OfflineReply> {
  if (deps.tools.has('calculate')) {
    const outcome = await deps.tools.run('calculate', { expression: intent.expression });
    const problem = outcomeProblem(outcome, seed);
    if (problem) return problem;
    const summary = outcome.result?.summary?.trim();
    if (summary) return reply(sentence(summary), 'cheerful', 'present', 'info');
  }
  try {
    const value = evaluate(intent.expression);
    return reply(`That comes out to **${formatNumber(value)}**, sugar.`, 'cheerful', 'present', 'info');
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'that math';
    return reply(`I can't work that one out: ${reason}.`, 'worried', 'shrug', 'info');
  }
}

async function agenda(intent: Extract<Intent, { kind: 'agenda' }>, deps: OfflineDeps, seed: string): Promise<OfflineReply> {
  if (!deps.tools.has('list_schedule')) return unavailable('list_schedule', seed);
  const outcome = await deps.tools.run('list_schedule', intent.args);
  const problem = outcomeProblem(outcome, seed);
  if (problem) return problem;
  const items = renderItems(outcome.result?.data, deps.now, 10);
  const summary = outcome.result?.summary?.trim() ?? '';
  if (items.length === 0) {
    return reply(summary ? sentence(summary) : `Nothing on the books for ${intent.label}, sugar. A quiet stretch of the Sacred Timeline.`, 'cheerful', 'none', 'info');
  }
  return reply(`${summary ? sentence(summary) : `Here's ${intent.label}:`}\n${items.map(item => `- ${item}`).join('\n')}`, 'talking', 'present', 'info');
}

/** Answers one message offline: detects the intent, runs any tools, and phrases the result. */
export async function respondOffline(text: string, deps: OfflineDeps): Promise<OfflineReply> {
  const intent = detectIntent(text, deps.now, deps.history, deps);
  const seed = text;
  switch (intent.kind) {
    case 'tool':
      return runTool(intent, deps, seed);
    case 'agenda':
      return agenda(intent, deps, seed);
    case 'ask':
      return reply(intent.question, intent.emotion ?? 'thinking', 'think', 'question');
    case 'remember':
      return remember(intent, deps, seed);
    case 'memory-list':
      return memoryList(deps);
    case 'memory-name':
      return memoryName(deps);
    case 'forget':
      return forget(intent, deps, seed);
    case 'note-read':
      return readNote(intent, deps, seed);
    case 'math':
      return math(intent, deps, seed);
    case 'lore':
      return reply(intent.text, intent.emotion, 'present', 'chat');
    case 'say':
      return reply(intent.text, intent.emotion, intent.gesture, 'chat');
    default:
      return reply(`${pick(seed, LINES.fallback)} I can set timers, alarms and reminders, keep your calendar, to-dos and notes, check the time, weather and the web, do math, and remember things about you. Say "help" for examples, or connect a model in Settings for open conversation.`, 'thinking', 'shrug', 'fallback');
  }
}

/** True for intents that do something useful even when a model provider is failing. */
export function isActionable(intent: Intent): boolean {
  return intent.kind === 'tool' || intent.kind === 'agenda' || intent.kind === 'remember' || intent.kind === 'math'
    || intent.kind === 'memory-list' || intent.kind === 'memory-name' || intent.kind === 'note-read';
}

/**
 * Learns durable facts about the owner after each completed turn: name, home, preferences,
 * people, projects, routines and important dates. Model providers use a small strict-JSON
 * call; the offline engine (or a failed call) uses phrase patterns. Secrets, identifiers and
 * sensitive guesses are filtered out before anything is stored, and changed facts replace the
 * old record instead of piling up.
 */
import type { AISettings } from '../../types';
import type { MemoryCategory, MemoryRecord } from '../../store/db';
import { completeUtility, parseJsonObject } from '../brain/utility';
import { MEMORY_CATEGORIES, cleanFact, listMemories, searchMemories, upsertMemory } from './store';
import { safeToAutoRemember } from './sensitive';

export interface ExtractionInput {
  chatId?: string;
  userText: string;
  replyText: string;
  settings: AISettings;
}

interface CandidateFact {
  text: string;
  category: MemoryCategory;
  replaces?: string;
}

const MAX_FACTS_PER_TURN = 4;

const EXTRACTION_TASK = `You maintain the long-term memory of Miss Minutes, a personal assistant, about her owner.
From the exchange you are given, extract durable facts the OWNER stated about themselves or their life that will still matter weeks from now: their name or what to call them, where they live or work, preferences and dislikes, important people (names and relationships), pets, projects, routines, important dates.
Rules:
- Only facts the owner said directly. Never infer or guess. Nothing about the assistant.
- Skip anything temporary (today's plans, a timer, a one-off reminder), questions, and small talk.
- Never include secrets or identifiers: passwords, PINs, API keys, tokens, card, bank, passport or ID numbers, phone numbers, email or street addresses.
- Skip sensitive topics (health, religion, politics, sexuality, ethnicity, finances, legal matters).
- Write each fact as one short sentence without a subject, e.g. "Prefers to be called Irshad.", "Lives in Pune.", "Has a daughter named Aisha.", "Prefers tea over coffee."
- If a fact updates or contradicts one of the known facts, set "replaces" to that fact's id; otherwise null.
- Leave out facts already known with the same meaning.
Return only JSON: {"facts":[{"text":"...","category":"identity|preference|person|place|project|routine|other","replaces":null}]}. Return {"facts":[]} when there is nothing worth keeping.`;

const FACTS_SCHEMA = {
  type: 'object',
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          category: { type: 'string', enum: [...MEMORY_CATEGORIES] },
          replaces: { type: ['string', 'null'] },
        },
        required: ['text', 'category', 'replaces'],
        additionalProperties: false,
      },
    },
  },
  required: ['facts'],
  additionalProperties: false,
};

/** Cheap gate: only messages that talk about the owner are worth a model call. */
export function mightContainFacts(text: string): boolean {
  if (text.trim().length < 8) return false;
  return /\b(?:i|i'm|im|i am|i've|i'd|i'll|my|me|mine|myself|we|we're|our|us|call me)\b/i.test(text);
}

// ── Patterns (offline) ───────────────────────────────────────────────────────────

interface Pattern {
  re: RegExp;
  category: MemoryCategory;
  /** Existing facts in the same slot are replaced (one home, one name...). */
  slot?: RegExp;
  fact(match: RegExpExecArray): string | null;
}

function words(text: string, max = 8): string | null {
  const cleaned = text.replace(/\s+/g, ' ').replace(/[.!?,;:]+$/, '').trim();
  if (!cleaned || cleaned.split(' ').length > max) return null;
  return cleaned;
}

function title(text: string): string {
  return text.replace(/\b([a-z])/g, (m: string) => m.toUpperCase());
}

const RELATIONS = 'wife|husband|partner|girlfriend|boyfriend|fianc[eé]e?|son|daughter|kid|child|mom|mum|mother|dad|father|brother|sister|grandma|grandmother|grandpa|grandfather|aunt|uncle|cousin|best friend|friend|boss|manager|colleague|coworker|roommate|dog|cat|puppy|kitten|pet';

const PATTERNS: Pattern[] = [
  {
    re: /\b(?:my name is|my name's|i'm called|i am called)\s+([A-Za-z][\w'-]*(?:\s+[A-Z][\w'-]*)?)/i,
    category: 'identity',
    slot: /^(?:name is|is named|prefers to be called|goes by)\b/i,
    fact: m => `Name is ${title(m[1])}.`,
  },
  {
    re: /\b(?:call me|you can call me|i go by|please call me)\s+([A-Za-z][\w'-]*)/i,
    category: 'identity',
    slot: /^(?:prefers to be called|goes by)\b/i,
    fact: m => (/^(?:back|later|tomorrow|when|if|at|a|an|the)$/i.test(m[1]) ? null : `Prefers to be called ${title(m[1])}.`),
  },
  {
    re: /\b(?:i live in|i'm based in|i am based in|i moved to|i just moved to|i'm living in|i am living in|i reside in)\s+([A-Za-z][\w .'-]{1,50}?)(?=[.,!?]|\s+(?:now|with|and|since|for)\b|$)/i,
    category: 'place',
    slot: /^lives in\b/i,
    fact: m => {
      const place = words(m[1], 5);
      return place ? `Lives in ${title(place)}.` : null;
    },
  },
  {
    re: /\bi(?:'m| am) from\s+([A-Za-z][\w .'-]{1,50}?)(?=[.,!?]|\s+(?:but|and|originally)\b|$)/i,
    category: 'place',
    slot: /^(?:is )?from\b/i,
    fact: m => {
      const place = words(m[1], 5);
      return place ? `Is from ${title(place)}.` : null;
    },
  },
  {
    re: /\bi work (?:at|for)\s+([A-Za-z0-9][\w .&'-]{1,50}?)(?=[.,!?]|\s+(?:as|in|and|since)\b|$)/i,
    category: 'project',
    slot: /^works (?:at|for)\b/i,
    fact: m => {
      const place = words(m[1], 6);
      return place ? `Works at ${place}.` : null;
    },
  },
  {
    re: /\bi(?:'m| am) an?\s+([a-z][\w -]{2,40}?)\s+(?:by profession|by trade)\b|\bi work as an?\s+([a-z][\w -]{2,40}?)(?=[.,!?]|\s+(?:at|for|in)\b|$)/i,
    category: 'project',
    slot: /^works as\b/i,
    fact: m => {
      const job = words(m[1] ?? m[2] ?? '', 5);
      return job ? `Works as ${/^[aeiou]/i.test(job) ? 'an' : 'a'} ${job}.` : null;
    },
  },
  {
    // "my wife's name is Sara", "my dog is called rex"
    re: new RegExp(`\\bmy (${RELATIONS})(?:'s name is| is called| is named| named| called)\\s+([A-Za-z][\\w'-]*)`, 'i'),
    category: 'person',
    fact: m => `Has a ${m[1].toLowerCase()} named ${title(m[2])}.`,
  },
  {
    // "my wife is Sara": only a capitalized word counts as a name ("my boss is annoying" doesn't).
    re: new RegExp(`\\b[Mm]y (${RELATIONS}) is ([A-Z][a-z'-]+)\\b`),
    category: 'person',
    fact: m => (/^(?:The|A|An|Very|So|Really|Not|Home|Here|There|Sick|Away|Out|Back)$/.test(m[2]) ? null : `Has a ${m[1].toLowerCase()} named ${m[2]}.`),
  },
  {
    re: /\bmy birthday is (?:on )?([A-Za-z]+ \d{1,2}(?:st|nd|rd|th)?|\d{1,2}(?:st|nd|rd|th)? (?:of )?[A-Za-z]+)/i,
    category: 'identity',
    slot: /^birthday is\b/i,
    fact: m => `Birthday is ${m[1]}.`,
  },
  {
    re: /\bi(?:'m| am) (?:a )?(vegetarian|vegan|pescatarian|night owl|early bird|morning person|left-handed)\b/i,
    category: 'preference',
    fact: m => `Is ${/^(?:night owl|early bird|morning person)$/i.test(m[1]) ? 'a ' : ''}${m[1].toLowerCase()}.`,
  },
  {
    re: /\bi (?:really |absolutely )?(love|like|enjoy|adore)\s+([a-z][\w '&-]{2,40}?)(?=[.,!?]|\s+(?:and|but|so|because)\b|$)/i,
    category: 'preference',
    fact: m => {
      const thing = words(m[2], 5);
      if (!thing || /^(?:to|it|that|this|you|when|how|the way|your)\b/i.test(thing)) return null;
      return `${m[1].toLowerCase() === 'like' ? 'Likes' : m[1].toLowerCase() === 'enjoy' ? 'Enjoys' : 'Loves'} ${thing}.`;
    },
  },
  {
    re: /\bi prefer\s+([a-z][\w '-]{1,30}?)\s+(?:over|to)\s+([a-z][\w '-]{1,30}?)(?=[.,!?]|$)/i,
    category: 'preference',
    fact: m => `Prefers ${m[1].trim()} over ${m[2].trim()}.`,
  },
  {
    re: /\bi (?:really )?(?:hate|dislike|can't stand|cannot stand|don't like)\s+([a-z][\w '&-]{2,40}?)(?=[.,!?]|\s+(?:and|but|so|because)\b|$)/i,
    category: 'preference',
    fact: m => {
      const thing = words(m[1], 5);
      if (!thing || /^(?:to|it|that|this|you|when|how)\b/i.test(thing)) return null;
      return `Dislikes ${thing}.`;
    },
  },
  {
    re: /\bi(?:'m| am) (?:currently )?working on\s+([a-z0-9][\w '&.-]{2,60}?)(?=[.,!?]|\s+(?:and|but|for|at)\b|$)/i,
    category: 'project',
    fact: m => {
      const project = words(m[1], 8);
      return project ? `Is working on ${project}.` : null;
    },
  },
  {
    re: /\b(?:every|each) (morning|evening|night|day|weekday|monday|tuesday|wednesday|thursday|friday|saturday|sunday),? i\s+([a-z][\w '-]{2,50}?)(?=[.,!?]|$)/i,
    category: 'routine',
    fact: m => {
      const action = words(m[2], 8);
      return action ? `Every ${m[1].toLowerCase()}: ${action}.` : null;
    },
  },
];

/** Facts recognizable from phrasing alone ("my name is...", "I live in..."). */
export function patternFacts(userText: string, existing: MemoryRecord[] = []): CandidateFact[] {
  const out: CandidateFact[] = [];
  for (const pattern of PATTERNS) {
    const match = pattern.re.exec(userText);
    if (!match) continue;
    const text = pattern.fact(match);
    if (!text) continue;
    const replaces = pattern.slot ? existing.find(memory => pattern.slot?.test(memory.text))?.id : undefined;
    out.push({ text, category: pattern.category, replaces });
  }
  return out;
}

// ── Model extraction ─────────────────────────────────────────────────────────────

async function knownFacts(userText: string): Promise<MemoryRecord[]> {
  const [all, related] = await Promise.all([listMemories(), searchMemories(userText, 10)]);
  const byId = new Map<string, MemoryRecord>();
  for (const memory of [...all.filter(item => item.category === 'identity' || item.category === 'place').slice(0, 8), ...related]) {
    byId.set(memory.id, memory);
  }
  return [...byId.values()].slice(0, 16);
}

async function modelFacts(input: ExtractionInput, known: MemoryRecord[]): Promise<CandidateFact[]> {
  const prompt = JSON.stringify({
    known_facts: known.map(memory => ({ id: memory.id, text: memory.text, category: memory.category })),
    exchange: { owner: input.userText.slice(0, 4000), assistant: input.replyText.slice(0, 1500) },
  });
  const raw = await completeUtility(input.settings, EXTRACTION_TASK, prompt, {
    json: { name: 'memory_facts', schema: FACTS_SCHEMA },
    maxOutputTokens: 600,
  });
  const parsed = parseJsonObject(raw);
  const facts = Array.isArray(parsed?.facts) ? (parsed?.facts as unknown[]) : [];
  const knownIds = new Set(known.map(memory => memory.id));
  const out: CandidateFact[] = [];
  for (const entry of facts) {
    if (!entry || typeof entry !== 'object') continue;
    const fact = entry as Record<string, unknown>;
    if (typeof fact.text !== 'string') continue;
    const category = typeof fact.category === 'string' && (MEMORY_CATEGORIES as readonly string[]).includes(fact.category)
      ? (fact.category as MemoryCategory)
      : 'other';
    const replaces = typeof fact.replaces === 'string' && knownIds.has(fact.replaces) ? fact.replaces : undefined;
    out.push({ text: fact.text, category, replaces });
  }
  return out;
}

/** Runs extraction for one exchange and stores what passes the filters. */
export async function extractMemories(input: ExtractionInput): Promise<MemoryRecord[]> {
  if (input.settings.memoryEnabled === false) return [];
  if (!mightContainFacts(input.userText)) return [];
  const known = await knownFacts(input.userText);
  let candidates: CandidateFact[];
  if (input.settings.provider === 'tva-offline') {
    candidates = patternFacts(input.userText, known);
  } else {
    try {
      candidates = await modelFacts(input, known);
    } catch {
      // No model available right now: phrasing patterns still catch the clear cases.
      candidates = patternFacts(input.userText, known);
    }
  }
  const saved: MemoryRecord[] = [];
  for (const candidate of candidates.slice(0, MAX_FACTS_PER_TURN)) {
    const text = cleanFact(candidate.text);
    if (text.length < 4 || text.length > 200 || !safeToAutoRemember(text)) continue;
    try {
      const { record } = await upsertMemory(text, candidate.category, 'chat', { chatId: input.chatId, replaces: candidate.replaces });
      saved.push(record);
    } catch {
      // Storage unavailable: skip silently, the conversation itself is unaffected.
    }
  }
  return saved;
}

let queue: Promise<unknown> = Promise.resolve();

/** Queues extraction in the background; jobs run one at a time so updates don't race. */
export function scheduleMemoryExtraction(input: ExtractionInput): void {
  if (input.settings.memoryEnabled === false) return;
  queue = queue.then(() => extractMemories(input)).catch(() => undefined);
}

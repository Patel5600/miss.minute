/**
 * Long-term memory store: durable facts about the owner, deduplicated, searchable.
 * Shared by automatic extraction (brain) and the remember/recall/forget tools.
 */
import { deleteRecord, listAll, newId, putRecord, type MemoryCategory, type MemoryRecord } from '../../store/db';

export const MEMORY_CATEGORIES: readonly MemoryCategory[] = [
  'identity', 'preference', 'person', 'place', 'project', 'routine', 'other',
];

const MAX_MEMORIES = 400;
const MAX_FACT_LENGTH = 280;

const STOPWORDS = new Set(
  ('a an and are as at be been but by do does for from has have he her his i in is it its me my of on or our '
    + 'she so that the their them they this to was we were what when where which who will with you your user owner')
    .split(' '),
);

function tokens(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s'-]/g, ' ')
      .split(/\s+/)
      .map(word => word.replace(/^'+|'+$/g, ''))
      .filter(word => word.length > 1 && !STOPWORDS.has(word)),
  );
}

function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  a.forEach(word => { if (b.has(word)) shared += 1; });
  return shared / (a.size + b.size - shared);
}

export function cleanFact(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_FACT_LENGTH);
}

export async function listMemories(): Promise<MemoryRecord[]> {
  const all = await listAll('memories');
  return all.sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false) || b.updatedAt - a.updatedAt);
}

/**
 * Saves a fact. A near-duplicate (same subject, reworded or updated) replaces the old
 * record instead of piling up, so "Lives in Pune" followed by "Moved to Mumbai" can be
 * handled by the caller passing `replaces`.
 */
export async function upsertMemory(
  text: string,
  category: MemoryCategory = 'other',
  source: MemoryRecord['source'] = 'chat',
  options: { chatId?: string; replaces?: string } = {},
): Promise<{ record: MemoryRecord; created: boolean }> {
  const fact = cleanFact(text);
  if (!fact) throw new Error('A memory needs some text.');
  const now = Date.now();
  const all = await listAll('memories');

  const target = options.replaces
    ? all.find(memory => memory.id === options.replaces)
    : (() => {
        const wanted = tokens(fact);
        let best: MemoryRecord | undefined;
        let bestScore = 0;
        for (const memory of all) {
          const score = similarity(wanted, tokens(memory.text));
          if (score > bestScore) { best = memory; bestScore = score; }
        }
        return bestScore >= 0.72 ? best : undefined;
      })();

  if (target) {
    const record: MemoryRecord = { ...target, text: fact, category, updatedAt: now };
    await putRecord('memories', record);
    return { record, created: false };
  }

  if (all.length >= MAX_MEMORIES) {
    const oldest = all.filter(memory => !memory.pinned).sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (oldest) await deleteRecord('memories', oldest.id);
  }
  const record: MemoryRecord = {
    id: newId(), text: fact, category, source, createdAt: now, updatedAt: now, chatId: options.chatId,
  };
  await putRecord('memories', record);
  return { record, created: true };
}

/** Lexical relevance plus a small boost for pinned and recent facts. */
export async function searchMemories(query: string, limit = 8): Promise<MemoryRecord[]> {
  const all = await listAll('memories');
  const wanted = tokens(query);
  const now = Date.now();
  return all
    .map(memory => {
      const overlap = similarity(wanted, tokens(memory.text));
      const ageDays = (now - memory.updatedAt) / 86_400_000;
      const score = overlap * 3 + (memory.pinned ? 1 : 0) + Math.max(0, 0.5 - ageDays / 120);
      return { memory, score, overlap };
    })
    .filter(entry => wanted.size === 0 || entry.overlap > 0 || entry.memory.pinned)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(entry => entry.memory);
}

export async function deleteMemory(id: string): Promise<void> {
  await deleteRecord('memories', id);
}

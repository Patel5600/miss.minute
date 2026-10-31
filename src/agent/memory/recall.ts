/**
 * What Miss Minutes knows about the owner, chosen per turn: facts relevant to the message,
 * plus pinned and identity facts that always matter (name, how to address them).
 */
import type { MemoryRecord } from '../../store/db';
import { listMemories, searchMemories } from './store';

const MAX_RELEVANT = 8;
const MAX_ALWAYS = 8;
const MAX_TOTAL = 16;

export async function memoriesForTurn(userText: string): Promise<MemoryRecord[]> {
  const [all, relevant] = await Promise.all([listMemories(), searchMemories(userText, MAX_RELEVANT)]);
  const always = all.filter(memory => memory.pinned || memory.category === 'identity').slice(0, MAX_ALWAYS);
  const picked = new Map<string, MemoryRecord>();
  for (const memory of [...always, ...relevant]) {
    if (!picked.has(memory.id)) picked.set(memory.id, memory);
    if (picked.size >= MAX_TOTAL) break;
  }
  return [...picked.values()];
}

export function formatMemories(memories: MemoryRecord[]): string {
  return memories
    .map(memory => `- ${memory.text} (${memory.category}${memory.pinned ? ', pinned' : ''}; id ${memory.id})`)
    .join('\n');
}

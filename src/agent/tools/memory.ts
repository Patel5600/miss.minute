/**
 * Long-term memory tools on top of the shared memory store: remember, recall, forget.
 * The Dossier panel reads and edits the same records.
 */
import { clearStore, getRecord, putRecord, type MemoryCategory, type MemoryRecord } from '../../store/db';
import { MEMORY_CATEGORIES, cleanFact, deleteMemory, searchMemories, upsertMemory } from '../memory/store';
import { ToolInputError, clip, optionalEnum, requiredText } from './args';
import { makeTool } from './define';
import { findRecord } from './lookup';
import { formatDay, localDate } from './time';

function memoryView(memory: MemoryRecord) {
  return {
    id: memory.id,
    fact: clip(memory.text, 280),
    category: memory.category,
    learned: localDate(memory.createdAt),
    ...(memory.updatedAt - memory.createdAt > 60_000 ? { updated: localDate(memory.updatedAt) } : {}),
    ...(memory.pinned ? { pinned: true } : {}),
  };
}

// ── Domain functions for the Dossier panel ────────────────────────────────────────────────

export async function addMemoryManually(text: string, category: MemoryCategory): Promise<{ record: MemoryRecord; created: boolean }> {
  if (!cleanFact(text)) throw new ToolInputError('Write the fact first.');
  return upsertMemory(text, category, 'manual');
}

/** Rewrites a fact in place (same id and "learned" date). */
export async function editMemory(id: string, text: string, category: MemoryCategory): Promise<MemoryRecord> {
  if (!cleanFact(text)) throw new ToolInputError('A fact cannot be empty. Delete it instead.');
  if (!(await getRecord('memories', id))) throw new ToolInputError('That fact no longer exists.');
  const { record } = await upsertMemory(text, category, 'manual', { replaces: id });
  return record;
}

export async function setMemoryPinned(id: string, pinned: boolean): Promise<MemoryRecord> {
  const memory = await getRecord('memories', id);
  if (!memory) throw new ToolInputError('That fact no longer exists.');
  return putRecord('memories', { ...memory, pinned: pinned || undefined });
}

export async function forgetAllMemories(): Promise<void> {
  await clearStore('memories');
}

function findMemory(id: string): Promise<MemoryRecord> {
  return findRecord('memories', id, { noun: 'memory', listTool: 'recall', nameOf: memory => memory.text });
}

export const memoryTools = [
  makeTool<{ fact: string; category: MemoryCategory }>({
    name: 'remember',
    description:
      'Saves one durable fact about the owner to long-term memory (kept on this device), e.g. their name, where '
      + 'they live, preferences, people in their life, projects and routines. Use it when the owner asks you to '
      + 'remember something or states a lasting fact; not for passing remarks or one-off tasks (use add_todo or '
      + 'add_reminder). Write the fact in plain third-person words ("Prefers tea over coffee"). A reworded or updated '
      + 'version of an existing fact replaces it.',
    parameters: {
      type: 'object',
      properties: {
        fact: { type: 'string', description: 'One fact, under 280 characters.' },
        category: { type: 'string', enum: [...MEMORY_CATEGORIES], description: 'Default other.' },
      },
      required: ['fact'],
    },
    policy: 'auto',
    failure: "Couldn't save that memory",
    parse(args) {
      return { fact: requiredText(args, 'fact', 280), category: optionalEnum(args, 'category', MEMORY_CATEGORIES) ?? 'other' };
    },
    describe(args) {
      return `Remember (${args.category}): ${args.fact}`;
    },
    async run(args, ctx) {
      if (ctx.settings?.memoryEnabled === false) {
        throw new ToolInputError('Long-term memory is turned off in Settings, so nothing was saved. Tell the owner they can turn it on.');
      }
      const { record, created } = await upsertMemory(args.fact, args.category, 'tool', { chatId: ctx.chatId });
      return {
        ok: true,
        summary: created ? `Remembered: ${record.text}` : `Updated memory: ${record.text}`,
        data: { ...memoryView(record), created },
      };
    },
  }),

  makeTool<{ query: string }>({
    name: 'recall',
    description:
      'Searches long-term memory for facts about the owner. Returns the best matches with ids and when each was '
      + 'learned. Pass a broad query like "family" or "work"; "*" lists pinned and recent facts.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What to look for.' } },
      required: ['query'],
    },
    policy: 'auto',
    failure: "Couldn't search memory",
    parse(args) {
      return { query: requiredText(args, 'query', 200) };
    },
    describe(args) {
      return `Recall memories about "${args.query}"`;
    },
    async run(args) {
      const query = args.query === '*' ? '' : args.query;
      const memories = await searchMemories(query, 10);
      return {
        ok: true,
        summary: memories.length === 0 ? `Nothing remembered about "${args.query}"` : `Recalled ${memories.length} fact${memories.length === 1 ? '' : 's'} about "${args.query}"`,
        data: { memories: memories.map(memoryView) },
      };
    },
  }),

  makeTool<{ id: string }>({
    name: 'forget',
    description: 'Deletes one fact from long-term memory by id (from recall). Asks the owner first.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Memory id from recall.' } },
      required: ['id'],
    },
    policy: 'confirm',
    failure: "Couldn't forget that",
    parse(args) {
      return { id: requiredText(args, 'id', 300) };
    },
    describe(args) {
      return `Forget memory ${args.id}`;
    },
    async prepare(args) {
      const memory = await findMemory(args.id);
      return {
        text: `Forget this ${memory.category} fact: "${memory.text}" (learned ${formatDay(memory.createdAt)}).`,
        risk: 'low',
        token: memory.id,
      };
    },
    async run(args, _ctx, prepared) {
      const id = prepared?.token ?? (await findMemory(args.id)).id;
      const memory = await getRecord('memories', id);
      if (!memory) return { ok: true, summary: 'That memory was already gone', data: { id, deleted: false } };
      await deleteMemory(id);
      return { ok: true, summary: `Forgot: ${memory.text}`, data: { id, deleted: true } };
    },
  }),
];

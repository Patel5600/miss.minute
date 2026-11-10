/**
 * Local-first persistence (IndexedDB). Everything Miss Minutes remembers lives here:
 * chats, long-term memories, the owner's schedule, to-dos, timers and notes.
 *
 * Nothing in this file talks to the network. Changes are broadcast to every window of the
 * same origin (dashboard + desktop overlay) so panels refresh without polling.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { ChatMessage } from '../types';

// ── Records ──────────────────────────────────────────────────────────────────

export interface ChatRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
}

export interface StoredMessage extends ChatMessage {
  chatId: string;
  createdAt: number;
}

export type MemoryCategory = 'identity' | 'preference' | 'person' | 'place' | 'project' | 'routine' | 'other';

export interface MemoryRecord {
  id: string;
  /** One durable fact in plain words, e.g. "Prefers to be called Irshad." */
  text: string;
  category: MemoryCategory;
  source: 'chat' | 'manual' | 'tool';
  createdAt: number;
  updatedAt: number;
  chatId?: string;
  pinned?: boolean;
}

export type ScheduleKind = 'event' | 'reminder' | 'alarm';
export type Recurrence = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly';

export interface ScheduleItem {
  id: string;
  kind: ScheduleKind;
  title: string;
  notes?: string;
  /** Unix ms. For reminders and alarms this is when it fires. */
  startAt: number;
  /** Events only. */
  endAt?: number;
  allDay?: boolean;
  location?: string;
  recurrence: Recurrence;
  done: boolean;
  /** Set when a reminder/alarm fired for its current occurrence. */
  lastFiredAt?: number;
  snoozedUntil?: number;
  createdAt: number;
  updatedAt: number;
  source: 'chat' | 'manual';
}

export interface TodoRecord {
  id: string;
  text: string;
  done: boolean;
  priority: 'low' | 'normal' | 'high';
  dueAt?: number;
  createdAt: number;
  completedAt?: number;
}

export type TimerState = 'running' | 'paused' | 'done' | 'cancelled';

export interface TimerRecord {
  id: string;
  label: string;
  durationMs: number;
  startedAt: number;
  /** When a running timer finishes. Meaningless while paused. */
  endsAt: number;
  /** Set while paused. */
  remainingMs?: number;
  state: TimerState;
  createdAt: number;
  firedAt?: number;
}

export interface NoteRecord {
  id: string;
  title: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

export interface ActivityRecord {
  id: string;
  at: number;
  kind: 'tool' | 'alarm' | 'approval' | 'error';
  summary: string;
  detail?: unknown;
}

export interface KvRecord {
  key: string;
  value: unknown;
}

interface MissMinutesDB extends DBSchema {
  chats: { key: string; value: ChatRecord; indexes: { byUpdated: number } };
  messages: { key: string; value: StoredMessage; indexes: { byChat: [string, number] } };
  memories: { key: string; value: MemoryRecord; indexes: { byUpdated: number } };
  schedule: { key: string; value: ScheduleItem; indexes: { byStart: number } };
  todos: { key: string; value: TodoRecord; indexes: { byCreated: number } };
  timers: { key: string; value: TimerRecord; indexes: { byCreated: number } };
  notes: { key: string; value: NoteRecord; indexes: { byUpdated: number } };
  activity: { key: string; value: ActivityRecord; indexes: { byAt: number } };
  kv: { key: string; value: KvRecord };
}

export interface RecordMap {
  chats: ChatRecord;
  messages: StoredMessage;
  memories: MemoryRecord;
  schedule: ScheduleItem;
  todos: TodoRecord;
  timers: TimerRecord;
  notes: NoteRecord;
  activity: ActivityRecord;
}

export type StoreName = keyof RecordMap;
export type AnyStoreName = StoreName | 'kv';

const DB_NAME = 'miss-minutes';
const DB_VERSION = 1;
const MAX_ACTIVITY = 500;

let dbPromise: Promise<IDBPDatabase<MissMinutesDB>> | null = null;

function database(): Promise<IDBPDatabase<MissMinutesDB>> {
  if (!dbPromise) {
    dbPromise = openDB<MissMinutesDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        db.createObjectStore('chats', { keyPath: 'id' }).createIndex('byUpdated', 'updatedAt');
        db.createObjectStore('messages', { keyPath: 'id' }).createIndex('byChat', ['chatId', 'createdAt']);
        db.createObjectStore('memories', { keyPath: 'id' }).createIndex('byUpdated', 'updatedAt');
        db.createObjectStore('schedule', { keyPath: 'id' }).createIndex('byStart', 'startAt');
        db.createObjectStore('todos', { keyPath: 'id' }).createIndex('byCreated', 'createdAt');
        db.createObjectStore('timers', { keyPath: 'id' }).createIndex('byCreated', 'createdAt');
        db.createObjectStore('notes', { keyPath: 'id' }).createIndex('byUpdated', 'updatedAt');
        db.createObjectStore('activity', { keyPath: 'id' }).createIndex('byAt', 'at');
        db.createObjectStore('kv', { keyPath: 'key' });
      },
      blocked() {
        console.warn('[db] An older Miss Minutes tab is blocking a database upgrade. Close other tabs.');
      },
    });
  }
  return dbPromise;
}

// ── Change notifications (this window + every other window of the same origin) ──────────

type ChangeHandler = (store: AnyStoreName) => void;
const handlers = new Set<{ store: AnyStoreName | '*'; fn: ChangeHandler }>();
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('miss-minutes-db') : null;

function dispatch(store: AnyStoreName) {
  handlers.forEach(handler => {
    if (handler.store === '*' || handler.store === store) handler.fn(store);
  });
}

channel?.addEventListener('message', event => {
  const store = (event.data as { store?: AnyStoreName } | null)?.store;
  if (store) dispatch(store);
});

function changed(store: AnyStoreName) {
  dispatch(store);
  channel?.postMessage({ store });
}

/** Subscribe to changes in one store (or '*' for all). Returns an unsubscribe function. */
export function onDbChange(store: AnyStoreName | '*', fn: ChangeHandler): () => void {
  const entry = { store, fn };
  handlers.add(entry);
  return () => { handlers.delete(entry); };
}

export function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ── Generic CRUD ──────────────────────────────────────────────────────────────

export async function listAll<K extends StoreName>(store: K): Promise<RecordMap[K][]> {
  return (await database()).getAll(store) as Promise<RecordMap[K][]>;
}

export async function getRecord<K extends StoreName>(store: K, id: string): Promise<RecordMap[K] | undefined> {
  return (await database()).get(store, id) as Promise<RecordMap[K] | undefined>;
}

export async function putRecord<K extends StoreName>(store: K, value: RecordMap[K]): Promise<RecordMap[K]> {
  await (await database()).put(store, value as never);
  changed(store);
  return value;
}

export async function putRecords<K extends StoreName>(store: K, values: RecordMap[K][]): Promise<void> {
  if (values.length === 0) return;
  const tx = (await database()).transaction(store, 'readwrite');
  await Promise.all([...values.map(value => tx.store.put(value as never)), tx.done]);
  changed(store);
}

export async function deleteRecord(store: StoreName, id: string): Promise<void> {
  await (await database()).delete(store, id);
  changed(store);
}

export async function clearStore(store: StoreName): Promise<void> {
  await (await database()).clear(store);
  changed(store);
}

// ── Chats ─────────────────────────────────────────────────────────────────────

export async function listChats(): Promise<ChatRecord[]> {
  const chats = await listAll('chats');
  return chats.sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false) || b.updatedAt - a.updatedAt);
}

export async function createChat(title = 'New conversation'): Promise<ChatRecord> {
  const now = Date.now();
  return putRecord('chats', { id: newId(), title, createdAt: now, updatedAt: now });
}

export async function messagesForChat(chatId: string): Promise<StoredMessage[]> {
  const db = await database();
  const range = IDBKeyRange.bound([chatId, 0], [chatId, Number.MAX_SAFE_INTEGER]);
  return db.getAllFromIndex('messages', 'byChat', range);
}

/** Inserts or replaces a message and bumps the chat's updatedAt. */
export async function saveMessage(message: StoredMessage): Promise<void> {
  const db = await database();
  const tx = db.transaction(['messages', 'chats'], 'readwrite');
  await tx.objectStore('messages').put(message);
  const chat = await tx.objectStore('chats').get(message.chatId);
  if (chat) await tx.objectStore('chats').put({ ...chat, updatedAt: Math.max(chat.updatedAt, message.createdAt) });
  await tx.done;
  changed('messages');
  changed('chats');
}

export async function deleteChat(chatId: string): Promise<void> {
  const db = await database();
  const tx = db.transaction(['messages', 'chats'], 'readwrite');
  const range = IDBKeyRange.bound([chatId, 0], [chatId, Number.MAX_SAFE_INTEGER]);
  let cursor = await tx.objectStore('messages').index('byChat').openCursor(range);
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.objectStore('chats').delete(chatId);
  await tx.done;
  changed('messages');
  changed('chats');
}

// ── Schedule ──────────────────────────────────────────────────────────────────

/** Items whose start falls in [from, to). Recurring items are returned once; expand with `occurrences`. */
export async function scheduleBetween(from: number, to: number): Promise<ScheduleItem[]> {
  const db = await database();
  return db.getAllFromIndex('schedule', 'byStart', IDBKeyRange.bound(from, to, false, true));
}

/**
 * Expands an item into concrete occurrences overlapping [from, to).
 * Non-recurring items yield at most one occurrence.
 */
export function occurrences(item: ScheduleItem, from: number, to: number, limit = 400): Array<{ startAt: number; endAt: number }> {
  const length = Math.max(0, (item.endAt ?? item.startAt) - item.startAt);
  const out: Array<{ startAt: number; endAt: number }> = [];
  const push = (start: number) => {
    if (start < to && start + length >= from) out.push({ startAt: start, endAt: start + length });
  };
  if (item.recurrence === 'none') {
    push(item.startAt);
    return out;
  }
  const cursor = new Date(item.startAt);
  for (let i = 0; i < limit && cursor.getTime() < to; i += 1) {
    const day = cursor.getDay();
    if (item.recurrence !== 'weekdays' || (day !== 0 && day !== 6)) push(cursor.getTime());
    if (item.recurrence === 'monthly') cursor.setMonth(cursor.getMonth() + 1);
    else cursor.setDate(cursor.getDate() + (item.recurrence === 'weekly' ? 7 : 1));
  }
  return out;
}

// ── Activity log ──────────────────────────────────────────────────────────────

export async function logActivity(kind: ActivityRecord['kind'], summary: string, detail?: unknown): Promise<void> {
  const db = await database();
  await db.put('activity', { id: newId(), at: Date.now(), kind, summary, detail });
  const count = await db.count('activity');
  if (count > MAX_ACTIVITY) {
    const tx = db.transaction('activity', 'readwrite');
    let cursor = await tx.store.index('byAt').openCursor();
    let excess = count - MAX_ACTIVITY;
    while (cursor && excess > 0) {
      await cursor.delete();
      excess -= 1;
      cursor = await cursor.continue();
    }
    await tx.done;
  }
  changed('activity');
}

export async function recentActivity(limit = 50): Promise<ActivityRecord[]> {
  const all = await listAll('activity');
  return all.sort((a, b) => b.at - a.at).slice(0, limit);
}

// ── Key/value ─────────────────────────────────────────────────────────────────

export async function kvGet<T>(key: string): Promise<T | undefined> {
  const record = await (await database()).get('kv', key);
  return record?.value as T | undefined;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await (await database()).put('kv', { key, value });
  changed('kv');
}

/** Deletes everything Miss Minutes stored in this browser profile. */
export async function wipeAll(): Promise<void> {
  const db = await database();
  const stores: AnyStoreName[] = ['chats', 'messages', 'memories', 'schedule', 'todos', 'timers', 'notes', 'activity', 'kv'];
  const tx = db.transaction(stores, 'readwrite');
  await Promise.all([...stores.map(store => tx.objectStore(store).clear()), tx.done]);
  stores.forEach(changed);
}

/**
 * Local-first persistence:
 * - On Android and Desktop, routes owner records to the native encrypted SQLCipher store (`owner.store` / `owner_data`).
 * - In plain browser mode, falls back to local IndexedDB.
 *
 * Nothing in this file talks to the network. Changes are broadcast to every window of the
 * same origin (dashboard + desktop overlay) so panels refresh without polling.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { ChatMessage } from '../types';
import { invokeNative, isDesktopRuntime } from '../desktop/bridge.ts';
import { androidRequest, isAndroidApp, isAndroidMigrationRenderer, mayOpenLegacyOwnerDatabase } from '../agent/platform.ts';
import { splitOwnerMigrationBatches } from './androidMigrationBatches.ts';

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

export interface MissionRecord {
  id: string;
  goal: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  nodes: Array<{
    id: string;
    title: string;
    depends_on: string[];
    action_kind: string;
    side_effect: 'read_only' | 'local_write' | 'external' | 'destructive' | 'financial';
    max_retries: number;
  }>;
  checkpoints?: Array<{
    node_id: string;
    status: string;
    attempts: number;
    evidence?: string | null;
  }>;
  runId?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface OfferRecord {
  id: string;
  query: string;
  sourceDomain: string;
  title: string;
  totalScore: number;
  legitimacyScore: number;
  fitScore: number;
  clarityScore: number;
  rejectedAsScam: boolean;
  scamFlags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface CallRecord {
  id: string;
  callId: string;
  destinationE164: string;
  callerLabel: string;
  voice: string;
  disclosureOpening: string;
  allowedFacts: Array<{ kind: string; value: string }>;
  state: 'draft' | 'validated' | 'disclosed' | 'connected' | 'completed' | 'aborted';
  dryRun?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface DelegationRecord {
  id: string;
  grantId: string;
  delegateName: string;
  allowedScopes: string[];
  maxSpendMinor: 0;
  expiresAtMs: number;
  revoked: boolean;
  createdAt: number;
}

export interface AuditChainRecord {
  id: string;
  sequence: number;
  event: string;
  fromState?: string;
  toState?: string;
  mode?: string;
  detail: string;
  prevHash: string;
  entryHash: string;
  createdAt: number;
}

export interface ConnectorRecord {
  id: string;
  serverName: string;
  name: string;
  description: string;
  trustedBuiltin: boolean;
  derivedSideEffect: 'read_only' | 'local_write' | 'external' | 'destructive' | 'financial';
  ownerApprovedReclassification: boolean;
  rawManifestJson?: string;
  createdAt: number;
  updatedAt: number;
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
  missions: { key: string; value: MissionRecord; indexes: { byUpdated: number } };
  offers: { key: string; value: OfferRecord; indexes: { byUpdated: number } };
  calls: { key: string; value: CallRecord; indexes: { byCreated: number } };
  delegations: { key: string; value: DelegationRecord; indexes: { byCreated: number } };
  audit_chain: { key: string; value: AuditChainRecord; indexes: { bySequence: number } };
  connectors: { key: string; value: ConnectorRecord; indexes: { byUpdated: number } };
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
  missions: MissionRecord;
  offers: OfferRecord;
  calls: CallRecord;
  delegations: DelegationRecord;
  audit_chain: AuditChainRecord;
  connectors: ConnectorRecord;
}

export type StoreName = keyof RecordMap;
export type AnyStoreName = StoreName | 'kv';

export type LegacyOwnerDatabaseState = 'present' | 'missing' | 'unknown';
export interface OwnerMigrationProgress {
  stage: 'checking' | 'copying' | 'securing' | 'complete';
  store?: AnyStoreName;
  copied: number;
}


const DB_NAME = 'miss-minutes';
const DB_VERSION = 2;
const MAX_ACTIVITY = 500;
const MAX_NATIVE_BATCH = 1000;
const ALL_STORES: AnyStoreName[] = [
  'chats',
  'messages',
  'memories',
  'schedule',
  'todos',
  'timers',
  'notes',
  'activity',
  'kv',
  'missions',
  'offers',
  'calls',
  'delegations',
  'audit_chain',
  'connectors',
];

let dbPromise: Promise<IDBPDatabase<MissMinutesDB>> | null = null;
let desktopMigrationInFlight: Promise<void> | null = null;

function isMigrationPage(): boolean {
  return typeof window !== 'undefined' && typeof window.location !== 'undefined'
    && isAndroidMigrationRenderer(window.location);
}

function nativeStoreMode(): 'android' | 'desktop' | 'none' {
  if (isAndroidApp() && !isMigrationPage()) return 'android';
  if (isDesktopRuntime()) return 'desktop';
  return 'none';
}

function isSecretKvKey(key: string): boolean {
  return key === 'vault:web:key' || key.startsWith('vault:web:secret:');
}

async function nativeStoreOp(
  mode: 'android' | 'desktop',
  op: string,
  params: Record<string, unknown> = {},
  timeoutMs?: number,
): Promise<unknown[]> {
  if (mode === 'android') {
    const res = await androidRequest('owner.store', { op, ...params }, timeoutMs);
    return Array.isArray(res?.data) ? res.data : [];
  }
  const res = await invokeNative<{ data?: unknown[] }>('owner_data', { request: { op, ...params } });
  return Array.isArray(res?.data) ? res.data : [];
}

function database(forMigration = false): Promise<IDBPDatabase<MissMinutesDB>> {
  const nativeStore = isAndroidApp() || isDesktopRuntime();
  if (!mayOpenLegacyOwnerDatabase(nativeStore, forMigration || isMigrationPage())) {
    return Promise.reject(new Error('Native encrypted owner storage is active; legacy WebView IndexedDB cannot be opened directly.'));
  }
  if (!dbPromise) {
    dbPromise = openDB<MissMinutesDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('chats')) {
          db.createObjectStore('chats', { keyPath: 'id' }).createIndex('byUpdated', 'updatedAt');
        }
        if (!db.objectStoreNames.contains('messages')) {
          db.createObjectStore('messages', { keyPath: 'id' }).createIndex('byChat', ['chatId', 'createdAt']);
        }
        if (!db.objectStoreNames.contains('memories')) {
          db.createObjectStore('memories', { keyPath: 'id' }).createIndex('byUpdated', 'updatedAt');
        }
        if (!db.objectStoreNames.contains('schedule')) {
          db.createObjectStore('schedule', { keyPath: 'id' }).createIndex('byStart', 'startAt');
        }
        if (!db.objectStoreNames.contains('todos')) {
          db.createObjectStore('todos', { keyPath: 'id' }).createIndex('byCreated', 'createdAt');
        }
        if (!db.objectStoreNames.contains('timers')) {
          db.createObjectStore('timers', { keyPath: 'id' }).createIndex('byCreated', 'createdAt');
        }
        if (!db.objectStoreNames.contains('notes')) {
          db.createObjectStore('notes', { keyPath: 'id' }).createIndex('byUpdated', 'updatedAt');
        }
        if (!db.objectStoreNames.contains('activity')) {
          db.createObjectStore('activity', { keyPath: 'id' }).createIndex('byAt', 'at');
        }
        if (!db.objectStoreNames.contains('kv')) {
          db.createObjectStore('kv', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('missions')) {
          db.createObjectStore('missions', { keyPath: 'id' }).createIndex('byUpdated', 'updatedAt');
        }
        if (!db.objectStoreNames.contains('offers')) {
          db.createObjectStore('offers', { keyPath: 'id' }).createIndex('byUpdated', 'updatedAt');
        }
        if (!db.objectStoreNames.contains('calls')) {
          db.createObjectStore('calls', { keyPath: 'id' }).createIndex('byCreated', 'createdAt');
        }
        if (!db.objectStoreNames.contains('delegations')) {
          db.createObjectStore('delegations', { keyPath: 'id' }).createIndex('byCreated', 'createdAt');
        }
        if (!db.objectStoreNames.contains('audit_chain')) {
          db.createObjectStore('audit_chain', { keyPath: 'id' }).createIndex('bySequence', 'sequence');
        }
        if (!db.objectStoreNames.contains('connectors')) {
          db.createObjectStore('connectors', { keyPath: 'id' }).createIndex('byUpdated', 'updatedAt');
        }
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
const channel: BroadcastChannel | null =
  typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('miss-minutes-db')
    : null;

function dispatch(store: AnyStoreName) {
  handlers.forEach(handler => {
    if (handler.store === '*' || handler.store === store) handler.fn(store);
  });
}

channel?.addEventListener('message', event => {
  const store = (event.data as { store?: AnyStoreName } | null)?.store;
  if (store) dispatch(store);
});
(channel as (BroadcastChannel & { unref?: () => void }) | null)?.unref?.();

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
  const mode = nativeStoreMode();
  if (mode !== 'none') return (await nativeStoreOp(mode, 'list', { store })) as RecordMap[K][];
  return (await database()).getAll(store) as Promise<RecordMap[K][]>;
}

export async function getRecord<K extends StoreName>(store: K, id: string): Promise<RecordMap[K] | undefined> {
  const mode = nativeStoreMode();
  if (mode !== 'none') {
    const rows = await nativeStoreOp(mode, 'get', { store, key: id });
    return rows[0] as RecordMap[K] | undefined;
  }
  return (await database()).get(store, id) as Promise<RecordMap[K] | undefined>;
}

export async function putRecord<K extends StoreName>(store: K, value: RecordMap[K]): Promise<RecordMap[K]> {
  const mode = nativeStoreMode();
  if (mode !== 'none') {
    await nativeStoreOp(mode, 'put', { store, record: value as unknown as Record<string, unknown> });
    changed(store);
    return value;
  }
  await (await database()).put(store, value as never);
  changed(store);
  return value;
}

export async function putRecords<K extends StoreName>(store: K, values: RecordMap[K][]): Promise<void> {
  if (values.length === 0) return;
  const mode = nativeStoreMode();
  if (mode !== 'none') {
    for (let offset = 0; offset < values.length; offset += MAX_NATIVE_BATCH) {
      await nativeStoreOp(mode, 'putMany', {
        store,
        records: values.slice(offset, offset + MAX_NATIVE_BATCH) as unknown as Array<Record<string, unknown>>,
      });
    }
    changed(store);
    return;
  }
  const tx = (await database()).transaction(store, 'readwrite');
  await Promise.all([...values.map(value => tx.store.put(value as never)), tx.done]);
  changed(store);
}

export async function deleteRecord(store: StoreName, id: string): Promise<void> {
  const mode = nativeStoreMode();
  if (mode !== 'none') {
    await nativeStoreOp(mode, 'delete', { store, key: id });
    changed(store);
    return;
  }
  await (await database()).delete(store, id);
  changed(store);
}

export async function clearStore(store: StoreName): Promise<void> {
  const mode = nativeStoreMode();
  if (mode !== 'none') {
    await nativeStoreOp(mode, 'clear', { store });
    changed(store);
    return;
  }
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

export async function renameChat(chatId: string, title: string): Promise<ChatRecord | undefined> {
  const clean = title.trim();
  if (!clean) return undefined;
  const chat = await getRecord('chats', chatId);
  if (!chat) return undefined;
  return putRecord('chats', { ...chat, title: clean.slice(0, 120) });
}

export async function messagesForChat(chatId: string): Promise<StoredMessage[]> {
  const mode = nativeStoreMode();
  if (mode !== 'none') return (await nativeStoreOp(mode, 'messagesForChat', { chatId })) as StoredMessage[];
  const db = await database();
  const range = IDBKeyRange.bound([chatId, 0], [chatId, Number.MAX_SAFE_INTEGER]);
  return db.getAllFromIndex('messages', 'byChat', range);
}

/** Inserts or replaces a message and bumps the chat's updatedAt. */
export async function saveMessage(message: StoredMessage): Promise<void> {
  const mode = nativeStoreMode();
  if (mode !== 'none') {
    await nativeStoreOp(mode, 'saveMessage', { record: message as unknown as Record<string, unknown> });
    changed('messages');
    changed('chats');
    return;
  }
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
  const mode = nativeStoreMode();
  if (mode !== 'none') {
    await nativeStoreOp(mode, 'deleteChat', { chatId });
    changed('messages');
    changed('chats');
    return;
  }
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
  const mode = nativeStoreMode();
  if (mode !== 'none') return (await nativeStoreOp(mode, 'scheduleBetween', { from, to })) as ScheduleItem[];
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
  const entry: ActivityRecord = {
    id: newId(),
    at: Date.now(),
    kind,
    summary,
    ...(detail !== undefined ? { detail } : {}),
  };
  const mode = nativeStoreMode();
  if (mode !== 'none') {
    await nativeStoreOp(mode, 'logActivity', { record: entry as unknown as Record<string, unknown> });
    changed('activity');
    return;
  }
  const db = await database();
  await db.put('activity', entry);
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

/** Inspect the legacy WebView database without opening (and accidentally creating) it. */
export async function inspectLegacyOwnerDatabase(): Promise<LegacyOwnerDatabaseState> {
  if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') return 'unknown';
  try {
    const databases = await indexedDB.databases();
    return databases.some(info => info.name === DB_NAME) ? 'present' : 'missing';
  } catch {
    return 'unknown';
  }
}

/** Copy old IndexedDB records into the migration-only encrypted Android store. This renderer
 * role alone may call importBatch/migrationComplete. The legacy database stays intact so an
 * interrupted import never loses the user's only copy. */
export async function ensureAndroidOwnerDataReady(
  report: (progress: OwnerMigrationProgress) => void | Promise<void>,
): Promise<void> {
  const state = await inspectLegacyOwnerDatabase();
  if (state === 'unknown') throw new Error('This WebView cannot safely inspect the old saved-data database.');
  await report({ stage: 'checking', copied: 0 });
  const stores = ALL_STORES;
  let total = 0;
  const sendBatch = async (store: AnyStoreName, batch: Array<Record<string, unknown>>) => {
    await androidRequest('owner.store', { op: 'importBatch', store, records: batch }, 60_000);
    total += batch.length;
    await report({ stage: 'copying', store, copied: total });
  };
  if (state === 'present') {
    const legacy = await database(true);
    try {
      for (const store of stores) {
        if (!legacy.objectStoreNames.contains(store)) continue;
        const records = await legacy.getAll(store) as unknown as Array<Record<string, unknown>>;
        for (const batch of splitOwnerMigrationBatches(store, records)) await sendBatch(store, batch);
      }
    } finally {
      legacy.close();
      dbPromise = null;
    }
  }
  await report({ stage: 'securing', copied: total });
  await androidRequest('owner.store', { op: 'migrationComplete' }, 30_000);
  await report({ stage: 'complete', copied: total });
}

/** Migrate legacy WebView IndexedDB records into the desktop SQLCipher store on first owner unlock. */
export async function ensureDesktopOwnerDataReady(): Promise<void> {
  if (!isDesktopRuntime()) return;
  if (desktopMigrationInFlight) return desktopMigrationInFlight;
  desktopMigrationInFlight = (async () => {
    const status = await nativeStoreOp('desktop', 'migrationStatus');
    const first = status[0] as { done?: unknown } | undefined;
    if (first?.done === true) return;

    const state = await inspectLegacyOwnerDatabase();
    if (state === 'present') {
      const legacy = await database(true);
      const stores = ALL_STORES;
      try {
        for (const store of stores) {
          if (!legacy.objectStoreNames.contains(store)) continue;
          const records = await legacy.getAll(store) as unknown as Array<Record<string, unknown>>;
          for (let offset = 0; offset < records.length; offset += 200) {
            const batch = records.slice(offset, offset + 200);
            if (batch.length > 0) {
              await nativeStoreOp('desktop', 'importBatch', { store, records: batch });
            }
          }
        }
      } finally {
        legacy.close();
        dbPromise = null;
      }
    }

    await nativeStoreOp('desktop', 'migrationComplete');

    if (state === 'present' && typeof indexedDB !== 'undefined' && typeof indexedDB.deleteDatabase === 'function') {
      await new Promise<void>(resolve => {
        try {
          const req = indexedDB.deleteDatabase(DB_NAME);
          const timer = setTimeout(resolve, 2000);
          const finish = () => { clearTimeout(timer); resolve(); };
          req.onsuccess = finish;
          req.onerror = finish;
          req.onblocked = finish;
        } catch {
          resolve();
        }
      });
    }
  })().finally(() => {
    desktopMigrationInFlight = null;
  });
  return desktopMigrationInFlight;
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  const mode = nativeStoreMode();
  if (mode !== 'none') {
    if (isSecretKvKey(key)) {
      throw new Error('Provider credentials are isolated in native OS storage.');
    }
    const rows = await nativeStoreOp(mode, 'get', { store: 'kv', key });
    const record = rows[0] as KvRecord | undefined;
    return record?.value as T | undefined;
  }
  const record = await (await database()).get('kv', key);
  return record?.value as T | undefined;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  const mode = nativeStoreMode();
  if (mode !== 'none') {
    if (isSecretKvKey(key)) {
      throw new Error('Provider credentials must remain isolated in native OS storage.');
    }
    await nativeStoreOp(mode, 'put', { store: 'kv', record: { key, value } });
    changed('kv');
    return;
  }
  await (await database()).put('kv', { key, value });
  changed('kv');
}

/** Deletes everything Miss Minutes stored in this browser profile or native owner store. */
export async function wipeAll(): Promise<void> {
  const stores = ALL_STORES;
  const mode = nativeStoreMode();
  if (mode !== 'none') {
    await nativeStoreOp(mode, 'wipe');
    stores.forEach(changed);
    return;
  }
  const db = await database();
  const tx = db.transaction(stores, 'readwrite');
  await Promise.all([...stores.map(store => tx.objectStore(store).clear()), tx.done]);
  stores.forEach(changed);
}

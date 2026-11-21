import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearStore,
  deleteChat,
  deleteRecord,
  ensureDesktopOwnerDataReady,
  getRecord,
  kvGet,
  kvSet,
  listAll,
  logActivity,
  messagesForChat,
  putRecord,
  putRecords,
  saveMessage,
  scheduleBetween,
  wipeAll,
} from '../../src/store/db.ts';

interface WindowStub {
  location?: { hostname: string; origin: string; pathname: string };
  __TAURI__?: {
    core?: {
      invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    };
  };
  missNative?: {
    onmessage: ((event: { data: unknown }) => void) | null;
    postMessage: (raw: string) => void;
  };
}

function withWindow(stub: WindowStub, fn: () => Promise<void>): Promise<void> {
  const root = globalThis as unknown as Record<string, unknown>;
  const previous = root.window;
  root.window = stub;
  return fn().finally(() => {
    if (previous === undefined) delete root.window;
    else root.window = previous;
  });
}

test('desktop runtime routes CRUD, kv, and specialized queries through owner_data IPC', async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  await withWindow({
    location: { hostname: 'localhost', origin: 'http://localhost', pathname: '/' },
    __TAURI__: {
      core: {
        invoke: async (command, args) => {
          calls.push({ command, args });
          const req = (args?.request ?? {}) as Record<string, unknown>;
          switch (req.op) {
            case 'list':
              return { data: [{ id: 'n1', title: 'Hi', body: 'World', createdAt: 1, updatedAt: 2 }] };
            case 'get':
              if (req.store === 'kv') return { data: [{ key: 'theme', value: 'amber' }] };
              return { data: [{ id: 'n1', title: 'Hi', body: 'World', createdAt: 1, updatedAt: 2 }] };
            case 'messagesForChat':
              return { data: [{ id: 'm1', chatId: 'c1', sender: 'user', text: 'hello', createdAt: 5, timestamp: '10:00' }] };
            case 'scheduleBetween':
              return { data: [] };
            default:
              return { data: [] };
          }
        },
      },
    },
  }, async () => {
    const notes = await listAll('notes');
    assert.equal(notes.length, 1);
    const got = await getRecord('notes', 'n1');
    assert.equal(got?.id, 'n1');
    await putRecord('notes', { id: 'n2', title: 'A', body: 'B', createdAt: 1, updatedAt: 1 });
    await putRecords('notes', [{ id: 'n3', title: 'C', body: 'D', createdAt: 2, updatedAt: 2 }]);
    await deleteRecord('notes', 'n3');
    await clearStore('todos');
    const msgs = await messagesForChat('c1');
    assert.equal(msgs.length, 1);
    await saveMessage({ id: 'm2', chatId: 'c1', sender: 'user', text: 'hi', createdAt: 6, timestamp: '10:01' });
    await deleteChat('c1');
    await scheduleBetween(0, 1000);
    await logActivity('tool', 'Ran get_time', { city: 'Pune' });
    assert.equal(await kvGet<string>('theme'), 'amber');
    await kvSet('theme', 'dark');
    await wipeAll();

    const ops = calls.map(c => {
      assert.equal(c.command, 'owner_data');
      return ((c.args?.request ?? {}) as Record<string, unknown>).op;
    });
    assert.deepEqual(ops, [
      'list', 'get', 'put', 'putMany', 'delete', 'clear',
      'messagesForChat', 'saveMessage', 'deleteChat', 'scheduleBetween',
      'logActivity', 'get', 'put', 'wipe',
    ]);

    await assert.rejects(() => kvGet('vault:web:key'), /isolated in native OS storage/i);
    await assert.rejects(() => kvGet('vault:web:secret:openai'), /isolated in native OS storage/i);
    await assert.rejects(() => kvSet('vault:web:key', 'bad'), /native OS storage/i);
    await assert.rejects(() => kvSet('vault:web:secret:openai', 'sk-bad'), /native OS storage/i);
  });
});

test('android dashboard runtime routes store ops via owner.store and blocks secret keys', async () => {
  const ops: Array<{ type: string; op?: unknown }> = [];
  const port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage(raw: string) {
      const msg = JSON.parse(raw) as { id: string; type: string; payload: Record<string, unknown> };
      ops.push({ type: msg.type, op: msg.payload?.op });
      queueMicrotask(() => {
        port.onmessage?.({
          data: JSON.stringify({
            v: 1,
            type: 'reply',
            id: msg.id,
            ok: true,
            payload: { data: msg.payload?.op === 'list' ? [{ id: 't1', text: 'Task', done: false, priority: 'normal', createdAt: 1 }] : [] },
          }),
        });
      });
    },
  };
  await withWindow({
    location: {
      hostname: 'dashboard.missminutes.local',
      origin: 'https://dashboard.missminutes.local',
      pathname: '/assets/web/dashboard.html',
    },
    missNative: port,
  }, async () => {
    const todos = await listAll('todos');
    assert.equal(todos.length, 1);
    assert.equal(ops[0].type, 'owner.store');
    assert.equal(ops[0].op, 'list');
    await assert.rejects(() => kvGet('vault:web:secret:gemini'), /isolated in native OS storage/i);
    await assert.rejects(() => kvSet('vault:web:key', 'x'), /native OS storage/i);
  });
});

test('ensureDesktopOwnerDataReady skips import when migrationStatus is already done and completes when no legacy DB exists', async () => {
  const seenOps: string[] = [];
  let done = true;
  await withWindow({
    location: { hostname: 'localhost', origin: 'http://localhost', pathname: '/' },
    __TAURI__: {
      core: {
        invoke: async (_command, args) => {
          const req = (args?.request ?? {}) as Record<string, unknown>;
          seenOps.push(String(req.op));
          if (req.op === 'migrationStatus') return { data: [{ done }] };
          return { data: [] };
        },
      },
    },
  }, async () => {
    await ensureDesktopOwnerDataReady();
    assert.deepEqual(seenOps, ['migrationStatus']);

    seenOps.length = 0;
    done = false;
    await ensureDesktopOwnerDataReady();
    assert.deepEqual(seenOps, ['migrationStatus', 'migrationComplete']);
  });
});

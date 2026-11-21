import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeRequest } from '../../native/mobile/web/src/shared/protocol.ts';
import { MAX_OWNER_MIGRATION_MESSAGE_BYTES, splitOwnerMigrationBatches } from '../../src/store/androidMigrationBatches.ts';

test('legacy migration batches stay below the UTF-8 bridge limit', () => {
  const rows = Array.from({ length: 90 }, (_, index) => ({ id: `r${index}`, value: 'x'.repeat(5_000) }));
  const batches = splitOwnerMigrationBatches('notes', rows);
  assert.ok(batches.length > 1);
  assert.equal(batches.flat().length, rows.length);
  for (const records of batches) {
    const bytes = new TextEncoder().encode(encodeRequest('migration-batch', 'owner.store', {
      op: 'importBatch', store: 'notes', records,
    })).byteLength;
    assert.ok(bytes <= MAX_OWNER_MIGRATION_MESSAGE_BYTES);
  }
});

test('a single legacy record too large for IPC fails clearly without producing a batch', () => {
  assert.throws(
    () => splitOwnerMigrationBatches('messages', [{ id: 'large', text: 'x'.repeat(221 * 1024) }]),
    /too large for the secure migration channel.*old saved data is still intact/i,
  );
});

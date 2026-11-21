import { encodeBridgeRequest } from '../agent/platform.ts';
import type { AnyStoreName } from './db';

export const MAX_OWNER_MIGRATION_MESSAGE_BYTES = 220 * 1024;

/** Split records by the actual UTF-8 bridge envelope size, leaving headroom under the 256 KiB protocol cap. */
export function splitOwnerMigrationBatches(
  store: AnyStoreName,
  records: Array<Record<string, unknown>>,
): Array<Array<Record<string, unknown>>> {
  const batches: Array<Array<Record<string, unknown>>> = [];
  let batch: Array<Record<string, unknown>> = [];
  const encodedSize = (items: Array<Record<string, unknown>>) => new TextEncoder().encode(
    encodeBridgeRequest('migration-batch', 'owner.store', { op: 'importBatch', store, records: items }),
  ).byteLength;

  for (const record of records) {
    const single = [record];
    if (encodedSize(single) > MAX_OWNER_MIGRATION_MESSAGE_BYTES) {
      throw new Error(`A saved ${store} record is too large for the secure migration channel. The old saved data is still intact.`);
    }
    const candidate = [...batch, record];
    if (batch.length > 0 && encodedSize(candidate) > MAX_OWNER_MIGRATION_MESSAGE_BYTES) {
      batches.push(batch);
      batch = single;
    } else {
      batch = candidate;
    }
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

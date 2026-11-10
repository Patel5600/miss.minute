/**
 * Finds a stored record from what the model passed as an id. Models sometimes shorten UUIDs
 * or pass a title instead, so an exact id wins, then a unique id prefix, then a unique
 * case-insensitive name. Ambiguity is an error that lists the candidates.
 */
import { getRecord, listAll, type RecordMap } from '../../store/db';
import { ToolInputError } from './args';

type LookupStore = 'schedule' | 'todos' | 'notes' | 'timers' | 'memories';

export async function findRecord<K extends LookupStore>(
  store: K,
  idOrName: string,
  options: { noun: string; listTool: string; nameOf: (record: RecordMap[K]) => string },
): Promise<RecordMap[K]> {
  const wanted = idOrName.trim();
  if (!wanted) throw new ToolInputError(`'id' is required. Call ${options.listTool} to see ids.`);
  const exact = await getRecord(store, wanted);
  if (exact) return exact;

  const all = await listAll(store);
  const lower = wanted.toLowerCase();
  const describe = (records: RecordMap[K][]) =>
    records.slice(0, 5).map(record => `${(record as { id: string }).id} ("${options.nameOf(record)}")`).join(', ');

  if (wanted.length >= 4) {
    const byPrefix = all.filter(record => (record as { id: string }).id.toLowerCase().startsWith(lower));
    if (byPrefix.length === 1) return byPrefix[0];
    if (byPrefix.length > 1) throw new ToolInputError(`"${wanted}" matches several ${options.noun}s: ${describe(byPrefix)}. Pass the full id.`);
  }
  const byName = all.filter(record => options.nameOf(record).trim().toLowerCase() === lower);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) throw new ToolInputError(`Several ${options.noun}s are called "${wanted}": ${describe(byName)}. Pass the id.`);
  throw new ToolInputError(`No ${options.noun} with id "${wanted}". Call ${options.listTool} to see ids.`);
}

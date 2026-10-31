import { useEffect, useRef, useState } from 'react';
import { listAll, onDbChange, type RecordMap, type StoreName } from './db';

/**
 * Live view of one IndexedDB store. Re-queries whenever the store changes in any window.
 * `select` may filter/sort; keep it pure. It is read through a ref, so inline functions are fine.
 */
export function useDbList<K extends StoreName, R = RecordMap[K][]>(
  store: K,
  select?: (rows: RecordMap[K][]) => R,
): { data: R | undefined; loading: boolean; error: string | null } {
  const [state, setState] = useState<{ data: R | undefined; loading: boolean; error: string | null }>({
    data: undefined,
    loading: true,
    error: null,
  });
  const selectRef = useRef(select);
  useEffect(() => { selectRef.current = select; });

  useEffect(() => {
    let active = true;
    const load = () => {
      void listAll(store)
        .then(rows => {
          if (!active) return;
          const pick = selectRef.current;
          setState({ data: (pick ? pick(rows) : rows) as R, loading: false, error: null });
        })
        .catch((error: unknown) => {
          if (active) setState(previous => ({ ...previous, loading: false, error: String(error) }));
        });
    };
    load();
    const stop = onDbChange(store, load);
    return () => { active = false; stop(); };
  }, [store]);

  return state;
}

/** Re-renders every `intervalMs` with the current time. For countdowns and "now" markers. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

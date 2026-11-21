import { useCallback, useState } from 'react';
import { errorMessage } from '../agent/tools/args';

/**
 * Runs a panel action and keeps its error for display. Validation errors from the domain
 * functions are already written for people, so they are shown as-is.
 */
export function useAction(): {
  run: (action: () => Promise<unknown>, onDone?: () => void) => void;
  error: string | null;
  busy: boolean;
  clear: () => void;
} {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = useCallback((action: () => Promise<unknown>, onDone?: () => void) => {
    setBusy(true);
    setError(null);
    action()
      .then(() => onDone?.())
      .catch((caught: unknown) => setError(errorMessage(caught)))
      .finally(() => setBusy(false));
  }, []);
  const clear = useCallback(() => setError(null), []);
  return { run, error, busy, clear };
}

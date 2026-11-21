/**
 * Small fetch wrapper for the keyless public APIs the tools use (Open-Meteo, Wikipedia,
 * DuckDuckGo): hard timeout, caller cancellation, and errors that say which service failed.
 */

function combinedSignal(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('The request timed out.', 'TimeoutError')), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason ?? new DOMException('The request was cancelled.', 'AbortError'));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

export async function fetchJson<T>(
  url: string,
  options: { service: string; signal?: AbortSignal; timeoutMs?: number; headers?: Record<string, string> },
): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new Error(`This device is offline, so ${options.service} cannot be reached.`);
  }
  const { signal, dispose } = combinedSignal(options.signal, options.timeoutMs ?? 10_000);
  try {
    let response: Response;
    try {
      response = await fetch(url, { signal, headers: { Accept: 'application/json', ...options.headers }, credentials: 'omit' });
    } catch (error) {
      if (signal.aborted) {
        const reason: unknown = signal.reason;
        if (reason instanceof DOMException && reason.name === 'TimeoutError') throw new Error(`${options.service} did not answer in time.`);
        throw new DOMException('The request was cancelled.', 'AbortError');
      }
      throw new Error(`${options.service} could not be reached (${error instanceof Error ? error.message : 'network error'}).`);
    }
    if (!response.ok) {
      let detail = '';
      try {
        const body = (await response.json()) as { reason?: unknown; error?: unknown };
        const reason = typeof body.reason === 'string' ? body.reason : typeof body.error === 'string' ? body.error : '';
        if (reason) detail = `: ${reason}`;
      } catch {
        // Non-JSON error bodies carry nothing useful for the owner.
      }
      throw new Error(`${options.service} answered HTTP ${response.status}${detail}`);
    }
    return (await response.json()) as T;
  } finally {
    dispose();
  }
}

/** Removes markup and decodes the entities Wikipedia and DuckDuckGo put in snippets. */
export function plainText(html: string): string {
  const withoutTags = html.replace(/<[^>]*>/g, '');
  const decoded = withoutTags.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    const lower = code.toLowerCase();
    if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(parseInt(lower.slice(1), 10));
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', hellip: '...' };
    return named[lower] ?? entity;
  });
  return decoded.replace(/\s+/g, ' ').trim();
}

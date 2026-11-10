/**
 * One streaming HTTP API for every provider.
 *
 * Browser: fetch with an AbortSignal; the caller supplies credential headers.
 * Desktop: the Rust host makes the request (`provider_http_stream`), injects the stored key or
 * OAuth token itself and relays the body over a Channel. Credential headers are never sent to
 * the host, so a key cannot leak into the renderer or into logs on that path.
 *
 * Also home to the stream framing parsers (SSE and NDJSON) the providers read with.
 */
import type { ProviderHttpRequest, ProviderStreamEvent } from '../../desktop/bridge';
import { createNativeChannel, invokeNative, isDesktopRuntime } from '../../desktop/bridge';
import { ProviderError, cancelledError, redactSecrets } from './errors';

export type ProviderName = ProviderHttpRequest['provider'];

export interface HttpRequest {
  provider: ProviderName;
  url: string;
  method?: 'GET' | 'POST';
  /** Non-secret headers. */
  headers?: Record<string, string>;
  /** Browser only: credential headers. Dropped on desktop, where the host injects its own. */
  secretHeaders?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /** Fail when no bytes arrive for this long (default 120 s). */
  idleTimeoutMs?: number;
  /** Used in error messages, e.g. "OpenAI". */
  label?: string;
}

export interface HttpStream {
  status: number;
  ok: boolean;
  /** Lower-case header names. */
  headers: Record<string, string>;
  /** Body text chunks in arrival order. Single use. Throws ProviderError on failure or abort. */
  chunks(): AsyncGenerator<string, void, undefined>;
  /** Reads the rest of the body (capped) as text. */
  text(maxChars?: number): Promise<string>;
}

const DEFAULT_IDLE_MS = 120_000;
const END_GRACE_MS = 1_500;

export function openHttpStream(request: HttpRequest): Promise<HttpStream> {
  return isDesktopRuntime() ? openDesktop(request) : openWeb(request);
}

function lowerHeaders(entries: Iterable<[string, string]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of entries) out[key.toLowerCase()] = value;
  return out;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function readAll(stream: AsyncGenerator<string, void, undefined>, maxChars: number): Promise<string> {
  let out = '';
  for await (const chunk of stream) {
    out += chunk;
    if (out.length >= maxChars) break;
  }
  return out.slice(0, maxChars);
}

// ── Browser ────────────────────────────────────────────────────────────────────

async function openWeb(request: HttpRequest): Promise<HttpStream> {
  const label = request.label ?? hostOf(request.url);
  if (request.signal?.aborted) throw cancelledError();
  const controller = new AbortController();
  let timedOut = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const idleMs = request.idleTimeoutMs ?? DEFAULT_IDLE_MS;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, idleMs);
  };
  const onAbort = () => controller.abort();
  request.signal?.addEventListener('abort', onAbort, { once: true });
  const cleanup = () => {
    if (idleTimer) clearTimeout(idleTimer);
    request.signal?.removeEventListener('abort', onAbort);
  };
  const failure = (error: unknown): ProviderError => {
    if (request.signal?.aborted) return cancelledError();
    if (timedOut) return new ProviderError('timeout', `${label} stopped responding.`);
    if (error instanceof ProviderError) return error;
    const reason = error instanceof Error ? error.message : String(error);
    return new ProviderError('network', `Couldn't reach ${hostOf(request.url)} (${redactSecrets(reason)}).`, { detail: reason });
  };

  armIdle();
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: request.method ?? (request.body === undefined ? 'GET' : 'POST'),
      headers: { ...request.headers, ...request.secretHeaders },
      body: request.body,
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch (error) {
    cleanup();
    throw failure(error);
  }

  const body = response.body;
  let consumed = false;
  async function* chunks(): AsyncGenerator<string, void, undefined> {
    if (consumed) throw new ProviderError('protocol', 'The response body was already read.');
    consumed = true;
    if (!body) {
      cleanup();
      return;
    }
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let finished = false;
    try {
      armIdle();
      for (;;) {
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await reader.read();
        } catch (error) {
          throw failure(error);
        }
        if (result.done) break;
        armIdle();
        const text = decoder.decode(result.value, { stream: true });
        if (text) yield text;
      }
      finished = true;
      const tail = decoder.decode();
      if (tail) yield tail;
    } finally {
      cleanup();
      if (!finished) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  return {
    status: response.status,
    ok: response.ok,
    headers: lowerHeaders(response.headers.entries()),
    chunks,
    text: (maxChars = 262_144) => readAll(chunks(), maxChars),
  };
}

// ── Desktop ────────────────────────────────────────────────────────────────────

/** Single-consumer async queue bridging the push-style Channel to a pull-style iterator. */
class ChunkQueue {
  private items: string[] = [];
  private closed = false;
  private failure: unknown = null;
  private wake: (() => void) | null = null;

  push(item: string): void {
    if (this.closed || this.failure) return;
    this.items.push(item);
    this.notify();
  }

  close(): void {
    this.closed = true;
    this.notify();
  }

  fail(error: unknown): void {
    if (this.closed) return;
    this.failure = error;
    this.notify();
  }

  get done(): boolean {
    return this.closed || this.failure !== null;
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  async *iterate(): AsyncGenerator<string, void, undefined> {
    for (;;) {
      if (this.items.length > 0) {
        yield this.items.shift() as string;
        continue;
      }
      if (this.failure) throw this.failure;
      if (this.closed) return;
      await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }
}

function newRequestId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function openDesktop(request: HttpRequest): Promise<HttpStream> {
  const label = request.label ?? hostOf(request.url);
  if (request.signal?.aborted) throw cancelledError();
  const requestId = newRequestId();
  const queue = new ChunkQueue();
  const decoder = new TextDecoder('utf-8');
  let settledHead = false;
  let resolveHead!: (head: { status: number; headers: Record<string, string> }) => void;
  let rejectHead!: (error: unknown) => void;
  const headPromise = new Promise<{ status: number; headers: Record<string, string> }>((resolve, reject) => {
    resolveHead = head => { settledHead = true; resolve(head); };
    rejectHead = error => { settledHead = true; reject(error); };
  });
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;

  const finish = (error?: unknown) => {
    if (finished) return;
    finished = true;
    if (idleTimer) clearTimeout(idleTimer);
    request.signal?.removeEventListener('abort', onAbort);
    if (error) {
      if (!settledHead) rejectHead(error);
      queue.fail(error);
    } else {
      if (!settledHead) rejectHead(new ProviderError('protocol', `${label} closed the connection without answering.`));
      const tail = decoder.decode();
      if (tail) queue.push(tail);
      queue.close();
    }
  };
  const cancelNative = () => {
    void invokeNative<void>('provider_http_cancel', { requestId }).catch(() => undefined);
  };
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      cancelNative();
      finish(new ProviderError('timeout', `${label} stopped responding.`));
    }, request.idleTimeoutMs ?? DEFAULT_IDLE_MS);
  };
  function onAbort() {
    cancelNative();
    finish(cancelledError());
  }
  request.signal?.addEventListener('abort', onAbort, { once: true });

  const onEvent = (message: ProviderStreamEvent) => {
    if (finished) return;
    armIdle();
    switch (message.event) {
      case 'head':
        if (!settledHead) resolveHead({ status: message.status, headers: lowerHeaders(Object.entries(message.headers ?? {})) });
        break;
      case 'data':
        if (message.text) queue.push(message.text);
        break;
      case 'bytes': {
        const text = decoder.decode(decodeBase64(message.base64), { stream: true });
        if (text) queue.push(text);
        break;
      }
      case 'end':
        finish();
        break;
      case 'error':
        finish(new ProviderError('network', `${label}: ${redactSecrets(message.message || 'the desktop host reported an error')}.`, { detail: message.message }));
        break;
    }
  };

  // Credentials are injected by the host; only non-secret headers cross the bridge.
  const nativeRequest: ProviderHttpRequest = {
    provider: request.provider,
    url: request.url,
    method: request.method ?? (request.body === undefined ? 'GET' : 'POST'),
    headers: request.headers,
    body: request.body,
    responseType: 'text',
  };
  armIdle();
  try {
    const channel = createNativeChannel<ProviderStreamEvent>(onEvent);
    void invokeNative<void>('provider_http_stream', { request: nativeRequest, requestId, onEvent: channel }).then(
      // The command resolves after the host sent its final event, but Channel delivery is a
      // separate path; give trailing messages a moment to land before closing the stream.
      () => { setTimeout(() => finish(), END_GRACE_MS); },
      (error: unknown) => {
        const text = error instanceof Error ? error.message : typeof error === 'string' ? error : 'request failed';
        finish(new ProviderError('network', `${label}: ${redactSecrets(text)}`, { detail: text }));
      },
    );
  } catch (error) {
    finish(error);
  }

  const head = await headPromise;
  let consumed = false;
  async function* chunks(): AsyncGenerator<string, void, undefined> {
    if (consumed) throw new ProviderError('protocol', 'The response body was already read.');
    consumed = true;
    try {
      yield* queue.iterate();
    } finally {
      if (!queue.done) {
        cancelNative();
        finish(cancelledError());
      }
    }
  }
  return {
    status: head.status,
    ok: head.status >= 200 && head.status < 300,
    headers: head.headers,
    chunks,
    text: (maxChars = 262_144) => readAll(chunks(), maxChars),
  };
}

// ── Framing: Server-Sent Events ─────────────────────────────────────────────────

export interface SseEvent {
  /** "message" unless the server named it. */
  event: string;
  data: string;
  id?: string;
}

/**
 * Incremental parser for the WHATWG event-stream format: LF, CR and CRLF line endings
 * (including a CRLF split across chunks), comments, multi-line data fields, a leading BOM,
 * and events split at any byte. A final event without its blank line is still delivered.
 */
export class SseParser {
  private buffer = '';
  private data: string[] = [];
  private eventName = '';
  private lastId = '';
  private pendingCR = false;
  private started = false;
  /** Comment lines seen (keep-alives such as ": OPENROUTER PROCESSING"). */
  comments = 0;

  feed(chunk: string): SseEvent[] {
    let text = chunk;
    if (!this.started && text.length > 0) {
      this.started = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    if (this.pendingCR) {
      this.pendingCR = false;
      if (text.startsWith('\n')) text = text.slice(1);
    }
    this.buffer += text;
    const events: SseEvent[] = [];
    const buffer = this.buffer;
    let start = 0;
    for (let i = 0; i < buffer.length; i += 1) {
      const c = buffer.charCodeAt(i);
      if (c !== 10 && c !== 13) continue;
      this.line(buffer.slice(start, i), events);
      if (c === 13) {
        if (i + 1 < buffer.length) {
          if (buffer.charCodeAt(i + 1) === 10) i += 1;
        } else {
          this.pendingCR = true;
        }
      }
      start = i + 1;
    }
    this.buffer = buffer.slice(start);
    return events;
  }

  /** Flushes a trailing line and an event the server did not terminate. */
  end(): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.buffer.length > 0) {
      this.line(this.buffer, events);
      this.buffer = '';
    }
    this.dispatch(events);
    return events;
  }

  private line(line: string, events: SseEvent[]): void {
    if (line.length === 0) {
      this.dispatch(events);
      return;
    }
    if (line.charCodeAt(0) === 58 /* : */) {
      this.comments += 1;
      return;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.charCodeAt(0) === 32) value = value.slice(1);
    switch (field) {
      case 'data':
        this.data.push(value);
        break;
      case 'event':
        this.eventName = value;
        break;
      case 'id':
        if (!value.includes('\u0000')) this.lastId = value;
        break;
      default:
        // "retry" and unknown fields carry nothing the providers rely on.
        break;
    }
  }

  private dispatch(events: SseEvent[]): void {
    if (this.data.length === 0) {
      this.eventName = '';
      return;
    }
    events.push({ event: this.eventName || 'message', data: this.data.join('\n'), ...(this.lastId ? { id: this.lastId } : {}) });
    this.data = [];
    this.eventName = '';
  }
}

// ── Framing: newline-delimited JSON ────────────────────────────────────────────

/** Splits NDJSON (JSON Lines) into complete lines across chunk boundaries. */
export class NdjsonParser {
  private buffer = '';

  feed(chunk: string): string[] {
    this.buffer += chunk;
    const parts = this.buffer.split(/\r?\n/);
    this.buffer = parts.pop() ?? '';
    return parts.map(part => part.trim()).filter(part => part.length > 0);
  }

  end(): string[] {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest ? [rest] : [];
  }
}

/** Parses one NDJSON line; malformed lines are a protocol error. */
export function parseJsonLine(line: string, label: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    throw new ProviderError('protocol', `${label} sent a malformed stream line.`, { detail: line.slice(0, 200) });
  }
}

/**
 * Yields framed messages from a response body: SSE by default, NDJSON when the server says
 * so, and the whole body as one message for plain JSON (servers that ignore `stream`).
 */
export async function* readMessages(stream: HttpStream): AsyncGenerator<SseEvent, void, undefined> {
  const type = stream.headers['content-type'] ?? '';
  if (/ndjson|jsonl|json-seq/i.test(type)) {
    const parser = new NdjsonParser();
    for await (const chunk of stream.chunks()) {
      for (const line of parser.feed(chunk)) yield { event: 'message', data: line };
    }
    for (const line of parser.end()) yield { event: 'message', data: line };
    return;
  }
  if (/application\/json/i.test(type) && !/event-stream/i.test(type)) {
    const body = await stream.text(8_000_000);
    if (body.trim()) yield { event: 'message', data: body };
    return;
  }
  const parser = new SseParser();
  for await (const chunk of stream.chunks()) {
    for (const event of parser.feed(chunk)) yield event;
  }
  for (const event of parser.end()) yield event;
}

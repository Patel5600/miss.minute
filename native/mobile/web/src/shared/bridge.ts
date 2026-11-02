/**
 * Client for the native side. Android injects `window.missNative` through
 * WebViewCompat.addWebMessageListener (object name `missNative`, one allowed origin). When it is
 * missing every request rejects with code `unavailable`; there is no pretend success.
 */
import { decode, encodeRequest, ProtocolError } from './protocol.ts';
import type { ErrorCode, Message, Payload } from './protocol.ts';

interface NativePort {
  postMessage(message: string): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

declare global {
  interface Window {
    missNative?: NativePort;
  }
}

export const REQUEST_TIMEOUT_MS = 15_000;

export class BridgeError extends Error {
  readonly code: ErrorCode | string;
  constructor(code: ErrorCode | string, message: string) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

type Listener = (payload: Payload) => void;
type CommandListener = (type: string, payload: Payload) => void;

interface Pending {
  resolve: (payload: Payload) => void;
  reject: (error: BridgeError) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();
const eventListeners = new Map<string, Set<Listener>>();
const commandListeners = new Set<CommandListener>();
let counter = 0;
let attached: NativePort | null = null;

function nextId(): string {
  counter += 1;
  return `w${counter.toString(36)}-${Date.now().toString(36)}`;
}

function handle(text: string): void {
  let message: Message;
  try {
    message = decode(text);
  } catch (e) {
    if (e instanceof ProtocolError) return;
    throw e;
  }
  if (message.type === 'reply' && message.id) {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message.payload);
    else entry.reject(new BridgeError(message.error?.code ?? 'internal', message.error?.message ?? 'request failed'));
    return;
  }
  if (message.type === 'event' && message.name) {
    eventListeners.get(message.name)?.forEach((fn) => fn(message.payload));
    return;
  }
  commandListeners.forEach((fn) => fn(message.type, message.payload));
}

function attach(): NativePort | null {
  const port = typeof window === 'undefined' ? undefined : window.missNative;
  if (!port) return null;
  if (attached !== port) {
    attached = port;
    port.onmessage = (event) => {
      if (typeof event.data === 'string') handle(event.data);
    };
  }
  return port;
}

export function isConnected(): boolean {
  return attach() !== null;
}

export function request(type: string, payload: Payload = {}): Promise<Payload> {
  const port = attach();
  if (!port) return Promise.reject(new BridgeError('unavailable', 'Not running inside the Miss Minutes app'));
  const id = nextId();
  return new Promise<Payload>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new BridgeError('internal', `No answer to ${type} within ${REQUEST_TIMEOUT_MS / 1000} seconds`));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try {
      port.postMessage(encodeRequest(id, type, payload));
    } catch (e) {
      pending.delete(id);
      clearTimeout(timer);
      reject(new BridgeError('internal', e instanceof Error ? e.message : 'post failed'));
    }
  });
}

/** Native events (`state.changed`, ...). Returns an unsubscribe function. */
export function onEvent(name: string, listener: Listener): () => void {
  attach();
  const existing = eventListeners.get(name);
  const set = existing ?? new Set<Listener>();
  if (!existing) eventListeners.set(name, set);
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

/** Native-to-page commands that are not replies or events (`rig.pose`, `rig.power`, ...). */
export function onCommand(listener: CommandListener): () => void {
  attach();
  commandListeners.add(listener);
  return () => {
    commandListeners.delete(listener);
  };
}

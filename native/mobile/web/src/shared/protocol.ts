/**
 * Wire format shared with the Java side (`core.protocol`). One JSON text per message:
 *   request  {"v":1,"id":"<=64 chars","type":"<lowercase first letter, then letters, digits, dots>","payload":{...}}
 *   reply    {"v":1,"id":"<same>","type":"reply","ok":true,"payload":{...}} or "ok":false,"error":{code,message}
 *   event    {"v":1,"type":"event","name":"...","payload":{...}}
 * The vectors in tests/android/vectors/protocol.json are checked against both implementations.
 */
import { ERROR_CODES, MESSAGE_TYPES } from './vocabulary.ts';
import type { Authority, ErrorCode } from './vocabulary.ts';

export type { Authority, ErrorCode };

export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 256 * 1024;
export const MAX_ID_LENGTH = 64;
/** Equal to "typePattern" in protocol.json and to Protocol.TYPE_PATTERN in Java. camelCase is allowed after the first letter. */
export const TYPE_PATTERN_SOURCE = '^[a-z][a-zA-Z0-9.]{0,47}$';
const TYPE_PATTERN = new RegExp(TYPE_PATTERN_SOURCE);
const MAX_NAME_LENGTH = 64;

export class ProtocolError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

export type Payload = Record<string, unknown>;

export interface Message {
  readonly id: string | null;
  readonly type: string;
  /** Present on events only. */
  readonly name: string | null;
  readonly payload: Payload;
  /** Present on replies only. */
  readonly ok: boolean | null;
  readonly error: { code: string; message: string } | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Looks a type up in the table; `family.*` entries match by prefix. */
export function authorityOf(type: string): Authority | null {
  const exact = MESSAGE_TYPES[type];
  if (exact) return exact;
  for (const key of Object.keys(MESSAGE_TYPES)) {
    if (key.endsWith('.*') && type.startsWith(key.slice(0, -1))) return MESSAGE_TYPES[key] ?? null;
  }
  return null;
}

/** Structural validation only (same first steps as the Java decoder). Throws ProtocolError. */
export function decode(text: string): Message {
  if (byteLength(text) > MAX_MESSAGE_BYTES) throw new ProtocolError('too_large', 'message is larger than 256 KB');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProtocolError('bad_json', 'message is not valid JSON');
  }
  if (!isObject(raw)) throw new ProtocolError('bad_json', 'message is not a JSON object');
  if (raw.v !== PROTOCOL_VERSION) throw new ProtocolError('bad_version', 'unsupported protocol version');
  const type = raw.type;
  if (typeof type !== 'string' || !TYPE_PATTERN.test(type)) throw new ProtocolError('bad_type', 'invalid message type');

  let name: string | null = null;
  let id: string | null = null;
  if (type === 'event') {
    if (typeof raw.name !== 'string' || raw.name.length === 0 || raw.name.length > MAX_NAME_LENGTH) {
      throw new ProtocolError('bad_payload', 'event name is missing or too long');
    }
    name = raw.name;
    if (raw.id !== undefined) {
      if (typeof raw.id !== 'string' || raw.id.length > MAX_ID_LENGTH) throw new ProtocolError('bad_payload', 'invalid id');
      id = raw.id;
    }
  } else {
    if (typeof raw.id !== 'string' || raw.id.length === 0 || raw.id.length > MAX_ID_LENGTH) {
      throw new ProtocolError('bad_payload', 'id is missing, empty or longer than 64 characters');
    }
    id = raw.id;
  }

  let ok: boolean | null = null;
  let error: { code: string; message: string } | null = null;
  if (type === 'reply') {
    if (typeof raw.ok !== 'boolean') throw new ProtocolError('bad_payload', 'reply needs a boolean ok');
    ok = raw.ok;
    if (!ok) {
      const e = raw.error;
      if (!isObject(e) || typeof e.code !== 'string') throw new ProtocolError('bad_payload', 'failed reply needs an error object');
      error = { code: e.code, message: typeof e.message === 'string' ? e.message : '' };
    }
  }

  const payload = raw.payload;
  if (payload === undefined && type === 'reply' && ok === false) {
    return { id, type, name, payload: {}, ok, error };
  }
  if (!isObject(payload)) throw new ProtocolError('bad_payload', 'payload must be an object');
  return { id, type, name, payload, ok, error };
}

/**
 * What the native side does with a page message: structural checks, then the type must be known,
 * and a native-only type is refused. Kept in TypeScript so the shared vectors can prove parity.
 */
export function decodeFromPage(text: string): Message & { authority: Authority; userOnly: boolean } {
  const message = decode(text);
  const authority = authorityOf(message.type);
  if (authority === null) throw new ProtocolError('unknown_type', 'unknown message type');
  if (authority === 'NATIVE_ONLY') throw new ProtocolError('forbidden', 'message type is reserved for native code');
  return { ...message, authority, userOnly: authority === 'USER_ONLY' };
}

export function encodeRequest(id: string, type: string, payload: Payload = {}): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, id, type, payload });
}

export function reply(id: string, payload: Payload = {}): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, id, type: 'reply', ok: true, payload });
}

export function error(id: string, code: ErrorCode, message: string): string {
  if (!ERROR_CODES.includes(code)) throw new ProtocolError('internal', `unknown error code ${code}`);
  return JSON.stringify({ v: PROTOCOL_VERSION, id, type: 'reply', ok: false, error: { code, message } });
}

export function event(name: string, payload: Payload = {}): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, type: 'event', name, payload });
}

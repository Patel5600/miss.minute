/**
 * Browser-mode API keys.
 *
 * By default a key lives only in this tab's memory and is gone on reload. "Remember on this
 * device" stores it encrypted with AES-GCM under a non-extractable WebCrypto key that is kept
 * in IndexedDB: script on this origin can use the key to decrypt, but cannot export it, and the
 * ciphertext alone is useless if the database files are copied off the machine.
 *
 * The desktop app never uses this module: there, keys go to the OS vault (credential_set) and
 * are never read back into the renderer.
 */
import { kvGet, kvSet } from '../store/db';
import { isDesktopRuntime } from '../desktop/bridge';

export type WebSecretId = 'openai' | 'gemini' | 'anthropic' | 'openrouter' | 'ollama' | 'elevenlabs';

export const WEB_SECRET_IDS: readonly WebSecretId[] = ['openai', 'gemini', 'anthropic', 'openrouter', 'ollama', 'elevenlabs'];

interface SealedSecret {
  v: 1;
  iv: Uint8Array;
  data: ArrayBuffer;
  savedAt: number;
}

const KEY_RECORD = 'vault:web:key';
const SECRET_RECORD = (id: WebSecretId) => `vault:web:secret:${id}`;
const MAX_SECRET_LENGTH = 4096;

const memory = new Map<WebSecretId, string>();
const remembered = new Set<WebSecretId>();
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;

function notify(): void {
  listeners.forEach(listener => {
    try {
      listener();
    } catch {
      // A broken listener must not stop the others.
    }
  });
}

function assertWeb(): void {
  if (isDesktopRuntime()) {
    throw new Error('In the desktop app, keys are stored in the Windows Credential Manager, not in the browser.');
  }
}

function isWebSecretId(value: string): value is WebSecretId {
  return (WEB_SECRET_IDS as readonly string[]).includes(value);
}

function hasSpaceOrControl(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 32 || code === 127) return true;
  }
  return false;
}

/** True when this browser can encrypt keys for "remember on this device" (needs a secure context). */
export function canRememberWebSecrets(): boolean {
  return typeof crypto !== 'undefined' && typeof crypto.subtle?.encrypt === 'function' && typeof indexedDB !== 'undefined';
}

async function deviceKey(create: boolean): Promise<CryptoKey | null> {
  const existing = await kvGet<CryptoKey | null>(KEY_RECORD);
  if (existing && typeof existing === 'object' && 'algorithm' in existing) return existing;
  if (!create) return null;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await kvSet(KEY_RECORD, key);
  return key;
}

function additionalData(id: WebSecretId): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`miss-minutes/web-secret/${id}`);
}

async function seal(id: WebSecretId, value: string): Promise<SealedSecret> {
  const key = await deviceKey(true);
  if (!key) throw new Error('Could not create the device key.');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: additionalData(id) }, key, new TextEncoder().encode(value));
  return { v: 1, iv, data, savedAt: Date.now() };
}

async function unseal(id: WebSecretId, sealed: SealedSecret): Promise<string | null> {
  const key = await deviceKey(false);
  if (!key) return null;
  try {
    const iv = new Uint8Array(sealed.iv);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: additionalData(id) }, key, sealed.data);
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

function isSealed(value: unknown): value is SealedSecret {
  return !!value && typeof value === 'object' && (value as SealedSecret).v === 1
    && (value as SealedSecret).iv instanceof Uint8Array && (value as SealedSecret).data instanceof ArrayBuffer;
}

/**
 * Decrypts remembered keys into memory. Safe to call more than once; later calls reuse the
 * first. Records that no longer decrypt (device key wiped) are removed.
 */
export function loadRememberedWebSecrets(): Promise<void> {
  if (isDesktopRuntime() || !canRememberWebSecrets()) return Promise.resolve();
  if (!loading) {
    loading = (async () => {
      for (const id of WEB_SECRET_IDS) {
        try {
          const sealed = await kvGet<unknown>(SECRET_RECORD(id));
          if (!isSealed(sealed)) continue;
          const value = await unseal(id, sealed);
          if (value === null) {
            await kvSet(SECRET_RECORD(id), null);
            continue;
          }
          remembered.add(id);
          if (!memory.has(id)) memory.set(id, value);
        } catch {
          // IndexedDB unavailable (private mode quirks): keys stay session-only.
        }
      }
      notify();
    })();
  }
  return loading;
}

/** The key held for this provider in this tab, or '' when none. */
export function getWebSecret(id: WebSecretId): string {
  return memory.get(id) ?? '';
}

export function hasWebSecret(id: WebSecretId): boolean {
  return (memory.get(id) ?? '').length > 0;
}

export function isWebSecretRemembered(id: WebSecretId): boolean {
  return remembered.has(id);
}

/**
 * Holds a key for this session. `remember: true` also stores it encrypted on this device,
 * `false` deletes any stored copy, and leaving it out keeps the current choice.
 */
export async function setWebSecret(id: WebSecretId, value: string, options: { remember?: boolean } = {}): Promise<void> {
  assertWeb();
  if (!isWebSecretId(id)) throw new Error('Unknown key slot.');
  const secret = value.trim();
  if (!secret) {
    await clearWebSecret(id);
    return;
  }
  if (secret.length > MAX_SECRET_LENGTH || hasSpaceOrControl(secret)) {
    throw new Error('That does not look like an API key (it contains spaces or is far too long).');
  }
  memory.set(id, secret);
  const remember = options.remember ?? remembered.has(id);
  if (remember) {
    if (!canRememberWebSecrets()) throw new Error('This browser cannot encrypt keys here (it needs HTTPS or localhost). The key is kept for this session only.');
    await kvSet(SECRET_RECORD(id), await seal(id, secret));
    remembered.add(id);
  } else if (remembered.has(id)) {
    await kvSet(SECRET_RECORD(id), null);
    remembered.delete(id);
  }
  notify();
}

/** Turns "remember on this device" on or off for a key already held in memory. */
export async function setWebSecretRemembered(id: WebSecretId, remember: boolean): Promise<void> {
  const value = getWebSecret(id);
  if (!value) {
    if (!remember) await clearWebSecret(id);
    return;
  }
  await setWebSecret(id, value, { remember });
}

/** Forgets a key everywhere: memory and the encrypted copy. */
export async function clearWebSecret(id: WebSecretId): Promise<void> {
  memory.delete(id);
  if (remembered.has(id) || canRememberWebSecrets()) {
    try {
      await kvSet(SECRET_RECORD(id), null);
    } catch {
      // Nothing stored, or storage unavailable.
    }
  }
  remembered.delete(id);
  notify();
}

/** Forgets every key, including the device encryption key. */
export async function clearAllWebSecrets(): Promise<void> {
  for (const id of WEB_SECRET_IDS) await clearWebSecret(id);
  try {
    await kvSet(KEY_RECORD, null);
  } catch {
    // Storage unavailable.
  }
  loading = null;
  notify();
}

export function onWebSecretsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

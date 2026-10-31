/**
 * OpenRouter pairing in the browser (OAuth PKCE, S256). The owner signs in on openrouter.ai,
 * which redirects back here with ?code=; the code plus our verifier buys a user-scoped API key
 * that goes to secrets-web. The verifier and state live in sessionStorage only for that round
 * trip and are removed whatever the outcome. The desktop app pairs through the host instead
 * (openrouter_pair_start / openrouter_pair_complete), so the key lands in the OS vault.
 */
import { isDesktopRuntime } from '../../../desktop/bridge';
import { setWebSecret } from '../../secrets-web';

const AUTH_URL = 'https://openrouter.ai/auth';
const KEYS_URL = 'https://openrouter.ai/api/v1/auth/keys';
const SESSION_KEY = 'miss-minutes:openrouter-pkce';
const MAX_AGE_MS = 15 * 60_000;

interface PendingPairing {
  verifier: string;
  state: string;
  callback: string;
  remember: boolean;
  createdAt: number;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken(bytes: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function callbackUrl(): string {
  return `${window.location.origin}${window.location.pathname}`;
}

function assertBrowser(): void {
  if (isDesktopRuntime()) throw new Error('In the desktop app, pair OpenRouter from Settings; the key goes straight to the Windows vault.');
  if (typeof window === 'undefined' || typeof crypto?.subtle?.digest !== 'function') {
    throw new Error('OpenRouter pairing needs a secure page (HTTPS or localhost).');
  }
}

/**
 * Sends the owner to OpenRouter to approve a key for Miss Minutes. The page navigates away;
 * call completeOpenRouterPairingFromUrl() when it loads again.
 */
export async function startOpenRouterPairing(options: { remember?: boolean } = {}): Promise<void> {
  assertBrowser();
  const verifier = randomToken(48);
  const state = randomToken(16);
  const callback = callbackUrl();
  const pending: PendingPairing = { verifier, state, callback, remember: options.remember === true, createdAt: Date.now() };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(pending));
  const url = new URL(AUTH_URL);
  url.searchParams.set('callback_url', callback);
  url.searchParams.set('code_challenge', await codeChallenge(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('key_label', 'Miss Minutes');
  window.location.assign(url.toString());
}

function readPending(): PendingPairing | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as PendingPairing;
    return typeof value.verifier === 'string' && typeof value.state === 'string' ? value : null;
  } catch {
    return null;
  }
}

function scrubUrl(): void {
  const url = new URL(window.location.href);
  for (const key of ['code', 'state', 'error', 'error_description']) url.searchParams.delete(key);
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

/**
 * Finishes a pairing when this page load is OpenRouter's redirect. Resolves true when a key
 * was stored, false when there was nothing to finish. Throws an Error with an owner-facing
 * message when the pairing failed (expired, state mismatch, rejected code).
 */
export async function completeOpenRouterPairingFromUrl(): Promise<boolean> {
  if (typeof window === 'undefined' || isDesktopRuntime()) return false;
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const pending = readPending();
  // A ?code= without our pending pairing belongs to someone else; leave it untouched.
  if (!code || !pending) return false;
  sessionStorage.removeItem(SESSION_KEY);
  scrubUrl();

  if (Date.now() - pending.createdAt > MAX_AGE_MS) throw new Error('That OpenRouter sign-in took too long and expired. Start pairing again.');
  const returnedState = params.get('state');
  if (returnedState !== null && returnedState !== pending.state) {
    throw new Error('OpenRouter sent back a sign-in that does not match this one, so I ignored it. Start pairing again.');
  }
  if (!/^[\w.-]{8,512}$/.test(code)) throw new Error('OpenRouter returned an unexpected code. Start pairing again.');

  let response: Response;
  try {
    response = await fetch(KEYS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: pending.verifier, code_challenge_method: 'S256' }),
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch {
    throw new Error("Couldn't reach OpenRouter to finish pairing. Check your connection and try again.");
  }
  if (!response.ok) {
    if (response.status === 403) throw new Error('OpenRouter rejected the sign-in code (it may have expired). Start pairing again.');
    if (response.status === 400) throw new Error('OpenRouter rejected the pairing request. Start pairing again.');
    throw new Error(`OpenRouter couldn't finish pairing (HTTP ${response.status}).`);
  }
  const body = (await response.json().catch(() => ({}))) as { key?: unknown };
  if (typeof body.key !== 'string' || !body.key.trim()) throw new Error('OpenRouter did not return a key. Start pairing again.');
  await setWebSecret('openrouter', body.key.trim(), { remember: pending.remember });
  return true;
}

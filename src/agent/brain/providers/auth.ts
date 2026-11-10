/**
 * Credentials for provider requests.
 *
 * Desktop: the host injects keys and tokens; here we only ask whether one is stored
 * (provider_has_credential) so a missing key becomes a clear message instead of a 401.
 * Browser: the key comes from the settings being edited or from secrets-web, and is checked
 * against the provider so a key typed for one service is never sent to another.
 */
import type { AISettings } from '../../../types';
import { invokeNative, isDesktopRuntime } from '../../../desktop/bridge';
import { getWebSecret, type WebSecretId } from '../../secrets-web';
import { ProviderError } from '../errors';

export type KeyedProvider = Extract<WebSecretId, 'openai' | 'gemini' | 'anthropic' | 'openrouter' | 'ollama'>;

const KEY_OWNERS: Array<[RegExp, KeyedProvider]> = [
  [/^sk-ant-/, 'anthropic'],
  [/^sk-or-/, 'openrouter'],
  [/^AIza/, 'gemini'],
];

/** False when the key's prefix shows it belongs to a different provider. */
export function keyFitsProvider(key: string, provider: KeyedProvider): boolean {
  for (const [pattern, owner] of KEY_OWNERS) {
    if (pattern.test(key)) return owner === provider;
  }
  // OpenAI keys start with "sk-"; anything else unprefixed is allowed for Ollama/self-hosted.
  if (provider === 'anthropic' || provider === 'openrouter') return false;
  return true;
}

/** Browser key for a provider, or '' when none is held. */
export function webKey(provider: KeyedProvider, settings: AISettings): string {
  const typed = settings.provider === provider ? settings.apiKey.trim() : '';
  if (typed && keyFitsProvider(typed, provider)) return typed;
  const stored = getWebSecret(provider).trim();
  return stored && keyFitsProvider(stored, provider) ? stored : '';
}

const presentCache = new Map<string, number>();
const PRESENT_TTL_MS = 15_000;

/** Desktop: whether the vault holds a credential for this provider. Positive answers are cached briefly. */
export async function desktopHasCredential(provider: string): Promise<boolean> {
  const cached = presentCache.get(provider);
  if (cached && Date.now() - cached < PRESENT_TTL_MS) return true;
  const present = await invokeNative<boolean>('provider_has_credential', { provider });
  if (present) presentCache.set(provider, Date.now());
  else presentCache.delete(provider);
  return present;
}

/**
 * Makes sure a credential exists. Returns the browser key ('' on desktop, where the host
 * adds it). Throws ProviderError('config') with a message the owner can act on.
 */
export async function requireCredential(provider: KeyedProvider, settings: AISettings, label: string): Promise<string> {
  if (isDesktopRuntime()) {
    let present = false;
    try {
      present = await desktopHasCredential(provider);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ProviderError('config', `I couldn't check the Windows credential vault for your ${label} key (${reason}).`);
    }
    if (!present) throw new ProviderError('config', `No ${label} API key is saved yet. Add one in Settings and I'll be ready.`);
    return '';
  }
  const key = webKey(provider, settings);
  if (!key) throw new ProviderError('config', `I need a ${label} API key first. Add it in Settings (it stays in this browser).`);
  return key;
}

export function forgetCredentialCache(): void {
  presentCache.clear();
}

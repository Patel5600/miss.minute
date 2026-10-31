/**
 * Owner settings: defaults for every field, validation, persistence without secrets, and the
 * migration from the first release's format (same localStorage key, which other modules read).
 *
 * Secrets never touch localStorage. Desktop keys go to the OS vault through credential_set and
 * are only ever checked with provider_has_credential; browser keys go to secrets-web.
 */
import type { AIProvider, AISettings, VoiceEngine } from '../types';
import { TVA_SYSTEM_PROMPT } from '../data/tvaLore';
import { invokeNative, isDesktopRuntime } from '../desktop/bridge';
import { clearWebSecret, hasWebSecret, loadRememberedWebSecrets, setWebSecret, type WebSecretId } from './secrets-web';

export const SETTINGS_STORAGE_KEY = 'miss_minutes_settings';
const SCHEMA_VERSION = 2;

export const PROVIDERS: readonly AIProvider[] = ['tva-offline', 'chatgpt', 'openrouter', 'openai', 'gemini', 'anthropic', 'ollama'];

export const PROVIDER_LABELS: Record<AIProvider, string> = {
  'tva-offline': 'TVA Offline',
  chatgpt: 'ChatGPT',
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  anthropic: 'Anthropic Claude',
  ollama: 'Ollama',
};

/**
 * Default model per provider (October 2026). Empty means "choose at runtime": ChatGPT uses
 * the signed-in account's catalog, Ollama the first installed model.
 */
export const DEFAULT_MODELS: Record<AIProvider, string> = {
  'tva-offline': '',
  chatgpt: '',
  openrouter: 'google/gemini-3.8-flash',
  openai: 'gpt-6.1-terra',
  gemini: 'gemini-3.8-flash',
  anthropic: 'claude-sonnet-5-5',
  ollama: '',
};

export const DEFAULT_OLLAMA_ENDPOINT = 'http://localhost:11434/v1';

/** Models the first release filled in automatically; they are retired now. */
const OLD_AUTO_MODELS = new Set(['gemini-1.5-flash', 'gpt-4o-mini', 'claude-3-5-sonnet-20241022']);

const VOICE_ENGINES: readonly VoiceEngine[] = ['system', 'openai', 'elevenlabs', 'local'];

export function defaultModelFor(provider: AIProvider): string {
  return DEFAULT_MODELS[provider] ?? '';
}

export function defaultSettings(): AISettings {
  return {
    provider: 'tva-offline',
    apiKey: '',
    model: '',
    customEndpoint: DEFAULT_OLLAMA_ENDPOINT,
    systemPrompt: '',
    voiceEnabled: true,
    voicePitch: 1.12,
    voiceRate: 1.0,
    soundEffects: true,
    hologramMode: true,
    ambientChatter: true,
    roam: true,
    voiceEngine: 'system',
    openaiVoice: 'coral',
    elevenLabsKey: '',
    elevenLabsVoiceId: '',
    useElevenLabs: false,
    localVoice: false,
    homeCity: '',
    memoryEnabled: true,
    strictApprovals: false,
  };
}

// ── Validation ────────────────────────────────────────────────────────────────

function str(value: unknown, fallback: string, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** http(s) URL without credentials, trailing slash removed; otherwise the default. */
export function normalizeEndpoint(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return DEFAULT_OLLAMA_ENDPOINT;
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return DEFAULT_OLLAMA_ENDPOINT;
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return DEFAULT_OLLAMA_ENDPOINT;
  }
}

/** Any stored or edited value made into complete, valid settings. Secrets are kept as given. */
export function normalizeSettings(raw: unknown): AISettings {
  const d = defaultSettings();
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const provider = typeof r.provider === 'string' && (PROVIDERS as readonly string[]).includes(r.provider)
    ? (r.provider as AIProvider)
    : d.provider;
  const voiceEngine = typeof r.voiceEngine === 'string' && (VOICE_ENGINES as readonly string[]).includes(r.voiceEngine)
    ? (r.voiceEngine as VoiceEngine)
    : d.voiceEngine;
  const openaiVoice = typeof r.openaiVoice === 'string' && /^[a-z][a-z0-9_-]{0,39}$/i.test(r.openaiVoice.trim())
    ? r.openaiVoice.trim()
    : d.openaiVoice;
  return {
    provider,
    apiKey: str(r.apiKey, '', 4096).trim(),
    model: str(r.model, '', 200).trim(),
    customEndpoint: normalizeEndpoint(r.customEndpoint),
    systemPrompt: str(r.systemPrompt, '', 8000),
    voiceEnabled: bool(r.voiceEnabled, d.voiceEnabled),
    voicePitch: num(r.voicePitch, d.voicePitch, 0.5, 2),
    voiceRate: num(r.voiceRate, d.voiceRate, 0.5, 2),
    soundEffects: bool(r.soundEffects, d.soundEffects),
    hologramMode: bool(r.hologramMode, d.hologramMode),
    ambientChatter: bool(r.ambientChatter, d.ambientChatter ?? true),
    roam: bool(r.roam, d.roam ?? true),
    voiceEngine,
    openaiVoice,
    elevenLabsKey: str(r.elevenLabsKey, '', 4096).trim(),
    elevenLabsVoiceId: str(r.elevenLabsVoiceId, '', 200).trim(),
    useElevenLabs: bool(r.useElevenLabs, d.useElevenLabs ?? false),
    localVoice: bool(r.localVoice, d.localVoice ?? false),
    homeCity: str(r.homeCity, '', 120).trim(),
    memoryEnabled: bool(r.memoryEnabled, d.memoryEnabled ?? true),
    strictApprovals: bool(r.strictApprovals, d.strictApprovals ?? false),
  };
}

// ── Persistence ───────────────────────────────────────────────────────────────

interface LegacySecrets {
  provider: AIProvider;
  apiKey: string;
  elevenLabsKey: string;
}

let legacySecrets: LegacySecrets | null = null;
const listeners = new Set<(settings: AISettings) => void>();

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function withoutSecrets(settings: AISettings): AISettings {
  return { ...settings, apiKey: '', elevenLabsKey: '' };
}

function write(settings: AISettings): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ ...withoutSecrets(settings), _schema: SCHEMA_VERSION }));
  } catch {
    // Quota or privacy mode: settings stay in memory for this session.
  }
}

/** Upgrades a first-release record: retired auto-filled models, the old default prompt, voice engine. */
function migrate(raw: Record<string, unknown>): AISettings {
  const settings = normalizeSettings(raw);
  if (raw._schema === SCHEMA_VERSION) return settings;
  if (!settings.model || OLD_AUTO_MODELS.has(settings.model) || settings.provider === 'tva-offline') {
    settings.model = defaultModelFor(settings.provider);
  }
  if (settings.systemPrompt.trim() === TVA_SYSTEM_PROMPT.trim()) settings.systemPrompt = '';
  if (typeof raw.voiceEngine !== 'string') {
    settings.voiceEngine = settings.localVoice ? 'local' : settings.useElevenLabs ? 'elevenlabs' : 'system';
  }
  return settings;
}

/** Settings from this browser profile, with defaults for anything missing. Never contains stored secrets. */
export function loadSettings(): AISettings {
  const store = storage();
  let raw: Record<string, unknown> | null = null;
  try {
    const text = store?.getItem(SETTINGS_STORAGE_KEY);
    const parsed = text ? (JSON.parse(text) as unknown) : null;
    raw = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    raw = null;
  }
  if (!raw) return defaultSettings();
  const settings = migrate(raw);
  const plaintextKey = settings.apiKey || settings.elevenLabsKey;
  if (plaintextKey) {
    // Very old builds stored keys in plain text. Move them out and scrub the record.
    legacySecrets = { provider: settings.provider, apiKey: settings.apiKey, elevenLabsKey: settings.elevenLabsKey ?? '' };
  }
  if (plaintextKey || raw._schema !== SCHEMA_VERSION) write(settings);
  return withoutSecrets(settings);
}

/** Validates and stores settings (secrets stripped) and tells listeners in every window. */
export function saveSettings(settings: AISettings): AISettings {
  const normalized = normalizeSettings(settings);
  write(normalized);
  const stored = withoutSecrets(normalized);
  listeners.forEach(listener => {
    try {
      listener(stored);
    } catch {
      // Keep notifying the rest.
    }
  });
  return stored;
}

/** Called with the stored settings whenever they change here or in another window. */
export function onSettingsChange(listener: (settings: AISettings) => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === SETTINGS_STORAGE_KEY) listener(loadSettings());
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

/**
 * Startup: loads settings, moves any plaintext key left by an old build into the vault
 * (desktop) or session memory (browser), and decrypts remembered browser keys.
 */
export async function initializeSettings(): Promise<AISettings> {
  const settings = loadSettings();
  const legacy = legacySecrets;
  legacySecrets = null;
  if (legacy) {
    const moves: Array<[KeyProvider, string]> = [];
    if (legacy.apiKey && isKeyProvider(legacy.provider)) moves.push([legacy.provider, legacy.apiKey]);
    if (legacy.elevenLabsKey) moves.push(['elevenlabs', legacy.elevenLabsKey]);
    for (const [provider, secret] of moves) {
      try {
        await saveProviderKey(provider, secret);
      } catch {
        // The key stays unusable rather than being written back in plain text.
      }
    }
  }
  if (!isDesktopRuntime()) await loadRememberedWebSecrets();
  return settings;
}

// ── Provider keys (one API for both runtimes) ──────────────────────────────────

export type KeyProvider = WebSecretId;

const KEY_PROVIDERS: readonly KeyProvider[] = ['openai', 'gemini', 'anthropic', 'openrouter', 'ollama', 'elevenlabs'];

export function isKeyProvider(value: string): value is KeyProvider {
  return (KEY_PROVIDERS as readonly string[]).includes(value);
}

/** Whether this provider needs an API key ('chatgpt' uses sign-in, Ollama and offline need nothing). */
export function providerNeedsKey(provider: AIProvider): boolean {
  return provider === 'openai' || provider === 'gemini' || provider === 'anthropic' || provider === 'openrouter';
}

/**
 * Stores a key. Desktop: OS vault via credential_set (never readable from here afterwards).
 * Browser: held in memory; `remember: true` also keeps it encrypted on this device.
 */
export async function saveProviderKey(provider: KeyProvider, secret: string, options: { remember?: boolean } = {}): Promise<void> {
  if (!isKeyProvider(provider)) throw new Error('Unknown provider.');
  const value = secret.trim();
  if (isDesktopRuntime()) {
    if (!value) {
      await invokeNative<void>('credential_delete', { provider });
      return;
    }
    await invokeNative<void>('credential_set', { provider, secret: value });
    return;
  }
  await setWebSecret(provider, value, options);
}

/** Whether a key is stored for this provider. Never returns the key itself. */
export async function hasProviderKey(provider: KeyProvider): Promise<boolean> {
  if (!isKeyProvider(provider)) return false;
  if (isDesktopRuntime()) return invokeNative<boolean>('provider_has_credential', { provider });
  return hasWebSecret(provider);
}

export async function removeProviderKey(provider: KeyProvider): Promise<void> {
  if (!isKeyProvider(provider)) return;
  if (isDesktopRuntime()) {
    await invokeNative<void>('credential_delete', { provider });
    return;
  }
  await clearWebSecret(provider);
}

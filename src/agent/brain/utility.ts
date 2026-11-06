/**
 * Small one-shot model calls for background work (memory extraction, chat titles): no tools,
 * no persona, the provider's cheap model where it has one, falling back to the chat model when
 * the cheap one isn't available to this account.
 */
import type { AISettings } from '../../types';
import { ProviderError } from './errors';
import { utilityInstructions } from './persona';
import { adapterFor } from './providers';
import type { JsonOutput, ModelProfile } from './providers/types';

export interface UtilityOptions {
  json?: JsonOutput;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

const UTILITY_TIMEOUT_MS = 45_000;

export async function completeUtility(settings: AISettings, task: string, prompt: string, options: UtilityOptions = {}): Promise<string> {
  const adapter = adapterFor(settings.provider);
  if (!adapter) throw new ProviderError('config', 'The offline engine has no model for this.', { recoverable: false });
  const signal = options.signal ?? AbortSignal.timeout(UTILITY_TIMEOUT_MS);
  const run = async (profile: ModelProfile) => {
    const session = adapter.session({
      settings,
      profile,
      instructions: utilityInstructions(task),
      conversation: [{ role: 'user', text: prompt, images: [] }],
      tools: [],
      purpose: 'utility',
      json: options.json,
      maxOutputTokens: options.maxOutputTokens,
    });
    const result = await session.round({ onText: () => undefined, signal, toolChoice: 'none' });
    return result.text;
  };
  const cheap = await adapter.profile(settings, 'utility', signal);
  try {
    return await run(cheap);
  } catch (error) {
    const retryable = error instanceof ProviderError && (error.kind === 'not_found' || error.kind === 'permission' || error.kind === 'bad_request' || error.kind === 'unsupported');
    if (!retryable) throw error;
    const chat = await adapter.profile(settings, 'chat', signal);
    if (chat.model === cheap.model) throw error;
    return run(chat);
  }
}

/** The first JSON object in a model reply (tolerates code fences and stray prose). */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

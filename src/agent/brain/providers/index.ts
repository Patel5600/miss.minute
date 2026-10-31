import type { AIProvider } from '../../../types';
import { anthropicAdapter } from './anthropic';
import { ollamaAdapter, openrouterAdapter } from './chatCompletions';
import { geminiAdapter } from './gemini';
import { chatgptAdapter, openaiAdapter } from './responses';
import type { ProviderAdapter } from './types';

const ADAPTERS: Record<Exclude<AIProvider, 'tva-offline'>, ProviderAdapter> = {
  openai: openaiAdapter,
  chatgpt: chatgptAdapter,
  openrouter: openrouterAdapter,
  gemini: geminiAdapter,
  anthropic: anthropicAdapter,
  ollama: ollamaAdapter,
};

/** The adapter for a model provider, or null for the built-in offline engine. */
export function adapterFor(provider: AIProvider): ProviderAdapter | null {
  return provider === 'tva-offline' ? null : ADAPTERS[provider] ?? null;
}

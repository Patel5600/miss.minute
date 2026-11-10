/**
 * Miss Minutes' brain: `brain.runTurn` for conversation, plus model discovery and connection
 * tests for Settings. Everything the UI needs from the brain is exported from here.
 */
import type { AISettings } from '../../types';
import { PROVIDER_LABELS } from '../settings';
import { toProviderError } from './errors';
import { runTurn } from './orchestrator';
import { adapterFor } from './providers';
import type { Brain, ModelOption } from './types';

const OFFLINE_MODEL: ModelOption = { id: 'tva-offline', label: 'TVA offline engine (no model)', tools: true, vision: false };

/** Models plus the reason listing failed, for Settings screens that want to show it. */
export async function listModelsWithStatus(settings: AISettings): Promise<{ models: ModelOption[]; error?: string }> {
  if (settings.provider === 'tva-offline') return { models: [OFFLINE_MODEL] };
  const adapter = adapterFor(settings.provider);
  if (!adapter) return { models: [], error: 'Unknown provider.' };
  try {
    return { models: await adapter.listModels(settings) };
  } catch (error) {
    return { models: [], error: toProviderError(error, PROVIDER_LABELS[settings.provider]).message };
  }
}

export const brain: Brain = {
  runTurn,
  async listModels(settings) {
    return (await listModelsWithStatus(settings)).models;
  },
  async testConnection(settings) {
    if (settings.provider === 'tva-offline') {
      return { ok: true, message: 'The offline engine is built in and needs no model or key. Weather and web search still need an internet connection.' };
    }
    const adapter = adapterFor(settings.provider);
    if (!adapter) return { ok: false, message: 'Unknown provider.' };
    try {
      return await adapter.testConnection(settings);
    } catch (error) {
      return { ok: false, message: toProviderError(error, PROVIDER_LABELS[settings.provider]).message };
    }
  },
};

export type { BrainEvent, TurnInput, ModelOption, ApprovalHandler, Brain } from './types';
export { inferEmotion, stripCueTags } from './cueParser';
export { startOpenRouterPairing, completeOpenRouterPairingFromUrl } from './pairing/openrouterWeb';
export { resetChatGptCache, CHATGPT_USAGE_URL } from './providers/responses';
export { forgetCredentialCache } from './providers/auth';
export { generateChatTitle, autoTitleChat, fallbackTitle, DEFAULT_CHAT_TITLE } from '../memory/titles';
export { extractMemories, scheduleMemoryExtraction } from '../memory/extract';

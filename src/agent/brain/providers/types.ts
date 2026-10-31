/**
 * What every provider adapter implements. A session owns the provider-native message list for
 * one turn, so continuation state (reasoning items, thinking blocks, thought signatures) stays
 * exact across tool rounds without leaking into the shared conversation types.
 */
import type { AIProvider, AISettings } from '../../../types';
import type { ModelOption } from '../types';
import type { ConvMessage, ModelToolCall, ToolResultForModel, ToolSpec } from '../conversation';

export interface ModelProfile {
  model: string;
  vision: boolean;
  tools: boolean;
}

export type Purpose = 'chat' | 'utility';

export interface Instructions {
  /** Persona, rules and tool policy: identical across turns, so providers can cache it. */
  stable: string;
  /** Time, agenda, memories: changes every turn. */
  dynamic: string;
}

export interface JsonOutput {
  name: string;
  /** Strict-mode compatible JSON Schema (all properties required, no extra properties). */
  schema: Record<string, unknown>;
}

export interface SessionInit {
  settings: AISettings;
  profile: ModelProfile;
  instructions: Instructions;
  conversation: ConvMessage[];
  tools: ToolSpec[];
  purpose: Purpose;
  /** Utility calls: ask for JSON that matches this schema where the provider supports it. */
  json?: JsonOutput;
  maxOutputTokens?: number;
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'filtered' | 'other';

export interface RoundResult {
  /** Raw model text for this round, cue tag included. */
  text: string;
  toolCalls: ModelToolCall[];
  finish: FinishReason;
  /** Model the provider reports having used. */
  model: string;
}

export interface RoundOptions {
  onText(delta: string): void;
  signal: AbortSignal;
  /** 'none' on the last allowed round so the model answers in words. */
  toolChoice: 'auto' | 'none';
}

export interface ProviderSession {
  round(options: RoundOptions): Promise<RoundResult>;
  /** Results for every call of the last round, in order. */
  addToolResults(results: ToolResultForModel[]): void;
}

export interface ProviderAdapter {
  id: Exclude<AIProvider, 'tva-offline'>;
  label: string;
  /** Model, capabilities and credential check. Throws ProviderError('config' | 'auth') with a clear message. */
  profile(settings: AISettings, purpose: Purpose, signal?: AbortSignal): Promise<ModelProfile>;
  session(init: SessionInit): ProviderSession;
  listModels(settings: AISettings): Promise<ModelOption[]>;
  testConnection(settings: AISettings): Promise<{ ok: boolean; message: string }>;
}

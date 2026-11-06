/**
 * OpenAI-compatible Chat Completions, streamed: OpenRouter (https://openrouter.ai/api/v1) and
 * Ollama (default http://localhost:11434/v1). Tool calls arrive as deltas and are assembled by
 * index; OpenRouter's reasoning_details are replayed inside the tool loop so models that sign
 * their reasoning (Gemini 3, Claude) keep working across rounds.
 */
import type { AISettings } from '../../../types';
import { isDesktopRuntime } from '../../../desktop/bridge';
import { defaultModelFor, normalizeEndpoint } from '../../settings';
import type { ModelOption } from '../types';
import { ProviderError, httpError, parseErrorBody } from '../errors';
import { openHttpStream, readMessages, type HttpStream } from '../transport';
import { parseToolArguments, toolOutputText, type ConvMessage, type ModelToolCall, type ToolResultForModel, type ToolSpec } from '../conversation';
import { requireCredential, webKey } from './auth';
import { jsonSchemaFor } from './schema';
import type { FinishReason, ModelProfile, ProviderAdapter, ProviderSession, RoundOptions, RoundResult, SessionInit } from './types';

type Kind = 'openrouter' | 'ollama';
type Item = Record<string, unknown>;

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const LABEL: Record<Kind, string> = { openrouter: 'OpenRouter', ollama: 'Ollama' };

export function ollamaBase(settings: AISettings): string {
  const base = normalizeEndpoint(settings.customEndpoint);
  return /\/v1$/i.test(base) ? base : `${base}/v1`;
}

function ollamaRoot(settings: AISettings): string {
  return ollamaBase(settings).replace(/\/v1$/i, '');
}

function baseUrl(kind: Kind, settings: AISettings): string {
  return kind === 'openrouter' ? OPENROUTER_BASE : ollamaBase(settings);
}

function credentialHeaders(kind: Kind, settings: AISettings): Record<string, string> | undefined {
  if (isDesktopRuntime()) return undefined;
  const key = webKey(kind, settings);
  return key ? { Authorization: `Bearer ${key}` } : undefined;
}

function networkHint(kind: Kind, settings: AISettings, error: ProviderError): ProviderError {
  if (kind !== 'ollama' || error.kind !== 'network') return error;
  const where = ollamaRoot(settings);
  const browserHint = isDesktopRuntime() ? '' : ' In the browser, also allow this page with the OLLAMA_ORIGINS setting.';
  return new ProviderError('network', `I couldn't reach Ollama at ${where}. Is it running?${browserHint}`, { detail: error.detail });
}

async function getJson(kind: Kind, settings: AISettings, url: string, auth: boolean): Promise<unknown> {
  let stream: HttpStream;
  try {
    stream = await openHttpStream({
      provider: kind,
      url,
      method: 'GET',
      headers: { Accept: 'application/json' },
      secretHeaders: auth ? credentialHeaders(kind, settings) : undefined,
      label: LABEL[kind],
      idleTimeoutMs: 20_000,
    });
  } catch (error) {
    throw error instanceof ProviderError ? networkHint(kind, settings, error) : error;
  }
  const body = await stream.text(8_000_000);
  if (!stream.ok) throw httpError(LABEL[kind], stream.status, body);
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ProviderError('protocol', `${LABEL[kind]} answered with something that isn't JSON.`);
  }
}

async function postJson(kind: Kind, settings: AISettings, url: string, payload: unknown): Promise<unknown> {
  const stream = await openHttpStream({
    provider: kind,
    url,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    secretHeaders: credentialHeaders(kind, settings),
    body: JSON.stringify(payload),
    label: LABEL[kind],
    idleTimeoutMs: 15_000,
  });
  const body = await stream.text(2_000_000);
  if (!stream.ok) throw httpError(LABEL[kind], stream.status, body);
  return JSON.parse(body) as unknown;
}

// ── Capabilities ─────────────────────────────────────────────────────────────

interface OpenRouterModel {
  id: string;
  name?: string;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  supported_parameters?: string[];
}

let openRouterCatalog: { at: number; models: OpenRouterModel[] } | null = null;

/** OpenRouter's public model list (no key needed). Cached for an hour. */
export async function fetchOpenRouterCatalog(settings: AISettings, fresh = false): Promise<OpenRouterModel[]> {
  if (!fresh && openRouterCatalog && Date.now() - openRouterCatalog.at < 3_600_000) return openRouterCatalog.models;
  const json = (await getJson('openrouter', settings, `${OPENROUTER_BASE}/models`, false)) as { data?: OpenRouterModel[] };
  const models = (json.data ?? []).filter(model => model && typeof model.id === 'string');
  openRouterCatalog = { at: Date.now(), models };
  return models;
}

function openRouterOption(model: OpenRouterModel): ModelOption {
  return {
    id: model.id,
    label: model.name ?? model.id,
    vision: model.architecture?.input_modalities?.includes('image') ?? false,
    tools: model.supported_parameters?.includes('tools') ?? false,
  };
}

const ollamaCapabilities = new Map<string, { vision: boolean; tools: boolean }>();

async function ollamaCaps(settings: AISettings, model: string): Promise<{ vision: boolean; tools: boolean } | null> {
  const key = `${ollamaRoot(settings)}|${model}`;
  const cached = ollamaCapabilities.get(key);
  if (cached) return cached;
  try {
    const json = (await postJson('ollama', settings, `${ollamaRoot(settings)}/api/show`, { model })) as { capabilities?: unknown };
    if (!Array.isArray(json.capabilities)) return null;
    const caps = { vision: json.capabilities.includes('vision'), tools: json.capabilities.includes('tools') };
    ollamaCapabilities.set(key, caps);
    return caps;
  } catch {
    return null;
  }
}

async function ollamaModelIds(settings: AISettings): Promise<string[]> {
  const json = (await getJson('ollama', settings, `${ollamaBase(settings)}/models`, true)) as { data?: Array<{ id?: unknown }> };
  return (json.data ?? []).map(entry => (typeof entry.id === 'string' ? entry.id : '')).filter(Boolean);
}

// ── Messages ─────────────────────────────────────────────────────────────────

function conversationMessages(instructions: string, conversation: ConvMessage[]): Item[] {
  const out: Item[] = [{ role: 'system', content: instructions }];
  for (const message of conversation) {
    if (message.role === 'assistant') {
      out.push({ role: 'assistant', content: message.text });
    } else if (message.images.length === 0) {
      out.push({ role: 'user', content: message.text });
    } else {
      out.push({
        role: 'user',
        content: [
          { type: 'text', text: message.text },
          ...message.images.map(image => ({ type: 'image_url', image_url: { url: image.dataUrl } })),
        ],
      });
    }
  }
  return out;
}

/** Local models usually run with small context windows; keep tool definitions short there. */
function compactSpec(tool: ToolSpec): ToolSpec {
  const first = /^(.{20,200}?[.!?])(\s|$)/.exec(tool.description)?.[1] ?? tool.description.slice(0, 200);
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(tool.parameters.properties ?? {})) {
    const { description, ...rest } = value;
    properties[key] = description && description.length <= 60 ? { ...rest, description } : rest;
  }
  return { name: tool.name, description: first, parameters: { ...tool.parameters, properties: properties as ToolSpec['parameters']['properties'] } };
}

interface CallAcc {
  index: number;
  id: string;
  name: string;
  args: string;
}

function mergeToolCall(calls: CallAcc[], part: Item): void {
  const fn = (part.function && typeof part.function === 'object' ? part.function : {}) as Item;
  let target: CallAcc | undefined;
  if (typeof part.index === 'number') target = calls.find(call => call.index === part.index);
  else if (typeof part.id === 'string' && part.id) target = calls.find(call => call.id === part.id);
  else if (!fn.name && calls.length > 0) target = calls[calls.length - 1];
  if (!target) {
    target = { index: typeof part.index === 'number' ? part.index : calls.length, id: '', name: '', args: '' };
    calls.push(target);
  }
  if (typeof part.id === 'string' && part.id) target.id = part.id;
  if (typeof fn.name === 'string' && fn.name && !target.name) target.name = fn.name;
  if (typeof fn.arguments === 'string') target.args += fn.arguments;
  else if (fn.arguments && typeof fn.arguments === 'object') target.args = JSON.stringify(fn.arguments);
}

/** Concatenates streamed reasoning_details pieces that share an index (OpenRouter's documented shape). */
function mergeReasoning(acc: Item[], details: unknown[]): void {
  for (const raw of details) {
    if (!raw || typeof raw !== 'object') continue;
    const detail = raw as Item;
    const target = typeof detail.index === 'number'
      ? acc.find(existing => existing.index === detail.index && existing.type === detail.type)
      : undefined;
    if (!target) {
      acc.push({ ...detail });
      continue;
    }
    for (const field of ['text', 'summary', 'data', 'signature']) {
      if (typeof detail[field] === 'string') target[field] = `${typeof target[field] === 'string' ? target[field] : ''}${detail[field] as string}`;
    }
    for (const field of ['id', 'format']) {
      if (detail[field] !== undefined && detail[field] !== null && (target[field] === undefined || target[field] === null)) target[field] = detail[field];
    }
  }
}

function midStreamError(kind: Kind, error: unknown): ProviderError {
  const e = (error && typeof error === 'object' ? error : { message: String(error) }) as Item;
  const status = typeof e.code === 'number' ? e.code : undefined;
  const parsed = parseErrorBody(JSON.stringify({ error: e }));
  if (status && status >= 400) return httpError(LABEL[kind], status, JSON.stringify({ error: e }));
  return new ProviderError('server', `${LABEL[kind]} stopped mid-reply: ${parsed.message ?? 'unknown error'}.`, { code: parsed.code });
}

function mapFinish(reason: string | undefined, hasCalls: boolean): FinishReason {
  if (hasCalls) return 'tool_calls';
  if (reason === 'length') return 'length';
  if (reason === 'content_filter') return 'filtered';
  return 'stop';
}

class ChatSession implements ProviderSession {
  private readonly kind: Kind;
  private readonly init: SessionInit;
  private readonly messages: Item[];
  private toolsEnabled: boolean;

  constructor(kind: Kind, init: SessionInit) {
    this.kind = kind;
    this.init = init;
    const instructions = init.instructions.dynamic ? `${init.instructions.stable}\n\n${init.instructions.dynamic}` : init.instructions.stable;
    this.messages = conversationMessages(instructions, init.conversation);
    this.toolsEnabled = init.tools.length > 0;
  }

  private body(toolChoice: 'auto' | 'none'): Item {
    const { profile, tools, purpose } = this.init;
    const body: Item = {
      model: profile.model,
      messages: this.messages,
      stream: true,
      max_tokens: this.init.maxOutputTokens ?? (purpose === 'chat' ? 4096 : 1024),
    };
    if (this.toolsEnabled) {
      const specs = this.kind === 'ollama' ? tools.map(compactSpec) : tools;
      body.tools = specs.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: jsonSchemaFor(tool.parameters) } }));
      body.tool_choice = toolChoice;
    }
    if (this.kind === 'openrouter') body.reasoning = { effort: 'low' };
    if (this.kind === 'ollama' && this.init.json) body.response_format = { type: 'json_object' };
    return body;
  }

  async round(options: RoundOptions): Promise<RoundResult> {
    try {
      return await this.attempt(options);
    } catch (error) {
      // Ollama refuses tool definitions for models without tool support; chat without them.
      if (this.kind === 'ollama' && this.toolsEnabled && error instanceof ProviderError && /does not support tools/i.test(`${error.message} ${error.detail ?? ''}`)) {
        this.toolsEnabled = false;
        return this.attempt(options);
      }
      throw error;
    }
  }

  private async attempt(options: RoundOptions): Promise<RoundResult> {
    const { settings, profile } = this.init;
    let stream: HttpStream;
    try {
      stream = await openHttpStream({
        provider: this.kind,
        url: `${baseUrl(this.kind, settings)}/chat/completions`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        secretHeaders: credentialHeaders(this.kind, settings),
        body: JSON.stringify(this.body(options.toolChoice)),
        signal: options.signal,
        label: LABEL[this.kind],
        idleTimeoutMs: this.kind === 'ollama' ? 300_000 : 120_000,
      });
    } catch (error) {
      throw error instanceof ProviderError ? networkHint(this.kind, settings, error) : error;
    }
    if (!stream.ok) {
      const body = await stream.text(65_536).catch(() => '');
      const failure = httpError(LABEL[this.kind], stream.status, body, { model: profile.model, requestId: stream.headers['x-generation-id'] });
      if (this.kind === 'ollama' && failure.kind === 'not_found') {
        throw new ProviderError('not_found', `Ollama doesn't have the model "${profile.model}". Run "ollama pull ${profile.model}" or pick an installed model in Settings.`, { status: stream.status });
      }
      throw failure;
    }

    let text = '';
    let model = profile.model;
    let finishReason: string | undefined;
    const calls: CallAcc[] = [];
    const reasoning: Item[] = [];
    let sawChoice = false;

    for await (const message of readMessages(stream)) {
      const data = message.data.trim();
      if (data === '[DONE]') break;
      if (!data) continue;
      let chunk: Item;
      try {
        chunk = JSON.parse(data) as Item;
      } catch {
        continue;
      }
      if (chunk.error) throw midStreamError(this.kind, chunk.error);
      if (typeof chunk.model === 'string') model = chunk.model;
      const choices = Array.isArray(chunk.choices) ? (chunk.choices as Item[]) : [];
      const choice = choices[0];
      if (!choice) continue;
      sawChoice = true;
      // `message` instead of `delta` means a server answered without streaming.
      const rawDelta = choice.delta ?? choice.message;
      const delta = (rawDelta && typeof rawDelta === 'object' ? rawDelta : {}) as Item;
      const content = delta.content;
      if (typeof content === 'string' && content) {
        text += content;
        options.onText(content);
      } else if (Array.isArray(content)) {
        for (const part of content as Item[]) {
          if (typeof part?.text === 'string' && part.text) {
            text += part.text;
            options.onText(part.text);
          }
        }
      }
      if (Array.isArray(delta.reasoning_details)) mergeReasoning(reasoning, delta.reasoning_details);
      if (Array.isArray(delta.tool_calls)) for (const part of delta.tool_calls as Item[]) mergeToolCall(calls, part);
      if (typeof choice.finish_reason === 'string' && choice.finish_reason) finishReason = choice.finish_reason;
    }
    if (!sawChoice) throw new ProviderError('protocol', `${LABEL[this.kind]} ended the stream without a reply.`);
    if (finishReason === 'error') throw new ProviderError('server', `${LABEL[this.kind]} reported an error while answering.`);

    const named = calls.filter(call => call.name);
    const toolCalls: ModelToolCall[] = named.map((call, i) => {
      if (!call.id) call.id = `call_${i}_${Date.now().toString(36)}`;
      const parsed = parseToolArguments(call.args);
      return { id: call.id, name: call.name, args: parsed.args, argsError: parsed.error };
    });

    const assistant: Item = { role: 'assistant', content: this.kind === 'openrouter' ? text || null : text };
    if (named.length > 0) {
      assistant.tool_calls = named.map(call => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.args || '{}' },
      }));
    }
    if (reasoning.length > 0) assistant.reasoning_details = reasoning;
    if (text || toolCalls.length > 0) this.messages.push(assistant);

    return { text, toolCalls, finish: mapFinish(finishReason, toolCalls.length > 0), model };
  }

  addToolResults(results: ToolResultForModel[]): void {
    const images = results.flatMap(result => result.images.map(image => ({ image, name: result.name })));
    for (const result of results) {
      this.messages.push({ role: 'tool', tool_call_id: result.callId, content: toolOutputText(result) });
    }
    if (images.length > 0 && this.init.profile.vision) {
      // Tool messages carry text only in this API, so images follow as an owner-side message.
      this.messages.push({
        role: 'user',
        content: [
          { type: 'text', text: `Image${images.length === 1 ? '' : 's'} returned by ${[...new Set(images.map(entry => entry.name))].join(', ')}:` },
          ...images.map(entry => ({ type: 'image_url', image_url: { url: entry.image.dataUrl } })),
        ],
      });
    }
  }
}

// ── Adapters ───────────────────────────────────────────────────────────────────

async function openRouterProfile(settings: AISettings): Promise<ModelProfile> {
  await requireCredential('openrouter', settings, 'OpenRouter');
  const model = settings.model.trim() || defaultModelFor('openrouter');
  try {
    const entry = (await fetchOpenRouterCatalog(settings)).find(candidate => candidate.id === model);
    if (entry) {
      const option = openRouterOption(entry);
      return { model, vision: option.vision ?? false, tools: option.tools ?? false };
    }
  } catch {
    // Catalog unavailable: assume a modern model and let the API say otherwise.
  }
  return { model, vision: true, tools: true };
}

async function ollamaProfile(settings: AISettings): Promise<ModelProfile> {
  let model = settings.model.trim();
  if (!model) {
    const ids = await ollamaModelIds(settings);
    model = ids[0] ?? '';
    if (!model) throw new ProviderError('config', 'Ollama is running but has no models yet. Run "ollama pull <model>" (for example a Llama, Qwen or Gemma model) and try again.', { recoverable: false });
  }
  const caps = await ollamaCaps(settings, model);
  return { model, vision: caps?.vision ?? false, tools: caps?.tools ?? true };
}

export const openrouterAdapter: ProviderAdapter = {
  id: 'openrouter',
  label: 'OpenRouter',
  profile: settings => openRouterProfile(settings),
  session: init => new ChatSession('openrouter', init),
  async listModels(settings) {
    const models = await fetchOpenRouterCatalog(settings, true);
    const current = settings.model.trim() || defaultModelFor('openrouter');
    return models
      .filter(model => !model.id.endsWith(':batch') && (model.architecture?.output_modalities?.includes('text') ?? true))
      .map(openRouterOption)
      .sort((a, b) => Number(b.id === current) - Number(a.id === current) || Number(b.tools) - Number(a.tools));
  },
  async testConnection(settings) {
    await requireCredential('openrouter', settings, 'OpenRouter');
    const json = (await getJson('openrouter', settings, `${OPENROUTER_BASE}/key`, true)) as { data?: Item };
    const data = json.data ?? {};
    const label = typeof data.label === 'string' && data.label ? ` (key "${data.label}")` : '';
    const remaining = typeof data.limit_remaining === 'number' ? ` ${data.limit_remaining.toFixed(2)} credits left on this key.` : '';
    const model = settings.model.trim() || defaultModelFor('openrouter');
    let modelNote = '';
    try {
      const listed = (await fetchOpenRouterCatalog(settings)).some(entry => entry.id === model);
      modelNote = listed ? ` ${model} is available.` : ` But "${model}" isn't in OpenRouter's catalog; pick another model.`;
      if (!listed) return { ok: false, message: `Connected to OpenRouter${label}.${modelNote}` };
    } catch {
      // The key check already passed.
    }
    return { ok: true, message: `Connected to OpenRouter${label}.${remaining}${modelNote}` };
  },
};

export const ollamaAdapter: ProviderAdapter = {
  id: 'ollama',
  label: 'Ollama',
  profile: settings => ollamaProfile(settings),
  session: init => new ChatSession('ollama', init),
  async listModels(settings) {
    const ids = await ollamaModelIds(settings);
    const options: ModelOption[] = [];
    for (const id of ids.slice(0, 40)) {
      const caps = await ollamaCaps(settings, id);
      options.push({ id, label: id, vision: caps?.vision, tools: caps?.tools });
    }
    return options;
  },
  async testConnection(settings) {
    const ids = await ollamaModelIds(settings);
    if (ids.length === 0) return { ok: false, message: `Ollama is running at ${ollamaRoot(settings)}, but no models are installed. Run "ollama pull <model>".` };
    const model = settings.model.trim() || ids[0];
    const installed = ids.includes(model);
    return {
      ok: installed,
      message: installed
        ? `Ollama is running at ${ollamaRoot(settings)} with ${ids.length} model${ids.length === 1 ? '' : 's'}; using ${model}.`
        : `Ollama is running, but "${model}" isn't installed. Installed: ${ids.slice(0, 6).join(', ')}.`,
    };
  },
};

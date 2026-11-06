/**
 * Anthropic Messages API, streamed. Browser requests carry the documented opt-in header
 * `anthropic-dangerous-direct-browser-access: true`. Within a tool loop the assistant turn is
 * replayed exactly as streamed (thinking blocks with signatures included), because current
 * Claude models reject or degrade on edited thinking; the system prompt and tools stay
 * identical across rounds for the same reason.
 */
import type { AISettings } from '../../../types';
import { isDesktopRuntime } from '../../../desktop/bridge';
import { defaultModelFor } from '../../settings';
import type { ModelOption } from '../types';
import { ProviderError, httpError } from '../errors';
import { openHttpStream, readMessages } from '../transport';
import { parseDataUrl, parseToolArguments, toolOutputText, type ConvMessage, type ModelToolCall, type ToolResultForModel } from '../conversation';
import { requireCredential, webKey } from './auth';
import { jsonSchemaFor } from './schema';
import type { FinishReason, ProviderAdapter, ProviderSession, RoundOptions, RoundResult, SessionInit } from './types';

type Item = Record<string, unknown>;

const API = 'https://api.anthropic.com/v1';
const VERSION = '2023-06-01';
const UTILITY_MODEL = 'claude-haiku-5-5';

function headers(settings: AISettings): { headers: Record<string, string>; secret?: Record<string, string> } {
  const base: Record<string, string> = { 'Content-Type': 'application/json', 'anthropic-version': VERSION };
  if (isDesktopRuntime()) return { headers: base };
  const key = webKey('anthropic', settings);
  return {
    headers: { ...base, 'anthropic-dangerous-direct-browser-access': 'true' },
    secret: key ? { 'x-api-key': key } : undefined,
  };
}

/** `output_config.effort` exists on Claude 5 models and on Opus 4.5 / 4.6+ and Sonnet 4.6+. */
function supportsEffort(model: string): boolean {
  const match = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?!\d)/i.exec(model);
  if (!match) return false;
  const family = match[1].toLowerCase();
  const major = Number(match[2]);
  const minor = match[3] ? Number(match[3]) : 0;
  if (major >= 5) return true;
  if (major === 4 && family === 'opus' && minor >= 5) return true;
  return major === 4 && family === 'sonnet' && minor >= 6;
}

function imageBlock(dataUrl: string): Item | null {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return null;
  return { type: 'image', source: { type: 'base64', media_type: parsed.mime, data: parsed.base64 } };
}

function conversationMessages(conversation: ConvMessage[]): Item[] {
  return conversation.map(message => {
    if (message.role === 'assistant') return { role: 'assistant', content: [{ type: 'text', text: message.text }] };
    const content: Item[] = [];
    for (const image of message.images) {
      const block = imageBlock(image.dataUrl);
      if (block) content.push(block);
    }
    content.push({ type: 'text', text: message.text });
    return { role: 'user', content };
  });
}

function mapStop(reason: string | undefined, hasCalls: boolean): FinishReason {
  if (hasCalls || reason === 'tool_use') return 'tool_calls';
  if (reason === 'max_tokens' || reason === 'model_context_window_exceeded') return 'length';
  if (reason === 'refusal') return 'filtered';
  return 'stop';
}

function streamError(error: unknown): ProviderError {
  const e = (error && typeof error === 'object' ? error : {}) as Item;
  const type = typeof e.type === 'string' ? e.type : '';
  const message = typeof e.message === 'string' ? e.message : 'unknown error';
  if (type === 'overloaded_error') return new ProviderError('unavailable', `Anthropic is overloaded right now: ${message}.`, { code: type });
  if (type === 'rate_limit_error') return new ProviderError('rate_limit', `Anthropic is rate limiting requests: ${message}.`, { code: type });
  if (type === 'api_error') return new ProviderError('server', `Anthropic had an internal error: ${message}.`, { code: type });
  return new ProviderError('protocol', `Anthropic stopped the reply: ${message}.`, { code: type });
}

class AnthropicSession implements ProviderSession {
  private readonly init: SessionInit;
  private readonly messages: Item[];
  private effort: boolean;

  constructor(init: SessionInit) {
    this.init = init;
    this.messages = conversationMessages(init.conversation);
    this.effort = supportsEffort(init.profile.model);
  }

  private body(toolChoice: 'auto' | 'none'): Item {
    const { profile, instructions, tools, purpose } = this.init;
    const system: Item[] = [{ type: 'text', text: instructions.stable, cache_control: { type: 'ephemeral' } }];
    if (instructions.dynamic) system.push({ type: 'text', text: instructions.dynamic });
    const body: Item = {
      model: profile.model,
      max_tokens: this.init.maxOutputTokens ?? (purpose === 'chat' ? 8192 : 1024),
      system,
      messages: this.messages,
      stream: true,
    };
    if (tools.length > 0) {
      body.tools = tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: jsonSchemaFor(tool.parameters) }));
      body.tool_choice = { type: toolChoice };
    }
    // Low effort keeps spoken replies quick; these models still think when a request needs it.
    if (this.effort) body.output_config = { effort: 'low' };
    return body;
  }

  async round(options: RoundOptions): Promise<RoundResult> {
    try {
      return await this.attempt(options);
    } catch (error) {
      // An older model that rejects the effort setting gets one retry without it.
      if (this.effort && error instanceof ProviderError && error.kind === 'bad_request' && /(output_config|effort)/i.test(`${error.message} ${error.detail ?? ''}`)) {
        this.effort = false;
        return this.attempt(options);
      }
      throw error;
    }
  }

  private async attempt(options: RoundOptions): Promise<RoundResult> {
    const { settings, profile } = this.init;
    const { headers: plain, secret } = headers(settings);
    const stream = await openHttpStream({
      provider: 'anthropic',
      url: `${API}/messages`,
      method: 'POST',
      headers: { ...plain, Accept: 'text/event-stream' },
      secretHeaders: secret,
      body: JSON.stringify(this.body(options.toolChoice)),
      signal: options.signal,
      label: 'Anthropic',
    });
    if (!stream.ok) {
      const body = await stream.text(65_536).catch(() => '');
      throw httpError('Anthropic', stream.status, body, { model: profile.model, requestId: stream.headers['request-id'] });
    }

    const blocks: Item[] = [];
    const jsonParts = new Map<number, string>();
    let text = '';
    let model = profile.model;
    let stopReason: string | undefined;
    let stopped = false;

    for await (const message of readMessages(stream)) {
      let event: Item;
      try {
        event = JSON.parse(message.data) as Item;
      } catch {
        continue;
      }
      const type = typeof event.type === 'string' ? event.type : message.event;
      switch (type) {
        case 'message_start': {
          const m = event.message as Item | undefined;
          if (typeof m?.model === 'string') model = m.model;
          break;
        }
        case 'content_block_start': {
          const index = typeof event.index === 'number' ? event.index : blocks.length;
          const block = { ...((event.content_block as Item | undefined) ?? { type: 'text', text: '' }) };
          if (block.type === 'tool_use') jsonParts.set(index, '');
          blocks[index] = block;
          if (block.type === 'text' && typeof block.text === 'string' && block.text) {
            text += block.text;
            options.onText(block.text);
          }
          break;
        }
        case 'content_block_delta': {
          const index = typeof event.index === 'number' ? event.index : blocks.length - 1;
          const block = blocks[index];
          const delta = (event.delta as Item | undefined) ?? {};
          if (!block) break;
          if (delta.type === 'text_delta' && typeof delta.text === 'string') {
            block.text = `${typeof block.text === 'string' ? block.text : ''}${delta.text}`;
            text += delta.text;
            options.onText(delta.text);
          } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            jsonParts.set(index, `${jsonParts.get(index) ?? ''}${delta.partial_json}`);
          } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
            block.thinking = `${typeof block.thinking === 'string' ? block.thinking : ''}${delta.thinking}`;
          } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
            block.signature = `${typeof block.signature === 'string' ? block.signature : ''}${delta.signature}`;
          } else if (delta.type === 'citations_delta' && delta.citation) {
            block.citations = [...(Array.isArray(block.citations) ? block.citations : []), delta.citation];
          }
          break;
        }
        case 'content_block_stop': {
          const index = typeof event.index === 'number' ? event.index : -1;
          const block = blocks[index];
          if (block?.type === 'tool_use') {
            const raw = jsonParts.get(index) ?? '';
            const parsed = parseToolArguments(raw.trim() ? raw : '{}');
            block.input = parsed.args ?? {};
            if (parsed.error) block._argsError = parsed.error;
          }
          break;
        }
        case 'message_delta': {
          const delta = (event.delta as Item | undefined) ?? {};
          if (typeof delta.stop_reason === 'string') stopReason = delta.stop_reason;
          break;
        }
        case 'message_stop':
          stopped = true;
          break;
        case 'error':
          throw streamError(event.error);
        default:
          break;
      }
    }
    if (!stopped && !stopReason) throw new ProviderError('protocol', 'Anthropic closed the stream before the reply finished.');

    const toolCalls: ModelToolCall[] = [];
    const replay: Item[] = [];
    for (const block of blocks) {
      if (!block) continue;
      if (block.type === 'tool_use') {
        const argsError = typeof block._argsError === 'string' ? block._argsError : undefined;
        delete block._argsError;
        toolCalls.push({
          id: typeof block.id === 'string' ? block.id : `toolu_${toolCalls.length}`,
          name: typeof block.name === 'string' ? block.name : '',
          args: argsError ? undefined : (block.input as Record<string, unknown>),
          argsError,
        });
      }
      // Empty text blocks are rejected on replay; every other block goes back unchanged.
      if (block.type === 'text' && !(typeof block.text === 'string' && block.text)) continue;
      replay.push(block);
    }
    if (replay.length > 0) this.messages.push({ role: 'assistant', content: replay });
    return { text, toolCalls, finish: mapStop(stopReason, toolCalls.length > 0), model };
  }

  addToolResults(results: ToolResultForModel[]): void {
    const content: Item[] = results.map(result => {
      const blocks: Item[] = [{ type: 'text', text: toolOutputText(result) }];
      for (const image of result.images) {
        const block = imageBlock(image.dataUrl);
        if (block) blocks.push(block);
      }
      return { type: 'tool_result', tool_use_id: result.callId, content: blocks, ...(result.isError ? { is_error: true } : {}) };
    });
    if (content.length > 0) this.messages.push({ role: 'user', content });
  }
}

async function listAnthropicModels(settings: AISettings): Promise<ModelOption[]> {
  await requireCredential('anthropic', settings, 'Anthropic');
  const { headers: plain, secret } = headers(settings);
  const stream = await openHttpStream({
    provider: 'anthropic',
    url: `${API}/models?limit=100`,
    method: 'GET',
    headers: { ...plain, Accept: 'application/json' },
    secretHeaders: secret,
    label: 'Anthropic',
    idleTimeoutMs: 20_000,
  });
  const body = await stream.text(2_000_000);
  if (!stream.ok) throw httpError('Anthropic', stream.status, body, { requestId: stream.headers['request-id'] });
  const data = (JSON.parse(body) as { data?: Array<{ id?: unknown; display_name?: unknown }> }).data ?? [];
  return data
    .filter(model => typeof model.id === 'string')
    .map(model => ({ id: model.id as string, label: typeof model.display_name === 'string' ? model.display_name : (model.id as string), vision: true, tools: true }));
}

export const anthropicAdapter: ProviderAdapter = {
  id: 'anthropic',
  label: 'Anthropic',
  async profile(settings, purpose) {
    await requireCredential('anthropic', settings, 'Anthropic');
    const model = purpose === 'utility' ? UTILITY_MODEL : settings.model.trim() || defaultModelFor('anthropic');
    return { model, vision: !/claude-(instant|2)/i.test(model), tools: true };
  },
  session: init => new AnthropicSession(init),
  listModels: settings => listAnthropicModels(settings),
  async testConnection(settings) {
    const models = await listAnthropicModels(settings);
    const model = settings.model.trim() || defaultModelFor('anthropic');
    const listed = models.some(option => option.id === model);
    return {
      ok: listed,
      message: listed
        ? `Connected to Anthropic. ${model} is available (${models.length} models).`
        : `Connected to Anthropic, but "${model}" isn't available to this key. Try ${models[0]?.id ?? 'another model'}.`,
    };
  },
};

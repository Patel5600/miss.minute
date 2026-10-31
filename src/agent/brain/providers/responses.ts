/**
 * OpenAI Responses API (POST /v1/responses, streamed), shared by two providers:
 *
 *  - openai: the owner's API key.
 *  - chatgpt: "Sign in with ChatGPT" plan usage, desktop only. The host adds the OAuth token.
 *    Per OpenAI's rules for this route every request is store:false + stream:true, carries the
 *    whole history in `input`, uses `instructions` (never system-role items), omits the
 *    unsupported fields (temperature, max_output_tokens, previous_response_id, metadata, ...),
 *    groups function tools in a namespace, and counts as successful only on response.completed.
 *
 * Both use store:false, so reasoning items are replayed with their encrypted content inside
 * the tool loop instead of being referenced by id.
 */
import type { AISettings } from '../../../types';
import type { ChatGptAccount } from '../../../desktop/bridge';
import { invokeNative, isDesktopRuntime } from '../../../desktop/bridge';
import { defaultModelFor } from '../../settings';
import type { ModelOption } from '../types';
import { ProviderError, httpError } from '../errors';
import { openHttpStream, readMessages, type HttpStream } from '../transport';
import { parseToolArguments, toolOutputText, type ConvMessage, type ModelToolCall, type ToolResultForModel, type ToolSpec } from '../conversation';
import { requireCredential, webKey } from './auth';
import { jsonSchemaFor } from './schema';
import type { FinishReason, ModelProfile, ProviderAdapter, ProviderSession, Purpose, RoundOptions, RoundResult, SessionInit } from './types';

const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const MODELS_URL = 'https://api.openai.com/v1/models';
const NAMESPACE = 'miss_minutes';
const UTILITY_MODEL = 'gpt-6-luna';
export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage';

type Kind = 'openai' | 'chatgpt';
type Item = Record<string, unknown>;

const LABEL: Record<Kind, string> = { openai: 'OpenAI', chatgpt: 'ChatGPT' };

function isReasoningModel(model: string): boolean {
  return /^(gpt-5|gpt-6|o[1-9])/i.test(model);
}

function effortFor(model: string, purpose: Purpose): string {
  // "none" is documented for GPT-6 Luna and GPT-6.1 Terra; every reasoning model accepts "low".
  if (purpose === 'utility' && /(luna|terra)/i.test(model)) return 'none';
  return 'low';
}

function visionModel(model: string): boolean {
  return !/^(gpt-3\.5|o1-mini|o3-mini|text-|davinci|babbage)/i.test(model);
}

function joinInstructions(init: SessionInit): string {
  return init.instructions.dynamic ? `${init.instructions.stable}\n\n${init.instructions.dynamic}` : init.instructions.stable;
}

function conversationInput(conversation: ConvMessage[]): Item[] {
  return conversation.map(message => {
    if (message.role === 'assistant') return { role: 'assistant', content: message.text };
    const content: Item[] = [];
    for (const image of message.images) content.push({ type: 'input_image', image_url: image.dataUrl, detail: 'auto' });
    content.push({ type: 'input_text', text: message.text });
    return { role: 'user', content };
  });
}

function functionTools(tools: ToolSpec[], kind: Kind): Item[] {
  const functions = tools.map(tool => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: jsonSchemaFor(tool.parameters),
    ...(kind === 'openai' ? { strict: false } : {}),
  }));
  if (kind === 'openai') return functions;
  return [{
    type: 'namespace',
    name: NAMESPACE,
    description: "Miss Minutes' assistant tools: time, timers, alarms, reminders, schedule, to-dos, notes, weather, search, memory and approved PC actions.",
    tools: functions,
  }];
}

/** Strips a namespace prefix some servers add ("miss_minutes.set_timer"). */
function localToolName(name: string): string {
  return name.replace(new RegExp(`^${NAMESPACE}(?:\\.|__|:|/)`), '');
}

function textOf(item: Item): string {
  const content = item.content;
  if (!Array.isArray(content)) return '';
  return content
    .map(part => (part && typeof part === 'object' && typeof (part as Item).text === 'string' ? (part as Item).text as string : ''))
    .join('');
}

// ── ChatGPT plan error codes ─────────────────────────────────────────────────────

let chatgptPausedUntil = 0;
const USAGE_PAUSE_MS = 120_000;

function usageLimitError(): ProviderError {
  return new ProviderError(
    'usage_limit',
    `You've reached the usage limit for using your ChatGPT plan here. Check it at ${CHATGPT_USAGE_URL}, or switch to an API key in Settings for now.`,
    { code: 'subscription_sharing_usage_limit_exceeded', link: CHATGPT_USAGE_URL, recoverable: false },
  );
}

function chatgptCodeError(code: string | undefined, message: string | undefined, param: string | undefined, status?: number): ProviderError | null {
  const opts = { code, param, status, detail: message };
  switch (code) {
    case 'subscription_sharing_usage_limit_exceeded':
      chatgptPausedUntil = Date.now() + USAGE_PAUSE_MS;
      return usageLimitError();
    case 'subscription_sharing_usage_unavailable':
      return new ProviderError('unavailable', "ChatGPT couldn't check your plan usage just now. Give it a minute and try again.", opts);
    case 'subscription_sharing_user_not_eligible':
      return new ProviderError('permission', "Your ChatGPT account or workspace can't share plan usage with apps. Use an API key in Settings instead.", { ...opts, recoverable: false });
    case 'subscription_sharing_unsupported_capability':
      return new ProviderError('unsupported', `ChatGPT plan usage doesn't support part of this request${param ? ` (${param})` : ''}.`, opts);
    case 'subscription_sharing_route_not_supported':
      return new ProviderError('permission', 'ChatGPT plan usage is not available on this endpoint.', { ...opts, recoverable: false });
    case 'subscription_sharing_invalid_user':
      return new ProviderError('auth', "ChatGPT couldn't validate your sign-in. Sign in with ChatGPT again in Settings.", opts);
    case 'chatpass_v2_scope_not_authorized':
    case 'chatpass_v2_invalid_authorization_context':
      return new ProviderError('permission', "This ChatGPT sign-in doesn't allow plan usage. Sign in again and allow Miss Minutes to use your plan.", { ...opts, recoverable: false });
    case 'subscription_sharing_user_unavailable':
      return new ProviderError('unavailable', 'ChatGPT account details are temporarily unavailable. Try again shortly.', opts);
    default:
      return null;
  }
}

async function failureFrom(stream: HttpStream, kind: Kind, model: string): Promise<ProviderError> {
  const body = await stream.text(65_536).catch(() => '');
  const requestId = stream.headers['x-request-id'];
  const generic = httpError(LABEL[kind], stream.status, body, { requestId, model });
  if (kind !== 'chatgpt') return generic;
  const specific = chatgptCodeError(generic.code, generic.detail, generic.param, stream.status);
  if (specific) return specific;
  if (generic.code === 'detail') {
    // Direct-admission failures arrive as {"detail": "..."} before any Responses processing.
    const detail = generic.detail ? `: ${generic.detail}` : '';
    if (stream.status === 401) return new ProviderError('auth', `ChatGPT didn't accept the sign-in or plan permission${detail}. Check the signed-in account in Settings.`, { status: 401, requestId });
    if (stream.status === 403) return new ProviderError('permission', `ChatGPT refused the request (a policy or region restriction)${detail}.`, { status: 403, requestId, recoverable: false });
    if (stream.status === 503) return new ProviderError('unavailable', `ChatGPT plan routing is unavailable right now${detail}. Try again shortly.`, { status: 503, requestId });
  }
  return generic;
}

function streamError(kind: Kind, error: unknown, fallback: string): ProviderError {
  const e = (error && typeof error === 'object' ? error : {}) as Item;
  const code = typeof e.code === 'string' ? e.code : undefined;
  const message = typeof e.message === 'string' ? e.message : fallback;
  const param = typeof e.param === 'string' ? e.param : undefined;
  if (kind === 'chatgpt') {
    const specific = chatgptCodeError(code, message, param);
    if (specific) return specific;
  }
  if (code === 'rate_limit_exceeded') return new ProviderError('rate_limit', `${LABEL[kind]} is rate limiting requests: ${message}`, { code });
  if (code === 'insufficient_quota') return new ProviderError('quota', `Your ${LABEL[kind]} account is out of quota: ${message}`, { code });
  if (code === 'server_error' || code === 'internal_error') return new ProviderError('server', `${LABEL[kind]} had an internal error: ${message}`, { code });
  return new ProviderError('protocol', `${LABEL[kind]} stopped the reply: ${message}`, { code, param });
}

/** Top-level body fields that can be dropped and retried when ChatGPT reports an unsupported capability. */
const DROPPABLE = ['include', 'reasoning', 'tools', 'tool_choice', 'text', 'parallel_tool_calls'];

function droppableFeature(error: ProviderError): string | null {
  if (error.code !== 'subscription_sharing_unsupported_capability' || !error.param) return null;
  const top = error.param.split(/[.[]/)[0];
  if (DROPPABLE.includes(top)) return top;
  if (top === 'input' && /image|content|output/i.test(error.param)) return 'images';
  return null;
}

// ── Session ──────────────────────────────────────────────────────────────────

class ResponsesSession implements ProviderSession {
  private readonly kind: Kind;
  private readonly init: SessionInit;
  private readonly input: Item[];
  private readonly dropped = new Set<string>();

  constructor(kind: Kind, init: SessionInit) {
    this.kind = kind;
    this.init = init;
    this.input = conversationInput(init.conversation);
  }

  private body(toolChoice: 'auto' | 'none'): Item {
    const { profile, tools, purpose, json } = this.init;
    const body: Item = {
      model: profile.model,
      instructions: joinInstructions(this.init),
      input: this.dropped.has('images') ? this.input.map(stripImages) : this.input,
      stream: true,
      store: false,
    };
    if (tools.length > 0 && !this.dropped.has('tools')) {
      body.tools = functionTools(tools, this.kind);
      if (!this.dropped.has('tool_choice')) body.tool_choice = toolChoice;
    }
    if (isReasoningModel(profile.model) && !this.dropped.has('reasoning')) {
      body.reasoning = { effort: effortFor(profile.model, purpose) };
      if (!this.dropped.has('include')) body.include = ['reasoning.encrypted_content'];
    }
    if (json && !this.dropped.has('text')) {
      body.text = { format: { type: 'json_schema', name: json.name, schema: json.schema, strict: true } };
    }
    if (this.kind === 'openai') body.max_output_tokens = this.init.maxOutputTokens ?? (purpose === 'chat' ? 8192 : 2048);
    return body;
  }

  async round(options: RoundOptions): Promise<RoundResult> {
    for (let attempt = 0; ; attempt += 1) {
      let emitted = false;
      try {
        return await this.attempt({ ...options, onText: delta => { emitted = true; options.onText(delta); } });
      } catch (error) {
        const feature = error instanceof ProviderError && !emitted && attempt < 3 ? droppableFeature(error) : null;
        if (!feature || this.dropped.has(feature)) throw error;
        // OpenAI's guidance: remove the unsupported part instead of resending the same body.
        this.dropped.add(feature);
        if (feature === 'include') this.dropped.add('reasoning-replay');
      }
    }
  }

  private async attempt(options: RoundOptions): Promise<RoundResult> {
    const { profile, settings } = this.init;
    const key = this.kind === 'openai' && !isDesktopRuntime() ? webKey('openai', settings) : '';
    const stream = await openHttpStream({
      provider: this.kind,
      url: RESPONSES_URL,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      secretHeaders: key ? { Authorization: `Bearer ${key}` } : undefined,
      body: JSON.stringify(this.body(options.toolChoice)),
      signal: options.signal,
      label: LABEL[this.kind],
    });
    if (!stream.ok) throw await failureFrom(stream, this.kind, profile.model);

    const done = new Map<number, Item>();
    let text = '';
    let model = profile.model;
    let final: Item | null = null;
    let status: 'completed' | 'incomplete' | null = null;

    for await (const message of readMessages(stream)) {
      if (message.data === '[DONE]') break;
      let event: Item;
      try {
        event = JSON.parse(message.data) as Item;
      } catch {
        continue;
      }
      const type = typeof event.type === 'string' ? event.type : message.event;
      switch (type) {
        case 'response.created':
        case 'response.in_progress': {
          const response = event.response as Item | undefined;
          if (typeof response?.model === 'string') model = response.model;
          break;
        }
        case 'response.output_text.delta':
        case 'response.refusal.delta': {
          const delta = event.delta;
          if (typeof delta === 'string' && delta) {
            text += delta;
            options.onText(delta);
          }
          break;
        }
        case 'response.output_item.done': {
          const index = typeof event.output_index === 'number' ? event.output_index : done.size;
          if (event.item && typeof event.item === 'object') done.set(index, event.item as Item);
          break;
        }
        case 'response.completed':
          final = (event.response as Item | undefined) ?? null;
          status = 'completed';
          break;
        case 'response.incomplete':
          final = (event.response as Item | undefined) ?? null;
          status = 'incomplete';
          break;
        case 'response.failed': {
          const response = event.response as Item | undefined;
          throw streamError(this.kind, response?.error, 'the response failed');
        }
        case 'error':
          throw streamError(this.kind, (event.error as Item | undefined) ?? event, 'the stream reported an error');
        default:
          break;
      }
    }

    if (status === null) {
      throw new ProviderError('protocol', `${LABEL[this.kind]} closed the stream before the reply finished.`);
    }
    if (typeof final?.model === 'string') model = final.model;
    const output = Array.isArray(final?.output) && (final?.output as Item[]).length > 0
      ? (final?.output as Item[])
      : [...done.entries()].sort((a, b) => a[0] - b[0]).map(entry => entry[1]);

    const toolCalls: ModelToolCall[] = [];
    const replay: Item[] = [];
    for (const item of output) {
      switch (item.type) {
        case 'reasoning':
          if (typeof item.encrypted_content === 'string' && !this.dropped.has('reasoning-replay')) {
            replay.push({ type: 'reasoning', summary: Array.isArray(item.summary) ? item.summary : [], encrypted_content: item.encrypted_content });
          }
          break;
        case 'message': {
          const said = textOf(item);
          if (said) replay.push({ role: 'assistant', content: said });
          break;
        }
        case 'function_call': {
          if (item.status === 'incomplete') break;
          const callId = typeof item.call_id === 'string' ? item.call_id : `call_${toolCalls.length}`;
          const name = localToolName(typeof item.name === 'string' ? item.name : '');
          const parsed = parseToolArguments(item.arguments);
          toolCalls.push({ id: callId, name, args: parsed.args, argsError: parsed.error });
          replay.push({
            type: 'function_call',
            call_id: callId,
            name: typeof item.name === 'string' ? item.name : name,
            arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
            ...(typeof item.namespace === 'string' ? { namespace: item.namespace } : {}),
          });
          break;
        }
        default:
          break;
      }
    }
    if (!text) {
      // Some proxies send only the final response; surface its text as one delta.
      text = output.filter(item => item.type === 'message').map(textOf).join('');
      if (text) options.onText(text);
    }
    this.input.push(...replay);

    let finish: FinishReason = toolCalls.length > 0 ? 'tool_calls' : 'stop';
    if (status === 'incomplete') {
      const reason = ((final?.incomplete_details as Item | undefined)?.reason as string | undefined) ?? '';
      finish = reason === 'content_filter' ? 'filtered' : 'length';
    }
    return { text, toolCalls, finish, model };
  }

  addToolResults(results: ToolResultForModel[]): void {
    for (const result of results) {
      const output = toolOutputText(result);
      if (result.images.length > 0 && !this.dropped.has('images')) {
        this.input.push({
          type: 'function_call_output',
          call_id: result.callId,
          output: [
            { type: 'input_text', text: output },
            ...result.images.map(image => ({ type: 'input_image', image_url: image.dataUrl, detail: 'auto' })),
          ],
        });
      } else {
        this.input.push({ type: 'function_call_output', call_id: result.callId, output });
      }
    }
  }
}

function stripImages(item: Item): Item {
  if (Array.isArray(item.content)) {
    const content = (item.content as Item[]).filter(part => part.type !== 'input_image');
    return { ...item, content: content.length > 0 ? content : [{ type: 'input_text', text: '(image removed)' }] };
  }
  if (item.type === 'function_call_output' && Array.isArray(item.output)) {
    const textPart = (item.output as Item[]).find(part => part.type === 'input_text');
    return { ...item, output: typeof textPart?.text === 'string' ? textPart.text : '{}' };
  }
  return item;
}

// ── ChatGPT account and catalog (desktop host) ───────────────────────────────────

interface ChatGptModel {
  slug: string;
  displayName?: string;
  display_name?: string;
}

let accountCache: { at: number; account: ChatGptAccount } | null = null;
let modelCache: { at: number; models: ModelOption[] } | null = null;

async function chatgptAccount(fresh = false): Promise<ChatGptAccount> {
  if (!fresh && accountCache && Date.now() - accountCache.at < 30_000) return accountCache.account;
  const account = await invokeNative<ChatGptAccount>('chatgpt_account');
  accountCache = { at: Date.now(), account };
  return account;
}

async function chatgptModels(fresh = false): Promise<ModelOption[]> {
  if (!fresh && modelCache && Date.now() - modelCache.at < 300_000) return modelCache.models;
  const raw = await invokeNative<ChatGptModel[]>('chatgpt_models');
  const models = (Array.isArray(raw) ? raw : [])
    .filter(model => model && typeof model.slug === 'string' && model.slug)
    .map(model => ({ id: model.slug, label: model.displayName ?? model.display_name ?? model.slug, vision: true, tools: true }));
  modelCache = { at: Date.now(), models };
  return models;
}

function requireDesktopForChatGpt(): void {
  if (!isDesktopRuntime()) {
    throw new ProviderError('config', 'Sign in with ChatGPT works in the Miss Minutes desktop app. In the browser, use OpenAI with an API key or OpenRouter instead.', { recoverable: false });
  }
}

function hostError(error: unknown, what: string): ProviderError {
  if (error instanceof ProviderError) return error;
  const reason = error instanceof Error ? error.message : String(error);
  return new ProviderError('config', `${what} (${reason}).`, { detail: reason });
}

async function chatgptProfile(settings: AISettings): Promise<ModelProfile> {
  requireDesktopForChatGpt();
  if (Date.now() < chatgptPausedUntil) throw usageLimitError();
  let account: ChatGptAccount;
  try {
    account = await chatgptAccount();
  } catch (error) {
    throw hostError(error, "I couldn't check your ChatGPT sign-in");
  }
  if (!account.signedIn) throw new ProviderError('config', 'Sign in with ChatGPT first (Settings, then Continue with ChatGPT).', { recoverable: false });
  if (!account.planUsage) {
    throw new ProviderError('config', "You're signed in, but ChatGPT plan usage wasn't granted. Sign in again and allow plan usage, or use an API key.", { recoverable: false });
  }
  let model = settings.model.trim();
  if (!model) {
    try {
      model = (await chatgptModels())[0]?.id ?? '';
    } catch (error) {
      throw hostError(error, "I couldn't load the models for your ChatGPT account");
    }
  }
  if (!model) throw new ProviderError('config', 'Your ChatGPT account did not list any models for apps.', { recoverable: false });
  return { model, vision: visionModel(model), tools: true };
}

// ── OpenAI (API key) model list ───────────────────────────────────────────────────

const PREFERRED_OPENAI = ['gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra'];

async function openaiModelIds(settings: AISettings): Promise<string[]> {
  const key = await requireCredential('openai', settings, 'OpenAI');
  const stream = await openHttpStream({
    provider: 'openai',
    url: MODELS_URL,
    method: 'GET',
    headers: { Accept: 'application/json' },
    secretHeaders: key ? { Authorization: `Bearer ${key}` } : undefined,
    label: 'OpenAI',
    idleTimeoutMs: 20_000,
  });
  const body = await stream.text(2_000_000);
  if (!stream.ok) throw httpError('OpenAI', stream.status, body, { requestId: stream.headers['x-request-id'] });
  const data = (JSON.parse(body) as { data?: Array<{ id?: unknown }> }).data ?? [];
  return data.map(model => (typeof model.id === 'string' ? model.id : '')).filter(Boolean);
}

function isChatModel(id: string): boolean {
  if (!/^(gpt-|o[1-9]|chatgpt-)/i.test(id)) return false;
  return !/(audio|realtime|transcribe|tts|image|embedding|moderation|search|instruct|computer-use|-\d{4}-\d{2}-\d{2}$)/i.test(id);
}

function sortModels(ids: string[], current: string): string[] {
  const rank = (id: string) => {
    const preferred = PREFERRED_OPENAI.indexOf(id);
    if (preferred !== -1) return preferred;
    if (id === current) return PREFERRED_OPENAI.length;
    return PREFERRED_OPENAI.length + 1;
  };
  return [...new Set(ids)].sort((a, b) => rank(a) - rank(b) || b.localeCompare(a));
}

// ── Adapters ───────────────────────────────────────────────────────────────────

export const openaiAdapter: ProviderAdapter = {
  id: 'openai',
  label: 'OpenAI',
  async profile(settings, purpose) {
    await requireCredential('openai', settings, 'OpenAI');
    const model = purpose === 'utility' ? UTILITY_MODEL : settings.model.trim() || defaultModelFor('openai');
    return { model, vision: visionModel(model), tools: true };
  },
  session: init => new ResponsesSession('openai', init),
  async listModels(settings) {
    const ids = (await openaiModelIds(settings)).filter(isChatModel);
    const current = settings.provider === 'openai' ? settings.model.trim() : '';
    return sortModels(current ? [...ids, current] : ids, current).map(id => ({ id, label: id, vision: visionModel(id), tools: true }));
  },
  async testConnection(settings) {
    const ids = await openaiModelIds(settings);
    const model = settings.model.trim() || defaultModelFor('openai');
    const has = ids.includes(model);
    return {
      ok: has,
      message: has
        ? `Connected to OpenAI. ${model} is available (${ids.length} models on this key).`
        : `Connected to OpenAI, but this key can't use "${model}". Pick one of the ${ids.filter(isChatModel).length} chat models listed.`,
    };
  },
};

export const chatgptAdapter: ProviderAdapter = {
  id: 'chatgpt',
  label: 'ChatGPT',
  profile: settings => chatgptProfile(settings),
  session: init => new ResponsesSession('chatgpt', init),
  async listModels() {
    requireDesktopForChatGpt();
    return chatgptModels(true);
  },
  async testConnection(settings) {
    requireDesktopForChatGpt();
    let account: ChatGptAccount;
    try {
      account = await chatgptAccount(true);
    } catch (error) {
      throw hostError(error, "I couldn't check your ChatGPT sign-in");
    }
    if (!account.signedIn) return { ok: false, message: 'Not signed in with ChatGPT yet.' };
    if (!account.planUsage) return { ok: false, message: `Signed in${account.email ? ` as ${account.email}` : ''}, but ChatGPT plan usage was not granted. Sign in again and allow it.` };
    const models = await chatgptModels(true);
    const model = settings.model.trim() || models[0]?.id || '';
    const listed = models.some(option => option.id === model);
    return {
      ok: models.length > 0 && listed,
      message: models.length === 0
        ? 'Signed in, but your ChatGPT account did not list any models for apps.'
        : listed
          ? `Signed in${account.email ? ` as ${account.email}` : ''}. ChatGPT plan usage is on; ${model} is available. Usage: ${CHATGPT_USAGE_URL}`
          : `Signed in, but "${model}" isn't in your account's catalog. Pick one of: ${models.slice(0, 5).map(option => option.id).join(', ')}.`,
    };
  },
};

/** Clears cached ChatGPT account and catalog (call after sign-in or sign-out). */
export function resetChatGptCache(): void {
  accountCache = null;
  modelCache = null;
  chatgptPausedUntil = 0;
}

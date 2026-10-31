/**
 * Gemini generateContent, streamed (`streamGenerateContent?alt=sse`), key in the
 * x-goog-api-key header (never in the URL). Gemini 3+ requires the model's parts, with their
 * thought signatures, to be sent back exactly as received during function calling, so the
 * session keeps the streamed parts and replays them.
 */
import type { AISettings } from '../../../types';
import { isDesktopRuntime } from '../../../desktop/bridge';
import { defaultModelFor } from '../../settings';
import type { ModelOption } from '../types';
import { ProviderError, httpError } from '../errors';
import { openHttpStream, readMessages } from '../transport';
import { parseDataUrl, type ConvMessage, type ModelToolCall, type ToolResultForModel } from '../conversation';
import { requireCredential, webKey } from './auth';
import { geminiSchema } from './schema';
import type { FinishReason, ProviderAdapter, ProviderSession, RoundOptions, RoundResult, SessionInit } from './types';

type Item = Record<string, unknown>;

const API = 'https://generativelanguage.googleapis.com/v1beta';
const UTILITY_MODEL = 'gemini-3.5-flash-lite';

function modelId(model: string): string {
  return model.trim().replace(/^models\//, '');
}

/** Gemini 3 and later: thinking levels, thought signatures, multimodal function responses. */
function isGemini3Plus(model: string): boolean {
  const match = /gemini-(\d+)/i.exec(model);
  return !!match && Number(match[1]) >= 3;
}

function headers(settings: AISettings): { headers: Record<string, string>; secret?: Record<string, string> } {
  const base = { 'Content-Type': 'application/json' };
  if (isDesktopRuntime()) return { headers: base };
  const key = webKey('gemini', settings);
  return { headers: base, secret: key ? { 'x-goog-api-key': key } : undefined };
}

function inlineImage(dataUrl: string, displayName?: string): Item | null {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return null;
  return { inlineData: { mimeType: parsed.mime, data: parsed.base64, ...(displayName ? { displayName } : {}) } };
}

function conversationContents(conversation: ConvMessage[]): Item[] {
  return conversation.map(message => {
    if (message.role === 'assistant') return { role: 'model', parts: [{ text: message.text }] };
    const parts: Item[] = [];
    for (const image of message.images) {
      const part = inlineImage(image.dataUrl);
      if (part) parts.push(part);
    }
    parts.push({ text: message.text });
    return { role: 'user', parts };
  });
}

function mapFinish(reason: string | undefined, hasCalls: boolean): FinishReason {
  if (hasCalls) return 'tool_calls';
  if (reason === 'MAX_TOKENS') return 'length';
  if (reason && /SAFETY|RECITATION|BLOCKLIST|PROHIBITED|SPII|IMAGE_SAFETY/.test(reason)) return 'filtered';
  return 'stop';
}

function streamError(error: unknown): ProviderError {
  const e = (error && typeof error === 'object' ? error : {}) as Item;
  const status = typeof e.code === 'number' ? e.code : 500;
  return httpError('Gemini', status, JSON.stringify({ error: e }));
}

/** Appends a streamed part, merging plain text pieces so replay stays compact. */
function appendPart(parts: Item[], part: Item): void {
  const last = parts[parts.length - 1];
  const isPlainText = (p: Item | undefined) => !!p && typeof p.text === 'string' && !p.thought && !p.functionCall;
  if (isPlainText(part) && isPlainText(last) && !last.thoughtSignature) {
    last.text = `${last.text as string}${part.text as string}`;
    if (part.thoughtSignature) last.thoughtSignature = part.thoughtSignature;
    return;
  }
  if (isPlainText(part) && part.text === '' && part.thoughtSignature && last && !last.thoughtSignature && !last.functionCall) {
    // A signature-only part at the end of a text reply belongs to the text before it.
    last.thoughtSignature = part.thoughtSignature;
    return;
  }
  parts.push({ ...part });
}

class GeminiSession implements ProviderSession {
  private readonly init: SessionInit;
  private readonly contents: Item[];
  private callCounter = 0;

  constructor(init: SessionInit) {
    this.init = init;
    this.contents = conversationContents(init.conversation);
  }

  private body(toolChoice: 'auto' | 'none'): Item {
    const { profile, instructions, tools, purpose, json } = this.init;
    const system = instructions.dynamic ? `${instructions.stable}\n\n${instructions.dynamic}` : instructions.stable;
    const generationConfig: Item = { maxOutputTokens: this.init.maxOutputTokens ?? (purpose === 'chat' ? 8192 : 1024) };
    if (isGemini3Plus(profile.model) && purpose === 'chat' && !/flash-lite/i.test(profile.model)) {
      generationConfig.thinkingConfig = { thinkingLevel: 'low' };
    }
    // JSON mode; the prompt carries the exact shape, which every Gemini version accepts.
    if (json) generationConfig.responseMimeType = 'application/json';
    const body: Item = {
      systemInstruction: { parts: [{ text: system }] },
      contents: this.contents,
      generationConfig,
    };
    if (tools.length > 0) {
      body.tools = [{
        functionDeclarations: tools.map(tool => {
          const hasParams = Object.keys(tool.parameters.properties ?? {}).length > 0;
          // Gemini rejects OBJECT schemas without properties, so parameterless tools omit them.
          return { name: tool.name, description: tool.description, ...(hasParams ? { parameters: geminiSchema(tool.parameters) } : {}) };
        }),
      }];
      body.toolConfig = { functionCallingConfig: { mode: toolChoice === 'none' ? 'NONE' : 'AUTO' } };
    }
    return body;
  }

  async round(options: RoundOptions): Promise<RoundResult> {
    const { settings, profile } = this.init;
    const { headers: plain, secret } = headers(settings);
    const stream = await openHttpStream({
      provider: 'gemini',
      url: `${API}/models/${encodeURIComponent(modelId(profile.model))}:streamGenerateContent?alt=sse`,
      method: 'POST',
      headers: { ...plain, Accept: 'text/event-stream' },
      secretHeaders: secret,
      body: JSON.stringify(this.body(options.toolChoice)),
      signal: options.signal,
      label: 'Gemini',
    });
    if (!stream.ok) {
      const body = await stream.text(65_536).catch(() => '');
      throw httpError('Gemini', stream.status, body, { model: profile.model });
    }

    const parts: Item[] = [];
    let text = '';
    let model = profile.model;
    let finishReason: string | undefined;
    let sawCandidate = false;

    for await (const message of readMessages(stream)) {
      let chunk: Item;
      try {
        chunk = JSON.parse(message.data) as Item;
      } catch {
        continue;
      }
      // Plain-JSON fallback: a server that ignored alt=sse returns an array of chunks.
      const chunks = Array.isArray(chunk) ? (chunk as Item[]) : [chunk];
      for (const piece of chunks) {
        if (piece.error) throw streamError(piece.error);
        if (typeof piece.modelVersion === 'string') model = piece.modelVersion;
        const feedback = piece.promptFeedback as Item | undefined;
        if (typeof feedback?.blockReason === 'string') {
          throw new ProviderError('content_filter', `Gemini blocked this request (${feedback.blockReason}).`, { code: feedback.blockReason });
        }
        const candidate = (Array.isArray(piece.candidates) ? (piece.candidates as Item[]) : [])[0];
        if (!candidate) continue;
        sawCandidate = true;
        const content = candidate.content as Item | undefined;
        for (const part of (Array.isArray(content?.parts) ? (content?.parts as Item[]) : [])) {
          if (!part || typeof part !== 'object') continue;
          if (typeof part.text === 'string' && !part.thought && part.text) {
            text += part.text;
            options.onText(part.text);
          }
          appendPart(parts, part);
        }
        if (typeof candidate.finishReason === 'string') finishReason = candidate.finishReason;
      }
    }
    if (!sawCandidate) throw new ProviderError('protocol', 'Gemini ended the stream without a reply.');
    if (finishReason === 'MALFORMED_FUNCTION_CALL') {
      throw new ProviderError('protocol', 'Gemini produced a malformed tool call. Try asking again.', { code: finishReason });
    }

    const toolCalls: ModelToolCall[] = [];
    for (const part of parts) {
      const call = part.functionCall as Item | undefined;
      if (!call || typeof call.name !== 'string') continue;
      this.callCounter += 1;
      const id = typeof call.id === 'string' && call.id ? call.id : `gemini_call_${this.callCounter}`;
      const args = call.args && typeof call.args === 'object' && !Array.isArray(call.args) ? (call.args as Record<string, unknown>) : {};
      toolCalls.push({ id, name: call.name, args });
    }
    if (parts.length > 0) this.contents.push({ role: 'model', parts });
    return { text, toolCalls, finish: mapFinish(finishReason, toolCalls.length > 0), model };
  }

  addToolResults(results: ToolResultForModel[]): void {
    const nested = isGemini3Plus(this.init.profile.model);
    const parts: Item[] = [];
    const siblings: Item[] = [];
    let imageNumber = 0;
    for (const result of results) {
      const response: Item = { ...result.payload };
      const imageParts: Item[] = [];
      for (const image of result.images) {
        imageNumber += 1;
        const part = inlineImage(image.dataUrl, nested ? `${result.name}-${imageNumber}.${image.mime.includes('png') ? 'png' : 'jpg'}` : undefined);
        if (part) imageParts.push(part);
      }
      const functionResponse: Item = {
        name: result.name,
        response,
        ...(result.callId.startsWith('gemini_call_') ? {} : { id: result.callId }),
      };
      if (imageParts.length > 0 && nested) functionResponse.parts = imageParts;
      else siblings.push(...imageParts);
      parts.push({ functionResponse });
    }
    if (parts.length === 0) return;
    // Models before Gemini 3 can't take images inside a function response; send them alongside.
    if (siblings.length > 0 && this.init.profile.vision) parts.push({ text: `Image${siblings.length === 1 ? '' : 's'} from the tool result:` }, ...siblings);
    this.contents.push({ role: 'user', parts });
  }
}

async function listGeminiModels(settings: AISettings): Promise<ModelOption[]> {
  await requireCredential('gemini', settings, 'Gemini');
  const { headers: plain, secret } = headers(settings);
  const stream = await openHttpStream({
    provider: 'gemini',
    url: `${API}/models?pageSize=1000`,
    method: 'GET',
    headers: { ...plain, Accept: 'application/json' },
    secretHeaders: secret,
    label: 'Gemini',
    idleTimeoutMs: 20_000,
  });
  const body = await stream.text(4_000_000);
  if (!stream.ok) throw httpError('Gemini', stream.status, body);
  const models = (JSON.parse(body) as { models?: Array<{ name?: unknown; displayName?: unknown; supportedGenerationMethods?: unknown }> }).models ?? [];
  return models
    .filter(model => typeof model.name === 'string'
      && Array.isArray(model.supportedGenerationMethods) && model.supportedGenerationMethods.includes('generateContent')
      && /^models\/gemini/i.test(model.name)
      && !/(embedding|tts|image|aqa|live|native-audio|transcribe|robotics|computer-use|translate)/i.test(model.name))
    .map(model => {
      const id = modelId(model.name as string);
      return { id, label: typeof model.displayName === 'string' ? model.displayName : id, vision: true, tools: true };
    })
    .sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
}

export const geminiAdapter: ProviderAdapter = {
  id: 'gemini',
  label: 'Gemini',
  async profile(settings, purpose) {
    await requireCredential('gemini', settings, 'Gemini');
    const model = purpose === 'utility' ? UTILITY_MODEL : modelId(settings.model) || defaultModelFor('gemini');
    return { model, vision: true, tools: !/(tts|image)/i.test(model) };
  },
  session: init => new GeminiSession(init),
  listModels: settings => listGeminiModels(settings),
  async testConnection(settings) {
    const models = await listGeminiModels(settings);
    const model = modelId(settings.model) || defaultModelFor('gemini');
    const listed = models.some(option => option.id === model);
    return {
      ok: listed,
      message: listed
        ? `Connected to Gemini. ${model} is available (${models.length} models).`
        : `Connected to Gemini, but "${model}" isn't available to this key. Try ${models[0]?.id ?? 'another model'}.`,
    };
  },
};

/**
 * Provider-neutral conversation pieces: earlier chat messages turned into model history, tool
 * specs, tool calls the model made, and tool results shaped (and capped) for the model.
 */
import type { Attachment, ChatMessage } from '../../types';
import type { JsonSchema, ToolResult } from '../tools/types';
import { stripCueTags } from './cueParser';

export interface ConvUser {
  role: 'user';
  text: string;
  images: Attachment[];
}

export interface ConvAssistant {
  role: 'assistant';
  text: string;
}

export type ConvMessage = ConvUser | ConvAssistant;

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ModelToolCall {
  /** The provider's call id (unique within the round). */
  id: string;
  name: string;
  args?: Record<string, unknown>;
  /** Why the arguments could not be used, when they could not. */
  argsError?: string;
}

export interface ToolResultForModel {
  callId: string;
  name: string;
  /** Always a JSON object, at most about 4 KB serialized. */
  payload: Record<string, unknown>;
  /** Images for vision models (screenshots, camera frames). */
  images: Attachment[];
  isError: boolean;
}

export function toolOutputText(result: ToolResultForModel): string {
  return JSON.stringify(result.payload);
}

const MAX_HISTORY_MESSAGES = 30;
const MAX_HISTORY_CHARS = 28_000;
const MAX_MESSAGE_CHARS = 6_000;
export const MAX_TOOL_OUTPUT_CHARS = 4_000;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function toolLog(message: ChatMessage): string {
  const calls = message.toolCalls ?? [];
  if (calls.length === 0) return '';
  const lines = calls.slice(0, 8).map(call => {
    const outcome = call.status === 'done' ? (call.summary ?? 'done')
      : call.status === 'denied' ? 'the owner declined'
        : call.status === 'error' ? `failed: ${call.error ?? call.summary ?? 'error'}`
          : call.status;
    return `${call.name}: ${clip(outcome, 200)}`;
  });
  return `\n\n[Actions in this reply: ${lines.join('; ')}]`;
}

/**
 * Earlier messages as model history: newest messages kept within a size budget, system notices
 * dropped, roles merged so they alternate and start with the owner. Earlier images are
 * replaced by a note; only the current message carries image data.
 */
export function historyToConversation(history: ChatMessage[]): ConvMessage[] {
  const picked: ConvMessage[] = [];
  let budget = MAX_HISTORY_CHARS;
  for (let i = history.length - 1; i >= 0 && picked.length < MAX_HISTORY_MESSAGES; i -= 1) {
    const message = history[i];
    if (message.sender === 'system') continue;
    let text: string;
    if (message.sender === 'user') {
      const images = message.attachments?.filter(item => item.kind === 'image').length ?? 0;
      text = clip(message.text.trim(), MAX_MESSAGE_CHARS);
      if (images > 0) text = `${text}${text ? '\n' : ''}[The owner attached ${images} image${images === 1 ? '' : 's'} here.]`;
    } else {
      text = clip(stripCueTags(message.text).text.trim(), MAX_MESSAGE_CHARS) + toolLog(message);
    }
    if (!text.trim()) continue;
    if (text.length > budget) break;
    budget -= text.length;
    picked.push(message.sender === 'user' ? { role: 'user', text, images: [] } : { role: 'assistant', text: text.trim() });
  }
  picked.reverse();
  return normalizeTurns(picked);
}

/** Merges consecutive same-role messages and drops leading assistant messages. */
export function normalizeTurns(messages: ConvMessage[]): ConvMessage[] {
  const out: ConvMessage[] = [];
  for (const message of messages) {
    if (out.length === 0 && message.role === 'assistant') continue;
    const last = out[out.length - 1];
    if (last && last.role === message.role) {
      if (last.role === 'user' && message.role === 'user') {
        out[out.length - 1] = { role: 'user', text: `${last.text}\n\n${message.text}`, images: [...last.images, ...message.images] };
      } else {
        out[out.length - 1] = { role: 'assistant', text: `${last.text}\n\n${message.text}` };
      }
      continue;
    }
    out.push(message);
  }
  return out;
}

/** The full conversation for a turn: history plus the owner's new message. */
export function buildConversation(
  history: ChatMessage[],
  user: { text: string; attachments?: Attachment[] },
  vision: boolean,
): ConvMessage[] {
  const images = (user.attachments ?? []).filter(item => item.kind === 'image' && parseDataUrl(item.dataUrl));
  let text = user.text.trim();
  if (images.length > 0 && !vision) {
    text = `${text}${text ? '\n' : ''}[The owner attached ${images.length} image${images.length === 1 ? '' : 's'}, but the current model can't view images. Say so briefly.]`;
  }
  if (!text) text = images.length > 0 ? 'What do you see in this?' : '(empty message)';
  return normalizeTurns([...historyToConversation(history), { role: 'user', text, images: vision ? images : [] }]);
}

export function parseDataUrl(dataUrl: string): { mime: string; base64: string } | null {
  const match = /^data:([a-z]+\/[a-z0-9.+-]+)?(?:;[a-z0-9=.+-]+)*;base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!match) return null;
  return { mime: (match[1] ?? 'image/png').toLowerCase(), base64: match[2].replace(/\s+/g, '') };
}

/** Accepts arguments as an object or a JSON string; anything else is reported back to the model. */
export function parseToolArguments(raw: unknown): { args?: Record<string, unknown>; error?: string } {
  if (raw === undefined || raw === null || raw === '') return { args: {} };
  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return { error: 'The arguments were not valid JSON. Send a JSON object that matches the tool schema.' };
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { error: 'The arguments must be a JSON object.' };
  }
  return { args: value as Record<string, unknown> };
}

/** Tool result payload for the model: ok, summary and data, cut down to about 4 KB. */
export function payloadFromResult(result: ToolResult): Record<string, unknown> {
  const summary = clip(result.summary ?? '', 400);
  const base: Record<string, unknown> = { ok: result.ok, summary };
  if (result.data === undefined) return base;
  const full = { ...base, data: result.data };
  let serialized: string;
  try {
    serialized = JSON.stringify(full);
  } catch {
    return { ...base, data_note: 'The result data could not be serialized.' };
  }
  if (serialized.length <= MAX_TOOL_OUTPUT_CHARS) return full;
  const dataText = JSON.stringify(result.data);
  const room = Math.max(200, MAX_TOOL_OUTPUT_CHARS - JSON.stringify(base).length - 80);
  return { ...base, data_truncated: `${dataText.slice(0, room)}…`, note: 'Data was cut to fit. Ask for something narrower if you need more.' };
}

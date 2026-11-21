/**
 * Chat titles from the first exchange. Model providers write a short title with a utility
 * call; the offline engine (or any failure) falls back to a cleaned-up version of the owner's
 * first message.
 */
import type { AISettings } from '../../types';
import { getRecord, putRecord } from '../../store/db';
import { stripCueTags } from '../brain/cueParser';
import { completeUtility } from '../brain/utility';

export const DEFAULT_CHAT_TITLE = 'New conversation';
const MAX_TITLE = 60;

const FILLER = /^(?:(?:hey|hi|hello|ok(?:ay)?|so|um+|well|yo)[\s,!.]+)*(?:miss\s+minutes?[\s,!.:]*)?(?:(?:can|could|would|will)\s+you\s+|please\s+|i\s+(?:want|need|would like)\s+(?:you\s+)?to\s+|i'd\s+like\s+(?:you\s+)?to\s+)*/i;

function tidy(title: string): string {
  return stripCueTags(title).text
    .replace(/[*_`#>]+/g, '')
    .replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '')
    .replace(/^title:\s*/i, '')
    .replace(/[.!?:;,\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function capitalizeWords(text: string): string {
  const small = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'at', 'by', 'with']);
  return text
    .split(' ')
    .map((word, i) => (i > 0 && small.has(word.toLowerCase()) ? word.toLowerCase() : word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ');
}

/** A title from the owner's first message alone, e.g. "Set a Timer for 5 Minutes". */
export function fallbackTitle(userText: string): string {
  const firstLine = userText.replace(/\s+/g, ' ').trim().replace(FILLER, '');
  const clause = firstLine.split(/(?<=[.!?])\s|[\n;]/)[0] ?? firstLine;
  const words = clause.replace(/[?!.,;:]+$/g, '').split(' ').filter(Boolean).slice(0, 7);
  const title = tidy(capitalizeWords(words.join(' ')));
  if (!title) return DEFAULT_CHAT_TITLE;
  return title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1).trimEnd()}…` : title;
}

const TITLE_TASK = 'You write titles for chat conversations. Reply with the title only: 2 to 6 words, plain text, no quotes, no emoji, no trailing punctuation.';

export async function generateChatTitle(input: { userText: string; replyText?: string; settings: AISettings; signal?: AbortSignal }): Promise<string> {
  const fallback = fallbackTitle(input.userText);
  if (input.settings.provider === 'tva-offline' || !input.userText.trim()) return fallback;
  try {
    const prompt = `Owner: ${input.userText.slice(0, 1500)}\nAssistant: ${stripCueTags(input.replyText ?? '').text.slice(0, 600)}\n\nTitle:`;
    const raw = await completeUtility(input.settings, TITLE_TASK, prompt, { maxOutputTokens: 40, signal: input.signal });
    const title = tidy(raw.split('\n').find(line => line.trim()) ?? '');
    if (!title || title.length > 80 || title.split(' ').length > 10) return fallback;
    return title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1).trimEnd()}…` : title;
  } catch {
    return fallback;
  }
}

/**
 * Titles a chat that still has the default name. Re-reads the record before writing so a
 * rename the owner made meanwhile is never overwritten. Returns the new title, or null.
 */
export async function autoTitleChat(chatId: string, input: { userText: string; replyText?: string; settings: AISettings; signal?: AbortSignal }): Promise<string | null> {
  const chat = await getRecord('chats', chatId);
  if (!chat || (chat.title.trim() && chat.title !== DEFAULT_CHAT_TITLE)) return null;
  const title = await generateChatTitle(input);
  const latest = await getRecord('chats', chatId);
  if (!latest || (latest.title.trim() && latest.title !== DEFAULT_CHAT_TITLE)) return null;
  await putRecord('chats', { ...latest, title });
  return title;
}

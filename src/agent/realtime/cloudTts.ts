/**
 * Cloud text-to-speech that streams raw 24 kHz 16-bit PCM: OpenAI's speech endpoint and
 * ElevenLabs. PCM (rather than MP3) lets sentences play back to back with no decoder gaps and
 * feeds the same lip-sync analyser as every other engine.
 *
 * Browser: fetch with the key this tab holds in memory (secrets-web).
 * Desktop: the host's provider proxy makes the request and injects the stored key; the
 * renderer only ever sees the audio bytes.
 */
import type { ProviderHttpRequest, ProviderStreamEvent } from '../../desktop/bridge';
import { createNativeChannel, invokeNative, isDesktopRuntime } from '../../desktop/bridge';
import { getWebSecret } from '../secrets-web';
import { base64ToBytes } from './pcmPlayer';

export const CLOUD_SAMPLE_RATE = 24000;

/**
 * OpenAI's speech model that accepts `instructions`. OpenAI has scheduled it (and tts-1) to
 * shut down on 2027-01-06 in favour of gpt-realtime-2.1-mini over the Realtime API.
 */
export const OPENAI_TTS_MODEL = 'gpt-4o-mini-tts';
export const OPENAI_TTS_URL = 'https://api.openai.com/v1/audio/speech';
export const OPENAI_TTS_VOICES = [
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar',
] as const;
export const DEFAULT_OPENAI_VOICE = 'coral';
export const ELEVENLABS_MODEL = 'eleven_flash_v2_5';

/**
 * Delivery for the cloud voice. An original character performance: it describes a style and
 * deliberately names no actor, film or show, so the result is not an imitation of anyone.
 */
export const HOSTESS_VOICE_INSTRUCTIONS = [
  'Voice: an original animated character, a bright and bubbly 1950s cartoon hostess with a warm Southern drawl. '
    + 'Do not imitate any real performer or existing character.',
  'Tone: sunny, sweet and eager to help, with a wink of mischief, like the cheerful host of a vintage educational short.',
  'Delivery: quick comic timing. Bounce through the cheerful lines, take a tiny beat before a punchline or aside, '
    + 'and let words like "sugar", "darlin\'" and "y\'all" stretch with an easy drawl while every word stays clear.',
  'Pacing: brisk and lively in conversation; slow down a little for times, numbers, names and instructions.',
  'Emotion: warm and upbeat. When a line turns serious or stern, drop the sparkle and go calm, low and firm.',
].join('\n');

const ERROR_BODY_LIMIT = 2_000;

export class CloudSpeechError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'CloudSpeechError';
    this.status = status;
  }
}

export interface CloudSpeechRequest {
  engine: 'openai' | 'elevenlabs';
  text: string;
  /** What was said just before; ElevenLabs uses it to keep the intonation continuous. */
  previousText?: string;
  openaiVoice?: string;
  instructions?: string;
  elevenLabsVoiceId?: string;
  /** Browser only: overrides the key held in memory. Never sent to the desktop host. */
  key?: string;
  signal: AbortSignal;
  /** Raw little-endian PCM16 at CLOUD_SAMPLE_RATE, in arrival order. Chunks may split a sample. */
  onAudio(pcm16: Uint8Array): void;
}

interface PreparedRequest {
  provider: ProviderHttpRequest['provider'];
  label: string;
  url: string;
  body: string;
  headers: Record<string, string>;
  /** Browser only. */
  secretHeaders: Record<string, string>;
}

export function isOpenAiVoice(voice: string | undefined): voice is (typeof OPENAI_TTS_VOICES)[number] {
  return !!voice && (OPENAI_TTS_VOICES as readonly string[]).includes(voice);
}

/** Replaces anything that looks like a key or bearer token, so errors can be shown and logged. */
export function redactKeys(text: string): string {
  return text
    .replace(/\b(sk|ek|rk)-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, '[redacted]')
    .replace(/\b(xi|sk)_[A-Za-z0-9]{20,}/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [redacted]');
}

function errorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; detail?: { message?: string } | Array<{ msg?: string }> | string };
    if (typeof parsed.error === 'string') return parsed.error;
    if (parsed.error?.message) return parsed.error.message;
    if (typeof parsed.detail === 'string') return parsed.detail;
    if (Array.isArray(parsed.detail)) return parsed.detail.map(item => item.msg).filter(Boolean).join('; ');
    if (parsed.detail?.message) return parsed.detail.message;
  } catch {
    // not JSON
  }
  return body.trim().slice(0, 200);
}

function failure(label: string, status: number, body: string): CloudSpeechError {
  const detail = redactKeys(errorDetail(body));
  const hint = status === 401 || status === 403
    ? ' Check the key in Settings.'
    : status === 429 ? ' The account is rate limited or out of credit.' : '';
  return new CloudSpeechError(`${label} speech failed (${status})${detail ? `: ${detail}` : ''}.${hint}`, status);
}

function abortError(): DOMException {
  return new DOMException('Speech was stopped.', 'AbortError');
}

function prepare(request: CloudSpeechRequest, desktop: boolean): PreparedRequest {
  if (request.engine === 'openai') {
    const voice = isOpenAiVoice(request.openaiVoice) ? request.openaiVoice : DEFAULT_OPENAI_VOICE;
    const key = desktop ? '' : (request.key?.trim() || getWebSecret('openai'));
    if (!desktop && !key) throw new CloudSpeechError('Add an OpenAI key in Settings to use the OpenAI voice.');
    return {
      provider: 'openai',
      label: 'OpenAI',
      url: OPENAI_TTS_URL,
      body: JSON.stringify({
        model: OPENAI_TTS_MODEL,
        voice,
        input: request.text,
        instructions: request.instructions ?? HOSTESS_VOICE_INSTRUCTIONS,
        response_format: 'pcm',
      }),
      headers: { 'Content-Type': 'application/json' },
      secretHeaders: key ? { Authorization: `Bearer ${key}` } : {},
    };
  }
  const voiceId = request.elevenLabsVoiceId?.trim();
  if (!voiceId) throw new CloudSpeechError('Set an ElevenLabs voice ID in Settings to use the ElevenLabs voice.');
  const key = desktop ? '' : (request.key?.trim() || getWebSecret('elevenlabs'));
  if (!desktop && !key) throw new CloudSpeechError('Add an ElevenLabs key in Settings to use the ElevenLabs voice.');
  return {
    provider: 'elevenlabs',
    label: 'ElevenLabs',
    url: `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=pcm_24000`,
    body: JSON.stringify({
      text: request.text,
      model_id: ELEVENLABS_MODEL,
      voice_settings: { stability: 0.42, similarity_boost: 0.78, style: 0.22, use_speaker_boost: true },
      ...(request.previousText ? { previous_text: request.previousText.slice(-600) } : {}),
    }),
    headers: { 'Content-Type': 'application/json' },
    secretHeaders: key ? { 'xi-api-key': key } : {},
  };
}

/** Streams one request's audio into `onAudio`. Resolves at the end; rejects on failure or abort. */
export async function streamCloudSpeech(request: CloudSpeechRequest): Promise<void> {
  if (request.signal.aborted) throw abortError();
  const desktop = isDesktopRuntime();
  const prepared = prepare(request, desktop);
  return desktop ? streamViaHost(prepared, request) : streamViaFetch(prepared, request);
}

async function streamViaFetch(prepared: PreparedRequest, request: CloudSpeechRequest): Promise<void> {
  let response: Response;
  try {
    response = await fetch(prepared.url, {
      method: 'POST',
      headers: { ...prepared.headers, ...prepared.secretHeaders },
      body: prepared.body,
      signal: request.signal,
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch (error) {
    if (request.signal.aborted) throw abortError();
    throw new CloudSpeechError(`Couldn't reach ${prepared.label} (${redactKeys(error instanceof Error ? error.message : String(error))}).`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw failure(prepared.label, response.status, body.slice(0, ERROR_BODY_LIMIT));
  }
  const reader = response.body?.getReader();
  if (!reader) throw new CloudSpeechError(`${prepared.label} returned no audio.`);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value && value.length > 0) request.onAudio(value);
    }
  } catch (error) {
    if (request.signal.aborted) throw abortError();
    throw new CloudSpeechError(`${prepared.label} audio stream broke off (${redactKeys(error instanceof Error ? error.message : String(error))}).`);
  } finally {
    reader.releaseLock();
  }
}

function newRequestId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** The host proxy: credentials are injected natively and only audio crosses the bridge. */
function streamViaHost(prepared: PreparedRequest, request: CloudSpeechRequest): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const requestId = newRequestId();
    const decoder = new TextDecoder();
    let status = 0;
    let errorBody = '';
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (error?: Error | DOMException) => {
      if (settled) return;
      settled = true;
      if (graceTimer) clearTimeout(graceTimer);
      request.signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const complete = () => {
      if (status >= 400) finish(failure(prepared.label, status, errorBody));
      else if (status === 0) finish(new CloudSpeechError(`${prepared.label} closed the connection without answering.`));
      else finish();
    };
    function onAbort() {
      void invokeNative<void>('provider_http_cancel', { requestId }).catch(() => undefined);
      finish(abortError());
    }
    request.signal.addEventListener('abort', onAbort, { once: true });

    const onEvent = (event: ProviderStreamEvent) => {
      if (settled) return;
      switch (event.event) {
        case 'head':
          status = event.status;
          break;
        case 'bytes': {
          const bytes = base64ToBytes(event.base64);
          if (status >= 400) {
            if (errorBody.length < ERROR_BODY_LIMIT) errorBody += decoder.decode(bytes, { stream: true });
          } else if (bytes.length > 0) {
            request.onAudio(bytes);
          }
          break;
        }
        case 'data':
          if (status >= 400 && errorBody.length < ERROR_BODY_LIMIT) errorBody += event.text;
          break;
        case 'end':
          complete();
          break;
        case 'error':
          finish(new CloudSpeechError(`${prepared.label}: ${redactKeys(event.message || 'the desktop host reported an error')}.`));
          break;
      }
    };

    const nativeRequest: ProviderHttpRequest = {
      provider: prepared.provider,
      url: prepared.url,
      method: 'POST',
      headers: prepared.headers,
      body: prepared.body,
      responseType: 'bytes',
    };
    try {
      const channel = createNativeChannel<ProviderStreamEvent>(onEvent);
      invokeNative<void>('provider_http_stream', { request: nativeRequest, requestId, onEvent: channel }).then(
        // Channel messages travel separately from the command result; let trailing ones land.
        () => { graceTimer = setTimeout(complete, 1_500); },
        (error: unknown) => finish(new CloudSpeechError(`${prepared.label}: ${redactKeys(error instanceof Error ? error.message : String(error))}`)),
      );
    } catch (error) {
      finish(new CloudSpeechError(`${prepared.label}: ${redactKeys(error instanceof Error ? error.message : String(error))}`));
    }
  });
}

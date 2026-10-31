export interface NativeAgentStatus {
  enrolled: boolean;
  running: boolean;
  roots: string[];
  events: number;
  indexedFiles: number;
  decisions: number;
  lastError: string | null;
  approvedNoteRoots: string[];
  pendingActions: number;
  autoCreateNotes: boolean;
  foregroundWindowContextEnabled: boolean;
  foregroundWindowContextSupported: boolean;
  automaticActionsToday: number;
  dailyNoteLimit: number;
}

export interface AgentStreamTicket {
  token: string;
  cursor: number;
  expiresAtUnixMs: number;
}

export interface AgentEventRecord {
  seq: number;
  id: string;
  source: string;
  event_type: string;
  observed_at_unix_ms: number;
  source_timestamp_unix_ms: number | null;
  timestamp_semantics: string;
  resource_path: string | null;
  payload_json: string;
}

export interface OwnerContextRecord {
  id: string;
  title: string;
  content: string;
  enabled: boolean;
  createdAtUnixMs: number;
  updatedAtUnixMs: number;
}

export interface PendingAction {
  id: string;
  throughSeq: number;
  description: string;
  payloadJson: string;
  evidenceEventIdsJson: string;
  status: string;
  createdAtUnixMs: number;
  expiresAtUnixMs: number;
  resultJson: string | null;
}

export interface CreateNotePayload {
  kind: 'create_note';
  root_index: number;
  filename: string;
  content: string;
}

/** State of the private on-device voice engine (`native/voice`). */
export interface NativeVoiceStatus {
  installed: boolean;
  starting: boolean;
  ready: boolean;
  model: string | null;
  /** "builtin" is the model's own neutral voice; anything else is a prepared voice. */
  voice: string | null;
  sampleRate: number | null;
  loadSeconds: number | null;
  lastError: string | null;
  /** When not installed: the next step, phrased for the owner. */
  detail: string | null;
}

/** One sentence of synthesized speech relayed by the host. `pcm16` is base64 mono PCM16. */
export interface NativeVoiceChunk {
  id: string;
  index: number;
  last: boolean;
  text: string;
  sampleRate: number;
  pcm16: string;
}

export interface NativeVoiceEnd {
  id: string;
  event: 'done' | 'cancelled' | 'error';
  message: string | null;
}

// ── AI provider proxy ─────────────────────────────────────────────────────────
// On desktop, provider requests are made by the Rust host so API keys and OAuth
// tokens never enter the WebView. The renderer only receives response bytes.

export interface ProviderHttpRequest {
  /** Which stored credential the host injects. The renderer never sees its value. */
  provider: 'openai' | 'gemini' | 'anthropic' | 'openrouter' | 'chatgpt' | 'ollama' | 'elevenlabs';
  url: string;
  method?: 'GET' | 'POST';
  /** Non-secret headers only. Authorization headers are rejected by the host. */
  headers?: Record<string, string>;
  body?: string;
  /** 'text' (default) streams UTF-8 text events; 'bytes' streams base64 chunks (audio). */
  responseType?: 'text' | 'bytes';
}

/** Events delivered on the Channel passed to `provider_http_stream`. */
export type ProviderStreamEvent =
  | { event: 'head'; status: number; headers: Record<string, string> }
  | { event: 'data'; text: string }
  | { event: 'bytes'; base64: string }
  | { event: 'end' }
  | { event: 'error'; message: string };

export interface ChatGptAccount {
  signedIn: boolean;
  email: string | null;
  /** True only when the granted scopes include ChatGPT plan usage. */
  planUsage: boolean;
  expiresAtUnixMs: number | null;
}

export interface OpenRouterPairing {
  /** URL the owner opens (the host also opens it in the system browser). */
  authorizeUrl: string;
}

// ── Desktop tools ─────────────────────────────────────────────────────────────

export interface DesktopPlanStep {
  /** Exact action, e.g. "Open C:\\Users\\me\\Notes\\todo.md in Notepad". */
  description: string;
}

/** A desktop action awaiting approval. Nothing runs until `desktop_approve`. */
export interface DesktopProposal {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  /** Plain-language preview: exactly what will happen, with full paths. */
  preview: string;
  /** For writes: the exact content that would be written. */
  contentPreview: string | null;
  risk: 'low' | 'medium' | 'high';
  expiresAtUnixMs: number;
}

export interface DesktopActionResult {
  ok: boolean;
  summary: string;
  output?: string;
}

interface TauriCore {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  Channel: new <T>() => { onmessage: (message: T) => void; id: number };
}

interface TauriEventApi {
  listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void>;
}

declare global {
  interface Window {
    __TAURI__?: {
      core?: TauriCore;
      event?: TauriEventApi;
    };
  }
}

export function isDesktopRuntime(): boolean {
  return typeof window !== 'undefined' && typeof window.__TAURI__?.core?.invoke === 'function';
}

export async function invokeNative<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) {
    throw new Error('The native desktop bridge is available only inside the Miss Minutes desktop app.');
  }
  return invoke<T>(command, args);
}

/** Creates a Tauri IPC channel for streamed command responses. */
export function createNativeChannel<T>(onMessage: (message: T) => void) {
  const Channel = window.__TAURI__?.core?.Channel;
  if (!Channel) throw new Error('Streaming IPC channels require the Miss Minutes desktop app.');
  const channel = new Channel<T>();
  channel.onmessage = onMessage;
  return channel;
}

export async function listenNative<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  const events = window.__TAURI__?.event;
  if (!events) return () => undefined;
  return events.listen<T>(event, e => handler(e.payload));
}

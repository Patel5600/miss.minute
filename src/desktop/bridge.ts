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

export interface OwnerContextRecord {\n  id: string;\n  title: string;\n  content: string;\n  enabled: boolean;\n  createdAtUnixMs: number;\n  updatedAtUnixMs: number;\n}\n\nexport interface PendingAction {
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

interface TauriCore {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
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

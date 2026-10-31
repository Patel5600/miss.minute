/**
 * Tool contract shared by the brain (which lets the model call tools), the tool
 * implementations, and the UI (which shows calls and approvals).
 *
 * Policy, set by the owner:
 *   - Timers, notes, reminders, to-dos, clocks, weather, searches and memory run on their own.
 *   - Anything that touches files, runs commands or controls the PC asks first and shows
 *     exactly what will happen. Nothing runs until the owner approves that exact preview.
 *   - "Always ask first" (settings.strictApprovals) makes every tool ask.
 */
import type { AISettings, Attachment } from '../../types';

/** JSON Schema for tool arguments. Root must be `{ type: 'object' }`. */
export interface JsonSchema {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'null';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: Array<string | number>;
  minimum?: number;
  maximum?: number;
  default?: unknown;
  additionalProperties?: boolean;
}

export type ToolPolicy = 'auto' | 'confirm';

export interface ToolContext {
  now: Date;
  settings: AISettings;
  /** True inside the Tauri desktop app. */
  desktop: boolean;
  signal?: AbortSignal;
  chatId?: string;
}

export interface ToolResult {
  ok: boolean;
  /** One short line for the transcript, e.g. "Timer set for 5 minutes (ends 10:42)". */
  summary: string;
  /** Structured result returned to the model. Keep it small (< 4 KB serialized). */
  data?: unknown;
  /** Images to show the owner and (when the model supports it) to the model. */
  attachments?: Attachment[];
}

/** What the owner sees before approving. Produced by `prepare` (authoritative) or `describe`. */
export interface ToolPreview {
  /** Plain language, complete and exact: full paths, exact command text, exact recipient. */
  text: string;
  /** For writes: the full content that will be written. */
  content?: string;
  risk: 'low' | 'medium' | 'high';
  /** Opaque handle from the executor (e.g. a desktop proposal id) passed back to `run`. */
  token?: string;
}

export interface ToolDef<A extends Record<string, unknown> = Record<string, unknown>> {
  /** snake_case, unique, stable. */
  name: string;
  /** Written for the model: when to use it and what it returns. */
  description: string;
  parameters: JsonSchema;
  policy: ToolPolicy | ((args: A) => ToolPolicy);
  /** Short synchronous preview used for the transcript and for 'auto' tools. */
  describe(args: A): string;
  /**
   * Optional authoritative preview, computed before approval (e.g. the desktop host resolves
   * paths and stores the exact action). Called only for 'confirm' tools.
   */
  prepare?(args: A, ctx: ToolContext): Promise<ToolPreview>;
  /** Executes. For 'confirm' tools this runs only after approval, with the prepared preview. */
  run(args: A, ctx: ToolContext, prepared?: ToolPreview): Promise<ToolResult>;
  /** Hide the tool when it cannot work here (e.g. desktop-only tools in the browser). */
  available?(ctx: ToolContext): boolean;
}

/** Narrowing helper so each tool file gets typed args without casts at call sites. */
export function defineTool<A extends Record<string, unknown>>(tool: ToolDef<A>): ToolDef<Record<string, unknown>> {
  return tool as unknown as ToolDef<Record<string, unknown>>;
}

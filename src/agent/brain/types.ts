/**
 * Brain contract: one conversational turn, streamed.
 *
 * The UI calls `runTurn`. The brain builds context (persona, time, memories, schedule),
 * streams the model's reply, executes tools (asking for approval where policy says so),
 * and reports progress through `onEvent`. The UI owns persistence of the visible transcript;
 * the brain owns memory extraction.
 */
import type { AISettings, Attachment, ChatMessage, CharacterCue, Emotion, Gesture, ToolCallRecord } from '../../types';

export type BrainEvent =
  /** Visible reply text as it streams. Never contains the mood/gesture tag. */
  | { type: 'text-delta'; text: string }
  /** Mood and body language for the character, as soon as the model commits to them. */
  | { type: 'cue'; cue: CharacterCue }
  /** A tool call was created or changed state (running, awaiting-approval, done...). */
  | { type: 'tool'; call: ToolCallRecord }
  /** Turn finished. `text` is the complete visible reply. */
  | { type: 'done'; text: string; emotion: Emotion; gesture: Gesture; model: string }
  | { type: 'error'; message: string; recoverable: boolean };

/** Resolves true when the owner approves this exact call (with its preview), false otherwise. */
export type ApprovalHandler = (call: ToolCallRecord) => Promise<boolean>;

export interface TurnInput {
  chatId: string;
  /** Earlier messages in this chat, oldest first. Does not include `user`. */
  history: ChatMessage[];
  user: { text: string; attachments?: Attachment[] };
  settings: AISettings;
  onEvent: (event: BrainEvent) => void;
  requestApproval: ApprovalHandler;
  signal: AbortSignal;
}

export interface ModelOption {
  id: string;
  label: string;
  /** Supports image input. */
  vision?: boolean;
  /** Supports tool/function calling. */
  tools?: boolean;
}

export interface Brain {
  runTurn(input: TurnInput): Promise<void>;
  /** Models available to the current provider/credential. Empty when unknown. */
  listModels(settings: AISettings): Promise<ModelOption[]>;
  /** Cheap connectivity check used by Settings → Test. */
  testConnection(settings: AISettings): Promise<{ ok: boolean; message: string }>;
}

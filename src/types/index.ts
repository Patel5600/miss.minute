export type MouthFrame = 0 | 1 | 2 | 3 | 4;

export type Emotion =
  | 'cheerful'
  | 'talking'
  | 'winking'
  | 'suspicious'
  | 'scary'
  | 'thinking'
  | 'pruning'
  // Expressions taken from the reference art in assets/
  | 'blushing'
  | 'stern'
  | 'surprised'
  | 'sassy'
  | 'worried';

export const EMOTIONS: readonly Emotion[] = [
  'cheerful', 'talking', 'winking', 'suspicious', 'scary', 'thinking', 'pruning',
  'blushing', 'stern', 'surprised', 'sassy', 'worried',
];

/** Body language the character can perform. 'none' returns to idle. */
export type Gesture =
  | 'none'
  | 'wave'      // "HEY Y'ALL!" (images (1).jpg)
  | 'shrug'     // arms out, palms up (transparent cutout)
  | 'point'     // index finger up, "now listen here" (images.jpg)
  | 'hips'      // hands on hips, sassy/stern
  | 'present'   // one arm sweeping out, other hand raised (promo art)
  | 'think'     // hand to chin
  | 'knock'     // taps on the screen glass
  | 'clap';

export const GESTURES: readonly Gesture[] = ['none', 'wave', 'shrug', 'point', 'hips', 'present', 'think', 'knock', 'clap'];

/** What the brain or voice layer asks the character to do alongside speech. */
export interface CharacterCue {
  emotion?: Emotion;
  gesture?: Gesture;
}

export type AIProvider =
  | 'tva-offline'  // built-in: no key, still runs tools
  | 'chatgpt'      // Sign in with ChatGPT (desktop only; tokens stay native)
  | 'openrouter'   // pairing code / OAuth PKCE
  | 'openai'
  | 'gemini'
  | 'anthropic'
  | 'ollama';

export type VoiceEngine = 'system' | 'openai' | 'elevenlabs' | 'local';

export interface AISettings {
  provider: AIProvider;
  /** Web mode only, held in memory. Desktop mode keeps secrets in the OS vault and never fills this. */
  apiKey: string;
  model: string;
  customEndpoint?: string;
  systemPrompt: string;
  voiceEnabled: boolean;
  voicePitch: number;
  voiceRate: number;
  soundEffects: boolean;
  hologramMode: boolean;
  /** Occasional in-character remarks while the app is visible and idle. */
  ambientChatter?: boolean;
  /** Web: let her walk around the page edges. When false she stays docked on the stage. */
  roam?: boolean;
  // Voice engine
  voiceEngine?: VoiceEngine;
  /** OpenAI TTS / Realtime voice name (e.g. "coral"). */
  openaiVoice?: string;
  elevenLabsKey?: string;
  elevenLabsVoiceId?: string;
  useElevenLabs?: boolean;
  /** Desktop only: speak through the private on-device voice engine when it is ready. */
  localVoice?: boolean;
  /** Owner's location for weather / local time, set from the dossier or a tool call. */
  homeCity?: string;
  /** Long-term memory: learn durable facts from conversation. */
  memoryEnabled?: boolean;
  /** Ask before every tool call, including timers, notes and searches. */
  strictApprovals?: boolean;
}

export interface Attachment {
  id: string;
  kind: 'image';
  mime: string;
  /** data: URL (image/jpeg or image/png). Captured only after an explicit click. */
  dataUrl: string;
  source: 'screen' | 'camera' | 'upload';
  width?: number;
  height?: number;
}

export type ToolCallStatus = 'running' | 'awaiting-approval' | 'done' | 'denied' | 'error';

export interface ToolCallRecord {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: ToolCallStatus;
  /** Exact human-readable description of what the tool does with these args. */
  preview?: string;
  /** For writes: the full content that would be written, shown before approval. */
  previewContent?: string;
  risk?: 'low' | 'medium' | 'high';
  summary?: string;
  result?: unknown;
  error?: string;
  attachments?: Attachment[];
}

export interface ChatMessage {
  id: string;
  chatId?: string;
  sender: 'user' | 'miss_minute' | 'system';
  text: string;
  /** Display time, e.g. "09:41". */
  timestamp: string;
  createdAt?: number;
  emotion?: Emotion;
  gesture?: Gesture;
  nexusEventDetected?: boolean;
  audioPlayed?: boolean;
  attachments?: Attachment[];
  toolCalls?: ToolCallRecord[];
  /** True while the reply is still streaming in. */
  streaming?: boolean;
  model?: string;
}

/** @deprecated The timeline now shows the owner's real schedule (src/panels). */
export interface TimelineBranch {
  id: string;
  name: string;
  deviationRate: number; // 0 to 100
  timeString: string;
  status: 'safe' | 'warning' | 'critical' | 'pruned';
  variant: string;
}

/** @deprecated The dossier is now built from long-term memory (src/panels). */
export interface VariantProfile {
  id: string;
  variantId: string;
  alias: string;
  offense: string;
  timelineBranch: string;
  pruneRisk: 'Low' | 'Moderate' | 'Critical';
  capturedTimestamp: string;
}

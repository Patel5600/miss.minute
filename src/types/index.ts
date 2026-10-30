export type Emotion = 
  | 'cheerful' 
  | 'talking' 
  | 'winking' 
  | 'suspicious' 
  | 'scary' 
  | 'thinking' 
  | 'pruning';

export type AIProvider = 'gemini' | 'openai' | 'anthropic' | 'ollama' | 'tva-offline';

export interface AISettings {
  provider: AIProvider;
  apiKey: string;
  model: string;
  customEndpoint?: string;
  systemPrompt: string;
  voiceEnabled: boolean;
  voicePitch: number;
  voiceRate: number;
  soundEffects: boolean;
  hologramMode: boolean;
  // Voice engine
  elevenLabsKey?: string;
  elevenLabsVoiceId?: string;
  useElevenLabs?: boolean;
}

export interface ChatMessage {
  id: string;
  sender: 'user' | 'miss_minute' | 'system';
  text: string;
  timestamp: string;
  emotion?: Emotion;
  nexusEventDetected?: boolean;
  audioPlayed?: boolean;
}

export interface TimelineBranch {
  id: string;
  name: string;
  deviationRate: number; // 0 to 100
  timeString: string;
  status: 'safe' | 'warning' | 'critical' | 'pruned';
  variant: string;
}

export interface VariantProfile {
  id: string;
  variantId: string;
  alias: string;
  offense: string;
  timelineBranch: string;
  pruneRisk: 'Low' | 'Moderate' | 'Critical';
  capturedTimestamp: string;
}

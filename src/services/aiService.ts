/**
 * Compatibility facade for the first-generation UI (App, SettingsModal, VoiceLab). It keeps
 * the old static API working on top of the new brain and settings modules. New code should
 * call `brain.runTurn` (src/agent/brain) and src/agent/settings directly.
 */
import type { AISettings, ChatMessage, Emotion, ToolCallRecord } from '../types';
import { isDesktopRuntime } from '../desktop/bridge';
import { brain, inferEmotion } from '../agent/brain';
import { initializeSettings, isKeyProvider, loadSettings, saveSettings } from '../agent/settings';
import { getWebSecret, setWebSecret } from '../agent/secrets-web';

/** Browser mode: the old UI expects the current provider's key on the settings object. */
function withWebKeys(settings: AISettings): AISettings {
  if (isDesktopRuntime()) return { ...settings, apiKey: '', elevenLabsKey: '' };
  const key = isKeyProvider(settings.provider) ? getWebSecret(settings.provider) : '';
  return { ...settings, apiKey: settings.apiKey || key, elevenLabsKey: settings.elevenLabsKey || getWebSecret('elevenlabs') };
}

/**
 * The old UI has no approval panel, so confirm-first tools ask through the browser's own
 * dialog showing the exact preview. Anything too long to show in full is declined rather
 * than approved unseen.
 */
async function approveWithDialog(call: ToolCallRecord): Promise<boolean> {
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return false;
  const content = call.previewContent ?? '';
  if (content.length > 1500) return false;
  const details = content ? `\n\nContent:\n${content}` : '';
  return window.confirm(`Miss Minutes wants to:\n\n${call.preview ?? call.name}${details}\n\nAllow this?`);
}

export class AIService {
  public static getStoredSettings(): AISettings {
    return withWebKeys(loadSettings());
  }

  /** Persists settings without secrets; in the browser the typed key is kept for this session. */
  public static saveSettings(settings: AISettings): void {
    saveSettings(settings);
    if (isDesktopRuntime()) return;
    const key = settings.apiKey.trim();
    if (key && isKeyProvider(settings.provider)) void setWebSecret(settings.provider, key).catch(() => undefined);
    const eleven = settings.elevenLabsKey?.trim();
    if (eleven) void setWebSecret('elevenlabs', eleven).catch(() => undefined);
  }

  /** Startup: migrates old plaintext keys to the vault and decrypts remembered browser keys. */
  public static async initializeSecureSettings(): Promise<AISettings> {
    return withWebKeys(await initializeSettings());
  }

  public static inferEmotion(text: string): Emotion {
    return inferEmotion(text);
  }

  /** One full turn through the brain, returned as a single reply (never throws for provider errors). */
  public static async generateResponse(
    userText: string,
    history: ChatMessage[],
    settings: AISettings,
  ): Promise<{ text: string; emotion: Emotion; isNexusAlert?: boolean }> {
    let text = '';
    let emotion: Emotion = 'cheerful';
    await brain.runTurn({
      chatId: 'legacy-chat',
      history,
      user: { text: userText },
      settings,
      signal: new AbortController().signal,
      requestApproval: approveWithDialog,
      onEvent: event => {
        if (event.type === 'done') {
          text = event.text;
          emotion = event.emotion;
        }
      },
    });
    const lower = text.toLowerCase();
    return { text, emotion, isNexusAlert: lower.includes('red line') || lower.includes('nexus event') };
  }
}

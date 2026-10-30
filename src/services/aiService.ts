import type { AISettings, ChatMessage, Emotion } from '../types';
import { OFFLINE_LORE_RESPONSES, TVA_SYSTEM_PROMPT } from '../data/tvaLore';
import { invokeNative, isDesktopRuntime } from '../desktop/bridge';

export class AIService {
  public static getStoredSettings(): AISettings {
    const defaultSettings: AISettings = {
      provider: 'tva-offline',
      apiKey: '',
      model: 'gemini-1.5-flash',
      customEndpoint: 'http://localhost:11434/v1',
      systemPrompt: TVA_SYSTEM_PROMPT,
      voiceEnabled: true,
      voicePitch: 1.12,
      voiceRate: 1.0,
      soundEffects: true,
      hologramMode: true,
      ambientChatter: true,
    };

    if (typeof window === 'undefined') return defaultSettings;

    try {
      const stored = localStorage.getItem('miss_minutes_settings');
      if (stored) {
        return { ...defaultSettings, ...JSON.parse(stored) };
      }
    } catch {
      // Fallback
    }

    return defaultSettings;
  }

  public static saveSettings(settings: AISettings) {
    if (typeof window !== 'undefined') {
      localStorage.setItem('miss_minutes_settings', JSON.stringify({ ...settings, apiKey: '', elevenLabsKey: '' }));
    }
  }


  public static async initializeSecureSettings(): Promise<AISettings> {
    const settings = this.getStoredSettings();
    if (isDesktopRuntime()) {
      if (settings.provider !== 'tva-offline' && settings.apiKey.trim()) {
        await invokeNative<void>('credential_set', { provider: settings.provider, secret: settings.apiKey });
      }
      if (settings.elevenLabsKey?.trim()) {
        await invokeNative<void>('credential_set', { provider: 'elevenlabs', secret: settings.elevenLabsKey });
      }
    }
    this.saveSettings(settings);
    if (!isDesktopRuntime()) return settings;
    return this.resolveCredentials({ ...settings, apiKey: '', elevenLabsKey: '' });
  }

  private static async resolveCredentials(settings: AISettings): Promise<AISettings> {
    if (!isDesktopRuntime()) return settings;
    let apiKey = settings.apiKey;
    let elevenLabsKey = settings.elevenLabsKey;
    if (settings.provider !== 'tva-offline' && !apiKey.trim()) {
      apiKey = await invokeNative<string | null>('credential_get', { provider: settings.provider }) ?? '';
    }
    if (settings.useElevenLabs && !elevenLabsKey?.trim()) {
      elevenLabsKey = await invokeNative<string | null>('credential_get', { provider: 'elevenlabs' }) ?? '';
    }
    return { ...settings, apiKey, elevenLabsKey };
  }

  public static inferEmotion(text: string): Emotion {
    const lower = text.toLowerCase();
    if (lower.includes('prune') || lower.includes('reset charge') || lower.includes('vaporize') || lower.includes('disintegrate')) {
      return 'pruning';
    }
    if (lower.includes('he who remains') || lower.includes('citadel') || lower.includes('died') || lower.includes('monster') || lower.includes('creepy') || lower.includes('shadow')) {
      return 'scary';
    }
    if (lower.includes('nexus') || lower.includes('deviant') || lower.includes('suspicious') || lower.includes('red line') || lower.includes('alert') || lower.includes('danger')) {
      return 'suspicious';
    }
    if (lower.includes('wink') || lower.includes('secret') || lower.includes('sassy') || lower.includes('darlin') || lower.includes('mischief')) {
      return 'winking';
    }
    if (lower.includes('think') || lower.includes('calculat') || lower.includes('searching') || lower.includes('let me see')) {
      return 'thinking';
    }
    return 'cheerful';
  }

  public static async generateResponse(
    userText: string,
    history: ChatMessage[],
    settings: AISettings
  ): Promise<{ text: string; emotion: Emotion; isNexusAlert?: boolean }> {
    const lower = userText.toLowerCase().trim();
    let activeSettings = settings;
    try {
      activeSettings = await this.resolveCredentials(settings);
    } catch (error) {
      console.warn('OS credential vault unavailable; using offline TVA responses:', error);
      return this.generateOfflineResponse(lower, userText);
    }

    // If using Built-in Offline TVA Hologram or no API key is supplied
    if (activeSettings.provider === 'tva-offline' || !activeSettings.apiKey.trim()) {
      return this.generateOfflineResponse(lower, userText);
    }

    try {
      if (activeSettings.provider === 'gemini') {
        return await this.callGemini(userText, history, activeSettings);
      } else if (activeSettings.provider === 'openai' || activeSettings.provider === 'ollama') {
        return await this.callOpenAICompatible(userText, history, activeSettings);
      } else if (activeSettings.provider === 'anthropic') {
        return await this.callAnthropic(userText, history, activeSettings);
      }
    } catch (err: any) {
      console.warn('AI call failed, falling back to offline TVA engine:', err);
      const fallback = this.generateOfflineResponse(lower, userText);
      return {
        text: `⚠️ *[Temporal Transmission Static - API error: ${err?.message || 'Check your API Key'} - switching to offline TVA records]*\n\n${fallback.text}`,
        emotion: 'suspicious',
        isNexusAlert: true,
      };
    }

    return this.generateOfflineResponse(lower, userText);
  }

  private static generateOfflineResponse(lower: string, originalText: string): { text: string; emotion: Emotion; isNexusAlert?: boolean } {
    // 1. Check exact lore triggers
    for (const item of OFFLINE_LORE_RESPONSES) {
      if (item.triggers.some(trigger => lower.includes(trigger))) {
        return {
          text: item.text,
          emotion: item.emotion,
          isNexusAlert: item.isNexusAlert,
        };
      }
    }

    // 2. Interactive variant case file query
    if (lower.includes('case file') || lower.includes('record') || lower.includes('who am i') || lower.includes('my offense')) {
      const variantNumbers = Math.floor(1000 + Math.random() * 9000);
      return {
        text: `Well look here! Your dossier says you are Variant #${variantNumbers}, designation Earth-616-B! Your offense: "Unauthorized temporal deviation and asking too many questions." Current Prune Priority: HIGH! Now behave yourself, sugar!`,
        emotion: 'winking',
      };
    }

    // 3. Dynamic TVA Mascot conversational responses
    const dynamicResponses = [
      `Well bless your heart, darlin'! That's a mighty curious question. But remember, the Time-Keepers already wrote the script for everything you're fixin' to do! Keep on the straight and narrow now, sugar. For all time. Always!`,
      `Hold on just a minute, sugar! My temporal scanners show a slight oscillation in your timeline branch. Let's not make any sudden moves that might draw the attention of the Minutemen, okay?`,
      `You know what? I like your moxie, variant! Just between you and me, workin' the desk at the TVA can get a tad predictable when everyone sticks to their proper flow. What else is on your mind?`,
      `Now don't you get cute with me! The Sacred Timeline didn't build itself, and every second we spend chatterin' is another second a branch could be creepin' toward that red line!`,
      `Tick-tock, darlin'! Time moves fast when you're having fun, but at the TVA, time doesn't exist at all! Ain't that a peach?`
    ];

    const randomPick = dynamicResponses[Math.floor(Math.random() * dynamicResponses.length)];
    const emotion = this.inferEmotion(originalText);

    return {
      text: randomPick,
      emotion: emotion,
    };
  }

  private static async callGemini(
    userText: string,
    history: ChatMessage[],
    settings: AISettings
  ): Promise<{ text: string; emotion: Emotion; isNexusAlert?: boolean }> {
    const model = settings.model || 'gemini-1.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${settings.apiKey}`;

    // Format conversation history for Gemini API
    const contents: any[] = [];

    // Take last 8 messages for context
    const recent = history.slice(-8);
    for (const msg of recent) {
      contents.push({
        role: msg.sender === 'user' ? 'user' : 'model',
        parts: [{ text: msg.text }],
      });
    }

    // Add current user message
    contents.push({
      role: 'user',
      parts: [{ text: userText }],
    });

    const body = {
      contents,
      systemInstruction: {
        parts: [{ text: settings.systemPrompt || TVA_SYSTEM_PROMPT }],
      },
      generationConfig: {
        temperature: 0.85,
        maxOutputTokens: 500,
      },
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData?.error?.message || `Gemini API error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    const replyText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "Well bless my clockwork, my connection scrambled! Try again, sugar!";
    const emotion = this.inferEmotion(replyText);
    const isNexusAlert = replyText.toLowerCase().includes('red line') || replyText.toLowerCase().includes('nexus event');

    return {
      text: replyText,
      emotion,
      isNexusAlert,
    };
  }

  private static async callOpenAICompatible(
    userText: string,
    history: ChatMessage[],
    settings: AISettings
  ): Promise<{ text: string; emotion: Emotion; isNexusAlert?: boolean }> {
    const isOpenAI = settings.provider === 'openai';
    const endpoint = isOpenAI 
      ? 'https://api.openai.com/v1/chat/completions'
      : (settings.customEndpoint ? `${settings.customEndpoint}/chat/completions` : 'http://localhost:11434/v1/chat/completions');

    const model = settings.model || (isOpenAI ? 'gpt-4o-mini' : 'llama3');

    const messages: any[] = [
      { role: 'system', content: settings.systemPrompt || TVA_SYSTEM_PROMPT },
    ];

    const recent = history.slice(-8);
    for (const msg of recent) {
      messages.push({
        role: msg.sender === 'user' ? 'user' : 'assistant',
        content: msg.text,
      });
    }
    messages.push({ role: 'user', content: userText });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (settings.apiKey) {
      headers['Authorization'] = `Bearer ${settings.apiKey}`;
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.85,
        max_tokens: 500,
      }),
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData?.error?.message || `API error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    const replyText = data?.choices?.[0]?.message?.content || "Well hush my mouth, no response came through!";
    const emotion = this.inferEmotion(replyText);
    const isNexusAlert = replyText.toLowerCase().includes('red line') || replyText.toLowerCase().includes('nexus event');

    return {
      text: replyText,
      emotion,
      isNexusAlert,
    };
  }

  private static async callAnthropic(
    userText: string,
    history: ChatMessage[],
    settings: AISettings
  ): Promise<{ text: string; emotion: Emotion; isNexusAlert?: boolean }> {
    const endpoint = 'https://api.anthropic.com/v1/messages';
    const model = settings.model || 'claude-3-5-sonnet-20241022';

    const messages: any[] = [];
    const recent = history.slice(-8);
    for (const msg of recent) {
      messages.push({
        role: msg.sender === 'user' ? 'user' : 'assistant',
        content: msg.text,
      });
    }
    messages.push({ role: 'user', content: userText });

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'dangerously-allow-browser': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: 500,
        system: settings.systemPrompt || TVA_SYSTEM_PROMPT,
        messages,
      }),
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData?.error?.message || `Anthropic API error: ${res.status}`);
    }

    const data = await res.json();
    const replyText = data?.content?.[0]?.text || "Well butter my biscuits, Claude is taking a tea break!";
    const emotion = this.inferEmotion(replyText);

    return {
      text: replyText,
      emotion,
    };
  }
}

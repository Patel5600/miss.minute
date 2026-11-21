import type { AISettings } from '../../types/index.ts';
import { androidRequest as request, isAndroidApp } from '../platform.ts';
import { invokeNative, isDesktopRuntime } from '../../desktop/bridge.ts';

const GUEST_TOOLS = new Set(['calculate', 'get_time', 'web_search', 'get_weather']);

export function scrubSettingsForGuest(settings: AISettings): AISettings {
  return {
    ...settings,
    apiKey: '',
    elevenLabsKey: '',
    systemPrompt: '',
    homeCity: '',
    memoryEnabled: false,
  };
}

export function isGuestToolAllowed(name: string): boolean {
  return GUEST_TOOLS.has(name);
}

/** Check the native session at the action boundary, not only when the chat turn began. */
export async function captureOwnerSessionSnapshot(): Promise<string | null> {
  try {
    if (isAndroidApp()) {
      const state = await request('hello', { role: 'dashboard' });
      return state.ownerAuthenticated === true && typeof state.ownerSessionId === 'string'
        ? state.ownerSessionId : null;
    }
    if (isDesktopRuntime()) {
      const state = await invokeNative<{ authenticated?: boolean; sessionId?: string | null }>('owner_status');
      return state.authenticated === true && typeof state.sessionId === 'string' ? state.sessionId : null;
    }
    return null;
  } catch {
    return null;
  }
}

export async function isOwnerSessionActive(expectedSessionId?: string | null): Promise<boolean> {
  if (expectedSessionId === null) return false;
  try {
    if (isAndroidApp()) {
      const state = await request('hello', { role: 'dashboard' });
      return state.ownerAuthenticated === true
        && (expectedSessionId === undefined || state.ownerSessionId === expectedSessionId);
    }
    if (isDesktopRuntime()) {
      const state = await invokeNative<{ authenticated?: boolean; sessionId?: string | null }>('owner_status');
      return state.authenticated === true
        && (expectedSessionId === undefined || state.sessionId === expectedSessionId);
    }
    // A normal browser cannot prove desktop or Android owner authority.
    return false;
  } catch {
    return false;
  }
}

/** Guest allowlisting is checked separately; owner calls fail closed on bridge or session errors. */
export async function toolPrincipalAuthorized(
  guestMode: boolean,
  checkOwner: () => Promise<boolean>,
  expectedSessionId?: string | null,
): Promise<boolean> {
  if (guestMode) return true;
  if (expectedSessionId === null) return false;
  try {
    return await checkOwner();
  } catch {
    return false;
  }
}

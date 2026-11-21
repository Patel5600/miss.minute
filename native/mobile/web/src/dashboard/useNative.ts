import { useCallback, useEffect, useRef, useState } from 'react';
import { BridgeError, isConnected, onEvent } from '../shared/bridge.ts';
import { getHello } from '../shared/nativeApi.ts';
import type { HelloInfo } from '../shared/nativeApi.ts';

export type NativePhase = 'loading' | 'ready' | 'offline';

export interface NativeState {
  phase: NativePhase;
  info: HelloInfo | null;
  /** Reload the state now, for example right after the owner changed something. */
  refresh: () => Promise<void>;
}

const POLL_MS = 5000;

/**
 * Keeps a screen in step with native: loads the state when the screen opens, again when native says
 * something changed (state.changed, kill.happened), when the page becomes visible, and every few
 * seconds in case Android changed something on its own (a permission toggled in Settings).
 */
export function useNativeState(): NativeState {
  const [phase, setPhase] = useState<NativePhase>(() => (isConnected() ? 'loading' : 'offline'));
  const [info, setInfo] = useState<HelloInfo | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const next = await getHello();
      if (!alive.current) return;
      setInfo(next);
      setPhase('ready');
    } catch (error) {
      if (!alive.current) return;
      // "unavailable" means this page is not running inside the app; anything else is a passing failure.
      if (error instanceof BridgeError && error.code === 'unavailable') setPhase('offline');
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    const offState = onEvent('state.changed', () => void refresh());
    const offKill = onEvent('kill.happened', () => void refresh());
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
      offState();
      offKill();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  return { phase, info, refresh };
}

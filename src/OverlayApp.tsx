import { useEffect, useState } from 'react';
import type { Emotion, MouthFrame } from './types';
import { MissMinutesFloating } from './components/MissMinutesFloating';
import { voiceService } from './services/voiceService';
import { soundEffects } from './utils/audioEffects';
import { invokeNative } from './desktop/bridge';

interface AvatarUtterance {
  text: string;
  emotion: Emotion;
  pitch: number;
  rate: number;
  elevenLabsKey?: string;
  elevenLabsVoiceId?: string;
}

interface TauriEventApi {
  listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void>;
}

declare global {
  interface Window {
    __TAURI__?: {
      event?: TauriEventApi;
    };
  }
}
import './overlay.css';

export function OverlayApp() {
  const [emotion, setEmotion] = useState<Emotion>('cheerful');
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [mouthFrame, setMouthFrame] = useState<MouthFrame>(0);

  useEffect(() => {
    document.documentElement.classList.add('mm-native-overlay');
    document.body.classList.add('mm-native-overlay');
    const stopSpeaking = voiceService.onSpeakingChange(setIsSpeaking);
    const stopVisemes = voiceService.onVisemeChange(setMouthFrame);
    let unlisten: (() => void) | undefined;
    let disposed = false;

    void window.__TAURI__?.event?.listen<AvatarUtterance>('miss-minutes:speak', ({ payload }) => {
      setEmotion(payload.emotion);
      soundEffects.playClockTick(false);
      void voiceService.speak(payload.text, {
        pitch: payload.pitch,
        rate: payload.rate,
        elevenLabsKey: payload.elevenLabsKey,
        elevenLabsVoiceId: payload.elevenLabsVoiceId,
      }).finally(() => setEmotion('cheerful'));
    }).then(stop => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(error => console.error('[Miss Minutes] Avatar event listener failed:', error));

    return () => {
      disposed = true;
      unlisten?.();
      document.documentElement.classList.remove('mm-native-overlay');
      document.body.classList.remove('mm-native-overlay');
      stopSpeaking();
      stopVisemes();
      voiceService.stop();
    };
  }, []);

  const speak = (line: string) => {
    setEmotion('winking');
    soundEffects.playClockTick(false);
    void voiceService.speak(line, { pitch: 1.12, rate: 1.0 }).finally(() => {
      setEmotion('cheerful');
    });
  };

  const updateBounds = (bounds: { x: number; y: number; width: number; height: number }) => {
    void invokeNative<void>('set_avatar_bounds', { bounds }).catch(() => undefined);
  };

  const updateDragging = (dragging: boolean) => {
    void invokeNative<void>('set_avatar_dragging', { dragging }).catch(() => undefined);
  };

  return (
    <div className="mm-native-overlay-root" aria-label="Miss Minutes desktop companion">
      <MissMinutesFloating
        emotion={emotion}
        isSpeaking={isSpeaking}
        mouthFrame={mouthFrame}
        hologramMode
        autonomousChatter={false}
        isBusy={false}
        onAvatarClick={speak}
        onBoundsChange={updateBounds}
        onDraggingChange={updateDragging}
      />
    </div>
  );
}

export default OverlayApp;

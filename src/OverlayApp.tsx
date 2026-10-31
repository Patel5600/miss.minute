import { useEffect, useState } from 'react';
import type { Emotion, Gesture, MouthFrame } from './types';
import { GESTURES } from './types';
import { voiceService } from './services/voiceService';
import { soundEffects } from './utils/audioEffects';
import { invokeNative } from './desktop/bridge';
import { RANDOM_CLICK_QUOTES } from './data/tvaLore';
import { Companion } from './app/Companion';
import './overlay.css';

interface AvatarUtterance {
  text: string;
  emotion: Emotion;
  gesture?: string | null;
  pitch: number;
  rate: number;
  elevenLabsKey?: string;
  elevenLabsVoiceId?: string;
}

function asGesture(value: unknown): Gesture {
  return typeof value === 'string' && (GESTURES as readonly string[]).includes(value) ? (value as Gesture) : 'none';
}

/** The transparent always-on-top desktop window: Miss Minutes living on the owner's screen. */
export function OverlayApp() {
  const [emotion, setEmotion] = useState<Emotion>('cheerful');
  const [gesture, setGesture] = useState<{ g: Gesture; k: number }>({ g: 'wave', k: 1 });
  const [speaking, setSpeaking] = useState(false);
  const [mouth, setMouth] = useState<MouthFrame>(0);
  const [line, setLine] = useState('');

  useEffect(() => {
    document.documentElement.classList.add('mm-native-overlay');
    document.body.classList.add('mm-native-overlay');
    const stopSpeaking = voiceService.onSpeakingChange(value => {
      setSpeaking(value);
      if (!value) {
        setEmotion('cheerful');
        window.setTimeout(() => setLine(''), 1500);
      }
    });
    const stopVisemes = voiceService.onVisemeChange(setMouth);
    // Local-voice audio (on-device engine) arrives from the host as events.
    const detachNativeVoice = voiceService.attachNativeVoice();
    const cue = (e: Emotion, g: unknown, text?: string) => {
      setEmotion(e);
      const gest = asGesture(g);
      if (gest !== 'none') setGesture(previous => ({ g: gest, k: previous.k + 1 }));
      if (text) setLine(text);
      soundEffects.playClockTick(false);
    };

    const stops: Array<() => void> = [];
    let disposed = false;
    const events = window.__TAURI__?.event;
    const listen = <T,>(name: string, handler: (payload: T) => void) => {
      void events?.listen<T>(name, event => handler(event.payload))
        .then(stop => { if (disposed) stop(); else stops.push(stop); })
        .catch((error: unknown) => console.error(`[Miss Minutes] ${name} listener failed:`, error));
    };

    listen<{ id: string; emotion: Emotion; gesture?: string | null }>('miss-minutes:speak-local', payload => cue(payload.emotion, payload.gesture));
    listen<{ id: string; event: string }>('miss-minutes:voice-end', payload => { if (payload.event === 'error') setEmotion('cheerful'); });
    listen<AvatarUtterance>('miss-minutes:speak', payload => {
      cue(payload.emotion, payload.gesture, payload.text);
      void voiceService.speak(payload.text, {
        pitch: payload.pitch,
        rate: payload.rate,
        elevenLabsKey: payload.elevenLabsKey,
        elevenLabsVoiceId: payload.elevenLabsVoiceId,
      });
    });
    listen<{ title: string; body?: string }>('miss-minutes:alarm', payload => cue('surprised', 'wave', payload.title));

    return () => {
      disposed = true;
      stops.forEach(stop => stop());
      document.documentElement.classList.remove('mm-native-overlay');
      document.body.classList.remove('mm-native-overlay');
      stopSpeaking();
      stopVisemes();
      detachNativeVoice();
      voiceService.stop();
    };
  }, []);

  // Clicking her: the host routes the line through the chosen voice engine.
  const poke = () => {
    const quote = RANDOM_CLICK_QUOTES[Math.floor(Math.random() * RANDOM_CLICK_QUOTES.length)];
    setEmotion('winking');
    setGesture(previous => ({ g: 'wave', k: previous.k + 1 }));
    setLine(quote);
    soundEffects.playClockTick(false);
    void invokeNative<void>('avatar_say', { text: quote }).catch(() => {
      void voiceService.speak(quote, { pitch: 1.12, rate: 1.0 });
    });
  };

  return (
    <div className="mm-native-overlay-root" aria-label="Miss Minutes desktop companion">
      <Companion
        emotion={emotion}
        gesture={gesture.g}
        gestureKey={gesture.k}
        speaking={speaking}
        mouth={mouth}
        line={line}
        onPoke={poke}
        onBoundsChange={bounds => void invokeNative<void>('set_avatar_bounds', { bounds }).catch(() => undefined)}
        onDraggingChange={dragging => void invokeNative<void>('set_avatar_dragging', { dragging }).catch(() => undefined)}
      />
    </div>
  );
}

export default OverlayApp;

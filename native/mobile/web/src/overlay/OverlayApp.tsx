import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MissMinutesRig, VIEW_BOX } from '@desktop/character/MissMinutesRig';
import type { MissMinutesRigHandle } from '@desktop/character/MissMinutesRig';
import { onCommand, request } from '../shared/bridge.ts';
import { applyCommand, INITIAL_VIEW, probeCapabilities } from '../shared/rigAdapter.ts';
import type { RigView } from '../shared/rigAdapter.ts';

interface Props {
  /** Caps the animation frame rate (installFrameCap's setFrameCap). 0 pauses. */
  setFps: (fps: number) => void;
}

/** Rendered size of one view-box unit in CSS pixels, from the rig's xMidYMax meet layout. */
function measureScale(): number {
  const w = window.innerWidth > 0 ? window.innerWidth : VIEW_BOX.w;
  const h = window.innerHeight > 0 ? window.innerHeight : VIEW_BOX.h;
  return Math.max(0.1, Math.min(w / VIEW_BOX.w, h / VIEW_BOX.h));
}

export function OverlayApp({ setFps }: Props) {
  const [view, setView] = useState<RigView>(INITIAL_VIEW);
  const [visible, setVisible] = useState(true);
  const handle = useRef<MissMinutesRigHandle | null>(null);
  const scale = useRef(measureScale());

  useLayoutEffect(() => {
    scale.current = measureScale();
  }, []);

  useEffect(() => {
    const onResize = () => { scale.current = measureScale(); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    return onCommand((type, payload) => {
      switch (type) {
        case 'rig.visible':
          setVisible(payload.visible !== false);
          return;
        case 'rig.power': {
          const fps = typeof payload.fps === 'number' && Number.isFinite(payload.fps) ? payload.fps : 30;
          setFps(fps);
          return;
        }
        case 'rig.hop':
          handle.current?.hop();
          return;
        case 'rig.squash': {
          const amount = typeof payload.amount === 'number' ? Math.min(1, Math.max(0, payload.amount)) : 0.3;
          handle.current?.squash(amount);
          return;
        }
        default:
          setView((current) => applyCommand(current, { type, payload }, scale.current));
      }
    });
  }, [setFps]);

  // Tell native what this rig can draw. Rejects quietly when opened outside the app.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      request('hello', {
        role: 'overlay',
        rigScale: scale.current,
        capabilities: probeCapabilities(handle.current),
      }).catch(() => undefined);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  if (!visible) return null;
  return (
    <MissMinutesRig
      ref={handle}
      skin="hologram"
      gaze="none"
      emotion={view.emotion}
      gesture={view.gesture}
      gestureKey={view.gestureKey}
      isSpeaking={view.isSpeaking}
      mouthFrame={view.mouthFrame}
      facing={view.facing}
      locomotion={view.locomotion}
      walkSpeed={view.walkSpeed}
      style={{ width: '100%', height: '100%', display: 'block' }}
    />
  );
}
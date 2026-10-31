/**
 * MissMinutesRig: the animated SVG Miss Minutes.
 *
 * React renders the markup once; RigEngine then drives every attribute from the shared animation
 * loop, so there is no React work per frame. Size it with CSS: the SVG fills its box and keeps
 * its aspect (view box 400 x 400, feet on the bottom fifth).
 *
 * Props
 *   emotion        mood (12 parametric face states), default 'cheerful'
 *   gesture        performs when it changes; use gestureKey to repeat the same one
 *   isSpeaking     enables lip sync from mouthFrame (0-4, voiceService visemes)
 *   skin           'classic' (giphy.gif palette) or 'hologram' (the show's projection)
 *   facing         -1 screen left, 1 screen right, 0 keep the last side (coin-like turn between)
 *   locomotion     'idle' | 'walk' | 'drag' | 'fall'; walkSpeed in rig units per second
 *   gaze           'pointer' follows the cursor, 'none' looks at the viewer
 *   snapshot       renders a fixed moment (QA sheets, thumbnails) instead of animating
 *   onImpact       knock / clap contact point in client pixels
 * Handle (ref): perform, hop, squash, getBounds (view-box units), setAnchor, svg.
 */
import { memo, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, Ref } from 'react';
import type { Emotion, Gesture, MouthFrame } from '../types';
import { RigEngine, type ArmCopyEls, type EyeEls, type Locomotion, type RigBounds, type RigEls, type RigSnapshot } from './rig/engine';
import { EXPRESSIONS } from './rig/expressions';
import { ARM, EYE, eyePathD, GLOVE_LINE, LASH_WIDTH, LEG, LINE, NOSE, PUPIL, R, SHOE_LINE, TICKS, VIEW } from './rig/geometry';
import { HAND_SHAPES, HANDS, type HandShape } from './rig/hands';
import { subscribeTick, wakeTicker } from './rig/ticker';
import { DEG } from './rig/math';
import './character.css';

export type RigSkin = 'classic' | 'hologram';
export type { Locomotion, RigBounds, RigSnapshot };

export interface RigImpact {
  gesture: Gesture;
  clientX: number;
  clientY: number;
}

export interface MissMinutesRigHandle {
  perform(gesture: Gesture): void;
  hop(): void;
  squash(amount: number): void;
  /** Character extent in view-box units (see VIEW_BOX). */
  getBounds(): RigBounds;
  /** Supply the face centre in client px yourself (skips self-measuring; use when you move her). */
  setAnchor(anchor: { x: number; y: number; scale: number } | null): void;
  readonly svg: SVGSVGElement | null;
}

export interface MissMinutesRigProps {
  emotion?: Emotion;
  gesture?: Gesture;
  gestureKey?: string | number;
  isSpeaking?: boolean;
  mouthFrame?: MouthFrame;
  skin?: RigSkin;
  facing?: -1 | 0 | 1;
  locomotion?: Locomotion;
  walkSpeed?: number;
  gaze?: 'pointer' | 'none';
  reducedMotion?: boolean;
  snapshot?: RigSnapshot;
  onImpact?: (impact: RigImpact) => void;
  className?: string;
  style?: CSSProperties;
  title?: string;
  ref?: Ref<MissMinutesRigHandle>;
}

/** The rig's view box (face centre at rest is the origin, ground at y = 180). */
export const VIEW_BOX = VIEW;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true);
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return;
    const update = () => setReduced(mq.matches);
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return reduced;
}

export function MissMinutesRig({
  emotion = 'cheerful',
  gesture = 'none',
  gestureKey,
  isSpeaking = false,
  mouthFrame = 0,
  skin = 'classic',
  facing = 0,
  locomotion = 'idle',
  walkSpeed = 0,
  gaze = 'pointer',
  reducedMotion,
  snapshot,
  onImpact,
  className,
  style,
  title = 'Miss Minutes',
  ref,
}: MissMinutesRigProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const registry = useRef(new Map<string, Element>());
  const binders = useRef(new Map<string, (el: Element | null) => void>());
  const bind = useCallback((key: string) => {
    let fn = binders.current.get(key);
    if (!fn) {
      fn = (el: Element | null) => {
        if (el) registry.current.set(key, el);
        else registry.current.delete(key);
      };
      binders.current.set(key, fn);
    }
    return fn;
  }, []);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const engineRef = useRef<RigEngine | null>(null);
  const manualAnchor = useRef(false);
  const onImpactRef = useRef(onImpact);
  onImpactRef.current = onImpact;
  const prefersReduced = usePrefersReducedMotion();
  const reduced = reducedMotion ?? prefersReduced;

  const inputs = {
    emotion,
    isSpeaking,
    mouthFrame,
    facing,
    locomotion,
    speed: walkSpeed,
    reducedMotion: reduced,
  };
  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;

  // Build the engine once the markup exists.
  useLayoutEffect(() => {
    const els = collectElements(registry.current);
    if (!els) return;
    const engine = new RigEngine(els, inputsRef.current);
    engineRef.current = engine;
    const stopEvents = engine.onEvent(e => {
      const svg = svgRef.current;
      const cb = onImpactRef.current;
      if (!svg || !cb) return;
      const p = viewToClient(svg.getBoundingClientRect(), e.x, e.y);
      cb({ gesture: e.gesture, clientX: p.x, clientY: p.y });
    });
    const stopTick = subscribeTick((_now, dt) => engine.tick(dt));
    return () => {
      stopTick();
      stopEvents();
      engineRef.current = null;
    };
  }, []);

  // Forward prop changes to the engine without re-rendering the SVG.
  useLayoutEffect(() => {
    engineRef.current?.setInputs(inputsRef.current);
    wakeTicker();
  }, [emotion, isSpeaking, mouthFrame, facing, locomotion, walkSpeed, reduced]);

  useLayoutEffect(() => {
    engineRef.current?.setSnapshot(snapshot ?? null);
    wakeTicker();
    // A snapshot is a value; compare by content so inline objects do not thrash.
  }, [snapshot ? JSON.stringify(snapshot) : '']);

  const lastGesture = useRef<{ g: Gesture; k: unknown } | null>(null);
  useEffect(() => {
    const prev = lastGesture.current;
    lastGesture.current = { g: gesture, k: gestureKey };
    if (prev && prev.g === gesture && prev.k === gestureKey) return;
    if (!prev && gesture === 'none') return;
    engineRef.current?.perform(gesture);
    wakeTicker();
  }, [gesture, gestureKey]);

  // Gaze: follow the pointer; measure our own position unless the parent supplies it.
  useEffect(() => {
    if (gaze !== 'pointer' || snapshot) {
      engineRef.current?.setPointer(null);
      return;
    }
    let measuredAt = 0;
    const measure = () => {
      const svg = svgRef.current;
      const engine = engineRef.current;
      if (!svg || !engine || manualAnchor.current) return;
      const rect = svg.getBoundingClientRect();
      const scale = Math.min(rect.width / VIEW.w, rect.height / VIEW.h);
      const c = viewToClient(rect, 0, 0);
      engine.setAnchor({ x: c.x, y: c.y, scale });
    };
    const onMove = (e: PointerEvent) => {
      const now = performance.now();
      if (now - measuredAt > 400) {
        measuredAt = now;
        measure();
      }
      engineRef.current?.setPointer({ x: e.clientX, y: e.clientY });
    };
    const invalidate = () => { measuredAt = 0; };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('resize', invalidate);
    window.addEventListener('scroll', invalidate, { passive: true, capture: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('resize', invalidate);
      window.removeEventListener('scroll', invalidate, { capture: true });
    };
  }, [gaze, snapshot]);

  useImperativeHandle(ref, () => ({
    perform: g => { engineRef.current?.perform(g); wakeTicker(); },
    hop: () => { engineRef.current?.hop(); wakeTicker(); },
    squash: amount => { engineRef.current?.squashImpact(amount); wakeTicker(); },
    getBounds: () => engineRef.current?.getBounds() ?? { x: -110, y: -105, width: 220, height: 290 },
    setAnchor: anchor => {
      manualAnchor.current = anchor !== null;
      engineRef.current?.setAnchor(anchor);
    },
    get svg() { return svgRef.current; },
  }), []);

  const tone = (EXPRESSIONS[emotion]?.tone ?? 0) > 0.5 ? ' mm-tone-red' : '';
  const svgClass = `mm-rig mm-skin-${skin}${tone}${reduced ? ' mm-reduced' : ''}${className ? ` ${className}` : ''}`;

  return (
    <RigMarkup
      uid={uid}
      bind={bind}
      svgRef={svgRef}
      className={svgClass}
      style={style}
      title={title}
    />
  );
}

/** Maps a view-box point to client pixels for an SVG laid out with xMidYMax meet. */
export function viewToClient(rect: DOMRect | { x: number; y: number; width: number; height: number }, vx: number, vy: number) {
  const scale = Math.min(rect.width / VIEW.w, rect.height / VIEW.h);
  const ox = rect.x + (rect.width - VIEW.w * scale) / 2;
  const oy = rect.y + (rect.height - VIEW.h * scale);
  return { x: ox + (vx - VIEW.x) * scale, y: oy + (vy - VIEW.y) * scale, scale };
}

function collectElements(reg: Map<string, Element>): RigEls | null {
  const g = <T extends Element>(k: string) => reg.get(k) as T | undefined;
  const need = <T extends Element>(k: string) => {
    const el = g<T>(k);
    if (!el) throw new Error(`Miss Minutes rig is missing element "${k}"`);
    return el;
  };
  try {
    const eye = (s: 'L' | 'R'): EyeEls => ({
      group: need(`eye${s}`),
      band: need(`band${s}`),
      pupil: need(`pupil${s}`),
      upperLid: need(`upperLid${s}`),
      lowerLid: need(`lowerLid${s}`),
      lashes: need(`lashes${s}`),
    });
    const arm = (s: 'L' | 'R', layer: 'back' | 'front'): ArmCopyEls => {
      const p = `arm${s}${layer}`;
      const shapes: Partial<Record<HandShape, SVGGElement>> = {};
      for (const shape of HAND_SHAPES) shapes[shape] = g<SVGGElement>(`${p}-${shape}`);
      return {
        group: need(p),
        outline: need(`${p}-outline`),
        core: need(`${p}-core`),
        cuff: need(`${p}-cuff`),
        hand: need(`${p}-hand`),
        shapes,
      };
    };
    return {
      shadow: need('shadow'),
      legs: [need('legL'), need('legR')],
      shoes: [need('shoeL'), need('shoeR')],
      body: need('body'),
      rim: need('rim'),
      backCap: need('backCap'),
      face: need('face'),
      eyes: [eye('L'), eye('R')],
      mouth: {
        outline: need('mouthOutline'),
        fill: need('mouthFill'),
        clip: need('mouthClip'),
        teeth: need('teeth'),
        tongue: need('tongue'),
        dimples: need('dimples'),
      },
      cheeks: need('cheeks'),
      arms: [[arm('L', 'back'), arm('L', 'front')], [arm('R', 'back'), arm('R', 'front')]],
    };
  } catch (error) {
    console.error(error);
    return null;
  }
}

interface MarkupProps {
  uid: string;
  bind: (key: string) => (el: Element | null) => void;
  svgRef: React.RefObject<SVGSVGElement | null>;
  className: string;
  style?: CSSProperties;
  title: string;
}

const EYE_D = eyePathD();
const EYE_CLIP_D = eyePathD(EYE.line / 2);

const RigMarkup = memo(function RigMarkup({ uid, bind, svgRef, className, style, title }: MarkupProps) {
  const id = (k: string) => `${uid}-${k}`;
  const url = (k: string) => `url(#${id(k)})`;
  const ticks = useMemo(() => TICKS.map((t, i) => {
    const a = t.angle * DEG;
    const sx = Math.sin(a);
    const cy = -Math.cos(a);
    const r0 = t.r0 + t.width / 2;
    const r1 = t.r1 - t.width / 2;
    return (
      <line
        key={i}
        x1={(sx * r0).toFixed(2)}
        y1={(cy * r0).toFixed(2)}
        x2={(sx * r1).toFixed(2)}
        y2={(cy * r1).toFixed(2)}
        strokeWidth={t.width}
      />
    );
  }), []);

  const eye = (s: 'L' | 'R') => (
    <g ref={bind(`eye${s}`)} transform={`translate(${s === 'L' ? -EYE.x : EYE.x} ${EYE.y})`}>
      <g clipPath={url(`eyeclip${s}`)}>
        <g clipPath={url(`band${s}`)}>
          <path d={EYE_D} className="mm-eye-white" />
          <g ref={bind(`pupil${s}`)} transform={`translate(${PUPIL.restX} ${PUPIL.restY})`}>
            <ellipse rx={PUPIL.rx} ry={PUPIL.ry} className="mm-pupil" />
            <ellipse cx={PUPIL.inner.dx} cy={PUPIL.inner.dy} rx={PUPIL.inner.rx} ry={PUPIL.inner.ry} className="mm-pupil-core" />
            <path
              className="mm-glint"
              d={`M ${(PUPIL.notch[0].x * PUPIL.rx).toFixed(2)} ${(PUPIL.notch[0].y * PUPIL.ry).toFixed(2)} L ${(PUPIL.notch[1].x * PUPIL.rx).toFixed(2)} ${(PUPIL.notch[1].y * PUPIL.ry).toFixed(2)} L ${(PUPIL.notch[2].x * PUPIL.rx).toFixed(2)} ${(PUPIL.notch[2].y * PUPIL.ry).toFixed(2)} Z`}
            />
          </g>
          <path d={EYE_D} className="mm-eye-line" strokeWidth={EYE.line} />
        </g>
      </g>
      <path ref={bind(`lowerLid${s}`)} className="mm-lid" strokeWidth={EYE.line} display="none" />
      <path ref={bind(`upperLid${s}`)} className="mm-lid" strokeWidth={EYE.line} display="none" />
      <path ref={bind(`lashes${s}`)} className="mm-lash" strokeWidth={LASH_WIDTH} />
    </g>
  );

  const hand = (prefix: string) => (
    <g ref={bind(`${prefix}-hand`)}>
      {HAND_SHAPES.map(shape => {
        const art = HANDS[shape];
        return (
          <g key={shape} ref={bind(`${prefix}-${shape}`)} display={shape === 'fist' ? 'inline' : 'none'}>
            <path d={art.palm} className="mm-glove-edge" strokeWidth={GLOVE_LINE * 2} />
            {art.fingers.map((fg, i) => (
              <path key={`o${i}`} d={fg.d} className="mm-glove-edge-stroke" strokeWidth={fg.w + GLOVE_LINE * 2} />
            ))}
            <path d={art.palm} className="mm-glove" />
            {art.fingers.map((fg, i) => (
              <path key={`f${i}`} d={fg.d} className="mm-glove-stroke" strokeWidth={fg.w} />
            ))}
            {art.creases && <path d={art.creases} className="mm-crease" />}
          </g>
        );
      })}
    </g>
  );

  const arm = (s: 'L' | 'R', layer: 'back' | 'front') => {
    const p = `arm${s}${layer}`;
    return (
      <g ref={bind(p)} display={layer === 'back' ? 'inline' : 'none'}>
        <path ref={bind(`${p}-outline`)} className="mm-arm-line" strokeWidth={ARM.core + ARM.line * 2} />
        <path ref={bind(`${p}-core`)} className="mm-arm" strokeWidth={ARM.core} />
        <path ref={bind(`${p}-cuff`)} className="mm-cuff" strokeWidth={ARM.core + 0.2} />
        {hand(p)}
      </g>
    );
  };

  const shoe = (k: 'L' | 'R') => (
    <g ref={bind(`shoe${k}`)}>
      <path className="mm-shoe" strokeWidth={SHOE_LINE} d={SHOE_D} />
      <path className="mm-shoe-detail" d={SHOE_DETAIL_D} />
    </g>
  );

  return (
    <svg
      ref={svgRef}
      className={className}
      style={style}
      viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`}
      preserveAspectRatio="xMidYMax meet"
      role="img"
      aria-label={title}
    >
      <defs>
        <clipPath id={id('eyeclipL')}><path d={EYE_CLIP_D} /></clipPath>
        <clipPath id={id('eyeclipR')}><path d={EYE_CLIP_D} /></clipPath>
        <clipPath id={id('bandL')}><path ref={bind('bandL')} d="M -30 -40 H 30 V 40 H -30 Z" /></clipPath>
        <clipPath id={id('bandR')}><path ref={bind('bandR')} d="M -30 -40 H 30 V 40 H -30 Z" /></clipPath>
        <clipPath id={id('mouth')}><path ref={bind('mouthClip')} /></clipPath>
        <clipPath id={id('disc')}><use href={`#${id('rim')}`} /></clipPath>
        <radialGradient id={id('cheek')}>
          <stop offset="0" className="mm-cheek-stop" stopOpacity="0.85" />
          <stop offset="0.6" className="mm-cheek-stop" stopOpacity="0.5" />
          <stop offset="1" className="mm-cheek-stop" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={id('halo')}>
          <stop offset="0" className="mm-halo-stop" stopOpacity="0.5" />
          <stop offset="0.55" className="mm-halo-stop" stopOpacity="0.16" />
          <stop offset="1" className="mm-halo-stop" stopOpacity="0" />
        </radialGradient>
        <pattern id={id('scan')} width="10" height="3.1" patternUnits="userSpaceOnUse">
          <rect width="10" height="1.15" className="mm-scan-line" />
        </pattern>
      </defs>
      <title>{title}</title>

      <g transform={`translate(0 ${180})`}>
        <ellipse className="mm-halo" cx="0" cy="-180" rx="190" ry="190" fill={url('halo')} />
        <ellipse ref={bind('shadow')} className="mm-shadow" cx="0" cy="0" rx="62" ry="7.5" />
        <path ref={bind('legL')} className="mm-leg" strokeWidth={LEG.width} />
        <path ref={bind('legR')} className="mm-leg" strokeWidth={LEG.width} />
        {shoe('L')}
        {shoe('R')}

        <g ref={bind('body')} transform={`translate(0 -180)`}>
          {arm('L', 'back')}
          {arm('R', 'back')}
          <path ref={bind('rim')} id={id('rim')} className="mm-rim" strokeWidth={LINE} />
          <ellipse ref={bind('backCap')} className="mm-disc" strokeWidth={LINE} cx="0" cy="0" rx={R} ry={R} display="none" />
          <g ref={bind('face')}>
            <circle r={R} className="mm-disc" strokeWidth={LINE} />
            <g className="mm-ticks">{ticks}</g>
            <g ref={bind('cheeks')} opacity="0">
              <ellipse cx={-50} cy={13} rx={14} ry={8.5} fill={url('cheek')} />
              <ellipse cx={50} cy={13} rx={14} ry={8.5} fill={url('cheek')} />
            </g>
            <circle cx={NOSE.x} cy={NOSE.y} r={NOSE.r} className="mm-nose" />
            {eye('L')}
            {eye('R')}
            <g>
              <path ref={bind('mouthFill')} className="mm-mouth" display="none" />
              <g clipPath={url('mouth')}>
                <path ref={bind('teeth')} className="mm-teeth" display="none" />
                <ellipse ref={bind('tongue')} className="mm-tongue" display="none" />
              </g>
              <path ref={bind('mouthOutline')} className="mm-mouth-line" />
              <path ref={bind('dimples')} className="mm-dimple" display="none" />
            </g>
          </g>
          <g className="mm-holo-only" clipPath={url('disc')}>
            <rect x="-140" y="-112" width="280" height="224" fill={url('scan')} className="mm-scan" />
          </g>
          {arm('L', 'front')}
          {arm('R', 'front')}
        </g>
      </g>
    </svg>
  );
});

/** High-top sneaker, side view facing +x; ankle at the origin, sole on y = 25.9. */
const SHOE_D =
  'M -10.6 -1.6 C -12.2 4.2 -12.8 11.8 -12.6 17.6 L -12.6 22.2 C -12.6 24.8 -11.2 25.9 -8.8 25.9 ' +
  'L 16.6 25.9 C 19.8 25.9 21 24.2 21 21.6 C 21 13.8 15.2 8.6 6.6 7.4 C 5.6 4.4 5.2 1.2 4.8 -1.6 ' +
  'C 0.2 -3.2 -6.4 -3.2 -10.6 -1.6 Z';
const SHOE_DETAIL_D =
  'M -12.4 20.6 L 20.8 20.6 ' +
  'M 5.6 6.6 C 1.6 9.4 -0.8 14.2 -0.6 20.2 ' +
  'M -11.6 5.4 C -7 7.2 -2 7.4 3.2 6';

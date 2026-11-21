/**
 * ThoughtBubble: renders an animated thought bubble with an authentic
 * retro black-and-white / amber monochrome CRT ASCII video stream.
 *
 * When Miss Minutes is imagining or thinking, this displays a real-time
 * procedural 3D wireframe (Sacred Timeline torus / TVA clock) rendered
 * into ASCII characters, along with any live thinking tokens from her AI brain.
 * Zero hardcoded loops or static videos — 100% computed live on canvas.
 */
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

interface ThoughtBubbleProps {
  /** 0..1 visibility blend */
  visible: boolean;
  /** Live thought stream or tokens from the AI brain */
  thoughtText?: string;
  /** Optional bullet lines (e.g. tools being planned) */
  lines?: string[];
  className?: string;
  style?: CSSProperties;
}

const ASCII_RAMP = ' .:-=+*#%@';
const COLS = 36;
const ROWS = 16;

export function ThoughtBubble({ visible, thoughtText, lines, className = '', style }: ThoughtBubbleProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);
  const animRef = useRef<number>(0);
  const angleRef = useRef<number>(0);
  const [frameText, setFrameText] = useState<string>('');

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.style.opacity = visible ? '1' : '0';
    el.style.transform = visible ? 'scale(1) translateY(0)' : 'scale(0.6) translateY(24px)';
    el.style.pointerEvents = visible ? 'auto' : 'none';
  }, [visible]);

  // Procedural ASCII 3D wireframe / thought matrix engine
  useEffect(() => {
    if (!visible) {
      if (animRef.current) cancelAnimationFrame(animRef.current);
      return;
    }

    let lastTime = performance.now();
    const buffer: string[] = [];

    const render = (now: number) => {
      const dt = (now - lastTime) / 1000;
      lastTime = now;
      angleRef.current += dt * 1.8;
      const angle = angleRef.current;

      // 3D Torus / Sacred Timeline parametric wireframe projected into ASCII grid
      // Torus parameters: R = 1.0 (major), r = 0.45 (minor)
      const R1 = 1.0;
      const r1 = 0.45;
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      const cosB = Math.cos(angle * 0.7);
      const sinB = Math.sin(angle * 0.7);

      const zBuffer = new Float32Array(COLS * ROWS);
      const charBuffer = new Array<string>(COLS * ROWS).fill(' ');

      // Sweep points along torus surface
      const stepTheta = 0.28;
      const stepPhi = 0.14;
      for (let theta = 0; theta < Math.PI * 2; theta += stepTheta) {
        const costheta = Math.cos(theta);
        const sintheta = Math.sin(theta);

        for (let phi = 0; phi < Math.PI * 2; phi += stepPhi) {
          const cosphi = Math.cos(phi);
          const sinphi = Math.sin(phi);

          // 3D coordinate before rotation
          const circlex = R1 + r1 * costheta;
          const circley = r1 * sintheta;

          // 3D rotation
          const x = circlex * (cosB * cosphi + sinA * sinB * sinphi) - circley * cosA * sinB;
          const y = circlex * (sinB * cosphi - sinA * cosB * sinphi) + circley * cosA * cosB;
          const z = 2.4 + cosA * circlex * sinphi + circley * sinA;
          const ooz = 1 / z;

          // 2D Projection into ASCII screen grid
          const xp = Math.floor(COLS / 2 + 18 * ooz * x);
          const yp = Math.floor(ROWS / 2 - 9 * ooz * y);

          // Luminance / depth shading
          const L = cosphi * costheta * sinB - cosA * costheta * sinphi - sinA * sintheta + cosB * (cosA * sintheta - costheta * sinA * sinphi);
          if (L > 0 && xp >= 0 && xp < COLS && yp >= 0 && yp < ROWS) {
            const idx = xp + yp * COLS;
            if (ooz > zBuffer[idx]) {
              zBuffer[idx] = ooz;
              const luminanceIndex = Math.min(ASCII_RAMP.length - 1, Math.floor(L * 8));
              charBuffer[idx] = ASCII_RAMP[luminanceIndex] ?? '.';
            }
          }
        }
      }

      // Overlay live thoughts or prompt fragments across the middle rows
      const displayMsg = thoughtText ? thoughtText.slice(0, 50) : (lines && lines.length > 0 ? lines[0] : 'IMAGINING TIMELINE');
      if (displayMsg) {
        const textRow = Math.floor(ROWS / 2);
        const startCol = Math.max(1, Math.floor((COLS - displayMsg.length) / 2));
        for (let c = 0; c < displayMsg.length && startCol + c < COLS - 1; c++) {
          const idx = (startCol + c) + textRow * COLS;
          charBuffer[idx] = displayMsg[c];
        }
      }

      // Build text string with newlines
      buffer.length = 0;
      for (let r = 0; r < ROWS; r++) {
        buffer.push(charBuffer.slice(r * COLS, (r + 1) * COLS).join(''));
      }
      setFrameText(buffer.join('\n'));

      animRef.current = requestAnimationFrame(render);
    };

    animRef.current = requestAnimationFrame(render);
    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, [visible, thoughtText, lines]);

  return (
    <div
      ref={containerRef}
      className={`pointer-events-none absolute left-1/2 -translate-x-1/2 z-30 transition-all duration-500 ease-out ${className}`}
      style={{
        bottom: '80%',
        marginBottom: 12,
        opacity: 0,
        filter: 'drop-shadow(0 10px 24px rgba(0,0,0,0.85)) drop-shadow(0 0 12px rgba(255,140,30,0.35))',
        ...style,
      }}
      aria-hidden="true"
    >
      {/* Cartoon Thought Bubble Outline Container */}
      <div className="relative rounded-3xl border-2 border-[#050101] bg-[#0d0905]/95 p-3 text-amber-200 shadow-2xl backdrop-blur-md">
        {/* CRT Scanline and Phosphor Overlay */}
        <div className="pointer-events-none absolute inset-0 rounded-3xl bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.45)_50%)] bg-[size:100%_4px] opacity-75" />

        {/* Header HUD */}
        <div className="mb-1.5 flex items-center justify-between border-b border-amber-500/30 pb-1 font-mono text-[9px] uppercase tracking-widest text-amber-400">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
            TVA // MIND MATRIX
          </span>
          <span className="text-amber-500/60 font-semibold">ASCII 3D</span>
        </div>

        {/* ASCII Video Monitor Viewport */}
        <div className="relative overflow-hidden rounded-xl border border-amber-900/40 bg-black/85 p-2 font-mono shadow-inner">
          <pre
            ref={preRef}
            className="m-0 select-none text-[8.5px] leading-[9.5px] tracking-[1.5px] text-amber-300 [text-shadow:0_0_6px_rgba(255,170,50,0.8)]"
            style={{ fontFamily: '"Courier New", Courier, monospace' }}
          >
            {frameText}
          </pre>
        </div>

        {/* Subtle thinking caption footer */}
        <div className="mt-1 flex items-center justify-between px-1 font-mono text-[9px] text-amber-400/75">
          <span>{thoughtText ? 'Analyzing Temporal Branch...' : 'Projecting Sacred Geometry'}</span>
          <span className="text-[8px] opacity-60">FOR ALL TIME</span>
        </div>
      </div>

      {/* Bubble trailing dots downward toward Miss Minutes' head */}
      <div className="relative -mt-1 flex justify-center gap-2">
        <span className="block h-3.5 w-3.5 rounded-full border-2 border-[#050101] bg-[#0d0905] shadow-lg" />
        <span className="block h-2 w-2 translate-y-3.5 rounded-full border border-[#050101] bg-[#0d0905] shadow-md" />
      </div>
    </div>
  );
}

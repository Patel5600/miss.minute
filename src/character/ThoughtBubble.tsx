/**
 * ThoughtBubble: renders an animated SVG thought bubble above Miss Minutes.
 * Appears when locomotion='think' or emotion='thinking'. No hardcoded text —
 * the content is driven by `content` prop (array of SVG child elements from parent).
 * Falls back to animated clock gears when no content is provided.
 */
import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';

interface ThoughtBubbleProps {
  /** 0..1 visibility blend */
  visible: boolean;
  /** Optional text lines to show inside bubble (from AI state, not hardcoded) */
  lines?: string[];
  className?: string;
  style?: CSSProperties;
}

export function ThoughtBubble({ visible, lines, className = '', style }: ThoughtBubbleProps) {
  const ref = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    svg.style.opacity = visible ? '1' : '0';
    svg.style.transform = visible ? 'scale(1) translateY(0)' : 'scale(0.7) translateY(20px)';
  }, [visible]);

  return (
    <svg
      ref={ref}
      viewBox="0 0 180 130"
      className={`pointer-events-none absolute left-1/2 -translate-x-1/2 w-44 transition-all duration-500 ease-out ${className}`}
      style={{ bottom: '72%', marginBottom: 8, opacity: 0, ...style }}
      aria-hidden="true"
    >
      {/* Bubble trail dots */}
      <circle cx="88" cy="122" r="4" fill="rgba(255,255,255,0.7)" />
      <circle cx="96" cy="115" r="6" fill="rgba(255,255,255,0.8)" />
      <circle cx="108" cy="106" r="8" fill="rgba(255,255,255,0.85)" />

      {/* Main bubble */}
      <ellipse cx="82" cy="58" rx="72" ry="52" fill="rgba(255,255,255,0.92)" stroke="#050101" strokeWidth="2.5" />

      {/* Gear 1 (large) */}
      <g transform="translate(60 55)">
        <GearIcon r={20} teeth={8} color="#ff711c" />
      </g>
      {/* Gear 2 (small, meshing) */}
      <g transform="translate(96 42)">
        <GearIcon r={12} teeth={6} color="#e5621a" />
      </g>

      {/* Optional text lines */}
      {lines && lines.slice(0, 2).map((line, i) => (
        <text
          key={i}
          x="82"
          y={48 + i * 16}
          textAnchor="middle"
          fontSize="10"
          fontFamily="sans-serif"
          fill="#050101"
          opacity="0.85"
        >
          {line.slice(0, 18)}
        </text>
      ))}
    </svg>
  );
}

function GearIcon({ r, teeth, color }: { r: number; teeth: number; color: string }) {
  const toothH = r * 0.35;
  const points: string[] = [];
  for (let i = 0; i < teeth; i++) {
    const a0 = (i / teeth) * Math.PI * 2 - Math.PI / teeth / 2;
    const a1 = (i / teeth) * Math.PI * 2 + Math.PI / teeth / 2;
    const mid = (a0 + a1) / 2;
    const inner = r * 0.68;
    points.push(
      `${(Math.cos(a0) * r).toFixed(1)},${(Math.sin(a0) * r).toFixed(1)}`,
      `${(Math.cos(mid) * (r + toothH)).toFixed(1)},${(Math.sin(mid) * (r + toothH)).toFixed(1)}`,
      `${(Math.cos(a1) * r).toFixed(1)},${(Math.sin(a1) * r).toFixed(1)}`,
      `${(Math.cos(a1) * inner).toFixed(1)},${(Math.sin(a1) * inner).toFixed(1)}`,
    );
  }
  return (
    <>
      <animateTransform
        attributeName="transform"
        type="rotate"
        from="0" to="360" dur={`${3 + r * 0.05}s`} repeatCount="indefinite"
      />
      <polygon points={points.join(' ')} fill={color} stroke="#050101" strokeWidth="1.2" />
      <circle r={r * 0.3} fill="#fff" stroke="#050101" strokeWidth="1" />
    </>
  );
}

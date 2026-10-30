import React, { useState, useEffect, useRef } from 'react';
import type { Emotion } from '../types';
import { soundEffects } from '../utils/audioEffects';
import { RANDOM_CLICK_QUOTES } from '../data/tvaLore';

interface MissMinutesAvatarProps {
  emotion: Emotion;
  isSpeaking: boolean;
  hologramMode: boolean;
  onAvatarClick?: (quote: string) => void;
  scale?: number;
}

export const MissMinutesAvatar: React.FC<MissMinutesAvatarProps> = ({
  emotion,
  isSpeaking,
  hologramMode,
  onAvatarClick,
  scale = 1,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pupilOffset, setPupilOffset] = useState({ x: 0, y: 0 });
  const [isBlinking, setIsBlinking] = useState(false);
  const [mouthFrame, setMouthFrame] = useState(0);
  const [isHovered, setIsHovered] = useState(false);
  const [isClicked, setIsClicked] = useState(false);

  // Mouse tracking for pupil movement
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      const deltaX = e.clientX - centerX;
      const deltaY = e.clientY - centerY;
      const angle = Math.atan2(deltaY, deltaX);
      const distance = Math.min(Math.hypot(deltaX, deltaY) / 30, 7); // max 7px shift

      setPupilOffset({
        x: Math.cos(angle) * distance,
        y: Math.sin(angle) * distance,
      });
    };

    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, []);

  // Natural Blinking Loop
  useEffect(() => {
    let blinkTimeout: ReturnType<typeof setTimeout>;
    const scheduleNextBlink = () => {
      const nextTime = 2500 + Math.random() * 3500;
      blinkTimeout = setTimeout(() => {
        setIsBlinking(true);
        setTimeout(() => {
          setIsBlinking(false);
          scheduleNextBlink();
        }, 180);
      }, nextTime);
    };

    scheduleNextBlink();
    return () => clearTimeout(blinkTimeout);
  }, []);

  // Lip-sync animation loop when speaking
  useEffect(() => {
    if (!isSpeaking) {
      setMouthFrame(0);
      return;
    }

    const interval = setInterval(() => {
      setMouthFrame(prev => (prev + 1) % 4);
    }, 110);

    return () => clearInterval(interval);
  }, [isSpeaking]);

  const handleClick = () => {
    setIsClicked(true);
    setTimeout(() => setIsClicked(false), 300);
    soundEffects.playClockTick(false);
    
    const randomQuote = RANDOM_CLICK_QUOTES[Math.floor(Math.random() * RANDOM_CLICK_QUOTES.length)];
    if (onAvatarClick) {
      onAvatarClick(randomQuote);
    }
  };

  const isScary = emotion === 'scary';
  const isSuspicious = emotion === 'suspicious';
  const isWinking = emotion === 'winking';
  const isPruning = emotion === 'pruning';

  return (
    <div
      ref={containerRef}
      onClick={handleClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className={`relative inline-flex flex-col items-center justify-center cursor-pointer select-none transition-transform duration-200 ${
        isClicked ? 'scale-95' : isHovered ? 'scale-105' : 'scale-100'
      }`}
      style={{ transform: `scale(${scale})` }}
      title="Click Miss Minutes to interact!"
    >
      {/* Hologram Projector Light Cone (when hologram mode is ON) */}
      {hologramMode && (
        <div className="absolute -bottom-10 w-48 h-28 pointer-events-none opacity-40 bg-gradient-to-t from-amber-500/30 via-orange-400/10 to-transparent blur-md clip-cone" />
      )}

      {/* Main SVG Container */}
      <svg
        viewBox="0 0 340 360"
        className={`w-72 h-80 drop-shadow-2xl transition-all duration-300 ${
          hologramMode ? 'filter contrast-125 saturate-150' : ''
        } ${isScary ? 'animate-pulse drop-shadow-[0_0_35px_rgba(239,68,68,0.7)]' : 'drop-shadow-[0_15px_25px_rgba(243,107,33,0.35)]'}`}
      >
        <defs>
          {/* Clock body gradient */}
          <radialGradient id="tvaClockFace" cx="45%" cy="40%" r="55%">
            <stop offset="0%" stopColor={isScary ? '#b91c1c' : '#FF9E2C'} />
            <stop offset="55%" stopColor={isScary ? '#7f1d1d' : '#F36B21'} />
            <stop offset="100%" stopColor={isScary ? '#450a0a' : '#C84B06'} />
          </radialGradient>

          {/* Clock rim gradient */}
          <linearGradient id="tvaRim" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={isScary ? '#ef4444' : '#FFA834'} />
            <stop offset="50%" stopColor={isScary ? '#991b1b' : '#D45308'} />
            <stop offset="100%" stopColor={isScary ? '#450a0a' : '#8A2D00'} />
          </linearGradient>

          {/* Hologram scanline pattern */}
          <pattern id="hologramScanlines" width="100" height="4" patternUnits="userSpaceOnUse">
            <line x1="0" y1="0" x2="100" y2="0" stroke="rgba(255,165,0,0.25)" strokeWidth="1.5" />
          </pattern>

          {/* Glove gradient */}
          <linearGradient id="gloveWhite" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#FFFFFF" />
            <stop offset="100%" stopColor="#E2E8F0" />
          </linearGradient>
        </defs>

        {/* --- LEGS & SHOES --- */}
        <g className="transition-transform duration-300">
          {/* Left Leg */}
          <path
            d="M 130 255 Q 120 290 115 315"
            stroke="#26180E"
            strokeWidth="5"
            strokeLinecap="round"
            fill="none"
          />
          {/* Left Shoe */}
          <path
            d="M 95 316 C 95 306 125 306 130 318 C 132 324 100 326 95 316 Z"
            fill={isScary ? '#450a0a' : '#854D0E'}
            stroke="#26180E"
            strokeWidth="3.5"
          />

          {/* Right Leg */}
          <path
            d="M 210 255 Q 220 290 225 315"
            stroke="#26180E"
            strokeWidth="5"
            strokeLinecap="round"
            fill="none"
          />
          {/* Right Shoe */}
          <path
            d="M 210 318 C 215 306 245 306 245 316 C 240 326 208 324 210 318 Z"
            fill={isScary ? '#450a0a' : '#854D0E'}
            stroke="#26180E"
            strokeWidth="3.5"
          />
        </g>

        {/* --- ARMS & GLOVES --- */}
        <g>
          {/* Left Arm: waves or rests on hip */}
          {isPruning ? (
            // Holding TVA Pruning Baton
            <g className="animate-pulse">
              <path
                d="M 80 180 Q 40 160 45 130"
                stroke="#26180E"
                strokeWidth="5"
                strokeLinecap="round"
                fill="none"
              />
              {/* Hand */}
              <circle cx="45" cy="126" r="14" fill="url(#gloveWhite)" stroke="#26180E" strokeWidth="3" />
              {/* Pruning Baton */}
              <rect x="36" y="80" width="8" height="65" rx="3" fill="#38BDF8" stroke="#0284C7" strokeWidth="2" />
              <circle cx="40" cy="80" r="8" fill="#F43F5E" className="animate-ping" />
            </g>
          ) : (
            // Cute wave / relaxed arm
            <g className="transition-all duration-300">
              <path
                d={isHovered ? "M 80 180 Q 35 150 45 120" : "M 80 180 Q 45 200 40 220"}
                stroke="#26180E"
                strokeWidth="5"
                strokeLinecap="round"
                fill="none"
              />
              {/* Left Glove */}
              <g transform={isHovered ? "translate(42, 115)" : "translate(38, 222)"}>
                <ellipse cx="0" cy="0" rx="13" ry="11" fill="url(#gloveWhite)" stroke="#26180E" strokeWidth="3" />
                <path d="M -5 -8 Q 0 -15 6 -7" fill="none" stroke="#26180E" strokeWidth="2.5" />
                <path d="M -9 2 L -2 2" stroke="#26180E" strokeWidth="2" strokeLinecap="round" />
              </g>
            </g>
          )}

          {/* Right Arm: Sassy hip rest or pointing */}
          <g>
            <path
              d={isSpeaking ? "M 260 180 Q 295 160 300 140" : "M 260 180 Q 295 200 300 220"}
              stroke="#26180E"
              strokeWidth="5"
              strokeLinecap="round"
              fill="none"
            />
            {/* Right Glove */}
            <g transform={isSpeaking ? "translate(302, 136)" : "translate(300, 222)"}>
              <ellipse cx="0" cy="0" rx="13" ry="11" fill="url(#gloveWhite)" stroke="#26180E" strokeWidth="3" />
              <path d="M -3 -8 Q 3 -14 8 -6" fill="none" stroke="#26180E" strokeWidth="2.5" />
            </g>
          </g>
        </g>

        {/* --- MAIN CLOCK BODY --- */}
        <g id="clockBody" className="transition-transform duration-300">
          {/* Outer Ring / Bezel */}
          <circle
            cx="170"
            cy="170"
            r="105"
            fill="url(#tvaRim)"
            stroke="#1E140C"
            strokeWidth="6"
          />

          {/* Inner Clock Face */}
          <circle
            cx="170"
            cy="170"
            r="94"
            fill="url(#tvaClockFace)"
          />

          {/* 12 Hour Ticks */}
          {[0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map((deg) => (
            <line
              key={deg}
              x1="170"
              y1="82"
              x2="170"
              y2={deg % 90 === 0 ? "93" : "88"}
              stroke="#2C1A0E"
              strokeWidth={deg % 90 === 0 ? "4" : "2.5"}
              strokeLinecap="round"
              transform={`rotate(${deg} 170 170)`}
            />
          ))}

          {/* Clock Hands (Acting as subtle facial nose accent) */}
          <g transform="translate(170, 170)">
            {/* Minute Hand (pointing toward 2 o'clock) */}
            <line
              x1="0"
              y1="0"
              x2="28"
              y2="-28"
              stroke="#1C1108"
              strokeWidth="4.5"
              strokeLinecap="round"
            />
            {/* Hour Hand (pointing toward 10 o'clock) */}
            <line
              x1="0"
              y1="0"
              x2="-20"
              y2="-15"
              stroke="#1C1108"
              strokeWidth="5"
              strokeLinecap="round"
            />
            {/* Center Pin / Nose */}
            <circle cx="0" cy="0" r="6" fill="#1C1108" />
            <circle cx="-1.5" cy="-1.5" r="2" fill="#FFA834" />
          </g>

          {/* --- EYES --- */}
          <g id="eyes">
            {/* Left Eye */}
            <g transform="translate(132, 138)">
              {isBlinking ? (
                // Closed eyelid line
                <path
                  d="M -18 0 Q 0 8 18 0"
                  stroke="#1C1108"
                  strokeWidth="4"
                  strokeLinecap="round"
                  fill="none"
                />
              ) : (
                <>
                  {/* Eye Sclera */}
                  <ellipse
                    cx="0"
                    cy="0"
                    rx="19"
                    ry="24"
                    fill="#FFF"
                    stroke="#1C1108"
                    strokeWidth="3.5"
                  />
                  {/* Pupil with Eye-Tracking */}
                  <ellipse
                    cx={pupilOffset.x}
                    cy={pupilOffset.y}
                    rx={isScary ? 7 : 11}
                    ry={isScary ? 7 : 14}
                    fill={isScary ? '#ef4444' : '#1C1108'}
                  />
                  {/* Sparkle Reflection */}
                  <circle
                    cx={pupilOffset.x - 4}
                    cy={pupilOffset.y - 5}
                    r={isScary ? 2 : 4}
                    fill="#FFF"
                  />
                  {/* Lower eyelash accent */}
                  <path
                    d="M -12 20 Q 0 25 12 20"
                    stroke="#1C1108"
                    strokeWidth="2"
                    fill="none"
                  />
                </>
              )}

              {/* Eyebrow */}
              <path
                d={
                  isSuspicious
                    ? "M -18 -26 Q 0 -22 18 -32" // arched eyebrow
                    : isScary
                    ? "M -18 -22 Q 0 -34 18 -24"
                    : "M -18 -28 Q 0 -36 18 -28"
                }
                stroke="#1C1108"
                strokeWidth="4"
                strokeLinecap="round"
                fill="none"
              />
            </g>

            {/* Right Eye */}
            <g transform="translate(208, 138)">
              {isBlinking || isWinking ? (
                // Winking or blinking eye arch
                <path
                  d="M -18 2 Q 0 -8 18 2"
                  stroke="#1C1108"
                  strokeWidth="4.5"
                  strokeLinecap="round"
                  fill="none"
                />
              ) : (
                <>
                  {/* Eye Sclera */}
                  <ellipse
                    cx="0"
                    cy="0"
                    rx="19"
                    ry="24"
                    fill="#FFF"
                    stroke="#1C1108"
                    strokeWidth="3.5"
                  />
                  {/* Pupil with Eye-Tracking */}
                  <ellipse
                    cx={pupilOffset.x}
                    cy={pupilOffset.y}
                    rx={isScary ? 7 : 11}
                    ry={isScary ? 7 : 14}
                    fill={isScary ? '#ef4444' : '#1C1108'}
                  />
                  {/* Sparkle Reflection */}
                  <circle
                    cx={pupilOffset.x - 4}
                    cy={pupilOffset.y - 5}
                    r={isScary ? 2 : 4}
                    fill="#FFF"
                  />
                  {/* Lower eyelash accent */}
                  <path
                    d="M -12 20 Q 0 25 12 20"
                    stroke="#1C1108"
                    strokeWidth="2"
                    fill="none"
                  />
                </>
              )}

              {/* Eyebrow */}
              <path
                d={
                  isSuspicious
                    ? "M -18 -30 Q 0 -24 18 -20" // furrowed brow
                    : isScary
                    ? "M -18 -24 Q 0 -34 18 -22"
                    : "M -18 -28 Q 0 -36 18 -28"
                }
                stroke="#1C1108"
                strokeWidth="4"
                strokeLinecap="round"
                fill="none"
              />
            </g>
          </g>

          {/* --- CHEEKS (Vintage Cartoon Blush) --- */}
          <ellipse
            cx="108"
            cy="178"
            rx="9"
            ry="6"
            fill={isScary ? '#7f1d1d' : '#EF4444'}
            opacity="0.4"
          />
          <ellipse
            cx="232"
            cy="178"
            rx="9"
            ry="6"
            fill={isScary ? '#7f1d1d' : '#EF4444'}
            opacity="0.4"
          />

          {/* --- MOUTH (Lip Sync & Emotions) --- */}
          <g id="mouth">
            {isSpeaking ? (
              // Lip-sync animated mouth cycles
              mouthFrame === 0 ? (
                // Wide open 'A' / 'O'
                <path
                  d="M 144 195 Q 170 232 196 195 Q 170 190 144 195 Z"
                  fill="#7F1D1D"
                  stroke="#1C1108"
                  strokeWidth="3.5"
                />
              ) : mouthFrame === 1 ? (
                // Wide smile / 'E'
                <path
                  d="M 140 192 Q 170 220 200 192 Q 170 208 140 192 Z"
                  fill="#991B1B"
                  stroke="#1C1108"
                  strokeWidth="3.5"
                />
              ) : mouthFrame === 2 ? (
                // Round 'O'
                <ellipse
                  cx="170"
                  cy="204"
                  rx="16"
                  ry="14"
                  fill="#7F1D1D"
                  stroke="#1C1108"
                  strokeWidth="3.5"
                />
              ) : (
                // Cheerful teeth smile
                <g>
                  <path
                    d="M 142 195 Q 170 226 198 195 Z"
                    fill="#991B1B"
                    stroke="#1C1108"
                    strokeWidth="3.5"
                  />
                  <path
                    d="M 146 197 Q 170 205 194 197"
                    stroke="#FFF"
                    strokeWidth="3"
                    fill="none"
                  />
                </g>
              )
            ) : isScary ? (
              // Creepy eerie sharp smirk
              <g>
                <path
                  d="M 134 198 Q 170 236 206 198 Q 170 215 134 198 Z"
                  fill="#450a0a"
                  stroke="#1C1108"
                  strokeWidth="4"
                />
                <path
                  d="M 140 200 L 145 208 L 150 200 L 155 209 L 160 200 L 165 210 L 170 200 L 175 210 L 180 200 L 185 208 L 190 200 L 195 207 L 200 200"
                  stroke="#FFF"
                  strokeWidth="2"
                  fill="none"
                />
              </g>
            ) : isSuspicious ? (
              // Skeptical smirk
              <path
                d="M 146 204 Q 165 200 194 194"
                stroke="#1C1108"
                strokeWidth="4"
                strokeLinecap="round"
                fill="none"
              />
            ) : (
              // Classic wide happy Southern cartoon smile
              <g>
                <path
                  d="M 136 192 C 140 226 200 226 204 192 C 180 196 160 196 136 192 Z"
                  fill="#991B1B"
                  stroke="#1C1108"
                  strokeWidth="3.5"
                />
                {/* Upper Teeth Row */}
                <path
                  d="M 142 195 Q 170 202 198 195"
                  stroke="#FFF"
                  strokeWidth="3.5"
                  strokeLinecap="round"
                  fill="none"
                />
                {/* Tongue */}
                <path
                  d="M 158 214 Q 170 208 182 214 Q 170 224 158 214 Z"
                  fill="#F87171"
                />
                {/* Smile dimples */}
                <path
                  d="M 132 189 Q 134 196 137 197"
                  stroke="#1C1108"
                  strokeWidth="3"
                  strokeLinecap="round"
                  fill="none"
                />
                <path
                  d="M 208 189 Q 206 196 203 197"
                  stroke="#1C1108"
                  strokeWidth="3"
                  strokeLinecap="round"
                  fill="none"
                />
              </g>
            )}
          </g>

          {/* Hologram Scanlines Overlay */}
          {hologramMode && (
            <circle
              cx="170"
              cy="170"
              r="94"
              fill="url(#hologramScanlines)"
              pointerEvents="none"
              opacity="0.6"
            />
          )}
        </g>
      </svg>

      {/* Retro Status Pill */}
      <div className="mt-2 flex items-center gap-2 px-3 py-1 rounded-full bg-amber-950/80 border border-amber-600/40 text-amber-300 text-xs font-mono tracking-wider shadow-inner">
        <span className={`w-2 h-2 rounded-full ${
          isSpeaking 
            ? 'bg-amber-400 animate-ping' 
            : isScary 
            ? 'bg-red-500 animate-pulse' 
            : 'bg-emerald-400'
        }`} />
        <span>
          {isSpeaking ? 'TRANSMITTING VOICE' : emotion.toUpperCase()}
        </span>
      </div>
    </div>
  );
};

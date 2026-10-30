import React from 'react';
import type { AISettings } from '../types';
import { soundEffects } from '../utils/audioEffects';
import { Clock, Settings, Volume2, VolumeX, Sparkles } from 'lucide-react';

interface TvaHeaderProps {
  settings: AISettings;
  onOpenSettings: () => void;
  onToggleSound: () => void;
  soundMuted: boolean;
  onTimeDoorJump: () => void;
}

export const TvaHeader: React.FC<TvaHeaderProps> = ({
  settings,
  onOpenSettings,
  onToggleSound,
  soundMuted,
  onTimeDoorJump,
}) => {
  return (
    <header className="w-full bg-neutral-950/80 border-b border-amber-600/30 backdrop-blur-md px-6 py-3.5 flex flex-wrap items-center justify-between gap-4 font-mono select-none">
      {/* Brand & Logo */}
      <div className="flex items-center gap-3">
        <div className="relative">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center shadow-[0_0_15px_rgba(245,158,11,0.5)]">
            <Clock className="w-6 h-6 text-neutral-950 stroke-[2.5]" />
          </div>
          <span className="absolute -top-1 -right-1 w-3 h-3 bg-emerald-400 rounded-full border-2 border-neutral-950 animate-ping" />
        </div>

        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-black tracking-wider text-amber-400 uppercase drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]">
              MISS MINUTES
            </h1>
            <span className="text-[10px] px-2 py-0.5 rounded bg-amber-950 text-amber-300 border border-amber-600/40 font-bold tracking-widest">
              TVA v2.0
            </span>
          </div>
          <p className="text-[11px] text-amber-400/70 tracking-widest uppercase">
            Time Variance Authority • For all time. Always.
          </p>
        </div>
      </div>

      {/* Control Actions */}
      <div className="flex items-center gap-2.5">
        {/* Time Door Warp Button */}
        <button
          onClick={() => {
            soundEffects.playHologramGlitch();
            onTimeDoorJump();
          }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-orange-950/40 hover:bg-orange-900/60 text-orange-300 border border-orange-500/40 text-xs transition-all hover:scale-105"
          title="Open Glowing Orange TemPad Time Door"
        >
          <Sparkles className="w-3.5 h-3.5 text-orange-400" />
          <span className="hidden sm:inline">TemPad Warp</span>
        </button>

        {/* Audio FX Mute / Unmute */}
        <button
          onClick={onToggleSound}
          className={`p-2 rounded-xl border transition-all ${
            soundMuted
              ? 'bg-neutral-900 border-neutral-700 text-neutral-500'
              : 'bg-amber-950/40 hover:bg-amber-900/60 border-amber-600/40 text-amber-300'
          }`}
          title={soundMuted ? 'Unmute Sound Effects' : 'Mute Sound Effects'}
        >
          {soundMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
        </button>

        {/* Settings / Pair AI Button */}
        <button
          onClick={onOpenSettings}
          className="flex items-center gap-2 px-3.5 py-1.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-neutral-950 font-bold text-xs shadow-lg shadow-amber-500/20 transition-all hover:scale-105"
        >
          <Settings className="w-4 h-4" />
          <span>Pair AI ({settings.provider.toUpperCase()})</span>
          <span className="w-2 h-2 rounded-full bg-neutral-950" />
        </button>
      </div>
    </header>
  );
};

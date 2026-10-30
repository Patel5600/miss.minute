import React, { useState } from 'react';
import type { VariantProfile } from '../types';
import { Shield, Fingerprint, Award, Edit3, Check } from 'lucide-react';
import { soundEffects } from '../utils/audioEffects';

export const VariantCard: React.FC = () => {
  const [profile, setProfile] = useState<VariantProfile>({
    id: 'TVA-DOC-88319',
    variantId: 'VAR-L1130-USER',
    alias: 'The Mastermind Variant',
    offense: 'Willful deviation from the Sacred Timeline & building autonomous AI',
    timelineBranch: 'Branch Earth-616-B / Chrono 2026',
    pruneRisk: 'Moderate',
    capturedTimestamp: '2026-10-30 08:26:00',
  });

  const [isEditing, setIsEditing] = useState(false);
  const [aliasInput, setAliasInput] = useState(profile.alias);
  const [offenseInput, setOffenseInput] = useState(profile.offense);

  const handleSave = () => {
    setProfile(prev => ({
      ...prev,
      alias: aliasInput || 'Anonymous Variant',
      offense: offenseInput || 'Unauthorized temporal tinkering',
    }));
    setIsEditing(false);
    soundEffects.playKeyClick();
  };

  return (
    <div className="bg-amber-950/40 border border-amber-600/30 rounded-xl p-4 backdrop-blur-md shadow-2xl font-mono text-amber-200 flex flex-col gap-3 relative overflow-hidden">
      {/* Background Watermark Stamp */}
      <div className="absolute -right-6 -bottom-6 opacity-10 pointer-events-none select-none text-7xl font-black rotate-12 text-amber-500">
        TVA
      </div>

      {/* Header */}
      <div className="flex items-center justify-between border-b border-amber-600/20 pb-2">
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4 text-amber-400" />
          <span className="text-xs uppercase font-bold tracking-widest text-amber-300">
            TVA Offense Dossier
          </span>
        </div>
        <button
          onClick={() => {
            if (isEditing) handleSave();
            else setIsEditing(true);
          }}
          className="text-xs text-amber-400 hover:text-amber-200 flex items-center gap-1 bg-amber-900/30 px-2 py-0.5 rounded border border-amber-700/40"
        >
          {isEditing ? (
            <>
              <Check className="w-3 h-3 text-emerald-400" /> Save Dossier
            </>
          ) : (
            <>
              <Edit3 className="w-3 h-3" /> Edit Profile
            </>
          )}
        </button>
      </div>

      {/* Profile Details */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="bg-black/30 p-2 rounded border border-amber-800/20 flex flex-col">
          <span className="text-[10px] text-amber-500 uppercase">Docket ID</span>
          <span className="font-semibold">{profile.id}</span>
        </div>

        <div className="bg-black/30 p-2 rounded border border-amber-800/20 flex flex-col">
          <span className="text-[10px] text-amber-500 uppercase">Designation</span>
          <span className="font-semibold text-amber-300">{profile.variantId}</span>
        </div>

        <div className="col-span-2 bg-black/30 p-2 rounded border border-amber-800/20 flex flex-col">
          <span className="text-[10px] text-amber-500 uppercase">Variant Alias</span>
          {isEditing ? (
            <input
              type="text"
              value={aliasInput}
              onChange={e => setAliasInput(e.target.value)}
              className="bg-black/60 border border-amber-500/60 rounded px-2 py-1 text-amber-200 text-xs mt-1 focus:outline-none focus:ring-1 focus:ring-amber-400"
            />
          ) : (
            <span className="font-semibold text-amber-200">{profile.alias}</span>
          )}
        </div>

        <div className="col-span-2 bg-black/30 p-2 rounded border border-amber-800/20 flex flex-col">
          <span className="text-[10px] text-amber-500 uppercase">Temporal Offense</span>
          {isEditing ? (
            <textarea
              rows={2}
              value={offenseInput}
              onChange={e => setOffenseInput(e.target.value)}
              className="bg-black/60 border border-amber-500/60 rounded px-2 py-1 text-amber-200 text-xs mt-1 focus:outline-none focus:ring-1 focus:ring-amber-400 resize-none"
            />
          ) : (
            <span className="text-amber-300/90 italic">"{profile.offense}"</span>
          )}
        </div>

        <div className="bg-black/30 p-2 rounded border border-amber-800/20 flex flex-col">
          <span className="text-[10px] text-amber-500 uppercase">Prune Priority</span>
          <span className={`font-bold ${
            profile.pruneRisk === 'Critical' ? 'text-red-400' : profile.pruneRisk === 'Moderate' ? 'text-amber-400' : 'text-emerald-400'
          }`}>
            {profile.pruneRisk}
          </span>
        </div>

        <div className="bg-black/30 p-2 rounded border border-amber-800/20 flex flex-col">
          <span className="text-[10px] text-amber-500 uppercase">Origin Coordinates</span>
          <span className="text-[11px] truncate">{profile.timelineBranch}</span>
        </div>
      </div>

      {/* Footer Fingerprint Stamp */}
      <div className="flex items-center justify-between pt-1 border-t border-amber-700/20 text-[10px] text-amber-400/70">
        <span className="flex items-center gap-1">
          <Fingerprint className="w-3.5 h-3.5 text-amber-500" /> Chrono-Biometric Verified
        </span>
        <span className="flex items-center gap-1 font-bold text-amber-400">
          <Award className="w-3.5 h-3.5" /> For all time. Always.
        </span>
      </div>
    </div>
  );
};

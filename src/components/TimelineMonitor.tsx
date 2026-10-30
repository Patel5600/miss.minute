import React, { useEffect, useRef, useState } from 'react';
import type { TimelineBranch } from '../types';
import { soundEffects } from '../utils/audioEffects';
import confetti from 'canvas-confetti';
import { Zap, AlertTriangle, ShieldCheck, RefreshCw } from 'lucide-react';

interface TimelineMonitorProps {
  onBranchPruned?: (branch: TimelineBranch) => void;
  onNexusTriggered?: () => void;
}

export const TimelineMonitor: React.FC<TimelineMonitorProps> = ({
  onBranchPruned,
  onNexusTriggered,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [branches, setBranches] = useState<TimelineBranch[]>([
    {
      id: 'branch-1',
      name: 'Branch 616-Delta (Loki Variant)',
      deviationRate: 42,
      timeString: '2026-10-30 08:30:12',
      status: 'warning',
      variant: 'L-1130',
    },
    {
      id: 'branch-2',
      name: 'Branch 838-Zeta (Coffee Spilled on TemPad)',
      deviationRate: 15,
      timeString: '1985-07-04 14:22:00',
      status: 'safe',
      variant: 'M-0902',
    },
  ]);

  const [activeTab, setActiveTab] = useState<'monitor' | 'branches'>('monitor');
  const [redLineAlert, setRedLineAlert] = useState(false);

  // Animated Timeline Canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;
    let offset = 0;

    const render = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      offset += 0.8;

      const centerY = canvas.height / 2;

      // Draw Grid Lines (TVA CRT retro grid)
      ctx.strokeStyle = 'rgba(217, 119, 6, 0.12)';
      ctx.lineWidth = 1;
      for (let x = 0; x < canvas.width; x += 30) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
      }
      for (let y = 0; y < canvas.height; y += 30) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
      }

      // Draw Red Lines (Upper and Lower Thresholds)
      const redLineTop = centerY - 65;
      const redLineBottom = centerY + 65;

      ctx.strokeStyle = redLineAlert ? 'rgba(239, 68, 68, 0.85)' : 'rgba(239, 68, 68, 0.45)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 6]);

      // Top Red Line
      ctx.beginPath();
      ctx.moveTo(0, redLineTop);
      ctx.lineTo(canvas.width, redLineTop);
      ctx.stroke();

      // Bottom Red Line
      ctx.beginPath();
      ctx.moveTo(0, redLineBottom);
      ctx.lineTo(canvas.width, redLineBottom);
      ctx.stroke();

      ctx.setLineDash([]); // Reset dash

      // Sacred Timeline: Center Glowing Beam
      ctx.shadowBlur = 12;
      ctx.shadowColor = '#F59E0B';
      ctx.strokeStyle = '#FBBF24';
      ctx.lineWidth = 3.5;

      ctx.beginPath();
      for (let x = 0; x < canvas.width; x++) {
        // Mild undulating wave representing the timeline stability
        const y = centerY + Math.sin((x + offset) * 0.02) * 4;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Draw Active Branches
      branches.forEach((b, idx) => {
        if (b.status === 'pruned') return;

        const isUpper = idx % 2 === 0;
        const branchX = 120 + idx * 110;
        const branchHeight = (b.deviationRate / 100) * 60;
        const targetY = isUpper ? centerY - branchHeight : centerY + branchHeight;

        ctx.shadowBlur = b.status === 'critical' ? 18 : 8;
        ctx.shadowColor = b.status === 'critical' ? '#EF4444' : '#F59E0B';
        ctx.strokeStyle = b.status === 'critical' ? '#EF4444' : '#FB923C';
        ctx.lineWidth = 2.5;

        ctx.beginPath();
        ctx.moveTo(branchX, centerY);
        ctx.bezierCurveTo(
          branchX + 30, centerY,
          branchX + 50, targetY,
          branchX + 110, targetY + Math.sin((offset + idx) * 0.05) * 3
        );
        ctx.stroke();

        // Pulsing branch node
        ctx.fillStyle = b.status === 'critical' ? '#EF4444' : '#F59E0B';
        ctx.beginPath();
        ctx.arc(branchX + 110, targetY, 4.5, 0, Math.PI * 2);
        ctx.fill();
      });

      // Scanline CRT raster overlay
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
      for (let y = 0; y < canvas.height; y += 4) {
        ctx.fillRect(0, y, canvas.width, 1.5);
      }

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => cancelAnimationFrame(animationFrameId);
  }, [branches, redLineAlert]);

  const handlePrune = (branchId: string) => {
    soundEffects.playPruneZap();

    // Trigger visual confetti / particle burst
    confetti({
      particleCount: 45,
      spread: 70,
      origin: { y: 0.6 },
      colors: ['#0284C7', '#38BDF8', '#F59E0B', '#F43F5E'],
    });

    setBranches(prev =>
      prev.map(b => (b.id === branchId ? { ...b, status: 'pruned' } : b))
    );

    const prunedBranch = branches.find(b => b.id === branchId);
    if (prunedBranch && onBranchPruned) {
      onBranchPruned(prunedBranch);
    }
  };

  const handleSimulateNexus = () => {
    soundEffects.playNexusAlert();
    setRedLineAlert(true);
    setTimeout(() => setRedLineAlert(false), 3000);

    const newId = `branch-${Date.now()}`;
    const newBranch: TimelineBranch = {
      id: newId,
      name: `Branch-Nexus-${Math.floor(100 + Math.random() * 900)} (Spontaneous Variant)`,
      deviationRate: Math.floor(75 + Math.random() * 24),
      timeString: new Date().toLocaleTimeString(),
      status: 'critical',
      variant: `VAR-${Math.floor(1000 + Math.random() * 9000)}`,
    };

    setBranches(prev => [newBranch, ...prev.slice(0, 4)]);
    if (onNexusTriggered) {
      onNexusTriggered();
    }
  };

  const activeBranchCount = branches.filter(b => b.status !== 'pruned').length;

  return (
    <div className="bg-amber-950/40 border border-amber-600/30 rounded-xl p-4 backdrop-blur-md shadow-2xl flex flex-col gap-3 font-mono text-amber-200">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-amber-600/20 pb-2.5">
        <div className="flex items-center gap-2">
          <div className={`w-3 h-3 rounded-full ${redLineAlert ? 'bg-red-500 animate-ping' : 'bg-amber-400'}`} />
          <h3 className="font-bold tracking-wider text-sm uppercase text-amber-300">
            Sacred Timeline Chrono-Scope
          </h3>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setActiveTab('monitor')}
            className={`px-2.5 py-1 text-xs rounded transition-colors ${
              activeTab === 'monitor' ? 'bg-amber-600/40 text-amber-100 font-semibold' : 'text-amber-400/70 hover:text-amber-200'
            }`}
          >
            Oscilloscope
          </button>
          <button
            onClick={() => setActiveTab('branches')}
            className={`px-2.5 py-1 text-xs rounded transition-colors ${
              activeTab === 'branches' ? 'bg-amber-600/40 text-amber-100 font-semibold' : 'text-amber-400/70 hover:text-amber-200'
            }`}
          >
            Branches ({activeBranchCount})
          </button>
        </div>
      </div>

      {/* Main Content */}
      {activeTab === 'monitor' ? (
        <div className="relative rounded-lg overflow-hidden border border-amber-700/50 bg-black/60 shadow-inner">
          <canvas
            ref={canvasRef}
            width={480}
            height={180}
            className="w-full h-44 block"
          />

          {/* CRT Overlay Labels */}
          <div className="absolute top-2 left-3 text-[10px] text-red-400/80 uppercase tracking-widest flex items-center gap-1 font-bold">
            <AlertTriangle className="w-3 h-3" /> Red Line Threshold [Critical 80%]
          </div>
          <div className="absolute bottom-2 left-3 text-[10px] text-amber-400/80 uppercase tracking-widest">
            Frequency: 432.18 THz • Flow: Stable
          </div>
          <div className="absolute top-2 right-3 text-[10px] text-emerald-400 uppercase tracking-widest flex items-center gap-1">
            <ShieldCheck className="w-3 h-3" /> TVA Chrono Guard
          </div>
        </div>
      ) : (
        <div className="space-y-2 max-h-44 overflow-y-auto pr-1">
          {branches.map(branch => (
            <div
              key={branch.id}
              className={`p-2.5 rounded-lg border text-xs flex items-center justify-between ${
                branch.status === 'pruned'
                  ? 'border-neutral-800 bg-neutral-900/40 text-neutral-500 line-through'
                  : branch.status === 'critical'
                  ? 'border-red-600/40 bg-red-950/30 text-red-200'
                  : 'border-amber-600/30 bg-amber-950/30 text-amber-200'
              }`}
            >
              <div className="flex flex-col">
                <span className="font-semibold">{branch.name}</span>
                <span className="text-[10px] text-amber-400/60">
                  Variant: {branch.variant} • Deviation: {branch.deviationRate}%
                </span>
              </div>
              {branch.status !== 'pruned' ? (
                <button
                  onClick={() => handlePrune(branch.id)}
                  className="px-2.5 py-1 bg-red-900/60 hover:bg-red-800 text-red-200 border border-red-500/50 rounded flex items-center gap-1 text-[11px] transition-all hover:scale-105"
                  title="Deploy Reset Charge & Prune"
                >
                  <Zap className="w-3 h-3 text-red-400" /> Prune
                </button>
              ) : (
                <span className="text-[10px] text-emerald-500 font-bold uppercase">Pruned ✓</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Action Footer */}
      <div className="flex items-center justify-between pt-1">
        <button
          onClick={handleSimulateNexus}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-amber-600/30 hover:bg-amber-600/50 border border-amber-500/40 rounded-lg text-amber-200 transition-colors"
        >
          <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
          Simulate Nexus Event
        </button>

        <span className="text-[11px] text-amber-400/60 flex items-center gap-1">
          <RefreshCw className="w-3 h-3 animate-spin text-amber-500" />
          TemPad Auto-Syncing
        </span>
      </div>
    </div>
  );
};

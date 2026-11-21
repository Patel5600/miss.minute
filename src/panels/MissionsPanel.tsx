/**
 * Bounded Mission DAG Builder & Checkpointed Runner panel.
 * Validates 1..=32 nodes, dependency depth <= 8, enforces loop abort cancellation,
 * and blocks autonomous 'financial' side-effect nodes.
 */
import { useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  Clock,
  GitBranch,
  Play,
  Plus,
  RotateCcw,
  ShieldAlert,
  Square,
  Trash2,
  XCircle,
} from 'lucide-react';
import { useDbList } from '../store/useDb';
import type { MissionRecord } from '../store/db';
import type { MissionNode, SideEffectTier } from '../desktop/bridge';
import { SIDE_EFFECT_TIERS } from '../agent/tools/connectors';
import {
  MAX_DAG_NODES,
  removeMission,
  runAndSaveMission,
  validateMissionDag,
} from '../agent/tools/missions';
import { formatWhen } from '../agent/tools/time';
import { Button, ConfirmButton, Empty, ErrorLine, MicroLabel, PanelShell, Tabs, inputClass } from './ui';
import { useAction } from './useAction';

export interface MissionsPanelProps {
  className?: string;
}

type MissionPreset = {
  id: string;
  label: string;
  goal: string;
  nodes: MissionNode[];
};

const PRESETS: MissionPreset[] = [
  {
    id: 'brief',
    label: 'Daily Research & Plan',
    goal: 'Gather schedule context and synthesize daily priorities',
    nodes: [
      { id: 'fetch_agenda', title: 'Read today schedule & reminders', depends_on: [], action_kind: 'read_schedule', side_effect: 'read_only', max_retries: 1 },
      { id: 'check_weather', title: 'Check local forecast window', depends_on: [], action_kind: 'weather_check', side_effect: 'read_only', max_retries: 1 },
      { id: 'compile_brief', title: 'Compile verified briefing', depends_on: ['fetch_agenda', 'check_weather'], action_kind: 'synthesize', side_effect: 'read_only', max_retries: 0 },
    ],
  },
  {
    id: 'draft_note',
    label: 'Draft & Verify Summary Note',
    goal: 'Prepare summary and save local note',
    nodes: [
      { id: 'collect', title: 'Collect open todos', depends_on: [], action_kind: 'list_todos', side_effect: 'read_only', max_retries: 0 },
      { id: 'save_note', title: 'Write local markdown summary', depends_on: ['collect'], action_kind: 'write_note', side_effect: 'local_write', max_retries: 1 },
    ],
  },
];

const TIER_STYLE: Record<SideEffectTier, string> = {
  read_only: 'border-emerald-500/35 bg-emerald-950/30 text-emerald-300',
  local_write: 'border-sky-500/35 bg-sky-950/30 text-sky-300',
  external: 'border-[#FF7A1A]/40 bg-[#FF7A1A]/15 text-[#FFD9B3]',
  destructive: 'border-orange-500/45 bg-orange-950/40 text-orange-200',
  financial: 'border-red-500/50 bg-red-950/45 text-red-200',
};

const STATUS_STYLE: Record<MissionRecord['status'], string> = {
  pending: 'border-white/[0.12] bg-white/[0.04] text-[#CBBEB0]',
  running: 'border-[#FF7A1A]/50 bg-[#FF7A1A]/15 text-[#FFD9B3]',
  completed: 'border-emerald-500/40 bg-emerald-950/35 text-emerald-300',
  failed: 'border-red-500/45 bg-red-950/35 text-red-200',
  cancelled: 'border-white/[0.12] bg-white/[0.04] text-[#9D9082]',
};

export function MissionsPanel({ className }: MissionsPanelProps) {
  const { data: missions = [], loading, error: loadError } = useDbList(
    'missions',
    rows => [...rows].sort((a, b) => b.updatedAt - a.updatedAt),
  );
  const action = useAction();
  const [tab, setTab] = useState<'builder' | 'runs'>('builder');
  const [goal, setGoal] = useState(PRESETS[0].goal);
  const [nodes, setNodes] = useState<MissionNode[]>(PRESETS[0].nodes);
  const [runningAbort, setRunningAbort] = useState<AbortController | null>(null);
  const runningRef = useRef<AbortController | null>(null);

  const [stepId, setStepId] = useState('');
  const [stepTitle, setStepTitle] = useState('');
  const [stepAction, setStepAction] = useState('read_task');
  const [stepTier, setStepTier] = useState<SideEffectTier>('read_only');
  const [stepDependsOn, setStepDependsOn] = useState('');
  const [stepRetries, setStepRetries] = useState(0);

  const dagCheck = useMemo(() => {
    try {
      const order = validateMissionDag({
        mission_id: 'preview',
        goal: goal.trim() || 'Preview mission',
        nodes,
      });
      const hasFinancial = nodes.some(n => n.side_effect === 'financial');
      const needsConfirm = nodes.some(n => n.side_effect !== 'read_only');
      return { ok: true as const, order, hasFinancial, needsConfirm };
    } catch (err) {
      return {
        ok: false as const,
        order: [] as string[],
        hasFinancial: nodes.some(n => n.side_effect === 'financial'),
        needsConfirm: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }, [goal, nodes]);

  const applyPreset = (preset: MissionPreset) => {
    setGoal(preset.goal);
    setNodes(preset.nodes.map(n => ({ ...n, depends_on: [...n.depends_on] })));
    action.clear();
  };

  const addStep = () => {
    if (nodes.length >= MAX_DAG_NODES) return;
    const rawId = stepId.trim() || `step_${nodes.length + 1}`;
    const cleanId = rawId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const deps = stepDependsOn
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    setNodes(prev => [
      ...prev,
      {
        id: cleanId,
        title: stepTitle.trim() || cleanId,
        action_kind: stepAction.trim() || 'task',
        side_effect: stepTier,
        depends_on: deps,
        max_retries: Math.min(3, Math.max(0, stepRetries)),
      },
    ]);
    setStepId('');
    setStepTitle('');
    setStepDependsOn('');
    action.clear();
  };

  const updateNodeTier = (idx: number, tier: SideEffectTier) => {
    setNodes(prev => prev.map((n, i) => (i === idx ? { ...n, side_effect: tier } : n)));
  };

  const removeNode = (idx: number) => {
    setNodes(prev => prev.filter((_, i) => i !== idx));
  };

  const runMissionNow = () => {
    const controller = new AbortController();
    runningRef.current = controller;
    setRunningAbort(controller);
    action.run(
      async () => {
        try {
          await runAndSaveMission({ goal: goal.trim() || 'Custom mission', nodes }, controller.signal);
          setTab('runs');
        } finally {
          runningRef.current = null;
          setRunningAbort(null);
        }
      },
    );
  };

  const cancelRunning = () => {
    runningRef.current?.abort();
  };

  return (
    <PanelShell
      title="Mission DAGs"
      icon={<GitBranch className="h-4 w-4" />}
      className={className}
      subtitle={`${missions.length} recorded`}
      actions={
        <Button
          tone="ghost"
          onClick={() => applyPreset(PRESETS[0])}
          className="min-h-11"
          label="Reset to default mission preset"
        >
          <RotateCcw className="h-3.5 w-3.5" /> Preset
        </Button>
      }
    >
      <div className="flex items-start gap-2 rounded-xl border border-[#FF7A1A]/35 bg-[#FF7A1A]/10 px-3 py-2 text-xs text-[#FFD9B3]">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-[#FF9240]" aria-hidden="true" />
        <p className="min-w-0 leading-relaxed">
          Bounded execution: 1–32 steps, depth ≤ 8, retries 0–3. Autonomous{' '}
          <code className="rounded bg-black/40 px-1 py-0.5 font-mono text-[11px]">financial</code> nodes are blocked.
        </p>
      </div>

      <Tabs
        idPrefix="missions"
        label="Mission sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'builder', label: 'Builder', count: nodes.length },
          { id: 'runs', label: 'Saved Runs', count: missions.length },
        ]}
      />

      {tab === 'builder' && (
        <div
          id="missions-panel-builder"
          role="tabpanel"
          aria-labelledby="missions-tab-builder"
          className="space-y-3.5"
        >
          <div className="flex flex-wrap gap-2">
            {PRESETS.map(p => (
              <Button key={p.id} tone="ghost" onClick={() => applyPreset(p)} className="min-h-11">
                {p.label}
              </Button>
            ))}
          </div>

          <div className="space-y-1.5">
            <MicroLabel htmlFor="mission-goal-input">Mission Goal</MicroLabel>
            <input
              id="mission-goal-input"
              value={goal}
              onChange={e => setGoal(e.target.value)}
              placeholder="Describe the objective"
              className={`${inputClass} min-h-11 w-full`}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <MicroLabel>Pipeline Steps ({nodes.length}/{MAX_DAG_NODES})</MicroLabel>
              {dagCheck.ok && (
                <span className="text-[11px] text-emerald-300">
                  Order: {dagCheck.order.join(' → ')}
                </span>
              )}
            </div>

            {nodes.length === 0 ? (
              <Empty>Add at least one step to build a Mission DAG.</Empty>
            ) : (
              <ul className="space-y-2">
                {nodes.map((node, idx) => (
                  <li
                    key={`${node.id}-${idx}`}
                    className="flex flex-col gap-2 rounded-2xl border border-white/[0.08] bg-[#16120E] p-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-mono text-xs font-semibold text-[#FFF8EE]">{node.id}</span>
                          <span className={`rounded-lg border px-2 py-0.5 text-[10px] font-semibold ${TIER_STYLE[node.side_effect]}`}>
                            {node.side_effect}
                          </span>
                          <span className="text-[11px] text-[#9D9082]">retries: {node.max_retries}</span>
                        </div>
                        <p className="mt-0.5 break-words text-xs text-[#CBBEB0]">{node.title}</p>
                        {node.depends_on.length > 0 && (
                          <p className="mt-0.5 font-mono text-[10px] text-[#9D9082]">
                            depends_on: [{node.depends_on.join(', ')}]
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <select
                          aria-label={`Side effect tier for ${node.id}`}
                          value={node.side_effect}
                          onChange={e => updateNodeTier(idx, e.target.value as SideEffectTier)}
                          className={`${inputClass} min-h-11`}
                        >
                          {SIDE_EFFECT_TIERS.map(tier => (
                            <option key={tier} value={tier}>{tier}</option>
                          ))}
                        </select>
                        <Button
                          tone="danger"
                          onClick={() => removeNode(idx)}
                          label={`Remove step ${node.id}`}
                          className="min-h-11"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-2.5 rounded-2xl border border-white/[0.08] bg-[#0E0B08] p-3">
            <MicroLabel>Add Step</MicroLabel>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <input
                value={stepId}
                onChange={e => setStepId(e.target.value)}
                placeholder="step_id (e.g. review)"
                aria-label="New step ID"
                className={`${inputClass} min-h-11`}
              />
              <input
                value={stepTitle}
                onChange={e => setStepTitle(e.target.value)}
                placeholder="Human title"
                aria-label="New step title"
                className={`${inputClass} min-h-11`}
              />
              <input
                value={stepAction}
                onChange={e => setStepAction(e.target.value)}
                placeholder="action_kind"
                aria-label="New step action kind"
                className={`${inputClass} min-h-11`}
              />
              <input
                value={stepDependsOn}
                onChange={e => setStepDependsOn(e.target.value)}
                placeholder="depends_on (comma-separated ids)"
                aria-label="Dependencies"
                className={`${inputClass} min-h-11`}
              />
              <select
                value={stepTier}
                onChange={e => setStepTier(e.target.value as SideEffectTier)}
                aria-label="New step side effect tier"
                className={`${inputClass} min-h-11`}
              >
                {SIDE_EFFECT_TIERS.map(tier => (
                  <option key={tier} value={tier}>{tier}</option>
                ))}
              </select>
              <label className="flex min-h-11 items-center justify-between gap-2 rounded-xl border border-white/[0.12] bg-[#0E0B08] px-3 text-xs text-[#CBBEB0]">
                <span>Max retries (0–3)</span>
                <input
                  type="number"
                  min={0}
                  max={3}
                  value={stepRetries}
                  onChange={e => setStepRetries(Math.min(3, Math.max(0, Number(e.target.value) || 0)))}
                  className="w-14 bg-transparent text-right font-mono text-[#FFF8EE] outline-none"
                />
              </label>
            </div>
            <Button
              tone="ghost"
              onClick={addStep}
              disabled={nodes.length >= MAX_DAG_NODES}
              className="min-h-11 w-full justify-center"
            >
              <Plus className="h-3.5 w-3.5" /> Add Step to DAG
            </Button>
          </div>

          {!dagCheck.ok && <ErrorLine message={dagCheck.error} />}
          {dagCheck.hasFinancial && (
            <ErrorLine message="One or more nodes declare 'financial' side-effects. Policy forbids autonomous financial execution." />
          )}

          <div className="flex flex-wrap gap-2">
            {runningAbort ? (
              <Button tone="danger" onClick={cancelRunning} className="min-h-12 flex-1 justify-center">
                <Square className="h-4 w-4" /> Cancel Running Mission
              </Button>
            ) : dagCheck.needsConfirm && dagCheck.ok && !dagCheck.hasFinancial ? (
              <ConfirmButton
                question="Run mission with write/external steps?"
                confirmLabel="Execute"
                tone="solid"
                onConfirm={runMissionNow}
              >
                <Play className="h-4 w-4" /> Execute Mission
              </ConfirmButton>
            ) : (
              <Button
                tone="solid"
                disabled={action.busy || !dagCheck.ok || nodes.length === 0}
                onClick={runMissionNow}
                className="min-h-12 flex-1 justify-center"
              >
                <Play className="h-4 w-4" /> {action.busy ? 'Executing DAG…' : 'Execute Read-Only Mission'}
              </Button>
            )}
          </div>
          <ErrorLine message={action.error} />
        </div>
      )}

      {tab === 'runs' && (
        <div
          id="missions-panel-runs"
          role="tabpanel"
          aria-labelledby="missions-tab-runs"
          className="space-y-3"
        >
          <ErrorLine message={loadError} />
          {loading ? (
            <Empty>Loading saved mission checkpoints…</Empty>
          ) : missions.length === 0 ? (
            <Empty>No mission runs saved yet. Build and run a DAG to see checkpoints here.</Empty>
          ) : (
            <ul className="space-y-3">
              {missions.map(mission => (
                <li
                  key={mission.id}
                  className="space-y-2.5 rounded-2xl border border-white/[0.08] bg-[#16120E] p-3.5"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATUS_STYLE[mission.status]}`}>
                          {mission.status}
                        </span>
                        <span className="font-mono text-[10px] text-[#9D9082]">{mission.id}</span>
                      </div>
                      <p className="mt-1 break-words text-sm font-semibold text-[#FFF8EE]">{mission.goal}</p>
                      <p className="mt-0.5 text-[11px] text-[#9D9082]">
                        {formatWhen(mission.updatedAt)} · {mission.nodes.length} steps
                      </p>
                    </div>
                    <ConfirmButton
                      iconOnly
                      label={`Delete mission ${mission.goal}`}
                      question="Remove?"
                      onConfirm={() => action.run(() => removeMission(mission.id))}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </ConfirmButton>
                  </div>

                  {mission.error && <ErrorLine message={mission.error} />}

                  {mission.checkpoints && mission.checkpoints.length > 0 && (
                    <ul className="space-y-1.5 border-t border-white/[0.06] pt-2">
                      {mission.checkpoints.map(cp => (
                        <li
                          key={cp.node_id}
                          className="flex items-start gap-2 rounded-xl bg-black/30 px-2.5 py-2 text-xs"
                        >
                          {cp.status === 'succeeded' ? (
                            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
                          ) : cp.status === 'failed' ? (
                            <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
                          ) : (
                            <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#9D9082]" />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center justify-between gap-1">
                              <span className="font-mono font-medium text-[#FFF8EE]">{cp.node_id}</span>
                              <span className="text-[10px] text-[#9D9082]">
                                {cp.status} · {cp.attempts} attempt{cp.attempts === 1 ? '' : 's'}
                              </span>
                            </div>
                            {cp.evidence && (
                              <p className="mt-0.5 break-words text-[11px] text-[#CBBEB0]">{cp.evidence}</p>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </PanelShell>
  );
}

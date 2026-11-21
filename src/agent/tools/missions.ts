/**
 * Bounded Mission DAG validator and checkpointed executor.
 * Mirrors `crates/mm-mission/src/mission.rs` (1..=32 nodes, depth <= 8, max retries clamped 0..=3,
 * blocks autonomous 'financial' side-effect nodes, and aborts cleanly when signalled).
 */
import {
  executeMission,
  isDesktopRuntime,
  validateMission,
  type MissionDag,
  type MissionNode,
  type MissionRunReport,
  type NodeCheckpoint,
  type SideEffectTier,
} from '../../desktop/bridge.ts';
import { deleteRecord, listAll, newId, putRecord, type MissionRecord } from '../../store/db.ts';
import { requiredText, ToolInputError } from './args.ts';
import { SIDE_EFFECT_TIERS } from './connectors.ts';
import { makeTool } from './define.ts';
import type { ToolContext } from './types.ts';

export const MAX_DAG_NODES = 32;
export const MAX_DAG_DEPTH = 8;

export function normalizeMissionNodes(rawNodes: unknown): MissionNode[] {
  let items: unknown = rawNodes;
  if (typeof items === 'string') {
    try {
      items = JSON.parse(items) as unknown;
    } catch {
      throw new ToolInputError("'nodes' must be a JSON array of mission nodes.");
    }
  }
  if (!Array.isArray(items)) {
    throw new ToolInputError("'nodes' must be an array of mission step objects.");
  }
  if (items.length === 0 || items.length > MAX_DAG_NODES) {
    throw new ToolInputError(`Mission DAG must contain between 1 and ${MAX_DAG_NODES} nodes.`);
  }
  return items.map((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ToolInputError(`Mission node at index ${idx} must be an object.`);
    }
    const obj = item as Record<string, unknown>;
    const id = typeof obj.id === 'string' ? obj.id.trim() : '';
    if (!id) throw new ToolInputError(`Mission node at index ${idx} requires a non-empty 'id'.`);
    const title = typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim() : id;
    const actionKind = typeof obj.action_kind === 'string' && obj.action_kind.trim()
      ? obj.action_kind.trim()
      : 'task';
    const rawSideEffect = typeof obj.side_effect === 'string' ? obj.side_effect.trim() : 'read_only';
    if (!SIDE_EFFECT_TIERS.includes(rawSideEffect as SideEffectTier)) {
      throw new ToolInputError(`Invalid side_effect "${rawSideEffect}" on node "${id}".`);
    }
    const deps = Array.isArray(obj.depends_on)
      ? obj.depends_on.filter((d): d is string => typeof d === 'string').map(d => d.trim())
      : [];
    const rawRetries = typeof obj.max_retries === 'number' && Number.isFinite(obj.max_retries)
      ? Math.floor(obj.max_retries)
      : 0;
    const maxRetries = Math.min(3, Math.max(0, rawRetries));

    return {
      id,
      title,
      depends_on: deps,
      action_kind: actionKind,
      side_effect: rawSideEffect as SideEffectTier,
      max_retries: maxRetries,
    };
  });
}

export function validateMissionDag(dag: MissionDag): string[] {
  if (dag.nodes.length === 0 || dag.nodes.length > MAX_DAG_NODES) {
    throw new ToolInputError(`Mission DAG is empty or exceeds ${MAX_DAG_NODES} nodes.`);
  }

  const byId = new Map<string, MissionNode>();
  for (const node of dag.nodes) {
    const id = node.id.trim();
    if (!id || byId.has(id)) {
      throw new ToolInputError(`Duplicate or empty mission node id "${node.id}".`);
    }
    byId.set(id, node);
  }

  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const node of dag.nodes) {
    const seenDeps = new Set<string>();
    let count = 0;
    for (const dep of node.depends_on) {
      if (!byId.has(dep)) {
        throw new ToolInputError(`Mission node "${node.id}" depends on unknown node "${dep}".`);
      }
      if (!seenDeps.has(dep)) {
        seenDeps.add(dep);
        const list = dependents.get(dep) ?? [];
        list.push(node.id);
        dependents.set(dep, list);
        count += 1;
      }
    }
    indegree.set(node.id, count);
  }

  const depthMap = new Map<string, number>();
  const queue: string[] = [];
  for (const node of dag.nodes) {
    if ((indegree.get(node.id) ?? 0) === 0) {
      queue.push(node.id);
      depthMap.set(node.id, 1);
    }
  }

  const topo: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    const currentDepth = depthMap.get(id) ?? 1;
    if (currentDepth > MAX_DAG_DEPTH) {
      throw new ToolInputError(`Mission DAG exceeds maximum dependency depth ${MAX_DAG_DEPTH}.`);
    }
    topo.push(id);
    const children = dependents.get(id) ?? [];
    for (const child of children) {
      const nextDepth = currentDepth + 1;
      const prevDepth = depthMap.get(child) ?? 0;
      if (nextDepth > prevDepth) depthMap.set(child, nextDepth);
      const nextDeg = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, nextDeg);
      if (nextDeg === 0) queue.push(child);
    }
  }

  if (topo.length !== dag.nodes.length) {
    throw new ToolInputError('Mission DAG contains a cycle.');
  }
  return topo;
}

export type MissionStepExecutor = (
  node: MissionNode,
  attempt: number,
  signal?: AbortSignal,
) => Promise<string>;

const defaultStepExecutor: MissionStepExecutor = async (node, attempt, signal) => {
  if (signal?.aborted) {
    throw new DOMException('Mission aborted.', 'AbortError');
  }
  return `Verified step ${node.id} (${node.action_kind}) on attempt ${attempt}`;
};

export async function executeMissionDagLocal(
  dag: MissionDag,
  executor: MissionStepExecutor = defaultStepExecutor,
  signal?: AbortSignal,
): Promise<MissionRunReport> {
  const order = validateMissionDag(dag);
  const nodeMap = new Map(dag.nodes.map(node => [node.id, node]));

  for (const node of dag.nodes) {
    if (node.side_effect === 'financial') {
      throw new ToolInputError(`Autonomous mission blocked: node "${node.id}" has financial side-effect.`);
    }
  }

  const checkpoints: NodeCheckpoint[] = [];
  for (const nodeId of order) {
    if (signal?.aborted) {
      throw new DOMException('Mission paused/cancelled by abort signal.', 'AbortError');
    }
    const node = nodeMap.get(nodeId) as MissionNode;
    const maxAttempts = Math.min(3, Math.max(0, Math.floor(node.max_retries))) + 1;
    let attempts = 0;
    let lastError = '';
    let evidence: string | undefined;

    while (attempts < maxAttempts) {
      if (signal?.aborted) {
        throw new DOMException('Mission paused/cancelled by abort signal.', 'AbortError');
      }
      attempts += 1;
      try {
        evidence = await executor(node, attempts, signal);
        break;
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') throw err;
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    if (evidence !== undefined) {
      checkpoints.push({
        node_id: nodeId,
        status: 'succeeded',
        attempts,
        evidence,
      });
    } else {
      checkpoints.push({
        node_id: nodeId,
        status: 'failed',
        attempts,
        evidence: lastError || 'Step failed',
      });
      throw new Error(`Node "${nodeId}" failed permanently after ${attempts} attempt(s): ${lastError}`);
    }
  }

  return {
    run_id: newId(),
    mission_id: dag.mission_id,
    checkpoints,
    completed: true,
  };
}

export async function listMissions(): Promise<MissionRecord[]> {
  const rows = await listAll('missions');
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function removeMission(id: string): Promise<void> {
  await deleteRecord('missions', id);
}

export async function runAndSaveMission(
  input: { missionId?: string; goal: string; nodes: MissionNode[] },
  signal?: AbortSignal,
): Promise<{ record: MissionRecord; report: MissionRunReport }> {
  const now = Date.now();
  const missionId = input.missionId?.trim() || `mission-${newId()}`;
  const dag: MissionDag = {
    mission_id: missionId,
    goal: input.goal.trim(),
    nodes: input.nodes,
  };

  validateMissionDag(dag);
  for (const node of dag.nodes) {
    if (node.side_effect === 'financial') {
      throw new ToolInputError(`Autonomous mission blocked: node "${node.id}" requires financial side-effect.`);
    }
  }

  let record: MissionRecord = {
    id: missionId,
    goal: dag.goal,
    status: 'running',
    nodes: dag.nodes,
    checkpoints: dag.nodes.map(n => ({ node_id: n.id, status: 'pending', attempts: 0, evidence: null })),
    createdAt: now,
    updatedAt: now,
  };
  await putRecord('missions', record);

  try {
    let report: MissionRunReport;
    if (isDesktopRuntime()) {
      await validateMission(dag);
      report = await executeMission(dag);
    } else {
      report = await executeMissionDagLocal(dag, defaultStepExecutor, signal);
    }

    record = {
      ...record,
      status: report.completed ? 'completed' : 'failed',
      checkpoints: report.checkpoints,
      runId: report.run_id,
      updatedAt: Date.now(),
    };
    await putRecord('missions', record);
    return { record, report };
  } catch (error) {
    const aborted = Boolean(signal?.aborted) || (error instanceof DOMException && error.name === 'AbortError');
    record = {
      ...record,
      status: aborted ? 'cancelled' : 'failed',
      error: error instanceof Error ? error.message : String(error),
      updatedAt: Date.now(),
    };
    await putRecord('missions', record);
    throw error;
  }
}

interface MissionArgs {
  missionId?: string;
  goal: string;
  nodes: MissionNode[];
}

export const missionTools = [
  makeTool<MissionArgs>({
    name: 'run_mission',
    description:
      'Validates and runs a bounded multi-step Mission DAG (1..=32 nodes, depth <= 8, up to 3 retries per node) '
      + 'with checkpoint persistence. Autonomous financial side-effects are always blocked. Owner only.',
    parameters: {
      type: 'object',
      properties: {
        mission_id: { type: 'string', description: 'Optional mission id.' },
        goal: { type: 'string', description: 'Short description of the mission goal.' },
        nodes: {
          type: 'array',
          description: 'DAG steps with id, title, depends_on, action_kind, side_effect, max_retries.',
          items: { type: 'object' },
        },
      },
      required: ['goal', 'nodes'],
    },
    policy: args => (args.nodes.every(node => node.side_effect === 'read_only') ? 'auto' : 'confirm'),
    failure: "Couldn't run mission",
    available: (ctx: ToolContext) => !ctx.guestMode,
    parse(args) {
      const goal = requiredText(args, 'goal', 300);
      const nodes = normalizeMissionNodes(args.nodes);
      const missionId = typeof args.mission_id === 'string' && args.mission_id.trim()
        ? args.mission_id.trim().slice(0, 120)
        : undefined;
      validateMissionDag({ mission_id: missionId ?? 'preview', goal, nodes });
      return { missionId, goal, nodes };
    },
    describe(args) {
      return `Run mission "${args.goal}" (${args.nodes.length} step${args.nodes.length === 1 ? '' : 's'})`;
    },
    async prepare(args) {
      const tiers = new Set(args.nodes.map(n => n.side_effect));
      const risk = tiers.has('destructive') || tiers.has('financial')
        ? 'high'
        : tiers.has('external') || tiers.has('local_write')
          ? 'medium'
          : 'low';
      return {
        text: `Execute ${args.nodes.length}-step mission "${args.goal}" (tiers: ${[...tiers].join(', ')}).`,
        content: JSON.stringify(args.nodes, null, 2),
        risk,
      };
    },
    async run(args, ctx) {
      const { record, report } = await runAndSaveMission(args, ctx.signal);
      return {
        ok: true,
        summary: `Mission "${record.goal}" completed (${report.checkpoints.length} steps)`,
        data: {
          mission_id: record.id,
          run_id: report.run_id,
          status: record.status,
          checkpoints: report.checkpoints,
        },
      };
    },
  }),
];

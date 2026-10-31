/**
 * Tool registry. The brain lists tools from here and the UI looks calls up by name.
 * Signatures are a shared contract: keep them stable.
 */
import type { AISettings } from '../../types';
import { calculateTools } from './calculate';
import { clockTools } from './clock';
import { desktopTools } from './desktop';
import { memoryTools } from './memory';
import { noteTools } from './notes';
import { scheduleTools } from './schedule';
import { searchTools } from './search';
import { rememberSettings } from './settingsCache';
import { timerTools } from './timers';
import { todoTools } from './todos';
import type { ToolContext, ToolDef, ToolPolicy } from './types';
import { visionTools } from './vision';
import { weatherTools } from './weather';

export { discardPreparedAction, rejectDesktopProposal } from './desktop';

const tools: ToolDef[] = [
  ...clockTools,
  ...timerTools,
  ...scheduleTools,
  ...todoTools,
  ...noteTools,
  ...weatherTools,
  ...searchTools,
  ...calculateTools,
  ...memoryTools,
  ...visionTools,
  ...desktopTools,
];

if (import.meta.env.DEV) {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) console.error(`[tools] Duplicate tool name: ${tool.name}`);
    seen.add(tool.name);
  }
}

/** Tools usable in this context (e.g. desktop-only tools are hidden in the browser). */
export function listTools(ctx: ToolContext): ToolDef[] {
  rememberSettings(ctx.settings);
  return tools.filter(tool => tool.available?.(ctx) ?? true);
}

export function findTool(name: string): ToolDef | undefined {
  return tools.find(tool => tool.name === name);
}

/** Applies the owner's approval policy, including "Always ask first". */
export function resolvePolicy(tool: ToolDef, args: Record<string, unknown>, settings: AISettings): ToolPolicy {
  if (settings.strictApprovals) return 'confirm';
  return typeof tool.policy === 'function' ? tool.policy(args) : tool.policy;
}

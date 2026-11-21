/**
 * Wraps a tool spec into the shared ToolDef contract: arguments are parsed strictly on every
 * entry point, failures come back as `{ ok: false }` results the model can act on, and every
 * run, approval and error lands in the activity log (compact args, long text clipped).
 */
import { logActivity } from '../../store/db.ts';
import { clip, errorMessage, objectArgs, type RawArgs } from './args.ts';
import { rememberSettings } from './settingsCache.ts';
import { defineTool, type JsonSchema, type ToolContext, type ToolDef, type ToolPolicy, type ToolPreview, type ToolResult } from './types.ts';

export interface ToolSpec<P> {
  name: string;
  description: string;
  parameters: JsonSchema;
  policy: ToolPolicy | ((args: P) => ToolPolicy);
  /** Validates and normalizes raw arguments. Throws ToolInputError with a fixable message. */
  parse(args: RawArgs): P;
  /** One exact sentence: what this call will do. Must not throw. */
  describe(args: P): string;
  /** Authoritative preview for approval (record lookups, host proposals). Defaults to describe(). */
  prepare?(args: P, ctx: ToolContext): Promise<ToolPreview>;
  run(args: P, ctx: ToolContext, prepared?: ToolPreview): Promise<ToolResult>;
  available?(ctx: ToolContext): boolean;
  /** Prefix for failure summaries, e.g. "Couldn't set the timer". */
  failure: string;
}

const SENSITIVE_KEYS = new Set(['content', 'body', 'text', 'command', 'fact']);

/** Activity-log copy of the arguments: short, and free of long content. */
function compactArgs(args: RawArgs): RawArgs {
  const out: RawArgs = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string') out[key] = clip(value, SENSITIVE_KEYS.has(key) ? 80 : 160);
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else out[key] = clip(JSON.stringify(value) ?? '', 120);
  }
  return out;
}

function record(ctx: ToolContext, kind: 'tool' | 'approval' | 'error', summary: string, detail: unknown): void {
  if (ctx.guestMode) return;
  void logActivity(kind, clip(summary, 240), detail).catch(() => undefined);
}

export function failure(summary: string, error?: string): ToolResult {
  return { ok: false, summary, data: { error: error ?? summary } };
}

export function makeTool<P>(spec: ToolSpec<P>): ToolDef {
  const keys = Object.keys(spec.parameters.properties ?? {});
  const parse = (raw: Record<string, unknown> | undefined) => spec.parse(objectArgs(raw, keys));

  return defineTool<Record<string, unknown>>({
    name: spec.name,
    description: spec.description,
    parameters: { ...spec.parameters, additionalProperties: false },
    policy: typeof spec.policy === 'function'
      ? (raw: Record<string, unknown>) => {
          try {
            return (spec.policy as (args: P) => ToolPolicy)(parse(raw));
          } catch {
            return 'confirm';
          }
        }
      : spec.policy,
    available: spec.available,

    describe(raw) {
      try {
        return spec.describe(parse(raw));
      } catch (error) {
        return `${spec.failure}: ${errorMessage(error)}`;
      }
    },

    async prepare(raw, ctx) {
      if (!ctx.guestMode) rememberSettings(ctx.settings);
      const args = parse(raw);
      if (spec.prepare) return spec.prepare(args, ctx);
      return { text: spec.describe(args), risk: 'low' };
    },

    async run(raw, ctx, prepared) {
      if (!ctx.guestMode) rememberSettings(ctx.settings);
      const logged = compactArgs(objectArgsSafe(raw));
      let args: P;
      try {
        args = parse(raw);
      } catch (error) {
        const message = errorMessage(error);
        record(ctx, 'error', `${spec.failure}: ${message}`, { tool: spec.name, args: logged });
        return failure(`${spec.failure}: ${message}`, message);
      }
      const resolvedPolicy = typeof spec.policy === 'function' ? spec.policy(args) : spec.policy;
      const asked = ctx.settings?.strictApprovals === true || resolvedPolicy === 'confirm';
      if (asked) record(ctx, 'approval', `Approved: ${prepared?.text ?? spec.describe(args)}`, { tool: spec.name, args: logged });
      try {
        if (ctx.signal?.aborted) return failure('Cancelled before it started.');
        const result = await spec.run(args, ctx, prepared);
        record(ctx, result.ok ? 'tool' : 'error', result.summary, { tool: spec.name, args: logged, ok: result.ok });
        return result;
      } catch (error) {
        const message = errorMessage(error);
        record(ctx, 'error', `${spec.failure}: ${message}`, { tool: spec.name, args: logged });
        return failure(`${spec.failure}: ${message}`, message);
      }
    },
  });
}

function objectArgsSafe(raw: unknown): RawArgs {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as RawArgs) : {};
}

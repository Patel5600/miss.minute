/**
 * Structured agent loop phases (UNDERSTAND -> PLAN -> VALIDATE -> EXECUTE -> VERIFY -> AMEND -> REPORT)
 * plus resilient JSON extraction and bounded repair passes that respect AbortSignal/kill state.
 */
import { incrementCounter, nowUs, recordLatency } from '../telemetry.ts';

export type LoopPhase =
  | 'UNDERSTAND'
  | 'PLAN'
  | 'VALIDATE'
  | 'EXECUTE'
  | 'VERIFY'
  | 'AMEND'
  | 'REPORT';

export interface LoopStepTrace {
  phase: LoopPhase;
  startedAtUs: number;
  endedAtUs: number;
  ok: boolean;
  detail?: string;
}

export interface LoopTrace {
  runId: string;
  goal: string;
  currentPhase: LoopPhase;
  steps: LoopStepTrace[];
  startedAtMs: number;
  endedAtMs?: number;
}

export const DEFAULT_MAX_REPAIR_PASSES = 3;

export class LoopTracker {
  readonly runId: string;
  readonly goal: string;
  readonly startedAtMs: number;
  private currentPhase: LoopPhase = 'UNDERSTAND';
  private activeStartUs = 0;
  private activeDetail: string | undefined;
  private steps: LoopStepTrace[] = [];
  private endedAtMs: number | undefined;

  constructor(runId: string, goal: string) {
    this.runId = runId;
    this.goal = goal;
    this.startedAtMs = Date.now();
  }

  enter(phase: LoopPhase, detail?: string): void {
    const now = nowUs();
    if (this.activeStartUs > 0) {
      this.closeActiveStep(now, true);
    }
    this.currentPhase = phase;
    this.activeStartUs = now;
    this.activeDetail = detail;
    incrementCounter(`loop.phase.${phase.toLowerCase()}.entered`, 1);
  }

  finishStep(ok: boolean, detail?: string): void {
    const now = nowUs();
    if (this.activeStartUs === 0) {
      this.activeStartUs = now;
    }
    if (detail !== undefined) this.activeDetail = detail;
    this.closeActiveStep(now, ok);
  }

  complete(ok: boolean, detail?: string): LoopTrace {
    if (this.activeStartUs > 0) {
      this.finishStep(ok, detail);
    }
    this.endedAtMs = Date.now();
    incrementCounter(ok ? 'loop.runs.succeeded' : 'loop.runs.failed', 1);
    return this.snapshot();
  }

  snapshot(): LoopTrace {
    return {
      runId: this.runId,
      goal: this.goal,
      currentPhase: this.currentPhase,
      steps: [...this.steps],
      startedAtMs: this.startedAtMs,
      ...(this.endedAtMs !== undefined ? { endedAtMs: this.endedAtMs } : {}),
    };
  }

  private closeActiveStep(endedAtUs: number, ok: boolean): void {
    const durationUs = Math.max(0, endedAtUs - this.activeStartUs);
    recordLatency(`loop.phase.${this.currentPhase.toLowerCase()}_us`, durationUs);
    this.steps.push({
      phase: this.currentPhase,
      startedAtUs: this.activeStartUs,
      endedAtUs,
      ok,
      ...(this.activeDetail ? { detail: this.activeDetail } : {}),
    });
    this.activeStartUs = 0;
    this.activeDetail = undefined;
  }
}

/**
 * Finds the first balanced `{...}` or `[...]` JSON payload in arbitrary text (such as markdown
 * fences or explanatory prose around model JSON output). Respects quoted strings and `\` escapes.
 */
export function extractJsonObject(text: string): string | null {
  const source = text.trim();
  if (!source) return null;

  // Prefer fenced ```json ... ``` blocks first when present.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(source);
  const searchSpace = fenced?.[1]?.trim() || source;

  let start = -1;
  let openChar = '';
  let closeChar = '';
  for (let i = 0; i < searchSpace.length; i += 1) {
    const ch = searchSpace[i];
    if (ch === '{' || ch === '[') {
      start = i;
      openChar = ch;
      closeChar = ch === '{' ? '}' : ']';
      break;
    }
  }
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < searchSpace.length; i += 1) {
    const ch = searchSpace[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === openChar) depth += 1;
    else if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return searchSpace.slice(start, i + 1);
    }
  }
  return null;
}

function stripTrailingCommas(json: string): string {
  return json.replace(/,\s*([}\]])/g, '$1');
}

function tryParseJson(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const candidates: string[] = [];
  const extracted = extractJsonObject(raw);
  if (extracted) {
    candidates.push(extracted, stripTrailingCommas(extracted));
  }
  const trimmed = raw.trim();
  if (trimmed) {
    candidates.push(trimmed, stripTrailingCommas(trimmed));
  }

  let lastError = 'Empty JSON payload.';
  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) as unknown };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return { ok: false, error: lastError };
}

export interface RepairJsonOptions<T> {
  raw: string;
  validate?: (value: unknown) => T;
  requestRepair?: (broken: string, reason: string, attempt: number) => Promise<string>;
  maxAttempts?: number;
  signal?: AbortSignal;
}

export interface RepairJsonResult<T> {
  value: T;
  attempts: number;
  repaired: boolean;
}

/**
 * Parses and validates JSON output, running up to `maxAttempts` (default 3) repair passes
 * through `requestRepair` when malformed or schema-invalid, aborting cleanly if signalled.
 */
export async function repairAndParseJson<T = Record<string, unknown>>(
  options: RepairJsonOptions<T>,
): Promise<RepairJsonResult<T>> {
  const maxPasses = Math.max(0, Math.min(3, Math.floor(options.maxAttempts ?? DEFAULT_MAX_REPAIR_PASSES)));
  const assertNotAborted = () => {
    if (options.signal?.aborted) {
      throw new DOMException('JSON repair cancelled.', 'AbortError');
    }
  };

  assertNotAborted();
  let current = options.raw;
  let lastReason = 'Malformed JSON payload.';

  for (let attempt = 0; attempt <= maxPasses; attempt += 1) {
    assertNotAborted();
    const parsed = tryParseJson(current);
    if (parsed.ok) {
      try {
        const value = options.validate ? options.validate(parsed.value) : (parsed.value as T);
        return { value, attempts: attempt, repaired: attempt > 0 };
      } catch (err) {
        lastReason = err instanceof Error ? err.message : String(err);
      }
    } else {
      lastReason = parsed.error;
    }

    if (attempt >= maxPasses || !options.requestRepair) {
      throw new Error(`Could not obtain valid structured JSON after ${attempt + 1} attempt(s): ${lastReason}`);
    }

    incrementCounter('loop.json_repair.attempts', 1);
    current = await options.requestRepair(current, lastReason, attempt + 1);
    assertNotAborted();
  }

  throw new Error(`Could not obtain valid structured JSON: ${lastReason}`);
}

/**
 * Runs tool calls under the owner's approval policy, for model turns and the offline engine
 * alike. 'auto' tools run at once. 'confirm' tools get their authoritative preview from
 * prepare() first, wait for the owner to approve that exact preview, and then run with it.
 * Every state change is reported so the UI can show the call live.
 */
import type { AISettings, ToolCallRecord } from '../../types';
import { logActivity, newId } from '../../store/db';
import type { ToolContext, ToolDef, ToolPreview, ToolResult } from '../tools/types';
import { findTool, listTools, resolvePolicy } from '../tools/registry';
import { payloadFromResult, type ModelToolCall, type ToolResultForModel } from './conversation';
import { cancelledError, isAbortError } from './errors';
import type { ApprovalHandler } from './types';

export interface ToolRunnerOptions {
  settings: AISettings;
  desktop: boolean;
  chatId?: string;
  signal: AbortSignal;
  requestApproval: ApprovalHandler;
  onUpdate: (record: ToolCallRecord) => void;
}

export interface ToolOutcome {
  record: ToolCallRecord;
  /** Present when the tool actually ran. */
  result?: ToolResult;
  forModel: ToolResultForModel;
}

const MEMORY_TOOLS = new Set(['remember', 'forget']);

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return typeof error === 'string' ? error : 'unknown error';
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(cancelledError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

export class ToolRunner {
  readonly records: ToolCallRecord[] = [];
  private readonly options: ToolRunnerOptions;

  constructor(options: ToolRunnerOptions) {
    this.options = options;
  }

  context(): ToolContext {
    return {
      now: new Date(),
      settings: this.options.settings,
      desktop: this.options.desktop,
      signal: this.options.signal,
      chatId: this.options.chatId,
    };
  }

  /** Tools usable right now, with the owner's policy applied. */
  available(): Array<{ tool: ToolDef; policy: 'auto' | 'confirm' }> {
    return listTools(this.context()).map(tool => {
      let policy: 'auto' | 'confirm';
      try {
        policy = resolvePolicy(tool, {}, this.options.settings);
      } catch {
        policy = 'confirm';
      }
      return { tool, policy };
    });
  }

  has(name: string): boolean {
    const tool = findTool(name);
    return !!tool && (tool.available?.(this.context()) ?? true);
  }

  /** True when remember/forget ran successfully this turn (automatic extraction then stands down). */
  get usedMemoryTools(): boolean {
    return this.records.some(record => MEMORY_TOOLS.has(record.name) && record.status === 'done');
  }

  /** Marks calls that never finished (turn stopped) so the UI doesn't show them spinning. */
  finishPending(reason: string): void {
    for (const record of this.records) {
      if (record.status === 'running' || record.status === 'awaiting-approval') {
        record.status = 'error';
        record.error = reason;
        this.emit(record);
      }
    }
  }

  private emit(record: ToolCallRecord): void {
    try {
      this.options.onUpdate({ ...record, args: { ...record.args } });
    } catch {
      // The UI's handler failing must not break the turn.
    }
  }

  /** Convenience for the offline engine: run a tool by name with known-good arguments. */
  run(name: string, args: Record<string, unknown>, vision = false): Promise<ToolOutcome> {
    return this.execute({ id: newId(), name, args }, vision);
  }

  async execute(call: ModelToolCall, vision: boolean): Promise<ToolOutcome> {
    const { settings, signal } = this.options;
    const record: ToolCallRecord = { id: newId(), name: call.name, args: call.args ?? {}, status: 'running' };
    this.records.push(record);
    const fail = (error: string, extra: Record<string, unknown> = {}): ToolOutcome => {
      record.status = 'error';
      record.error = error;
      this.emit(record);
      return { record, forModel: { callId: call.id, name: call.name, payload: { ok: false, error, ...extra }, images: [], isError: true } };
    };

    const ctx = this.context();
    const tool = findTool(call.name);
    if (!tool) return fail(`There is no tool named "${call.name}".`);
    if (!(tool.available?.(ctx) ?? true)) {
      return fail(`${call.name} isn't available here${ctx.desktop ? '' : ' (it needs the Miss Minutes desktop app)'}.`);
    }
    if (call.argsError || !call.args) return fail(call.argsError ?? 'The arguments were missing.');
    const args = call.args;
    if (signal.aborted) return fail('Cancelled before it started.');

    let policy: 'auto' | 'confirm';
    try {
      policy = resolvePolicy(tool, args, settings);
    } catch {
      policy = 'confirm';
    }

    let prepared: ToolPreview | undefined;
    if (policy === 'confirm') {
      try {
        prepared = tool.prepare ? await tool.prepare(args, ctx) : { text: tool.describe(args), risk: 'medium' };
      } catch (error) {
        return fail(`Couldn't prepare this action: ${messageOf(error)}`);
      }
      record.preview = prepared.text;
      record.previewContent = prepared.content;
      record.risk = prepared.risk;
      record.status = 'awaiting-approval';
      this.emit(record);
      let approved = false;
      try {
        approved = (await raceAbort(Promise.resolve(this.options.requestApproval({ ...record, args: { ...args } })), signal)) === true;
      } catch (error) {
        if (isAbortError(error) || signal.aborted) return fail('The turn was stopped before approval.');
        approved = false;
      }
      if (!approved) {
        record.status = 'denied';
        this.emit(record);
        void logActivity('approval', `Declined: ${prepared.text}`.slice(0, 240), { tool: call.name }).catch(() => undefined);
        return {
          record,
          forModel: {
            callId: call.id,
            name: call.name,
            payload: { ok: false, denied: true, summary: 'The owner declined this action. Do not retry it unless they ask again.' },
            images: [],
            isError: true,
          },
        };
      }
      record.status = 'running';
      this.emit(record);
    } else {
      try {
        record.preview = tool.describe(args);
      } catch {
        // A preview is a nicety for 'auto' tools.
      }
      this.emit(record);
    }

    let result: ToolResult;
    try {
      result = await tool.run(args, { ...ctx, now: new Date() }, prepared);
    } catch (error) {
      result = { ok: false, summary: `${call.name} failed: ${messageOf(error)}` };
    }
    if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
      result = { ok: false, summary: `${call.name} returned no result.` };
    }
    record.status = result.ok ? 'done' : 'error';
    record.summary = result.summary;
    record.result = result.data;
    if (result.attachments?.length) record.attachments = result.attachments;
    if (!result.ok) record.error = result.summary;
    this.emit(record);

    const images = (result.attachments ?? []).filter(item => item.kind === 'image');
    const payload = payloadFromResult(result);
    if (images.length > 0 && !vision) {
      payload.note = `${images.length} image${images.length === 1 ? ' was' : 's were'} captured and shown to the owner, but this model can't view images.`;
    }
    return {
      record,
      result,
      forModel: { callId: call.id, name: call.name, payload, images: vision ? images : [], isError: !result.ok },
    };
  }
}

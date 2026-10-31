/**
 * One conversational turn: context, streaming, the tool loop and approvals, cues, and
 * failure handling. runTurn never throws; problems become an 'error' event plus a short
 * in-character reply, and when a provider is down the offline engine still carries out clear
 * requests (timers, reminders, notes...).
 */
import type { CharacterCue, ToolCallRecord } from '../../types';
import { emitCue } from '../../character/cues';
import { isDesktopRuntime } from '../../desktop/bridge';
import { buildDynamicContext } from '../context';
import { scheduleMemoryExtraction } from '../memory/extract';
import { formatMemories, memoriesForTurn } from '../memory/recall';
import { listMemories, searchMemories, upsertMemory } from '../memory/store';
import { defaultModelFor, PROVIDER_LABELS } from '../settings';
import { buildConversation, type ModelToolCall, type ToolResultForModel } from './conversation';
import { CueStreamFilter, inferEmotion } from './cueParser';
import { isAbortError, toProviderError, type ProviderError, type ProviderErrorKind } from './errors';
import { detectIntent, isActionable, respondOffline, type OfflineDeps, type OfflineReply } from './offline/engine';
import { buildInstructions } from './persona';
import { adapterFor } from './providers';
import type { ModelProfile, RoundResult } from './providers/types';
import { ToolRunner } from './toolRunner';
import type { BrainEvent, TurnInput } from './types';

const MAX_ROUNDS = 8;
const MAX_CALLS_PER_ROUND = 8;
const CONTEXT_TIMEOUT_MS = 2_500;

/** Failures after which the offline engine may still act on a clear request. */
const OFFLINE_RESCUE: ReadonlySet<ProviderErrorKind> = new Set([
  'auth', 'permission', 'rate_limit', 'quota', 'usage_limit', 'not_found', 'server', 'unavailable', 'network', 'timeout', 'config', 'protocol',
]);

/** Visible text and events for one turn. Text from later rounds starts a new paragraph. */
class TurnOutput {
  text = '';
  private roundHasText = false;
  private forced: CharacterCue | null = null;
  private readonly send: (event: BrainEvent) => void;
  readonly cues: CueStreamFilter;

  constructor(onEvent: (event: BrainEvent) => void) {
    this.send = event => {
      try {
        onEvent(event);
      } catch {
        // A failing UI handler must not break the turn.
      }
    };
    this.cues = new CueStreamFilter(cue => this.cue(cue));
  }

  private cue(cue: CharacterCue): void {
    this.send({ type: 'cue', cue });
    try {
      emitCue(cue);
    } catch {
      // The character may not be mounted.
    }
  }

  /** A cue chosen by the brain itself (offline replies, failures). */
  forceCue(cue: CharacterCue): void {
    this.forced = { ...this.forced, ...cue };
    this.cue(cue);
  }

  beginRound(): void {
    this.cues.beginRound();
    this.roundHasText = false;
  }

  push(delta: string): void {
    this.visible(this.cues.push(delta));
  }

  endRound(): void {
    this.visible(this.cues.end());
  }

  /** Brain-authored text (fallbacks, offline replies), kept apart from what came before. */
  say(text: string): void {
    this.roundHasText = false;
    this.visible(text);
  }

  private visible(text: string): void {
    if (!text) return;
    let chunk = text;
    if (!this.roundHasText && this.text && !/\s$/.test(this.text)) chunk = `\n\n${chunk}`;
    this.roundHasText = true;
    this.text += chunk;
    this.send({ type: 'text-delta', text: chunk });
  }

  tool(record: ToolCallRecord): void {
    this.send({ type: 'tool', call: record });
  }

  error(message: string, recoverable: boolean): void {
    this.send({ type: 'error', message, recoverable });
  }

  done(model: string): void {
    const chosen = { ...this.cues.latest, ...this.forced };
    const emotion = chosen.emotion ?? inferEmotion(this.text);
    const gesture = chosen.gesture ?? 'none';
    if (this.cues.all.length === 0 && !this.forced && this.text) this.cue({ emotion, gesture });
    this.send({ type: 'done', text: this.text, emotion, gesture, model });
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>(resolve => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(fallback); },
    );
  });
}

function basicContext(now: Date): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const local = now.toLocaleString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `Local time: ${local} (${zone}).`;
}

function offlineDeps(input: TurnInput, runner: ToolRunner): OfflineDeps {
  return {
    now: new Date(),
    settings: input.settings,
    history: input.history,
    tools: {
      has: name => runner.has(name),
      run: (name, args) => runner.run(name, args),
    },
    memory: {
      list: () => listMemories(),
      search: query => searchMemories(query, 5),
      save: async (fact, category) => {
        await upsertMemory(fact, category, 'chat', { chatId: input.chatId });
      },
    },
  };
}

function failureLine(error: ProviderError): string {
  const opener = error.kind === 'usage_limit' || error.kind === 'quota' ? 'Well, I\'ll be.' : error.kind === 'config' ? 'Hold your horses, sugar.' : 'Well, shoot.';
  return `${opener} ${error.message}`;
}

function actionsSummary(records: ToolCallRecord[]): string {
  const done = records.filter(record => record.status === 'done' && record.summary).map(record => record.summary as string);
  const failed = records.filter(record => record.status === 'error').map(record => `${record.name} didn't work (${record.error ?? 'error'})`);
  const declined = records.filter(record => record.status === 'denied').map(record => record.preview ?? record.name);
  const parts: string[] = [];
  if (done.length > 0) parts.push(`All set, sugar: ${done.join('; ')}.`);
  if (declined.length > 0) parts.push(`I left ${declined.length === 1 ? 'that action' : 'those actions'} alone, like you said.`);
  if (failed.length > 0) parts.push(`Heads up: ${failed.join('; ')}.`);
  return parts.join(' ');
}

function blockedResult(call: ModelToolCall, error: string): ToolResultForModel {
  return { callId: call.id, name: call.name, payload: { ok: false, error }, images: [], isError: true };
}

/** Runs a clear, actionable request offline. Returns the reply, or null when the request isn't one. */
async function offlineAction(input: TurnInput, runner: ToolRunner): Promise<OfflineReply | null> {
  const deps = offlineDeps(input, runner);
  const intent = detectIntent(input.user.text, deps.now, input.history);
  if (!isActionable(intent)) return null;
  return respondOffline(input.user.text, deps);
}

async function recover(error: unknown, input: TurnInput, out: TurnOutput, runner: ToolRunner, allowOffline: boolean): Promise<void> {
  const failure = toProviderError(error, PROVIDER_LABELS[input.settings.provider]);
  if (failure.kind === 'cancelled' || input.signal.aborted) return;
  out.error(failure.message, failure.recoverable);
  runner.finishPending('Stopped by an error.');
  let rescued: OfflineReply | null = null;
  if (allowOffline && OFFLINE_RESCUE.has(failure.kind)) {
    try {
      rescued = await offlineAction(input, runner);
    } catch {
      rescued = null;
    }
  }
  if (rescued) {
    out.forceCue({ emotion: rescued.emotion, gesture: rescued.gesture });
    out.say(`${failureLine(failure)} I handled this one with my offline gears:\n\n${rescued.text}`);
    return;
  }
  out.forceCue({ emotion: 'worried', gesture: 'shrug' });
  const done = actionsSummary(runner.records);
  out.say(done ? `${failureLine(failure)} ${done}` : failureLine(failure));
}

async function offlineTurn(input: TurnInput, out: TurnOutput, runner: ToolRunner): Promise<void> {
  const images = (input.user.attachments ?? []).filter(item => item.kind === 'image').length;
  const note = images > 0 ? "I can't look at pictures in offline mode, sugar. Connect a vision model in Settings for that." : '';
  if (!input.user.text.trim() && note) {
    out.forceCue({ emotion: 'worried', gesture: 'shrug' });
    out.say(note);
    return;
  }
  const reply = await respondOffline(input.user.text, offlineDeps(input, runner));
  out.forceCue({ emotion: reply.emotion, gesture: reply.gesture });
  out.say(note ? `${note}\n\n${reply.text}` : reply.text);
}

async function modelTurn(input: TurnInput, out: TurnOutput, runner: ToolRunner, desktop: boolean): Promise<string> {
  const { settings, signal } = input;
  const adapter = adapterFor(settings.provider);
  const fallbackModel = settings.model.trim() || defaultModelFor(settings.provider);
  if (!adapter) {
    await recover(new Error('Unknown provider.'), input, out, runner, true);
    return fallbackModel;
  }

  let profile: ModelProfile;
  try {
    profile = await adapter.profile(settings, 'chat', signal);
  } catch (error) {
    if (isAbortError(error) || signal.aborted) return fallbackModel;
    await recover(error, input, out, runner, true);
    return fallbackModel;
  }

  if (!profile.tools) {
    // No tool calling on this model: clear requests still get done by the offline engine.
    const handled = await offlineAction(input, runner).catch(() => null);
    if (handled) {
      out.forceCue({ emotion: handled.emotion, gesture: handled.gesture });
      out.say(handled.text);
      return profile.model;
    }
  }

  const now = new Date();
  const available = profile.tools ? runner.available() : [];
  const [context, memories] = await Promise.all([
    withTimeout(buildDynamicContext(now), CONTEXT_TIMEOUT_MS, basicContext(now)),
    settings.memoryEnabled === false ? Promise.resolve('') : withTimeout(memoriesForTurn(input.user.text).then(formatMemories), CONTEXT_TIMEOUT_MS, ''),
  ]);
  const instructions = buildInstructions({
    settings,
    tools: available.map(entry => ({ name: entry.tool.name, policy: entry.policy })),
    desktop,
    vision: profile.vision,
    providerLabel: PROVIDER_LABELS[settings.provider],
    model: profile.model,
    context,
    memories,
  });
  const session = adapter.session({
    settings,
    profile,
    instructions,
    conversation: buildConversation(input.history, input.user, profile.vision),
    tools: available.map(entry => ({ name: entry.tool.name, description: entry.tool.description, parameters: entry.tool.parameters })),
    purpose: 'chat',
  });

  let model = profile.model;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    if (signal.aborted) break;
    const last = round === MAX_ROUNDS - 1;
    out.beginRound();
    let result: RoundResult;
    try {
      result = await session.round({ signal, toolChoice: last ? 'none' : 'auto', onText: delta => out.push(delta) });
    } catch (error) {
      out.endRound();
      if (isAbortError(error) || signal.aborted) break;
      await recover(error, input, out, runner, round === 0 && !out.text.trim() && runner.records.length === 0);
      return model;
    }
    out.endRound();
    if (result.model) model = result.model;
    if (result.finish === 'filtered' && result.toolCalls.length === 0) {
      out.error(`${PROVIDER_LABELS[settings.provider]} held back part of this reply.`, true);
      if (!out.text.trim()) {
        out.forceCue({ emotion: 'stern', gesture: 'none' });
        out.say("That's a timeline I can't go down, sugar. Let's try something else.");
      }
    }
    if (result.toolCalls.length === 0 || last) break;

    const results: ToolResultForModel[] = [];
    for (const [index, call] of result.toolCalls.entries()) {
      if (signal.aborted) {
        results.push(blockedResult(call, 'The owner stopped the turn.'));
      } else if (index >= MAX_CALLS_PER_ROUND) {
        results.push(blockedResult(call, `Too many tool calls in one step (limit ${MAX_CALLS_PER_ROUND}). Do the rest in the next step.`));
      } else {
        results.push((await runner.execute(call, profile.vision)).forModel);
      }
    }
    if (signal.aborted) break;
    session.addToolResults(results);
  }

  if (!signal.aborted && !out.text.trim()) {
    const summary = actionsSummary(runner.records);
    out.say(summary || "Well, I'm plumb out of words on that one, sugar. Try asking another way?");
  }
  return model;
}

export async function runTurn(input: TurnInput): Promise<void> {
  const out = new TurnOutput(input.onEvent);
  const desktop = isDesktopRuntime();
  const runner = new ToolRunner({
    settings: input.settings,
    desktop,
    chatId: input.chatId,
    signal: input.signal,
    requestApproval: input.requestApproval,
    onUpdate: record => out.tool(record),
  });
  const offline = input.settings.provider === 'tva-offline';
  let model = offline ? 'tva-offline' : input.settings.model.trim() || defaultModelFor(input.settings.provider);
  try {
    if (!input.signal.aborted) {
      if (offline) await offlineTurn(input, out, runner);
      else model = await modelTurn(input, out, runner, desktop);
    }
  } catch (error) {
    if (!isAbortError(error) && !input.signal.aborted) {
      const failure = toProviderError(error);
      out.error(failure.message, failure.recoverable);
      out.forceCue({ emotion: 'worried', gesture: 'shrug' });
      out.say(`Well, shoot. Something in my gears slipped: ${failure.message}`);
    }
  }
  if (input.signal.aborted) runner.finishPending('Stopped.');
  out.done(model);
  if (!input.signal.aborted && input.settings.memoryEnabled !== false && !runner.usedMemoryTools && out.text.trim()) {
    scheduleMemoryExtraction({ chatId: input.chatId, userText: input.user.text, replyText: out.text, settings: input.settings });
  }
}

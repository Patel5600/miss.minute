/**
 * Ethical AI-disclosed outbound calling tool & guardrails.
 * Enforces strict E.164 syntax, DNC registry, quiet hours (midnight-wrapping), daily cap (5/day),
 * typed fact hygiene (1..=8 facts, <= 140 chars, zero newlines/secrets), Miss Minutes brand voice ONLY,
 * and mandatory upfront AI identity disclosure.
 */
import type { AISettings } from '../../types/index.ts';
import {
  isDesktopRuntime,
  prepareOutboundCall,
  type DesktopCallFact,
} from '../../desktop/bridge.ts';
import {
  androidCallsPrepare,
  androidCallsStart,
  isAndroidApp,
  type PlatformCallFact,
  type PlatformCallFactKind,
} from '../platform.ts';
import { listAll, newId, putRecord, type CallRecord } from '../../store/db.ts';
import { optionalBoolean, optionalText, requiredText, ToolInputError, type RawArgs } from './args.ts';
import { makeTool } from './define.ts';
import type { ToolContext } from './types.ts';

export const DEFAULT_QUIET_START_MIN = 21 * 60;
export const DEFAULT_QUIET_END_MIN = 8 * 60;
export const DEFAULT_MAX_CALLS_PER_DAY = 5;
export const MAX_CALL_FACTS = 8;
export const MAX_FACT_LENGTH = 140;

export const MISS_MINUTES_CALL_VOICE_DESKTOP = 'MissMinutesTva';
export const MISS_MINUTES_CALL_VOICE_ANDROID = 'MISS_MINUTES_TVA';

const FACT_KINDS: readonly PlatformCallFactKind[] = [
  'scheduled_window',
  'booking_name',
  'callback_number',
  'reference_code',
  'brief_topic',
];

const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

export function isValidE164(number: string): boolean {
  return E164_PATTERN.test(number);
}

export function isQuietHour(
  localMinuteOfDay: number,
  policy: { quietStartMin: number; quietEndMin: number; enabled?: boolean } = {
    quietStartMin: DEFAULT_QUIET_START_MIN,
    quietEndMin: DEFAULT_QUIET_END_MIN,
    enabled: true,
  },
): boolean {
  if (policy.enabled === false) return false;
  const m = ((Math.floor(localMinuteOfDay) % 1440) + 1440) % 1440;
  const start = ((Math.floor(policy.quietStartMin) % 1440) + 1440) % 1440;
  const end = ((Math.floor(policy.quietEndMin) % 1440) + 1440) % 1440;
  if (start > end) {
    return m >= start || m < end;
  }
  return m >= start && m < end;
}

export function validateCallFact(fact: PlatformCallFact): PlatformCallFact {
  if (!FACT_KINDS.includes(fact.kind)) {
    throw new ToolInputError(`Unsupported call fact kind "${String(fact.kind)}".`);
  }
  const value = typeof fact.value === 'string' ? fact.value.trim() : '';
  if (!value || value.length > MAX_FACT_LENGTH) {
    throw new ToolInputError(`Call fact "${fact.kind}" must be 1..${MAX_FACT_LENGTH} characters.`);
  }
  if (value.includes('\n') || value.includes('\r') || value.includes('sk-') || value.includes('Bearer ')) {
    throw new ToolInputError(`Call fact "${fact.kind}" contains disallowed line breaks or credential prefixes.`);
  }
  if (fact.kind === 'callback_number' && !isValidE164(value)) {
    throw new ToolInputError('callback_number fact must use strict E.164 format (+[country][number]).');
  }
  return { kind: fact.kind, value };
}

export function buildDisclosureOpening(ownerFirstName?: string): string {
  const cleanName = (ownerFirstName ?? '').replace(/[\r\n]+/g, ' ').trim() || 'the account owner';
  return `Hello, this is Miss Minutes, an automated AI assistant calling on behalf of ${cleanName}. I will only share authorized scheduling details.`;
}

export function toDesktopCallFact(fact: PlatformCallFact): DesktopCallFact {
  switch (fact.kind) {
    case 'scheduled_window':
      return { kind: 'scheduled_window', summary: fact.value };
    case 'booking_name':
      return { kind: 'booking_name', first_name: fact.value };
    case 'callback_number':
      return { kind: 'callback_number', e164: fact.value };
    case 'reference_code':
      return { kind: 'reference_code', code: fact.value };
    case 'brief_topic':
      return { kind: 'brief_topic', topic: fact.value };
  }
}

export function normalizeFactsInput(rawFacts: unknown): PlatformCallFact[] {
  let items: unknown = rawFacts;
  if (typeof items === 'string') {
    try {
      items = JSON.parse(items) as unknown;
    } catch {
      throw new ToolInputError("'facts' must be a JSON array of typed call facts.");
    }
  }
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_CALL_FACTS) {
    throw new ToolInputError(`Outbound calls require between 1 and ${MAX_CALL_FACTS} authorized facts.`);
  }
  return items.map((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ToolInputError(`Fact at index ${idx} must be an object with 'kind' and 'value'.`);
    }
    const obj = item as Record<string, unknown>;
    const kind = typeof obj.kind === 'string' ? obj.kind.trim() as PlatformCallFactKind : ('' as PlatformCallFactKind);
    const value = typeof obj.value === 'string' ? obj.value : '';
    return validateCallFact({ kind, value });
  });
}

export function validateOutboundCallInput(params: {
  destinationE164: string;
  ownerFirstName?: string;
  facts: PlatformCallFact[];
  localMinuteOfDay: number;
  quietHours?: { enabled: boolean; startMin: number; endMin: number };
  dncNumbers?: readonly string[];
  callsPlacedToday?: number;
  maxCallsPerDay?: number;
  ownerConfirmed: boolean;
}): {
  destinationE164: string;
  cleanOwnerName: string;
  normalizedFacts: PlatformCallFact[];
  disclosureOpening: string;
} {
  const dest = params.destinationE164.trim();
  if (!isValidE164(dest)) {
    throw new ToolInputError('destination_e164 must use strict E.164 format (+[country][number], 7-15 digits).');
  }
  const dncSet = new Set((params.dncNumbers ?? []).map(n => n.trim()).filter(Boolean));
  if (dncSet.has(dest)) {
    throw new ToolInputError(`Destination ${dest} is on the Do-Not-Call registry.`);
  }
  if (isQuietHour(params.localMinuteOfDay, {
    quietStartMin: params.quietHours?.startMin ?? DEFAULT_QUIET_START_MIN,
    quietEndMin: params.quietHours?.endMin ?? DEFAULT_QUIET_END_MIN,
    enabled: params.quietHours?.enabled ?? true,
  })) {
    throw new ToolInputError('Quiet hours are active; outbound calling is deferred outside quiet hours.');
  }
  const maxPerDay = params.maxCallsPerDay ?? DEFAULT_MAX_CALLS_PER_DAY;
  if ((params.callsPlacedToday ?? 0) >= maxPerDay) {
    throw new ToolInputError(`Daily outbound call cap (${maxPerDay}/day) reached.`);
  }
  if (!params.facts.length || params.facts.length > MAX_CALL_FACTS) {
    throw new ToolInputError(`Outbound calls require between 1 and ${MAX_CALL_FACTS} authorized facts.`);
  }
  const normalizedFacts = params.facts.map(validateCallFact);
  if (!params.ownerConfirmed) {
    throw new ToolInputError('Explicit owner confirmation is required before preparing or placing an outbound call.');
  }
  const cleanOwnerName = (params.ownerFirstName ?? '').replace(/[\r\n]+/g, ' ').trim() || 'the account owner';
  return {
    destinationE164: dest,
    cleanOwnerName,
    normalizedFacts,
    disclosureOpening: buildDisclosureOpening(cleanOwnerName),
  };
}

export async function listCallHistory(): Promise<CallRecord[]> {
  const rows = await listAll('calls');
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

export async function todayCallCount(now = Date.now()): Promise<number> {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const startMs = start.getTime();
  const rows = await listAll('calls');
  return rows.filter(
    row => row.createdAt >= startMs && !row.dryRun && row.state !== 'draft' && row.state !== 'aborted',
  ).length;
}

export async function prepareAndOptionallyStartCall(
  input: {
    destinationE164: string;
    ownerFirstName?: string;
    facts: PlatformCallFact[];
    dncNumbers?: string[];
    placeCall?: boolean;
  },
  options: {
    settings?: Pick<AISettings, 'dncNumbers' | 'callQuietHoursEnabled' | 'callQuietStartMin' | 'callQuietEndMin'>;
    ownerConfirmed: boolean;
    localMinuteOfDay?: number;
    now?: number;
  },
): Promise<{ record: CallRecord; dailyRemaining: number }> {
  if (!options.ownerConfirmed) {
    throw new ToolInputError('Explicit owner confirmation is required before preparing or placing an outbound call.');
  }
  const now = options.now ?? Date.now();
  const dateNow = new Date(now);
  const minuteOfDay = options.localMinuteOfDay ?? (dateNow.getHours() * 60 + dateNow.getMinutes());
  const combinedDnc = [...(options.settings?.dncNumbers ?? []), ...(input.dncNumbers ?? [])]
    .map(v => v.trim())
    .filter(Boolean);
  const placedToday = await todayCallCount(now);

  const validated = validateOutboundCallInput({
    destinationE164: input.destinationE164,
    ownerFirstName: input.ownerFirstName,
    facts: input.facts,
    localMinuteOfDay: minuteOfDay,
    quietHours: {
      enabled: options.settings?.callQuietHoursEnabled !== false,
      startMin: options.settings?.callQuietStartMin ?? DEFAULT_QUIET_START_MIN,
      endMin: options.settings?.callQuietEndMin ?? DEFAULT_QUIET_END_MIN,
    },
    dncNumbers: combinedDnc,
    callsPlacedToday: placedToday,
    maxCallsPerDay: DEFAULT_MAX_CALLS_PER_DAY,
    ownerConfirmed: options.ownerConfirmed,
  });

  if (isAndroidApp()) {
    const bridgeParams = {
      destinationE164: validated.destinationE164,
      ownerFirstName: validated.cleanOwnerName,
      facts: validated.normalizedFacts,
      dncNumbers: combinedDnc,
    };
    const res = input.placeCall
      ? await androidCallsStart(bridgeParams)
      : await androidCallsPrepare(bridgeParams);

    const record: CallRecord = {
      id: res.callId || newId(),
      callId: res.callId || newId(),
      destinationE164: res.destinationE164,
      callerLabel: res.callerLabel,
      voice: res.voice || MISS_MINUTES_CALL_VOICE_ANDROID,
      disclosureOpening: res.disclosureOpening || validated.disclosureOpening,
      allowedFacts: res.allowedFacts,
      state: (res.state as CallRecord['state']) || 'validated',
      dryRun: res.dryRun,
      createdAt: now,
      updatedAt: now,
    };
    await putRecord('calls', record);
    return { record, dailyRemaining: res.dailyRemaining };
  }

  if (isDesktopRuntime()) {
    const res = await prepareOutboundCall({
      destinationE164: validated.destinationE164,
      ownerFirstName: validated.cleanOwnerName,
      facts: validated.normalizedFacts.map(toDesktopCallFact),
      localMinuteOfDay: minuteOfDay,
      policy: {
        quiet_start_min: options.settings?.callQuietHoursEnabled === false
          ? 0
          : (options.settings?.callQuietStartMin ?? DEFAULT_QUIET_START_MIN),
        quiet_end_min: options.settings?.callQuietHoursEnabled === false
          ? 0
          : (options.settings?.callQuietEndMin ?? DEFAULT_QUIET_END_MIN),
        max_calls_per_day: DEFAULT_MAX_CALLS_PER_DAY,
      },
      dncNumbers: combinedDnc,
      callsPlacedToday: placedToday,
    });

    const record: CallRecord = {
      id: res.call_id,
      callId: res.call_id,
      destinationE164: res.destination_e164,
      callerLabel: res.caller_label,
      voice: res.voice.voice_id || MISS_MINUTES_CALL_VOICE_DESKTOP,
      disclosureOpening: res.disclosure_opening,
      allowedFacts: validated.normalizedFacts,
      state: res.state,
      dryRun: true,
      createdAt: now,
      updatedAt: now,
    };
    await putRecord('calls', record);
    return {
      record,
      dailyRemaining: Math.max(0, DEFAULT_MAX_CALLS_PER_DAY - placedToday),
    };
  }

  const callId = newId();
  const record: CallRecord = {
    id: callId,
    callId,
    destinationE164: validated.destinationE164,
    callerLabel: validated.cleanOwnerName,
    voice: MISS_MINUTES_CALL_VOICE_DESKTOP,
    disclosureOpening: validated.disclosureOpening,
    allowedFacts: validated.normalizedFacts,
    state: 'validated',
    dryRun: true,
    createdAt: now,
    updatedAt: now,
  };
  await putRecord('calls', record);
  return {
    record,
    dailyRemaining: Math.max(0, DEFAULT_MAX_CALLS_PER_DAY - placedToday),
  };
}

function parseDncArg(raw: RawArgs): string[] {
  const value = raw.dnc_numbers;
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ToolInputError("'dnc_numbers' must be an array of E.164 phone numbers.");
  return value.filter((v): v is string => typeof v === 'string').map(v => v.trim()).filter(Boolean);
}

interface PrepareCallArgs {
  destinationE164: string;
  ownerFirstName?: string;
  facts: PlatformCallFact[];
  dncNumbers: string[];
  placeCall: boolean;
}

export const callingTools = [
  makeTool<PrepareCallArgs>({
    name: 'prepare_outbound_call',
    description:
      'Prepares (and on Android optionally starts with native biometric/dialog confirmation) an ethical outbound call '
      + 'using ONLY Miss Minutes brand voice and mandatory upfront AI identity disclosure. Enforces strict E.164 format, '
      + 'quiet hours, Do-Not-Call list, 5/day cap, and typed authorized facts (1..=8). Owner only; always asks first.',
    parameters: {
      type: 'object',
      properties: {
        destination_e164: { type: 'string', description: 'Recipient phone in strict E.164 format, e.g. "+12025550111".' },
        owner_first_name: { type: 'string', description: 'Owner first name for the upfront AI disclosure.' },
        facts: {
          type: 'array',
          description: 'Authorized fact entries (1..=8): { kind: "scheduled_window"|"booking_name"|"callback_number"|"reference_code"|"brief_topic", value: string }.',
          items: { type: 'object' },
        },
        dnc_numbers: {
          type: 'array',
          description: 'Optional extra Do-Not-Call E.164 numbers to enforce.',
          items: { type: 'string' },
        },
        place_call: { type: 'boolean', description: 'Android only: dial via Telecom after native confirmation dialog. Default false (dry-run preview).' },
      },
      required: ['destination_e164', 'facts'],
    },
    policy: 'confirm',
    failure: "Couldn't prepare outbound call",
    available: (ctx: ToolContext) => !ctx.guestMode,
    parse(args) {
      const destinationE164 = requiredText(args, 'destination_e164', 24);
      if (!isValidE164(destinationE164)) {
        throw new ToolInputError('destination_e164 must be strict E.164 format (+[country][number], 7-15 digits).');
      }
      return {
        destinationE164,
        ownerFirstName: optionalText(args, 'owner_first_name', 60),
        facts: normalizeFactsInput(args.facts),
        dncNumbers: parseDncArg(args),
        placeCall: optionalBoolean(args, 'place_call') ?? false,
      };
    },
    describe(args) {
      return `${args.placeCall ? 'Prepare and place' : 'Prepare'} AI-disclosed call to ${args.destinationE164} (${args.facts.length} fact${args.facts.length === 1 ? '' : 's'})`;
    },
    async prepare(args, ctx) {
      const now = Date.now();
      const dateNow = new Date(now);
      const minuteOfDay = dateNow.getHours() * 60 + dateNow.getMinutes();
      const combinedDnc = [...(ctx.settings.dncNumbers ?? []), ...args.dncNumbers];
      const placedToday = await todayCallCount(now);
      const validated = validateOutboundCallInput({
        destinationE164: args.destinationE164,
        ownerFirstName: args.ownerFirstName,
        facts: args.facts,
        localMinuteOfDay: minuteOfDay,
        quietHours: {
          enabled: ctx.settings.callQuietHoursEnabled !== false,
          startMin: ctx.settings.callQuietStartMin ?? DEFAULT_QUIET_START_MIN,
          endMin: ctx.settings.callQuietEndMin ?? DEFAULT_QUIET_END_MIN,
        },
        dncNumbers: combinedDnc,
        callsPlacedToday: placedToday,
        maxCallsPerDay: DEFAULT_MAX_CALLS_PER_DAY,
        ownerConfirmed: true,
      });
      const factLines = validated.normalizedFacts.map(f => `- ${f.kind}: ${f.value}`).join('\n');
      return {
        text: `${args.placeCall ? 'Prepare and dial' : 'Prepare'} outbound call to ${validated.destinationE164} as Miss Minutes (brand voice only).`,
        content: `AI Disclosure Opening:\n"${validated.disclosureOpening}"\n\nAuthorized Facts (${validated.normalizedFacts.length}):\n${factLines}`,
        risk: 'high',
      };
    },
    async run(args, ctx, prepared) {
      const ownerConfirmed = prepared !== undefined;
      const { record, dailyRemaining } = await prepareAndOptionallyStartCall(
        {
          destinationE164: args.destinationE164,
          ownerFirstName: args.ownerFirstName,
          facts: args.facts,
          dncNumbers: args.dncNumbers,
          placeCall: args.placeCall,
        },
        {
          settings: ctx.settings,
          ownerConfirmed,
        },
      );
      return {
        ok: true,
        summary: `${record.dryRun ? 'Prepared' : 'Initiated'} call to ${record.destinationE164} (${record.voice})`,
        data: {
          call_id: record.callId,
          destination_e164: record.destinationE164,
          voice: record.voice,
          disclosure_opening: record.disclosureOpening,
          allowed_facts: record.allowedFacts,
          state: record.state,
          dry_run: record.dryRun,
          daily_remaining: dailyRemaining,
        },
      };
    },
  }),
];

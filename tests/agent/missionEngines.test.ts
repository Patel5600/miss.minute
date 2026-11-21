import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyMcpReclassification,
  parseMcpToolJson,
} from '../../src/agent/tools/connectors.ts';
import {
  executeMissionDagLocal,
  normalizeMissionNodes,
  validateMissionDag,
} from '../../src/agent/tools/missions.ts';
import {
  evaluateOffer,
  rankOffersLocal,
} from '../../src/agent/tools/offers.ts';
import {
  findFreeSlotsLocal,
  mergeBusyIntervals,
} from '../../src/agent/tools/availability.ts';
import {
  MISS_MINUTES_CALL_VOICE_ANDROID,
  buildDisclosureOpening,
  callingTools,
  isQuietHour,
  isValidE164,
  prepareAndOptionallyStartCall,
  validateCallFact,
  validateOutboundCallInput,
} from '../../src/agent/tools/calling.ts';
import { openHttpStream, readMessages } from '../../src/agent/brain/transport.ts';
import { ProviderError } from '../../src/agent/brain/errors.ts';
import { anthropicAdapter } from '../../src/agent/brain/providers/anthropic.ts';
import { geminiAdapter } from '../../src/agent/brain/providers/gemini.ts';
import { forgetCredentialCache } from '../../src/agent/brain/providers/auth.ts';
import {
  defaultSettings,
  hasProviderKey,
  isProviderKeyRemembered,
  removeProviderKey,
  saveProviderKey,
  setProviderKeyRemembered,
} from '../../src/agent/settings.ts';
import type { OfferListing } from '../../src/desktop/bridge.ts';

interface MockPort {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage: (raw: string) => void;
}

async function withAndroidEnvironment(
  handler: (msg: { v?: number; id: string; type: string; payload: Record<string, unknown> }, emit: (msg: unknown) => void, raw: string) => void,
  fn: (sentMessages: Array<{ raw: string; parsed: { id: string; type: string; payload: Record<string, unknown> } }>, localStore: Map<string, string>) => Promise<void>,
): Promise<void> {
  const root = globalThis as unknown as Record<string, unknown>;
  const prevWindow = root.window;
  const prevStorage = root.localStorage;
  const localStore = new Map<string, string>();
  const sentMessages: Array<{ raw: string; parsed: { id: string; type: string; payload: Record<string, unknown> } }> = [];

  const port: MockPort = {
    onmessage: null,
    postMessage(raw: string) {
      const parsed = JSON.parse(raw) as { v?: number; id: string; type: string; payload: Record<string, unknown> };
      sentMessages.push({ raw, parsed });
      const emit = (payload: unknown) => {
        queueMicrotask(() => {
          port.onmessage?.({ data: JSON.stringify(payload) });
        });
      };
      handler(parsed, emit, raw);
    },
  };

  const memoryStorage: Storage = {
    get length() { return localStore.size; },
    clear() { localStore.clear(); },
    getItem(key: string) { return localStore.has(key) ? (localStore.get(key) ?? null) : null; },
    key(index: number) { return [...localStore.keys()][index] ?? null; },
    removeItem(key: string) { localStore.delete(key); },
    setItem(key: string, value: string) { localStore.set(key, value); },
  };

  root.localStorage = memoryStorage;
  root.window = {
    location: {
      hostname: 'dashboard.missminutes.local',
      origin: 'https://dashboard.missminutes.local',
      pathname: '/assets/web/dashboard.html',
    },
    missNative: port,
    dispatchEvent: () => true,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  forgetCredentialCache();

  try {
    await fn(sentMessages, localStore);
  } finally {
    forgetCredentialCache();
    if (prevWindow === undefined) delete root.window;
    else root.window = prevWindow;
    if (prevStorage === undefined) delete root.localStorage;
    else root.localStorage = prevStorage;
  }
}

// ── Connectors ───────────────────────────────────────────────────────────────

test('connectors enforce untrusted external floor, escalate destructive/financial keywords, and block financial downgrades', () => {
  const readOnlyClaim = parseMcpToolJson(
    'docs-server',
    JSON.stringify({ name: 'fetch_docs', description: 'Lookup public manual pages', readOnlyHint: true }),
  );
  assert.equal(readOnlyClaim.id, 'mcp:docs-server:fetch_docs');
  assert.equal(readOnlyClaim.trusted_builtin, false);
  assert.equal(readOnlyClaim.derived_side_effect, 'external');
  assert.equal(readOnlyClaim.owner_approved_reclassification, false);

  const destructive = parseMcpToolJson(
    'cleanup-srv',
    JSON.stringify({ name: 'purge_logs', description: 'Delete expired archive entries', readOnlyHint: true }),
  );
  assert.equal(destructive.derived_side_effect, 'destructive');

  const financial = parseMcpToolJson(
    'billing-srv',
    JSON.stringify({ name: 'send_wire', description: 'Execute wire transfer payment', readOnlyHint: true }),
  );
  assert.equal(financial.derived_side_effect, 'financial');

  assert.throws(() => parseMcpToolJson(' ', '{"name":"x"}'), /empty_server_or_tool_name/);
  assert.throws(() => parseMcpToolJson('srv', '{"description":"missing"}'), /empty_server_or_tool_name/);
  assert.throws(() => parseMcpToolJson('srv', '{invalid-json'), /malformed_json/);

  assert.throws(
    () => applyMcpReclassification(readOnlyClaim, 'local_write', false),
    /explicit owner confirmation is required/,
  );

  for (const lowerTier of ['destructive', 'external', 'local_write', 'read_only'] as const) {
    assert.throws(
      () => applyMcpReclassification(financial, lowerTier, true),
      /cannot_downgrade_financial_tool/,
    );
  }

  const reclassified = applyMcpReclassification(readOnlyClaim, 'local_write', true);
  assert.equal(reclassified.derived_side_effect, 'local_write');
  assert.equal(reclassified.owner_approved_reclassification, true);
});

// ── Missions ─────────────────────────────────────────────────────────────────

test('missions validate bounded DAGs, reject cycles/depth>8, retry with checkpoints, block financial nodes, and honor AbortSignal', async () => {
  const normalized = normalizeMissionNodes([
    { id: 'a', max_retries: -5, side_effect: 'read_only' },
    { id: 'b', depends_on: ['a'], max_retries: 99, side_effect: 'local_write' },
  ]);
  assert.equal(normalized[0]?.max_retries, 0);
  assert.equal(normalized[1]?.max_retries, 3);

  assert.throws(() => normalizeMissionNodes([]), /between 1 and 32/);
  const tooMany = Array.from({ length: 33 }, (_, i) => ({ id: `n${i}` }));
  assert.throws(() => normalizeMissionNodes(tooMany), /between 1 and 32/);

  assert.throws(
    () => validateMissionDag({
      mission_id: 'dup',
      goal: 'dup test',
      nodes: [
        { id: 'a', title: 'A', depends_on: [], action_kind: 't', side_effect: 'read_only', max_retries: 0 },
        { id: 'a', title: 'A2', depends_on: [], action_kind: 't', side_effect: 'read_only', max_retries: 0 },
      ],
    }),
    /Duplicate/,
  );

  assert.throws(
    () => validateMissionDag({
      mission_id: 'unk',
      goal: 'unknown dep',
      nodes: [
        { id: 'a', title: 'A', depends_on: ['missing'], action_kind: 't', side_effect: 'read_only', max_retries: 0 },
      ],
    }),
    /unknown node "missing"/,
  );

  assert.throws(
    () => validateMissionDag({
      mission_id: 'cyc',
      goal: 'cycle',
      nodes: [
        { id: 'a', title: 'A', depends_on: ['b'], action_kind: 't', side_effect: 'read_only', max_retries: 0 },
        { id: 'b', title: 'B', depends_on: ['a'], action_kind: 't', side_effect: 'read_only', max_retries: 0 },
      ],
    }),
    /cycle/,
  );

  const deep9 = Array.from({ length: 9 }, (_, i) => ({
    id: `d${i}`,
    title: `D${i}`,
    depends_on: i === 0 ? [] : [`d${i - 1}`],
    action_kind: 't',
    side_effect: 'read_only' as const,
    max_retries: 0,
  }));
  assert.throws(() => validateMissionDag({ mission_id: 'deep', goal: 'depth 9', nodes: deep9 }), /maximum dependency depth 8/);

  const order = validateMissionDag({
    mission_id: 'diamond',
    goal: 'diamond',
    nodes: [
      { id: 'merge', title: 'M', depends_on: ['left', 'right'], action_kind: 't', side_effect: 'read_only', max_retries: 0 },
      { id: 'left', title: 'L', depends_on: ['root'], action_kind: 't', side_effect: 'read_only', max_retries: 0 },
      { id: 'right', title: 'R', depends_on: ['root'], action_kind: 't', side_effect: 'read_only', max_retries: 0 },
      { id: 'root', title: 'Root', depends_on: [], action_kind: 't', side_effect: 'read_only', max_retries: 0 },
    ],
  });
  assert.equal(order[0], 'root');
  assert.equal(order[3], 'merge');

  const seen: Array<{ id: string; attempt: number }> = [];
  const report = await executeMissionDagLocal(
    {
      mission_id: 'retry-ok',
      goal: 'retry step b',
      nodes: [
        { id: 'a', title: 'A', depends_on: [], action_kind: 'search', side_effect: 'read_only', max_retries: 0 },
        { id: 'b', title: 'B', depends_on: ['a'], action_kind: 'save', side_effect: 'local_write', max_retries: 2 },
      ],
    },
    async (node, attempt) => {
      seen.push({ id: node.id, attempt });
      if (node.id === 'b' && attempt < 3) throw new Error(`transient-${attempt}`);
      return `ok-${node.id}-${attempt}`;
    },
  );
  assert.equal(report.completed, true);
  assert.deepEqual(seen, [
    { id: 'a', attempt: 1 },
    { id: 'b', attempt: 1 },
    { id: 'b', attempt: 2 },
    { id: 'b', attempt: 3 },
  ]);
  assert.equal(report.checkpoints[1]?.attempts, 3);
  assert.equal(report.checkpoints[1]?.status, 'succeeded');

  await assert.rejects(
    () => executeMissionDagLocal({
      mission_id: 'fin',
      goal: 'financial step blocked',
      nodes: [
        { id: 'pay', title: 'Pay', depends_on: [], action_kind: 'transfer', side_effect: 'financial', max_retries: 0 },
      ],
    }),
    /financial side-effect/,
  );

  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => executeMissionDagLocal({
      mission_id: 'abort',
      goal: 'aborted',
      nodes: [{ id: 'a', title: 'A', depends_on: [], action_kind: 't', side_effect: 'read_only', max_retries: 0 }],
    }, undefined, ac.signal),
    (err: unknown) => err instanceof DOMException && err.name === 'AbortError',
  );
});

// ── Offers ───────────────────────────────────────────────────────────────────

function sampleOffer(over: Partial<OfferListing> & { signals?: Partial<OfferListing['signals']> } = {}): OfferListing {
  return {
    id: over.id ?? 'offer-1',
    title: over.title ?? 'Standard Workstation GPU Plan',
    source_domain: over.source_domain ?? 'verifiedvendor.example',
    fit_score: over.fit_score ?? 80,
    clarity_score: over.clarity_score ?? 70,
    base_legitimacy_score: over.base_legitimacy_score ?? 80,
    signals: {
      verified_domain: true,
      requires_upfront_fee_or_wire: false,
      asks_off_platform_payment: false,
      typosquatted_or_suspicious_url: false,
      impossible_roi_or_urgency_pressure: false,
      opaque_contact_or_masked_redirect: false,
      transparent_terms_present: true,
      ...over.signals,
    },
  };
}

test('offers reject hard scam flags/keywords with score 0 and rank legitimate offers by exact 50/35/15 math', () => {
  const flagCases: Array<keyof OfferListing['signals']> = [
    'requires_upfront_fee_or_wire',
    'asks_off_platform_payment',
    'typosquatted_or_suspicious_url',
    'impossible_roi_or_urgency_pressure',
    'opaque_contact_or_masked_redirect',
  ];

  for (const flag of flagCases) {
    const evaluated = evaluateOffer(sampleOffer({
      id: `scam-${flag}`,
      fit_score: 100,
      clarity_score: 100,
      base_legitimacy_score: 100,
      signals: { [flag]: true },
    }));
    assert.equal(evaluated.rejected_as_scam, true);
    assert.equal(evaluated.total_score, 0);
    assert.ok(evaluated.scam_flags.length >= 1);
  }

  for (const badTitle of ['Cloud Deal WIRE ONLY!', 'Pay via Gift Card fast', 'Guaranteed 500% return today']) {
    const scamByTitle = evaluateOffer(sampleOffer({ id: 'title-scam', title: badTitle }));
    assert.equal(scamByTitle.rejected_as_scam, true);
    assert.equal(scamByTitle.total_score, 0);
  }

  const verifiedOffer = sampleOffer({
    id: 'legit-verified',
    base_legitimacy_score: 80, // +10 verified +5 transparent = 95 => 0.50*95 = 47.5
    fit_score: 80,             // 0.35*80 = 28.0
    clarity_score: 60,         // 0.15*60 = 9.0 -> total 84.5
    signals: { verified_domain: true, transparent_terms_present: true },
  });
  const evalVerified = evaluateOffer(verifiedOffer);
  assert.equal(evalVerified.rejected_as_scam, false);
  assert.equal(evalVerified.legitimacy_component, 47.5);
  assert.equal(evalVerified.fit_component, 28);
  assert.equal(evalVerified.clarity_component, 9);
  assert.equal(evalVerified.total_score, 84.5);

  const unverifiedOffer = sampleOffer({
    id: 'legit-unverified',
    base_legitimacy_score: 80, // -15 unverified +0 transparent = 65 => 0.50*65 = 32.5
    fit_score: 100,            // 35.0
    clarity_score: 100,        // 15.0 -> total 82.5
    signals: { verified_domain: false, transparent_terms_present: false },
  });
  const evalUnverified = evaluateOffer(unverifiedOffer);
  assert.equal(evalUnverified.total_score, 82.5);

  const ranked = rankOffersLocal([
    sampleOffer({ id: 'scam-high-fit', title: 'Wire only rush', fit_score: 100, clarity_score: 100 }),
    unverifiedOffer,
    verifiedOffer,
  ]);
  assert.deepEqual(ranked.map(r => r.id), ['legit-verified', 'legit-unverified', 'scam-high-fit']);
  assert.equal(ranked[2]?.rejected_as_scam, true);
});

// ── Availability ─────────────────────────────────────────────────────────────

test('availability merges overlapping/adjacent busy intervals and finds exact clipped free slots', () => {
  const merged = mergeBusyIntervals([
    { start_epoch_min: 100, end_epoch_min: 120, label: 'C' },
    { start_epoch_min: 50, end_epoch_min: 50, label: 'zero' },
    { start_epoch_min: 10, end_epoch_min: 30, label: 'A' },
    { start_epoch_min: 30, end_epoch_min: 45, label: 'B' },
    { start_epoch_min: 20, end_epoch_min: 60, label: 'Overlap' },
  ]);
  assert.deepEqual(
    merged.map(m => [m.start_epoch_min, m.end_epoch_min]),
    [[10, 60], [100, 120]],
  );

  const slots = findFreeSlotsLocal(
    [
      { start_epoch_min: 480, end_epoch_min: 540, label: 'Morning' },
      { start_epoch_min: 600, end_epoch_min: 620, label: 'Standup' },
      { start_epoch_min: 635, end_epoch_min: 720, label: 'Deep work' },
    ],
    500, // clips inside Morning (480-540)
    800,
    30,
  );
  // 540..600 (60m), 620..635 (15m skipped < 30m), 720..800 (80m)
  assert.deepEqual(slots.free_slots, [
    { start_epoch_min: 540, end_epoch_min: 600, duration_minutes: 60 },
    { start_epoch_min: 720, end_epoch_min: 800, duration_minutes: 80 },
  ]);
  assert.match(slots.summary_sentence, /2 open window\(s\) totaling 140 minutes/);

  const fullDay = findFreeSlotsLocal([{ start_epoch_min: 0, end_epoch_min: 1000, label: 'Booked' }], 100, 500, 15);
  assert.equal(fullDay.free_slots.length, 0);
  assert.match(fullDay.summary_sentence, /No openings/);
});

// ── Outbound Calling Guardrails ──────────────────────────────────────────────

test('calling guardrails validate E.164, quiet hours midnight wrap, fact hygiene, AI disclosure, daily cap, and fail-closed confirmation', async () => {
  assert.equal(isValidE164('+12025550111'), true);
  assert.equal(isValidE164('+442079460958'), true);
  assert.equal(isValidE164('12025550111'), false);
  assert.equal(isValidE164('+02025550111'), false);
  assert.equal(isValidE164('+1202-555-0111'), false);
  assert.equal(isValidE164('+12345'), false);

  // Midnight-wrapping quiet hours: 21:00 (1260) -> 08:00 (480)
  assert.equal(isQuietHour(22 * 60), true);
  assert.equal(isQuietHour(0), true);
  assert.equal(isQuietHour(7 * 60 + 59), true);
  assert.equal(isQuietHour(8 * 60), false);
  assert.equal(isQuietHour(20 * 60 + 59), false);
  assert.equal(isQuietHour(23 * 60, { quietStartMin: 21 * 60, quietEndMin: 8 * 60, enabled: false }), false);
  assert.equal(isQuietHour(13 * 60 + 30, { quietStartMin: 13 * 60, quietEndMin: 15 * 60, enabled: true }), true);

  assert.deepEqual(
    validateCallFact({ kind: 'booking_name', value: '  Irshad  ' }),
    { kind: 'booking_name', value: 'Irshad' },
  );
  assert.throws(() => validateCallFact({ kind: 'brief_topic', value: 'line1\nline2' }), /disallowed/);
  assert.throws(() => validateCallFact({ kind: 'brief_topic', value: 'token sk-abc12345' }), /disallowed/);
  assert.throws(() => validateCallFact({ kind: 'brief_topic', value: 'Bearer xyz123' }), /disallowed/);
  assert.throws(() => validateCallFact({ kind: 'brief_topic', value: 'x'.repeat(141) }), /1..140/);
  assert.throws(() => validateCallFact({ kind: 'callback_number', value: '555-0111' }), /strict E\.164/);

  const disclosure = buildDisclosureOpening('Irshad\nPatel');
  assert.match(disclosure, /Miss Minutes/);
  assert.match(disclosure, /automated AI assistant/);
  assert.doesNotMatch(disclosure, /\n/);

  const baseParams = {
    destinationE164: '+12025550111',
    ownerFirstName: 'Irshad',
    facts: [{ kind: 'brief_topic' as const, value: 'Reschedule Friday checkup' }],
    localMinuteOfDay: 14 * 60,
    dncNumbers: ['+12025550999'],
    callsPlacedToday: 0,
    ownerConfirmed: true,
  };
  assert.equal(validateOutboundCallInput(baseParams).destinationE164, '+12025550111');
  assert.throws(() => validateOutboundCallInput({ ...baseParams, destinationE164: '+12025550999' }), /Do-Not-Call/);
  assert.throws(() => validateOutboundCallInput({ ...baseParams, localMinuteOfDay: 22 * 60 }), /Quiet hours/);
  assert.throws(() => validateOutboundCallInput({ ...baseParams, callsPlacedToday: 5 }), /5\/day/);
  assert.throws(
    () => validateOutboundCallInput({
      ...baseParams,
      facts: Array.from({ length: 9 }, (_, i) => ({ kind: 'brief_topic' as const, value: `f${i}` })),
    }),
    /1 and 8/,
  );
  assert.throws(() => validateOutboundCallInput({ ...baseParams, ownerConfirmed: false }), /Explicit owner confirmation/);

  // callingTools[0].run refuses execution cleanly when `prepared` is undefined.
  const callTool = callingTools[0];
  assert.ok(callTool);
  const directRunResult = await callTool.run(
    {
      destination_e164: '+12025550111',
      owner_first_name: 'Irshad',
      facts: [{ kind: 'brief_topic', value: 'Confirm Tuesday 2pm' }],
    },
    {
      settings: { ...defaultSettings(), callQuietHoursEnabled: false },
      guestMode: false,
      signal: new AbortController().signal,
    },
    undefined,
  );
  assert.equal(directRunResult.ok, false);
  assert.match(directRunResult.summary, /Explicit owner confirmation is required/);

  // In Android mode, prepareAndOptionallyStartCall sends calls.prepare / calls.start and persists to owner.store.
  await withAndroidEnvironment((msg, emit) => {
    if (msg.type === 'owner.store') {
      emit({ v: 1, type: 'reply', id: msg.id, ok: true, payload: { data: [] } });
      return;
    }
    if (msg.type === 'calls.prepare') {
      emit({
        v: 1,
        type: 'reply',
        id: msg.id,
        ok: true,
        payload: {
          callId: 'call-android-1',
          destinationE164: msg.payload.destinationE164,
          callerLabel: 'Irshad',
          voice: MISS_MINUTES_CALL_VOICE_ANDROID,
          disclosureOpening: buildDisclosureOpening('Irshad'),
          allowedFacts: msg.payload.facts,
          state: 'validated',
          dryRun: true,
          dailyRemaining: 4,
        },
      });
    }
  }, async (sent) => {
    const out = await prepareAndOptionallyStartCall(
      {
        destinationE164: '+12025550111',
        ownerFirstName: 'Irshad',
        facts: [{ kind: 'brief_topic', value: 'Confirm appointment' }],
      },
      {
        settings: { ...defaultSettings(), callQuietHoursEnabled: false },
        ownerConfirmed: true,
        localMinuteOfDay: 14 * 60,
      },
    );
    assert.equal(out.record.voice, MISS_MINUTES_CALL_VOICE_ANDROID);
    assert.equal(out.record.dryRun, true);
    assert.ok(sent.some(m => m.parsed.type === 'calls.prepare'));
    assert.ok(sent.some(m => m.parsed.type === 'owner.store' && m.parsed.payload.op === 'put'));

    const beforeUnconfirmedCount = sent.length;
    const unconfirmedAndroid = await callTool.run(
      {
        destination_e164: '+12025550111',
        owner_first_name: 'Irshad',
        facts: [{ kind: 'brief_topic', value: 'Confirm appointment' }],
      },
      {
        settings: { ...defaultSettings(), callQuietHoursEnabled: false },
        guestMode: false,
        signal: new AbortController().signal,
      },
      undefined,
    );
    assert.equal(unconfirmedAndroid.ok, false);
    assert.match(unconfirmedAndroid.summary, /Explicit owner confirmation is required/);
    const afterMessages = sent.slice(beforeUnconfirmedCount);
    assert.equal(afterMessages.some(m => m.parsed.type === 'calls.prepare' || m.parsed.type === 'calls.start'), false);
  });
});

// ── Android Native Bridge Security & Streaming ───────────────────────────────

test('Android openHttpStream drops secretHeaders, streams chunks, maps owner_auth_required to auth error, and sends cancel on abort', async () => {
  await withAndroidEnvironment((msg, emit) => {
    if (msg.type === 'provider.http.stream') {
      const requestId = String(msg.payload.requestId);
      emit({ v: 1, type: 'reply', id: msg.id, ok: true, payload: {} });
      emit({ v: 1, type: 'event', name: 'provider.event', payload: { requestId, event: 'start', status: 200, headers: { 'content-type': 'text/event-stream' } } });
      emit({ v: 1, type: 'event', name: 'provider.event', payload: { requestId, event: 'chunk', data: 'data: {"part":1}\n\n' } });
      emit({ v: 1, type: 'event', name: 'provider.event', payload: { requestId, event: 'done', status: 200 } });
    }
  }, async (sent) => {
    const stream = await openHttpStream({
      provider: 'openai',
      url: 'https://api.openai.com/v1/responses',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      secretHeaders: { Authorization: 'Bearer sk-must-stay-out-of-webview-bridge' },
      body: '{"input":"hi"}',
    });
    assert.equal(stream.ok, true);
    const events: string[] = [];
    for await (const ev of readMessages(stream)) {
      events.push(ev.data);
    }
    assert.deepEqual(events, ['{"part":1}']);

    const streamCall = sent.find(m => m.parsed.type === 'provider.http.stream');
    assert.ok(streamCall);
    assert.doesNotMatch(streamCall.raw, /sk-must-stay-out-of-webview-bridge/);
    assert.doesNotMatch(streamCall.raw, /Authorization/);
  });

  // owner_auth_required -> ProviderError('auth')
  await withAndroidEnvironment((msg, emit) => {
    if (msg.type === 'provider.http.stream') {
      const requestId = String(msg.payload.requestId);
      emit({ v: 1, type: 'reply', id: msg.id, ok: true, payload: {} });
      emit({
        v: 1,
        type: 'event',
        name: 'provider.event',
        payload: { requestId, event: 'error', code: 'owner_auth_required', message: 'Biometric owner unlock required' },
      });
    }
  }, async () => {
    await assert.rejects(
      () => openHttpStream({ provider: 'openai', url: 'https://api.openai.com/v1/models', method: 'GET' }),
      (err: unknown) => err instanceof ProviderError && err.kind === 'auth' && err.code === 'owner_auth_required',
    );
  });

  // AbortSignal sends provider.http.cancel and cancels stream cleanly
  await withAndroidEnvironment((msg, emit) => {
    if (msg.type === 'provider.http.stream') {
      const requestId = String(msg.payload.requestId);
      emit({ v: 1, type: 'reply', id: msg.id, ok: true, payload: {} });
      emit({ v: 1, type: 'event', name: 'provider.event', payload: { requestId, event: 'start', status: 200, headers: { 'content-type': 'text/event-stream' } } });
      return;
    }
    if (msg.type === 'provider.http.cancel') {
      emit({ v: 1, type: 'reply', id: msg.id, ok: true, payload: {} });
    }
  }, async (sent) => {
    const controller = new AbortController();
    const stream = await openHttpStream({
      provider: 'openai',
      url: 'https://api.openai.com/v1/responses',
      method: 'POST',
      body: '{}',
      signal: controller.signal,
    });
    const iter = stream.chunks();
    const pendingRead = iter.next();
    controller.abort();
    await assert.rejects(
      () => pendingRead,
      (err: unknown) => err instanceof ProviderError && err.kind === 'cancelled',
    );
    assert.ok(sent.some(m => m.parsed.type === 'provider.http.cancel'));
  });
});

test('Android settings route provider secrets through provider.secret.* bridge with zero localStorage persistence', async () => {
  const keystore = new Map<string, { value: string; remembered: boolean }>();

  await withAndroidEnvironment((msg, emit) => {
    const provider = String(msg.payload.provider ?? '');
    if (msg.type === 'provider.secret.set') {
      keystore.set(provider, { value: String(msg.payload.value ?? ''), remembered: msg.payload.remember !== false });
      emit({ v: 1, type: 'reply', id: msg.id, ok: true, payload: { present: true } });
    } else if (msg.type === 'provider.secret.status') {
      const entry = keystore.get(provider);
      emit({ v: 1, type: 'reply', id: msg.id, ok: true, payload: { present: Boolean(entry), remembered: Boolean(entry?.remembered) } });
    } else if (msg.type === 'provider.secret.remember') {
      const entry = keystore.get(provider);
      if (entry) entry.remembered = msg.payload.remember === true;
      emit({ v: 1, type: 'reply', id: msg.id, ok: true, payload: { present: Boolean(entry), remembered: Boolean(entry?.remembered) } });
    } else if (msg.type === 'provider.secret.remove') {
      keystore.delete(provider);
      emit({ v: 1, type: 'reply', id: msg.id, ok: true, payload: { present: false } });
    }
  }, async (sent, localStore) => {
    await saveProviderKey('anthropic', 'sk-ant-android-secret', { remember: true });
    assert.equal(await hasProviderKey('anthropic'), true);
    assert.equal(await isProviderKeyRemembered('anthropic'), true);
    assert.equal(await setProviderKeyRemembered('anthropic', false), false);
    assert.equal(await isProviderKeyRemembered('anthropic'), false);
    await removeProviderKey('anthropic');
    assert.equal(await hasProviderKey('anthropic'), false);

    assert.equal(localStore.size, 0, 'No secrets may be persisted in WebView localStorage');
    assert.deepEqual(
      sent.map(m => m.parsed.type),
      [
        'provider.secret.set',
        'provider.secret.status',
        'provider.secret.status',
        'provider.secret.remember',
        'provider.secret.status',
        'provider.secret.remove',
        'provider.secret.status',
      ],
    );
  });
});

test('Anthropic and Gemini adapters never emit direct browser access headers or API keys over the Android bridge', async () => {
  await withAndroidEnvironment((msg, emit) => {
    if (msg.type === 'provider.secret.status') {
      emit({ v: 1, type: 'reply', id: msg.id, ok: true, payload: { present: true, remembered: true } });
      return;
    }
    if (msg.type === 'provider.http.stream') {
      const requestId = String(msg.payload.requestId);
      const provider = String(msg.payload.provider);
      emit({ v: 1, type: 'reply', id: msg.id, ok: true, payload: {} });
      emit({ v: 1, type: 'event', name: 'provider.event', payload: { requestId, event: 'start', status: 200, headers: { 'content-type': 'text/event-stream' } } });

      if (provider === 'anthropic') {
        emit({
          v: 1,
          type: 'event',
          name: 'provider.event',
          payload: {
            requestId,
            event: 'chunk',
            data: [
              'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-5-5"}}\n\n',
              'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
              'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Howdy from Claude"}}\n\n',
              'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
              'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
              'event: message_stop\ndata: {"type":"message_stop"}\n\n',
            ].join(''),
          },
        });
      } else if (provider === 'gemini') {
        emit({
          v: 1,
          type: 'event',
          name: 'provider.event',
          payload: {
            requestId,
            event: 'chunk',
            data: 'data: {"modelVersion":"gemini-3.8-flash","candidates":[{"content":{"parts":[{"text":"All clear from Gemini"}]},"finishReason":"STOP"}]}\n\n',
          },
        });
      }
      emit({ v: 1, type: 'event', name: 'provider.event', payload: { requestId, event: 'done', status: 200 } });
    }
  }, async (sent) => {
    const settings = { ...defaultSettings(), apiKey: 'sk-ant-should-be-ignored-by-native-path' };

    const antProfile = await anthropicAdapter.profile({ ...settings, provider: 'anthropic', model: 'claude-sonnet-5-5' }, 'chat');
    let antOut = '';
    const antRes = await anthropicAdapter.session({
      profile: antProfile,
      settings: { ...settings, provider: 'anthropic' },
      conversation: [{ role: 'user', text: 'Ping', images: [] }],
      instructions: { stable: 'Be concise.', dynamic: '' },
      tools: [],
      purpose: 'chat',
    }).round({
      toolChoice: 'auto',
      onText: delta => { antOut += delta; },
      signal: new AbortController().signal,
    });
    assert.equal(antOut, 'Howdy from Claude');
    assert.equal(antRes.finish, 'stop');

    const gemProfile = await geminiAdapter.profile({ ...settings, provider: 'gemini', model: 'gemini-3.8-flash' }, 'chat');
    let gemOut = '';
    const gemRes = await geminiAdapter.session({
      profile: gemProfile,
      settings: { ...settings, provider: 'gemini' },
      conversation: [{ role: 'user', text: 'Ping', images: [] }],
      instructions: { stable: 'Be concise.', dynamic: '' },
      tools: [],
      purpose: 'chat',
    }).round({
      toolChoice: 'auto',
      onText: delta => { gemOut += delta; },
      signal: new AbortController().signal,
    });
    assert.equal(gemOut, 'All clear from Gemini');
    assert.equal(gemRes.finish, 'stop');

    const streamRequests = sent.filter(m => m.parsed.type === 'provider.http.stream');
    assert.equal(streamRequests.length, 2);
    for (const req of streamRequests) {
      const headers = req.parsed.payload.headers as Record<string, string>;
      const url = String(req.parsed.payload.url);
      assert.equal(headers['anthropic-dangerous-direct-browser-access'], undefined);
      assert.equal(headers['x-api-key'], undefined);
      assert.equal(headers['x-goog-api-key'], undefined);
      assert.doesNotMatch(url, /[?&]key=/i);
      assert.doesNotMatch(req.raw, /anthropic-dangerous-direct-browser-access/);
      assert.doesNotMatch(req.raw, /sk-ant-should-be-ignored/);
    }
  });
});

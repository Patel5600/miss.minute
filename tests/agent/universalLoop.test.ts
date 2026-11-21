import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MAX_REPAIR_PASSES,
  LoopTracker,
  extractJsonObject,
  repairAndParseJson,
} from '../../src/agent/brain/universalLoop.ts';
import {
  getClientTelemetrySnapshot,
  incrementCounter,
  measureLatency,
  recordLatency,
  resetTelemetry,
  setQueueDepth,
} from '../../src/agent/telemetry.ts';

test('extractJsonObject handles plain JSON, fenced blocks, prose, escaped quotes, and unbalanced input', () => {
  assert.equal(extractJsonObject('{"ok":true,"n":2}'), '{"ok":true,"n":2}');

  const fenced = 'Here is the plan:\n```json\n{"steps":[{"id":"a"},{"id":"b"}]}\n```\nDone.';
  assert.equal(extractJsonObject(fenced), '{"steps":[{"id":"a"},{"id":"b"}]}');

  const withStrings = 'Prefix text {"msg":"quote \\"here\\" and } bracket { inside","nested":[1,{"k":"}"}]} trailing prose';
  assert.equal(
    extractJsonObject(withStrings),
    '{"msg":"quote \\"here\\" and } bracket { inside","nested":[1,{"k":"}"}]}',
  );

  assert.equal(extractJsonObject('Array payload: [1, {"x": [2, 3]}, 4] end'), '[1, {"x": [2, 3]}, 4]');
  assert.equal(extractJsonObject('{"unterminated": [1, 2'), null);
  assert.equal(extractJsonObject('plain prose without json'), null);
  assert.equal(extractJsonObject('   '), null);
});

test('repairAndParseJson strips trailing commas without repair passes and retries up to maxAttempts', async () => {
  resetTelemetry();

  const cleanTrailing = await repairAndParseJson<{ a: number; list: number[] }>({
    raw: '```json\n{"a": 1, "list": [2, 3,],}\n```',
  });
  assert.deepEqual(cleanTrailing.value, { a: 1, list: [2, 3] });
  assert.equal(cleanTrailing.attempts, 0);
  assert.equal(cleanTrailing.repaired, false);

  const calls: Array<{ attempt: number; reason: string }> = [];
  const repaired = await repairAndParseJson<{ goal: string }>({
    raw: 'not json at all',
    maxAttempts: DEFAULT_MAX_REPAIR_PASSES,
    validate(value) {
      const obj = value as Record<string, unknown>;
      if (!obj || typeof obj.goal !== 'string' || !obj.goal.trim()) {
        throw new Error('goal string is required');
      }
      return { goal: obj.goal.trim() };
    },
    async requestRepair(_broken, reason, attempt) {
      calls.push({ attempt, reason });
      if (attempt === 1) return '{"wrong": 1}';
      return '```json\n{"goal": "ship release"}\n```';
    },
  });

  assert.equal(repaired.repaired, true);
  assert.equal(repaired.attempts, 2);
  assert.equal(repaired.value.goal, 'ship release');
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.attempt, 1);
  assert.equal(calls[1]?.attempt, 2);
  assert.match(calls[1]?.reason ?? '', /goal string is required/);

  const snap = getClientTelemetrySnapshot();
  assert.equal(snap.counters['loop.json_repair.attempts'], 2);
});

test('repairAndParseJson fails after exhausting bounded repair passes', async () => {
  let repairCount = 0;
  await assert.rejects(
    () => repairAndParseJson({
      raw: '{bad',
      maxAttempts: 3,
      async requestRepair() {
        repairCount += 1;
        return '{still_bad';
      },
    }),
    /Could not obtain valid structured JSON after 4 attempt\(s\)/,
  );
  assert.equal(repairCount, 3);
});

test('repairAndParseJson respects AbortSignal before and during repair passes', async () => {
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(
    () => repairAndParseJson({
      raw: '{bad',
      signal: alreadyAborted.signal,
      async requestRepair() {
        throw new Error('should not be called when already aborted');
      },
    }),
    (err: unknown) => err instanceof DOMException && err.name === 'AbortError',
  );

  const midAbort = new AbortController();
  await assert.rejects(
    () => repairAndParseJson({
      raw: '{bad',
      signal: midAbort.signal,
      async requestRepair() {
        midAbort.abort();
        return '{"ok":true}';
      },
    }),
    (err: unknown) => err instanceof DOMException && err.name === 'AbortError',
  );
});

test('LoopTracker records full phase progression and telemetry metrics', async () => {
  resetTelemetry();
  const tracker = new LoopTracker('run-42', 'Verify research pipeline');

  tracker.enter('UNDERSTAND', 'parsed owner intent');
  tracker.enter('PLAN', 'built 3-node DAG');
  tracker.enter('VALIDATE', 'validated schema');
  tracker.enter('EXECUTE', 'ran nodes');
  tracker.enter('VERIFY', 'all assertions passed');
  tracker.enter('AMEND', 'none needed');
  tracker.enter('REPORT', 'summarized findings');
  const trace = tracker.complete(true, 'done');

  assert.equal(trace.runId, 'run-42');
  assert.equal(trace.goal, 'Verify research pipeline');
  assert.equal(trace.currentPhase, 'REPORT');
  assert.ok(typeof trace.endedAtMs === 'number' && trace.endedAtMs >= trace.startedAtMs);
  assert.deepEqual(
    trace.steps.map(s => s.phase),
    ['UNDERSTAND', 'PLAN', 'VALIDATE', 'EXECUTE', 'VERIFY', 'AMEND', 'REPORT'],
  );
  for (const step of trace.steps) {
    assert.equal(step.ok, true);
    assert.ok(step.endedAtUs >= step.startedAtUs);
  }

  const snap = getClientTelemetrySnapshot();
  assert.equal(snap.counters['loop.runs.succeeded'], 1);
  assert.equal(snap.counters['loop.phase.understand.entered'], 1);
  assert.equal(snap.counters['loop.phase.report.entered'], 1);
  assert.equal(snap.histograms['loop.phase.execute_us']?.count, 1);

  const failedTracker = new LoopTracker('run-43', 'Failing run');
  failedTracker.enter('EXECUTE');
  const failedTrace = failedTracker.complete(false, 'upstream timeout');
  assert.equal(failedTrace.steps[0]?.ok, false);
  assert.equal(failedTrace.steps[0]?.detail, 'upstream timeout');
  assert.equal(getClientTelemetrySnapshot().counters['loop.runs.failed'], 1);
});

test('telemetry records ordered percentiles, enforces 512-sample ring buffer eviction, counters, and queue depths', async () => {
  resetTelemetry();

  for (let i = 0; i < 100; i += 1) {
    recordLatency('voice.stt_us', 10_000);
  }
  for (let i = 1; i <= 512; i += 1) {
    recordLatency('voice.stt_us', i);
  }

  incrementCounter('tool.calls', 2);
  incrementCounter('tool.calls', 3);
  setQueueDepth('tts_queue', 4);
  const res = await measureLatency('op.work_us', () => 'computed');
  assert.equal(res, 'computed');

  const snap = getClientTelemetrySnapshot();
  const h = snap.histograms['voice.stt_us'];
  assert.ok(h);
  assert.equal(h.count, 612);
  assert.equal(h.min_us, 1);
  assert.equal(h.max_us, 10_000);
  assert.ok(h.min_us <= h.p50_us && h.p50_us <= h.p95_us && h.p95_us <= h.p99_us && h.p99_us <= h.max_us);
  // Early 10_000us spikes were evicted from the 512-sample percentile window.
  assert.ok(h.p99_us <= 512, `Expected evicted 10000us spikes not to skew p99 (got ${h.p99_us})`);

  assert.equal(snap.counters['tool.calls'], 5);
  assert.equal(snap.queue_depths['tts_queue'], 4);
  assert.equal(snap.histograms['op.work_us']?.count, 1);
});

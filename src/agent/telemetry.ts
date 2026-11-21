/**
 * Bounded monotonic microsecond latency histograms, counters, and queue depth tracking.
 * Mirrors `crates/mm-telemetry` in TypeScript and merges native Desktop telemetry when running inside Tauri.
 */
import {
  getTelemetrySnapshot as getNativeTelemetrySnapshot,
  isDesktopRuntime,
  type HistogramSummary,
  type TelemetrySnapshot,
} from '../desktop/bridge.ts';

const MAX_WINDOW_SAMPLES = 512;

interface HistogramBucket {
  samples: number[];
  count: number;
  minUs: number;
  maxUs: number;
}

const histograms = new Map<string, HistogramBucket>();
const counters = new Map<string, number>();
const queueDepths = new Map<string, number>();

/** Monotonic clock in microseconds when `performance.now()` is available. */
export function nowUs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return Math.max(0, Math.round(performance.now() * 1000));
  }
  return Math.max(0, Math.round(Date.now() * 1000));
}

function percentile(sorted: readonly number[], pct: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor(((sorted.length - 1) * pct) / 100);
  return sorted[idx];
}

export function recordLatency(metric: string, durationUs: number): void {
  const cleanName = metric.trim();
  if (!cleanName) return;
  const cleanUs = Number.isFinite(durationUs) ? Math.max(0, Math.round(durationUs)) : 0;
  let bucket = histograms.get(cleanName);
  if (!bucket) {
    bucket = { samples: [], count: 0, minUs: cleanUs, maxUs: cleanUs };
    histograms.set(cleanName, bucket);
  }
  if (bucket.count === 0) {
    bucket.minUs = cleanUs;
    bucket.maxUs = cleanUs;
  } else {
    bucket.minUs = Math.min(bucket.minUs, cleanUs);
    bucket.maxUs = Math.max(bucket.maxUs, cleanUs);
  }
  bucket.count += 1;
  if (bucket.samples.length >= MAX_WINDOW_SAMPLES) {
    bucket.samples.shift();
  }
  bucket.samples.push(cleanUs);
}

export async function measureLatency<T>(metric: string, fn: () => Promise<T> | T): Promise<T> {
  const started = nowUs();
  try {
    return await fn();
  } finally {
    recordLatency(metric, Math.max(0, nowUs() - started));
  }
}

export function incrementCounter(name: string, delta = 1): void {
  const cleanName = name.trim();
  if (!cleanName) return;
  const step = Number.isFinite(delta) ? Math.max(0, Math.round(delta)) : 0;
  counters.set(cleanName, (counters.get(cleanName) ?? 0) + step);
}

export function setQueueDepth(queue: string, depth: number): void {
  const cleanName = queue.trim();
  if (!cleanName) return;
  queueDepths.set(cleanName, Number.isFinite(depth) ? Math.max(0, Math.floor(depth)) : 0);
}

function summarizeBucket(bucket: HistogramBucket): HistogramSummary {
  if (bucket.samples.length === 0) {
    return { count: 0, min_us: 0, p50_us: 0, p95_us: 0, p99_us: 0, max_us: 0 };
  }
  const sorted = [...bucket.samples].sort((a, b) => a - b);
  return {
    count: bucket.count,
    min_us: bucket.minUs,
    p50_us: percentile(sorted, 50),
    p95_us: percentile(sorted, 95),
    p99_us: percentile(sorted, 99),
    max_us: bucket.maxUs,
  };
}

export function getClientTelemetrySnapshot(): TelemetrySnapshot {
  const outHistograms: Record<string, HistogramSummary> = {};
  for (const [k, bucket] of histograms.entries()) {
    outHistograms[k] = summarizeBucket(bucket);
  }
  const outCounters: Record<string, number> = {};
  for (const [k, value] of counters.entries()) {
    outCounters[k] = value;
  }
  const outQueueDepths: Record<string, number> = {};
  for (const [k, depth] of queueDepths.entries()) {
    outQueueDepths[k] = depth;
  }
  return {
    histograms: outHistograms,
    counters: outCounters,
    queue_depths: outQueueDepths,
  };
}

export async function getCombinedTelemetrySnapshot(): Promise<TelemetrySnapshot> {
  const client = getClientTelemetrySnapshot();
  if (!isDesktopRuntime()) return client;
  try {
    const native = await getNativeTelemetrySnapshot();
    const histogramsMerged: Record<string, HistogramSummary> = { ...native.histograms };
    for (const [k, v] of Object.entries(client.histograms)) {
      histogramsMerged[k in histogramsMerged ? `client.${k}` : k] = v;
    }
    const countersMerged: Record<string, number> = { ...native.counters };
    for (const [k, v] of Object.entries(client.counters)) {
      countersMerged[k in countersMerged ? `client.${k}` : k] = v;
    }
    const queueMerged: Record<string, number> = { ...native.queue_depths };
    for (const [k, v] of Object.entries(client.queue_depths)) {
      queueMerged[k in queueMerged ? `client.${k}` : k] = v;
    }
    return {
      histograms: histogramsMerged,
      counters: countersMerged,
      queue_depths: queueMerged,
    };
  } catch {
    return client;
  }
}

export function resetTelemetry(): void {
  histograms.clear();
  counters.clear();
  queueDepths.clear();
}

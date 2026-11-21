//! Bounded monotonic microsecond latency histograms and runtime telemetry snapshots.

use std::collections::{BTreeMap, VecDeque};

use serde::{Deserialize, Serialize};

const MAX_WINDOW_SAMPLES: usize = 512;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistogramSummary {
    pub count: u64,
    pub min_us: u64,
    pub p50_us: u64,
    pub p95_us: u64,
    pub p99_us: u64,
    pub max_us: u64,
}

#[derive(Clone, Debug, Default)]
pub struct LatencyHistogram {
    samples: VecDeque<u64>,
    count: u64,
    min_us: u64,
    max_us: u64,
}

impl LatencyHistogram {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record_us(&mut self, duration_us: u64) {
        if self.count == 0 {
            self.min_us = duration_us;
            self.max_us = duration_us;
        } else {
            self.min_us = self.min_us.min(duration_us);
            self.max_us = self.max_us.max(duration_us);
        }
        self.count = self.count.saturating_add(1);
        if self.samples.len() >= MAX_WINDOW_SAMPLES {
            self.samples.pop_front();
        }
        self.samples.push_back(duration_us);
    }

    pub fn summary(&self) -> HistogramSummary {
        if self.samples.is_empty() {
            return HistogramSummary::default();
        }
        let mut sorted: Vec<u64> = self.samples.iter().copied().collect();
        sorted.sort_unstable();
        HistogramSummary {
            count: self.count,
            min_us: self.min_us,
            p50_us: percentile(&sorted, 50),
            p95_us: percentile(&sorted, 95),
            p99_us: percentile(&sorted, 99),
            max_us: self.max_us,
        }
    }
}

fn percentile(sorted: &[u64], pct: usize) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    let idx = ((sorted.len() - 1) * pct) / 100;
    sorted[idx]
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TelemetrySnapshot {
    pub histograms: BTreeMap<String, HistogramSummary>,
    pub counters: BTreeMap<String, u64>,
    pub queue_depths: BTreeMap<String, usize>,
}

#[derive(Clone, Debug, Default)]
pub struct TelemetryRegistry {
    histograms: BTreeMap<String, LatencyHistogram>,
    counters: BTreeMap<String, u64>,
    queue_depths: BTreeMap<String, usize>,
}

impl TelemetryRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record_latency_us(&mut self, metric: &str, duration_us: u64) {
        self.histograms
            .entry(metric.to_owned())
            .or_default()
            .record_us(duration_us);
    }

    pub fn increment(&mut self, counter: &str, delta: u64) {
        let entry = self.counters.entry(counter.to_owned()).or_insert(0);
        *entry = entry.saturating_add(delta);
    }

    pub fn set_queue_depth(&mut self, queue: &str, depth: usize) {
        self.queue_depths.insert(queue.to_owned(), depth);
    }

    pub fn snapshot(&self) -> TelemetrySnapshot {
        TelemetrySnapshot {
            histograms: self
                .histograms
                .iter()
                .map(|(k, v)| (k.clone(), v.summary()))
                .collect(),
            counters: self.counters.clone(),
            queue_depths: self.queue_depths.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_exact_percentiles_and_queue_depths() {
        let mut reg = TelemetryRegistry::new();
        for v in 1..=100u64 {
            reg.record_latency_us("wake_eval", v * 10);
        }
        reg.increment("wake_hits", 2);
        reg.set_queue_depth("mission_jobs", 4);

        let snap = reg.snapshot();
        let wake = snap.histograms.get("wake_eval").unwrap();
        assert_eq!(wake.count, 100);
        assert_eq!(wake.min_us, 10);
        assert_eq!(wake.max_us, 1000);
        assert!((490..=510).contains(&wake.p50_us));
        assert!((940..=960).contains(&wake.p95_us));
        assert_eq!(snap.counters.get("wake_hits"), Some(&2));
        assert_eq!(snap.queue_depths.get("mission_jobs"), Some(&4));
    }
}

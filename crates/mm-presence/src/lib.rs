//! Multimodal presence fusion engine.
//!
//! Security boundary: Produces candidate-readiness evaluations ONLY.
//! Can never mint an owner session or grant owner capabilities.

use serde::{Deserialize, Serialize};

pub const MIN_CANDIDATE_THRESHOLD: f32 = 0.70;
pub const SIGNAL_TTL_MS: u64 = 15_000;

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct PresenceSignal {
    pub confidence: f32,
    pub observed_at_ms: u64,
    pub liveness_verified: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct PresenceState {
    pub face: Option<PresenceSignal>,
    pub voice: Option<PresenceSignal>,
    pub gaze_engaged: Option<(bool, u64)>,
    pub wake_triggered_at_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PresenceAssessment {
    pub candidate_confidence: f32,
    pub owner_candidate_ready: bool,
    pub active_signals: u8,
    pub attention_engaged: bool,
}

impl PresenceState {
    pub fn record_face(&mut self, confidence: f32, liveness_verified: bool, now_ms: u64) {
        if liveness_verified && confidence.is_finite() {
            self.face = Some(PresenceSignal {
                confidence: confidence.clamp(0.0, 1.0),
                observed_at_ms: now_ms,
                liveness_verified: true,
            });
        }
    }

    pub fn record_voice(&mut self, confidence: f32, now_ms: u64) {
        if confidence.is_finite() {
            self.voice = Some(PresenceSignal {
                confidence: confidence.clamp(0.0, 1.0),
                observed_at_ms: now_ms,
                liveness_verified: true,
            });
        }
    }

    pub fn record_gaze(&mut self, engaged: bool, now_ms: u64) {
        self.gaze_engaged = Some((engaged, now_ms));
    }

    pub fn record_wake(&mut self, now_ms: u64) {
        self.wake_triggered_at_ms = Some(now_ms);
    }

    pub fn clear(&mut self) {
        *self = Self::default();
    }

    pub fn assess(&self, now_ms: u64) -> PresenceAssessment {
        let face = self
            .face
            .filter(|s| {
                s.liveness_verified && now_ms.saturating_sub(s.observed_at_ms) <= SIGNAL_TTL_MS
            })
            .map(|s| s.confidence)
            .unwrap_or(0.0);
        let voice = self
            .voice
            .filter(|s| now_ms.saturating_sub(s.observed_at_ms) <= SIGNAL_TTL_MS)
            .map(|s| s.confidence)
            .unwrap_or(0.0);
        let gaze = self
            .gaze_engaged
            .filter(|(engaged, ts)| *engaged && now_ms.saturating_sub(*ts) <= SIGNAL_TTL_MS)
            .is_some();
        let wake_recent = self
            .wake_triggered_at_ms
            .filter(|ts| now_ms.saturating_sub(*ts) <= SIGNAL_TTL_MS)
            .is_some();

        let score = (0.50 * face
            + 0.35 * voice
            + if gaze { 0.10 } else { 0.0 }
            + if wake_recent { 0.05 } else { 0.0 })
        .clamp(0.0, 1.0);
        let mut active = 0u8;
        if face > 0.0 {
            active += 1;
        }
        if voice > 0.0 {
            active += 1;
        }
        if gaze {
            active += 1;
        }
        if wake_recent {
            active += 1;
        }
        PresenceAssessment {
            candidate_confidence: score,
            owner_candidate_ready: score >= MIN_CANDIDATE_THRESHOLD
                || face >= MIN_CANDIDATE_THRESHOLD
                || voice >= MIN_CANDIDATE_THRESHOLD,
            active_signals: active,
            attention_engaged: gaze,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expired_and_unverified_signals_decay_safely() {
        let mut state = PresenceState::default();
        // Liveness-failed face must be ignored
        state.record_face(0.95, false, 1_000);
        assert!(!state.assess(1_000).owner_candidate_ready);

        state.record_face(0.90, true, 1_000);
        state.record_voice(0.80, 1_200);
        state.record_gaze(true, 1_300);
        let live = state.assess(1_500);
        assert!(live.owner_candidate_ready);
        assert_eq!(live.active_signals, 3);

        // After TTL passes, stale cues drop off cleanly
        let stale = state.assess(25_000);
        assert!(!stale.owner_candidate_ready);
        assert_eq!(stale.active_signals, 0);
    }
}

//! Local voice-activity gating, multi-phrase wake detection, hit-window hysteresis,
//! and emergency stop phrase detection.
//!
//! Security note: Wake events ONLY surface presence / OwnerCandidate notifications or trigger an
//! emergency stop. They never create or extend an authenticated owner session.

use std::collections::VecDeque;

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const DEFAULT_MIN_CONFIDENCE: f32 = 0.60;
pub const DEFAULT_REQUIRED_HITS: usize = 2;
pub const DEFAULT_HIT_WINDOW_MS: u64 = 8_000;
pub const DEFAULT_COOLDOWN_MS: u64 = 1_000;

/// Supported primary wake phrases (matching UI settings and voice tests).
pub const DEFAULT_WAKE_PHRASES: &[&str] = &[
    "hey miss minutes",
    "miss minutes",
    "hey miss",
    "hey minute",
    "miss minute",
    "wake up miss minutes",
];

/// Emergency kill / stop phrases that bypass normal conversational queueing to halt actuation.
pub const EMERGENCY_STOP_PHRASES: &[&str] = &[
    "miss minutes stop",
    "hey miss minutes stop",
    "miss minute stop",
    "emergency stop",
    "freeze timeline",
];

#[derive(Debug, Error, PartialEq, Eq)]
pub enum WakeError {
    #[error("wake configuration is invalid: {0}")]
    InvalidConfig(&'static str),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct VadConfig {
    /// Minimum RMS normalized amplitude (0.0..=1.0) to classify a frame as active speech.
    pub min_rms: f32,
    /// Minimum & maximum zero-crossing rate for speech-like vocal energy.
    pub min_zcr: f32,
    pub max_zcr: f32,
}

impl Default for VadConfig {
    fn default() -> Self {
        Self {
            min_rms: 0.015,
            min_zcr: 0.02,
            max_zcr: 0.45,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct VadDecision {
    pub speech_active: bool,
    pub rms: f32,
    pub zero_crossing_rate: f32,
}

/// Evaluates whether a 16-bit PCM frame contains voiced speech energy vs. silence/flat noise.
pub fn evaluate_pcm_vad(samples: &[i16], config: &VadConfig) -> VadDecision {
    if samples.len() < 2 {
        return VadDecision {
            speech_active: false,
            rms: 0.0,
            zero_crossing_rate: 0.0,
        };
    }
    let mut sum_sq = 0.0f64;
    let mut crossings = 0usize;
    let mut prev = samples[0];
    for &sample in samples {
        let norm = f64::from(sample) / 32768.0;
        sum_sq += norm * norm;
        if (prev >= 0 && sample < 0) || (prev < 0 && sample >= 0) {
            crossings += 1;
        }
        prev = sample;
    }
    let rms = (sum_sq / samples.len() as f64).sqrt() as f32;
    let zcr = crossings as f32 / (samples.len() - 1) as f32;
    let speech_active = rms >= config.min_rms && zcr >= config.min_zcr && zcr <= config.max_zcr;
    VadDecision {
        speech_active,
        rms,
        zero_crossing_rate: zcr,
    }
}

/// Normalizes transcripts for phrase matching: ASCII lowercase, punctuation replaced with spaces,
/// whitespace collapsed.
pub fn normalize_phrase_text(input: &str) -> String {
    let mut cleaned = String::with_capacity(input.len());
    let mut last_space = true;
    for ch in input.chars() {
        let mapped = match ch {
            'A'..='Z' => ch.to_ascii_lowercase(),
            'a'..='z' | '0'..='9' => ch,
            _ => ' ',
        };
        if mapped == ' ' {
            if !last_space {
                cleaned.push(' ');
                last_space = true;
            }
        } else {
            cleaned.push(mapped);
            last_space = false;
        }
    }
    if cleaned.ends_with(' ') {
        cleaned.pop();
    }
    cleaned
}

fn contains_token_sequence(haystack_norm: &str, needle_norm: &str) -> bool {
    if haystack_norm.is_empty() || needle_norm.is_empty() {
        return false;
    }
    let h_tokens: Vec<&str> = haystack_norm.split(' ').collect();
    let n_tokens: Vec<&str> = needle_norm.split(' ').collect();
    if n_tokens.len() > h_tokens.len() {
        return false;
    }
    h_tokens
        .windows(n_tokens.len())
        .any(|win| win == n_tokens.as_slice())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PhraseMatch {
    pub phrase: String,
    pub emergency_stop: bool,
    pub normalized_transcript: String,
}

/// Checks transcripts against emergency stop commands first, then custom + default wake phrases.
pub fn match_wake_or_stop_phrase(
    transcript: &str,
    extra_wake_phrases: &[String],
) -> Option<PhraseMatch> {
    let norm = normalize_phrase_text(transcript);
    if norm.is_empty() {
        return None;
    }
    for stop_phrase in EMERGENCY_STOP_PHRASES {
        if contains_token_sequence(&norm, stop_phrase) {
            return Some(PhraseMatch {
                phrase: (*stop_phrase).to_owned(),
                emergency_stop: true,
                normalized_transcript: norm,
            });
        }
    }
    for custom in extra_wake_phrases {
        let custom_norm = normalize_phrase_text(custom);
        if !custom_norm.is_empty() && contains_token_sequence(&norm, &custom_norm) {
            return Some(PhraseMatch {
                phrase: custom_norm,
                emergency_stop: false,
                normalized_transcript: norm,
            });
        }
    }
    for phrase in DEFAULT_WAKE_PHRASES {
        if contains_token_sequence(&norm, phrase) {
            return Some(PhraseMatch {
                phrase: (*phrase).to_owned(),
                emergency_stop: false,
                normalized_transcript: norm,
            });
        }
    }
    None
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WakeConfig {
    pub min_confidence: f32,
    pub required_hits: usize,
    pub hit_window_ms: u64,
    pub cooldown_ms: u64,
    pub custom_phrases: Vec<String>,
    pub vad: VadConfig,
}

impl Default for WakeConfig {
    fn default() -> Self {
        Self {
            min_confidence: DEFAULT_MIN_CONFIDENCE,
            required_hits: DEFAULT_REQUIRED_HITS,
            hit_window_ms: DEFAULT_HIT_WINDOW_MS,
            cooldown_ms: DEFAULT_COOLDOWN_MS,
            custom_phrases: Vec::new(),
            vad: VadConfig::default(),
        }
    }
}

impl WakeConfig {
    pub fn validate(&self) -> Result<(), WakeError> {
        if !self.min_confidence.is_finite() || !(0.0..=1.0).contains(&self.min_confidence) {
            return Err(WakeError::InvalidConfig(
                "min_confidence must be in [0.0, 1.0]",
            ));
        }
        if self.required_hits == 0 {
            return Err(WakeError::InvalidConfig("required_hits must be >= 1"));
        }
        if self.hit_window_ms == 0 {
            return Err(WakeError::InvalidConfig("hit_window_ms must be > 0"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WakeOutcome {
    Silent,
    BelowThreshold,
    CooldownActive,
    Accumulating { hits: usize, required: usize },
    Triggered { phrase: String, confidence: f32 },
    EmergencyStop { phrase: String },
}

/// Stateful hysteresis wake detector with sliding hit window, cooldown, and instant emergency stop.
#[derive(Clone, Debug)]
pub struct WakeEngine {
    config: WakeConfig,
    recent_hits_ms: VecDeque<u64>,
    last_trigger_ms: Option<u64>,
}

impl WakeEngine {
    pub fn new(config: WakeConfig) -> Result<Self, WakeError> {
        config.validate()?;
        Ok(Self {
            config,
            recent_hits_ms: VecDeque::new(),
            last_trigger_ms: None,
        })
    }

    pub fn config(&self) -> &WakeConfig {
        &self.config
    }

    pub fn reset(&mut self) {
        self.recent_hits_ms.clear();
        self.last_trigger_ms = None;
    }

    /// Feeds a wake detection observation at monotonic timestamp `now_ms`.
    /// Emergency stop transcripts bypass hysteresis & cooldown immediately.
    pub fn observe_hit(
        &mut self,
        confidence: f32,
        transcript: Option<&str>,
        speech_active: bool,
        now_ms: u64,
    ) -> WakeOutcome {
        if let Some(text) = transcript
            && let Some(matched) = match_wake_or_stop_phrase(text, &self.config.custom_phrases)
            && matched.emergency_stop
            && confidence >= 0.40
            && confidence.is_finite()
        {
            self.recent_hits_ms.clear();
            return WakeOutcome::EmergencyStop {
                phrase: matched.phrase,
            };
        }

        if !speech_active {
            return WakeOutcome::Silent;
        }
        if !confidence.is_finite() || confidence < self.config.min_confidence {
            return WakeOutcome::BelowThreshold;
        }

        if let Some(last) = self.last_trigger_ms
            && now_ms.saturating_sub(last) < self.config.cooldown_ms
        {
            return WakeOutcome::CooldownActive;
        }

        let matched_phrase = if let Some(text) = transcript {
            let Some(m) = match_wake_or_stop_phrase(text, &self.config.custom_phrases) else {
                return WakeOutcome::BelowThreshold;
            };
            m.phrase
        } else {
            "wake_acoustic".to_owned()
        };

        while let Some(&oldest) = self.recent_hits_ms.front() {
            if now_ms.saturating_sub(oldest) > self.config.hit_window_ms {
                self.recent_hits_ms.pop_front();
            } else {
                break;
            }
        }
        self.recent_hits_ms.push_back(now_ms);

        if self.recent_hits_ms.len() >= self.config.required_hits {
            self.recent_hits_ms.clear();
            self.last_trigger_ms = Some(now_ms);
            WakeOutcome::Triggered {
                phrase: matched_phrase,
                confidence: confidence.clamp(0.0, 1.0),
            }
        } else {
            WakeOutcome::Accumulating {
                hits: self.recent_hits_ms.len(),
                required: self.config.required_hits,
            }
        }
    }

    /// Convenience helper combining PCM VAD + wake phrase hysteresis.
    pub fn process_pcm_frame(
        &mut self,
        pcm: &[i16],
        transcript: Option<&str>,
        phrase_confidence: f32,
        now_ms: u64,
    ) -> WakeOutcome {
        let vad = evaluate_pcm_vad(pcm, &self.config.vad);
        self.observe_hit(phrase_confidence, transcript, vad.speech_active, now_ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_all_supported_wake_variants_and_emergency_stop() {
        for phrase in [
            "Hey Miss Minutes!",
            "miss minutes, open notes",
            "Hey Miss, check my schedule",
            "hey minute what time is it",
            "Miss Minute please look here",
        ] {
            let m = match_wake_or_stop_phrase(phrase, &[]).expect("expected wake match");
            assert!(!m.emergency_stop, "did not expect stop for {phrase}");
        }
        let stop =
            match_wake_or_stop_phrase("Miss Minutes, STOP right now!", &[]).expect("expected stop");
        assert!(stop.emergency_stop);
        assert_eq!(stop.phrase, "miss minutes stop");
    }

    #[test]
    fn hysteresis_requires_two_hits_within_window_and_respects_cooldown() {
        let mut engine = WakeEngine::new(WakeConfig::default()).unwrap();
        assert_eq!(
            engine.observe_hit(0.75, Some("hey miss"), true, 1_000),
            WakeOutcome::Accumulating {
                hits: 1,
                required: 2
            }
        );
        // Outside 8000ms window -> stale hit expires cleanly
        assert_eq!(
            engine.observe_hit(0.75, Some("hey miss minutes"), true, 10_500),
            WakeOutcome::Accumulating {
                hits: 1,
                required: 2
            }
        );
        // Second hit within window triggers
        assert_eq!(
            engine.observe_hit(0.82, Some("miss minute"), true, 12_000),
            WakeOutcome::Triggered {
                phrase: "miss minute".to_owned(),
                confidence: 0.82
            }
        );
        // Within 1000ms cooldown
        assert_eq!(
            engine.observe_hit(0.90, Some("hey miss"), true, 12_500),
            WakeOutcome::CooldownActive
        );
        // Stop phrase works even during cooldown or silent VAD threshold check
        assert_eq!(
            engine.observe_hit(0.65, Some("miss minutes stop"), false, 12_600),
            WakeOutcome::EmergencyStop {
                phrase: "miss minutes stop".to_owned()
            }
        );
    }

    #[test]
    fn pcm_vad_separates_silence_from_voiced_speech_waveform() {
        let silence = vec![0i16; 320];
        assert!(!evaluate_pcm_vad(&silence, &VadConfig::default()).speech_active);

        let voiced: Vec<i16> = (0..320)
            .map(|i| (((i as f32) * 0.28).sin() * 6000.0) as i16)
            .collect();
        let decision = evaluate_pcm_vad(&voiced, &VadConfig::default());
        assert!(decision.speech_active);
        assert!(decision.rms > 0.05);
    }
}

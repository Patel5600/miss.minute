//! Local speaker identity verification.
//!
//! Security boundary: Produces `OwnerCandidate` verification signals ONLY.
//! Speaker embeddings NEVER unlock owner privileges or impersonate voice on calls.

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const DEFAULT_MIN_SPEAKER_SIMILARITY: f32 = 0.72;
pub const DEFAULT_MIN_VOICED_MS: u32 = 900;
pub const DEFAULT_MIN_SNR_DB: f32 = 8.0;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum SpeakerError {
    #[error("invalid speaker embedding")]
    InvalidEmbedding,
    #[error("embedding dimension mismatch: expected {expected}, got {actual}")]
    DimensionMismatch { expected: usize, actual: usize },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SpeakerObservation {
    pub embedding: Vec<f32>,
    pub voiced_ms: u32,
    pub snr_db: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SpeakerVerificationResult {
    pub matched_candidate: bool,
    pub audio_quality_ok: bool,
    pub similarity: f32,
    pub reason: &'static str,
}

fn l2_normalize(vec: &[f32]) -> Result<Vec<f32>, SpeakerError> {
    if vec.is_empty() || vec.iter().any(|v| !v.is_finite()) {
        return Err(SpeakerError::InvalidEmbedding);
    }
    let mag = vec
        .iter()
        .map(|v| f64::from(*v) * f64::from(*v))
        .sum::<f64>()
        .sqrt();
    if mag <= 1e-8 {
        return Err(SpeakerError::InvalidEmbedding);
    }
    Ok(vec.iter().map(|v| (f64::from(*v) / mag) as f32).collect())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SpeakerProfile {
    pub centroid: Vec<f32>,
    pub sample_count: usize,
}

impl SpeakerProfile {
    pub fn enroll(utterances: &[Vec<f32>]) -> Result<Self, SpeakerError> {
        if utterances.is_empty() {
            return Err(SpeakerError::InvalidEmbedding);
        }
        let dim = utterances[0].len();
        let mut sum = vec![0.0f64; dim];
        for utt in utterances {
            if utt.len() != dim {
                return Err(SpeakerError::DimensionMismatch {
                    expected: dim,
                    actual: utt.len(),
                });
            }
            let norm = l2_normalize(utt)?;
            for (i, val) in norm.iter().enumerate() {
                sum[i] += f64::from(*val);
            }
        }
        let avg: Vec<f32> = sum.into_iter().map(|x| x as f32).collect();
        Ok(Self {
            centroid: l2_normalize(&avg)?,
            sample_count: utterances.len(),
        })
    }

    pub fn verify(
        &self,
        obs: &SpeakerObservation,
    ) -> Result<SpeakerVerificationResult, SpeakerError> {
        if obs.voiced_ms < DEFAULT_MIN_VOICED_MS
            || !obs.snr_db.is_finite()
            || obs.snr_db < DEFAULT_MIN_SNR_DB
        {
            return Ok(SpeakerVerificationResult {
                matched_candidate: false,
                audio_quality_ok: false,
                similarity: 0.0,
                reason: "insufficient_speech_or_snr",
            });
        }
        if obs.embedding.len() != self.centroid.len() {
            return Err(SpeakerError::DimensionMismatch {
                expected: self.centroid.len(),
                actual: obs.embedding.len(),
            });
        }
        let probe = l2_normalize(&obs.embedding)?;
        let sim: f64 = self
            .centroid
            .iter()
            .zip(probe.iter())
            .map(|(a, b)| f64::from(*a) * f64::from(*b))
            .sum();
        let similarity = (sim as f32).clamp(0.0, 1.0);
        let matched = similarity >= DEFAULT_MIN_SPEAKER_SIMILARITY;
        Ok(SpeakerVerificationResult {
            matched_candidate: matched,
            audio_quality_ok: true,
            similarity,
            reason: if matched {
                "speaker_candidate_matched"
            } else {
                "speaker_mismatch"
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn noisy_short_clip_and_impostor_are_rejected() {
        let profile =
            SpeakerProfile::enroll(&[vec![1.0, 0.0, 0.0], vec![0.95, 0.05, 0.0]]).unwrap();
        let noisy = SpeakerObservation {
            embedding: vec![1.0, 0.0, 0.0],
            voiced_ms: 300,
            snr_db: 15.0,
        };
        assert!(!profile.verify(&noisy).unwrap().audio_quality_ok);

        let impostor = SpeakerObservation {
            embedding: vec![0.0, 1.0, 0.0],
            voiced_ms: 1400,
            snr_db: 18.0,
        };
        let res = profile.verify(&impostor).unwrap();
        assert!(res.audio_quality_ok);
        assert!(!res.matched_candidate);

        let owner = SpeakerObservation {
            embedding: vec![0.98, 0.02, 0.0],
            voiced_ms: 1400,
            snr_db: 18.0,
        };
        assert!(profile.verify(&owner).unwrap().matched_candidate);
    }
}

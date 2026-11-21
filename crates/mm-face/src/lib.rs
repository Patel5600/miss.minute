//! Local face quality gating, cosine embedding comparison, and liveness consensus.
//!
//! Security boundary: Produces candidate presence signals ONLY. Never authorizes owner commands.

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const DEFAULT_MIN_SIMILARITY: f32 = 0.72;
pub const DEFAULT_MIN_LIVENESS: f32 = 0.70;
pub const DEFAULT_MIN_SHARPNESS: f32 = 0.25;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum FaceError {
    #[error("embedding is empty or contains non-finite values")]
    InvalidEmbedding,
    #[error("embedding dimension mismatch: expected {expected}, got {actual}")]
    DimensionMismatch { expected: usize, actual: usize },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FaceQualityMetrics {
    pub bbox_width_ratio: f32,
    pub brightness: f32,
    pub sharpness: f32,
    pub yaw_deg: f32,
    pub pitch_deg: f32,
    pub occluded: bool,
    pub liveness_score: f32,
}

impl Default for FaceQualityMetrics {
    fn default() -> Self {
        Self {
            bbox_width_ratio: 0.25,
            brightness: 0.5,
            sharpness: 0.6,
            yaw_deg: 0.0,
            pitch_deg: 0.0,
            occluded: false,
            liveness_score: 0.9,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FaceObservation {
    pub embedding: Vec<f32>,
    pub quality: FaceQualityMetrics,
    pub timestamp_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FaceMatchDecision {
    pub matched_candidate: bool,
    pub quality_ok: bool,
    pub liveness_ok: bool,
    pub similarity: f32,
    pub reason: &'static str,
}

pub fn normalize_embedding(raw: &[f32]) -> Result<Vec<f32>, FaceError> {
    if raw.is_empty() || raw.iter().any(|v| !v.is_finite()) {
        return Err(FaceError::InvalidEmbedding);
    }
    let norm = raw
        .iter()
        .map(|v| (*v as f64) * (*v as f64))
        .sum::<f64>()
        .sqrt();
    if norm <= 1e-8 {
        return Err(FaceError::InvalidEmbedding);
    }
    Ok(raw.iter().map(|v| ((*v as f64) / norm) as f32).collect())
}

pub fn cosine_similarity(a: &[f32], b: &[f32]) -> Result<f32, FaceError> {
    if a.len() != b.len() {
        return Err(FaceError::DimensionMismatch {
            expected: a.len(),
            actual: b.len(),
        });
    }
    let na = normalize_embedding(a)?;
    let nb = normalize_embedding(b)?;
    let dot: f64 = na
        .iter()
        .zip(nb.iter())
        .map(|(x, y)| (*x as f64) * (*y as f64))
        .sum();
    Ok((dot as f32).clamp(-1.0, 1.0))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FaceTemplate {
    pub centroid: Vec<f32>,
    pub sample_count: usize,
}

impl FaceTemplate {
    pub fn from_samples(samples: &[Vec<f32>]) -> Result<Self, FaceError> {
        if samples.is_empty() {
            return Err(FaceError::InvalidEmbedding);
        }
        let dim = samples[0].len();
        let mut accum = vec![0.0f64; dim];
        for sample in samples {
            if sample.len() != dim {
                return Err(FaceError::DimensionMismatch {
                    expected: dim,
                    actual: sample.len(),
                });
            }
            let norm = normalize_embedding(sample)?;
            for (i, val) in norm.iter().enumerate() {
                accum[i] += f64::from(*val);
            }
        }
        let avg: Vec<f32> = accum.into_iter().map(|s| s as f32).collect();
        Ok(Self {
            centroid: normalize_embedding(&avg)?,
            sample_count: samples.len(),
        })
    }

    pub fn evaluate(&self, observation: &FaceObservation) -> Result<FaceMatchDecision, FaceError> {
        let q = &observation.quality;
        if !q.liveness_score.is_finite() || q.liveness_score < DEFAULT_MIN_LIVENESS {
            return Ok(FaceMatchDecision {
                matched_candidate: false,
                quality_ok: false,
                liveness_ok: false,
                similarity: 0.0,
                reason: "liveness_check_failed",
            });
        }
        let quality_ok = q.bbox_width_ratio >= 0.12
            && (0.12..=0.92).contains(&q.brightness)
            && q.sharpness >= DEFAULT_MIN_SHARPNESS
            && q.yaw_deg.abs() <= 35.0
            && q.pitch_deg.abs() <= 30.0
            && !q.occluded;
        if !quality_ok {
            return Ok(FaceMatchDecision {
                matched_candidate: false,
                quality_ok: false,
                liveness_ok: true,
                similarity: 0.0,
                reason: "quality_gate_failed",
            });
        }
        let sim = cosine_similarity(&self.centroid, &observation.embedding)?;
        let matched = sim >= DEFAULT_MIN_SIMILARITY;
        Ok(FaceMatchDecision {
            matched_candidate: matched,
            quality_ok: true,
            liveness_ok: true,
            similarity: sim.max(0.0),
            reason: if matched {
                "face_candidate_matched"
            } else {
                "similarity_below_threshold"
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spoofed_or_occluded_face_never_matches_candidate() {
        let tmpl = FaceTemplate::from_samples(&[vec![1.0, 0.0, 0.5, 0.0]]).unwrap();
        let spoof = FaceObservation {
            embedding: vec![1.0, 0.0, 0.5, 0.0],
            quality: FaceQualityMetrics {
                liveness_score: 0.15,
                ..Default::default()
            },
            timestamp_ms: 10,
        };
        let decision = tmpl.evaluate(&spoof).unwrap();
        assert!(!decision.matched_candidate);
        assert!(!decision.liveness_ok);

        let legitimate = FaceObservation {
            embedding: vec![0.99, 0.02, 0.49, 0.0],
            quality: FaceQualityMetrics::default(),
            timestamp_ms: 20,
        };
        let ok = tmpl.evaluate(&legitimate).unwrap();
        assert!(ok.matched_candidate);
        assert!(ok.similarity > 0.99);
    }
}

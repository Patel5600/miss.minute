//! Shared affine gaze calibration and attention presence scoring matching `GazeCalibrator`.

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const FEATURES: usize = 5;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum GazeError {
    #[error("calibration requires at least {FEATURES} valid samples")]
    InsufficientSamples,
    #[error("calibration system was ill-conditioned")]
    IllConditioned,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct GazeSample {
    pub left_x: f32,
    pub left_y: f32,
    pub right_x: f32,
    pub right_y: f32,
    pub screen_x: f32,
    pub screen_y: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct GazePoint {
    pub x: f32,
    pub y: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GazeCalibrationWeights {
    pub horizontal: [f64; FEATURES],
    pub vertical: [f64; FEATURES],
}

impl GazeCalibrationWeights {
    pub fn fit(samples: &[GazeSample]) -> Result<Self, GazeError> {
        let valid: Vec<&GazeSample> = samples
            .iter()
            .filter(|s| {
                [
                    s.left_x, s.left_y, s.right_x, s.right_y, s.screen_x, s.screen_y,
                ]
                .iter()
                .all(|v| v.is_finite())
                    && (0.0..=1.0).contains(&s.screen_x)
                    && (0.0..=1.0).contains(&s.screen_y)
            })
            .collect();
        if valid.len() < FEATURES {
            return Err(GazeError::InsufficientSamples);
        }

        let mut normal = [[0.0f64; FEATURES]; FEATURES];
        let mut bx = [0.0f64; FEATURES];
        let mut by = [0.0f64; FEATURES];
        for s in valid {
            let feats = [
                f64::from(s.left_x),
                f64::from(s.left_y),
                f64::from(s.right_x),
                f64::from(s.right_y),
                1.0,
            ];
            for row in 0..FEATURES {
                bx[row] += feats[row] * f64::from(s.screen_x);
                by[row] += feats[row] * f64::from(s.screen_y);
                for col in 0..FEATURES {
                    normal[row][col] += feats[row] * feats[col];
                }
            }
        }
        for (i, row) in normal.iter_mut().enumerate().take(FEATURES - 1) {
            row[i] += 1e-4;
        }
        let horizontal = solve_linear(&normal, &bx).ok_or(GazeError::IllConditioned)?;
        let vertical = solve_linear(&normal, &by).ok_or(GazeError::IllConditioned)?;
        Ok(Self {
            horizontal,
            vertical,
        })
    }

    pub fn project(&self, features: [f32; 4]) -> Option<GazePoint> {
        if features.iter().any(|v| !v.is_finite()) {
            return None;
        }
        let input = [
            f64::from(features[0]),
            f64::from(features[1]),
            f64::from(features[2]),
            f64::from(features[3]),
            1.0,
        ];
        let x: f64 = self
            .horizontal
            .iter()
            .zip(input.iter())
            .map(|(a, b)| a * b)
            .sum();
        let y: f64 = self
            .vertical
            .iter()
            .zip(input.iter())
            .map(|(a, b)| a * b)
            .sum();
        if !x.is_finite()
            || !y.is_finite()
            || !(-0.25..=1.25).contains(&x)
            || !(-0.25..=1.25).contains(&y)
        {
            return None;
        }
        Some(GazePoint {
            x: x.clamp(0.0, 1.0) as f32,
            y: y.clamp(0.0, 1.0) as f32,
        })
    }

    /// Returns true if the projected gaze point falls within the screen bounds + margin.
    pub fn attention_on_screen(&self, features: [f32; 4]) -> bool {
        self.project(features).is_some()
    }
}

fn solve_linear(
    matrix: &[[f64; FEATURES]; FEATURES],
    vector: &[f64; FEATURES],
) -> Option<[f64; FEATURES]> {
    let mut a = [[0.0f64; FEATURES + 1]; FEATURES];
    for row in 0..FEATURES {
        a[row][..FEATURES].copy_from_slice(&matrix[row]);
        a[row][FEATURES] = vector[row];
    }
    for col in 0..FEATURES {
        let mut pivot = col;
        for row in (col + 1)..FEATURES {
            if a[row][col].abs() > a[pivot][col].abs() {
                pivot = row;
            }
        }
        if a[pivot][col].abs() < 1e-9 {
            return None;
        }
        a.swap(col, pivot);
        let divisor = a[col][col];
        for entry in a[col].iter_mut().skip(col) {
            *entry /= divisor;
        }
        let pivot_row = a[col];
        for (row_idx, row) in a.iter_mut().enumerate() {
            if row_idx == col {
                continue;
            }
            let factor = row[col];
            for j in col..=FEATURES {
                row[j] -= factor * pivot_row[j];
            }
        }
    }
    let mut out = [0.0f64; FEATURES];
    for (row, value) in out.iter_mut().enumerate() {
        *value = a[row][FEATURES];
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fits_and_projects_calibrated_affine_screen_points() {
        let samples = vec![
            GazeSample {
                left_x: 0.1,
                left_y: 0.1,
                right_x: 0.12,
                right_y: 0.1,
                screen_x: 0.1,
                screen_y: 0.1,
            },
            GazeSample {
                left_x: 0.9,
                left_y: 0.1,
                right_x: 0.88,
                right_y: 0.1,
                screen_x: 0.9,
                screen_y: 0.1,
            },
            GazeSample {
                left_x: 0.1,
                left_y: 0.9,
                right_x: 0.12,
                right_y: 0.9,
                screen_x: 0.1,
                screen_y: 0.9,
            },
            GazeSample {
                left_x: 0.9,
                left_y: 0.9,
                right_x: 0.88,
                right_y: 0.9,
                screen_x: 0.9,
                screen_y: 0.9,
            },
            GazeSample {
                left_x: 0.5,
                left_y: 0.5,
                right_x: 0.50,
                right_y: 0.5,
                screen_x: 0.5,
                screen_y: 0.5,
            },
        ];
        let weights = GazeCalibrationWeights::fit(&samples).unwrap();
        let pt = weights.project([0.5, 0.5, 0.5, 0.5]).unwrap();
        assert!((pt.x - 0.5).abs() < 0.02);
        assert!((pt.y - 0.5).abs() < 0.02);
    }
}

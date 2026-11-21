//! Busy-interval normalization, free-window extraction, and natural-language summary.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BusyInterval {
    pub start_epoch_min: i64,
    pub end_epoch_min: i64,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FreeSlot {
    pub start_epoch_min: i64,
    pub end_epoch_min: i64,
    pub duration_minutes: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AvailabilitySummary {
    pub free_slots: Vec<FreeSlot>,
    pub summary_sentence: String,
}

pub fn merge_busy_intervals(intervals: &[BusyInterval]) -> Vec<BusyInterval> {
    let mut valid: Vec<BusyInterval> = intervals
        .iter()
        .filter(|iv| iv.end_epoch_min > iv.start_epoch_min)
        .cloned()
        .collect();
    valid.sort_by_key(|iv| (iv.start_epoch_min, iv.end_epoch_min));
    let mut merged: Vec<BusyInterval> = Vec::new();
    for iv in valid {
        if let Some(last) = merged.last_mut()
            && iv.start_epoch_min <= last.end_epoch_min
        {
            if iv.end_epoch_min > last.end_epoch_min {
                last.end_epoch_min = iv.end_epoch_min;
            }
            continue;
        }
        merged.push(iv);
    }
    merged
}

pub fn find_free_slots(
    busy: &[BusyInterval],
    window_start_min: i64,
    window_end_min: i64,
    min_duration_min: i64,
) -> AvailabilitySummary {
    if window_end_min <= window_start_min || min_duration_min <= 0 {
        return AvailabilitySummary {
            free_slots: Vec::new(),
            summary_sentence: "No valid scheduling window was provided.".to_owned(),
        };
    }

    let merged = merge_busy_intervals(busy);
    let mut cursor = window_start_min;
    let mut free = Vec::new();

    for iv in merged {
        if iv.end_epoch_min <= window_start_min {
            continue;
        }
        if iv.start_epoch_min >= window_end_min {
            break;
        }
        let clipped_start = iv.start_epoch_min.max(window_start_min);
        let clipped_end = iv.end_epoch_min.min(window_end_min);
        if clipped_start > cursor {
            let dur = clipped_start - cursor;
            if dur >= min_duration_min {
                free.push(FreeSlot {
                    start_epoch_min: cursor,
                    end_epoch_min: clipped_start,
                    duration_minutes: dur,
                });
            }
        }
        cursor = cursor.max(clipped_end);
    }

    if window_end_min > cursor {
        let dur = window_end_min - cursor;
        if dur >= min_duration_min {
            free.push(FreeSlot {
                start_epoch_min: cursor,
                end_epoch_min: window_end_min,
                duration_minutes: dur,
            });
        }
    }

    let summary_sentence = if free.is_empty() {
        format!("No openings of at least {min_duration_min} minutes exist in that window.")
    } else {
        let total_min: i64 = free.iter().map(|s| s.duration_minutes).sum();
        let longest = free.iter().map(|s| s.duration_minutes).max().unwrap_or(0);
        format!(
            "Found {} open window(s) totaling {} minutes (longest opening: {} minutes).",
            free.len(),
            total_min,
            longest
        )
    };

    AvailabilitySummary {
        free_slots: free,
        summary_sentence,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_overlaps_and_extracts_free_slots() {
        let busy = vec![
            BusyInterval {
                start_epoch_min: 540,
                end_epoch_min: 600,
                label: "Standup".into(),
            },
            BusyInterval {
                start_epoch_min: 585,
                end_epoch_min: 630,
                label: "Overlap".into(),
            },
            BusyInterval {
                start_epoch_min: 720,
                end_epoch_min: 780,
                label: "Lunch".into(),
            },
        ];
        let res = find_free_slots(&busy, 480, 900, 30);
        assert_eq!(res.free_slots.len(), 3);
        assert_eq!(
            res.free_slots[0],
            FreeSlot {
                start_epoch_min: 480,
                end_epoch_min: 540,
                duration_minutes: 60
            }
        );
        assert_eq!(
            res.free_slots[1],
            FreeSlot {
                start_epoch_min: 630,
                end_epoch_min: 720,
                duration_minutes: 90
            }
        );
        assert_eq!(
            res.free_slots[2],
            FreeSlot {
                start_epoch_min: 780,
                end_epoch_min: 900,
                duration_minutes: 120
            }
        );
        assert!(res.summary_sentence.contains("3 open window(s)"));
    }
}

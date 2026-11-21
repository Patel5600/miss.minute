//! Ethical outbound VoIP calling policy, compile-time brand-voice separation,
//! E.164 & DNC checks, quiet hours, daily caps, typed fact allowlist, and call state machine.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CallError {
    #[error("phone number must be valid E.164 format (+[country][number])")]
    InvalidE164,
    #[error("recipient is on the Do-Not-Call registry")]
    DoNotCallBlocked,
    #[error("quiet hours active ({local_hour_min} min); outbound call deferred")]
    QuietHoursBlocked { local_hour_min: u16 },
    #[error("daily outbound call cap ({max_per_day}) reached")]
    DailyCapReached { max_per_day: u32 },
    #[error("disclosed facts contain disallowed content or empty field")]
    InvalidFact,
    #[error("explicit owner confirmation is required before placing outbound call")]
    OwnerConfirmationRequired,
    #[error("invalid call state transition")]
    InvalidTransition,
}

/// Sealed brand voice type: outbound calls can ONLY accept Miss Minutes' persona voice,
/// making it a compile-time error to pass an `OwnerVoiceCloneProfile`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum BrandVoiceId {
    MissMinutesTva,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrandVoiceProfile {
    voice_id: BrandVoiceId,
    display_name: String,
}

impl BrandVoiceProfile {
    pub fn miss_minutes() -> Self {
        Self {
            voice_id: BrandVoiceId::MissMinutesTva,
            display_name: "Miss Minutes (TVA Clockwork Assistant)".to_owned(),
        }
    }

    pub fn voice_id(&self) -> BrandVoiceId {
        self.voice_id
    }
}

/// Separate type representing owner speaker biometric/voice data — intentionally has no
/// conversion into `BrandVoiceProfile` so Miss Minutes can never impersonate the owner.
#[derive(Clone, Debug)]
pub struct OwnerVoiceProfile {
    pub profile_id: String,
}

/// Validates strict E.164 syntax: `+` followed by 7 to 15 ASCII digits, first digit 1..=9.
pub fn is_valid_e164(number: &str) -> bool {
    let Some(rest) = number.strip_prefix('+') else {
        return false;
    };
    let bytes = rest.as_bytes();
    if !(7..=15).contains(&bytes.len()) {
        return false;
    }
    matches!(bytes[0], b'1'..=b'9') && bytes.iter().all(|b| b.is_ascii_digit())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Fact {
    ScheduledWindow { summary: String },
    BookingName { first_name: String },
    CallbackNumber { e164: String },
    ReferenceCode { code: String },
    BriefTopic { topic: String },
}

impl Fact {
    pub fn validate(&self) -> Result<(), CallError> {
        let non_empty_safe = |s: &str| {
            let trimmed = s.trim();
            !trimmed.is_empty()
                && trimmed.len() <= 140
                && !trimmed.contains('\n')
                && !trimmed.contains("sk-")
                && !trimmed.contains("Bearer ")
        };
        match self {
            Self::ScheduledWindow { summary } if non_empty_safe(summary) => Ok(()),
            Self::BookingName { first_name } if non_empty_safe(first_name) => Ok(()),
            Self::CallbackNumber { e164 } if is_valid_e164(e164) => Ok(()),
            Self::ReferenceCode { code } if non_empty_safe(code) => Ok(()),
            Self::BriefTopic { topic } if non_empty_safe(topic) => Ok(()),
            _ => Err(CallError::InvalidFact),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CallPolicy {
    /// Quiet hours window start in minutes from midnight (default 21:00 = 1260).
    pub quiet_start_min: u16,
    /// Quiet hours window end in minutes from midnight (default 08:00 = 480).
    pub quiet_end_min: u16,
    pub max_calls_per_day: u32,
}

impl Default for CallPolicy {
    fn default() -> Self {
        Self {
            quiet_start_min: 21 * 60,
            quiet_end_min: 8 * 60,
            max_calls_per_day: 5,
        }
    }
}

impl CallPolicy {
    pub fn is_quiet_hour(&self, local_minute_of_day: u16) -> bool {
        let m = local_minute_of_day % 1440;
        if self.quiet_start_min > self.quiet_end_min {
            m >= self.quiet_start_min || m < self.quiet_end_min
        } else {
            m >= self.quiet_start_min && m < self.quiet_end_min
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct CallGuardLedger {
    pub dnc_numbers: HashSet<String>,
    pub calls_placed_today: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CallState {
    Draft,
    Validated,
    Disclosed,
    Connected,
    Completed,
    Aborted,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreparedOutboundCall {
    pub call_id: String,
    pub destination_e164: String,
    pub caller_label: String,
    pub voice: BrandVoiceProfile,
    pub disclosure_opening: String,
    pub allowed_facts: Vec<Fact>,
    pub state: CallState,
}

#[derive(Clone, Debug)]
pub struct OutboundCallRequest<'a> {
    pub destination_e164: &'a str,
    pub owner_first_name: &'a str,
    pub facts: Vec<Fact>,
    pub voice: BrandVoiceProfile,
    pub local_minute_of_day: u16,
    pub policy: &'a CallPolicy,
    pub ledger: &'a CallGuardLedger,
    pub owner_confirmed: bool,
}

pub fn prepare_outbound_call(
    request: OutboundCallRequest<'_>,
) -> Result<PreparedOutboundCall, CallError> {
    let OutboundCallRequest {
        destination_e164,
        owner_first_name,
        facts,
        voice,
        local_minute_of_day,
        policy,
        ledger,
        owner_confirmed,
    } = request;
    if !is_valid_e164(destination_e164) {
        return Err(CallError::InvalidE164);
    }
    if ledger.dnc_numbers.contains(destination_e164) {
        return Err(CallError::DoNotCallBlocked);
    }
    if policy.is_quiet_hour(local_minute_of_day) {
        return Err(CallError::QuietHoursBlocked {
            local_hour_min: local_minute_of_day % 1440,
        });
    }
    if ledger.calls_placed_today >= policy.max_calls_per_day {
        return Err(CallError::DailyCapReached {
            max_per_day: policy.max_calls_per_day,
        });
    }
    if facts.is_empty() || facts.len() > 8 {
        return Err(CallError::InvalidFact);
    }
    for f in &facts {
        f.validate()?;
    }
    if !owner_confirmed {
        return Err(CallError::OwnerConfirmationRequired);
    }
    let clean_name = if owner_first_name.trim().is_empty() {
        "the account owner"
    } else {
        owner_first_name.trim()
    };
    let disclosure = format!(
        "Hello, this is Miss Minutes, an automated AI assistant calling on behalf of {clean_name}. I will only share authorized scheduling details."
    );
    Ok(PreparedOutboundCall {
        call_id: Uuid::new_v4().to_string(),
        destination_e164: destination_e164.to_owned(),
        caller_label: clean_name.to_owned(),
        voice,
        disclosure_opening: disclosure,
        allowed_facts: facts,
        state: CallState::Validated,
    })
}

impl PreparedOutboundCall {
    pub fn mark_disclosed(&mut self) -> Result<(), CallError> {
        if self.state != CallState::Validated || self.disclosure_opening.trim().is_empty() {
            return Err(CallError::InvalidTransition);
        }
        self.state = CallState::Disclosed;
        Ok(())
    }

    pub fn mark_connected(&mut self) -> Result<(), CallError> {
        // AI disclosure MUST precede sharing details in Connected state!
        if self.state != CallState::Disclosed {
            return Err(CallError::InvalidTransition);
        }
        self.state = CallState::Connected;
        Ok(())
    }

    pub fn complete(&mut self) -> Result<(), CallError> {
        if !matches!(self.state, CallState::Disclosed | CallState::Connected) {
            return Err(CallError::InvalidTransition);
        }
        self.state = CallState::Completed;
        Ok(())
    }

    pub fn abort(&mut self) {
        self.state = CallState::Aborted;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enforces_e164_quiet_hours_dnc_cap_and_mandatory_ai_disclosure_order() {
        let mut ledger = CallGuardLedger::default();
        ledger.dnc_numbers.insert("+12025550199".to_owned());
        let policy = CallPolicy::default();
        let facts = vec![Fact::BriefTopic {
            topic: "Dental appointment reschedule".to_owned(),
        }];

        // Invalid E.164
        assert_eq!(
            prepare_outbound_call(OutboundCallRequest {
                destination_e164: "2025550100",
                owner_first_name: "Alex",
                facts: facts.clone(),
                voice: BrandVoiceProfile::miss_minutes(),
                local_minute_of_day: 10 * 60,
                policy: &policy,
                ledger: &ledger,
                owner_confirmed: true,
            }),
            Err(CallError::InvalidE164)
        );
        // DNC blocked
        assert_eq!(
            prepare_outbound_call(OutboundCallRequest {
                destination_e164: "+12025550199",
                owner_first_name: "Alex",
                facts: facts.clone(),
                voice: BrandVoiceProfile::miss_minutes(),
                local_minute_of_day: 10 * 60,
                policy: &policy,
                ledger: &ledger,
                owner_confirmed: true,
            }),
            Err(CallError::DoNotCallBlocked)
        );
        // Quiet hours 22:30
        assert!(matches!(
            prepare_outbound_call(OutboundCallRequest {
                destination_e164: "+12025550111",
                owner_first_name: "Alex",
                facts: facts.clone(),
                voice: BrandVoiceProfile::miss_minutes(),
                local_minute_of_day: 22 * 60 + 30,
                policy: &policy,
                ledger: &ledger,
                owner_confirmed: true,
            }),
            Err(CallError::QuietHoursBlocked { .. })
        ));
        // Valid daytime confirmed call
        let mut call = prepare_outbound_call(OutboundCallRequest {
            destination_e164: "+12025550111",
            owner_first_name: "Alex",
            facts,
            voice: BrandVoiceProfile::miss_minutes(),
            local_minute_of_day: 10 * 60,
            policy: &policy,
            ledger: &ledger,
            owner_confirmed: true,
        })
        .unwrap();
        assert_eq!(call.voice.voice_id(), BrandVoiceId::MissMinutesTva);
        // Cannot connect before delivering AI disclosure
        assert_eq!(call.mark_connected(), Err(CallError::InvalidTransition));
        call.mark_disclosed().unwrap();
        call.mark_connected().unwrap();
        call.complete().unwrap();
        assert_eq!(call.state, CallState::Completed);
    }
}

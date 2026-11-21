//! Offer legitimacy checking, scam filtering, and 50/35/15 weighted ranking.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrustSignals {
    pub verified_domain: bool,
    pub requires_upfront_fee_or_wire: bool,
    pub asks_off_platform_payment: bool,
    pub typosquatted_or_suspicious_url: bool,
    pub impossible_roi_or_urgency_pressure: bool,
    pub opaque_contact_or_masked_redirect: bool,
    pub transparent_terms_present: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OfferListing {
    pub id: String,
    pub title: String,
    pub source_domain: String,
    /// Fit score (0.0..=100.0) matching owner preferences/requirements.
    pub fit_score: f32,
    /// Clarity & completeness score (0.0..=100.0) of pricing, specs, deliverables.
    pub clarity_score: f32,
    /// Historical/domain legitimacy signal (0.0..=100.0) before hard scam deduction.
    pub base_legitimacy_score: f32,
    pub signals: TrustSignals,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScamFlag {
    UpfrontFeeOrWire,
    OffPlatformPayment,
    SuspiciousOrTyposquattedDomain,
    ImpossibleRoiOrUrgency,
    MaskedRedirectOrOpaqueContact,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RankedOffer {
    pub id: String,
    pub title: String,
    pub source_domain: String,
    pub rejected_as_scam: bool,
    pub scam_flags: Vec<ScamFlag>,
    pub legitimacy_component: f32,
    pub fit_component: f32,
    pub clarity_component: f32,
    pub total_score: f32,
}

pub fn evaluate_offer(listing: &OfferListing) -> RankedOffer {
    let mut flags = Vec::new();
    if listing.signals.requires_upfront_fee_or_wire {
        flags.push(ScamFlag::UpfrontFeeOrWire);
    }
    if listing.signals.asks_off_platform_payment {
        flags.push(ScamFlag::OffPlatformPayment);
    }
    if listing.signals.typosquatted_or_suspicious_url {
        flags.push(ScamFlag::SuspiciousOrTyposquattedDomain);
    }
    if listing.signals.impossible_roi_or_urgency_pressure {
        flags.push(ScamFlag::ImpossibleRoiOrUrgency);
    }
    if listing.signals.opaque_contact_or_masked_redirect {
        flags.push(ScamFlag::MaskedRedirectOrOpaqueContact);
    }

    let text = listing.title.to_ascii_lowercase();
    if text.contains("wire only")
        || text.contains("gift card")
        || text.contains("kindly pay upfront")
        || text.contains("guaranteed 500%")
    {
        if !flags.contains(&ScamFlag::UpfrontFeeOrWire)
            && (text.contains("wire") || text.contains("gift card") || text.contains("upfront"))
        {
            flags.push(ScamFlag::UpfrontFeeOrWire);
        }
        if !flags.contains(&ScamFlag::ImpossibleRoiOrUrgency) && text.contains("guaranteed 500%") {
            flags.push(ScamFlag::ImpossibleRoiOrUrgency);
        }
    }

    let rejected = !flags.is_empty();
    let leg_raw = if rejected {
        0.0
    } else {
        let mut l = listing.base_legitimacy_score.clamp(0.0, 100.0);
        if listing.signals.verified_domain {
            l = (l + 10.0).min(100.0);
        } else {
            l = (l - 15.0).max(0.0);
        }
        if listing.signals.transparent_terms_present {
            l = (l + 5.0).min(100.0);
        }
        l
    };
    let fit_raw = if rejected {
        0.0
    } else {
        listing.fit_score.clamp(0.0, 100.0)
    };
    let clarity_raw = if rejected {
        0.0
    } else {
        listing.clarity_score.clamp(0.0, 100.0)
    };

    // 50% legitimacy / 35% fit / 15% clarity
    let leg_comp = 0.50 * leg_raw;
    let fit_comp = 0.35 * fit_raw;
    let clarity_comp = 0.15 * clarity_raw;
    let total = if rejected {
        0.0
    } else {
        leg_comp + fit_comp + clarity_comp
    };

    RankedOffer {
        id: listing.id.clone(),
        title: listing.title.clone(),
        source_domain: listing.source_domain.clone(),
        rejected_as_scam: rejected,
        scam_flags: flags,
        legitimacy_component: leg_comp,
        fit_component: fit_comp,
        clarity_component: clarity_comp,
        total_score: total,
    }
}

pub fn rank_offers(listings: &[OfferListing]) -> Vec<RankedOffer> {
    let mut ranked: Vec<RankedOffer> = listings.iter().map(evaluate_offer).collect();
    ranked.sort_by(|a, b| {
        a.rejected_as_scam
            .cmp(&b.rejected_as_scam)
            .then_with(|| {
                b.total_score
                    .partial_cmp(&a.total_score)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| a.id.cmp(&b.id))
    });
    ranked
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corpus_of_50_listings_rejects_scams_and_ranks_by_50_35_15() {
        let mut listings = Vec::with_capacity(50);
        for i in 0..50usize {
            let is_scam = i % 2 == 0;
            listings.push(OfferListing {
                id: format!("offer-{i:02}"),
                title: if is_scam {
                    format!("Urgent Exclusive Opportunity #{i} - kindly pay upfront")
                } else {
                    format!("Verified Partner Offer #{i}")
                },
                source_domain: if is_scam {
                    "paypa1-verify.invalid".to_owned()
                } else {
                    "trusted.example.com".to_owned()
                },
                fit_score: (50 + (i % 45)) as f32,
                clarity_score: 80.0,
                base_legitimacy_score: 85.0,
                signals: TrustSignals {
                    verified_domain: !is_scam,
                    requires_upfront_fee_or_wire: is_scam,
                    asks_off_platform_payment: is_scam && i % 4 == 0,
                    typosquatted_or_suspicious_url: is_scam,
                    impossible_roi_or_urgency_pressure: is_scam,
                    opaque_contact_or_masked_redirect: false,
                    transparent_terms_present: !is_scam,
                },
            });
        }
        let ranked = rank_offers(&listings);
        assert_eq!(ranked.len(), 50);
        let legit_count = ranked.iter().take_while(|o| !o.rejected_as_scam).count();
        assert_eq!(legit_count, 25);
        for scam in &ranked[25..] {
            assert!(scam.rejected_as_scam);
            assert_eq!(scam.total_score, 0.0);
            assert!(!scam.scam_flags.is_empty());
        }
        assert!(ranked[0].total_score >= ranked[24].total_score);
    }
}

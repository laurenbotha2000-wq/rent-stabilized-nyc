//! Amenities mentioned in a listing description, as yes/no flags. Only the
//! flags are published, never the description text. Descriptions are often
//! truncated, so a missing flag means "not mentioned", not "doesn't have it".

use std::sync::LazyLock;

use regex::Regex;

struct Feature {
    name: &'static str,
    yes: Regex,
    /// wording that rules the amenity out ("no pets"), checked first
    no: Option<Regex>,
}

static FEATURES: LazyLock<Vec<Feature>> = LazyLock::new(|| {
    let re = |p: &str| Regex::new(&format!("(?i){p}")).unwrap();
    [
        ("dishwasher", r"\bdish\s?washer", Some(r"\bno\s+dish\s?washer")),
        (
            "laundry_unit",
            // needs in-unit wording: a washer/dryer "in the basement" doesn't count
            r"(washer\s*(/|and|&|\+)\s*dryer|w/d)\s*(in|inside)\s*(the\s*|every\s*|each\s*)?(unit|apartment|residence|home)|in[- ](unit|home|apartment) (washer|laundry|w/d)|private (washer|laundry)",
            None,
        ),
        ("laundry_building", r"laundry (room|facilit|in (the )?building|on (site|premises))|on-?site laundry|laundry in building", None),
        (
            "pets",
            r"pet[- ]friendly|pets? (are )?(allowed|welcome|ok)|cats? (and|&) dogs?|dog[- ]friendly",
            Some(r"\bno\s+(pets|dogs|cats)\b|pets?\s+(are\s+)?not\s+(allowed|permitted|accepted)|\bno[- ]pet\b"),
        ),
        ("elevator", r"\belevator", Some(r"\bno\s+elevator|\bwalk-?up\b")),
        ("doorman", r"\bdoorman|\bconcierge|24[- /]?(hour|hr)? ?(attended )?(lobby|door)", Some(r"\bno\s+doorman")),
        ("private_outdoor", r"\bbalcony|\bterrace|\bpatio|\bbackyard|private (outdoor|yard|garden)", None),
        ("roof_deck", r"roof ?deck|rooftop", None),
        ("gym", r"\bgym\b|fitness (center|room)", None),
        ("no_fee", r"\bno[- ]fee\b|no broker('s)? fee", None),
    ]
    .into_iter()
    .map(|(name, yes, no)| Feature { name, yes: re(yes), no: no.map(re) })
    .collect()
});

pub fn detect(description: &str) -> Vec<&'static str> {
    FEATURES
        .iter()
        .filter(|f| !f.no.as_ref().is_some_and(|n| n.is_match(description)) && f.yes.is_match(description))
        .map(|f| f.name)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::detect;

    #[test]
    fn detects_common_amenities() {
        let f = detect("Bright 1BR with dishwasher, W/D in unit, private balcony. Pet friendly! No fee.");
        for want in ["dishwasher", "laundry_unit", "private_outdoor", "pets", "no_fee"] {
            assert!(f.contains(&want), "missing {want} in {f:?}");
        }
        assert!(detect("Laundry room in the building, roof deck").contains(&"roof_deck"));
        assert!(detect("Cozy studio").is_empty());
    }

    #[test]
    fn respects_negations_and_context() {
        assert!(!detect("Sorry, no pets allowed.").contains(&"pets"));
        assert!(!detect("No dishwasher, but a great kitchen").contains(&"dishwasher"));
        assert!(!detect("Washer/dryer in the basement laundry room").contains(&"laundry_unit"));
        assert!(detect("Washer/dryer in the basement laundry room").contains(&"laundry_building"));
        assert!(detect("In-unit washer and dryer").contains(&"laundry_unit"));
        assert!(!detect("Fourth floor walk-up").contains(&"elevator"));
    }
}

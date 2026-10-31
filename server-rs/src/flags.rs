//! Our own rent-stabilization flags (port of flags.py).
//!
//!   IN_CITY_PDFS                     address is in the RGB building lists
//!   RENT_STABILIZED_TEXT_IN_LISTING  description mentions rent stabilization
//!   UNEVEN_PRICE                     RGB building + price not a multiple of $5

use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;
use serde::Deserialize;
use serde_json::Value;

use crate::source::Listing;

pub const IN_CITY_PDFS: &str = "IN_CITY_PDFS";
pub const TEXT_IN_LISTING: &str = "RENT_STABILIZED_TEXT_IN_LISTING";
pub const UNEVEN_PRICE: &str = "UNEVEN_PRICE";

/// One row of data/rgb_buildings.json (written by rgb.py).
#[derive(Debug, Deserialize)]
pub struct Building {
    pub zip: String,
    pub house_lo: Option<String>,
    pub house_hi: Option<String>,
    pub text: String,
    pub status: String,
    pub bbl: String,
}

const WORDS: &[(&str, &str)] = &[
    ("STREET", "ST"), ("AVENUE", "AVE"), ("ROAD", "RD"), ("PLACE", "PL"), ("BOULEVARD", "BLVD"),
    ("PARKWAY", "PKWY"), ("DRIVE", "DR"), ("TERRACE", "TER"), ("COURT", "CT"), ("LANE", "LN"),
    ("SQUARE", "SQ"), ("HIGHWAY", "HWY"), ("EXPRESSWAY", "EXPY"), ("TURNPIKE", "TPKE"),
    ("CONCOURSE", "CONC"), ("PLAZA", "PLZ"), ("CIRCLE", "CIR"), ("EAST", "E"), ("WEST", "W"),
    ("NORTH", "N"), ("SOUTH", "S"), ("SAINT", "ST"), ("FORT", "FT"), ("MOUNT", "MT"),
];

static ADDRESS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?P<num>\d+(?:-\d+)?[A-Z]?)\s+(?P<street>[^,]+),.*?(?P<zip>\d{5})\s*$").unwrap()
});
static ORDINAL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\d+)(ST|ND|RD|TH)").unwrap());
static DIGITS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\d+").unwrap());
// "_Rent Stabilized", "*STABILIZED RENT*", "RS apartment". The leading
// (^|[^a-z]) stands in for Python's (?<![a-z]); Rust regex has no lookbehind.
static STABILIZED_TEXT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i:(?:^|[^a-z])(?:rent[\s-]*stabili[sz](?:ed|ation)|stabili[sz]ed[\s-]*rent))|\bRS\s+(?i:apartment|apt|unit)",
    )
    .unwrap()
});

fn squash(s: &str) -> String {
    s.to_uppercase()
        .chars()
        .filter(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
        .collect()
}

/// "12THAVE" -> "12AVE": drop an ordinal suffix when a letter follows it.
fn strip_ordinals(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last = 0;
    for cap in ORDINAL.captures_iter(s) {
        let whole = cap.get(0).unwrap();
        let next_is_letter = s[whole.end()..].starts_with(|c: char| c.is_ascii_uppercase());
        if next_is_letter {
            out.push_str(&s[last..whole.start()]);
            out.push_str(&cap[1]);
            last = whole.end();
        }
    }
    out.push_str(&s[last..]);
    out
}

/// Spaceless spellings to look for in the RGB address text.
fn street_variants(street: &str) -> Vec<String> {
    let upper = street.to_uppercase().replace('.', "");
    let words: Vec<&str> = upper.split_whitespace().collect();
    let short: Vec<&str> = words
        .iter()
        .map(|w| WORDS.iter().find(|(k, _)| k == w).map_or(*w, |(_, v)| *v))
        .collect();
    let mut variants = vec![squash(&short.join(" ")), squash(&words.join(" "))];
    // "Avenue M" is listed as "AVENUE M"; "5th Avenue" as "5TH AVE" / "5 AVE"
    if words.first() == Some(&"AVENUE") {
        variants.push(squash(&format!("AVENUE {}", short[1..].join(" "))));
    }
    variants.push(strip_ordinals(&squash(&short.join(" "))));
    variants.retain(|v| !v.is_empty());
    variants.sort();
    variants.dedup();
    variants
}

/// "11-15" -> [11, 15]; "286" -> [286]; letters dropped.
fn house_key(n: Option<&str>) -> Vec<u64> {
    DIGITS
        .find_iter(n.unwrap_or(""))
        .map(|m| m.as_str().parse().unwrap_or(u64::MAX))
        .collect()
}

struct Entry {
    lo: Vec<u64>,
    hi: Vec<u64>,
    text: String,
    row: usize,
}

pub struct BuildingIndex {
    rows: Vec<Building>,
    by_zip: HashMap<String, Vec<Entry>>,
}

impl BuildingIndex {
    pub fn new(rows: Vec<Building>) -> Self {
        let mut by_zip: HashMap<String, Vec<Entry>> = HashMap::new();
        for (i, r) in rows.iter().enumerate() {
            by_zip.entry(r.zip.clone()).or_default().push(Entry {
                lo: house_key(r.house_lo.as_deref()),
                hi: house_key(r.house_hi.as_deref()),
                text: squash(&r.text),
                row: i,
            });
        }
        Self { rows, by_zip }
    }

    pub fn len(&self) -> usize {
        self.rows.len()
    }

    pub fn find(&self, address: &str) -> Option<&Building> {
        let upper = address.trim().to_uppercase();
        let m = ADDRESS.captures(&upper)?;
        let num = house_key(Some(&m["num"]));
        let variants = street_variants(&m["street"]);
        let entries = self.by_zip.get(&m["zip"])?;
        let hit = entries
            .iter()
            .find(|e| {
                e.lo.len() == num.len()
                    && e.lo <= num
                    && num <= e.hi
                    && variants.iter().any(|v| e.text.starts_with(v.as_str()))
            })
            // corner buildings carry a second address later in the text
            .or_else(|| {
                let n = squash(&m["num"]);
                entries
                    .iter()
                    .find(|e| variants.iter().any(|v| e.text.contains(&format!("{n}{v}"))))
            })?;
        Some(&self.rows[hit.row])
    }
}

/// Reasier's rule, recovered from their data (293/293, no errors): only
/// applied to RGB buildings, and "uneven" means not a multiple of $5.
fn is_uneven(price: f64) -> bool {
    price % 5.0 != 0.0
}

pub fn our_reasons<'a>(listing: &Listing, index: &'a BuildingIndex) -> (Vec<&'static str>, Option<&'a Building>) {
    let mut reasons = Vec::new();
    let address = listing.get("address").and_then(Value::as_str).unwrap_or_default();
    let building = index.find(address);
    if building.is_some() {
        reasons.push(IN_CITY_PDFS);
    }
    let desc = listing.get("description").and_then(Value::as_str).unwrap_or_default();
    if STABILIZED_TEXT.is_match(desc) {
        reasons.push(TEXT_IN_LISTING);
    }
    let price = listing.get("price").and_then(Value::as_f64);
    if building.is_some() && price.is_some_and(is_uneven) {
        reasons.push(UNEVEN_PRICE);
    }
    (reasons, building)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn variants_and_ordinals() {
        let v = street_variants("East 44th Street");
        assert!(v.contains(&"E44THST".to_string()));
        assert!(v.contains(&"E44ST".to_string()));
        assert!(street_variants("Avenue M").contains(&"AVENUEM".to_string()));
    }

    #[test]
    fn house_keys() {
        assert_eq!(house_key(Some("11-15")), vec![11, 15]);
        assert_eq!(house_key(Some("971A")), vec![971]);
        assert!(house_key(None).is_empty());
    }

    #[test]
    fn stabilized_text() {
        assert!(STABILIZED_TEXT.is_match("_Rent Stabilized unit"));
        assert!(STABILIZED_TEXT.is_match("*STABILIZED RENT*"));
        assert!(STABILIZED_TEXT.is_match("Gorgeous, RS apartment"));
        assert!(!STABILIZED_TEXT.is_match("current stabilized"));
        assert!(!STABILIZED_TEXT.is_match("rs apartment"));
    }
}

//! Fetch Reasier's public list and pull `initialListings` out of the Next.js
//! RSC payload embedded in the HTML (port of reasier.py `fetch_from_page`).

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use anyhow::{anyhow, Context, Result};
use regex::Regex;
use serde_json::{Map, Value};

pub const PAGE_URL: &str = "https://www.reasier.com/current-rent-stabilized";
pub const USER_AGENT: &str = "Mozilla/5.0 (personal reasier-client)";

pub type Listing = Map<String, Value>;

static CHUNK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?s)self\.__next_f\.push\(\[1,"(.*?)"\]\)</script>"#).unwrap()
});

pub async fn fetch_listings(client: &reqwest::Client) -> Result<Vec<Listing>> {
    let html = client
        .get(PAGE_URL)
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    parse_page(&html)
}

pub fn parse_page(html: &str) -> Result<Vec<Listing>> {
    // Next.js streams its RSC payload as JS-string chunks: self.__next_f.push([1,"..."])
    let mut rsc = String::with_capacity(html.len() / 2);
    for cap in CHUNK.captures_iter(html) {
        let lit = format!("\"{}\"", &cap[1]);
        let s: String = serde_json::from_str(&lit).context("bad RSC chunk literal")?;
        rsc.push_str(&s);
    }
    let start = rsc
        .find(r#"{"initialListings":"#)
        .ok_or_else(|| anyhow!("initialListings not found; the page structure changed"))?;
    let obj: Value = serde_json::Deserializer::from_str(&rsc[start..])
        .into_iter::<Value>()
        .next()
        .ok_or_else(|| anyhow!("empty initialListings"))??;
    let Value::Array(items) = obj
        .get("initialListings")
        .cloned()
        .unwrap_or(Value::Null)
    else {
        return Err(anyhow!("initialListings is not an array"));
    };

    // Long strings are hoisted into separate text rows and referenced as "$<id>"
    let texts = rsc_text_rows(&rsc);
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let Value::Object(mut listing) = item else { continue };
        for v in listing.values_mut() {
            if let Value::String(s) = v {
                if let Some(id) = s.strip_prefix('$') {
                    if !id.is_empty() && id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
                        if let Some(t) = texts.get(id) {
                            *s = t.clone();
                        }
                    }
                }
            }
        }
        out.push(listing);
    }
    Ok(out)
}

/// Parse RSC rows; return {id: text} for text rows ("<id>:T<hex byte len>,<text>").
fn rsc_text_rows(rsc: &str) -> HashMap<String, String> {
    let data = rsc.as_bytes();
    let mut texts = HashMap::new();
    let mut pos = 0;
    let is_hex = |b: u8| b.is_ascii_digit() || (b'a'..=b'f').contains(&b);
    let skip_line = |pos: usize| match memchr(b'\n', &data[pos..]) {
        Some(i) => pos + i + 1,
        None => data.len(),
    };
    while pos < data.len() {
        let mut i = pos;
        while i < data.len() && is_hex(data[i]) {
            i += 1;
        }
        if i == pos || i >= data.len() || data[i] != b':' {
            pos = skip_line(pos); // not at a row boundary
            continue;
        }
        let id = &rsc[pos..i];
        let after_colon = i + 1;
        // optional "T<hexlen>,"
        let mut j = after_colon;
        if j < data.len() && data[j] == b'T' {
            j += 1;
            let len_start = j;
            while j < data.len() && is_hex(data[j]) {
                j += 1;
            }
            if j > len_start && j < data.len() && data[j] == b',' {
                let len = usize::from_str_radix(&rsc[len_start..j], 16).unwrap_or(0);
                let body_start = j + 1;
                let end = (body_start + len).min(data.len());
                texts.insert(
                    id.to_string(),
                    String::from_utf8_lossy(&data[body_start..end]).into_owned(),
                );
                pos = end;
                continue;
            }
        }
        pos = skip_line(after_colon);
    }
    texts
}

fn memchr(needle: u8, hay: &[u8]) -> Option<usize> {
    hay.iter().position(|&b| b == needle)
}

/// Drop repeated URLs, keeping the first occurrence (the source occasionally repeats one).
pub fn dedupe(listings: Vec<Listing>) -> Vec<Listing> {
    let mut seen = HashSet::new();
    listings
        .into_iter()
        .filter(|l| {
            let url = l.get("url").and_then(Value::as_str).unwrap_or_default();
            seen.insert(url.to_string())
        })
        .collect()
}

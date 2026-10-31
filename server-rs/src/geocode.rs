//! Map coordinates via NYC Planning's GeoSearch (free, no key):
//! https://geosearch.planninglabs.nyc. Each address is looked up once; the
//! result (or the failed attempt) is stored on the listing.

use std::path::Path;
use std::time::Duration;

use anyhow::Result;
use serde_json::Value;

use crate::store;

const GEOSEARCH: &str = "https://geosearch.planninglabs.nyc/v2/search";
/// GeoSearch is a shared public service; stay well under any reasonable limit.
const PAUSE: Duration = Duration::from_millis(150);

pub struct Point {
    pub lat: f64,
    pub lng: f64,
    pub bbl: Option<String>,
}

async fn lookup(client: &reqwest::Client, address: &str) -> Result<Option<Point>> {
    let body: Value = client
        .get(GEOSEARCH)
        .query(&[("text", address), ("size", "1")])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let Some(f) = body["features"].get(0) else { return Ok(None) };
    let c = &f["geometry"]["coordinates"];
    let (Some(lng), Some(lat)) = (c[0].as_f64(), c[1].as_f64()) else { return Ok(None) };
    let bbl = f["properties"]["addendum"]["pad"]["bbl"].as_str().map(str::to_string);
    Ok(Some(Point { lat, lng, bbl }))
}

/// Geocode every listing that hasn't been tried yet. Returns how many got coordinates.
pub async fn fill_missing(client: &reqwest::Client, db_path: &Path) -> Result<usize> {
    let pending = {
        let db_path = db_path.to_path_buf();
        tokio::task::spawn_blocking(move || store::ungeocoded(&store::open(&db_path)?)).await??
    };
    if pending.is_empty() {
        return Ok(0);
    }
    let mut results = Vec::with_capacity(pending.len());
    for (url, address) in pending {
        // a failed lookup is recorded as attempted so it isn't retried every sync
        results.push((url, lookup(client, &address).await.unwrap_or(None)));
        tokio::time::sleep(PAUSE).await;
    }
    let found = results.iter().filter(|(_, p)| p.is_some()).count();
    let db_path = db_path.to_path_buf();
    tokio::task::spawn_blocking(move || store::set_locations(&mut store::open(&db_path)?, &results)).await??;
    Ok(found)
}

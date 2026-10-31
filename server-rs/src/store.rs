//! SQLite history (same schema as db.py, so either can run against reasier.db)
//! plus the in-memory snapshot the API serves from.

use std::collections::HashMap;
use std::path::Path;

use anyhow::Result;
use rusqlite::types::{Value as Sql, ValueRef};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::value::RawValue;
use serde_json::{Map, Value};

use crate::flags::{our_reasons, BuildingIndex};
use crate::source::Listing;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS listings (
  url TEXT PRIMARY KEY,
  price INTEGER, beds INTEGER, baths REAL, sqft INTEGER,
  neighborhood TEXT, address TEXT, likes INTEGER, time_on_market INTEGER,
  income_restricted INTEGER, reasons TEXT, description TEXT,
  status TEXT,            -- ACTIVE | DELISTED
  first_seen TEXT, last_seen TEXT, delisted_at TEXT,
  reasier_reasons TEXT, bbl TEXT
);
CREATE TABLE IF NOT EXISTS snapshots (
  url TEXT, scraped_at TEXT, price INTEGER, likes INTEGER, time_on_market INTEGER,
  PRIMARY KEY (url, scraped_at)
);
CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status, first_seen);
";
const ADDED_COLUMNS: &[(&str, &str)] = &[
    ("reasier_reasons", "TEXT"),
    ("bbl", "TEXT"),
    ("lat", "REAL"),
    ("lng", "REAL"),
    ("geo_bbl", "TEXT"),
    ("geocoded_at", "TEXT"),
];

pub fn open(path: &Path) -> Result<Connection> {
    let con = Connection::open(path)?;
    con.pragma_update(None, "journal_mode", "WAL")?;
    con.pragma_update(None, "synchronous", "NORMAL")?;
    con.execute_batch(SCHEMA)?;
    let have: Vec<String> = con
        .prepare("PRAGMA table_info(listings)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<Result<_, _>>()?;
    for (col, typ) in ADDED_COLUMNS {
        if !have.iter().any(|h| h == col) {
            con.execute(&format!("ALTER TABLE listings ADD COLUMN {col} {typ}"), [])?;
        }
    }
    Ok(con)
}

/// Same binding rules as Python's sqlite3: int -> INTEGER, float -> REAL, bool -> 0/1.
fn sql(v: Option<&Value>) -> Sql {
    match v {
        None | Some(Value::Null) => Sql::Null,
        Some(Value::Bool(b)) => Sql::Integer(*b as i64),
        Some(Value::Number(n)) => n.as_i64().map_or_else(|| Sql::Real(n.as_f64().unwrap_or(0.0)), Sql::Integer),
        Some(Value::String(s)) => Sql::Text(s.clone()),
        Some(other) => Sql::Text(other.to_string()),
    }
}

fn as_f64(v: &Sql) -> Option<f64> {
    match v {
        Sql::Integer(i) => Some(*i as f64),
        Sql::Real(f) => Some(*f),
        _ => None,
    }
}

/// Listings whose address hasn't been geocoded yet: (url, address).
pub fn ungeocoded(con: &Connection) -> Result<Vec<(String, String)>> {
    let mut stmt = con.prepare(
        "SELECT url, address FROM listings WHERE geocoded_at IS NULL AND address IS NOT NULL",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
    Ok(rows)
}

pub fn set_locations(con: &mut Connection, results: &[(String, Option<crate::geocode::Point>)]) -> Result<()> {
    let tx = con.transaction()?;
    {
        let mut upd = tx.prepare_cached(
            "UPDATE listings SET lat=?2, lng=?3, geo_bbl=?4, geocoded_at=?5 WHERE url=?1",
        )?;
        let now = now_iso();
        for (url, p) in results {
            upd.execute(params![
                url,
                p.as_ref().map(|p| p.lat),
                p.as_ref().map(|p| p.lng),
                p.as_ref().and_then(|p| p.bbl.clone()),
                now
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct SyncStats {
    pub active: usize,
    pub new: usize,
    pub price_changed: usize,
    pub delisted: usize,
}

pub fn now_iso() -> String {
    // matches Python's datetime.now(timezone.utc).isoformat(timespec="seconds")
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S+00:00").to_string()
}

/// Upsert current listings, record snapshots and price changes, mark vanished
/// listings DELISTED. `listings` must already be deduplicated by URL.
pub fn sync(con: &mut Connection, listings: &[Listing], index: &BuildingIndex, now: &str) -> Result<SyncStats> {
    let tx = con.transaction()?;
    let (mut new, mut changed) = (0, 0);
    {
        let mut prev_price = tx.prepare_cached("SELECT price FROM listings WHERE url=?")?;
        let mut upsert = tx.prepare_cached(
            "INSERT INTO listings (url, price, beds, baths, sqft, neighborhood, address,
               likes, time_on_market, income_restricted, reasons, description, status,
               first_seen, last_seen, reasier_reasons, bbl)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'ACTIVE',?13,?13,?14,?15)
             ON CONFLICT(url) DO UPDATE SET
               reasier_reasons=excluded.reasier_reasons, bbl=excluded.bbl,
               price=excluded.price, beds=excluded.beds, baths=excluded.baths,
               sqft=excluded.sqft, neighborhood=excluded.neighborhood,
               address=excluded.address, likes=excluded.likes,
               time_on_market=excluded.time_on_market,
               income_restricted=excluded.income_restricted,
               reasons=excluded.reasons, description=excluded.description,
               status='ACTIVE', last_seen=excluded.last_seen, delisted_at=NULL",
        )?;
        let mut snapshot = tx.prepare_cached("INSERT OR IGNORE INTO snapshots VALUES (?,?,?,?,?)")?;
        let mut last_snapshot = tx.prepare_cached(
            "SELECT price, likes, time_on_market FROM snapshots WHERE url=? ORDER BY scraped_at DESC LIMIT 1",
        )?;

        for l in listings {
            let url = sql(l.get("url"));
            let price = sql(l.get("price"));
            let prev: Option<Sql> = prev_price.query_row([&url], |r| r.get(0)).optional()?;
            match prev {
                None => new += 1,
                Some(p) if as_f64(&p) != as_f64(&price) => changed += 1,
                _ => {}
            }
            let (reasons, building) = our_reasons(l, index);
            let income = l.get("incomeRestricted").map_or(false, |v| match v {
                Value::Bool(b) => *b,
                Value::Null => false,
                Value::Number(n) => n.as_f64() != Some(0.0),
                Value::String(s) => !s.is_empty(),
                _ => true,
            });
            let reasier = l.get("rentStabilizedReasons").cloned().filter(|v| !v.is_null()).unwrap_or(Value::Array(vec![]));
            upsert.execute(params![
                url,
                price,
                sql(l.get("beds")),
                sql(l.get("baths")),
                sql(l.get("sqft")),
                sql(l.get("neighborhood")),
                sql(l.get("address")),
                sql(l.get("likes")),
                sql(l.get("timeOnMarket")),
                income as i64,
                serde_json::to_string(&reasons)?,
                sql(l.get("description")),
                now,
                serde_json::to_string(&reasier)?,
                building.map(|b| b.bbl.clone()),
            ])?;
            // history only grows when something changed; last_seen covers "still listed"
            let current = [price, sql(l.get("likes")), sql(l.get("timeOnMarket"))];
            let previous: Option<[Sql; 3]> = last_snapshot
                .query_row([&url], |r| Ok([r.get(0)?, r.get(1)?, r.get(2)?]))
                .optional()?;
            if previous.as_ref() != Some(&current) {
                let [price, likes, tom] = current;
                snapshot.execute(params![url, now, price, likes, tom])?;
            }
        }
    }
    let delisted = tx.execute(
        "UPDATE listings SET status='DELISTED', delisted_at=?1 WHERE status='ACTIVE' AND last_seen<?1",
        [now],
    )?;
    tx.commit()?;
    Ok(SyncStats { active: listings.len(), new, price_changed: changed, delisted })
}

/// A listing ready to serve: the fields the filters need, plus its JSON
/// (pre-serialized once per sync so requests only concatenate bytes).
pub struct Row {
    pub url: String,
    pub price: Option<f64>,
    pub beds: Option<f64>,
    pub baths: Option<f64>,
    pub neighborhood: Option<String>,
    pub active: bool,
    pub reasons: Vec<String>,
    pub json: Box<RawValue>,
    pub json_v2: Box<RawValue>,
}

#[derive(Default)]
pub struct State {
    /// sorted like the Python API: first_seen DESC, url ASC
    pub rows: Vec<Row>,
    pub neighborhoods: Vec<String>,
}

fn to_json(v: ValueRef) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::from(i),
        ValueRef::Real(f) => Value::from(f),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Value::String(String::from_utf8_lossy(b).into_owned()),
    }
}

fn parse_list(v: &Value) -> Value {
    match v {
        Value::String(s) if !s.is_empty() => serde_json::from_str(s).unwrap_or(Value::Array(vec![])),
        _ => Value::Array(vec![]),
    }
}

pub fn load_state(con: &Connection) -> Result<State> {
    let mut snaps: HashMap<String, Vec<Value>> = HashMap::new();
    let mut stmt = con.prepare(
        "SELECT url, scraped_at, price, likes, time_on_market FROM snapshots ORDER BY url, scraped_at DESC",
    )?;
    let mut q = stmt.query([])?;
    while let Some(r) = q.next()? {
        let mut m = Map::new();
        for (i, k) in ["scraped_at", "price", "likes", "time_on_market"].iter().enumerate() {
            m.insert((*k).into(), to_json(r.get_ref(i + 1)?));
        }
        snaps.entry(r.get(0)?).or_default().push(Value::Object(m));
    }

    let mut stmt = con.prepare("SELECT * FROM listings ORDER BY first_seen DESC, url")?;
    let cols: Vec<String> = stmt.column_names().map(str::to_string).collect();
    let mut q = stmt.query([])?;
    let mut rows = Vec::new();
    let mut hoods = std::collections::BTreeSet::new();
    while let Some(r) = q.next()? {
        let mut m = Map::new();
        for (i, c) in cols.iter().enumerate() {
            m.insert(c.clone(), to_json(r.get_ref(i)?));
        }
        let reasons = parse_list(&m["reasons"]);
        m["reasons"] = reasons.clone();
        m["reasier_reasons"] = parse_list(&m["reasier_reasons"]);
        m["income_restricted"] = Value::Bool(match &m["income_restricted"] {
            Value::Number(n) => n.as_f64() != Some(0.0),
            Value::Null => false,
            _ => true,
        });
        let [price, beds, baths] = ["price", "beds", "baths"].map(|k| m.get(k).and_then(Value::as_f64));
        let url = m["url"].as_str().unwrap_or_default().to_string();
        let active = m["status"].as_str() == Some("ACTIVE");
        let neighborhood = m["neighborhood"].as_str().map(str::to_string);
        if active {
            if let Some(h) = &neighborhood {
                hoods.insert(h.clone());
            }
        }
        let json = serde_json::value::to_raw_value(&m)?;
        m.insert("data".into(), Value::Array(snaps.remove(&url).unwrap_or_default()));
        let json_v2 = serde_json::value::to_raw_value(&m)?;
        rows.push(Row {
            url,
            price,
            beds,
            baths,
            neighborhood,
            active,
            reasons: reasons
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                .unwrap_or_default(),
            json,
            json_v2,
        });
    }
    Ok(State { rows, neighborhoods: hoods.into_iter().collect() })
}

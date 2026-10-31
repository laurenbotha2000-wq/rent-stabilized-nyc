"""SQLite store + daily sync of Reasier's public list.

Each sync upserts current listings, records any price change, and marks
listings that vanished since the last sync as DELISTED. Run it once a day
and you accumulate your own history (first seen, price changes, delistings).

`reasons` holds our own flags (flags.py, from the RGB building lists);
Reasier's flags are kept in `reasier_reasons` for comparison.

  python3 rgb.py       # once, or when RGB publishes a new list
  python3 db.py sync
"""

import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

from flags import BuildingIndex, our_reasons
from reasier import fetch_from_page

DB_PATH = Path(__file__).parent / "reasier.db"
RGB_PATH = Path(__file__).parent / "data" / "rgb_buildings.json"

SCHEMA = """
CREATE TABLE IF NOT EXISTS listings (
  url TEXT PRIMARY KEY,
  price INTEGER, beds INTEGER, baths REAL, sqft INTEGER,
  neighborhood TEXT, address TEXT, likes INTEGER, time_on_market INTEGER,
  income_restricted INTEGER, reasons TEXT, description TEXT,
  status TEXT,            -- ACTIVE | DELISTED
  first_seen TEXT, last_seen TEXT, delisted_at TEXT
);
CREATE TABLE IF NOT EXISTS snapshots (
  url TEXT, scraped_at TEXT, price INTEGER, likes INTEGER, time_on_market INTEGER,
  PRIMARY KEY (url, scraped_at)
);
CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status, first_seen);
"""
ADDED_COLUMNS = {"reasier_reasons": "TEXT", "bbl": "TEXT"}


def connect(path=DB_PATH):
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    have = {r["name"] for r in con.execute("PRAGMA table_info(listings)")}
    for col, typ in ADDED_COLUMNS.items():
        if col not in have:
            con.execute(f"ALTER TABLE listings ADD COLUMN {col} {typ}")
    return con


def sync(con, rows=None):
    if not RGB_PATH.exists():
        sys.exit("data/rgb_buildings.json missing; run: python3 rgb.py")
    index = BuildingIndex(json.loads(RGB_PATH.read_text()))
    rows = fetch_from_page() if rows is None else rows
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    seen = set()
    new = changed = 0
    for r in rows:
        if r["url"] in seen:  # the source occasionally repeats a URL
            continue
        seen.add(r["url"])
        prev = con.execute("SELECT price FROM listings WHERE url=?", (r["url"],)).fetchone()
        if prev is None:
            new += 1
        elif prev["price"] != r["price"]:
            changed += 1
        reasons, building = our_reasons(r, index)
        con.execute("""
          INSERT INTO listings (url, price, beds, baths, sqft, neighborhood, address,
            likes, time_on_market, income_restricted, reasons, description, status,
            first_seen, last_seen, reasier_reasons, bbl)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'ACTIVE',?,?,?,?)
          ON CONFLICT(url) DO UPDATE SET
            reasier_reasons=excluded.reasier_reasons, bbl=excluded.bbl,
            price=excluded.price, beds=excluded.beds, baths=excluded.baths,
            sqft=excluded.sqft, neighborhood=excluded.neighborhood,
            address=excluded.address, likes=excluded.likes,
            time_on_market=excluded.time_on_market,
            income_restricted=excluded.income_restricted,
            reasons=excluded.reasons, description=excluded.description,
            status='ACTIVE', last_seen=excluded.last_seen, delisted_at=NULL
        """, (r["url"], r["price"], r.get("beds"), r.get("baths"), r.get("sqft"),
              r.get("neighborhood"), r.get("address"), r.get("likes"),
              r.get("timeOnMarket"), int(bool(r.get("incomeRestricted"))),
              json.dumps(reasons), r.get("description"), now, now,
              json.dumps(r.get("rentStabilizedReasons") or []),
              building["bbl"] if building else None))
        con.execute("INSERT OR IGNORE INTO snapshots VALUES (?,?,?,?,?)",
                    (r["url"], now, r["price"], r.get("likes"), r.get("timeOnMarket")))
    gone = con.execute("""UPDATE listings SET status='DELISTED', delisted_at=?
                          WHERE status='ACTIVE' AND last_seen<?""", (now, now)).rowcount
    con.commit()
    return {"active": len(seen), "new": new, "price_changed": changed, "delisted": gone}


if __name__ == "__main__":
    if sys.argv[1:] != ["sync"]:
        sys.exit("usage: python3 db.py sync")
    print(sync(connect()))

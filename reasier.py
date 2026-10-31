"""Fetch Reasier's rent-stabilized NYC listings.

Two sources, same output shape:
  - "page": the public list at reasier.com/current-rent-stabilized. The full
    dataset is embedded in the HTML's Next.js RSC payload (initialListings).
    Free; personal use, be polite (it only changes ~daily).
  - "api":  the official paid API at api.reasier.com (needs REASIER_API_KEY).
    Note: the API returns ALL active rentals (not just stabilized ones) and
    raw string fields ("$4,995", "1 bath"), so it is normalized below.

Usage:
  python3 reasier.py                      # page source -> listings.json
  python3 reasier.py --neighborhood Bushwick --max-price 3000
  REASIER_API_KEY=rsr_... python3 reasier.py --source api
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

PAGE_URL = "https://www.reasier.com/current-rent-stabilized"
API_BASE = "https://api.reasier.com/reasier/api"
UA = "Mozilla/5.0 (personal reasier-client)"


def _get(url, headers=None):
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8")


def fetch_from_page():
    html = _get(PAGE_URL)
    # Next.js streams its RSC payload as JS-string chunks: self.__next_f.push([1,"..."])
    chunks = re.findall(r'self\.__next_f\.push\(\[1,"(.*?)"\]\)</script>', html, re.S)
    rsc = "".join(json.loads('"' + c + '"') for c in chunks)
    start = rsc.find('{"initialListings":')
    if start < 0:
        raise RuntimeError("initialListings not found; the page structure changed")
    obj, _ = json.JSONDecoder().raw_decode(rsc, start)
    # Long strings are hoisted into separate text rows and referenced as "$<id>"
    texts = _rsc_text_rows(rsc)
    for listing in obj["initialListings"]:
        for k, v in listing.items():
            if isinstance(v, str) and re.fullmatch(r"\$[0-9a-f]+", v) and v[1:] in texts:
                listing[k] = texts[v[1:]]
    return obj["initialListings"]


def _rsc_text_rows(rsc):
    """Parse RSC rows; return {id: text} for text rows ("<id>:T<hex byte len>,<text>")."""
    data, pos, texts = rsc.encode("utf-8"), 0, {}
    header = re.compile(rb"([0-9a-f]+):(T([0-9a-f]+),)?")
    while pos < len(data):
        m = header.match(data, pos)
        if not m:  # not at a row boundary; skip to the next line
            nl = data.find(b"\n", pos)
            pos = len(data) if nl < 0 else nl + 1
            continue
        if m.group(2):
            end = m.end() + int(m.group(3), 16)
            texts[m.group(1).decode()] = data[m.end():end].decode("utf-8", "replace")
            pos = end
        else:
            nl = data.find(b"\n", m.end())
            pos = len(data) if nl < 0 else nl + 1
    return texts


def _num(s):
    if s is None or isinstance(s, (int, float)):
        return s
    if "studio" in str(s).lower():
        return 0
    m = re.search(r"[\d,.]+", str(s))
    return float(m.group().replace(",", "")) if m else None


def _normalize_api(r):
    layout = r.get("layout") or {}
    beds, baths = _num(layout.get("beds")), _num(layout.get("baths"))
    return {
        "url": r.get("url"),
        "price": int(_num(r.get("price")) or 0),
        "beds": int(beds) if beds is not None else None,
        "baths": baths,
        "sqft": _num(layout.get("sqft")),
        "neighborhood": r.get("neighborhood"),
        "address": r.get("address"),
        "likes": r.get("savedNum"),
        "timeOnMarket": r.get("latestTimeOnMarket"),
        "images": r.get("images") or [],
        "raw": r,
    }


def fetch_from_api(key, neighborhood=None, min_price=None, max_price=None, beds=None):
    params = {k: v for k, v in {
        "neighborhood": neighborhood, "minPrice": min_price,
        "maxPrice": max_price, "beds": beds}.items() if v is not None}
    out, page = [], 1
    while True:
        q = urllib.parse.urlencode({**params, "page": page})
        data = json.loads(_get(f"{API_BASE}/listings?{q}", {"x-api-key": key}))
        rows = data.get("data", data if isinstance(data, list) else [])
        out += [_normalize_api(r) for r in rows]
        pag = data.get("pagination") or {}
        if not rows or len(out) >= pag.get("total", 0):
            return out
        page += 1
        time.sleep(0.25)  # documented limit is 5 req/s


def filter_listings(rows, neighborhood=None, min_price=None, max_price=None,
                    beds=None, reasons=None):
    hoods = {h.strip().lower() for h in neighborhood.split(",")} if neighborhood else None
    res = []
    for r in rows:
        if hoods and (r.get("neighborhood") or "").lower() not in hoods:
            continue
        if min_price and r["price"] < min_price:
            continue
        if max_price and r["price"] > max_price:
            continue
        if beds is not None and r.get("beds") != beds:
            continue
        # Same semantics as the site: match ANY selected indicator
        if reasons and not set(reasons) & set(r.get("rentStabilizedReasons") or []):
            continue
        res.append(r)
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", choices=["page", "api"], default="page")
    ap.add_argument("--neighborhood", help="comma-separated")
    ap.add_argument("--min-price", type=int)
    ap.add_argument("--max-price", type=int)
    ap.add_argument("--beds", type=int)
    ap.add_argument("--reason", action="append",
                    choices=["IN_CITY_PDFS", "UNEVEN_PRICE", "RENT_STABILIZED_TEXT_IN_LISTING"],
                    help="page source only; repeatable")
    ap.add_argument("-o", "--out", default="listings.json")
    a = ap.parse_args()

    if a.source == "api":
        key = os.environ.get("REASIER_API_KEY")
        if not key:
            sys.exit("Set REASIER_API_KEY (get one at reasier.com/api)")
        rows = fetch_from_api(key, a.neighborhood, a.min_price, a.max_price, a.beds)
    else:
        rows = fetch_from_page()

    rows = filter_listings(rows, a.neighborhood, a.min_price, a.max_price, a.beds, a.reason)
    with open(a.out, "w") as f:
        json.dump(rows, f, indent=1)
    print(f"{len(rows)} listings -> {a.out}")
    for r in rows[:10]:
        print(f"  ${r['price']:>6,}  {r.get('beds')}bd  {r.get('neighborhood'):<20} {r['address']}")


if __name__ == "__main__":
    main()

"""Our own rent-stabilization flags, scored against Reasier's.

  IN_CITY_PDFS                     address is in the RGB building lists (rgb.py)
  RENT_STABILIZED_TEXT_IN_LISTING  description mentions rent stabilization
  UNEVEN_PRICE                     RGB building + price not a "marketing" round number

  python3 flags.py            # scores against a fresh snapshot of reasier.com
  python3 flags.py --cached   # reuse data/reasier_snapshot.json
"""

import json
import re
import sys
from collections import defaultdict
from pathlib import Path

DATA = Path(__file__).parent / "data"
REASONS = ["IN_CITY_PDFS", "RENT_STABILIZED_TEXT_IN_LISTING", "UNEVEN_PRICE"]

WORDS = {
    "STREET": "ST", "AVENUE": "AVE", "ROAD": "RD", "PLACE": "PL", "BOULEVARD": "BLVD",
    "PARKWAY": "PKWY", "DRIVE": "DR", "TERRACE": "TER", "COURT": "CT", "LANE": "LN",
    "SQUARE": "SQ", "HIGHWAY": "HWY", "EXPRESSWAY": "EXPY", "TURNPIKE": "TPKE",
    "CONCOURSE": "CONC", "PLAZA": "PLZ", "CIRCLE": "CIR", "EAST": "E", "WEST": "W",
    "NORTH": "N", "SOUTH": "S", "SAINT": "ST", "FORT": "FT", "MOUNT": "MT",
}
ADDRESS = re.compile(r"^(?P<num>\d+(?:-\d+)?[A-Z]?)\s+(?P<street>[^,]+),.*?(?P<zip>\d{5})\s*$")


def squash(s):
    return re.sub(r"[^A-Z0-9]", "", s.upper())


def street_variants(street):
    """Spaceless spellings to look for in the RGB address text."""
    words = street.upper().replace(".", "").split()
    short = [WORDS.get(w, w) for w in words]
    variants = {squash(" ".join(short)), squash(" ".join(words))}
    # "Avenue M" is listed as "AVENUE M"; "5th Avenue" as "5TH AVE" / "5 AVE"
    if words and words[0] == "AVENUE":
        variants.add(squash("AVENUE " + " ".join(short[1:])))
    variants.add(re.sub(r"(\d+)(ST|ND|RD|TH)(?=[A-Z])", r"\1", squash(" ".join(short))))
    return {v for v in variants if v}


def house_key(n):
    """'11-15' -> (11, 15); '286' -> (286,); letters dropped."""
    return tuple(int(p) for p in re.findall(r"\d+", n or ""))


class BuildingIndex:
    def __init__(self, rows):
        self.by_zip = defaultdict(list)
        for r in rows:
            self.by_zip[r["zip"]].append(
                (house_key(r["house_lo"]), house_key(r["house_hi"]), squash(r["text"]), r))

    def match(self, address):
        m = ADDRESS.match(address.strip().upper())
        if not m:
            return None
        num, variants = house_key(m["num"]), street_variants(m["street"])
        for lo, hi, text, row in self.by_zip.get(m["zip"], []):
            if len(lo) == len(num) and lo <= num <= hi and any(text.startswith(v) for v in variants):
                return row
        # corner buildings carry a second address later in the text
        for lo, hi, text, row in self.by_zip.get(m["zip"], []):
            if any(squash(m["num"]) + v in text for v in variants):
                return row
        return None


# "_Rent Stabilized", "*STABILIZED RENT*", "RS apartment"
STABILIZED_TEXT = re.compile(
    r"(?i:(?<![a-z])(rent[\s-]*stabili[sz](ed|ation)|stabili[sz]ed[\s-]*rent))"
    r"|\bRS\s+(?i:apartment|apt|unit)")


def is_uneven(price):
    # Reasier's rule, recovered from their data (293/293, no errors): only
    # applied to RGB buildings, and "uneven" means not a multiple of $5.
    return price % 5 != 0


def our_reasons(listing, index):
    reasons = []
    building = index.match(listing["address"])
    if building:
        reasons.append("IN_CITY_PDFS")
    if STABILIZED_TEXT.search(listing.get("description") or ""):
        reasons.append("RENT_STABILIZED_TEXT_IN_LISTING")
    if building and is_uneven(listing["price"]):
        reasons.append("UNEVEN_PRICE")
    return reasons, building


def score(listings, index):
    stats = {r: {"tp": 0, "fp": 0, "fn": 0, "misses": [], "extras": []} for r in REASONS}
    for l in listings:
        ours, _ = our_reasons(l, index)
        theirs = set(l.get("rentStabilizedReasons") or [])
        for r in REASONS:
            s = stats[r]
            if r in ours and r in theirs:
                s["tp"] += 1
            elif r in ours:
                s["fp"] += 1
                s["extras"].append((l["price"], l["address"]))
            elif r in theirs:
                s["fn"] += 1
                s["misses"].append((l["price"], l["address"]))
    return stats


def main():
    snap = DATA / "reasier_snapshot.json"
    if "--cached" in sys.argv and snap.exists():
        listings = json.loads(snap.read_text())
    else:
        from reasier import fetch_from_page
        listings = fetch_from_page()
        snap.write_text(json.dumps(listings))
    index = BuildingIndex(json.loads((DATA / "rgb_buildings.json").read_text()))
    stats = score(listings, index)
    print(f"{len(listings)} Reasier listings\n")
    print(f"{'flag':34} {'agree':>6} {'we miss':>8} {'we add':>7} {'recall':>7} {'precision':>9}")
    for r, s in stats.items():
        rec = s["tp"] / max(1, s["tp"] + s["fn"])
        prec = s["tp"] / max(1, s["tp"] + s["fp"])
        print(f"{r:34} {s['tp']:>6} {s['fn']:>8} {s['fp']:>7} {rec:>7.0%} {prec:>9.0%}")
    if "-v" in sys.argv:
        for r, s in stats.items():
            print(f"\n{r} misses:", *s["misses"][:25], sep="\n  ")
            print(f"{r} extras:", *s["extras"][:25], sep="\n  ")


if __name__ == "__main__":
    main()

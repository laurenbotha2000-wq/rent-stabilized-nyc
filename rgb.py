"""Parse the NYC Rent Guidelines Board rent-stabilized building PDFs.

Source: rentguidelinesboard.cityofnewyork.us/resources/rent-stabilized-building-lists
(2024 HCR building registrations, one PDF per borough in data/rgb/).

  python3 rgb.py     # -> data/rgb_buildings.json
"""

import json
import re
import sys
from pathlib import Path

import pypdf

DATA = Path(__file__).parent / "data"
BOROUGHS = {"Manhattan": 1, "Bronx": 2, "Brooklyn": 3, "Queens": 4, "Staten-Island": 5}

# 10301 6 TO 14 ARLO RD STATEN ISLAND 64 MULTIPLE DWELLING A GARDEN COMPLEX 595 15
ROW = re.compile(
    r"^(?P<zip>1[01]\d{3})(?P<rest>.+?) (?P<county>6[0-4]) (?P<status>.*?)\s*"
    r"(?P<block>\d+) (?P<lot>\d+)$")
# PDF text extraction drops some spaces ("TO 1313MORRIS"), so the upper bound
# is digits only and the trailing space is optional.
HOUSE = re.compile(r"^(?P<lo>\d+(?:-\d+)?[A-Z]?)(?: ?TO ?(?P<hi>\d+(?:-\d+)?))? ?")


def parse_pdf(path, boro):
    rows = []
    for page in pypdf.PdfReader(path).pages:
        for line in page.extract_text().splitlines():
            m = ROW.match(line.strip())
            if not m:
                continue
            rest = m["rest"]
            h = HOUSE.match(rest)
            rows.append({
                "zip": m["zip"],
                "house_lo": h["lo"] if h else None,
                "house_hi": (h["hi"] or h["lo"]) if h else None,
                # address text after the first house number; still contains the
                # optional second address and the city name (matched by substring)
                "text": rest[h.end():] if h else rest,
                "status": m["status"],
                "bbl": f"{boro}{int(m['block']):05d}{int(m['lot']):04d}",
            })
    return rows


def main():
    out = []
    for name, boro in BOROUGHS.items():
        rows = parse_pdf(DATA / "rgb" / f"{name}.pdf", boro)
        print(f"{name}: {len(rows)} rows", file=sys.stderr)
        out += rows
    (DATA / "rgb_buildings.json").write_text(json.dumps(out))
    print(f"{len(out)} rows -> data/rgb_buildings.json", file=sys.stderr)


if __name__ == "__main__":
    main()

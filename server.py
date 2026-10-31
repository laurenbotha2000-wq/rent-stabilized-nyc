"""Your own rent-stabilized listings API, shaped like api.reasier.com.

  python3 server.py               # http://localhost:8787
  API_KEY=secret python3 server.py  # then require header  x-api-key: secret

Endpoints (50 per page, newest first):
  GET /api/listings                 active listings
  GET /api/listings/neighborhoods   sorted neighborhoods with active listings
  GET /api/listings/history         every listing incl. DELISTED
  GET /api/listings/history/v2      history + per-listing snapshot array ("data")
Filters: neighborhood (comma-separated), minPrice, maxPrice, beds, baths,
         reason (IN_CITY_PDFS | UNEVEN_PRICE | RENT_STABILIZED_TEXT_IN_LISTING), page
Only listings our own flags mark as stabilized are returned; all=1 includes the rest.
"""

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from db import connect

PAGE_SIZE = 50
API_KEY = os.environ.get("API_KEY")
PORT = int(os.environ.get("PORT", 8787))


def to_json(row):
    d = dict(row)
    d["reasons"] = json.loads(d["reasons"] or "[]")
    d["reasier_reasons"] = json.loads(d["reasier_reasons"] or "[]")
    d["income_restricted"] = bool(d["income_restricted"])
    return d


def query_listings(con, q, active_only):
    where, args = [], []
    if active_only:
        where.append("status='ACTIVE'")
    if q.get("all") != "1":
        where.append("json_array_length(reasons) > 0")
    if q.get("neighborhood"):
        hoods = [h.strip() for h in q["neighborhood"].split(",") if h.strip()]
        where.append(f"neighborhood IN ({','.join('?' * len(hoods))})")
        args += hoods
    for param, cond in (("minPrice", "price>=?"), ("maxPrice", "price<=?"),
                        ("beds", "beds=?"), ("baths", "baths=?")):
        if q.get(param):
            where.append(cond)
            args.append(float(q[param]))
    if q.get("reason"):
        where.append("EXISTS (SELECT 1 FROM json_each(reasons) WHERE value=?)")
        args.append(q["reason"])
    sql_where = f"WHERE {' AND '.join(where)}" if where else ""
    total = con.execute(f"SELECT COUNT(*) FROM listings {sql_where}", args).fetchone()[0]
    page = max(1, int(q.get("page", 1)))
    rows = con.execute(
        f"SELECT * FROM listings {sql_where} ORDER BY first_seen DESC, url"
        f" LIMIT {PAGE_SIZE} OFFSET {(page - 1) * PAGE_SIZE}", args).fetchall()
    pagination = {"page": page, "limit": PAGE_SIZE, "total": total,
                  "pages": -(-total // PAGE_SIZE)}
    return [to_json(r) for r in rows], pagination


class Handler(BaseHTTPRequestHandler):
    def send(self, code, body):
        data = json.dumps(body, indent=1).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if API_KEY and self.headers.get("x-api-key") != API_KEY:
            return self.send(401, {"error": "invalid or missing x-api-key"})
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        con = connect()
        try:
            if url.path == "/api/listings/neighborhoods":
                rows = con.execute("SELECT DISTINCT neighborhood FROM listings WHERE "
                                   "status='ACTIVE' AND neighborhood IS NOT NULL "
                                   "ORDER BY neighborhood").fetchall()
                return self.send(200, {"data": [r[0] for r in rows]})
            if url.path in ("/api/listings", "/api/listings/history",
                            "/api/listings/history/v2"):
                data, pag = query_listings(con, q, url.path == "/api/listings")
                if url.path.endswith("/v2"):
                    for d in data:
                        d["data"] = [dict(s) for s in con.execute(
                            "SELECT scraped_at, price, likes, time_on_market FROM snapshots "
                            "WHERE url=? ORDER BY scraped_at DESC", (d["url"],))]
                return self.send(200, {"data": data, "pagination": pag})
            self.send(404, {"error": "not found"})
        except ValueError as e:
            self.send(400, {"error": str(e)})
        finally:
            con.close()


if __name__ == "__main__":
    print(f"Listening on http://localhost:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()

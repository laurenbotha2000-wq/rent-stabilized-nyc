# Rent Stabilized NYC

Your own feed of NYC rent-stabilized listings. Listings come from Reasier's
public list page; the rent-stabilization flags are computed here from the
NYC Rent Guidelines Board building lists.

## Pieces

| Path | What |
|---|---|
| `server-rs/` | Rust service: syncs on a timer, keeps history in SQLite, serves the API and the web UI |
| `desktop/` | Tauri desktop app: runs the same service privately and shows the UI |
| `ui/` | The UI (plain HTML/CSS/JS), shared by the desktop app and the server |
| `rgb.py` | Parses the RGB building PDFs in `data/rgb/` into `data/rgb_buildings.json` (yearly) |
| `flags.py` | Scores our flags against Reasier's (`python3 flags.py -v`) |
| `reasier.py`, `db.py`, `server.py` | Original Python version (same database format) |

## Server

```bash
cargo build --release -p reasier-server
./target/release/reasier-server          # http://localhost:8787
```

| Env var | Default | |
|---|---|---|
| `PORT` | `8787` | |
| `BIND_ADDR` | `0.0.0.0` | |
| `DB_PATH` | `reasier.db` | SQLite history |
| `RGB_PATH` | `data/rgb_buildings.json` | from `rgb.py` |
| `SYNC_INTERVAL_SECS` | `3600` | minimum 300 |
| `API_KEY` | unset | if set, required as the `x-api-key` header (the web UI asks for it) |

Endpoints: `GET /api/listings`, `/api/listings/neighborhoods`,
`/api/listings/history`, `/api/listings/history/v2`, `POST /api/sync`,
`GET /healthz`, and the UI at `/`. Filters: `neighborhood` (comma-separated),
`minPrice`, `maxPrice`, `beds`, `baths`, `reason`, `url`, `all=1`, `page`.

### Deploy (Docker)

```bash
docker build -t rent-stabilized .
docker run -d --restart unless-stopped -p 8787:8787 -v rs-data:/data -e API_KEY=change-me rent-stabilized
```

Works on any host that runs a container with a persistent volume mounted at `/data`.

## Desktop app

```bash
cd desktop && cargo tauri dev      # run
cd desktop && cargo tauri build    # .app and .dmg in target/release/bundle/
```

Settings → "My deployed server" points the app at a deployed server instead
of its built-in one.

## Yearly: new RGB building list

Download the five borough PDFs into `data/rgb/` (same file names), then run
`python3 rgb.py` and rebuild.

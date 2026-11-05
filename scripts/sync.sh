#!/usr/bin/env bash
# One sync, identical on every runner: start from the published copy in
# Firestore, fetch Reasier, flag + geocode, add HPD records, publish changes.
# Each run is stateless (Firestore is the source of truth), so any number of
# runners can take turns; upload.mjs makes sure only one publishes a change.
#
#   BIN=target/release/reasier-server SYNC_RUNNER=mac scripts/sync.sh
# Credentials: FIREBASE_SERVICE_ACCOUNT, or the machine's Google identity (scripts/firebase.mjs).
set -euo pipefail
cd "$(dirname "$0")/.."
BIN=${BIN:-target/release/reasier-server}
NODE=${NODE:-node}
mkdir -p state out
"$NODE" scripts/restore.mjs out/published.json
rm -f state/work.db state/work.db-wal state/work.db-shm
DB_PATH=state/work.db "$BIN" import out/published.json
DB_PATH=state/work.db RGB_PATH=data/rgb_buildings.json "$BIN" export out
"$NODE" scripts/hpd.mjs out/data.json out/published.json
"$NODE" scripts/light.mjs out/data.json out/published.json || echo "light estimate failed (sync continues)"
"$NODE" scripts/superfund.mjs out/data.json
EVENTS_OUT=out/events.json "$NODE" scripts/upload.mjs out/data.json
# alerts are best effort: a failure here never fails the sync
"$NODE" scripts/notify.mjs out/events.json out/data.json || echo "alerts failed (sync itself succeeded)"

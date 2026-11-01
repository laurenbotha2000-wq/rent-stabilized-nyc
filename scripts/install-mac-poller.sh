#!/bin/bash
# Install (or update) the Mac poller: one sync every 2 minutes via launchd.
#
#   scripts/install-mac-poller.sh            install or update
#   scripts/install-mac-poller.sh --remove   turn it off and delete the copy
#
# macOS doesn't let background jobs read ~/Downloads, so the poller runs from
# its own copy in ~/Library/Application Support/RentStabilizedSync (same
# layout as this repo). Re-run after changing the sync code or rebuilding.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/Library/Application Support/RentStabilizedSync"
LABEL=com.lauren.rent-stabilized-sync
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
if [ "${1:-}" = "--remove" ]; then
  rm -f "$PLIST"
  rm -rf "$DEST"
  echo "Mac poller removed."
  exit 0
fi

[ -x "$REPO/target/release/reasier-server" ] || (cd "$REPO" && cargo build --release -p reasier-server)
[ -d "$REPO/scripts/node_modules" ] || npm install --prefix "$REPO/scripts" --no-audit --no-fund --silent

mkdir -p "$DEST/scripts" "$DEST/target/release" "$DEST/data"
rsync -a --delete --exclude build-web.mjs --exclude install-mac-poller.sh \
  --exclude '*.plist' "$REPO/scripts/" "$DEST/scripts/"
cp "$REPO/target/release/reasier-server" "$DEST/target/release/"
cp "$REPO/data/rgb_buildings.json" "$DEST/data/"
install -m 600 "$REPO/firebase-service-account.json" "$DEST/firebase-service-account.json"

sed "s|__POLLER__|$DEST/scripts/poll-mac.sh|; s|__HOME__|$HOME|" \
  "$REPO/scripts/$LABEL.plist" > "$PLIST"
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Mac poller installed; it syncs now and every 2 minutes."
echo "Log: ~/Library/Logs/rent-stabilized-sync.log"

#!/bin/bash
# Run one sync from this Mac (launchd calls this every 2 minutes; see
# scripts/com.lauren.rent-stabilized-sync.plist). Skips quietly if a run is
# still going. GitHub's 5-minute schedule stands down while this keeps checking.
cd "$(dirname "$0")/.." || exit 1
LOCK=/tmp/rent-stabilized-sync.lock
if ! mkdir "$LOCK" 2>/dev/null; then exit 0; fi
trap 'rmdir "$LOCK"' EXIT
LOG="$HOME/Library/Logs/rent-stabilized-sync.log"
[ -f "$LOG" ] && [ "$(stat -f%z "$LOG")" -gt 1000000 ] && mv "$LOG" "$LOG.1"
{
  echo "== $(date -u +%FT%TZ)"
  FIREBASE_SERVICE_ACCOUNT="$(cat firebase-service-account.json)" \
  NODE="$HOME/.nvm/versions/node/v24.14.1/bin/node" \
  BIN=target/release/reasier-server SYNC_RUNNER=mac \
    scripts/sync.sh 2>&1 | grep -v -i "private_key"
} >> "$LOG" 2>&1

#!/bin/bash
# Serve the site for the walkthrough the way the local preview does: the files in web/
# with a test config (no sign-in) and a fixed copy of listing data from e2e/fixtures/.
#   bash e2e/preview.sh [port]      (default 8790; Ctrl-C to stop)
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
port=${1:-8790}
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
cp -R "$root/web/." "$dir/"
cp "$root/e2e/fixtures/config.js" "$root/e2e/fixtures/dev-data.json" "$dir/"
echo '{ "type": "module" }' > "$dir/package.json"
exec python3 -m http.server "$port" --bind 127.0.0.1 --directory "$dir"

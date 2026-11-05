#!/bin/bash
# Server self-update, run every 5 minutes by rent-stabilized-sync-update.timer (set up by
# install-server-poller.sh). When main on GitHub has a newer commit AND that commit's
# "test" check passed in GitHub Actions, reinstall the sync at exactly that commit.
# Untested or failing versions are never installed.
set -euo pipefail
main() {
  local repo=laurenbotha2000-wq/rent-stabilized-nyc dir=/opt/rent-stabilized-sync
  exec 9>/run/rent-stabilized-update.lock
  flock -n 9 || exit 0
  local latest current passed tmp
  latest=$(git ls-remote "https://github.com/$repo" refs/heads/main | cut -f1)
  current=$(git -C "$dir" rev-parse HEAD 2>/dev/null || echo none)
  [ -n "$latest" ] && [ "$latest" != "$current" ] || exit 0
  passed=$(curl -fsS -H "Accept: application/vnd.github+json" \
      "https://api.github.com/repos/$repo/commits/$latest/check-runs?check_name=test" |
    node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{const r=JSON.parse(s).check_runs||[];console.log(r.some((c)=>c.conclusion==="success")?"yes":"no")})')
  if [ "$passed" != yes ]; then echo "Newer version ${latest:0:7} hasn't passed its checks yet; staying on ${current:0:7}."; exit 0; fi
  echo "Updating ${current:0:7} -> ${latest:0:7}"
  tmp=$(mktemp)
  curl -fsS "https://raw.githubusercontent.com/$repo/$latest/scripts/install-server-poller.sh" -o "$tmp"
  RSN_REF=$latest bash "$tmp"
  rm -f "$tmp"
  echo "Now running ${latest:0:7}"
}
main "$@" # (in a function so the update can replace this file safely while it runs)

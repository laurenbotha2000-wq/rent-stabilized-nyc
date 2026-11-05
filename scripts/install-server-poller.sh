#!/bin/bash
# Install (or update) the always-on sync on a Linux server (Ubuntu or Debian,
# x86_64): one sync every 60 seconds via a systemd timer.
#
#   sudo bash install-server-poller.sh            install or update
#   sudo bash install-server-poller.sh --remove   turn it off and delete it
#
# Credentials, in order of preference:
#   - Google Cloud server: none on disk. The server's attached service account
#     needs the "Cloud Datastore User" role on the rent-stabilized-nyc project.
#   - Anywhere else: put a Firebase key at /etc/rent-stabilized-sync/key.json
#     (root-only); systemd hands it to the sync, which never sees the path.
#
# The sync runs as its own locked-down user with no login, can only write its
# working folders, and listens on no ports.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
REPO_URL=https://github.com/laurenbotha2000-wq/rent-stabilized-nyc
DIR=/opt/rent-stabilized-sync
KEY=/etc/rent-stabilized-sync/key.json
UNIT=rent-stabilized-sync

if [ "${1:-}" = "--remove" ]; then
  systemctl disable --now "$UNIT.timer" 2>/dev/null || true
  rm -f "/etc/systemd/system/$UNIT.service" "/etc/systemd/system/$UNIT.timer"
  systemctl daemon-reload
  rm -rf "$DIR"
  userdel rentsync 2>/dev/null || true
  echo "Removed. (A key at $KEY, if any, was left in place.)"
  exit 0
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git nodejs npm curl ca-certificates build-essential cmake pkg-config >/dev/null
id rentsync >/dev/null 2>&1 || useradd --system --home-dir "$DIR" --shell /usr/sbin/nologin rentsync

if [ -d "$DIR/.git" ]; then git -C "$DIR" fetch -q --depth 1 origin main && git -C "$DIR" reset -q --hard origin/main
else git clone -q --depth 1 "$REPO_URL" "$DIR"; fi
npm ci --prefix "$DIR/scripts" --omit=dev --no-audit --no-fund --silent

# Build the Rust sync binary here, only when its source changed. The free
# server has 1 GB of memory, so add swap for the build and keep it lean.
stamp=$(git -C "$DIR" rev-parse HEAD:server-rs)-$(git -C "$DIR" rev-parse HEAD:Cargo.lock)
if [ ! -x "$DIR/target/release/reasier-server" ] || [ "$(cat "$DIR/target/.built" 2>/dev/null)" != "$stamp" ]; then
  if [ "$(free -m | awk '/Mem:/{print $2}')" -lt 3000 ] && ! swapon --show | grep -q .; then
    [ -f /swapfile ] || { fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap -q /swapfile; }
    swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi
  if ! command -v cargo >/dev/null && [ ! -x /root/.cargo/bin/cargo ]; then
    curl -fsSL --proto '=https' --tlsv1.2 https://sh.rustup.rs | sh -s -- -y -q --profile minimal
  fi
  echo "Building the sync binary (first time: about 15-20 minutes)..."
  (cd "$DIR" && PATH="/root/.cargo/bin:$PATH" CARGO_BUILD_JOBS=2 \
    CARGO_PROFILE_RELEASE_LTO=thin CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16 \
    cargo build -q --release --locked -p reasier-server)
  echo "$stamp" > "$DIR/target/.built"
fi

mkdir -p "$DIR/state" "$DIR/out"
chown -R root:root "$DIR"
# after the line above, so files from earlier runs stay writable by the sync on reinstall
chown -R rentsync:rentsync "$DIR/state" "$DIR/out"

cred=""
if [ -f "$KEY" ]; then
  chmod 600 "$KEY"; chown root:root "$KEY"
  cred="LoadCredential=firebase-key:$KEY
Environment=GOOGLE_APPLICATION_CREDENTIALS=%d/firebase-key"
fi

cat > "/etc/systemd/system/$UNIT.service" <<EOF
[Unit]
Description=Stoopify sync (one run)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=rentsync
WorkingDirectory=$DIR
Environment=SYNC_RUNNER=server NODE=/usr/bin/node BIN=target/release/reasier-server
$cred
ExecStart=$DIR/scripts/sync.sh
TimeoutStartSec=300
MemoryMax=400M
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=$DIR/state $DIR/out
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=
EOF

cat > "/etc/systemd/system/$UNIT.timer" <<EOF
[Unit]
Description=Stoopify sync every 60 seconds

[Timer]
OnBootSec=30
OnUnitActiveSec=60
AccuracySec=1s

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now "$UNIT.timer"
systemctl start "$UNIT.service" || true
journalctl -u "$UNIT" -n 8 --no-pager
echo
echo "Installed: syncs every 60 seconds. Watch it with: journalctl -u $UNIT -f"

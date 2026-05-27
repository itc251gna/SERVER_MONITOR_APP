param(
  [string]$Server = "10.4.51.232",
  [string]$User = "kmh251",
  [string]$KeyPath = "$HOME\.ssh\kai_archive_github",
  [string]$RemoteDir = "/home/kmh251/deployment/server_app_monitor",
  [string]$LegacyRemoteDir = "/opt/server-app-monitor",
  [string]$EnvFile = "/etc/server-app-monitor.env"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = Resolve-Path "$PSScriptRoot\.."
$Archive = Join-Path $env:TEMP "server-app-monitor.tgz"

Push-Location $Root
try {
  npm ci
  npm run build
  node --check server/index.js
  node --check server/discovery.js

  if (Test-Path $Archive) {
    Remove-Item $Archive -Force
  }

  tar -czf $Archive `
    --exclude=node_modules `
    --exclude=dist `
    --exclude=data/events.jsonl `
    --exclude=.env `
    .

  scp -i $KeyPath $Archive "${User}@${Server}:/tmp/server-app-monitor.tgz"

  $RemoteTemplate = @'
set -euo pipefail
SRC_DIR=/tmp/server-app-monitor-src
APP_DIR=__REMOTE_DIR__
LEGACY_APP_DIR=__LEGACY_REMOTE_DIR__
ENV_FILE=__ENV_FILE__
DEPLOY_USER=__DEPLOY_USER__
UNIT_FILE=/etc/systemd/system/server-app-monitor.service
KEEP_DIR=/tmp/server-app-monitor-keep
rm -rf "$SRC_DIR"
mkdir -p "$SRC_DIR"
tar -xzf /tmp/server-app-monitor.tgz -C "$SRC_DIR"
mkdir -p "$(dirname "$APP_DIR")"
mkdir -p "$APP_DIR"
rm -rf "$KEEP_DIR"
if [ -d "$APP_DIR/data" ]; then
  mkdir -p "$KEEP_DIR/data"
  cp -a "$APP_DIR/data/." "$KEEP_DIR/data/"
elif [ -d "$LEGACY_APP_DIR/data" ]; then
  mkdir -p "$KEEP_DIR/data"
  cp -a "$LEGACY_APP_DIR/data/." "$KEEP_DIR/data/"
fi
cp -a "$SRC_DIR/." "$APP_DIR/"
mkdir -p "$APP_DIR/data"
if [ -d "$KEEP_DIR/data" ]; then
  cp -a "$KEEP_DIR/data/." "$APP_DIR/data/"
fi
chown -R "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR"
find "$APP_DIR" -type d -exec chmod 775 {} +
find "$APP_DIR" -type f -exec chmod 664 {} +
if [ -f "$UNIT_FILE" ]; then
  cat > "$UNIT_FILE" <<UNIT
[Unit]
Description=Server App Monitor
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node $APP_DIR/server/index.js
Restart=always
RestartSec=5
User=root
Group=root

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
fi
cd "$APP_DIR"
npm ci
npm run build
systemctl restart server-app-monitor.service
systemctl is-active server-app-monitor.service
for attempt in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:4180/api/health; then
    exit 0
  fi
  sleep 1
done
systemctl status server-app-monitor.service --no-pager -l
exit 1
'@

  $RemoteScript = $RemoteTemplate.Replace("__REMOTE_DIR__", $RemoteDir).Replace("__LEGACY_REMOTE_DIR__", $LegacyRemoteDir).Replace("__ENV_FILE__", $EnvFile).Replace("__DEPLOY_USER__", $User)

  $Escaped = $RemoteScript -replace "'", "'\''"
  ssh -tt -i $KeyPath "${User}@${Server}" "sudo -S -p '' bash -lc '$Escaped'"
}
finally {
  Pop-Location
}

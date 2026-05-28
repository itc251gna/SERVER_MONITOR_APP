param(
  [string]$Server = "10.4.51.232",
  [string]$User = "kmh251",
  [string]$KeyPath = "",
  [string]$RemoteDir = "/home/kmh251/deployment/server_app_monitor",
  [string]$LegacyRemoteDir = "/opt/server-app-monitor",
  [string]$EnvFile = "/etc/server-app-monitor.env",
  [string]$RequiredBranch = "main",
  [switch]$SkipGitGuard,
  [switch]$SkipRemoteCheck,
  [switch]$ValidateOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = Resolve-Path "$PSScriptRoot\.."
$Archive = Join-Path $env:TEMP "server-app-monitor.tgz"

function Invoke-GitGuard {
  param(
    [string]$BranchName,
    [switch]$NoRemoteCheck
  )

  $insideWorkTree = (git rev-parse --is-inside-work-tree 2>$null).Trim()
  if ($insideWorkTree -ne "true") {
    throw "Production deploy must run from a Git worktree."
  }

  $currentBranch = (git branch --show-current).Trim()
  if (-not $currentBranch) {
    throw "Production deploy is blocked because HEAD is detached. Check out '$BranchName' first."
  }

  if ($BranchName -and $currentBranch -ne $BranchName) {
    throw "Production deploy is blocked from branch '$currentBranch'. Switch to '$BranchName' or pass -RequiredBranch explicitly."
  }

  $changes = @(git status --porcelain=v1 --untracked-files=all)
  if ($changes.Count -gt 0) {
    $changeList = ($changes | ForEach-Object { "  $_" }) -join [Environment]::NewLine
    throw "Production deploy is blocked because the worktree is not clean. Commit/stash/remove these changes first:$([Environment]::NewLine)$changeList"
  }

  $headCommit = (git rev-parse HEAD).Trim()

  if (-not $NoRemoteCheck) {
    git fetch --prune origin $BranchName
    $remoteCommit = (git rev-parse "origin/$BranchName").Trim()
    if ($headCommit -ne $remoteCommit) {
      throw "Production deploy is blocked because local HEAD ($headCommit) does not match origin/$BranchName ($remoteCommit). Push or pull first."
    }
  }

  Write-Host "Git guard passed: branch=$currentBranch commit=$headCommit"
  return $headCommit
}

if (-not $KeyPath) {
  $KeyCandidates = @(
    "$HOME\.ssh\kai_archive_github",
    "$HOME\.ssh\archived_old_ssh_keys_20260527_210751\kai_archive_github",
    "$HOME\.ssh\archived_old_ssh_keys_20260527_210751\server_app_monitor_github_deploy"
  )
  $KeyPath = $KeyCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $KeyPath) {
    throw "No SSH key found. Pass -KeyPath explicitly."
  }
}

Push-Location $Root
try {
  $DeployCommit = ""
  if (-not $SkipGitGuard) {
    $DeployCommit = Invoke-GitGuard -BranchName $RequiredBranch -NoRemoteCheck:$SkipRemoteCheck
  } else {
    Write-Warning "Git guard skipped. This can deploy uncommitted or non-main code."
  }

  npm ci
  npm run build
  node --check server/index.js
  node --check server/discovery.js

  if ($ValidateOnly) {
    Write-Host "ValidateOnly passed. No production files were uploaded."
    if ($DeployCommit) {
      Write-Host "Validated deploy commit: $DeployCommit"
    }
    return
  }

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

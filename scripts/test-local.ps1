Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Push-Location (Resolve-Path "$PSScriptRoot\..")
try {
  npm ci
  npm run local:check
  Write-Host "Local checks passed."
}
finally {
  Pop-Location
}

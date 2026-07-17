# Build the ZIP for Chrome Web Store upload.
# Only runtime files are included; manifest.json must sit at the ZIP root.
# Usage: powershell -ExecutionPolicy Bypass -File package.ps1
# NOTE: keep this script ASCII-only - Windows PowerShell 5.1 misreads
# BOM-less UTF-8 scripts and non-ASCII comments corrupt neighboring lines.

$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
# -Encoding UTF8: manifest.json is BOM-less UTF-8, which PS 5.1 misdetects by default
$manifest = Get-Content (Join-Path $root 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$zipName = "dual-subtitles-for-netflix-v$($manifest.version).zip"
$zipPath = Join-Path $root $zipName

$include = @(
  'manifest.json',
  'background',
  'content',
  'popup',
  'icons'
)

if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

$paths = $include | ForEach-Object { Join-Path $root $_ }
Compress-Archive -Path $paths -DestinationPath $zipPath

Write-Host "Created $zipName"

# Register boxd-vps MCP with Antigravity (agy) and enable in Cursor agent CLI.
$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
$McpScript = Join-Path $Root "src\mcp\server.js"
$EnvFile = Join-Path $Root ".env"

if (-not (Test-Path $McpScript)) {
  Write-Error "MCP server not found: $McpScript"
}

function Read-DotEnvLines($file) {
  if (-not (Test-Path $file)) { return @() }
  Get-Content $file | Where-Object {
    $_ -and $_ -notmatch '^\s*#' -and $_ -match '='
  }
}

Write-Host "=== Boxd VPS CLI setup (agy + Cursor agent) ===" -ForegroundColor Cyan

# --- Antigravity agy ---
if (Get-Command agy -ErrorAction SilentlyContinue) {
  $agyArgs = @("mcp", "add")
  foreach ($line in (Read-DotEnvLines $EnvFile)) {
    $pair = $line -split '=', 2
    $key = $pair[0].Trim()
    $val = $pair[1].Trim()
    if ($key -match '^(BOXD_|ARTBLOOM_)') {
      $agyArgs += "-e"
      $agyArgs += "${key}=${val}"
    }
  }
  $agyArgs += "boxd-vps"
  $agyArgs += "node"
  $agyArgs += $McpScript
  Write-Host "Registering agy MCP: boxd-vps ..."
  & agy @agyArgs
  & agy mcp enable boxd-vps
  Write-Host "agy MCP servers:"
  & agy mcp list
} else {
  Write-Warning "agy not in PATH - install Antigravity CLI or skip."
}

# --- Cursor agent CLI ---
$Agent = Join-Path $env:LOCALAPPDATA "cursor-agent\agent.cmd"
if (Test-Path $Agent) {
  Set-Location $Root
  Write-Host "Enabling Cursor agent MCP: boxd-vps ..."
  & $Agent mcp enable boxd-vps 2>&1
  Write-Host "Cursor agent MCP servers:"
  & $Agent mcp list 2>&1
} else {
  Write-Warning "Cursor agent CLI not found at $Agent"
}

Write-Host ""
Write-Host "Done. Try: npm run vm-agent -- 'your task'" -ForegroundColor Green
Write-Host "Or:     npm run agy-vm -- 'your task'"

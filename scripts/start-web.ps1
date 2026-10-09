# Kill stuck server on 3000 and start a fresh dashboard.
$Root = Split-Path $PSScriptRoot -Parent
Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1
Set-Location $Root
Write-Host "Starting http://localhost:3000 ..."
Start-Process -FilePath "node" -ArgumentList "src/server.js" -WorkingDirectory $Root -WindowStyle Normal

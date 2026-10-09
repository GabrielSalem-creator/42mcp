param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$PromptParts
)

$ProjectRoot = Split-Path $PSScriptRoot -Parent
$UserPrompt = ($PromptParts -join ' ').Trim()
if (-not $UserPrompt) {
  $UserPrompt = Read-Host "What should the VM do?"
}

$FullPrompt = @"
Use MCP server boxd-vps. Call vm_do with this user request verbatim, then summarize VM results.

User request: $UserPrompt
"@

Set-Location $ProjectRoot

if (-not (Get-Command agy -ErrorAction SilentlyContinue)) {
  Write-Error "agy CLI not found. Install Antigravity CLI."
}

agy -p $FullPrompt --dangerously-skip-permissions --add-dir $ProjectRoot

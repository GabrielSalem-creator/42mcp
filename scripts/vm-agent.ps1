# Run Cursor Agent CLI against this project; it uses MCP boxd-vps to control the cloud VM.
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$PromptParts
)

$ProjectRoot = Split-Path $PSScriptRoot -Parent
$Agent = Join-Path $env:LOCALAPPDATA "cursor-agent\agent.cmd"

if (-not (Test-Path $Agent)) {
  Write-Error "Cursor agent CLI not found at $Agent. Install/update Cursor."
  exit 1
}

$UserPrompt = ($PromptParts -join ' ').Trim()
if (-not $UserPrompt) {
  $UserPrompt = Read-Host "What should the VM do?"
}

$FullPrompt = @"
You control the Boxd cloud Linux VM browser through MCP server boxd-vps.
For this user request, call the vm_do tool with their exact words (do not reply with a menu).
Then summarize what ran on the VM and what was collected.

User request: $UserPrompt
"@

Set-Location $ProjectRoot
& $Agent --workspace $ProjectRoot --approve-mcps --trust --force -p $FullPrompt

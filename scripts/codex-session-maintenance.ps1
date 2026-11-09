[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'

# The legacy guard relocated raw sessions and swallowed failures. Its own
# incident analysis identifies oversized display fields as the startup cause.
# Keep every raw session in place; maintain the derived index only when idle.
$active = @(Get-Process -ErrorAction Stop | Where-Object { $_.ProcessName -match '^(Codex|ChatGPT|codex.*)$' })
if ($active.Count -gt 0) {
    [pscustomobject]@{ ok = $true; status = 'deferred-active-session'; processes = $active.Count } | ConvertTo-Json
    exit 0
}
$runner = Join-Path $PSScriptRoot 'codex-state-clamp.js'
& node --no-warnings $runner
exit $LASTEXITCODE

param(
  [string]$RepoRoot = '',
  [string]$TaskName = 'SecondBrain-CodexThreadIndexSync',
  [int]$EveryMinutes = 2
)

$ErrorActionPreference = 'Stop'

function Resolve-SecondBrainRepoRoot {
  param([string]$RequestedRoot)

  if ($RequestedRoot) {
    return (Resolve-Path $RequestedRoot).Path
  }

  $stableRoot = Join-Path $env:USERPROFILE 'secondbrain'
  $stableExporter = Join-Path $stableRoot 'scripts\export-codex-thread-index.js'
  if (Test-Path $stableExporter) {
    return (Resolve-Path $stableRoot).Path
  }

  return (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}

$RepoRoot = Resolve-SecondBrainRepoRoot -RequestedRoot $RepoRoot

$node = (Get-Command node -ErrorAction Stop).Source
$logDir = Join-Path $env:APPDATA 'secondbrain\data\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logPath = Join-Path $logDir 'codex-thread-index-sync.log'
$agentDir = Join-Path $env:APPDATA 'secondbrain\data\agent'
New-Item -ItemType Directory -Force -Path $agentDir | Out-Null

$script = Join-Path $RepoRoot 'scripts\export-codex-thread-index.js'
if (-not (Test-Path $script)) {
  throw "Missing exporter: $script"
}
$installScript = Join-Path $agentDir 'export-codex-thread-index.js'
Copy-Item -Force -Path $script -Destination $installScript

$quotedRunDir = $agentDir.Replace("'", "''")
$quotedNode = $node.Replace("'", "''")
$quotedScript = $installScript.Replace("'", "''")
$quotedLog = $logPath.Replace("'", "''")
$command = "Set-Location '$quotedRunDir'; & '$quotedNode' '$quotedScript' --sync-ec2 *> '$quotedLog'"

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"$command`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
try {
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 1)
} catch {
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Output "Registered $TaskName every $EveryMinutes minutes. Log: $logPath"

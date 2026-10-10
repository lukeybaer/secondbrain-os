param(
  [string]$RepoRoot = '',
  [string]$TaskName = 'SecondBrain-VoiceGitPeopleSync',
  [string]$DailyAt = '12:00PM'
)

$ErrorActionPreference = 'Stop'
$requiredTimeZone = 'Central Standard Time'
if ((Get-TimeZone).Id -ne $requiredTimeZone) {
  throw "This noon People-file batch must be registered on an America/Chicago host ($requiredTimeZone)."
}

function Resolve-SecondBrainRepoRoot {
  param([string]$RequestedRoot)

  if ($RequestedRoot) {
    return (Resolve-Path $RequestedRoot).Path
  }

  $stableRoot = Join-Path $env:USERPROFILE 'sb-runtime\amy-code'
  $stableRelay = Join-Path $stableRoot 'scripts\voice-git-people-sync.js'
  if (Test-Path $stableRelay) {
    return (Resolve-Path $stableRoot).Path
  }

  return (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}

$RepoRoot = Resolve-SecondBrainRepoRoot -RequestedRoot $RepoRoot
$launcher = Join-Path $RepoRoot 'scripts\silent-node-launcher.vbs'
$relay = Join-Path $RepoRoot 'scripts\voice-git-people-sync.bat'
$script = Join-Path $RepoRoot 'scripts\voice-git-people-sync.js'

foreach ($required in @($launcher, $relay, $script)) {
  if (-not (Test-Path $required)) {
    throw "Missing voice People relay dependency: $required"
  }
}

$action = New-ScheduledTaskAction `
  -Execute 'wscript.exe' `
  -Argument "`"$launcher`" `"$relay`"" `
  -WorkingDirectory $RepoRoot
$trigger = New-ScheduledTaskTrigger `
  -Daily `
  -At $DailyAt
try {
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 45)
} catch {
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable
}

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Force | Out-Null

Write-Output "Registered $TaskName daily at $DailyAt America/Chicago from $RepoRoot."

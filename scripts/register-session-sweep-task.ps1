# register-session-sweep-task.ps1
#
# Registers a Windows Scheduled Task that runs scripts/session-sweep.mjs every
# 10 minutes, so raw session transcripts are archived to S3 continuously (Layer
# 0) and checkpointed into Graphiti (Layer 1) regardless of whether the Electron
# app is open. Running outside the app is deliberate: a crashed or always-on
# session must still be swept, and the transcripts + spine both live in the user
# profile, so the task runs as the logged-in user.
#
# Idempotent: re-running replaces the task definition. Verify with:
#   Get-ScheduledTask -TaskName 'SecondBrain Session Sweep'
# Run on demand with:
#   Start-ScheduledTask -TaskName 'SecondBrain Session Sweep'

$ErrorActionPreference = 'Stop'

$TaskName = 'SecondBrain Session Sweep'
$Repo = Split-Path -Parent $PSScriptRoot
$Script = Join-Path $Repo 'scripts\session-sweep.mjs'
$Launcher = Join-Path $Repo 'scripts\silent-node-launcher.vbs'

if (-not (Test-Path $Script)) { throw "sweep script not found: $Script" }
if (-not (Test-Path $Launcher)) { throw "silent launcher not found: $Launcher" }

# MUST route through wscript.exe + silent-node-launcher.vbs (window style 0).
# This task runs every 10 minutes under an Interactive principal, so executing
# node.exe directly would pop a console window in front of ExampleCo on every firing.
# See feedback_scheduled_tasks_must_use_silent_launcher.md (2026-06-15 regression
# where this exact task popped a node.exe window every 10 minutes).
$action = New-ScheduledTaskAction -Execute 'wscript.exe' `
  -Argument "`"$Launcher`" `"$Script`"" -WorkingDirectory $Repo

# Every 10 minutes, effectively indefinitely (10 years; [TimeSpan]::MaxValue
# overflows the Task Scheduler XML duration field).
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes 10) `
  -RepetitionDuration (New-TimeSpan -Days 3650)

# Run as the current user, only when logged on (transcripts live in the profile).
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 8) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Force | Out-Null

Write-Output "Registered '$TaskName' -> wscript.exe `"$Launcher`" `"$Script`" every 10 minutes (silent)."

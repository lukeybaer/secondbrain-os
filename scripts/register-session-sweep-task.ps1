# register-session-sweep-task.ps1
#
# Registers TWO Windows Scheduled Tasks:
#
#   1. 'SecondBrain Session Sweep'         every 10 min  -- uploads transcripts
#   2. 'SecondBrain Session Archive Audit' daily 03:10   -- PROVES they landed
#
# Both are registered here, deliberately, because an uploader without a verifier
# is how 300 sessions went unproven until 2026-07-18. The sweep reports success
# from its own bookkeeping; only the audit compares the local inventory against
# actual S3 objects and publishes a receipt that another machine can check. If
# you ever split these apart, you have recreated the original blind spot.
# See memory/feedback_health_checks_must_verify_against_external_evidence.md.
#
# The audit runs at 03:10 local: after the 2:45/3:00 pre-briefing health
# self-heal, and before the 5:30 briefing, so the session-coverage card reads a
# receipt generated a couple of hours earlier rather than a day-old one.
#
# Idempotent: re-running replaces both task definitions. Verify with:
#   Get-ScheduledTask -TaskName 'SecondBrain Session Sweep'
#   Get-ScheduledTask -TaskName 'SecondBrain Session Archive Audit'
# Run on demand with:
#   Start-ScheduledTask -TaskName 'SecondBrain Session Sweep'
#
# Host identity: the audit publishes to audits/<host>/latest.json and the
# coverage health check holds every registered host accountable by that exact
# name. Pass -AuditHost to pin it (the old PC must use 'oldpc' to match the
# registry entry); it defaults to this machine's hostname, lowercased.

param(
  [string]$AuditHost = $env:COMPUTERNAME.ToLower()
)

$ErrorActionPreference = 'Stop'

$TaskName = 'SecondBrain Session Sweep'
$AuditTaskName = 'SecondBrain Session Archive Audit'
$Repo = Split-Path -Parent $PSScriptRoot
$Script = Join-Path $Repo 'scripts\session-sweep.mjs'
$AuditScript = Join-Path $Repo 'scripts\session-archive-audit.mjs'
$Launcher = Join-Path $Repo 'scripts\silent-node-launcher.vbs'

if (-not (Test-Path $Script)) { throw "sweep script not found: $Script" }
if (-not (Test-Path $AuditScript)) { throw "audit script not found: $AuditScript" }
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

# --- 2. The verifier -------------------------------------------------------
# --repair is deliberate: a shortfall this finds is almost always a session the
# sweep never selected, and re-uploading the whole file is both the fix and the
# proof. Anything it cannot repair stays unresolved and turns the coverage card
# red rather than being silently dropped.
$auditAction = New-ScheduledTaskAction -Execute 'wscript.exe' `
  -Argument "`"$Launcher`" `"$AuditScript`" --limit 300 --repair --host $AuditHost" -WorkingDirectory $Repo

$auditTrigger = New-ScheduledTaskTrigger -Daily -At '03:10'

# Longer limit than the sweep: a first run with a real backlog uploads hundreds
# of multi-MB transcripts, and being killed midway would leave the receipt
# unwritten and the card red for a reason that is not the real problem.
$auditSettings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $AuditTaskName -Action $auditAction -Trigger $auditTrigger `
  -Principal $principal -Settings $auditSettings -Force | Out-Null

Write-Output "Registered '$AuditTaskName' -> daily 03:10, --limit 300 --repair --host $AuditHost (silent)."
Write-Output "Verify coverage across machines with: node scripts/session-coverage-health.mjs"

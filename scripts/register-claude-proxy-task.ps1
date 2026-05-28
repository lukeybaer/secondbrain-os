# register-claude-proxy-task.ps1
#
# Registers the claude-proxy-watchdog as a Windows Scheduled Task that runs
# at user logon and survives reboots. Most durable, zero-maintenance setup
# without installing NSSM.
#
# Run once:
#   PowerShell -ExecutionPolicy Bypass -File scripts/register-claude-proxy-task.ps1
#
# Re-runs are idempotent (Unregister-ScheduledTask first, then re-register).

$ErrorActionPreference = 'Stop'
$taskName = 'ClaudeMaxProxyWatchdog'
$ps1      = (Join-Path $env:USERPROFILE 'secondbrain\scripts\claude-proxy-watchdog.ps1')

if (-not (Test-Path $ps1)) {
    Write-Error "Watchdog script missing: $ps1"
    exit 1
}

# Tear down old task if present (idempotent re-registration).
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Removing existing task: $taskName"
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

$action = New-ScheduledTaskAction -Execute 'PowerShell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ps1`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 0) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Claude Max plan proxy + SSH reverse tunnel to EC2. Self-restarting watchdog.'

Write-Host "Registered scheduled task: $taskName"
Write-Host "Starting it now..."
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 5
$task = Get-ScheduledTask -TaskName $taskName
Write-Host "Task status: $($task.State)"
Write-Host "Logs at: $env:APPDATA\secondbrain\data\claude-proxy-watchdog.log"

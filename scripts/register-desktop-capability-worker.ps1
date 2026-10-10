param(
    [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$TaskName = 'SecondBrain-DesktopCapabilityWorker'
)

$ErrorActionPreference = 'Stop'
$launcher = Join-Path $RepoRoot 'scripts\silent-node-launcher.vbs'
$worker = Join-Path $RepoRoot 'scripts\desktop-capability-worker.js'
if (!(Test-Path $launcher) -or !(Test-Path $worker)) { throw 'Desktop capability worker files are missing.' }
# Fail before touching the resident worker if its replacement is incomplete or
# its installed manifest no longer matches the shipped source bytes.
& node -e 'const path=require("path");const root=process.argv[1];require(path.join(root,"scripts/lib/runtime-source-sha.js")).sourceSha(root);require(path.join(root,"scripts/desktop-capability-worker.js"));require(path.join(root,"scripts/desktop-snapshot-maintenance.js"));' $RepoRoot
if ($LASTEXITCODE -ne 0) { throw 'Desktop capability runtime provenance or dependency preflight failed.' }

# Registration with MultipleInstances=IgnoreNew does not replace a resident
# worker. Stop the owned task and any same-path orphan before replacing files or
# starting the new runtime, otherwise the old Node process keeps stale modules
# in memory and silently ignores newly registered capabilities.
$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existingTask -and $existingTask.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $stopDeadline = (Get-Date).AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 250
        $existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    } while ($existingTask -and $existingTask.State -eq 'Running' -and (Get-Date) -lt $stopDeadline)
    if ($existingTask -and $existingTask.State -eq 'Running') {
        throw 'Existing desktop capability worker did not stop within 15 seconds.'
    }
}

$workerPath = [IO.Path]::GetFullPath($worker)
$staleWorkers = Get-CimInstance Win32_Process | Where-Object {
    $_.ProcessId -ne $PID -and
    $_.CommandLine -and
    $_.CommandLine.IndexOf($workerPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
}
foreach ($staleWorker in $staleWorkers) {
    try {
        Stop-Process -Id $staleWorker.ProcessId -Force -ErrorAction Stop
    } catch {
        if (Get-Process -Id $staleWorker.ProcessId -ErrorAction SilentlyContinue) {
            throw "Failed to stop stale desktop capability worker process $($staleWorker.ProcessId)."
        }
    }
}
if ($staleWorkers) { Start-Sleep -Milliseconds 250 }
$survivingWorkers = Get-CimInstance Win32_Process | Where-Object {
    $_.ProcessId -ne $PID -and
    $_.CommandLine -and
    $_.CommandLine.IndexOf($workerPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
}
if ($survivingWorkers) {
    throw "Refusing to start with stale desktop capability worker process(es): $($survivingWorkers.ProcessId -join ', ')."
}

$action = New-ScheduledTaskAction -Execute 'wscript.exe' `
    -Argument "`"$launcher`" `"$worker`"" `
    -WorkingDirectory $RepoRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 0) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Principal $principal -Force -Description 'Signed allowlisted desktop capability relay for Amy owner sessions.' | Out-Null
Start-ScheduledTask -TaskName $TaskName
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State

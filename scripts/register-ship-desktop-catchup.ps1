$ErrorActionPreference = 'Stop'
$name = 'SecondBrain-ShipAutoDeploy'
$runtime = Join-Path $env:USERPROFILE 'sb-runtime\amy-code\scripts'
$launcher = Join-Path $runtime 'silent-node-launcher.vbs'
$job = Join-Path $runtime 'ship-auto-deploy.bat'
if (!(Test-Path -LiteralPath $job) -or !(Test-Path -LiteralPath $launcher)) { throw 'Desktop release launcher is missing' }
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"{0}" "{1}"' -f $launcher, $job)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -RestartInterval (New-TimeSpan -Minutes 10) -RestartCount 2
$trigger = New-ScheduledTaskTrigger -Daily -At '05:35'
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -Description 'Catch up the local desktop release when Windows is available. EC2 owns promotion.' -Force | Out-Null
$task = Get-ScheduledTask -TaskName $name
if (!$task.Settings.StartWhenAvailable -or $task.Settings.WakeToRun -or !$task.Actions.Arguments.Contains($job)) { throw 'Desktop catch-up settings did not persist' }
Write-Host "Registered $name for desktop-only catch-up"

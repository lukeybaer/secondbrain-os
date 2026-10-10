# register-scheduled-tasks.ps1
# Registers all missing Amy/SecondBrain scheduled tasks via schtasks.exe.
# Safe to re-run , uses /F (force overwrite).

$root = if ($env:SECONDBRAIN_ROOT) { $env:SECONDBRAIN_ROOT } else { Join-Path $env:USERPROFILE 'secondbrain' }
$runner = "$root\scripts\run-scheduled-skill.js"
$launcher = "$root\scripts\silent-node-launcher.vbs"
$user = $env:USERNAME

# ── Overnight lane settings (2026-08-03, unattended night 1 evidence) ─────────
# Night 1 ran fully unattended for the first time. The 22:45 launch escalated
# all 6 sessions and closed state=exhausted at 02:38 with exit code 1. The board
# was only saved because the task ran AGAIN at 02:53 and that run closed
# state=finished-early at 05:07. That retry was accidental: schtasks /create
# leaves the task on its defaults, which for this lane are all wrong.
#
# Measured defaults on the live 22:45 task before this change:
#   RestartCount 0, RestartInterval <none>  -> a failed night is never retried
#   ExecutionTimeLimit PT72H                -> a wedged watcher can run 3 days
#   WakeToRun False                         -> a sleeping PC misses the night
#   StartWhenAvailable False                -> a missed trigger is simply lost
# MultipleInstances was already IgnoreNew, but only implicitly; it is declared
# here so a future schtasks default change cannot let two watchers race.
#
# schtasks /create cannot express WakeToRun, StartWhenAvailable, restart policy,
# or a custom execution limit, so the lane follows the same convention as
# desktop tasks that genuinely need those settings: create with schtasks (which
# keeps the wscript.exe silent-launcher action contract), then apply the richer
# settings through the ScheduledTasks cmdlets.
$OvernightRestartIntervalMinutes = 15
$OvernightRestartCount = 1
# The launcher itself owns the real deadline: it runs from 22:45 CT to the 05:35
# CT supervision cutoff (6h50m), and a DST fall-back night adds one more real
# hour (7h50m). This limit is the BACKSTOP against a wedged process, set just
# above the longest legitimate night instead of the 72-hour schtasks default.
$OvernightExecutionTimeLimitHours = 8
# Non-zero at the end of this script means at least one overnight lane is still
# on unsafe defaults, and the script exits nonzero so the activating coordinator
# cannot mistake a printed error for a successful registration pass.
$script:OvernightLaneFailures = 0

function Set-OvernightLaneSettings {
    param([string]$Name)
    try {
        $settings = New-ScheduledTaskSettingsSet `
            -WakeToRun `
            -StartWhenAvailable `
            -MultipleInstances IgnoreNew `
            -ExecutionTimeLimit (New-TimeSpan -Hours $OvernightExecutionTimeLimitHours) `
            -RestartInterval (New-TimeSpan -Minutes $OvernightRestartIntervalMinutes) `
            -RestartCount $OvernightRestartCount
        Set-ScheduledTask -TaskName $Name -Settings $settings -ErrorAction Stop | Out-Null
        # READ BACK. A cmdlet that returned without throwing is not proof that
        # the policy persisted, and an unverified overnight lane is exactly the
        # state that made night 1 depend on an accidental retry.
        $live = (Get-ScheduledTask -TaskName $Name -ErrorAction Stop).Settings
        $problems = @()
        if (-not $live.WakeToRun) { $problems += 'WakeToRun not set' }
        if (-not $live.StartWhenAvailable) { $problems += 'StartWhenAvailable not set' }
        if ($live.MultipleInstances -ne 'IgnoreNew') { $problems += "MultipleInstances=$($live.MultipleInstances)" }
        $liveLimit = [System.Xml.XmlConvert]::ToTimeSpan($live.ExecutionTimeLimit)
        if ($liveLimit.TotalHours -ne $OvernightExecutionTimeLimitHours) { $problems += "ExecutionTimeLimit=$($live.ExecutionTimeLimit)" }
        $liveRestart = [System.Xml.XmlConvert]::ToTimeSpan($live.RestartInterval)
        if ($liveRestart.TotalMinutes -ne $OvernightRestartIntervalMinutes) { $problems += "RestartInterval=$($live.RestartInterval)" }
        if ([int]$live.RestartCount -ne $OvernightRestartCount) { $problems += "RestartCount=$($live.RestartCount)" }
        if ($problems.Count -gt 0) { throw ("settings did not persist: " + ($problems -join '; ')) }
        Write-Host ("OK  $Name  overnight lane VERIFIED (WakeToRun, StartWhenAvailable, IgnoreNew, " +
            "$OvernightExecutionTimeLimitHours" + "h limit, restart every " +
            "$OvernightRestartIntervalMinutes" + "m x $OvernightRestartCount)")
    } catch {
        $script:OvernightLaneFailures++
        Write-Host "ERR $Name overnight lane settings: $_"
    }
}

function Skill-Task {
    param(
        [string]$Name,
        [string]$SkillName,
        [string]$Time,        # HH:MM (24h, local time)
        [string]$Schedule = 'DAILY',
        [string]$Day = '',    # MON, FRI, etc. for WEEKLY
        [string]$RootOverride = ''
    )
    $taskRoot = if ($RootOverride) { $RootOverride } else { $root }
    $taskLauncher = Join-Path $taskRoot 'scripts\silent-node-launcher.vbs'
    $taskRunner = Join-Path $taskRoot 'scripts\run-scheduled-skill.js'
    $taskRun = "wscript.exe `"$taskLauncher`" `"$taskRunner`" `"$SkillName`""
    if ($Day) {
        $result = schtasks /create /tn $Name /tr $taskRun /sc WEEKLY /d $Day /st $Time /f 2>&1
    } else {
        $result = schtasks /create /tn $Name /tr $taskRun /sc DAILY /st $Time /f 2>&1
    }
    if ($LASTEXITCODE -eq 0) {
        Write-Host "OK  $Name  ($Time)"
    } else {
        Write-Host "ERR $Name`: $result"
    }
}

function Bat-Task {
    param(
        [string]$Name,
        [string]$BatPath,
        [string]$Time,
        [string]$Schedule = 'DAILY',
        [string]$Day = '',
        [string]$RootOverride = '',
        # OvernightLane applies the unattended-night settings above after the
        # task is created. Opt-in, because a 15-minute bounded restart and an
        # 8-hour execution limit are correct for the overnight watcher lane and
        # wrong for a 60-second every-minute worker.
        [switch]$OvernightLane
    )
    # RootOverride points the task at a different checkout (e.g. the runtime
    # release path sb-runtime\amy-code) so scheduled work never depends on the
    # shared dev checkout being clean or current. A relative BatPath resolves
    # against the override root; the launcher vbs comes from the same root.
    $taskLauncher = if ($RootOverride) { Join-Path $RootOverride 'scripts\silent-node-launcher.vbs' } else { $launcher }
    $taskBat = if ($RootOverride -and -not [System.IO.Path]::IsPathRooted($BatPath)) { Join-Path $RootOverride $BatPath } else { $BatPath }
    if ($Day) {
        $taskRun = "wscript.exe `"$taskLauncher`" `"$taskBat`""
        $result = schtasks /create /tn $Name /tr $taskRun /sc WEEKLY /d $Day /st $Time /f 2>&1
    } else {
        $taskRun = "wscript.exe `"$taskLauncher`" `"$taskBat`""
        $result = schtasks /create /tn $Name /tr $taskRun /sc DAILY /st $Time /f 2>&1
    }
    if ($LASTEXITCODE -eq 0) {
        Write-Host "OK  $Name  ($Time)"
        # schtasks /create resets the task to defaults every time it runs, so the
        # lane settings must be re-applied on every registration pass, not once.
        if ($OvernightLane) { Set-OvernightLaneSettings -Name $Name }
    } else {
        Write-Host "ERR $Name`: $result"
    }
}

function Bat-Minute-Task {
    param(
        [string]$Name,
        [string]$BatPath,
        [int]$Minutes = 1
    )
    $taskRun = "wscript.exe `"$launcher`" `"$BatPath`""
    $result = schtasks /create /tn $Name /tr $taskRun /sc MINUTE /mo $Minutes /f 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "OK  $Name  (every $Minutes minute(s))"
    } else {
        Write-Host "ERR $Name`: $result"
    }
}

# A persistent watcher that should always be running: launched hidden at logon
# via the silent launcher. health-self-heal's healGmailAmyScan restarts it within
# the day if it dies, so this only needs to seed it at logon. Idempotent (/f).
function Watch-Task {
    param(
        [string]$Name,
        [string]$Script,   # repo-relative js path, e.g. scripts\gmail-amy-scan.js
        [string]$ExtraArg = '--watch'
    )
    $taskRun = "wscript.exe `"$launcher`" `"$Script`" $ExtraArg"
    $result = schtasks /create /tn $Name /tr $taskRun /sc ONLOGON /f 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "OK  $Name  (at logon, persistent watcher)"
    } else {
        Write-Host "ERR $Name`: $result"
    }
}

# ── Retired desktop owners ────────────────────────────────────────────────────
# This installer never creates or disables a broad duplicate owner. The exact
# cloud/night-owner replacement receipt is checked by desktop-task-consolidation
# before it snapshots XML and disables the task. Candidate identities and their
# exact replacement contracts live only in config/desktop-task-consolidation-plan.json.

# ── Midnight CT parallel fan-out ──────────────────────────────────────────────
# All of these are independent of each other. Windows Task Scheduler runs each
# as its own process, so identical start times = true parallel execution. They
# must all finish before the 04:35 daily build / 05:30 briefing reads their
# output. These PC mirror tasks are Disabled; the cloud-scheduled-fleet cron on
# EC2 is the production owner (scripts/lib/cloud-scheduled-fleet.js).
#
# SecondBrain-NightlyEnhancement is RETIRED (see the daytime fan-out below) and
# no longer runs in this midnight fan-out.
Skill-Task 'SecondBrain-BirthdayCheck'        'daily-birthday-check'              '00:00'  # concurrent
Skill-Task 'SecondBrain-GmailScan'            'daily-gmail-scan'                  '00:00'  # concurrent
# SecondBrain-OtterSweep DEREGISTERED 2026-09-14: the daily-otter-sweep
# scheduled skill was deleted (ExampleCo decision). It burned ~4M Claude tokens
# failing outright because it looked for PC paths while running on EC2;
# continuous Otter ingest is unaffected (Tier 1 MEMORY.md every-2-minute pull).
# SecondBrain-LinkedInScan DEREGISTERED 2026-09-27 (cloud-first, ExampleCo: "you
# shouldn't be doing linkedin stuff from pc"). daily-linkedin-scan runs in the
# EC2 cloud fleet; the PC only hosts the manual LinkedIn login
# (linkedin-bulk-scan-login.cmd), which exports the session to SSM. Do not
# recreate it here. A surviving PC task could write a same-date outcome that
# suppresses the cloud run, so every registration pass removes it.
schtasks /query /tn 'SecondBrain-LinkedInScan' *> $null
if ($LASTEXITCODE -eq 0) {
    schtasks /delete /tn 'SecondBrain-LinkedInScan' /f *> $null
    if ($LASTEXITCODE -eq 0) { Write-Host 'OK  SecondBrain-LinkedInScan removed (cloud-owned)' }
    else { Write-Host 'ERR SecondBrain-LinkedInScan could not be removed' }
}
Skill-Task 'SecondBrain-ValuesEquipping'     'values-equipping-ideas'           '00:00'  # concurrent
Skill-Task 'SecondBrain-AmyResearchSkill'     'amy-research-skill'                '00:00'  # concurrent

# Video research and tools run in the cloud fleet under September 7 item 44.
# video-quality-tools stays on the overnight cloud fleet; video-quality-research
# moved to the 13:10 daytime cloud fleet slot (ExampleCo 2026-09-14). Their compact
# methods require useful evidence, no proposal quotas, and no recreation of
# historical analyzer versions. Do not duplicate them here.
#
# SHORTS PROPOSALS (scripts/morning-shorts-proposals.js) is RETIRED (ExampleCo
# 2026-09-25: "you can kill the example niche channel and proposed clips").
# Do not re-register it here or in the cloud scheduled fleet.

# ── Pre-briefing diagnostic + health heal ─────────────────────────────────────
# The former desktop pre-briefing diagnostic and broad health-self-heal tasks
# are retired above. They could reap processes, refresh sources, repair deploy
# drift, restart services, and notify while the canonical cloud controller was
# active. Cloud card/metric owners now perform that work under one admission and
# evidence contract; an attended laptop may diagnose or rescue but cannot own a
# second scheduled mutation lane.
# Provider and Gravity probes are retired only through the receipt-gated
# consolidation plan above. Do not recreate a desktop paid-model or broad
# authority lane here.
# SecondBrain-LifeArchiveSmsBackfill DEREGISTERED 2026-07-11: scripts\life-archive-sms-backfill.bat
# does not exist, so this task only ever failed. SMS backfill maps to a real
# requirement (AMY_REQUIREMENTS.md section 1, SMS channel) and needs a proper
# rebuild before it is re-registered. Tracked as a standing reminder:
# data/standing-reminders.json id sms-backfill-rebuild-2026-07.

# Clicked LinkedIn sends are approved user actions and must not sit in a
# dashboard-only queue. The local authenticated browser owns the actual send,
# so this worker polls continuously and converts every job into sent proof or a
# named blocker.
Bat-Minute-Task 'SecondBrain-LinkedInOutboundSend' "$root\scripts\linkedin-outbound-send.bat" 1

# Raw-first life archive: keep Gmail/Otter/Vapi/LinkedIn/WhatsApp/session files
# indexed for immediate local search, then push newly captured raw files to S3.
Bat-Minute-Task 'SecondBrain-LifeArchiveGmailBackfill' "$root\scripts\life-archive-gmail-backfill-fast.ps1" 15
Bat-Minute-Task 'SecondBrain-LifeArchiveIndex' "$root\scripts\life-archive-index.bat" 5
Bat-Minute-Task 'SecondBrain-LifeArchiveHealth' "$root\scripts\life-archive-health.bat" 60
Bat-Minute-Task 'SecondBrain-LifeArchiveS3Sync' "$root\scripts\life-archive-sync-s3.bat" 60
# Pull live identity membership changes into git-authoritative People Files.
# The relay refuses partial artifact/contact pulls and records durable health.
& (Join-Path $root 'scripts\register-voice-git-people-sync-task.ps1') `
  -RepoRoot (Join-Path $env:USERPROFILE 'sb-runtime\amy-code')
# SecondBrain-ConversationCacheArchiveSync DEREGISTERED 2026-07-11:
# scripts\publish-conversation-cache.bat does not exist, so this task only ever
# failed. No requirement currently maps to it; re-register only if the script
# is built and a real need is identified.
# Graphiti realtime maintenance is retired through the same receipt-gated plan.

# Keep the Claude Max-plan OAuth token warm for opportunistic PC-connected
# workloads without flashing a console window. The overnight briefing watcher
# and healer never depend on this task or its pushed token.
Bat-Minute-Task 'SecondBrain-ClaudeTokenRefresh' "$root\scripts\claude-token-refresh.bat" 60

# Keep gh CLI's hosts.yml in sync with the git credential helper so Claude
# Code's "PR status" check never goes stale and pops the pink "GitHub CLI
# authentication expired" toast ExampleCo explicitly does not want. 6-hour
# cadence (360 minutes); gho_* tokens rotate on the order of weeks so
# this has zero practical lag.
# GhCliTokenSync is folded into LifeArchiveDailyMaintenance.
# Retire the existing task only through the receipt-gated consolidation command.

# Briefing card snapshots are a cloud card-controller responsibility and retire
# only after that night-owner receipt is supplied to the consolidation plan.

# ── Persistent watchers ───────────────────────────────────────────────────────
# The gmail-amy-scan watcher writes a heartbeat every ~5 min and scans new mail
# for #Amy dispatches + contact enrichment. It must always be running; if it
# dies, health-self-heal's healGmailAmyScan restarts it (idempotently, no
# duplicate). This seeds it at logon so a fresh boot has it running by default.
Watch-Task 'SecondBrain-GmailAmyScanWatch' 'scripts\gmail-amy-scan.js' '--watch'

# ── Daytime CT fan-out (ExampleCo 2026-09-14) ──────────────────────────────────────
# Moved off the overnight box so the overnight EC2 box and its Codex/Claude
# quota go to the briefing cards. Production owner is the EC2
# cloud-scheduled-fleet daytime cron (13:10-16:40 CT), not a PC mirror.
# SecondBrain-NightlyEnhancement DEREGISTERED 2026-09-24: ExampleCo killed the
# nightly Amy-improvement research (secondbrain-nightly-enhancement) and its
# Feature Backlog card. Do not recreate this task; run-scheduled-skill.js
# refuses the retired skill before any model launch.

# ── Weekly ────────────────────────────────────────────────────────────────────
# Warmth audit moves into the 13:10 daytime fan-out (ExampleCo 2026-09-14, same
# overnight-quota reason as above): independent of everything else, finishes
# long before the 05:30 briefing reads its output.
Skill-Task 'SecondBrain-WarmthAudit'       'weekly-warmth-audit'        '13:10' -Day 'MON'
Skill-Task 'SecondBrain-BackupHealthCheck' 'weekly-backup-health-check' '04:17' -Day 'FRI'
Skill-Task 'SecondBrain-MemoryConsolidation' 'memory-consolidation' '04:00' -Day 'SAT'

# ── Night wake for the overnight healer ──────────────────────────────────────
# Historical incident context: this task once woke the laptop to refresh a
# pushed token after an overnight EC2 401. Cloud-resident subscription auth now
# removes that dependency.
# RETIRED 2026-08-11: do not recreate SecondBrain-ClaudeTokenNightWake. The
# automated cloud watcher and healer authenticate through the EC2 service
# user's subscription CLIs and must pass with the laptop powered off. The
# historical explanation above remains incident context, not current authority.

Write-Host ''
if ($OvernightLaneFailures -gt 0) {
    # Exit nonzero: an overnight lane left on schtasks defaults has no wake, no
    # missed-trigger recovery, a 72-hour limit, and no retry. That must never be
    # reported as a successful registration pass.
    Write-Host "FAIL: $OvernightLaneFailures overnight lane task(s) are STILL on unsafe defaults."
    exit 1
}
Write-Host 'Done.'

# register-scheduled-tasks.ps1
# Registers all missing Amy/SecondBrain scheduled tasks via schtasks.exe.
# Safe to re-run , uses /F (force overwrite).

$root = if ($env:SECONDBRAIN_ROOT) { $env:SECONDBRAIN_ROOT } else { Join-Path $env:USERPROFILE 'secondbrain' }
$runner = "$root\scripts\run-scheduled-skill.js"
$launcher = "$root\scripts\silent-node-launcher.vbs"
$user = $env:USERNAME

function Skill-Task {
    param(
        [string]$Name,
        [string]$SkillName,
        [string]$Time,        # HH:MM (24h, local time)
        [string]$Schedule = 'DAILY',
        [string]$Day = ''     # MON, FRI, etc. for WEEKLY
    )
    $taskRun = "wscript.exe `"$launcher`" `"$runner`" `"$SkillName`""
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
        [string]$Day = ''
    )
    if ($Day) {
        $taskRun = "wscript.exe `"$launcher`" `"$BatPath`""
        $result = schtasks /create /tn $Name /tr $taskRun /sc WEEKLY /d $Day /st $Time /f 2>&1
    } else {
        $taskRun = "wscript.exe `"$launcher`" `"$BatPath`""
        $result = schtasks /create /tn $Name /tr $taskRun /sc DAILY /st $Time /f 2>&1
    }
    if ($LASTEXITCODE -eq 0) {
        Write-Host "OK  $Name  ($Time)"
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

# ── Overnight: exactly ONE git-writing convergence task ───────────────────────
# Codex P0#2 / P2#5 (2026-06-01): three overnight jobs used to race the same git
# working tree (22:30 self-heal, 23:00 LLM heal, 23:00 briefing orchestrator).
# That is the bug. There is now exactly ONE git-writing overnight task:
# SecondBrain-OvernightBriefingOrchestrator (the convergence state machine). It
# internally calls heal-tests-by-file (step a, then commits the verified-green
# files by explicit path) and content-heal (step b), regenerates with
# --no-publish (step c), validates (step d), and publishes ONCE only when the
# validator returns zero failures (step e). No other overnight task writes git.
#
# UNREGISTER the old racing tasks before/after running this script (they are no
# longer created here, but a previously-registered scheduler still holds them):
#   schtasks /delete /tn SecondBrain-OvernightSelfHealOrchestrator /f
#   schtasks /delete /tn SecondBrain-OvernightLlmHeal /f
# The converge loop subsumes both: step (a) IS the LLM heal ladder, and the
# self-heal orchestrator's blocker-by-blocker healing is now driven by the
# loop, not a separate scheduled task.
#
# The 22:00 NightlyHealTests stays: it is the mechanical pass that loops the
# suite and writes data/agent/tests-blocked.json. It does NO git writes; the
# converge loop's step (a) reads that file to know which files are red.
Bat-Task 'SecondBrain-NightlyHealTests' "$root\scripts\nightly-heal-tests.bat" '22:00'
Bat-Task 'SecondBrain-OvernightBriefingOrchestrator' "$root\scripts\overnight-briefing-orchestrator.bat" '23:00'
Bat-Task 'SecondBrain-DailyBriefing' "$root\scripts\daily-briefing.bat" '04:35'

# ── Midnight CT parallel fan-out ──────────────────────────────────────────────
# All of these are independent of each other. Windows Task Scheduler runs each
# as its own process, so identical start times = true parallel execution. They
# must all finish before the 04:35 daily build / 05:30 briefing reads their
# output.
Skill-Task 'SecondBrain-NightlyEnhancement'   'secondbrain-nightly-enhancement'  '00:00'  # concurrent
Skill-Task 'SecondBrain-BirthdayCheck'        'daily-birthday-check'              '00:00'  # concurrent
Skill-Task 'SecondBrain-GmailScan'            'daily-gmail-scan'                  '00:00'  # concurrent
Skill-Task 'SecondBrain-OtterSweep'           'daily-otter-sweep'                 '00:00'  # concurrent
Skill-Task 'SecondBrain-LinkedInScan'         'daily-linkedin-scan'               '00:00'  # concurrent
Skill-Task 'SecondBrain-KingdomEquipping'     'kingdom-equipping-ideas'           '00:00'  # concurrent
Skill-Task 'SecondBrain-AmyResearchSkill'     'amy-research-skill'                '00:00'  # concurrent

# video-quality-research and video-quality-tools RETIRED 2026-07-11: 172
# straight no-op nights, the saturation guard (audit-tool-sprawl.py) blocks
# further work, superseded by the QC-fix mission. See
# scheduled-tasks/video-quality-research/SKILL.md and
# scheduled-tasks/video-quality-tools/SKILL.md.
#
# SHORTS PROPOSALS survive that retirement (ExampleCo wave 3a, 2026-07-12): the
# daily 10-proposal producer (scripts/morning-shorts-proposals.js) previously
# rode the video loops and went dark as collateral. It is now its OWN daily
# job in the CLOUD scheduled fleet (scripts/lib/cloud-scheduled-fleet.js,
# skill 'morning-shorts-proposals'), which runs pre-briefing on EC2, so it is
# deliberately NOT re-registered as a Windows task here.

# ── Pre-briefing diagnostic + health heal ─────────────────────────────────────
# These stay in their late slots: they read the night's accumulated state and
# must run after the midnight fan-out has finished writing.
Bat-Task 'SecondBrain-PreBriefingDiagnostic' "$root\scripts\pre-briefing-diagnostic.bat" '02:45'
Bat-Task 'SecondBrain-HealthSelfHeal' "$root\scripts\health-self-heal.bat" '03:00'
# Provider canaries (2026-06-11 ladder plan P4): prove every LLM rung daily,
# BEFORE the diagnostic reads the ledger at 02:45.
Bat-Task 'SecondBrain-ProviderCanaries' "$root\scripts\provider-canary.bat" '02:30'
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
# SecondBrain-ConversationCacheArchiveSync DEREGISTERED 2026-07-11:
# scripts\publish-conversation-cache.bat does not exist, so this task only ever
# failed. No requirement currently maps to it; re-register only if the script
# is built and a real need is identified.
Bat-Minute-Task 'SecondBrain-GraphitiRealtimeMaintenance' "$root\scripts\graphiti-realtime-maintenance.bat" 15

# Keep the Claude Max-plan OAuth token warm for EC2 dispatches without flashing
# a console window. This is hourly, but still goes through the same hidden
# launcher contract as every other SecondBrain task.
Bat-Minute-Task 'SecondBrain-ClaudeTokenRefresh' "$root\scripts\claude-token-refresh.bat" 60

# Keep gh CLI's hosts.yml in sync with the git credential helper so Claude
# Code's "PR status" check never goes stale and pops the pink "GitHub CLI
# authentication expired" toast ExampleCo explicitly does not want. 6-hour
# cadence (360 minutes); gho_* tokens rotate on the order of weeks so
# this has zero practical lag.
Bat-Minute-Task 'SecondBrain-GhCliTokenSync' "$root\scripts\gh-cli-token-sync.bat" 360

# ── Persistent watchers ───────────────────────────────────────────────────────
# The gmail-amy-scan watcher writes a heartbeat every ~5 min and scans new mail
# for #Amy dispatches + contact enrichment. It must always be running; if it
# dies, health-self-heal's healGmailAmyScan restarts it (idempotently, no
# duplicate). This seeds it at logon so a fresh boot has it running by default.
Watch-Task 'SecondBrain-GmailAmyScanWatch' 'scripts\gmail-amy-scan.js' '--watch'

# ── Weekly ────────────────────────────────────────────────────────────────────
# Warmth audit moves into the midnight Monday fan-out: independent of everything
# else, finishes long before the 05:30 briefing reads its output.
Skill-Task 'SecondBrain-WarmthAudit'       'weekly-warmth-audit'        '00:00' -Day 'MON'
Skill-Task 'SecondBrain-BackupHealthCheck' 'weekly-backup-health-check' '04:17' -Day 'FRI'

# ── Night wake for the overnight healer ──────────────────────────────────────
# The hourly Claude token pusher above only runs while the laptop is awake, and
# the Max-plan access token expires ~8h after its last refresh. With the laptop
# asleep overnight, the EC2 copy expired by the 2:45 AM self-heal, the executor
# auth probe 401ed, and the LLM worker fan-out was suppressed every night
# (2026-07-05 root cause). This task WAKES the machine at 2:15 AM, runs one
# refresh+push through the same hidden launcher, and lets it sleep again,
# covering the 2:45 self-heal and the 5:30 briefing. Single-credential-authority
# stays on the PC (an EC2 refresher would rotate the shared refresh-token chain
# and clobber the interactive login). WakeToRun needs schtasks-XML-level
# settings, so this one uses the ScheduledTasks cmdlets instead of schtasks.
# Requires AC power; a powered-off laptop still walls honestly via the executor
# auth probe runbook.
$nightWakeAction = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$launcher`" `"$root\scripts\claude-token-refresh.bat`""
$nightWakeTrigger = New-ScheduledTaskTrigger -Daily -At '2:15AM'
$nightWakeSettings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
try { Unregister-ScheduledTask -TaskName 'SecondBrain-ClaudeTokenNightWake' -Confirm:$false -ErrorAction Stop } catch {}
Register-ScheduledTask -TaskName 'SecondBrain-ClaudeTokenNightWake' -Action $nightWakeAction -Trigger $nightWakeTrigger -Settings $nightWakeSettings -Description 'Wakes the laptop at 2:15 AM to refresh the Claude token and push it to EC2 so the 2:45 self-heal and 5:30 briefing never 401.' | Out-Null
Write-Host 'OK  SecondBrain-ClaudeTokenNightWake  (02:15, WakeToRun)'

Write-Host ''
Write-Host 'Done.'

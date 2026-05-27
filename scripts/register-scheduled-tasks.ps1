# register-scheduled-tasks.ps1
# Registers all missing Amy/SecondBrain scheduled tasks via schtasks.exe.
# Safe to re-run — uses /F (force overwrite).

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

# The overnight orchestrator owns the real briefing loop. It starts at 11 PM CT,
# runs card workers in parallel where the repo supports it, then keeps the QC
# loop moving until clean or until a real blocker is named. The 4:35 AM daily
# build remains a final full-render fallback so the web dashboard is ready by
# 5:30 AM CT even if the long-running orchestrator is interrupted.
Bat-Task 'SecondBrain-NightlyHealTests' "$root\scripts\nightly-heal-tests.bat" '22:00'
Bat-Task 'SecondBrain-OvernightBriefingOrchestrator' "$root\scripts\overnight-briefing-orchestrator.bat" '23:00'
Bat-Task 'SecondBrain-DailyBriefing' "$root\scripts\daily-briefing.bat" '04:35'

# ── Midnight CT parallel fan-out ──────────────────────────────────────────────
# All of these are independent of each other. Windows Task Scheduler runs each
# as its own process, so identical start times = true parallel execution. They
# must all finish before the 04:35 daily build / 05:30 briefing reads their
# output.
Skill-Task 'SecondBrain-NightlyEnhancement'   'secondbrain-nightly-enhancement'  '00:00'  # concurrent
Skill-Task 'SecondBrain-VideoQualityResearch' 'video-quality-research'            '00:00'  # concurrent
Skill-Task 'SecondBrain-BirthdayCheck'        'daily-birthday-check'              '00:00'  # concurrent
Skill-Task 'SecondBrain-GmailScan'            'daily-gmail-scan'                  '00:00'  # concurrent
Skill-Task 'SecondBrain-OtterSweep'           'daily-otter-sweep'                 '00:00'  # concurrent
Skill-Task 'SecondBrain-LinkedInScan'         'daily-linkedin-scan'               '00:00'  # concurrent
Skill-Task 'SecondBrain-AmyResearchSkill'     'amy-research-skill'                '00:00'  # concurrent

# video-quality-tools depends on video-quality-research finishing first: both
# pick the 3 lowest-coverage rubric criteria, so research must mark its 3 before
# tools picks the next 3. 45 minute gap is conservative.
Skill-Task 'SecondBrain-VideoQualityTools'    'video-quality-tools'               '00:45'

# ── Pre-briefing diagnostic + health heal ─────────────────────────────────────
# These stay in their late slots: they read the night's accumulated state and
# must run after the midnight fan-out has finished writing.
Bat-Task 'SecondBrain-PreBriefingDiagnostic' "$root\scripts\pre-briefing-diagnostic.bat" '02:45'
Bat-Task 'SecondBrain-HealthSelfHeal' "$root\scripts\health-self-heal.bat" '03:00'
Bat-Task 'SecondBrain-LifeArchiveSmsBackfill' "$root\scripts\life-archive-sms-backfill.bat" '03:18'

# Clicked LinkedIn sends are approved user actions and must not sit in a
# dashboard-only queue. The local authenticated browser owns the actual send,
# so this worker polls continuously and converts every job into sent proof or a
# named blocker.
Bat-Minute-Task 'SecondBrain-LinkedInOutboundSend' "$root\scripts\linkedin-outbound-send.bat" 1

# Raw-first life archive: keep Gmail/Otter/Vapi/LinkedIn/WhatsApp/session files
# indexed for immediate local search, then push newly captured raw files to S3.
Bat-Minute-Task 'SecondBrain-LifeArchiveGmailBackfill' "$root\scripts\life-archive-gmail-backfill.bat" 15
Bat-Minute-Task 'SecondBrain-LifeArchiveIndex' "$root\scripts\life-archive-index.bat" 5
Bat-Minute-Task 'SecondBrain-LifeArchiveHealth' "$root\scripts\life-archive-health.bat" 60
Bat-Minute-Task 'SecondBrain-LifeArchiveS3Sync' "$root\scripts\life-archive-sync-s3.bat" 60
Bat-Minute-Task 'SecondBrain-ConversationCacheArchiveSync' "$root\scripts\publish-conversation-cache.bat" 60

# Keep the Claude Max-plan OAuth token warm for EC2 dispatches without flashing
# a console window. This is hourly, but still goes through the same hidden
# launcher contract as every other SecondBrain task.
Bat-Minute-Task 'SecondBrain-ClaudeTokenRefresh' "$root\scripts\claude-token-refresh.bat" 60

# Keep gh CLI's hosts.yml in sync with the git credential helper so Claude
# Code's "PR status" check never goes stale and pops the pink "GitHub CLI
# authentication expired" toast Luke explicitly does not want. 6-hour
# cadence (360 minutes); gho_* tokens rotate on the order of weeks so
# this has zero practical lag.
Bat-Minute-Task 'SecondBrain-GhCliTokenSync' "$root\scripts\gh-cli-token-sync.bat" 360

# ── Weekly ────────────────────────────────────────────────────────────────────
# Warmth audit moves into the midnight Monday fan-out: independent of everything
# else, finishes long before the 05:30 briefing reads its output.
Skill-Task 'SecondBrain-WarmthAudit'       'weekly-warmth-audit'        '00:00' -Day 'MON'
Skill-Task 'SecondBrain-BackupHealthCheck' 'weekly-backup-health-check' '04:17' -Day 'FRI'

Write-Host ''
Write-Host 'Done.'

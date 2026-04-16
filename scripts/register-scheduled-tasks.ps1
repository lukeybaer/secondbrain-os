# register-scheduled-tasks.ps1
# Registers all missing Amy/SecondBrain scheduled tasks via schtasks.exe.
# Safe to re-run — uses /F (force overwrite).

$root = if ($env:SECONDBRAIN_ROOT) { $env:SECONDBRAIN_ROOT } else { Join-Path $env:USERPROFILE 'secondbrain' }
$node = (Get-Command node -ErrorAction Stop).Source
$runner = "$root\scripts\run-scheduled-skill.js"
$user = $env:USERNAME

function Skill-Task {
    param(
        [string]$Name,
        [string]$SkillName,
        [string]$Time,        # HH:MM (24h, local time)
        [string]$Schedule = 'DAILY',
        [string]$Day = ''     # MON, FRI, etc. for WEEKLY
    )
    $taskRun = "`"$node`" `"$runner`" `"$SkillName`""
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
        $result = schtasks /create /tn $Name /tr "`"$BatPath`"" /sc WEEKLY /d $Day /st $Time /f 2>&1
    } else {
        $result = schtasks /create /tn $Name /tr "`"$BatPath`"" /sc DAILY /st $Time /f 2>&1
    }
    if ($LASTEXITCODE -eq 0) {
        Write-Host "OK  $Name  ($Time)"
    } else {
        Write-Host "ERR $Name`: $result"
    }
}

# ── Daily briefing 5:30 AM CT ─────────────────────────────────────────────────
Bat-Task 'SecondBrain-DailyBriefing' "$root\scripts\daily-briefing.bat" '05:30'

# ── Overnight improvement ─────────────────────────────────────────────────────
Skill-Task 'SecondBrain-NightlyEnhancement'   'secondbrain-nightly-enhancement'  '00:00'
Skill-Task 'SecondBrain-VideoQualityResearch' 'video-quality-research'            '01:30'
Skill-Task 'SecondBrain-VideoQualityTools'    'video-quality-tools'               '02:15'

# ── Pre-briefing diagnostic + health heal ─────────────────────────────────────
Bat-Task 'SecondBrain-PreBriefingDiagnostic' "$root\scripts\pre-briefing-diagnostic.bat" '02:45'
Bat-Task 'SecondBrain-HealthSelfHeal' "$root\scripts\health-self-heal.bat" '03:00'

# ── Pre-briefing data prep ────────────────────────────────────────────────────
Skill-Task 'SecondBrain-BirthdayCheck'  'daily-birthday-check'  '03:12'
Skill-Task 'SecondBrain-GmailScan'      'daily-gmail-scan'      '03:28'
Skill-Task 'SecondBrain-OtterSweep'     'daily-otter-sweep'     '03:43'
Skill-Task 'SecondBrain-LinkedInScan'   'daily-linkedin-scan'   '03:57'

# ── Weekly ────────────────────────────────────────────────────────────────────
Skill-Task 'SecondBrain-WarmthAudit'       'weekly-warmth-audit'        '04:33' -Day 'MON'
Skill-Task 'SecondBrain-BackupHealthCheck' 'weekly-backup-health-check' '04:17' -Day 'FRI'

Write-Host ''
Write-Host 'Done.'

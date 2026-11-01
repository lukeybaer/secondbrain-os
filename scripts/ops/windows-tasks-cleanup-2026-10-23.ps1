<#
.SYNOPSIS
  P6 cloud-first cleanup of the Windows Task Scheduler (2026-10-23).
  PREPARED by session/p6-1023. NOT RUN by the preparer: the owner runs it.

.DESCRIPTION
  Dry run by default: prints the plan, changes nothing in the scheduler, writes only its plan receipt.

    powershell -NoProfile -File scripts\ops\windows-tasks-cleanup-2026-10-23.ps1             # plan
    powershell -NoProfile -File scripts\ops\windows-tasks-cleanup-2026-10-23.ps1 -Apply      # do it
    powershell -NoProfile -File scripts\ops\windows-tasks-cleanup-2026-10-23.ps1 -Rollback   # undo from the backup

  -Apply runs two phases, in this order, and stops before any change if a precondition fails:

    1. UNREGISTER (29 tasks). Every task XML is exported to $BackupRoot first, a manifest is
       written, the exports are verified, and only then is each task unregistered.
         - 23 disabled PC mirrors of work that EC2 owns, or that was retired
         - 1 dead one-shot ("Amy Codex resume recorder 2026-09-26")
         - 4 enabled duplicates the EC2 amy-night-run fold owns (SuggestTokenReduction,
           ProviderCanaries, NightlyHealTests, GravityHealthProbe)
         - 1 weekly check EC2 owns (BackupHealthCheck, weekly-backup-health-check)
    2. RETARGET (2 tasks). Session Sweep and Session Archive Audit move from the stale
       sb-runtime\session-cloud-code side copy to the amy-code release junction. Arguments and
       working directory are rewritten in place; triggers, settings and principal are untouched.
       The new files must exist under the release first or nothing is changed.

  Never touched (this script refuses even if asked): the three disabled tasks the consolidation
  plan protects (ClaudeTokenNightWake, AttendedBriefingWatcherBridge, ClaudeMaxProxyWatchdog),
  and every KEEP task listed at the bottom of the plan output. A task that is no longer in the
  state the plan expects (a "disabled" mirror that someone re-enabled, anything Running) is
  skipped and reported, not removed.

  Receipt: every plan or apply run writes one beside the XML backups in $BackupRoot. -Apply writes
  windows-tasks-cleanup-<stamp>.json, a dry run writes windows-tasks-cleanup-plan-<stamp>.json, same
  shape: one row per task (action unregister or retarget, result) with its post-state re-read from
  ONE full Get-ScheduledTask listing after the run (absent, or present with state and action path).
  A listing that fails, or a post-state that contradicts the row's result, is a failure: exit 1.

  Owner: peer-review this script (deletion path) before -Apply. Re-verify with
  Get-ScheduledTask afterwards. Rollback re-registers each task from its exported XML.

  ASCII only on purpose: Windows PowerShell 5.1 reads BOM-less files as ANSI.
#>
[CmdletBinding()]
param(
    [switch]$Apply,
    [switch]$Rollback,
    [switch]$SkipUnregister,
    [switch]$SkipRetarget,
    [string]$BackupRoot = (Join-Path $env:APPDATA 'secondbrain\data\agent\windows-task-backups\2026-10-23'),
    [string]$RuntimeRoot = (Join-Path $env:USERPROFILE 'sb-runtime\amy-code'),
    [string]$StaleRoot = (Join-Path $env:USERPROFILE 'sb-runtime\session-cloud-code'),
    # Empty means config\desktop-task-consolidation-plan.json in the repo this script sits in. It is
    # resolved below because $PSScriptRoot is empty inside a param() default in Windows PowerShell 5.1.
    [string]$PlanConfig = ''
)

$ErrorActionPreference = 'Stop'
if (-not $PlanConfig) {
    $PlanConfig = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'config\desktop-task-consolidation-plan.json'
}

# ---- The approved lists ------------------------------------------------------------------
# Group, required state, owner of the work today, and the receipt or reason that makes it safe.
$Targets = @(
    # 23 disabled PC mirrors. Disabled since 2026-09-10 or earlier; nothing runs them.
    @{ Name = 'SecondBrain-AmyResearchSkill';                Group = 'disabled-mirror'; Why = 'amy-research-skill runs in the EC2 cloud fleet' }
    @{ Name = 'SecondBrain-AutoRegenRejectedVideos';         Group = 'disabled-mirror'; Why = 'EC2 cron owns auto-regen (auto-regen-owner-receipt)' }
    @{ Name = 'SecondBrain-BirthdayCheck';                   Group = 'disabled-mirror'; Why = 'daily-birthday-check runs in the EC2 cloud fleet' }
    @{ Name = 'SecondBrain-BriefingCardSnapshots';           Group = 'disabled-mirror'; Why = 'DesktopCapabilityWorker snapshots own it (desktop-snapshot-owner-receipt)' }
    @{ Name = 'SecondBrain-DailyBriefing';                   Group = 'disabled-mirror'; Why = 'EC2 amy-night-run builds the 5:30 briefing' }
    @{ Name = 'SecondBrain-GhCliTokenSync';                  Group = 'disabled-mirror'; Why = 'folded into LifeArchiveDailyMaintenance (gh-cli-token-sync step)' }
    @{ Name = 'SecondBrain-GmailScan';                       Group = 'disabled-mirror'; Why = 'daily-gmail-scan runs in the EC2 cloud fleet' }
    @{ Name = 'SecondBrain-RealtimeMaintenance';     Group = 'disabled-mirror'; Why = 'Graphiti is off (The owner); retired in the consolidation plan' }
    @{ Name = 'SecondBrain-HealthSelfHeal';                  Group = 'disabled-mirror'; Why = 'EC2 card controller owns self-heal' }
    @{ Name = 'SecondBrain-ValuesEquipping';                Group = 'disabled-mirror'; Why = 'values-equipping-ideas runs in the EC2 cloud fleet' }
    @{ Name = 'SecondBrain-LifeArchiveGmailBackfill';        Group = 'disabled-mirror'; Why = 'folded into LifeArchiveDailyMaintenance (gmail-backfill step)' }
    @{ Name = 'SecondBrain-LifeArchiveHealth';               Group = 'disabled-mirror'; Why = 'folded into LifeArchiveDailyMaintenance (health step)' }
    @{ Name = 'SecondBrain-LifeArchiveIndex';                Group = 'disabled-mirror'; Why = 'folded into LifeArchiveDailyMaintenance (index step)' }
    @{ Name = 'SecondBrain-LifeArchiveS3Sync';               Group = 'disabled-mirror'; Why = 'folded into LifeArchiveDailyMaintenance (s3-sync step)' }
    @{ Name = 'SecondBrain-MemoryConsolidation';             Group = 'disabled-mirror'; Why = 'memory-consolidation runs in the EC2 cloud fleet' }
    @{ Name = 'SecondBrain-NightlyEnhancement';              Group = 'disabled-mirror'; Why = 'retired by owner decision' }
    @{ Name = 'SecondBrain-OtterSweep';                      Group = 'disabled-mirror'; Why = 'daily-otter-sweep skill deleted 2026-09-14; Recorder ingest is EC2' }
    @{ Name = 'SecondBrain-OvernightBriefingOrchestrator';   Group = 'disabled-mirror'; Why = 'EC2 amy-night-run is the briefing owner' }
    @{ Name = 'SecondBrain-OvernightWatcher';                Group = 'disabled-mirror'; Why = 'EC2 watcher is the owner' }
    @{ Name = 'SecondBrain-PreBriefingDiagnostic';           Group = 'disabled-mirror'; Why = 'cloud card controller owns it' }
    @{ Name = 'SecondBrain-VoiceGitPeopleSync';              Group = 'disabled-mirror'; Why = 'EC2 fleet voice-git-people-sync; folded into LifeArchiveDailyMaintenance' }
    @{ Name = 'SecondBrain-WarmthAudit';                     Group = 'disabled-mirror'; Why = 'weekly-warmth-audit runs in the EC2 cloud fleet' }
    @{ Name = 'AmyCodexSessionGuard';                        Group = 'disabled-mirror'; Why = 'folded into LifeArchiveDailyMaintenance (codex-session-guard step)' }
    # The dead one-shot.
    @{ Name = 'Amy Codex resume recorder 2026-09-26';           Group = 'dead-one-shot';   Why = 'one-time trigger on 2026-09-26, already past' }
    # EC2 duplicates, enabled on the PC. EC2 amy-night-run fold receipts were ok:true on
    # 2026-10-21, 22 and 23 (data/agent/cloud-maintenance-folds/<date>/<activity>.json).
    @{ Name = 'SecondBrain-SuggestTokenReduction';           Group = 'ec2-duplicate';   Why = 'EC2 fold token-reduction-repair' }
    @{ Name = 'SecondBrain-ProviderCanaries';                Group = 'ec2-duplicate';   Why = 'EC2 fold provider-canaries' }
    @{ Name = 'SecondBrain-NightlyHealTests';                Group = 'ec2-duplicate';   Why = 'EC2 fold nightly-test-health' }
    @{ Name = 'SecondBrain-GravityHealthProbe';              Group = 'ec2-duplicate';   Why = 'EC2 fold gravity-health' }
    # EC2 owns the weekly check (scripts/lib/cloud-scheduled-fleet.js, weekly-backup-health-check).
    @{ Name = 'SecondBrain-BackupHealthCheck';               Group = 'ec2-owned';       Why = 'EC2 weekly-backup-health-check, receipt ok:true 2026-10-16 and 2026-10-23' }
)

# Retarget: stale side copy -> amy-code release junction.
$RetargetTasks = @(
    @{ Name = 'SecondBrain Session Sweep';         Script = 'scripts\session-sweep.mjs' }
    @{ Name = 'SecondBrain Session Archive Audit'; Script = 'scripts\session-archive-audit.mjs' }
)

# KEEP: printed so the owner sees what stays and why. The script refuses to touch any of these.
$Keep = @(
    @{ Name = 'SecondBrain-CollectDailyTokenUsage';      Why = 'reads the local Claude/Codex usage logs that exist only on this PC; feeds the briefing token card' }
    @{ Name = 'SecondBrain-LifeArchiveDailyMaintenance'; Why = 'local life-archive index plus S3 push, gh token sync, People relay and Codex session guard in one 21:30 run from the amy-code release' }
    @{ Name = 'SecondBrain-LinkedInOutboundSend';        Why = 'the authenticated LinkedIn browser profile lives only on this PC; sends the queued outbound LinkedIn messages' }
    @{ Name = 'SecondBrain-DailyBackup';                 Why = 'writes the 03:00 snapshot that EC2 backup-restore-proof verifies' }
    @{ Name = 'SecondBrain-ClaudeTokenRefresh';          Why = 'keeps the Claude Max OAuth token warm for PC-connected work (protected in the consolidation plan)' }
    @{ Name = 'SecondBrain Session Sweep';               Why = 'session transcripts exist only on this PC; uploads them to S3' }
    @{ Name = 'SecondBrain Session Archive Audit';       Why = 'proves the uploads landed in S3 and repairs gaps' }
    @{ Name = 'SecondBrain-DesktopCapabilityWorker';     Why = 'PC end of the signed capability relay (git hygiene, DevOps snapshots, release trigger); runs from a stable copy BY DESIGN so it outlives a release promotion' }
    @{ Name = 'SecondBrain-CodexThreadIndexSync';        Why = 'reads the Codex app state database on this PC' }
    @{ Name = 'Amy Wallpaper Guard';                     Why = 'local logon wallpaper guard, no production output' }
)

# Disabled but deliberately left: protected by the consolidation plan and, for the watchdog,
# required by src/main/__tests__/critical-windows-scheduled-tasks.test.ts.
$LeftInPlace = @('SecondBrain-ClaudeTokenNightWake', 'SecondBrain-AttendedBriefingWatcherBridge', 'ClaudeMaxProxyWatchdog')

# ---- helpers -----------------------------------------------------------------------------
function Get-TaskOrNull([string]$Name) {
    return (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue)
}
function Get-ActionText($Task) {
    $a = @($Task.Actions)[0]
    if (-not $a) { return '' }
    return ("{0} {1}" -f $a.Execute, $a.Arguments).Trim()
}
function Get-SafeFileName([string]$Name) { return (($Name -replace '[^A-Za-z0-9._-]', '_') + '.xml') }
function Test-IsUnder([string]$Path, [string]$Root) {
    if (-not $Path -or -not $Root) { return $false }
    return ($Path.Replace('/', '\').IndexOf($Root.TrimEnd('\').Replace('/', '\') + '\', [StringComparison]::OrdinalIgnoreCase) -ge 0)
}

# ---- run receipt -------------------------------------------------------------------------
# One row per task this run could change. Plan and apply write the same shape.
$ReceiptRows = New-Object System.Collections.ArrayList
function Add-ReceiptRow([string]$Name, [string]$Action, [string]$Result) {
    $row = [pscustomobject]@{ task_name = $Name; action = $Action; result = $Result; post_state = $null }
    [void]$ReceiptRows.Add($row)
    return $row
}
# Post-state comes from ONE full listing taken after the run, so a scheduler that cannot be read
# is reported as an error, never as tasks that merely look absent. Returns '' or the reason.
function Read-PostState {
    try { $all = @(Get-ScheduledTask -ErrorAction Stop) } catch { return "scheduler listing failed: $($_.Exception.Message)" }
    foreach ($row in $ReceiptRows) {
        $task = @($all | Where-Object { $_.TaskName -eq $row.task_name })[0]
        if (-not $task) { $row.post_state = [pscustomobject]@{ present = $false }; continue }
        $text = Get-ActionText $task
        $row.post_state = [pscustomobject]@{ present = $true; state = [string]$task.State; action = $text; on_release = (Test-IsUnder $text $RuntimeRoot); on_stale_copy = (Test-IsUnder $text $StaleRoot) }
    }
    return ''
}
function Write-RunReceipt([string]$Mode, [int]$Failures, [string]$PostStateError) {
    $stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd'T'HHmmssfff'Z'")
    $name = if ($Mode -eq 'apply') { "windows-tasks-cleanup-$stamp.json" } else { "windows-tasks-cleanup-plan-$stamp.json" }
    New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
    $file = Join-Path $BackupRoot $name
    [pscustomobject]@{
        schema = 'amy.windows_task_cleanup_receipt.v1'
        mode = $Mode
        created_at = (Get-Date).ToUniversalTime().ToString('o')
        computer = $env:COMPUTERNAME
        backup_root = $BackupRoot; runtime_root = $RuntimeRoot; stale_root = $StaleRoot
        skip_unregister = [bool]$SkipUnregister; skip_retarget = [bool]$SkipRetarget
        failures = $Failures
        post_state_source = 'one full Get-ScheduledTask listing, re-read after the run'
        post_state_error = $(if ($PostStateError) { $PostStateError } else { $null })
        tasks = @($ReceiptRows)
    } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $file -Encoding UTF8
    if (-not (Test-Path -LiteralPath $file)) { throw "run receipt was not written: $file" }
    return $file
}

# ---- preconditions that abort the whole run ----------------------------------------------
$protected = @()
if (Test-Path -LiteralPath $PlanConfig) {
    $protected = @((Get-Content -LiteralPath $PlanConfig -Raw | ConvertFrom-Json).protectedTasks)
} else {
    throw "consolidation plan not found, cannot prove the protected list: $PlanConfig"
}
foreach ($t in $Targets) {
    if ($protected -contains $t.Name) { throw "REFUSING: $($t.Name) is protected by the consolidation plan" }
    if (@($Keep | ForEach-Object { $_.Name }) -contains $t.Name) { throw "REFUSING: $($t.Name) is on the KEEP list" }
    if ($LeftInPlace -contains $t.Name) { throw "REFUSING: $($t.Name) is deliberately left in place" }
}
if ($Targets.Count -ne 29) { throw "internal check: expected 29 targets, found $($Targets.Count)" }

# ---- rollback ----------------------------------------------------------------------------
if ($Rollback) {
    $manifestPath = Join-Path $BackupRoot 'backup-manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath)) { throw "no backup manifest at $manifestPath" }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    foreach ($entry in @($manifest.tasks)) {
        $xml = Get-Content -LiteralPath (Join-Path $BackupRoot $entry.xml) -Raw
        if (-not $Apply) { Write-Output ("WOULD   restore {0} from {1}" -f $entry.task_name, $entry.xml); continue }
        Register-ScheduledTask -TaskName $entry.task_name -TaskPath $entry.task_path -Xml $xml -Force | Out-Null
        Write-Output ("RESTORED {0}" -f $entry.task_name)
    }
    if (-not $Apply) { Write-Output 'Rollback dry run. Re-run with -Rollback -Apply to restore.' }
    return
}

# ---- plan --------------------------------------------------------------------------------
Write-Output ("mode: {0}   backup: {1}   release: {2}" -f $(if ($Apply) { 'APPLY' } else { 'DRY-RUN' }), $BackupRoot, $RuntimeRoot)
Write-Output ''
Write-Output '== unregister'
$toRemove = @()
foreach ($t in $Targets) {
    $task = Get-TaskOrNull $t.Name
    if (-not $task) { Write-Output ("  absent   {0}" -f $t.Name); [void](Add-ReceiptRow $t.Name 'unregister' 'absent before the run'); continue }
    $state = [string]$task.State
    if ($state -eq 'Running') { Write-Output ("  SKIP     {0} (Running now)" -f $t.Name); [void](Add-ReceiptRow $t.Name 'unregister' 'skipped: Running now'); continue }
    if ($t.Group -eq 'disabled-mirror' -and $state -ne 'Disabled') {
        Write-Output ("  SKIP     {0} (expected Disabled, is {1}: someone re-enabled it)" -f $t.Name, $state)
        [void](Add-ReceiptRow $t.Name 'unregister' "skipped: expected Disabled, is $state")
        continue
    }
    Write-Output ("  WOULD    unregister {0}  [{1}, {2}]  {3}" -f $t.Name, $t.Group, $state, $t.Why)
    $toRemove += [pscustomobject]@{ Name = $t.Name; Group = $t.Group; State = $state; Task = $task; Row = (Add-ReceiptRow $t.Name 'unregister' 'would-unregister') }
}

Write-Output ''
Write-Output '== retarget to the release junction'
$toRetarget = @()
foreach ($r in $RetargetTasks) {
    $task = Get-TaskOrNull $r.Name
    if (-not $task) { Write-Output ("  absent   {0}" -f $r.Name); [void](Add-ReceiptRow $r.Name 'retarget' 'absent before the run'); continue }
    $a = @($task.Actions)[0]
    $text = Get-ActionText $task
    if (Test-IsUnder $text $RuntimeRoot) { Write-Output ("  ok       {0} already runs from {1}" -f $r.Name, $RuntimeRoot); [void](Add-ReceiptRow $r.Name 'retarget' 'already on the release'); continue }
    if (-not (Test-IsUnder $text $StaleRoot)) { Write-Output ("  SKIP     {0} (does not run from {1}; found: {2})" -f $r.Name, $StaleRoot, $text); [void](Add-ReceiptRow $r.Name 'retarget' "skipped: does not run from $StaleRoot"); continue }
    $needs = @((Join-Path $RuntimeRoot 'scripts\silent-node-launcher.vbs'), (Join-Path $RuntimeRoot $r.Script))
    $missing = @($needs | Where-Object { -not (Test-Path -LiteralPath $_) })
    if ($missing.Count -gt 0) { Write-Output ("  SKIP     {0} (release is missing: {1})" -f $r.Name, ($missing -join ', ')); [void](Add-ReceiptRow $r.Name 'retarget' ("skipped: release is missing {0}" -f ($missing -join ', '))); continue }
    Write-Output ("  WOULD    retarget {0}: {1} -> {2}" -f $r.Name, $StaleRoot, $RuntimeRoot)
    $toRetarget += [pscustomobject]@{ Name = $r.Name; Task = $task; Action = $a; Row = (Add-ReceiptRow $r.Name 'retarget' 'would-retarget') }
}

Write-Output ''
Write-Output '== still pointing at the two side roots after this plan (read-only inventory)'
$left = 0
foreach ($task in @(Get-ScheduledTask -ErrorAction SilentlyContinue)) {
    $text = Get-ActionText $task
    $willChange = (@($toRemove | ForEach-Object { $_.Name }) -contains $task.TaskName) -or (@($toRetarget | ForEach-Object { $_.Name }) -contains $task.TaskName)
    if (-not $willChange -and $text -and ($text -match 'session-cloud-code|desktop-capability-runtime')) {
        Write-Output ("  {0}: {1}" -f $task.TaskName, $text); $left++
    }
}
if ($left -eq 0) { Write-Output '  none' }
else { Write-Output '  (DesktopCapabilityWorker is expected here: its stable copy is deliberate, see KEEP.)' }

Write-Output ''
Write-Output '== kept on purpose'
foreach ($k in $Keep) { Write-Output ("  KEEP     {0}  {1}" -f $k.Name, $k.Why) }
Write-Output ''
Write-Output '== disabled and left in place (protected by the consolidation plan / required by a test)'
foreach ($n in $LeftInPlace) { Write-Output ("  LEFT     {0}" -f $n) }

if (-not $Apply) {
    # The plan receipt is the only write a dry run makes; nothing in the scheduler changes.
    $postError = Read-PostState
    $receiptFile = Write-RunReceipt 'plan' 0 $postError
    Write-Output ''
    Write-Output ("Dry run: {0} to unregister, {1} to retarget. Re-run with -Apply." -f $toRemove.Count, $toRetarget.Count)
    Write-Output ("plan receipt: {0}" -f $receiptFile)
    if ($postError) { Write-Output ("POST-STATE UNREADABLE: {0}" -f $postError); exit 1 }
    return
}

# ---- apply -------------------------------------------------------------------------------
New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
$manifestRows = @()

# 1. Export everything that will change, verify, write the manifest. Nothing is changed yet.
$exportList = @()
if (-not $SkipUnregister) { $exportList += $toRemove | ForEach-Object { [pscustomobject]@{ Name = $_.Name; Group = $_.Group; Task = $_.Task } } }
if (-not $SkipRetarget)   { $exportList += $toRetarget | ForEach-Object { [pscustomobject]@{ Name = $_.Name; Group = 'retarget'; Task = $_.Task } } }
foreach ($item in $exportList) {
    $file = Join-Path $BackupRoot (Get-SafeFileName $item.Name)
    $xml = [string](Export-ScheduledTask -TaskName $item.Name -TaskPath $item.Task.TaskPath)
    if (-not $xml -or $xml.Length -lt 20) { throw "export of $($item.Name) came back empty; nothing was changed" }
    try { [void][xml]$xml } catch { throw "export of $($item.Name) is not valid XML; nothing was changed" }
    Set-Content -LiteralPath $file -Value $xml -Encoding UTF8
    if (-not (Test-Path -LiteralPath $file) -or (Get-Item -LiteralPath $file).Length -lt 20) { throw "backup file for $($item.Name) was not written; nothing was changed" }
    $manifestRows += [pscustomobject]@{
        task_name = $item.Name; task_path = $item.Task.TaskPath; xml = (Split-Path $file -Leaf); group = $item.Group
        state_before = [string]$item.Task.State; action_before = (Get-ActionText $item.Task)
    }
}
[pscustomobject]@{
    schema = 'amy.windows_task_cleanup_backup.v1'
    created_at = (Get-Date).ToUniversalTime().ToString('o')
    computer = $env:COMPUTERNAME
    tasks = $manifestRows
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $BackupRoot 'backup-manifest.json') -Encoding UTF8
Write-Output ("exported {0} task definitions to {1}" -f $manifestRows.Count, $BackupRoot)

$failures = 0

# 2. Unregister, one by one, each verified gone.
if ($SkipUnregister) { foreach ($item in $toRemove) { $item.Row.result = 'not run (-SkipUnregister)' } }
else {
    foreach ($item in $toRemove) {
        try {
            Unregister-ScheduledTask -TaskName $item.Name -TaskPath $item.Task.TaskPath -Confirm:$false -ErrorAction Stop
            if (Get-TaskOrNull $item.Name) { throw 'still registered after Unregister-ScheduledTask' }
            Write-Output ("REMOVED  {0}" -f $item.Name)
            $item.Row.result = 'unregistered'
        } catch {
            $failures++
            Write-Output ("FAILED   {0}: {1}" -f $item.Name, $_.Exception.Message)
            $item.Row.result = "failed: $($_.Exception.Message)"
        }
    }
}

# 3. Retarget, each verified by reading the action back.
if ($SkipRetarget) { foreach ($item in $toRetarget) { $item.Row.result = 'not run (-SkipRetarget)' } }
else {
    foreach ($item in $toRetarget) {
        try {
            $a = $item.Action
            $pattern = [regex]::Escape($StaleRoot)
            $newArgs = [regex]::Replace([string]$a.Arguments, $pattern, { param($m) $RuntimeRoot }, 'IgnoreCase')
            $newWd = [regex]::Replace([string]$a.WorkingDirectory, $pattern, { param($m) $RuntimeRoot }, 'IgnoreCase')
            # New-ScheduledTaskAction rejects an empty -WorkingDirectory, so a task that never had one
            # keeps none instead of failing the retarget.
            $actionParams = @{ Execute = $a.Execute; Argument = $newArgs }
            if ($newWd) { $actionParams.WorkingDirectory = $newWd }
            $newAction = New-ScheduledTaskAction @actionParams
            Set-ScheduledTask -TaskName $item.Name -TaskPath $item.Task.TaskPath -Action $newAction -ErrorAction Stop | Out-Null
            $after = Get-ActionText (Get-TaskOrNull $item.Name)
            if (-not (Test-IsUnder $after $RuntimeRoot) -or (Test-IsUnder $after $StaleRoot)) { throw "action did not persist: $after" }
            Write-Output ("RETARGET {0}: {1}" -f $item.Name, $after)
            $item.Row.result = 'retargeted'
        } catch {
            $failures++
            Write-Output ("FAILED   {0}: {1}" -f $item.Name, $_.Exception.Message)
            $item.Row.result = "failed: $($_.Exception.Message)"
        }
    }
}

# 4. Receipt: every row's post-state from one full listing re-read now. An unreadable listing,
#    or a post-state that contradicts the result, counts as a failure, so the run exits 1.
$postError = Read-PostState
if ($postError) { $failures++; Write-Output ("POST-STATE UNREADABLE: {0}" -f $postError) }
foreach ($row in $ReceiptRows) {
    if (-not $row.post_state) { continue }
    if ($row.result -eq 'unregistered' -and $row.post_state.present) {
        $failures++; $row.result = 'failed: still registered on the post-state re-read'
    }
    if ($row.result -eq 'retargeted' -and -not ($row.post_state.present -and $row.post_state.on_release -and -not $row.post_state.on_stale_copy)) {
        $failures++; $row.result = 'failed: the post-state re-read does not show the release action'
    }
}
$receiptFile = Write-RunReceipt 'apply' $failures $postError

Write-Output ''
Write-Output ("done: {0} failure(s). Backups and manifest: {1}" -f $failures, $BackupRoot)
Write-Output ("receipt: {0}" -f $receiptFile)
Write-Output 'Rollback: scripts\ops\windows-tasks-cleanup-2026-10-23.ps1 -Rollback -Apply'
if ($failures -gt 0) { exit 1 }

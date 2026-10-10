[CmdletBinding()]
param(
    [ValidateSet('Plan', 'Apply', 'Rollback')]
    [string]$Mode = 'Plan',
    [switch]$ConfirmApply,
    [switch]$FinalizeDailyArchive,
    [string]$BackupDirectory = '',
    [string]$CloudProofPath = (Join-Path $env:APPDATA 'secondbrain\data\agent\desktop-task-consolidation\cloud-proof.json')
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runtimeRoot = Join-Path $env:USERPROFILE 'sb-runtime\amy-code'
$config = Get-Content -LiteralPath (Join-Path $repo 'config\desktop-task-consolidation-plan.json') -Raw | ConvertFrom-Json
$timestamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
if (-not $BackupDirectory) { $BackupDirectory = Join-Path $env:APPDATA "secondbrain\data\agent\desktop-task-consolidation\backups\$timestamp" }
$script:BackupManifest = @()

function Get-CurrentSourceSha {
    try {
        $sha = (& git -C $repo rev-parse HEAD 2>$null | Out-String).Trim().ToLowerInvariant()
        if ($LASTEXITCODE -ne 0 -or $sha -notmatch '^[a-f0-9]{40}$') { return '' }
        return $sha
    } catch { return '' }
}

$script:PlannerSourceSha = Get-CurrentSourceSha

function Get-CheckoutSourceSha([string]$Root, [string]$Label) {
    try {
        $sha = (& git -C $Root rev-parse HEAD 2>$null | Out-String).Trim().ToLowerInvariant()
        if ($LASTEXITCODE -ne 0 -or $sha -notmatch '^[a-f0-9]{40}$') { throw 'not a Git SHA' }
        return $sha
    } catch {
        throw "$Label source SHA is unavailable at $Root."
    }
}

function Get-ReceiptSha256([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Replacement receipt does not exist: $Path" }
    $command = Get-Command Get-FileHash -ErrorAction SilentlyContinue
    if ($command) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() }
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try { return (($sha256.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) -join '') } finally { $sha256.Dispose(); $stream.Dispose() }
}

function Get-MaxReceiptAgeHours($Replacement) {
    if ($Replacement.activity -eq 'desktop-briefing-card-snapshots') { return 6 }
    if ($Replacement.activity -in @('weekly-warmth-audit', 'memory-consolidation')) { return 192 }
    return 26
}

function Get-ReceiptProducerEvidence([string]$Path, $Replacement) {
    try { $receipt = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json } catch { throw "Replacement receipt is unreadable JSON: $Path" }
    if ($receipt.ok -ne $true) { throw "Replacement receipt is not successful: $Path" }
    if ($receipt.source_sha -notmatch '^[a-fA-F0-9]{40}$') { throw "Replacement receipt has no valid producer source SHA: $Path" }
    if ($receipt.replacement_id -ne $Replacement.id -or $receipt.activity -ne $Replacement.activity -or $receipt.receipt_kind -ne $Replacement.receiptKind) {
        throw "Replacement receipt identity does not match configured replacement: $Path"
    }
    if ($receipt.schema -eq 'amy.cloud_scheduled_fleet_observation.v1') {
        $observed = $receipt.observed
        if (-not $observed -or $observed.raw_row_sha256 -notmatch '^[a-fA-F0-9]{64}$' -or -not $observed.graph_receipt_id -or $observed.skill -ne $Replacement.activity -or $observed.source_file_sha256 -notmatch '^[a-fA-F0-9]{64}$' -or $observed.release_source_sha -ne $receipt.source_sha) {
            throw "Cloud fleet observation lacks bound raw-row, graph, source-file, or release evidence: $Path"
        }
    } elseif ($receipt.schema -eq 'amy.retired_owner_observation.v1') {
        $observed = $receipt.observed
        if ($Replacement.kind -ne 'retired-owner' -or -not $observed -or $observed.policy_sha256 -notmatch '^[a-fA-F0-9]{64}$' -or $observed.policy_state -ne 'disabled' -or $observed.ingestion_state -ne 'disabled' -or @($observed.machine_checks).Count -lt 3) {
            throw "Retired-owner observation lacks disabled policy or machine absence evidence: $Path"
        }
        foreach ($check in @($observed.machine_checks)) {
            if ($check.ok -ne $true -or $check.output_sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw "Retired-owner machine observation has an unhashed or failed check: $Path" }
        }
        $checkNames = @($observed.machine_checks | ForEach-Object { $_.name })
        foreach ($requiredCheck in @('cron', 'timer', 'process')) {
            if ($checkNames -notcontains $requiredCheck) { throw "Retired-owner observation is missing the $requiredCheck absence check: $Path" }
        }
    } elseif ($receipt.schema -ne 'amy.desktop_task_replacement_native_receipt.v1') {
        throw "Replacement receipt has an unsupported schema: $Path"
    }
    if ($Replacement.receiptKind -eq 'cloud-maintenance-owner-receipt') {
        if ($receipt.owner -ne 'amy-night-run' -or $receipt.producer.exit_code -ne 0 -or $receipt.producer.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or $receipt.native_output.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or -not $receipt.native_output.evidence) { throw "Cloud maintenance receipt lacks native producer evidence: $Path" }
        $native = $receipt.native_output.evidence
        if ($Replacement.activity -eq 'provider-canaries') {
            foreach ($provider in @('claude', 'codex')) {
                if ($native.$provider -isnot [bool] -or $native.attempts.$provider.attempted -ne $true -or $native.attempts.$provider.nonce -notmatch '^amy-canary-[a-f0-9]{24}$') { throw "Canary receipt lacks both actual nonce-bound attempts: $Path" }
            }
        }
        if ($Replacement.activity -eq 'nightly-test-health' -and ($native.scopeMode -ne 'canonical-core-guards' -or $native.runnerFailed -ne $false -or $native.total -le 0 -or @($native.scope).Count -eq 0 -or $native.fullSuiteVerified -ne $false)) { throw "Scoped test receipt lacks a measured canonical scope: $Path" }
        if ($Replacement.activity -eq 'gravity-health' -and ($native.schema -ne 'amy.gravity_health.v1' -or @($native.laws).Count -eq 0)) { throw "Gravity receipt lacks native laws: $Path" }
        if ($Replacement.activity -eq 'token-reduction-repair' -and -not $native.suggestion) { throw "Suggestion receipt lacks native output: $Path" }
    }
    if ($Replacement.receiptKind -eq 'desktop-snapshot-owner-receipt') {
        if ($receipt.owner -ne 'DesktopCapabilityWorker' -or $receipt.cadence_ms -le 0 -or $receipt.cadence_ms -gt 21600000 -or @($receipt.received_snapshots).Count -ne 3) { throw "Snapshot receipt lacks bounded desktop ownership and received hashes: $Path" }
        foreach ($id in @('git-hygiene', 'devops-health', 'life-archive-health')) {
            $producer = @($receipt.producers | Where-Object { $_.id -eq $id })
            if ($producer.Count -ne 1 -or $producer[0].ok -ne $true -or $producer[0].ran -ne $true -or $producer[0].shipped -ne $true) { throw "Snapshot producer did not run and ship: $id" }
            $received = @($receipt.received_snapshots | Where-Object { $_.remote -eq $producer[0].remotePath })
            if ($received.Count -ne 1 -or $received[0].sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw "Snapshot producer lacks its received hash: $id" }
        }
    }
    if ($Replacement.receiptKind -eq 'auto-regen-owner-receipt') {
        if ($receipt.owner -ne 'ec2-cron' -or $receipt.observed.cron_sha256 -notmatch '^[a-fA-F0-9]{64}$' -or $receipt.observed.log_sha256 -notmatch '^[a-fA-F0-9]{64}$' -or $receipt.observed.guard_sha256 -notmatch '^[a-fA-F0-9]{64}$' -or $receipt.observed.source_file_sha256 -notmatch '^[a-fA-F0-9]{64}$' -or $receipt.observed.native_outcome -notin @('unchanged-input-refused', 'processed', 'empty')) { throw "AutoRegen receipt lacks scheduled execution evidence: $Path" }
    }
    $completedAt = $receipt.completed_at
    if (-not $completedAt) { $completedAt = $receipt.observed_at }
    if (-not $completedAt) { $completedAt = $receipt.ts }
    try { $completedAt = [DateTimeOffset]::Parse($completedAt).ToUniversalTime() } catch { throw "Replacement receipt has no valid completion timestamp: $Path" }
    $ageHours = ([DateTimeOffset]::UtcNow - $completedAt).TotalHours
    if ($ageHours -lt -0.1 -or $ageHours -gt (Get-MaxReceiptAgeHours $Replacement)) { throw "Replacement receipt is stale or implausibly future-dated: $Path" }
    return [pscustomobject]@{ source_sha = $receipt.source_sha.ToLowerInvariant(); completed_at = $completedAt.ToString('o') }
}

function Assert-NotProtected([string]$TaskName) {
    if ($config.protectedTasks -contains $TaskName) { throw "Refusing to modify protected task: $TaskName" }
}

function Export-TaskBackup([string]$TaskName) {
    Assert-NotProtected $TaskName
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $file = Join-Path $BackupDirectory ("{0}.xml" -f ($TaskName -replace '[^A-Za-z0-9._-]', '_'))
    Export-ScheduledTask -TaskName $TaskName -TaskPath $task.TaskPath | Set-Content -LiteralPath $file -Encoding UTF8
    $script:BackupManifest += [pscustomobject]@{ task_name = $TaskName; task_path = $task.TaskPath; xml = (Split-Path $file -Leaf) }
    return $file
}

function Write-BackupManifest {
    [pscustomobject]@{ schema = 'amy.desktop_task_xml_backup.v1'; created_at = (Get-Date).ToUniversalTime().ToString('o'); tasks = $script:BackupManifest } |
        ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $BackupDirectory 'backup-manifest.json') -Encoding UTF8
}

function Test-DailyArchiveReceipt {
    $receipt = Join-Path $env:APPDATA 'secondbrain\data\agent\life-archive-daily-maintenance\latest.json'
    if (-not (Test-Path -LiteralPath $receipt)) { return [pscustomobject]@{ ok = $false; reason = 'missing-daily-archive-receipt' } }
    try {
        $value = Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
        $runtimeSourceSha = Get-CheckoutSourceSha $runtimeRoot 'Daily archive runtime'
        if ($value.source_sha -notmatch '^[a-fA-F0-9]{40}$') { return [pscustomobject]@{ ok = $false; reason = 'daily-archive-receipt-missing-source-sha' } }
        if ($value.source_sha.ToLowerInvariant() -ne $runtimeSourceSha) { return [pscustomobject]@{ ok = $false; reason = 'daily-archive-runtime-source-sha-mismatch' } }
        $completedAt = [DateTimeOffset]::Parse($value.completed_at).ToUniversalTime()
        $ageHours = ([DateTimeOffset]::UtcNow - $completedAt).TotalHours
        if ($ageHours -lt -0.1 -or $ageHours -gt 26) { return [pscustomobject]@{ ok = $false; reason = 'daily-archive-receipt-stale' } }
        if ($value.schema -ne 'amy.life_archive_daily_maintenance_receipt.v1' -or $value.ok -ne $true -or @($value.steps).Count -ne @($config.dailyArchive.requiredSteps).Count) { return [pscustomobject]@{ ok = $false; reason = 'daily-archive-receipt-not-successful-complete-run' } }
        foreach ($stepName in @($config.dailyArchive.requiredSteps)) {
            $matched = @($value.steps | Where-Object { $_.name -eq $stepName })
            if ($matched.Count -ne 1 -or $matched[0].ok -ne $true -or $matched[0].exit_code -ne 0) {
                return [pscustomobject]@{ ok = $false; reason = "daily-maintenance-step-unproved:$stepName" }
            }
        }
        return [pscustomobject]@{ ok = $true; reason = 'verified-daily-archive-runtime-receipt' }
    } catch { return [pscustomobject]@{ ok = $false; reason = "daily-archive-receipt-invalid: $($_.Exception.Message)" } }
}

function Read-CloudProof {
    if (-not (Test-Path -LiteralPath $CloudProofPath)) { return @{} }
    try { $raw = Get-Content -LiteralPath $CloudProofPath -Raw | ConvertFrom-Json } catch { throw "Replacement proof document is malformed: $CloudProofPath ($($_.Exception.Message))" }
    if ($raw.schema -ne $config.replacementProofSchema -or $null -eq $raw.proofs) { throw "Replacement proof document has an incompatible schema or missing proofs: $CloudProofPath" }
    $proof = @{}
    foreach ($row in @($raw.proofs)) {
        if (-not $row.task_name) { throw "Replacement proof document contains a proof without task_name: $CloudProofPath" }
        if ($proof.ContainsKey($row.task_name)) { throw "Replacement proof document contains duplicate task_name '$($row.task_name)': $CloudProofPath" }
        $proof[$row.task_name] = $row
    }
    return $proof
}

function Test-ExactReplacementProof($Candidate, $Proof) {
    if (-not $Proof) { return [pscustomobject]@{ ok = $false; reason = 'missing-proof' } }
    if ($Proof.verified -ne $true) { return [pscustomobject]@{ ok = $false; reason = 'proof-not-reviewed' } }
    $replacement = $Candidate.replacement
    if ($replacement.kind -eq 'unverified-owner') { return [pscustomobject]@{ ok = $false; reason = 'replacement-owner-unverified' } }
    if ($Proof.task_name -ne $Candidate.taskName -or
        $Proof.replacement_id -ne $replacement.id -or
        $Proof.replacement_kind -ne $replacement.kind -or
        $Proof.activity -ne $replacement.activity -or
        $Proof.receipt_kind -ne $replacement.receiptKind) { return [pscustomobject]@{ ok = $false; reason = 'replacement-identity-mismatch' } }
    if (-not $Proof.receipt_path) { return [pscustomobject]@{ ok = $false; reason = 'missing-local-receipt-copy' } }
    if ($Proof.receipt_sha256 -notmatch '^[a-fA-F0-9]{64}$') { return [pscustomobject]@{ ok = $false; reason = 'invalid-receipt-sha256' } }
    try {
        $actualReceiptHash = Get-ReceiptSha256 $Proof.receipt_path
        if ($actualReceiptHash -ne $Proof.receipt_sha256.ToLowerInvariant()) { return [pscustomobject]@{ ok = $false; reason = 'local-receipt-hash-mismatch' } }
    } catch { return [pscustomobject]@{ ok = $false; reason = 'local-receipt-copy-unreadable' } }
    try {
        $evidence = Get-ReceiptProducerEvidence $Proof.receipt_path $replacement
        if ($Proof.source_sha -ne $evidence.source_sha -or $Proof.receipt_completed_at -ne $evidence.completed_at) { return [pscustomobject]@{ ok = $false; reason = 'proof-receipt-evidence-mismatch' } }
        [void][DateTimeOffset]::Parse($Proof.verified_at)
    } catch { return [pscustomobject]@{ ok = $false; reason = "invalid-replacement-receipt: $($_.Exception.Message)" } }
    return [pscustomobject]@{ ok = $true; reason = 'verified-local-receipt-copy' }
}

function Get-ExpectedActions {
    $proofs = Read-CloudProof
    $actions = @()
    $actions += [pscustomobject]@{ kind = 'create-daily-archive-runner'; task_name = $config.dailyArchive.taskName; time = $config.dailyArchive.time; runner = $config.dailyArchive.runner }
    foreach ($name in @($config.dailyArchive.retireAfterCreate)) { $actions += [pscustomobject]@{ kind = 'disable-after-daily-runner-verification'; task_name = $name } }
    foreach ($change in @($config.cadenceChanges)) { $actions += [pscustomobject]@{ kind = 'set-repetition'; task_name = $change.taskName; from_minutes = $change.fromMinutes; to_minutes = $change.toMinutes } }
    foreach ($candidate in @($config.cloudDuplicateCandidates)) {
        $match = $proofs[$candidate.taskName]
        $decision = Test-ExactReplacementProof $candidate $match
        if ($decision.ok) {
            $actions += [pscustomobject]@{ kind = 'disable-after-cloud-receipt-verification'; task_name = $candidate.taskName; replacement = $candidate.replacement }
        } else {
            $actions += [pscustomobject]@{ kind = 'blocked-cloud-proof'; task_name = $candidate.taskName; replacement = $candidate.replacement; reason = $decision.reason }
        }
    }
    foreach ($action in $actions) { if ($action.task_name) { Assert-NotProtected $action.task_name } }
    return $actions
}

function Register-DailyArchiveRunner {
    $launcher = Join-Path $runtimeRoot 'scripts\silent-node-launcher.vbs'
    $runner = Join-Path $runtimeRoot $config.dailyArchive.runner
    foreach ($required in @($launcher, $runner)) { if (-not (Test-Path -LiteralPath $required)) { throw "Runtime release is missing required daily archive dependency: $required" } }
    $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$launcher`" `"$runner`" -Execute" -WorkingDirectory $runtimeRoot
    $trigger = New-ScheduledTaskTrigger -Daily -At $config.dailyArchive.time
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 3)
    Register-ScheduledTask -TaskName $config.dailyArchive.taskName -Action $action -Trigger $trigger -Settings $settings -Description 'Daily local life-archive maintenance. Does not replace continuous desktop session replication.' -Force | Out-Null
    $registered = Get-ScheduledTask -TaskName $config.dailyArchive.taskName -ErrorAction Stop
    if ($registered.Actions[0].Execute -notmatch 'wscript') { throw 'Daily archive runner did not register through the silent launcher.' }
}

if ($Mode -eq 'Plan') {
    [pscustomobject]@{
        schema = 'amy.desktop_task_consolidation_plan.v1'
        mode = 'plan'
        backup_directory = $BackupDirectory
        cloud_proof_path = $CloudProofPath
        planner_source_sha = $script:PlannerSourceSha
        actions = Get-ExpectedActions
        protected_tasks = $config.protectedTasks
        note = 'Plan mode is read-only. It does not export XML, create a task, change cadence, disable a task, or contact EC2.'
    } | ConvertTo-Json -Depth 8
    exit 0
}

if ($Mode -eq 'Apply') {
    if (-not $ConfirmApply) { throw 'Apply requires -ConfirmApply. Run Plan first and review its exact actions.' }
    New-Item -ItemType Directory -Path $BackupDirectory -Force | Out-Null
    $actions = Get-ExpectedActions
    $changed = @($config.cadenceChanges.taskName) + @($actions | Where-Object { $_.kind -eq 'disable-after-cloud-receipt-verification' } | ForEach-Object { $_.task_name })
    if (Get-ScheduledTask -TaskName $config.dailyArchive.taskName -ErrorAction SilentlyContinue) { $changed += $config.dailyArchive.taskName }
    if ($FinalizeDailyArchive) {
        $dailyArchiveDecision = Test-DailyArchiveReceipt
        if (-not $dailyArchiveDecision.ok) { throw "Daily archive source tasks remain enabled: $($dailyArchiveDecision.reason)." }
        $changed += @($config.dailyArchive.retireAfterCreate)
    }
    foreach ($name in ($changed | Select-Object -Unique)) { Export-TaskBackup $name | Out-Null }
    Write-BackupManifest
    Register-DailyArchiveRunner
    if ($FinalizeDailyArchive) {
        foreach ($name in @($config.dailyArchive.retireAfterCreate)) { Disable-ScheduledTask -TaskName $name -ErrorAction Stop | Out-Null }
    }
    foreach ($change in @($config.cadenceChanges)) {
        $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $change.toMinutes) -RepetitionDuration (New-TimeSpan -Days 3650)
        Set-ScheduledTask -TaskName $change.taskName -Trigger $trigger -ErrorAction Stop | Out-Null
    }
    foreach ($action in $actions | Where-Object { $_.kind -eq 'disable-after-cloud-receipt-verification' }) { Disable-ScheduledTask -TaskName $action.task_name -ErrorAction Stop | Out-Null }
    [pscustomobject]@{ mode = 'apply'; backup_directory = $BackupDirectory; actions = $actions } | ConvertTo-Json -Depth 8
    exit 0
}

if (-not (Test-Path -LiteralPath $BackupDirectory)) { throw "Rollback backup directory does not exist: $BackupDirectory" }
$manifestPath = Join-Path $BackupDirectory 'backup-manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "Rollback manifest does not exist: $manifestPath" }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
foreach ($entry in @($manifest.tasks)) {
    Register-ScheduledTask -TaskName $entry.task_name -TaskPath $entry.task_path -Xml (Get-Content -LiteralPath (Join-Path $BackupDirectory $entry.xml) -Raw) -Force | Out-Null
}
$dailyArchiveWasBackedUp = @($manifest.tasks | Where-Object { $_.task_name -eq $config.dailyArchive.taskName }).Count -gt 0
if (-not $dailyArchiveWasBackedUp -and (Get-ScheduledTask -TaskName $config.dailyArchive.taskName -ErrorAction SilentlyContinue)) { Unregister-ScheduledTask -TaskName $config.dailyArchive.taskName -Confirm:$false }
Write-Output ("Rollback restored XML backups from {0}; daily archive task was {1}." -f $BackupDirectory, $(if ($dailyArchiveWasBackedUp) { 'preserved from its preexisting XML backup' } else { 'removed because this run created it' }))

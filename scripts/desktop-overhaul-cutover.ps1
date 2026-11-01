[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-fA-F0-9]{40}$')][string]$FinalSourceSha,
    [ValidateSet('Plan', 'Apply')][string]$Mode = 'Plan',
    [switch]$ConfirmApply,
    [string]$SourceRoot = '',
    [string]$RuntimeRoot = (Join-Path $env:USERPROFILE 'sb-runtime\amy-code'),
    [string]$SharedCheckoutRoot = (Join-Path $env:USERPROFILE 'secondbrain'),
    [string]$EvidenceDirectory = (Join-Path $env:APPDATA 'secondbrain\data\agent\desktop-overhaul-cutover'),
    [string]$ReplacementReceiptManifest = ''
)

# This is the attended, post-landed desktop cutover only. Plan mode is entirely
# descriptive. Apply needs a reviewed final SHA, a clean integration checkout,
# and per-task replacement receipts; it leaves every candidate without an exact
# current receipt enabled. It never touches the session-cloud runtime or stops a
# worker.
$ErrorActionPreference = 'Stop'

function Invoke-GitText([string]$Root, [string[]]$Arguments) {
    $value = & git -C $Root @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "git -C $Root $($Arguments -join ' ') failed: $value" }
    return ($value | Out-String).Trim()
}

function Assert-SourceSha([string]$Root, [string]$Sha) {
    $head = Invoke-GitText $Root @('rev-parse', 'HEAD')
    if ($head -ne $Sha) { throw "Source root HEAD $head is not the supplied final SHA $Sha." }
    & git -C $Root merge-base --is-ancestor $Sha 'origin/master'
    if ($LASTEXITCODE -ne 0) { throw "Final SHA $Sha is not landed on origin/master." }
    $dirty = Invoke-GitText $Root @('status', '--porcelain')
    if ($dirty) { throw "Source root must be a clean integration checkout for this cutover: $Root" }
}

function Get-ContinuityReceipt {
    $path = Join-Path $env:APPDATA 'secondbrain\data\agent\session-cloud-producer-local.json'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing session-cloud producer receipt: $path" }
    $receipt = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    $at = [DateTimeOffset]::Parse($receipt.observed_at)
    if (([DateTimeOffset]::UtcNow - $at).TotalMinutes -gt 10) { throw "Session-cloud producer receipt is older than ten minutes: $($receipt.observed_at)" }
    if ($receipt.s3_heartbeat_ok -ne $true -or $receipt.cloud_heartbeat_ok -ne $true -or [int]$receipt.pending_outbox -ne 0) {
        throw 'Session-cloud producer receipt is not positive (S3/cloud heartbeat and empty outbox are required).'
    }
    return $receipt
}

function Assert-Continuity([string]$Stage) {
    $sweep = Get-ScheduledTask -TaskName 'SecondBrain Session Sweep' -ErrorAction Stop
    $worker = Get-ScheduledTask -TaskName 'SecondBrain-DesktopCapabilityWorker' -ErrorAction Stop
    if ($worker.State -ne 'Running') { throw "DesktopCapabilityWorker is not running at $Stage." }
    $receipt = Get-ContinuityReceipt
    return [pscustomobject]@{
        stage = $Stage
        checked_at = (Get-Date).ToUniversalTime().ToString('o')
        session_sweep_state = $sweep.State.ToString()
        desktop_capability_worker_state = $worker.State.ToString()
        session_producer_observed_at = $receipt.observed_at
        s3_heartbeat_ok = $receipt.s3_heartbeat_ok
        cloud_heartbeat_ok = $receipt.cloud_heartbeat_ok
        pending_outbox = $receipt.pending_outbox
    }
}

function Get-ReceiptRows([string]$ManifestPath, [string]$Sha) {
    if (-not $ManifestPath) { return @() }
    if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { throw "Replacement receipt manifest does not exist: $ManifestPath" }
    $document = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
    if ($document.schema -ne 'amy.desktop_task_replacement_receipts.v1') { throw "Replacement receipt manifest has the wrong schema: $ManifestPath" }
    if ($document.planner_source_sha -ne $Sha) { throw "Replacement receipt manifest planner_source_sha does not equal final SHA $Sha" }
    return @($document.receipts | Where-Object { $_.reviewed -eq $true -and $_.task_name -and $_.receipt_path })
}

function Get-CutoverPlan($Config, [string]$Sha, [string]$ManifestPath) {
    $rows = Get-ReceiptRows $ManifestPath $Sha
    $proofs = foreach ($candidate in @($Config.cloudDuplicateCandidates)) {
        $row = @($rows | Where-Object { $_.task_name -eq $candidate.taskName })
        [pscustomobject]@{
            task_name = $candidate.taskName
            replacement = $candidate.replacement
            proof_action = if ($row.Count -ne 1) { 'blocked-missing-reviewed-receipt' } elseif (-not (Test-Path -LiteralPath $row[0].receipt_path -PathType Leaf)) { 'blocked-missing-local-receipt-copy' } elseif ($row[0].producer_source_sha -notmatch '^[a-fA-F0-9]{40}$') { 'blocked-missing-producer-source-sha' } else { 'create-reviewed-proof' }
            receipt_path = if ($row.Count -eq 1) { $row[0].receipt_path } else { $null }
        }
    }
    return [pscustomobject]@{
        schema = 'amy.desktop_overhaul_cutover_plan.v1'
        mode = $Mode.ToLower()
        final_source_sha = $Sha
        ordered_actions = @(
            'assert positive session and DesktopCapabilityWorker continuity',
            'promote immutable amy-code to the exact landed SHA without restarting the worker',
            'register the daily archive runner and run its four bounded steps',
            'create receipt proofs only for reviewed current replacements, including Graphiti retirement when its explicit retired-owner receipt is present',
            'consolidate only tasks with matching proofs and the successful daily archive receipt',
            'project repository Git hooks and global Claude/Codex adapters, then fast-forward the shared checkout only through its guarded updater',
            'recheck continuity and retain the XML backup directory reported by consolidation'
        )
        daily_archive = $Config.dailyArchive
        proof_candidates = @($proofs)
        protected_tasks = @($Config.protectedTasks)
        manifest_required_schema = 'amy.desktop_task_replacement_receipts.v1'
        no_receipt_means = 'candidate remains enabled'
    }
}

if (-not $SourceRoot) { $SourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
$SourceRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
$config = Get-Content -LiteralPath (Join-Path $SourceRoot 'config\desktop-task-consolidation-plan.json') -Raw | ConvertFrom-Json
$FinalSourceSha = $FinalSourceSha.ToLowerInvariant()
$plan = Get-CutoverPlan $config $FinalSourceSha $ReplacementReceiptManifest
if ($Mode -eq 'Plan') { $plan | ConvertTo-Json -Depth 12; exit 0 }
if (-not $ConfirmApply) { throw 'Apply requires -ConfirmApply after Plan review and deployment confirmation.' }
Assert-SourceSha $SourceRoot $FinalSourceSha
$global:LASTEXITCODE = 0
& (Join-Path $SourceRoot 'scripts\update-shared-checkout.ps1') -Mode Plan -SharedRoot $SharedCheckoutRoot
if ($LASTEXITCODE -ne 0) { throw 'Shared checkout preflight failed; no runtime or task changes were attempted.' }
New-Item -ItemType Directory -Force -Path $EvidenceDirectory | Out-Null
$before = Assert-Continuity 'before-cutover'

# The daily runner resolves from the stable runtime, so promote it before the
# task is registered. update-desktop-runtime does not stop the desktop worker.
$global:LASTEXITCODE = 0

& (Join-Path $SourceRoot 'scripts\update-desktop-runtime.ps1') -Mode Apply -ConfirmApply -SourceRoot $SourceRoot -RuntimeRoot $RuntimeRoot
if ($LASTEXITCODE -ne 0) { throw 'Amy-code promotion failed; no task consolidation was attempted.' }

# A fresh proof path prevents any stale receipt from a previous release from
# retiring a task during the daily-runner registration phase.
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$proofPath = Join-Path $EvidenceDirectory "desktop-task-proof-$FinalSourceSha-$stamp.json"
$global:LASTEXITCODE = 0

& (Join-Path $SourceRoot 'scripts\desktop-task-consolidation.ps1') -Mode Apply -ConfirmApply -CloudProofPath $proofPath
if ($LASTEXITCODE -ne 0) { throw 'Daily archive runner registration failed; source archive tasks remain enabled.' }
$global:LASTEXITCODE = 0

& (Join-Path $RuntimeRoot 'scripts\life-archive-daily-maintenance.ps1') -Execute
if ($LASTEXITCODE -ne 0) { throw 'Daily archive maintenance did not produce a successful four-step receipt; source archive tasks remain enabled.' }

$proofBlockers = @()
foreach ($candidate in @($config.cloudDuplicateCandidates)) {
    $row = @((Get-ReceiptRows $ReplacementReceiptManifest $FinalSourceSha) | Where-Object { $_.task_name -eq $candidate.taskName })
    if ($row.Count -ne 1 -or -not (Test-Path -LiteralPath $row[0].receipt_path -PathType Leaf) -or $row[0].producer_source_sha -notmatch '^[a-fA-F0-9]{40}$') { continue }
    if ($candidate.replacement.kind -eq 'unverified-owner') {
        $proofBlockers += [pscustomobject]@{ task_name = $candidate.taskName; reason = 'replacement-owner-unverified' }
        continue
    }
    $global:LASTEXITCODE = 0
    try {
        & (Join-Path $SourceRoot 'scripts\new-desktop-task-replacement-proof.ps1') `
            -TaskName $candidate.taskName -ReceiptPath $row[0].receipt_path `
            -ReplacementSourceSha $row[0].producer_source_sha -ConfirmReceipt -OutputPath $proofPath
        if ($LASTEXITCODE -ne 0) { throw "replacement-proof-writer-exit-$LASTEXITCODE" }
    } catch {
        $proofBlockers += [pscustomobject]@{ task_name = $candidate.taskName; reason = $_.Exception.Message }
        Write-Warning "Candidate remains enabled: $($candidate.taskName): $($_.Exception.Message)"
    }
}

$global:LASTEXITCODE = 0


& (Join-Path $SourceRoot 'scripts\desktop-task-consolidation.ps1') -Mode Apply -ConfirmApply -FinalizeDailyArchive -CloudProofPath $proofPath
if ($LASTEXITCODE -ne 0) { throw 'Receipt-gated task consolidation failed. Use its reported XML backup directory for rollback.' }

# Hooks are projected from the landed clean worktree. The guarded shared-checkout
# updater follows, preserving only path-proven disjoint runtime dirt.
$gitBash = Join-Path $env:ProgramFiles 'Git\bin\bash.exe'
if (-not (Test-Path -LiteralPath $gitBash -PathType Leaf)) { throw "Git for Windows Bash is missing: $gitBash" }
& $gitBash (Join-Path $SourceRoot 'scripts/install-git-hooks.sh')
if ($LASTEXITCODE -ne 0) { throw 'Git hook projection failed after task consolidation; inspect the hook installer output.' }
$global:LASTEXITCODE = 0

& (Join-Path $SourceRoot 'scripts\update-shared-checkout.ps1') -Mode Apply -ConfirmApply -SharedRoot $SharedCheckoutRoot
if ($LASTEXITCODE -ne 0) { throw 'Shared checkout fast-forward was refused; tasks and runtime were not rolled back automatically.' }
& node (Join-Path $SourceRoot 'scripts\project-global-adapters.js')
if ($LASTEXITCODE -ne 0) { throw 'Global Claude/Codex adapter and reviewed hooks projection failed after shared checkout promotion.' }
$after = Assert-Continuity 'after-cutover'
$receipt = [pscustomobject]@{
    schema = 'amy.desktop_overhaul_cutover_receipt.v1'
    completed_at = (Get-Date).ToUniversalTime().ToString('o')
    final_source_sha = $FinalSourceSha
    proof_path = $proofPath
    proof_blockers = $proofBlockers
    before_continuity = $before
    after_continuity = $after
    desktop_worker_restarted = $false
    session_cloud_runtime_touched = $false
}
$receiptPath = Join-Path $EvidenceDirectory "cutover-$FinalSourceSha-$stamp.json"
$receipt | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $receiptPath -Encoding utf8
[pscustomobject]@{ ok = $true; receipt_path = $receiptPath; proof_path = $proofPath; receipt = $receipt } | ConvertTo-Json -Depth 12

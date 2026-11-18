[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$TaskName,
    [Parameter(Mandatory = $true)][string]$ReceiptPath,
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-fA-F0-9]{40}$')][string]$ReplacementSourceSha,
    [switch]$ConfirmReceipt,
    [string]$OutputPath = (Join-Path $env:APPDATA 'secondbrain\data\agent\desktop-task-consolidation\cloud-proof.json')
)

# This records an operator-reviewed cloud/night-owner receipt. It neither reads
# EC2 nor changes Task Scheduler; desktop-task-consolidation remains the only
# consumer and still snapshots XML before any approved apply.
$ErrorActionPreference = 'Stop'
if (-not $ConfirmReceipt) { throw 'Proof creation requires -ConfirmReceipt after reviewing the actual replacement receipt.' }
if (-not (Test-Path -LiteralPath $ReceiptPath -PathType Leaf)) { throw "Replacement receipt does not exist: $ReceiptPath" }

function Get-ReceiptSha256([string]$Path) {
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
    try { $receipt = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json } catch { throw "Replacement receipt must be readable JSON with producer source evidence: $Path" }
    if ($receipt.ok -ne $true) { throw "Replacement receipt is not a successful producer receipt: $Path" }
    if ($receipt.source_sha -notmatch '^[a-fA-F0-9]{40}$') { throw "Replacement receipt is missing a valid producer source_sha: $Path" }
    if ($receipt.replacement_id -ne $Replacement.id -or $receipt.activity -ne $Replacement.activity -or $receipt.receipt_kind -ne $Replacement.receiptKind) {
        throw "Replacement receipt identity does not match the configured replacement: $Path"
    }
    if ($receipt.schema -eq 'amy.cloud_scheduled_fleet_observation.v1') {
        $observed = $receipt.observed
        if (-not $observed -or $observed.raw_row_sha256 -notmatch '^[a-fA-F0-9]{64}$' -or -not $observed.graph_receipt_id -or $observed.skill -ne $Replacement.activity -or $observed.source_file_sha256 -notmatch '^[a-fA-F0-9]{64}$' -or $observed.release_source_sha -ne $receipt.source_sha) {
            throw "Cloud fleet observation is missing bound raw-row, graph, source-file, or release evidence: $Path"
        }
    } elseif ($receipt.schema -eq 'amy.retired_owner_observation.v1') {
        $observed = $receipt.observed
        if ($Replacement.kind -ne 'retired-owner' -or -not $observed -or $observed.policy_sha256 -notmatch '^[a-fA-F0-9]{64}$' -or $observed.policy_state -ne 'disabled' -or $observed.ingestion_state -ne 'disabled' -or @($observed.machine_checks).Count -lt 3) {
            throw "Retired-owner observation is missing disabled policy or machine absence evidence: $Path"
        }
        foreach ($check in @($observed.machine_checks)) {
            if ($check.ok -ne $true -or $check.output_sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw "Retired-owner machine observation is not a hashed successful check: $Path" }
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
    try {
        $completedAt = [DateTimeOffset]::Parse($completedAt).ToUniversalTime()
    } catch { throw "Replacement receipt is missing a valid completion timestamp: $Path" }
    $ageHours = ([DateTimeOffset]::UtcNow - $completedAt).TotalHours
    if ($ageHours -lt -0.1 -or $ageHours -gt (Get-MaxReceiptAgeHours $Replacement)) { throw "Replacement receipt is stale or implausibly future-dated: $Path" }
    return [pscustomobject]@{ source_sha = $receipt.source_sha.ToLowerInvariant(); completed_at = $completedAt.ToString('o') }
}

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$plan = Get-Content -LiteralPath (Join-Path $repo 'config\desktop-task-consolidation-plan.json') -Raw | ConvertFrom-Json
$candidate = @($plan.cloudDuplicateCandidates | Where-Object { $_.taskName -eq $TaskName })
if ($candidate.Count -ne 1) { throw "Task is not a receipt-gated consolidation candidate: $TaskName" }
$replacement = $candidate[0].replacement
if ($replacement.kind -eq 'unverified-owner') { throw "Task replacement owner remains unverified and cannot receive a retirement proof: $TaskName" }
$hash = Get-ReceiptSha256 $ReceiptPath
$producerEvidence = Get-ReceiptProducerEvidence $ReceiptPath $replacement
if ($producerEvidence.source_sha -ne $ReplacementSourceSha.ToLowerInvariant()) {
    throw "ReplacementSourceSha does not match the producer source_sha in the reviewed receipt: $ReceiptPath"
}
$proof = [pscustomobject]@{
    task_name = $TaskName; replacement_id = $replacement.id; replacement_kind = $replacement.kind
    activity = $replacement.activity; receipt_kind = $replacement.receiptKind
    receipt_path = (Resolve-Path -LiteralPath $ReceiptPath).Path; receipt_sha256 = $hash
    # source_sha is the verified producing checkout, never the planner's HEAD.
    source_sha = $producerEvidence.source_sha; receipt_completed_at = $producerEvidence.completed_at
    verified_at = (Get-Date).ToUniversalTime().ToString('o'); verified = $true
}
if (Test-Path -LiteralPath $OutputPath) {
    $document = Get-Content -LiteralPath $OutputPath -Raw | ConvertFrom-Json
    if ($document.schema -ne $plan.replacementProofSchema -or -not $document.proofs) { throw "Existing proof document has an incompatible schema: $OutputPath" }
} else {
    $document = [pscustomobject]@{ schema = $plan.replacementProofSchema; proofs = @() }
}
$document.proofs = @($document.proofs | Where-Object { $_.task_name -ne $TaskName }) + @($proof)
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null
$temporary = "$OutputPath.$PID.tmp"
$document | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporary -Encoding UTF8
Move-Item -LiteralPath $temporary -Destination $OutputPath -Force
[pscustomobject]@{ ok = $true; proof_path = $OutputPath; proof = $proof } | ConvertTo-Json -Depth 8

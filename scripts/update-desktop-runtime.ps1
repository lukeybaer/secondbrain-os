[CmdletBinding()]
param(
    [ValidateSet('Plan', 'Apply')]
    [string]$Mode = 'Plan',
    [switch]$ConfirmApply,
    [switch]$RestartDesktopCapabilityWorker,
    [switch]$SessionCloudRuntime,
    [string]$SourceRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$RuntimeRoot = (Join-Path $env:USERPROFILE 'sb-runtime\amy-code'),
    [string]$ReceiptDirectory = (Join-Path $env:APPDATA 'secondbrain\data\agent\desktop-runtime-update')
)

# The old background reconciler was a second writer over the developer checkout.
# This is its narrow replacement: an attended, one-SHA checkout update of the
# stable runtime. Session-cloud promotion requires its explicit switch; archive data and a
# running process. The desktop worker has an explicit opt-in restart because it
# is installed in its own relay runtime and may safely finish its current claim.

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\windows-checkout-processes.ps1')

function Invoke-GitText([string]$Root, [string[]]$Arguments) {
    # Windows PowerShell 5.1 wraps native stderr lines (fetch's "From ...",
    # checkout's "Previous HEAD position") as ErrorRecords, and the script-wide
    # 'Stop' preference turned those into throws after git had succeeded. Judge
    # git by its exit code alone.
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $value = & git -C $Root @Arguments 2>&1 | ForEach-Object { "$_" }
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($exitCode -ne 0) { throw "git -C $Root $($Arguments -join ' ') failed: $value" }
    return ($value | Out-String).Trim()
}

function Assert-CleanSource([string]$Root) {
    $status = Invoke-GitText $Root @('status', '--porcelain')
    if ($status) { throw "Source checkout has uncommitted changes; attended runtime promotion requires an exact committed SHA: $Root" }
}

function Assert-RuntimeState([string]$Root) {
    if (-not (Test-Path -LiteralPath (Join-Path $Root '.git'))) { throw "Runtime root is not a Git checkout: $Root" }
    $status = Invoke-GitText $Root @('status', '--porcelain')
    $unexpected = @($status -split "`r?`n" | Where-Object {
        $_ -and $_ -notmatch '^[?][?] (data/|node_modules(?:/|\.|$))'
    })
    if ($unexpected) {
        throw "Runtime checkout has tracked or unknown code changes; preserve them outside the runtime before promotion: $($unexpected -join '; ')"
    }
}

function Write-Receipt($Receipt) {
    New-Item -ItemType Directory -Force -Path $ReceiptDirectory | Out-Null
    $file = Join-Path $ReceiptDirectory 'latest.json'
    $temp = "$file.$PID.tmp"
    $Receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temp -Encoding UTF8
    Move-Item -LiteralPath $temp -Destination $file -Force
    return $file
}

$SourceRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
$RuntimeRoot = (Resolve-Path -LiteralPath $RuntimeRoot).Path
$canonicalSessionRoot = Join-Path $env:USERPROFILE 'sb-runtime\session-cloud-code'
$runtimeReal = & node -e "process.stdout.write(require('fs').realpathSync(process.argv[1]))" $RuntimeRoot
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve runtime real path.' }
$sessionReal = & node -e "const f=require('fs'),p=process.argv[1];process.stdout.write(f.existsSync(p)?f.realpathSync(p):require('path').resolve(p))" $canonicalSessionRoot
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve session runtime real path.' }
$isSessionCloud = $runtimeReal.TrimEnd('\') -ieq $sessionReal.TrimEnd('\')
if ($isSessionCloud -ne [bool]$SessionCloudRuntime) { throw 'The session-cloud runtime requires -SessionCloudRuntime with its exact canonical RuntimeRoot.' }
if ($isSessionCloud -and $RestartDesktopCapabilityWorker) { throw 'Session-cloud promotion cannot restart the desktop capability worker.' }
Assert-CleanSource $SourceRoot
Assert-RuntimeState $RuntimeRoot

$sourceSha = Invoke-GitText $SourceRoot @('rev-parse', 'HEAD')
$runtimeBefore = Invoke-GitText $RuntimeRoot @('rev-parse', 'HEAD')
& git -C $SourceRoot merge-base --is-ancestor $sourceSha 'origin/master'
if ($LASTEXITCODE -ne 0) { throw "Source SHA $sourceSha is not landed on origin/master; land it before promoting the desktop runtime." }
$workerPaths = @(
    'scripts/desktop-capability-worker.js',
    'scripts/register-desktop-capability-worker.ps1',
    'scripts/lib/desktop-capability-relay.js',
    'scripts/lib/desktop-capability-http-auth.js'
)
Invoke-GitText $SourceRoot @('cat-file', '-e', "$runtimeBefore^{commit}") | Out-Null
$workerChanged = @((Invoke-GitText $SourceRoot (@('diff', '--name-only', "$runtimeBefore..$sourceSha", '--') + $workerPaths)) -split "`r?`n" | Where-Object { $_ })
$activeRuntimeProcesses = @(Get-ActiveCheckoutProcesses $RuntimeRoot)
$plan = [pscustomobject]@{
    schema = 'amy.desktop_runtime_update_plan.v1'
    mode = $Mode.ToLower()
    source_sha = $sourceSha
    runtime_before_sha = $runtimeBefore
    runtime_root = $RuntimeRoot
    active_runtime_processes = $activeRuntimeProcesses
    action = 'git checkout --detach exact landed SHA in the stable runtime root'
    preserves = @(
        'running processes are not stopped or restarted',
        $(if ($isSessionCloud) { 'amy-code and the desktop capability worker are not touched' } else { 'C:\Users\ExampleCo\sb-runtime\session-cloud-code is not touched' }),
        'runtime data/ and node_modules remain unmodified',
        'Windows task registrations remain unmodified'
    )
    desktop_worker_restart = if ($workerChanged) { 'required only if the attended operator explicitly passes -RestartDesktopCapabilityWorker' } else { 'not required by this source delta' }
    worker_changed_paths = @($workerChanged)
}

if ($Mode -eq 'Plan') {
    $plan | ConvertTo-Json -Depth 8
    exit 0
}

if (-not $ConfirmApply) { throw 'Apply requires -ConfirmApply. Run Plan first and review the exact SHA and preserved runtime surfaces.' }

# Fetch only the canonical branch, then prove the planned SHA exists locally
# before touching the stable checkout. This is an attended code update, not a
# deploy, service restart, relay provisioning, or session-plane action.
try { Invoke-GitText $RuntimeRoot @('fetch', 'origin', 'master') | Out-Null }
catch { throw "Runtime fetch of origin/master failed; stable runtime was not changed. $($_.Exception.Message)" }
Invoke-GitText $RuntimeRoot @('cat-file', '-e', "$sourceSha^{commit}") | Out-Null
Assert-RuntimeState $RuntimeRoot
$activeRuntimeProcesses = @(Get-ActiveCheckoutProcesses $RuntimeRoot)
if ($activeRuntimeProcesses.Count -gt 0) { throw "Runtime promotion waits for processes using its mutable source files: $($activeRuntimeProcesses.pid -join ', '). No process was stopped." }
Invoke-GitText $RuntimeRoot @('checkout', '--detach', $sourceSha) | Out-Null
$runtimeAfter = Invoke-GitText $RuntimeRoot @('rev-parse', 'HEAD')
if ($runtimeAfter -ne $sourceSha) { throw "Runtime checkout did not reach planned SHA $sourceSha (at $runtimeAfter)." }

$workerRestarted = $false
if ($RestartDesktopCapabilityWorker) {
    $global:LASTEXITCODE = 0
    & (Join-Path $RuntimeRoot 'scripts\register-desktop-capability-worker.ps1') -RepoRoot $RuntimeRoot
    if ($LASTEXITCODE -ne 0) { throw 'Runtime code updated, but the explicitly requested desktop worker restart failed.' }
    $workerRestarted = $true
}

$receipt = [pscustomobject]@{
    schema = 'amy.desktop_runtime_update_receipt.v1'
    updated_at = (Get-Date).ToUniversalTime().ToString('o')
    source_sha = $sourceSha
    runtime_before_sha = $runtimeBefore
    runtime_after_sha = $runtimeAfter
    runtime_root = $RuntimeRoot
    active_runtime_processes_before_promotion = $activeRuntimeProcesses
    desktop_worker_restarted = $workerRestarted
    session_cloud_runtime_touched = $isSessionCloud
    task_registration_touched = $false
}
$receiptPath = Write-Receipt $receipt
[pscustomobject]@{ ok = $true; receipt_path = $receiptPath; receipt = $receipt } | ConvertTo-Json -Depth 8

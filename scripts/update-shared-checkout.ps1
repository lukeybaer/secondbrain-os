[CmdletBinding()]
param(
    [ValidateSet('Plan', 'Apply')]
    [string]$Mode = 'Plan',
    [switch]$ConfirmApply,
    [string]$SharedRoot = 'C:\Users\ExampleCo\secondbrain',
    [string]$ReceiptDirectory = (Join-Path $env:APPDATA 'secondbrain\data\agent\shared-checkout-update')
)

# There is deliberately no scheduler or reconciler for the user-facing shared
# checkout. This attended operation only fast-forwards master. It can preserve
# unrelated runtime dirt only after a fresh Git proof shows that the incoming
# paths cannot touch it; it never repairs, stashes, cleans, switches, or stops.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\windows-checkout-processes.ps1')

function Invoke-GitText([string]$Root, [string[]]$Arguments) {
    $value = & git -C $Root @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) {
        $detail = & git -C $Root @Arguments 2>&1
        throw "git -C $Root $($Arguments -join ' ') failed: $detail"
    }
    return ($value | Out-String).Trim()
}

function Get-GitPaths([string]$Root, [string[]]$Arguments) {
    # Runtime receipts can contain LF on a Windows checkout. Suppress Git's
    # line-ending advisory so it cannot turn a successful inspection into a
    # PowerShell terminating NativeCommandError.
    $value = & git -c core.safecrlf=false -C $Root @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) {
        $detail = & git -c core.safecrlf=false -C $Root @Arguments 2>&1
        throw "git -C $Root $($Arguments -join ' ') failed: $detail"
    }
    return @((($value | Out-String) -split [char]0) | Where-Object { $_ })
}

function Get-ActiveSharedProcesses([string]$Root) {
    return @(Get-ActiveCheckoutProcesses $Root)
}

function Get-CheckoutState([string]$Root) {
    $branch = Invoke-GitText $Root @('rev-parse', '--abbrev-ref', 'HEAD')
    $head = Invoke-GitText $Root @('rev-parse', 'HEAD')
    $upstream = Invoke-GitText $Root @('rev-parse', 'origin/master')
    $counts = (Invoke-GitText $Root @('rev-list', '--left-right', '--count', 'HEAD...origin/master')) -split '\s+'
    [pscustomobject]@{
        branch = $branch; head = $head; origin_master = $upstream
        ahead = [int]$counts[0]; behind = [int]$counts[1]
    }
}

function Get-PathSafety([string]$Root) {
    $policy = Join-Path $PSScriptRoot 'lib\shared-checkout-update-policy.js'
    if (-not (Test-Path -LiteralPath $policy -PathType Leaf)) { throw "Shared checkout path policy is missing: $policy" }
    $pathSafetyInput = [pscustomobject]@{
        remoteChangedPaths = Get-GitPaths $Root @('diff', '--name-only', '-z', 'HEAD..origin/master')
        dirtyTrackedPaths = Get-GitPaths $Root @('diff', '--name-only', '-z', 'HEAD')
        untrackedPaths = Get-GitPaths $Root @('ls-files', '--others', '--exclude-standard', '-z')
    }
    $output = $pathSafetyInput | ConvertTo-Json -Depth 4 -Compress | & node $policy
    if ($LASTEXITCODE -ne 0) { throw 'Shared checkout path policy failed; no update was attempted.' }
    return ($output | Out-String | ConvertFrom-Json)
}

function Assert-EligibleState($State, [object[]]$ActiveProcesses) {
    if ($State.branch -ne 'master') { throw "Shared checkout is on $($State.branch), not master." }
    if ($State.ahead -gt 0 -and $State.behind -gt 0) { throw 'Shared checkout diverged from origin/master.' }
    if ($State.ahead -gt 0) { throw 'Shared checkout is ahead of origin/master; land or explicitly resolve its commits first.' }
    if ($ActiveProcesses.Count -gt 0) { throw "Shared checkout has active process(es): $($ActiveProcesses.pid -join ', '). Wait for terminal closure; this updater never stops them." }
}

function Assert-CleanMergeTree([string]$Root) {
    $value = & git -C $Root merge-tree --write-tree HEAD origin/master 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Shared checkout merge-tree is not clean; no update was attempted: $value" }
}

function Assert-PathSafety($Safety) {
    if (-not $Safety.safe) {
        $tracked = @($Safety.tracked_collisions | ForEach-Object { "$($_.remote_path) <-> $($_.local_path)" })
        $untracked = @($Safety.untracked_collisions | ForEach-Object { "$($_.remote_path) <-> $($_.local_path)" })
        throw "Incoming origin/master paths collide with local runtime dirt. Tracked: $($tracked -join '; '). Untracked: $($untracked -join '; '). Preserve or resolve it outside this updater."
    }
}

function Write-Receipt($Receipt) {
    New-Item -ItemType Directory -Force -Path $ReceiptDirectory | Out-Null
    $file = Join-Path $ReceiptDirectory 'latest.json'
    $temp = "$file.$PID.tmp"
    $Receipt | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $temp -Encoding UTF8
    Move-Item -LiteralPath $temp -Destination $file -Force
    return $file
}

$SharedRoot = (Resolve-Path -LiteralPath $SharedRoot).Path
$state = Get-CheckoutState $SharedRoot
$active = Get-ActiveSharedProcesses $SharedRoot
$plan = [pscustomobject]@{
    schema = 'amy.shared_checkout_update_plan.v2'; mode = $Mode.ToLower(); shared_root = $SharedRoot
    state = $state; active_processes = $active
    action = 'on Apply: fetch origin/master, recheck inactive master state, require a clean merge-tree and noncolliding dirty paths, then git merge --ff-only origin/master'
    preserves = @('no reset, clean, stash, checkout, branch switch, or process termination', 'unrelated dirty paths only when incoming paths are proven disjoint', 'active session and desktop runtimes are not touched')
}
if ($Mode -eq 'Plan') {
    Assert-EligibleState $state $active
    Assert-PathSafety (Get-PathSafety $SharedRoot)
    Assert-CleanMergeTree $SharedRoot
    $plan | ConvertTo-Json -Depth 8
    exit 0
}
if (-not $ConfirmApply) { throw 'Apply requires -ConfirmApply. Run Plan first and review the reported state.' }
Assert-EligibleState $state $active
& git -C $SharedRoot fetch origin master
if ($LASTEXITCODE -ne 0) { throw 'Fetch failed; shared checkout was not changed.' }
$state = Get-CheckoutState $SharedRoot
$active = Get-ActiveSharedProcesses $SharedRoot
Assert-EligibleState $state $active
$safety = Get-PathSafety $SharedRoot
Assert-PathSafety $safety
Assert-CleanMergeTree $SharedRoot
if ($state.behind -gt 0) {
    & git -C $SharedRoot merge --ff-only origin/master
    if ($LASTEXITCODE -ne 0) { throw 'Fast-forward failed; shared checkout requires attended diagnosis.' }
}
$after = Get-CheckoutState $SharedRoot
$receipt = [pscustomobject]@{
    schema = 'amy.shared_checkout_update_receipt.v2'; updated_at = (Get-Date).ToUniversalTime().ToString('o')
    before = $plan.state; after_fetch = $state; after = $after; shared_root = $SharedRoot; path_safety = $safety; process_termination = $false
}
$receiptPath = Write-Receipt $receipt
[pscustomobject]@{ ok = $true; receipt_path = $receiptPath; receipt = $receipt } | ConvertTo-Json -Depth 10

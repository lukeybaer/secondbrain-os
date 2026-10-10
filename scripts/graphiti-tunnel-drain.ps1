[CmdletBinding()]
param(
    [switch]$Apply,
    [ValidateRange(1, 25)][int]$BatchSize = 25,
    [ValidateRange(1, 20)][int]$MaxMinutes = 20,
    [int]$LocalPort = 8000,
    [int]$RemotePort = 8000,
    [string]$SshTarget = 'ec2-user@ExampleCo',
    [string]$PolicyPath
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($PolicyPath)) {
    $PolicyPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'config\graphiti-runtime-policy.json'
}
$startedAt = Get-Date
$excludedPids = @{}
$receipt = [ordered]@{
    schema = 'secondbrain.graphiti-tunnel-drain.v1'
    status = 'ok'
    mode = if ($Apply) { 'apply' } else { 'dry-run' }
    policy_state = $null
    matched = 0
    killed = 0
    remaining = 0
    batch_size = $BatchSize
    control_checks = 0
    reason = $null
}

function Write-ReceiptAndExit([int]$Code, [string]$Reason = $null) {
    if ($Reason) {
        $script:receipt.reason = $Reason
        if ($Code -ne 0) { $script:receipt.status = 'red' }
    }
    $script:receipt.elapsed_seconds = [math]::Round(((Get-Date) - $script:startedAt).TotalSeconds, 3)
    [Console]::Out.WriteLine(($script:receipt | ConvertTo-Json -Compress))
    exit $Code
}

function Test-ExactGraphitiTunnel([object]$ProcessRow) {
    if ($null -eq $ProcessRow -or $ProcessRow.Name -ine 'ssh.exe') { return $false }
    if ($script:excludedPids.ContainsKey([string]$ProcessRow.ProcessId)) { return $false }
    $commandLine = [string]$ProcessRow.CommandLine
    if ([string]::IsNullOrWhiteSpace($commandLine)) { return $false }
    $forward = "127.0.0.1:$LocalPort`:localhost:$RemotePort"
    $hasNoCommand = $commandLine -match '(?i)(?:^|\s)-N(?:\s|$)'
    $hasForward = $commandLine -match ("(?i)(?:^|\s)-L\s*" + [regex]::Escape($forward) + '(?:\s|$)')
    $hasTarget = $commandLine -match ("(?i)(?:^|\s)" + [regex]::Escape($SshTarget) + '(?:\s|$)')
    return $hasNoCommand -and $hasForward -and $hasTarget
}

function Get-ExactGraphitiTunnels {
    return @(
        Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" -ErrorAction Stop |
            Where-Object { Test-ExactGraphitiTunnel $_ } |
            Sort-Object ProcessId
    )
}

function Resolve-SshKey {
    $candidates = @(
        $env:GRAPHITI_SSH_KEY,
        $env:SECONDBRAIN_SSH_KEY,
        $env:EC2_SSH_KEY,
        $env:SB_KEY,
        (Join-Path $env:USERPROFILE '.ssh\secondbrain-backend-key.pem'),
        (Join-Path $env:USERPROFILE '.ssh\sb-key.pem')
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    return $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}

function Test-ControlPlane([string]$KeyPath) {
    $script:receipt.control_checks++
    try {
        $output = & ssh -i $KeyPath -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new $SshTarget 'printf CONTROL_OK' 2>$null
        return $LASTEXITCODE -eq 0 -and (($output -join '') -eq 'CONTROL_OK')
    } catch {
        return $false
    }
}

try {
    $cursorPid = $PID
    for ($depth = 0; $depth -lt 32 -and $cursorPid -gt 0; $depth++) {
        $excludedPids[[string]$cursorPid] = $true
        $cursorRow = Get-CimInstance Win32_Process -Filter "ProcessId=$cursorPid" -ErrorAction SilentlyContinue
        if (-not $cursorRow -or $cursorRow.ParentProcessId -eq $cursorPid) { break }
        $cursorPid = [int]$cursorRow.ParentProcessId
    }

    $policy = Get-Content -LiteralPath $PolicyPath -Raw | ConvertFrom-Json
    $receipt.policy_state = [string]$policy.state
    if ($receipt.policy_state -ne 'disabled') {
        Write-ReceiptAndExit 2 'Graphiti runtime policy is not disabled; drain refused'
    }

    $initial = Get-ExactGraphitiTunnels
    $receipt.matched = $initial.Count
    $receipt.remaining = $initial.Count
    if (-not $Apply) {
        Write-ReceiptAndExit 0
    }
    if ($initial.Count -eq 0) {
        Write-ReceiptAndExit 0
    }

    $sshKey = Resolve-SshKey
    if (-not $sshKey) {
        Write-ReceiptAndExit 2 'Independent SSH control key not found; drain refused'
    }
    if (-not (Test-ControlPlane $sshKey)) {
        Write-ReceiptAndExit 3 'Independent SSH control check failed before drain; no process was stopped'
    }

    while ($true) {
        if (((Get-Date) - $startedAt).TotalMinutes -ge $MaxMinutes) {
            $receipt.remaining = (Get-ExactGraphitiTunnels).Count
            Write-ReceiptAndExit 4 'Drain time ceiling reached before all exact tunnels were removed'
        }

        $current = Get-ExactGraphitiTunnels
        $receipt.remaining = $current.Count
        if ($current.Count -eq 0) { break }
        $batch = @($current | Select-Object -First $BatchSize)

        foreach ($candidate in $batch) {
            $samePid = Get-CimInstance Win32_Process -Filter "ProcessId=$($candidate.ProcessId)" -ErrorAction SilentlyContinue
            if (
                $samePid -and
                $samePid.CreationDate -eq $candidate.CreationDate -and
                (Test-ExactGraphitiTunnel $samePid)
            ) {
                try {
                    Stop-Process -Id $candidate.ProcessId -Force -ErrorAction Stop
                    $receipt.killed++
                } catch {
                    $survivor = Get-CimInstance Win32_Process -Filter "ProcessId=$($candidate.ProcessId)" -ErrorAction SilentlyContinue
                    if ($survivor -and (Test-ExactGraphitiTunnel $survivor)) { throw }
                }
            }
        }

        if (-not (Test-ControlPlane $sshKey)) {
            $receipt.remaining = (Get-ExactGraphitiTunnels).Count
            Write-ReceiptAndExit 3 'Independent SSH control check failed during drain; stopped before the next batch'
        }
    }

    $receipt.remaining = (Get-ExactGraphitiTunnels).Count
    if ($receipt.remaining -ne 0) {
        Write-ReceiptAndExit 5 'Exact Graphiti tunnel processes remain after drain'
    }
    Write-ReceiptAndExit 0
} catch {
    try { $receipt.remaining = (Get-ExactGraphitiTunnels).Count } catch { }
    Write-ReceiptAndExit 1 "Drain failed safely: $($_.Exception.Message)"
}

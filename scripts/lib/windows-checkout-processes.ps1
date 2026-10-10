# Read-only process guard shared by attended checkout promotions.
function Get-CheckoutCodeCommandLine([object]$Candidate, [string]$NormalizedAlias) {
    $command = ([string]$Candidate.CommandLine).Replace('/', '\')
    if (-not $command -or -not $candidate.ExecutablePath) { return $command }

    # Codex CUA hosts its generic Node kernel in AppData. The checkouts it
    # receives through --working-dir (and as trusted-worker's final argument)
    # are workspace metadata, not a script or executable from that checkout.
    # Accept only this exact runtime shape; all other Node processes, unknown
    # CUA entrypoints, and any remaining checkout reference still block.
    $executable = ([string]$Candidate.ExecutablePath).Replace('/', '\')
    $cuaRuntime = (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\runtimes\cua_node').TrimEnd('\') + '\'
    $isCuaNode = $executable.StartsWith($cuaRuntime, [StringComparison]::OrdinalIgnoreCase) -and $executable.EndsWith('\bin\node.exe', [StringComparison]::OrdinalIgnoreCase)
    $hasCuaBootstrap = $command -match '(?i)(?:^|\s)--eval(?:\s|=)'
    $tempRoot = ([IO.Path]::GetFullPath($env:TEMP)).TrimEnd('\', '/')
    $entrypointKind = $null
    $entrypointValue = $null
    foreach ($kind in @('kernel', 'trusted-worker')) {
        $suffix = '\' + $kind + '.js'
        $entrypointIndex = $command.IndexOf($suffix, [StringComparison]::OrdinalIgnoreCase)
        $tempIndex = $command.IndexOf($tempRoot + '\.tmp', [StringComparison]::OrdinalIgnoreCase)
        if ($entrypointIndex -ge 0 -and $tempIndex -ge 0 -and $tempIndex -lt $entrypointIndex) {
            $pathSegment = $command.Substring($tempIndex, $entrypointIndex - $tempIndex)
            if ($pathSegment -notmatch '[\s"'']') {
                $entrypointKind = $kind
                $entrypointValue = $command.Substring($tempIndex, $entrypointIndex + $suffix.Length - $tempIndex)
                break
            }
        }
    }
    if (-not $isCuaNode -or -not $hasCuaBootstrap -or -not $entrypointValue) { return $command }

    $aliasArgument = '(?:"' + [regex]::Escape($NormalizedAlias) + '"|' + [regex]::Escape($NormalizedAlias) + ')'
    $workingDirectory = '(?i)(?:^|\s)--working-dir\s+' + $aliasArgument + '(?=\s|$)'
    $workingDirectoryMatches = [regex]::Matches($command, $workingDirectory)
    if ($workingDirectoryMatches.Count -gt 1) { return $command }
    if ($workingDirectoryMatches.Count -eq 1) {
        $command = [regex]::Replace($command, $workingDirectory, ' ', 1)
    }

    # trusted-worker receives its workspace as one final positional argument.
    # Remove it only when it is immediately after the known entrypoint and is
    # the final argument, so a checkout path in any other code-bearing option
    # remains visible to the caller.
    if ($entrypointKind -eq 'trusted-worker') {
        $trustedWorkspace = [regex]::Escape($entrypointValue) + '\s+' + $aliasArgument + '\s*$'
        $command = [regex]::Replace($command, $trustedWorkspace, $entrypointValue, 1)
    }
    return $command
}

function Get-ActiveCheckoutProcesses([string]$Root) {
    $aliasScript = @'
const fs=require('fs'),path=require('path');const root=process.argv[2];const real=fs.realpathSync(root);const candidates=[root,real,path.join(process.env.USERPROFILE,'secondbrain'),path.join(process.env.USERPROFILE,'Documents/GitHub/SecondBrain')];console.log(JSON.stringify([...new Set(candidates.filter(p=>{try{return fs.realpathSync(p).toLowerCase()===real.toLowerCase()}catch{return false}}))]));
'@
    $aliasJson = $aliasScript | & node - $Root
    if ($LASTEXITCODE -ne 0) { throw "Cannot resolve checkout aliases for $Root" }
    $aliases = ConvertFrom-Json -InputObject ($aliasJson | Out-String)
    try {
        return @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
            $candidate = $_
            if ($candidate.ProcessId -eq $PID) { return $false }
            # Protected Windows services often hide both fields. They are not
            # script workers; an uninspectable runtime/interpreter is unknown,
            # never evidence that this checkout is unused.
            if (-not $candidate.CommandLine -and -not $candidate.ExecutablePath -and
                $candidate.Name -match '^(node|python[0-9.]*|pythonw|powershell|pwsh|cmd|bash|sh|wscript|cscript|electron|codex|claude)(\.exe)?$') {
                throw "Uninspectable script process $($candidate.ProcessId) ($($candidate.Name)); cannot prove checkout is unused."
            }
            foreach ($alias in $aliases) {
                $normalized = $alias.TrimEnd('\', '/').Replace('/', '\')
                $pattern = [regex]::Escape($normalized) + '(?=[\\\s"'']|$)'
                $command = Get-CheckoutCodeCommandLine $candidate $normalized
                if (($candidate.ExecutablePath -and $candidate.ExecutablePath.StartsWith($normalized + '\', [StringComparison]::OrdinalIgnoreCase)) -or $command.Replace('/', '\') -match $pattern) { return $true }
            }
            return $false
        } | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; name = $_.Name; command_line = $_.CommandLine } })
    } catch { throw "Cannot prove no active process uses checkout ${Root}: $_" }
}

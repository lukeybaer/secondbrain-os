<#
.SYNOPSIS
  Launch multiple Claude Code web sessions in tiled browser windows.
  Supports screenshot paste, rich rendering, and visual monitoring.
.PARAMETER Count
  Number of agent windows (default: 5)
.EXAMPLE
  .\launch-agents.ps1
  .\launch-agents.ps1 -Count 4
#>

param(
    [int]$Count = 5
)

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class WinAPI {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
}
"@

Add-Type -AssemblyName System.Windows.Forms
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea

# Find Chrome or Edge
$browser = $null
$browserArgs = @()
foreach ($candidate in @(
    "C:\Program Files\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
)) {
    if (Test-Path $candidate) { $browser = $candidate; break }
}

if (-not $browser) {
    Write-Host "No Chrome or Edge found." -ForegroundColor Red
    exit 1
}

$browserName = if ($browser -match "chrome") { "Chrome" } else { "Edge" }
Write-Host "Using $browserName to launch $Count Claude Code windows..." -ForegroundColor Cyan

# Grid layout
$rows = [math]::Ceiling([math]::Sqrt($Count))
$cols = [math]::Ceiling($Count / $rows)
$cellW = [math]::Floor($screen.Width / $cols)
$cellH = [math]::Floor($screen.Height / $rows)

$processes = @()
for ($i = 0; $i -lt $Count; $i++) {
    $row = [math]::Floor($i / $cols)
    $col = $i % $cols

    # For the last row with fewer windows, widen them
    $itemsInRow = [math]::Min($cols, $Count - ($row * $cols))
    if ($itemsInRow -lt $cols) {
        $w = [math]::Floor($screen.Width / $itemsInRow)
        $x = $screen.X + ($col * $w)
    } else {
        $w = $cellW
        $x = $screen.X + ($col * $cellW)
    }
    $y = $screen.Y + ($row * $cellH)
    $h = $cellH

    # Each window gets its own user-data-dir so they're independent sessions
    $userDataDir = "$env:TEMP\claude-agent-$($i+1)"

    $args = "--new-window --window-size=$w,$h --window-position=$x,$y --user-data-dir=`"$userDataDir`" --app=https://claude.ai/code"

    $proc = Start-Process -FilePath $browser -ArgumentList $args -PassThru
    $processes += $proc
    Write-Host "  Agent-$($i+1) -> ${w}x${h} @ ${x},${y}" -ForegroundColor Green

    Start-Sleep -Milliseconds 500
}

Write-Host ""
Write-Host "$Count Claude Code windows launched." -ForegroundColor Cyan
Write-Host "Each window is an independent session - paste screenshots, drag files, etc." -ForegroundColor DarkGray

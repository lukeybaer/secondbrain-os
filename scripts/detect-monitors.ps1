Add-Type -AssemblyName System.Windows.Forms
foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
    Write-Host "$($screen.DeviceName) Bounds:$($screen.Bounds.Width)x$($screen.Bounds.Height) WorkArea:$($screen.WorkingArea.Width)x$($screen.WorkingArea.Height) @$($screen.WorkingArea.X),$($screen.WorkingArea.Y) Primary:$($screen.Primary)"
}

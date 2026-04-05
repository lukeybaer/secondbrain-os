' Start Claude Max proxy + SSH tunnel silently (no visible window).
' Placed in Windows Startup folder to auto-run on login.
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c node C:\Users\luked\secondbrain\claude-proxy.js", 0, False
WScript.Sleep 3000
WshShell.Run "cmd /c ssh -N -R 3456:localhost:3456 -i C:\Users\luked\.ssh\secondbrain-backend-key.pem -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes ec2-user@98.80.164.16", 0, False

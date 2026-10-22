@echo off
REM gh-cli-token-sync.bat
REM Refreshes gh CLI's hosts.yml from the git credential helper so Claude
REM Code's "PR status" check never goes stale and pops the pink toast.
REM Silent: routed through silent-node-launcher.vbs by the scheduled task.
REM Logs to logs\gh-cli-token-sync.log.
cd /d "%~dp0\.."
node scripts\gh-cli-token-sync.js >> logs\gh-cli-token-sync.log 2>&1

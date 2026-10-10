@echo off
REM SecondBrain Overnight Watcher -- runs via Windows Task Scheduler at 22:45 CT.
REM Launches the overnight briefing watcher session loop (Claude CLI primary,
REM Codex CLI automatic fallback through scripts/lib/heal-executor.js) so the
REM babysitter never needs a manual kickoff. Single instance per briefing
REM night with stale-PID reclaim; relaunches a dead session up to 5 times;
REM writes data/agent/watcher-heartbeat.json every 60s and syncs it to EC2.
REM See scripts/overnight-watcher-launcher.js and
REM scripts/BRIEFING_BABYSITTER_SKILL.md. ExampleCo approval 2026-08-02.

set LOGFILE=%APPDATA%\secondbrain\backups\overnight-watcher.log
echo. >> "%LOGFILE%"
echo ============================== >> "%LOGFILE%"
echo %date% %time% - Starting overnight-watcher >> "%LOGFILE%"
echo ============================== >> "%LOGFILE%"

REM This bat is registered from the canonical runtime release. Pin the repo to
REM its own parent so a stale machine-level SECONDBRAIN_ROOT cannot redirect the
REM scheduled watcher into a developer checkout.
cd /d "%~dp0.."
REM Normalize scripts\.. before exporting it. new-session.sh derives its
REM sibling sb-sessions root with dirname, so leaving the .. literal would
REM point at scripts\sb-sessions and miss an existing nightly worktree.
set "SECONDBRAIN_ROOT=%CD%"
set "SECONDBRAIN_BRIEFING_CODEX_CEILING=gpt-5.6-sol:medium"

REM Task Scheduler's reduced PATH can omit Git Bash, which the isolated
REM worktree launcher requires. Bootstrap the standard installation if needed.
where bash.exe >nul 2>&1
if errorlevel 1 if exist "%ProgramFiles%\Git\bin\bash.exe" set "PATH=%ProgramFiles%\Git\bin;%PATH%"
REM The hidden VBS launcher sets NODE_EXE because Task Scheduler's PATH can
REM omit Node for .bat tasks. Use that stable binary before falling back to PATH.
if not defined NODE_EXE set "NODE_EXE=node"
if exist "%NODE_EXE%" (
  set "WATCHER_NODE=%NODE_EXE%"
) else (
  set "WATCHER_NODE=node"
)
echo Resolved repo root: %CD% >> "%LOGFILE%"
echo Resolved node: %WATCHER_NODE% >> "%LOGFILE%"
"%WATCHER_NODE%" scripts/overnight-watcher-launcher.js >> "%LOGFILE%" 2>&1
set WATCHER_EXIT=%ERRORLEVEL%

echo Exit code: %WATCHER_EXIT% >> "%LOGFILE%"
echo %date% %time% - overnight-watcher finished >> "%LOGFILE%"
REM Codex F4a: propagate the launcher's exit code (exhaustion is failure) so
REM Task Scheduler records the miss instead of a swallowed zero.
exit /b %WATCHER_EXIT%

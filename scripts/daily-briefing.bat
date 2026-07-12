@echo off
REM SecondBrain Daily Briefing -- Task Scheduler starts this early so the dashboard is ready by 5:30 AM CT.
REM Runs manual-briefing-v3.js (the canonical local briefing generator).
REM Writes briefing to Desktop + publishes the dashboard link.
REM
REM Per project_briefing_spec.md: this is the local fallback; EC2 is canonical.
REM Both can run safely -- the briefing is idempotent for the same date.
REM
REM W5 cloud cutover (2026-07-12): this trigger is now GATED. Every run first
REM records a desktop-vs-cloud parity comparison (briefing-parity-run.js), then
REM consults the cutover gate (briefing-cutover-check.js). Once the gate is
REM eligible (3 consecutive proven-parity days, latched), this task becomes a
REM logged no-op: EC2 cron owns 5:30 (proven live 2026-07-12). The task is NOT
REM deleted; the gate file is the switch (data/agent/briefing-cutover-gate.json).

set LOGFILE=%APPDATA%\secondbrain\backups\daily-briefing.log
echo. >> "%LOGFILE%"
echo ============================== >> "%LOGFILE%"
echo %date% %time% - Starting daily-briefing >> "%LOGFILE%"
echo ============================== >> "%LOGFILE%"

cd /d "%USERPROFILE%\secondbrain"

REM W5 Stage 2a: parity ledger accrues every morning this task fires. Never
REM fails the build (the runner exits 0 in wired mode).
node scripts\briefing-parity-run.js >> "%LOGFILE%" 2>&1

REM W5 Stage 2b: cutover gate. Exit 42 = eligible = desktop no-op with a log
REM line. Any other exit (0, or a crash) keeps the desktop build running: the
REM failure mode is redundant work, never a missing morning briefing.
node scripts\briefing-cutover-check.js >> "%LOGFILE%" 2>&1
if %ERRORLEVEL% EQU 42 (
  echo %date% %time% - daily-briefing no-op: cloud cutover gate eligible, EC2 cron owns 5:30 >> "%LOGFILE%"
  exit /b 0
)

REM --publish: the morning briefing publishes the SAME validated artifact it
REM emails, so the dashboard (ExampleCo:3001/briefing) shows today's briefing
REM the moment it is generated, not ~18h later. The publish stays gated inside
REM manual-briefing-v3.js on validationPassed (clean-or-blocked contract), so a
REM blocked briefing is never pushed. Matches daily-briefing/SKILL.md
REM ("publishes the dashboard link"). Fixes the 2026-06-08 stale-dashboard gap.
node scripts\manual-briefing-v3.js --publish >> "%LOGFILE%" 2>&1
set BRIEFING_EXIT=%ERRORLEVEL%

echo Exit code: %BRIEFING_EXIT% >> "%LOGFILE%"
echo %date% %time% - daily-briefing finished >> "%LOGFILE%"
exit /b %BRIEFING_EXIT%

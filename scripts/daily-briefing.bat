@echo off
REM SecondBrain Daily Briefing -- Task Scheduler starts this early so the dashboard is ready by 5:30 AM CT.
REM Runs manual-briefing-v3.js (the canonical local briefing generator).
REM Writes briefing to Desktop + publishes the dashboard link.
REM
REM Per project_briefing_spec.md: this is the local fallback; EC2 is canonical.
REM Both can run safely — the briefing is idempotent for the same date.

set LOGFILE=%APPDATA%\secondbrain\backups\daily-briefing.log
echo. >> "%LOGFILE%"
echo ============================== >> "%LOGFILE%"
echo %date% %time% - Starting daily-briefing >> "%LOGFILE%"
echo ============================== >> "%LOGFILE%"

cd /d "%USERPROFILE%\secondbrain"
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

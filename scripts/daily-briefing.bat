@echo off
REM SecondBrain Daily Briefing — Windows Task Scheduler, 5:30 AM CT daily.
REM Runs manual-briefing-v3.js (the canonical local briefing generator).
REM Writes briefing to Desktop + sends 4 Telegram messages.
REM
REM Per project_briefing_spec.md: this is the local fallback; EC2 is canonical.
REM Both can run safely — the briefing is idempotent for the same date.

set LOGFILE=%APPDATA%\secondbrain\backups\daily-briefing.log
echo. >> "%LOGFILE%"
echo ============================== >> "%LOGFILE%"
echo %date% %time% - Starting daily-briefing >> "%LOGFILE%"
echo ============================== >> "%LOGFILE%"

cd /d "%USERPROFILE%\secondbrain"
call node scripts\manual-briefing-v3.js >> "%LOGFILE%" 2>&1

echo Exit code: %ERRORLEVEL% >> "%LOGFILE%"
echo %date% %time% - daily-briefing finished >> "%LOGFILE%"

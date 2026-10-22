@echo off
REM SecondBrain Graphiti real-time maintenance.
REM Idempotently catches up recent raw source events, drains Graphiti, and refreshes health proof.

set LOGFILE=%APPDATA%\secondbrain\backups\graphiti-realtime-maintenance.log
set LOCKDIR=%APPDATA%\secondbrain\graphiti-realtime-maintenance.lock
mkdir "%LOCKDIR%" 2>nul
if not "%ERRORLEVEL%"=="0" (
  echo %date% %time% - Previous Graphiti realtime maintenance still running >> "%LOGFILE%"
  exit /b 0
)
echo. >> "%LOGFILE%"
echo ============================== >> "%LOGFILE%"
echo %date% %time% - Starting Graphiti realtime maintenance >> "%LOGFILE%"
echo ============================== >> "%LOGFILE%"

cd /d "%USERPROFILE%\secondbrain"
call node scripts/graphiti-provider-health.js >> "%LOGFILE%" 2>&1
call node scripts/graphiti-backfill-last-30-days.js --days 30 >> "%LOGFILE%" 2>&1
call node scripts/graphiti-event-drain.js --max 250 >> "%LOGFILE%" 2>&1
call node scripts/graphiti-lifetime-coverage-health.js >> "%LOGFILE%" 2>&1
call node scripts/graphiti-coverage-health.js --days 30 >> "%LOGFILE%" 2>&1
call node scripts/refresh-graphiti-health-card.js >> "%LOGFILE%" 2>&1

echo Exit code: %ERRORLEVEL% >> "%LOGFILE%"
echo %date% %time% - Graphiti realtime maintenance finished >> "%LOGFILE%"
rmdir "%LOCKDIR%" 2>nul

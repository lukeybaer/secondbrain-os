@echo off
REM SecondBrain Daily Backup — runs via Windows Task Scheduler
REM Logs output to %APPDATA%\secondbrain\backups\backup.log

set LOGFILE=%APPDATA%\secondbrain\backups\backup.log
echo. >> "%LOGFILE%"
echo ============================== >> "%LOGFILE%"
echo %date% %time% — Starting backup >> "%LOGFILE%"
echo ============================== >> "%LOGFILE%"

cd /d "C:\Users\luked\secondbrain"
call npx ts-node scripts/backup-cli.ts >> "%LOGFILE%" 2>&1

echo Exit code: %ERRORLEVEL% >> "%LOGFILE%"
echo %date% %time% — Backup finished >> "%LOGFILE%"

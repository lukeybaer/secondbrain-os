@echo off
REM SecondBrain Health Self-Heal — runs via Windows Task Scheduler at 4:00 AM CT.
REM Probes the same subsystems the morning briefing checks, and for every red
REM item attempts a remediation inline. Logs every action to
REM %APPDATA%\secondbrain\data\agent\health-heal.jsonl.
REM
REM Window: 4:00 AM (after 3 AM backup finishes, before 5:30 AM briefing starts).

set LOGFILE=%APPDATA%\secondbrain\backups\health-self-heal.log
echo. >> "%LOGFILE%"
echo ============================== >> "%LOGFILE%"
echo %date% %time% - Starting health-self-heal >> "%LOGFILE%"
echo ============================== >> "%LOGFILE%"

cd /d "C:\Users\luked\secondbrain"
call node scripts/health-self-heal.js >> "%LOGFILE%" 2>&1

echo Exit code: %ERRORLEVEL% >> "%LOGFILE%"
echo %date% %time% - health-self-heal finished >> "%LOGFILE%"

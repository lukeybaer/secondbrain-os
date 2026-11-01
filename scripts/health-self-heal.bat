@echo off
REM SecondBrain Health Self-Heal -- runs via Windows Task Scheduler at 3:00 AM CT.
REM Probes all subsystems, attempts remediation for red items, logs to
REM %APPDATA%\secondbrain\data\agent\health-heal.jsonl.
REM
REM Window: 3:00 AM (after 2:45 AM diagnostic, 2.5h before 5:30 AM briefing).

set LOGFILE=%APPDATA%\secondbrain\backups\health-self-heal.log
echo. >> "%LOGFILE%"
echo ============================== >> "%LOGFILE%"
echo %date% %time% - Starting health-self-heal >> "%LOGFILE%"
echo ============================== >> "%LOGFILE%"

cd /d "%USERPROFILE%\secondbrain"
call node scripts/health-self-heal.js >> "%LOGFILE%" 2>&1

echo Exit code: %ERRORLEVEL% >> "%LOGFILE%"
echo %date% %time% - health-self-heal finished >> "%LOGFILE%"

@echo off
REM SecondBrain Pre-Briefing Diagnostic -- runs at 2:45 AM CT.
REM Probes all subsystems and produces a structured JSON diagnostic
REM that health-self-heal.js reads at 3:00 AM to plan its heal pass.

set LOGFILE=%APPDATA%\secondbrain\backups\pre-briefing-diagnostic.log
echo. >> "%LOGFILE%"
echo ============================== >> "%LOGFILE%"
echo %date% %time% - Starting pre-briefing diagnostic >> "%LOGFILE%"
echo ============================== >> "%LOGFILE%"

cd /d "%USERPROFILE%\secondbrain"
call node scripts/pre-briefing-diagnostic.js >> "%LOGFILE%" 2>&1

echo Exit code: %ERRORLEVEL% >> "%LOGFILE%"
echo %date% %time% - pre-briefing-diagnostic finished >> "%LOGFILE%"

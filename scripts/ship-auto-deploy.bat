@echo off
setlocal
set "LOGDIR=%APPDATA%\secondbrain\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
set "LOGFILE=%LOGDIR%\ship-auto-deploy.log"
cd /d "%USERPROFILE%\Documents\GitHub\sb-sessions\auto-deploy" || exit /b 1
echo %date% %time% - desktop catch-up starting >> "%LOGFILE%"
if not defined NODE_EXE set "NODE_EXE=node.exe"
"%NODE_EXE%" "%USERPROFILE%\sb-runtime\amy-code\scripts\ship.js" auto >> "%LOGFILE%" 2>&1
set "JOB_RC=%ERRORLEVEL%"
echo %date% %time% - desktop catch-up exited %JOB_RC% >> "%LOGFILE%"
exit /b %JOB_RC%

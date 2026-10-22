@echo off
setlocal
set "SECOND_BRAIN_RELAY_ROOT=%~dp0\.."
set "SECOND_BRAIN_RELAY_LOG_DIR=%APPDATA%\secondbrain\logs"
if not exist "%SECOND_BRAIN_RELAY_LOG_DIR%" mkdir "%SECOND_BRAIN_RELAY_LOG_DIR%"
if "%NODE_EXE%"=="" set "NODE_EXE=node"
cd /d "%SECOND_BRAIN_RELAY_ROOT%"
"%NODE_EXE%" scripts\voice-git-people-sync.js --exact-poll >> "%SECOND_BRAIN_RELAY_LOG_DIR%\voice-git-people-sync.log" 2>&1
exit /b %ERRORLEVEL%

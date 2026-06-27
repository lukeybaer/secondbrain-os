@echo off
setlocal

set "REPO_ROOT=%USERPROFILE%\secondbrain"
set "AGENT_DIR=%APPDATA%\secondbrain\data\agent"
set "LOG_DIR=%APPDATA%\secondbrain\data\logs"
set "NODE_EXE=C:\Users\ExampleCod\Desktop\ExampleCo\Dev\Node\node.exe"

if not exist "%NODE_EXE%" set "NODE_EXE=node"
if not exist "%AGENT_DIR%" mkdir "%AGENT_DIR%"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

cd /d "%AGENT_DIR%"
"%NODE_EXE%" "%REPO_ROOT%\scripts\export-codex-thread-index.js" --sync-ec2 > "%LOG_DIR%\codex-thread-index-sync.log" 2>&1
exit /b %ERRORLEVEL%

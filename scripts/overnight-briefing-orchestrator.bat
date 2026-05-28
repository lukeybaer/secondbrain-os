@echo off
setlocal
cd /d "%~dp0.."
set BRIEFING_MODE=overnight
node scripts\overnight-briefing-orchestrator.js --mode overnight
set ORCH_EXIT=%ERRORLEVEL%
exit /b %ORCH_EXIT%

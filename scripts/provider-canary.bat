@echo off
REM Daily LLM provider canaries (P4, 2026-06-11 ladder plan): probes each rung
REM (claude sub, codex sub, OpenAI key floor), appends to
REM data/agent/amy-provider-health.jsonl; the 2:45am diagnostic reads the
REM latest row via probeProviderCanaries.

set LOGFILE=%APPDATA%\secondbrain\backups\provider-canary.log
echo. >> "%LOGFILE%"
echo %date% %time% - provider canaries >> "%LOGFILE%"

cd /d "%USERPROFILE%\secondbrain"
node scripts\lib\provider-canary.js >> "%LOGFILE%" 2>&1
exit /b %ERRORLEVEL%

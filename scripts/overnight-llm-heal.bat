@echo off
REM SecondBrain Overnight LLM Heal -- runs via Windows Task Scheduler at 23:00 CT.
REM
REM Runs AFTER the 22:00 mechanical heal-tests pass (nightly-heal-tests.bat),
REM WELL BEFORE the 05:15 CT briefing-build deadline. Where the mechanical
REM pass only fixes known deterministic categories (BOM, file-size envelope,
REM completeness-guard tracked-runtime, etc.), this LLM pass takes whatever is
REM still red in data/agent/vitest-probe-output.json and drives each failing
REM file through the claude->codex->claude->codex retry ladder until vitest
REM re-runs genuinely green or every path is exhausted.
REM
REM Each healed file is left verified-green in the working tree; this driver
REM does NOT commit. The 23:00 LLM heal and the morning briefing review pick
REM up the verified-green edits. Honest blocked/defect results land in
REM data/agent/heal-tests-by-file-runs.jsonl.
REM
REM Created 2026-06-01: before this task existed, the LLM healers
REM (heal-tests-by-file.js) were orphaned, only the mechanical loop ran
REM overnight.

set LOGFILE=%APPDATA%\secondbrain\backups\overnight-llm-heal.log
echo. >> "%LOGFILE%"
echo ============================== >> "%LOGFILE%"
echo %date% %time% - Starting overnight-llm-heal >> "%LOGFILE%"
echo ============================== >> "%LOGFILE%"

cd /d "%USERPROFILE%\secondbrain"
call node scripts/heal-tests-by-file.js --deadline-ct 05:15 --max-files 8 --max-attempts 4 --concurrency 3 >> "%LOGFILE%" 2>&1

echo Exit code: %ERRORLEVEL% >> "%LOGFILE%"
echo %date% %time% - overnight-llm-heal finished >> "%LOGFILE%"

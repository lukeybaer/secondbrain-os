@echo off
REM SecondBrain Nightly Heal Tests -- runs via Windows Task Scheduler at 22:00 CT.
REM Loops on the test suite (max 8 attempts, 30 min apart) so the briefing's
REM "looping on this until clean" claim is real, not fabricated. See
REM scheduled-tasks/nightly-heal-tests/SKILL.md.
REM
REM Window: 22:00 through the early-morning briefing prep window. Each attempt
REM appends to data/agent/heal-tests-runs.jsonl so the briefing can verify the
REM loop actually ran.
REM
REM Created 2026-05-04 #gap. Before this task existed, the briefing kept
REM saying "Looping on this" while no loop had ever fired between briefings.

set LOGFILE=%APPDATA%\secondbrain\backups\nightly-heal-tests.log
echo. >> "%LOGFILE%"
echo ============================== >> "%LOGFILE%"
echo %date% %time% - Starting nightly-heal-tests >> "%LOGFILE%"
echo ============================== >> "%LOGFILE%"

cd /d "%USERPROFILE%\secondbrain"
set HEAL_TESTS_TIMEOUT_MS=1200000
set HEAL_TESTS_MAX_WORKERS=2
call node scripts/heal-tests.js --loop --max=8 --interval=1800000 >> "%LOGFILE%" 2>&1

echo Exit code: %ERRORLEVEL% >> "%LOGFILE%"
echo %date% %time% - nightly-heal-tests finished >> "%LOGFILE%"

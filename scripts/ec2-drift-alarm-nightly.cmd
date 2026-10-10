@echo off
REM Nightly EC2 git-as-law drift check. Runs scripts/ec2-drift-alarm.js, writes a
REM JSON report the briefing System Health row reads, and a .err for failures.
REM Relative path (no hardcoded home dir) so it stays PII-clean for public sync.
cd /d "%~dp0\.."
node scripts\ec2-drift-alarm.js --json > data\agent\ec2-drift-latest.json 2> data\agent\ec2-drift-latest.err
exit /b %ERRORLEVEL%

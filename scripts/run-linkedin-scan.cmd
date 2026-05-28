@echo off
REM Kick off a detached Claude CLI run of the daily-linkedin-scan SKILL.md.
REM Stores stdout/stderr to %APPDATA%\secondbrain\data\linkedin-scan-run.log.
REM This is the manual-trigger sibling to the cron-driven scheduled task.

set LOG=%APPDATA%\secondbrain\data\linkedin-scan-run.log
echo [%date% %time%] manual linkedin scan launch >> "%LOG%"

node %USERPROFILE%\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\cli.js ^
  --model claude-opus-4-6 ^
  --dangerously-skip-permissions ^
  -p "Execute the daily-linkedin-scan SKILL.md at %USERPROFILE%\.claude\scheduled-tasks\daily-linkedin-scan\SKILL.md. You are Amy. Scan every warm contact with a linkedin: URL in %USERPROFILE%\secondbrain\memory\contacts\. Load contacts by reading each .md file's frontmatter. For each with a linkedin URL: open Chrome via MCP, navigate to recent-activity page, capture public posts from last 7 days, update the contact file's 'What They Post About' section and last_linkedin_scan date, close tab, wait 8-12s. Batch of 10 with 60s inter-batch. Write _linkedin-daily-intel.md with **Batch scanned** listing every contact name comma-separated, total, skipped count, ENGAGEMENT OPPORTUNITIES, JOB CHANGES, PERSONAL NEWS, WARMTH SIGNALS. Then overwrite %USERPROFILE%\AppData\Roaming\secondbrain\data\agent\linkedin-intel.json with totalContactsQueried = N. Commit changes to git. Alert Telegram on CAPTCHA. This is a manual run triggered by Luke during the working session." >> "%LOG%" 2>&1

echo [%date% %time%] manual linkedin scan exited code %ERRORLEVEL% >> "%LOG%"

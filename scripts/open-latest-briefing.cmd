@echo off
REM Opens the most recent daily executive briefing markdown file.
REM Invoked by the "Today's Briefing" desktop shortcut.
REM Falls back to regenerating if today's file does not exist.

setlocal
set BRIEFING_DIR=C:\Users\luked\secondbrain\data\briefings

REM Find the most recent briefing file in the data directory
for /f "delims=" %%f in ('dir /b /o-d "%BRIEFING_DIR%\briefing-*.md" 2^>nul') do (
    start "" "%BRIEFING_DIR%\%%f"
    exit /b 0
)

REM No briefing found — try Desktop as a fallback
for /f "delims=" %%f in ('dir /b /o-d "C:\Users\luked\Desktop\briefing-*.md" 2^>nul') do (
    start "" "C:\Users\luked\Desktop\%%f"
    exit /b 0
)

REM Nothing exists — regenerate and open
echo No briefing found. Regenerating...
cd /d C:\Users\luked\secondbrain
node scripts\manual-briefing-v3.js
for /f "delims=" %%f in ('dir /b /o-d "%BRIEFING_DIR%\briefing-*.md" 2^>nul') do (
    start "" "%BRIEFING_DIR%\%%f"
    exit /b 0
)

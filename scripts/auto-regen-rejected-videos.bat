@echo off
REM SecondBrain Auto-Regen Rejected Videos -- runs every 30 min via Windows
REM Task Scheduler. Picks up every video with video_needs_regen=true or
REM thumbnail_needs_regen=true in content-review/pending/manifest.json and
REM rebuilds locally (Bedrock for thumbs, Pexels+ffmpeg for video). Idempotent:
REM no work to do exits 0.
REM
REM Created 2026-05-05 #gap. Trigger: ExampleCo flagged that the video state model
REM is REJECTED-or-DEFECT, never blocked-on-ExampleCo. The defect for 4 days was
REM that no scheduler triggered the existing auto-regen script after a
REM rejection landed, so the regen queue accumulated without ever draining.
REM Memory: feedback_video_state_rejected_or_defect_never_blocked_on_ExampleCo.md.

set LOGFILE=%APPDATA%\secondbrain\backups\auto-regen-rejected-videos.log
echo. >> "%LOGFILE%"
echo ============================== >> "%LOGFILE%"
echo %date% %time% - Starting auto-regen-rejected-videos >> "%LOGFILE%"
echo ============================== >> "%LOGFILE%"

REM 2026-05-05 #gap fix: scheduled task context strips PATH so the
REM Microsoft Store python.exe alias hijacks `python`, causing exit 9009
REM "Python was not found". Force the real Python locations to the front
REM of PATH so the regen script can find py.exe and python.exe.
REM Also point ffmpeg to the absolute install path so audio extraction
REM does not fail under stripped PATH.
set "PATH=C:\Windows;C:\Windows\System32;C:\Python314;C:\Python314\Scripts;%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg.Shared_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.0-full_build-shared\bin;%USERPROFILE%\Desktop\ExampleCo\Dev\Node;%PATH%"
set "PYTHON_EXE=C:\Python314\python.exe"
set "PY_LAUNCHER=C:\Windows\py.exe"

cd /d "%USERPROFILE%\secondbrain"
call node scripts/auto-regen-rejected-videos.js >> "%LOGFILE%" 2>&1

echo Exit code: %ERRORLEVEL% >> "%LOGFILE%"
echo %date% %time% - auto-regen-rejected-videos finished >> "%LOGFILE%"

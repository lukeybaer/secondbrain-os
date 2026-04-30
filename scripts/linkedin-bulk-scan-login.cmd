@echo off
REM One-time login helper for scripts/linkedin-bulk-scan.js.
REM
REM Double-click this file from Explorer (or run from cmd.exe). A real Chromium
REM window opens - sign into LinkedIn once, close the window, done.
REM
REM The session is stored at:
REM   %APPDATA%\secondbrain\chrome-profile-linkedin\
REM
REM After this, scripts/linkedin-bulk-scan.js can run unattended from cron
REM forever (until LinkedIn expires the session cookie, usually 30-90 days).
REM
REM Why this is a separate .cmd file: Playwright's headful Chromium requires a
REM real Windows console/window station. The bash-under-Claude-Code shell
REM doesn't qualify (spawn UNKNOWN), so the login step must run from a normal
REM cmd.exe session. Scan runs (headless) work fine from any shell.

cd /d %~dp0..

echo.
echo   SecondBrain -- LinkedIn one-time login
echo   ======================================
echo.

REM Verify Playwright resolves to secondbrain\node_modules, not a parent.
REM The 2026-04-11 failure was Node picking up a different Playwright higher
REM up the module tree that was bound to a newer Chromium version.
for /f "delims=" %%i in ('node -e "console.log(require.resolve('playwright/package.json'))"') do set PW_PATH=%%i
echo   Playwright resolved to: %PW_PATH%
echo.

REM If the Chromium browser binary is missing (wrong Playwright version or
REM fresh install), auto-install it before trying to launch.
if not exist "%LOCALAPPDATA%\ms-playwright\chromium-1208\chrome-win64\chrome.exe" (
  echo   Chromium 1208 not installed. Installing now...
  echo.
  call npx playwright install chromium
  if errorlevel 1 (
    echo.
    echo   ERROR: playwright install failed. Try running manually:
    echo     cd %USERPROFILE%\secondbrain
    echo     npx playwright install chromium
    pause
    exit /b 1
  )
  echo.
)

echo   A Chromium window will open. Sign into LinkedIn normally.
echo   The session persists after you close the window.
echo.
pause

node scripts\linkedin-bulk-scan.js --login
set LOGIN_EXIT=%ERRORLEVEL%

echo.
if %LOGIN_EXIT%==0 (
  echo   Login successful. You can close this window.
  echo   Tonight's 3:57 AM scan will use the saved session.
) else (
  echo   Login exited with code %LOGIN_EXIT% -- check the log at
  echo   %%APPDATA%%\secondbrain\data\linkedin-bulk-scan.log
)
echo.
pause

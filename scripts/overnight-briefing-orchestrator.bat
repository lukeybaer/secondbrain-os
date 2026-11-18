@echo off
setlocal

rem Compatibility entrypoint for the existing Windows scheduled task name.
rem The canonical overnight owner is card-controller. Always jump to the
rem deployed runtime so a task registered from a developer checkout cannot
rem run producers against that checkout or its data directory.
set "RUNTIME_ROOT=%USERPROFILE%\sb-runtime\amy-code"
if not exist "%RUNTIME_ROOT%\scripts\card-controller.js" exit /b 2

cd /d "%RUNTIME_ROOT%"
set "SECONDBRAIN_ROOT=%CD%"
set "SECONDBRAIN_DATA_DIR=%CD%\data"
set "BRIEFING_MODE=overnight"

rem Task Scheduler can start with a reduced PATH. Resolve Node from the normal
rem machine install first, then fall back to PATH, and fail visibly if absent.
set "NODE_BIN=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE_BIN%" set "NODE_BIN="
if not defined NODE_BIN for %%N in (node.exe) do set "NODE_BIN=%%~$PATH:N"
if not defined NODE_BIN exit /b 2

set "BRIEFING_DATE="
for /f "delims=" %%D in ('"%NODE_BIN%" scripts\scheduled-briefing-date.js') do set "BRIEFING_DATE=%%D"
if not defined BRIEFING_DATE exit /b 2

"%NODE_BIN%" scripts\card-controller.js --mode overnight --cards all --date "%BRIEFING_DATE%" --data-dir "%SECONDBRAIN_DATA_DIR%" --bootstrap --max-seconds 43200
set "CONTROLLER_EXIT=%ERRORLEVEL%"
exit /b %CONTROLLER_EXIT%

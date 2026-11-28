@echo off
setlocal
chcp 65001 >nul 2>&1
set "ROOT=%~dp0"
set "NODE_RES=%TEMP%\ag_node_%RANDOM%%RANDOM%.txt"

echo === Antigravity API Setup ===
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\bootstrap_node.ps1" -ResultFile "%NODE_RES%"
if errorlevel 1 (
  if exist "%NODE_RES%" del /q "%NODE_RES%" >nul 2>&1
  echo Setup cancelled.
  pause
  exit /b 1
)

set /p NODE_EXE=<"%NODE_RES%"
del /q "%NODE_RES%" >nul 2>&1
cd /d "%ROOT%"

for /f "delims=" %%V in ('"%NODE_EXE%" -v') do set "NODE_VER=%%V"
echo [OK] Node.js %NODE_VER%: %NODE_EXE%
echo.

set /p EXTOK="Extract Antigravity OAuth token into auth.json if present? [Y/n]: "
if /i "%EXTOK%"=="" set "EXTOK=Y"
if /i "%EXTOK%"=="Y" (
  "%NODE_EXE%" "%ROOT%lib\token_extract.js"
  echo.
)

set /p MKSC="Create Desktop and Start Menu shortcuts for Antigravity API? [Y/n]: "
if /i "%MKSC%"=="" set "MKSC=Y"
if /i "%MKSC%"=="Y" (
  "%NODE_EXE%" "%ROOT%scripts\shortcuts.js"
  echo.
)

set /p LAUNCHNOW="Start Antigravity API Control Panel now? [Y/n]: "
if /i "%LAUNCHNOW%"=="" set "LAUNCHNOW=Y"
if /i "%LAUNCHNOW%"=="Y" (
  "%NODE_EXE%" "%ROOT%scripts\launcher.js"
) else (
  echo Done! Use run.bat or your Desktop shortcut anytime.
  pause
)
exit /b 0

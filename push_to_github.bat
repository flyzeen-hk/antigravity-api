@echo off
setlocal
chcp 65001 >nul 2>&1
set "ROOT=%~dp0"
set "NODE_RES=%TEMP%\ag_node_%RANDOM%%RANDOM%.txt"

powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\bootstrap_node.ps1" -ResultFile "%NODE_RES%"
if errorlevel 1 (
  if exist "%NODE_RES%" del /q "%NODE_RES%" >nul 2>&1
  pause
  exit /b 1
)

set /p NODE_EXE=<"%NODE_RES%"
del /q "%NODE_RES%" >nul 2>&1
cd /d "%ROOT%"

echo [1/3] Running privacy and secret leak check...
"%NODE_EXE%" "%ROOT%scripts\verify_privacy.js"
if errorlevel 1 (
  echo.
  echo [ABORT] Privacy check failed! Fix flagged files before pushing.
  pause
  exit /b 1
)

echo.
echo [2/3] Current git status:
git status -s
echo.
set /p CONF="Proceed with staging tracked/ignored-safe files and pushing to remote? [y/N]: "
if /i not "%CONF%"=="Y" (
  echo Cancelled.
  pause
  exit /b 0
)

git add -A
set /p MSG="Commit message (leave empty to push existing commits): "
if not "%MSG%"=="" git commit -m "%MSG%"
git push
pause
exit /b %ERRORLEVEL%

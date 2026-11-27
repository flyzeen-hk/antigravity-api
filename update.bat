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

"%NODE_EXE%" "%ROOT%scripts\update.js" %*
set "RC=%ERRORLEVEL%"
echo.
pause
exit /b %RC%

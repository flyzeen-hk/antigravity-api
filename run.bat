@echo off
setlocal
chcp 65001 >nul 2>&1
set "ROOT=%~dp0"
set "NODE_RES=%TEMP%\ag_node_%RANDOM%%RANDOM%.txt"

powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\bootstrap_node.ps1" -ResultFile "%NODE_RES%"
if errorlevel 1 (
  if exist "%NODE_RES%" del /q "%NODE_RES%" >nul 2>&1
  echo [Antigravity API] Node.js 18+ setup was cancelled or failed.
  pause
  exit /b 1
)

set /p NODE_EXE=<"%NODE_RES%"
del /q "%NODE_RES%" >nul 2>&1

if not exist "%NODE_EXE%" (
  echo [Antigravity API] Resolved Node executable not found: "%NODE_EXE%"
  pause
  exit /b 1
)

cd /d "%ROOT%"
"%NODE_EXE%" "%ROOT%scripts\launcher.js" %*
exit /b %ERRORLEVEL%

@echo off
setlocal enabledelayedexpansion
title Antigravity API - Windows Installer

echo =======================================================
echo          ANTIGRAVITY API - WINDOWS INSTALLER
echo =======================================================
echo.

cd /d "%~dp0"

:: 1. Check Python
echo [1/6] Checking Python installation...
where python >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Python is not found in PATH!
    echo Please install Python 3.10+ from https://www.python.org/downloads/
    echo Make sure to check "Add python.exe to PATH" during installation.
    pause
    exit /b 1
)
python --version

:: 2. Check Node.js
echo.
echo [2/6] Checking Node.js installation...
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not found in PATH!
    echo Node.js 18+ is required to run the Antigravity API server.
    echo Please download and install Node.js from https://nodejs.org/
    pause
    exit /b 1
)
node --version

:: 3. Install Python Dependencies
echo.
echo [3/6] Installing dependencies...
python -m pip install --quiet --upgrade pip
python -m pip install --quiet -r requirements.txt
if %ERRORLEVEL% neq 0 (
    echo [WARNING] Failed to install requirements via pip. UI will run in fallback mode.
) else (
    echo [OK] Dependencies installed successfully.
)

:: 4. Generate Application Icons
echo.
echo [4/6] Generating high-resolution application icons...
python scripts\make_icon.py
if %ERRORLEVEL% neq 0 (
    echo [WARNING] Icon generation had a minor issue, using existing icon.
) else (
    echo [OK] High-resolution icons created.
)

:: 5. Extract IDE OAuth Token
echo.
echo [5/6] Auto-detecting Google Antigravity IDE credentials...
python scripts\extract_token.py
if %ERRORLEVEL% neq 0 (
    echo [WARNING] Could not auto-extract token. If Antigravity IDE is closed, please start it once.
) else (
    echo [OK] Antigravity credentials configured.
)

:: 6. Optional Desktop & Start Menu Shortcuts
echo.
set /p CREATE_SHORTCUTS="Create Desktop and Start Menu shortcuts? (y/N): "
if /i "!CREATE_SHORTCUTS!"=="y" (
    echo Creating shortcuts...
    python scripts\create_shortcut.py
    if %ERRORLEVEL% neq 0 (
        echo [WARNING] Could not create shortcuts automatically.
    ) else (
        echo [OK] Shortcuts installed on Desktop and Start Menu.
    )
) else (
    echo [SKIPPED] Shortcut creation skipped.
)

echo.
echo =======================================================
echo           INSTALLATION COMPLETED SUCCESSFULLY!
echo =======================================================
echo.
echo You can now launch Antigravity API from:
echo   - Desktop shortcut: "Antigravity API"
echo   - Start Menu Programs: "Antigravity API"
echo   - Running "run.bat" in this directory
echo.
set /p LAUNCH="Do you want to launch Antigravity API now? (Y/n): "
if /i "!LAUNCH!"=="n" (
    echo Done.
    exit /b 0
)

start "" "%~dp0assets\antigravity_api.ico" >nul 2>&1
start "" pythonw "%~dp0app.py"
echo Started Antigravity API dashboard.
exit /b 0

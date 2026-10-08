@echo off
setlocal enabledelayedexpansion
title Push Antigravity API to GitHub

echo ========================================================
echo        ANTIGRAVITY API - PUSH TO GITHUB HELPER
echo ========================================================
echo.

cd /d "%~dp0"

:: 1. Run privacy audit first
echo [1/3] Running pre-push privacy audit...
python scripts\verify_privacy.py
if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Privacy check failed! Aborting push to prevent data leaks.
    pause
    exit /b 1
)

echo.
echo [2/3] Checking Git status...
git status
echo.

:: 2. Check or set remote origin
git remote get-url origin >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo Remote 'origin' is not set yet.
    echo Step 1: Go to https://github.com/new and create a new repository (e.g. "antigravity-api").
    echo Step 2: Copy the HTTPS repository URL.
    echo.
    set /p REPO_URL="Enter your GitHub repository URL (e.g. https://github.com/username/antigravity-api.git): "
    if "!REPO_URL!"=="" (
        echo [ERROR] URL cannot be empty.
        pause
        exit /b 1
    )
    git remote add origin !REPO_URL!
    echo [OK] Remote origin added: !REPO_URL!
) else (
    for /f "tokens=*" %%a in ('git remote get-url origin') do set CURRENT_ORIGIN=%%a
    echo Current remote origin: !CURRENT_ORIGIN!
)

:: 3. Push to main
echo.
echo [3/3] Pushing to GitHub (branch: main)...
git push -u origin main

if %ERRORLEVEL% equ 0 (
    echo.
    echo ========================================================
    echo    SUCCESSFULLY PUBLISHED TO GITHUB!
    echo ========================================================
) else (
    echo.
    echo [NOTICE] If Git prompted for authentication, make sure you are signed in
    echo or use a GitHub Personal Access Token (PAT).
)

echo.
pause

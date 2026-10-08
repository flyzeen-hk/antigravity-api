@echo off
chcp 65001 >nul
title Antigravity API Launcher

echo ========================================================
echo        Antigravity API — 1-Click Desktop Launcher
echo ========================================================
echo.

cd /d "%~dp0"

:: Проверка Python
where pythonw >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    start "" pythonw app.py
    echo [OK] Панель управления Antigravity API запущена!
    exit /b 0
)

where python >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    start "" python app.py
    echo [OK] Панель управления Antigravity API запущена!
    exit /b 0
)

echo [ОШИБКА] Python не найден в PATH!
echo Установите Python 3.10+ с галочкой 'Add Python to PATH'.
pause
exit /b 1

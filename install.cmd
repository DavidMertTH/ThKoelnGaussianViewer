@echo off
cd /d "%~dp0"
where npm >nul 2>nul || (
    echo Node.js was not found. Install Node.js 22 or newer from https://nodejs.org and run this again.
    if "%~1"=="" pause
    exit /b 1
)
call npm ci || goto failed
call npm run build || goto failed
if "%~1"=="" pause
exit /b 0

:failed
echo.
echo Installation failed.
if "%~1"=="" pause
exit /b 1

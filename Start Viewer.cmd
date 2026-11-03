@echo off
cd /d "%~dp0"
where node >nul 2>nul || (
    echo Node.js was not found. Install Node.js 22 or newer from https://nodejs.org and try again.
    goto failed
)
rem First start, or an update pulled new code: install and build again.
node check-install.js
if errorlevel 1 (
    call install.cmd quiet || goto failed
)
node server.js --open %*
if errorlevel 1 goto failed
exit /b 0

:failed
echo.
echo The viewer could not be started.
pause

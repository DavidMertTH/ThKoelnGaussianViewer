@echo off
cd /d "%~dp0"
if not exist dist\index.html (
    call install.cmd quiet || goto failed
)
node server.js --open
if errorlevel 1 goto failed
exit /b 0

:failed
echo.
echo The viewer could not be started.
pause

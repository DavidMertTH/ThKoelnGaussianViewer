@echo off
cd /d "%~dp0"

rem Install Node.js if it is missing or older than 22
call :checknode && goto hasnode
echo Node.js 22 or newer was not found. Installing Node.js LTS via winget...
where winget >nul 2>nul || (
    echo winget is not available. Install Node.js 22 or newer from https://nodejs.org and run this again.
    goto failed
)
winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements --silent
rem winget does not update PATH for this window, so add the default install folder
set "PATH=%ProgramFiles%\nodejs;%PATH%"
call :checknode || (
    echo Node.js was installed but could not be found. Close this window and run the setup again.
    goto failed
)

:hasnode
call npm ci || goto failed
call npm run build || goto failed
if "%~1"=="" pause
exit /b 0

:failed
echo.
echo Installation failed.
if "%~1"=="" pause
exit /b 1

:checknode
where npm >nul 2>nul || exit /b 1
node -e "process.exit(+process.versions.node.split('.')[0] >= 22 ? 0 : 1)" >nul 2>nul
exit /b %errorlevel%

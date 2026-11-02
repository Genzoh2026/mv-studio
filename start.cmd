@echo off
rem Usage: start.cmd [workspace-folder] [port]
rem Starts MV Studio and opens it in the browser.
rem Defaults: workspace = ..\workspace (next to this app folder), port = 4200.
setlocal
cd /d "%~dp0"
if not exist node_modules call npm install
set "WORK=%~1"
if "%WORK%"=="" set "WORK=%~dp0..\workspace"
if not "%~2"=="" set "PORT=%~2"
if "%PORT%"=="" set "PORT=4200"
if not exist "%WORK%" mkdir "%WORK%"
rem Open the browser after a short delay so the server is already listening.
start "" /b cmd /c "timeout /t 2 >nul & start http://127.0.0.1:%PORT%"
node server.mjs "%WORK%"
pause

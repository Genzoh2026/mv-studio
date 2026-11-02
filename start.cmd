@echo off
rem Usage: start.cmd [workspace-folder] [port]
rem Starts MV Studio and opens it in the browser.
rem Defaults: workspace = ..\workspace (next to this app folder), port = 4200.
rem The app's "restart" button exits with code 75; this script then starts the server again in this window.
setlocal
cd /d "%~dp0"
if not exist node_modules call npm install
set "WORK=%~1"
if "%WORK%"=="" set "WORK=%~dp0..\workspace"
if not "%~2"=="" set "PORT=%~2"
if "%PORT%"=="" set "PORT=4200"
if not exist "%WORK%" mkdir "%WORK%"

rem Refuse to start when the port is taken: otherwise the browser would open another (older) instance.
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue) { exit 1 }"
if errorlevel 1 (
  echo Port %PORT% is already in use. Another MV Studio may be running.
  echo Close it first, or start on another port:  start.cmd "%WORK%" 4201
  pause
  exit /b 1
)

set "MV_STUDIO_SUPERVISED=1"
rem Open the browser after a short delay so the server is already listening (set MV_STUDIO_NO_BROWSER=1 to skip).
if not defined MV_STUDIO_NO_BROWSER start "" /b cmd /c "timeout /t 2 >nul & start http://127.0.0.1:%PORT%"

:run
node server.mjs "%WORK%"
if %errorlevel% equ 75 (
  echo Restarting...
  goto run
)
pause

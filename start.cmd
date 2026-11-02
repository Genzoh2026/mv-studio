@echo off
rem Usage: start.cmd [workspace-folder] [port]
rem Starts MV Studio and opens it in the browser. Defaults: workspace = ..\workspace, port = 4200.
rem launcher.mjs does the work: it reuses an up-to-date server that is already running, offers to restart an
rem older one, and restarts the server in this window when the app's restart button asks for it.
rem Set MV_STUDIO_NO_BROWSER=1 to skip opening the browser.
setlocal
cd /d "%~dp0"
if not exist node_modules call npm install
node launcher.mjs %*
pause

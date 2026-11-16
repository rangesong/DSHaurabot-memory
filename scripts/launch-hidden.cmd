@echo off
setlocal
set "THINKSTAR_NO_PAUSE=1"
set "THINKSTAR_BACKGROUND=1"
rem The user-started WScript opens the browser after this helper reports readiness.
set "THINKSTAR_OPEN_BROWSER=0"
cd /d "%~dp0.."
if not exist "runtime-data\service" mkdir "runtime-data\service"
if not defined THINKSTAR_LAUNCH_LOG for /f "delims=" %%G in ('%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo -NoProfile -Command "[Guid]::NewGuid().ToString('N')"') do set "THINKSTAR_LAUNCH_LOG=runtime-data\service\startup-%%G.log"
if not defined THINKSTAR_LAUNCH_LOG exit /b 1
type nul > "%THINKSTAR_LAUNCH_LOG%" || exit /b 1
> "runtime-data\service\latest-startup.txt" echo %THINKSTAR_LAUNCH_LOG%
call "%~dp0run-node-task.cmd" "scripts\launch-memory-sea.js" > "%THINKSTAR_LAUNCH_LOG%" 2>&1
exit /b %ERRORLEVEL%

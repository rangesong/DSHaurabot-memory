@echo off
call "%~dp0scripts\run-node-task.cmd" "scripts\build-aurabot-module.js" %*
set "THINKSTAR_BUILD_EXIT=%ERRORLEVEL%"
if /i not "%~1"=="--check" pause
exit /b %THINKSTAR_BUILD_EXIT%

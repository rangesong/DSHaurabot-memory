@echo off
call "%~dp0scripts\run-node-task.cmd" "scripts\launch-memory-sea.js" %*
exit /b %ERRORLEVEL%

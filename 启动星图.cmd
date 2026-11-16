@echo off
if /i "%~1"=="--check" (
  call "%~dp0scripts\run-node-task.cmd" "scripts\launch-memory-sea.js" --check
  exit /b
)
start "" wscript.exe //nologo "%~dp0启动星图.vbs"

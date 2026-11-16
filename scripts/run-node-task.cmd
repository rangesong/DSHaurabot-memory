@echo off
setlocal
cd /d "%~dp0.."
set "THINKSTAR_NODE_EXE="

rem Locate a regular Node installation first, then the installed Codex runtime.
for /f "delims=" %%N in ('where.exe node.exe 2^>nul') do if not defined THINKSTAR_NODE_EXE set "THINKSTAR_NODE_EXE=%%N"
if not defined THINKSTAR_NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "THINKSTAR_NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined THINKSTAR_NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "THINKSTAR_NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if defined THINKSTAR_NODE_EXE call :check_version
if not defined THINKSTAR_NODE_EXE for /f "usebackq delims=" %%N in (`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo -NoProfile -Command "$ErrorActionPreference='SilentlyContinue'; $packages=@(Get-AppxPackage -Name 'OpenAI.CodexPrimaryRuntime*' | Sort-Object Version -Descending); foreach ($package in $packages) { $candidate=Join-Path $package.InstallLocation 'dependencies\node\bin\node.exe'; if (Test-Path -LiteralPath $candidate) { Write-Output $candidate; break } }"`) do if not defined THINKSTAR_NODE_EXE set "THINKSTAR_NODE_EXE=%%N"
if defined THINKSTAR_NODE_EXE call :check_version
if not defined THINKSTAR_NODE_EXE goto :missing_node

echo Thinkstar - Node task runner
echo Node: "%THINKSTAR_NODE_EXE%"
"%THINKSTAR_NODE_EXE%" --version
if /i "%~2"=="--check" exit /b 0
echo.
echo Task: %~1
echo.
echo.
"%THINKSTAR_NODE_EXE%" "%~1"
set "THINKSTAR_EXIT_CODE=%ERRORLEVEL%"
if not "%THINKSTAR_EXIT_CODE%"=="0" if not "%THINKSTAR_NO_PAUSE%"=="1" pause
exit /b %THINKSTAR_EXIT_CODE%

:check_version
"%THINKSTAR_NODE_EXE%" -e "const [major,minor]=process.versions.node.split('.').map(Number); process.exit(major>22||(major===22&&minor>=13)?0:1)" >nul 2>nul
if errorlevel 1 set "THINKSTAR_NODE_EXE="
exit /b 0

:missing_node
echo Could not find Node.js 22.13 or newer in PATH or the installed Codex runtime.
echo Please keep this message and report it to continue troubleshooting.
if /i not "%~2"=="--check" if not "%THINKSTAR_NO_PAUSE%"=="1" pause
exit /b 1

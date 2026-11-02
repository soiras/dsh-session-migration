@echo off
setlocal EnableExtensions
chcp 65001 >nul

rem ---------------------------------------------------------------------------
rem  Bring native WSL dsh sessions into DSH Desktop's WSL world.
rem  Requires the dsh-wsl-workspace plugin (only plugin verified).
rem  Quit DSH Desktop first (tray icon -> Quit; no "DeepSeek Harness.exe" in
rem  Task Manager), then run this file.  Pass --dry-run first if you want to
rem  see the plan without changing anything.  See README.md for scope,
rem  verified versions, rollback and known limits.
rem ---------------------------------------------------------------------------

set "HERE=%~dp0"
set "NODE_EXE="

if defined DSH_DESKTOP_NODE if exist "%DSH_DESKTOP_NODE%" set "NODE_EXE=%DSH_DESKTOP_NODE%"
if not defined NODE_EXE if exist "%ProgramFiles%\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=%ProgramFiles%\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
for %%D in (C D E F) do (
  if not defined NODE_EXE if exist "%%D:\Program Files\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=%%D:\Program Files\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
)
if not defined NODE_EXE for %%I in (node.exe) do if not defined NODE_EXE set "NODE_EXE=%%~$PATH:I"

if not defined NODE_EXE (
  echo No node.exe found. Set DSH_DESKTOP_NODE to the Desktop's bundled node.exe:
  echo   set DSH_DESKTOP_NODE to that path, then run this file again
  if "%~1"=="" pause
  exit /b 2
)

echo Using node: "%NODE_EXE%"
echo.
"%NODE_EXE%" "%HERE%migrate-dsh-wsl-sessions.mjs" %*
set "CODE=%ERRORLEVEL%"
echo.
echo exit code: %CODE%
if "%~1"=="" pause
exit /b %CODE%

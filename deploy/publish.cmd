@echo off
rem One-click publish wrapper. Works even when PowerShell scripts are blocked
rem by ExecutionPolicy, and from cmd / bash / any agent shell.
rem
rem Usage:
rem   deploy\publish.cmd -Message "fix: xxx"
rem   deploy\publish.cmd -GitOnly
rem   deploy\publish.cmd -SkipPush
setlocal
rem Use the absolute path: some shells (agent sandboxes) do not have
rem WindowsPowerShell\v1.0 on PATH, so a bare "powershell" is not found.
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish.ps1" %*
set RC=%ERRORLEVEL%
endlocal & exit /b %RC%

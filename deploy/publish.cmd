@echo off
rem One-click publish wrapper. Works even when PowerShell scripts are blocked
rem by ExecutionPolicy, and from cmd / bash / any agent shell.
rem
rem Usage:
rem   deploy\publish.cmd -Message "fix: xxx"
rem   deploy\publish.cmd -GitOnly
rem   deploy\publish.cmd -SkipPush
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish.ps1" %*
set RC=%ERRORLEVEL%
endlocal & exit /b %RC%

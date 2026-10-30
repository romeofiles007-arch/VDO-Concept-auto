@echo off
rem Cartoon Auto - open the program: starts the local bridge (hidden) if it is not running, then opens its page.
rem Same start-up path the Chrome extension uses (native\host.mjs). Close it with the "close program" .bat.
rem Keep this file ASCII-only: cmd.exe misreads UTF-8 Thai text in .bat files on some Windows builds.
cd /d "%~dp0"
set "NODE="
if exist "%~dp0runtime\node\node.exe" set "NODE=%~dp0runtime\node\node.exe"
if not defined NODE for %%N in (node.exe) do if not "%%~$PATH:N"=="" set "NODE=%%~$PATH:N"
rem No Node.js at all = never installed here: run the one-click installer first.
if not defined NODE powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0native\bootstrap.ps1"
if not defined NODE if exist "%~dp0runtime\node\node.exe" set "NODE=%~dp0runtime\node\node.exe"
if not defined NODE exit /b 1
"%NODE%" "%~dp0native\host.mjs" --open
if errorlevel 1 pause

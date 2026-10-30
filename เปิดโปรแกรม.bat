@echo off
rem Cartoon Auto - open the program: starts the local bridge (hidden) if it is not running, then opens its page.
rem Same start-up path the Chrome extension uses (native\host.mjs). Close it with the "close program" .bat.
rem Keep this file ASCII-only: cmd.exe misreads UTF-8 Thai text in .bat files on some Windows builds.
cd /d "%~dp0"
rem Double-clicked inside the .zip (Explorer extracts only this file to %TEMP%): say "extract first" instead of a Node error.
if not exist "%~dp0native\host.mjs" goto notextracted
set "NODE="
if exist "%~dp0runtime\node\node.exe" set "NODE=%~dp0runtime\node\node.exe"
if not defined NODE for %%N in (node.exe) do if not "%%~$PATH:N"=="" set "NODE=%%~$PATH:N"
rem No Node.js at all = never installed here: run the one-click installer first.
if not defined NODE powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0native\bootstrap.ps1"
if not defined NODE if exist "%~dp0runtime\node\node.exe" set "NODE=%~dp0runtime\node\node.exe"
if not defined NODE exit /b 1
"%NODE%" "%~dp0native\host.mjs" --open
if errorlevel 1 pause
exit /b
:notextracted
powershell.exe -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('4Lii4Lix4LiH4LmE4Lih4LmI4LmE4LiU4LmJ4LmB4LiV4LiB4LmE4Lif4Lil4LmMIHppcAoK4LiE4Lil4Li04LiB4LiC4Lin4Liy4LiX4Li14LmI4LmE4Lif4Lil4LmMIHppcCDguYHguKXguYnguKfguYDguKXguLfguK3guIEgIuC5geC4leC4geC5hOC4n+C4peC5jOC4l+C4seC5ieC4h+C4q+C4oeC4lCAoRXh0cmFjdCBBbGwpIgrguIjguLLguIHguJnguLHguYnguJnguYDguJvguLTguJTguYLguJ/guKXguYDguJTguK3guKPguYzguJfguLXguYjguYHguJXguIHguYHguKXguYnguKcg4LmB4Lil4Liw4LiU4Lix4Lia4LmA4Lia4Li04Lil4LiE4Lil4Li04LiBIHNldHVwLmV4ZSDguYPguJnguJnguLHguYnguJk=')), 'Cartoon Auto')"
exit /b 1

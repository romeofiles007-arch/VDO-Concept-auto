@echo off
rem Cartoon Auto - uninstall: stops the program, unlinks Chrome, removes shortcuts, then (after asking) deletes this folder.
rem Leaves the machine as if Cartoon Auto was never installed - used to test a fresh install.
rem Keep this file ASCII-only: cmd.exe misreads UTF-8 Thai text in .bat files on some Windows builds.
rem Everything the installer adds (node, ffmpeg, python) lives in runtime\ of this folder, nothing system-wide.
set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"
set "NODE="
if exist "%ROOT%\runtime\node\node.exe" set "NODE=%ROOT%\runtime\node\node.exe"
if not defined NODE for %%N in (node.exe) do if not "%%~$PATH:N"=="" set "NODE=%%~$PATH:N"
if not defined NODE echo Node.js not found - nothing to uninstall from here.
if not defined NODE pause
if not defined NODE exit /b 1
title Uninstall
rem Many Windows 10 consoles show Thai as boxes: ask install.mjs for English here (Thai details go to the popup window).
set "CARTOON_CONSOLE=en"
rem Work from TEMP so this window does not hold the folder open while it is being deleted.
cd /d "%TEMP%"
"%NODE%" "%ROOT%\native\install.mjs" --uninstall --full %*
rem Exit code 10 = the user agreed to delete this folder. node.exe has exited, so its files are free now.
if errorlevel 11 exit /b
if errorlevel 10 goto purge
exit /b
:purge
rem "(goto)" ends this batch context first, so cmd does not look for this file after the folder is gone.
(goto) 2>nul & rd /s /q "%ROOT%" 2>nul & if exist "%ROOT%" ping -n 3 127.0.0.1 >nul & rd /s /q "%ROOT%" 2>nul

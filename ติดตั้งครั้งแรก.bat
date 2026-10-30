@echo off
rem Cartoon Auto installer - double-click once, everything installs by itself.
rem Keep this file ASCII-only: cmd.exe misreads UTF-8 Thai text in .bat files on some Windows builds.
rem All work (and all Thai messages) live in native\bootstrap.ps1 (finds/downloads Node.js) and native\install.mjs.
rem Safe to run again any time (after moving the folder, after an update).  --quiet = no popup, no pause.
cd /d "%~dp0"
if not exist "%~dp0native\bootstrap.ps1" goto notextracted
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0native\bootstrap.ps1" %*
if errorlevel 1 if not "%~1"=="--quiet" pause
exit /b %errorlevel%

:notextracted
rem Opened from inside the zip (Windows extracts only this one file) - tell the user to extract first.
powershell.exe -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('4Lii4Lix4LiH4LmE4Lih4LmI4LmE4LiU4LmJ4LmB4LiV4LiB4LmE4Lif4Lil4LmMIHppcAoK4LiE4Lil4Li04LiB4LiC4Lin4Liy4LiX4Li14LmI4LmE4Lif4Lil4LmMIHppcCDguYHguKXguYnguKfguYDguKXguLfguK3guIEgIuC5geC4leC4geC5hOC4n+C4peC5jOC4l+C4seC5ieC4h+C4q+C4oeC4lCAoRXh0cmFjdCBBbGwpIiDguIjguLLguIHguJnguLHguYnguJnguYDguJvguLTguJTguYLguJ/guKXguYDguJTguK3guKPguYzguJfguLXguYjguYHguJXguIHguYHguKXguYnguKcg4LmB4Lil4Liw4LiU4Lix4Lia4LmA4Lia4Li04Lil4LiE4Lil4Li04LiBIOC4leC4tOC4lOC4leC4seC5ieC4h+C4hOC4o+C4seC5ieC4h+C5geC4o+C4gS5iYXQg4LmD4LiZ4LiZ4Lix4LmJ4LiZ')), 'Cartoon Auto')"
exit /b 1

@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ติดตั้ง Cartoon Auto — ดับเบิลคลิกครั้งเดียว แล้วกดไอคอน extension ใช้งานได้เลย
echo.

rem แพ็กเกจลูกค้าแถม node / ffmpeg ไว้ใน runtime\ — ใช้ตัวนั้นก่อน ไม่ต้องติดตั้งอะไรเพิ่ม
set "NODE=node"
if exist "%~dp0runtime\node\node.exe" set "NODE=%~dp0runtime\node\node.exe"
if exist "%~dp0runtime\ffmpeg\ffmpeg.exe" set "PATH=%~dp0runtime\ffmpeg;%PATH%"

"%NODE%" --version >nul 2>nul
if errorlevel 1 (
  echo ยังไม่มี Node.js — ลงจาก https://nodejs.org แล้วดับเบิลคลิกไฟล์นี้ใหม่
  pause
  exit /b 1
)
where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo ยังไม่มี ffmpeg — ใช้ตัดต่อวิดีโอ ลงด้วยคำสั่ง: winget install Gyan.FFmpeg
  echo แล้วดับเบิลคลิกไฟล์นี้ใหม่
  pause
  exit /b 1
)

"%NODE%" native\install.mjs
if errorlevel 1 (
  echo.
  echo ติดตั้งไม่สำเร็จ — ดูข้อความ error ด้านบน
  pause
  exit /b 1
)

echo.
if exist "tts\.venv\Scripts\python.exe" (
  echo ระบบเสียงในเครื่องติดตั้งไว้แล้ว
) else (
  if exist "runtime\python\python.exe" echo เสียงพากย์ Edge ^(ไทย/อังกฤษ^) ใช้ได้ทันที ไม่ต้องติดตั้งเพิ่ม
  echo.
  echo [ไม่บังคับ] ระบบเสียงในเครื่อง — โคลนเสียงตัวเอง เทรนเสียง ถอดเสียงจากไฟล์
  echo ต้องมีการ์ดจอ NVIDIA + Python 3.10 และดาวน์โหลดประมาณ 5GB
  choice /c YN /m "ติดตั้งตอนนี้เลยไหม (ไม่แน่ใจ ให้กด N)"
  if not errorlevel 2 (
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-tts.ps1
  ) else (
    echo ข้ามไปก่อน — ติดตั้งทีหลังได้ด้วยการดับเบิลคลิกไฟล์นี้อีกครั้ง
  )
)

echo.
pause

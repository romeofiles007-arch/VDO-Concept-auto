@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ติดตั้ง Cartoon Auto ให้กดไอคอน extension แล้วใช้ได้เลย
echo.
where node >nul 2>nul
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
node native\install.mjs
if errorlevel 1 (
  echo.
  echo ติดตั้งไม่สำเร็จ — ดูข้อความ error ด้านบน
  pause
  exit /b 1
)

echo.
if exist "tts\.venv\Scripts\python.exe" (
  echo ระบบเสียงติดตั้งไว้แล้ว
) else (
  echo ระบบเสียงในเครื่อง ^(สร้างเสียงไทย เทรนเสียงตัวเอง ถอดเสียง Edge TTS^)
  echo ต้องมีการ์ดจอ NVIDIA + Python 3.10 และดาวน์โหลดประมาณ 5GB
  choice /c YN /m "ติดตั้งตอนนี้เลยไหม"
  if not errorlevel 2 (
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-tts.ps1
  ) else (
    echo ข้ามไปก่อน — ติดตั้งทีหลังได้ด้วยการดับเบิลคลิกไฟล์นี้อีกครั้ง
  )
)

echo.
echo ขั้นต่อไปใน Chrome:
echo   1. เปิด chrome://extensions แล้วเปิด Developer mode
echo   2. ถ้ามี Cartoon Auto Bridge อยู่แล้ว กดปุ่มรีโหลด
echo      ถ้ายังไม่มี กด Load unpacked แล้วเลือกโฟลเดอร์ extension
echo   3. กดไอคอน extension — โปรแกรมเปิดเอง
echo.
pause

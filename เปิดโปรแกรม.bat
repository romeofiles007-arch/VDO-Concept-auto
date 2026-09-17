@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem ถ้า bridge เปิดอยู่แล้ว แค่เปิดหน้าเว็บ
curl -s -m 2 http://127.0.0.1:8765/health >nul 2>&1
if %errorlevel%==0 goto open

echo กำลังเปิดโปรแกรม... (หน้าต่าง "Cartoon Bridge" ต้องเปิดค้างไว้ระหว่างทำงาน)
start "Cartoon Bridge" /min cmd /k node bridge\server.js

for /l %%i in (1,1,30) do (
  timeout /t 1 /nobreak >nul
  curl -s -m 2 http://127.0.0.1:8765/health >nul 2>&1 && goto open
)
echo เปิดโปรแกรมไม่สำเร็จ ดูข้อความในหน้าต่าง Cartoon Bridge
pause
exit /b 1

:open
start "" http://127.0.0.1:8765/

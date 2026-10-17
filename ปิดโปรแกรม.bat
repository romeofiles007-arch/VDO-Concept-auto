@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem ปิดโปรแกรม Cartoon Auto ที่รันซ่อนอยู่ — ใช้ก่อนวางแพ็กเกจรุ่นใหม่ทับ (ไฟล์ที่กำลังใช้งานวางทับไม่ได้)
rem ปิดเฉพาะ process ของโฟลเดอร์นี้: node ที่แถมมาใน runtime\ หรือ node ที่รัน bridge\server.js ของโฟลเดอร์นี้
rem PowerShell คืนจำนวนที่ปิดเป็น exit code — ข้อความภาษาไทยพิมพ์จาก cmd (PowerShell 5 พิมพ์ไทยเพี้ยน)
powershell -NoProfile -Command ^
  "$root = (Get-Location).Path;" ^
  "$mine = @(Get-CimInstance Win32_Process | Where-Object { ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($root + '\runtime\', 'OrdinalIgnoreCase')) -or ($_.CommandLine -and $_.CommandLine.Contains($root + '\bridge\server.js')) });" ^
  "$mine | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue };" ^
  "exit $mine.Count"
if errorlevel 1 (
  echo ปิดโปรแกรมแล้ว — วางแพ็กเกจรุ่นใหม่ทับได้เลย
) else (
  echo โปรแกรมไม่ได้เปิดอยู่
)
echo กดไอคอน Cartoon Auto ใน Chrome เมื่อต้องการใช้งานอีกครั้ง — โปรแกรมเปิดเอง
if not "%~1"=="--quiet" pause

#!/bin/bash
# Cartoon Auto สำหรับ Mac — ปิดโปรแกรมที่รันเบื้องหลังอยู่ (คู่กับ ปิดโปรแกรม.bat)
# ปิดเฉพาะ process ของโฟลเดอร์นี้: node ใน runtime/ หรือ node ที่รัน bridge/server.js ของโฟลเดอร์นี้
DIR="$(cd "$(dirname "$0")" && pwd)"
n=0
while read -r pid cmd; do
  [ "$pid" = "$$" ] && continue
  case "$cmd" in
    "$DIR/runtime/"*|*"$DIR/bridge/server.js"*) kill "$pid" 2>/dev/null && n=$((n + 1)) ;;
  esac
done < <(/bin/ps -axww -o pid=,command=)
if [ $n -gt 0 ]; then echo "ปิดโปรแกรมแล้ว — วางแพ็กเกจรุ่นใหม่ทับได้เลย"; else echo "โปรแกรมไม่ได้เปิดอยู่"; fi
echo "กดไอคอน Cartoon Auto ใน Chrome เมื่อต้องการใช้งานอีกครั้ง — โปรแกรมเปิดเอง"

#!/bin/bash
# Cartoon Auto สำหรับ Mac — ดับเบิลคลิกครั้งเดียว ติดตั้งเองทั้งหมด (คู่กับ setup.exe / ติดตั้งครั้งแรก.bat ของ Windows)
# ครั้งแรก macOS อาจขึ้นว่าเปิดไม่ได้เพราะมาจากอินเทอร์เน็ต → System Settings → Privacy & Security → กด "Open Anyway"
# ทุกอย่างอยู่ใน native/bootstrap.sh (หา/ลง Node.js) และ native/install.mjs · รันซ้ำได้ทุกเมื่อ (ย้ายโฟลเดอร์ / อัปเดต / ซ่อม)
DIR="$(cd "$(dirname "$0")" && pwd)"
/bin/bash "$DIR/native/bootstrap.sh" "$@"
code=$?
echo ""
if [ $code -eq 0 ]; then echo "เสร็จแล้ว — ปิดหน้าต่างนี้ได้เลย"; else echo "ติดตั้งยังไม่ครบ — อ่านสรุปด้านบน แก้แล้วดับเบิลคลิกไฟล์นี้อีกครั้ง"; fi
exit $code

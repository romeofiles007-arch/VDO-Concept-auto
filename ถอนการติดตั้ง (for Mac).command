#!/bin/bash
# Cartoon Auto สำหรับ Mac — ถอนการติดตั้ง: ปิดโปรแกรม ตัดการเชื่อมกับ Chrome ลบ shortcut แล้ว (ถามก่อน) ลบโฟลเดอร์นี้
# ให้เครื่องกลับเป็นเหมือนไม่เคยติดตั้ง (คู่กับ ถอนการติดตั้ง.bat) · ของที่ตัวติดตั้งลง (node, ffmpeg, python) อยู่ใน runtime/ ทั้งหมด
ROOT="$(cd "$(dirname "$0")" && pwd)"
NODE=""
if [ -x "$ROOT/runtime/node/bin/node" ]; then NODE="$ROOT/runtime/node/bin/node"; fi
[ -z "$NODE" ] && NODE="$(command -v node 2>/dev/null)"
if [ -z "$NODE" ]; then echo "ไม่พบ Node.js — ไม่มีอะไรต้องถอนจากโฟลเดอร์นี้"; exit 1; fi
# ทำงานจากโฟลเดอร์อื่น — หน้าต่างนี้จะได้ไม่จับโฟลเดอร์ไว้ตอนลบ
cd /tmp || exit 1
"$NODE" "$ROOT/native/install.mjs" --uninstall --full "$@"
code=$?
# exit 10 = ผู้ใช้ตกลงให้ลบโฟลเดอร์นี้ (node ปิดไปแล้ว ไฟล์ว่างให้ลบ) · โฟลเดอร์พัฒนา (มี .git) ไม่ได้ส่ง 10 มา
if [ $code -eq 10 ] && [ -f "$ROOT/bridge/server.js" ] && [ -f "$ROOT/native/install.mjs" ] && [ "$ROOT" != "/" ]; then
  rm -rf "$ROOT"
  echo "ลบโฟลเดอร์โปรแกรมแล้ว — ปิดหน้าต่างนี้ได้เลย"
  exit 0
fi
exit $code

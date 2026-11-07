#!/bin/bash
# Cartoon Auto สำหรับ Mac — เปิดโปรแกรม: เปิด bridge แบบเบื้องหลัง (ถ้ายังไม่เปิด) แล้วเปิดหน้าเว็บ
# ทางเดียวกับที่ extension ใช้ (native/host.mjs) · ปิดด้วย ปิดโปรแกรม.command
# ใช้แอป "Cartoon Auto" บนเดสก์ท็อปแทนได้ (ตัวติดตั้งสร้างให้) — ไม่มีหน้าต่าง Terminal โผล่
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE=""
if [ -x "$DIR/runtime/node/bin/node" ]; then NODE="$DIR/runtime/node/bin/node"; fi
[ -z "$NODE" ] && NODE="$(command -v node 2>/dev/null)"
# ไม่มี Node.js เลย = ยังไม่เคยติดตั้งในเครื่องนี้ → รันตัวติดตั้งก่อน
if [ -z "$NODE" ]; then
  /bin/bash "$DIR/native/bootstrap.sh" || exit 1
  NODE="$DIR/runtime/node/bin/node"
fi
"$NODE" "$DIR/native/host.mjs" --open

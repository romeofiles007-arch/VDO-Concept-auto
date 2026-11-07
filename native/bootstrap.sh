#!/bin/bash
# ตัวติดตั้งขั้นแรกของ Mac — ติดตั้งครั้งแรก.command เรียกไฟล์นี้ (คู่กับ native/bootstrap.ps1 ของ Windows)
#
# หน้าที่เดียว: หา Node.js 20+ ให้ได้ แล้วส่งต่อให้ native/install.mjs ทำที่เหลือทั้งหมด
#   1. runtime/node/bin/node ที่ดาวน์โหลดไว้แล้ว
#   2. node ที่ลงไว้ในเครื่อง (Homebrew / nodejs.org) ถ้ารุ่น 20 ขึ้นไป
#   3. ไม่มีทั้งคู่ → ดาวน์โหลด Node.js LTS จาก nodejs.org (ตรวจ SHA256) วางที่ runtime/node — ไม่ต้องกดอะไร
# ไม่ลงอะไรทั้งเครื่อง ไม่ต้องใช้รหัสผ่านเครื่อง (sudo) · รันซ้ำได้
#
# ไฟล์นี้ต้องขึ้นบรรทัดแบบ LF (.gitattributes บังคับไว้) — CRLF ทำให้ bash อ่านคำสั่งเพี้ยน

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

popup() {
  /usr/bin/osascript -e 'on run argv' -e 'display dialog (item 1 of argv) with title "Cartoon Auto" buttons {"OK"} default button 1 with icon stop' -e 'end run' "$1" >/dev/null 2>&1
}

fail() {
  echo ""
  echo "✗ $1"
  popup "$1"
  exit 1
}

echo "Cartoon Auto — กำลังติดตั้ง ไม่ต้องกดอะไร รอจนขึ้นหน้าต่างสรุป"
echo ""

# ไฟล์ที่แตกจาก zip ที่ดาวน์โหลดมามีป้าย "มาจากอินเทอร์เน็ต" (quarantine) — macOS จะถามยืนยันทุกไฟล์ที่เปิด
# ปลดออกครั้งเดียวทั้งโฟลเดอร์ (เหมือน Unblock-File ของ Windows) และให้ไฟล์ .command / .sh รันได้
/usr/bin/xattr -dr com.apple.quarantine "$ROOT" 2>/dev/null
chmod +x "$ROOT"/*.command "$ROOT"/native/*.sh 2>/dev/null

node_ok() {
  [ -n "$1" ] && [ -x "$1" ] || return 1
  major="$("$1" -p "process.versions.node.split('.')[0]" 2>/dev/null)"
  [ -n "$major" ] && [ "$major" -ge 20 ] 2>/dev/null
}

NODE=""
for c in "$ROOT/runtime/node/bin/node" "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node; do
  if node_ok "$c"; then NODE="$c"; break; fi
done

if [ -z "$NODE" ]; then
  case "$(uname -m)" in
    arm64) ARCH=arm64 ;;
    x86_64) ARCH=x64 ;;
    *) fail "เครื่องนี้เป็นสถาปัตยกรรม $(uname -m) ซึ่งยังไม่รองรับ" ;;
  esac
  BASE="https://nodejs.org/dist/latest-v24.x"
  echo "▸ ดาวน์โหลด Node.js (~50 MB) — ครั้งแรกครั้งเดียว"
  SUMS="$(/usr/bin/curl -fsSL --retry 2 "$BASE/SHASUMS256.txt")" || fail "ต่อ nodejs.org ไม่ได้ — ตรวจอินเทอร์เน็ตแล้วดับเบิลคลิก ติดตั้งครั้งแรก.command อีกครั้ง"
  LINE="$(printf '%s\n' "$SUMS" | grep -E " node-v[0-9.]+-darwin-$ARCH\.tar\.gz$" | head -n 1)"
  [ -n "$LINE" ] || fail "หาไฟล์ Node.js สำหรับ Mac ใน nodejs.org ไม่เจอ"
  SHA="${LINE%% *}"
  NAME="${LINE##* }"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  /usr/bin/curl -fL --retry 2 --progress-bar -o "$TMP/$NAME" "$BASE/$NAME" || fail "ดาวน์โหลด Node.js ไม่สำเร็จ — ตรวจอินเทอร์เน็ตแล้วลองใหม่"
  GOT="$(/usr/bin/shasum -a 256 "$TMP/$NAME" | cut -d ' ' -f 1)"
  [ "$GOT" = "$SHA" ] || fail "ไฟล์ Node.js ที่ดาวน์โหลดเสีย (SHA256 ไม่ตรง) — ลองใหม่อีกครั้ง"
  /usr/bin/tar -xzf "$TMP/$NAME" -C "$TMP" || fail "แตกไฟล์ Node.js ไม่สำเร็จ"
  rm -rf "$ROOT/runtime/node"
  mkdir -p "$ROOT/runtime"
  mv "$TMP/${NAME%.tar.gz}" "$ROOT/runtime/node" || fail "วาง Node.js ลงใน runtime/node ไม่สำเร็จ"
  NODE="$ROOT/runtime/node/bin/node"
  node_ok "$NODE" || fail "ลง Node.js แล้วแต่รันไม่ได้"
  echo "✓ Node.js $("$NODE" -v)"
fi

"$NODE" "$ROOT/native/install.mjs" "$@"

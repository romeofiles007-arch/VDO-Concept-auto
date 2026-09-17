---
name: Cartoon Auto
description: แผงทำคลิปภาษาไทยกับทีมสัตว์ทะเล 3D
colors:
  ocean: "#006d77"
  sand: "#f5eddd"
  shell: "#fffcf5"
  ink: "#123b42"
  muted: "#526c6d"
  line: "#82765f"
  pick: "#d9eeea"
  success: "#24724f"
  warning: "#875000"
  danger: "#ae402f"
  deep-ocean: "#07242b"
  deep-panel: "#10363e"
  deep-ink: "#edf6f1"
  deep-muted: "#a5c2c2"
  deep-line: "#6d9495"
  deep-pick: "#194850"
  seafoam: "#78d9cd"
  deep-action-ink: "#07363b"
  deep-success: "#87d9ac"
  deep-warning: "#ebc17a"
  deep-danger: "#ffa18b"
  turtle: "#2a7336"
  turtle-pick: "#e3f2e1"
  octopus: "#9a3a8c"
  octopus-pick: "#f6e3f2"
  dolphin: "#1d67a8"
  dolphin-pick: "#e0ecf8"
  crab: "#b0431c"
  crab-pick: "#f9e6dc"
  deep-turtle: "#7ed38c"
  deep-turtle-pick: "#133a26"
  deep-octopus: "#f19ad9"
  deep-octopus-pick: "#3a1c38"
  deep-dolphin: "#78bdff"
  deep-dolphin-pick: "#12304f"
  deep-crab: "#ff9d70"
  deep-crab-pick: "#3b2218"
  turtle-bg: "#edf3e5"
  turtle-panel: "#f8fcf4"
  octopus-bg: "#f5eaf2"
  octopus-panel: "#fffafd"
  dolphin-bg: "#e7f1f7"
  dolphin-panel: "#f5fbff"
  crab-bg: "#f6ebdf"
  crab-panel: "#fff9f1"
  deep-turtle-bg: "#0b251d"
  deep-turtle-panel: "#133a2f"
  deep-octopus-bg: "#201326"
  deep-octopus-panel: "#30243b"
  deep-dolphin-bg: "#092331"
  deep-dolphin-panel: "#113747"
  deep-crab-bg: "#2e1b13"
  deep-crab-panel: "#3b2920"
typography:
  body:
    fontFamily: '"Noto Sans Thai", "Leelawadee UI", system-ui, sans-serif'
    fontSize: "15px"
    lineHeight: 1.55
  title:
    fontSize: "18px"
    fontWeight: 700
    lineHeight: 1.35
  heading:
    fontSize: "17px"
  item-title:
    fontSize: "14px"
  label:
    fontSize: "13px"
  hero-sub:
    fontSize: "12.5px"
  hint:
    fontSize: "12px"
  meta:
    fontSize: "11px"
rounded:
  field: "9px"
  button: "12px"
  section: "14px"
  crew: "10px"
  chip: "99px"
spacing:
  small: "8px"
  gap: "12px"
  section: "14px"
components:
  button-primary:
    backgroundColor: "{colors.ocean}"
    textColor: "#ffffff"
    rounded: "{rounded.button}"
    padding: "10px 16px"
  button-primary-dark:
    backgroundColor: "{colors.seafoam}"
    textColor: "{colors.deep-action-ink}"
    rounded: "{rounded.button}"
    padding: "10px 16px"
---

# Design System: Cartoon Auto

## Overview

**Creative North Star: "สตูดิโอทีมสัตว์ทะเล"**

หน้าใช้งานทำคลิปต้องอ่านสถานะและเลือกงานได้เร็ว ภาพมหาสมุทร 3D เป็นโลกเบื้องหลัง ตัวละครและอุปกรณ์แสดงบุคลิกแต่ละแผนก ไม่เปลี่ยนข้อความหรือการทำงานเพื่อการตกแต่ง

## Colors

สว่างใช้น้ำตื้น ทราย และเปลือกหอย มืดใช้น้ำลึกกับสีฟองคลื่น ปุ่มหลักใช้ --accent และตัวหนังสือบนปุ่มใช้ --accent-ink ข้อความรองใช้ --muted ไม่ใช้ opacity ลดความชัด

สีตามแผนกที่มีอยู่ใน agents.css: เต่าเขียว ปลาหมึกม่วงชมพู โลมาฟ้า ปูส้มปะการัง เปลี่ยน --world-image/--bg/--panel/--accent/--pick/--sea-top ตาม html[data-dept] และธีมระบบ ค่าสีในโค้ดเป็นต้นฉบับของตัวแปรเหล่านี้ ทั้งฉากใหญ่และแบนเนอร์ตามตัวละครที่แสดง รวม idle/offline และการกดเลือกแผนก

พื้นแผนก light bg/panel → dark bg/panel: เต่า #edf3e5/#f8fcf4 → #0b251d/#133a2f; ปลาหมึก #f5eaf2/#fffafd → #201326/#30243b; โลมา #e7f1f7/#f5fbff → #092331/#113747; ปู #f6ebdf/#fff9f1 → #2e1b13/#3b2920

**The Readable Surface Rule.** กล่องที่อยู่บนภาพใช้พื้น --panel อย่างน้อย 92% ไม่วางข้อความแบบฟอร์มบนรายละเอียดภาพโดยตรง ตรวจ contrast อีกครั้งเมื่อเปลี่ยนสีแผนก

## Typography

ใช้ชุดฟอนต์ไทยเดิมและฟอนต์ในระบบ ไม่โหลดฟอนต์ภายนอก หัวเรื่องแบนเนอร์ตัวหนา แสดงไม่เกินสองบรรทัด งาน/เวลายังเป็นข้อความจริง ไม่ใช้ภาพแทนข้อความ ขนาดย่อยแบนเนอร์ 12.5px และข้อความขั้น 11px

## Layout

แผงข้างเป้าหมาย 360–450px และยืดได้ตามหน้าต่าง main เว้นขอบ 12px ระยะห่างส่วนงาน 12px แบนเนอร์ขั้นต่ำ 200px ตัวละคร 104px ทางซ้าย ข้อความกลาง เว้นท้ายข้อความ 96px สำหรับอุปกรณ์ด้านล่างขวา แถวเลือกสัตว์กดได้และห่อบรรทัดได้

ฉากใหญ่ ocean-{chatgpt,flow,voice,edit}.png อยู่ใน body::before เต็ม viewport แบบ fixed/cover และแบนเนอร์ร่วมกัน ไม่ดัก pointer เมื่อเลื่อนหน้ายังคงเป็นพื้นหลังของหน้าต่าง ไม่เพิ่มความสูงเอกสาร ocean-world.png เป็นภาพเริ่มต้น/สำรอง ฉากแต่ละแผนกคงทางเดินทรายและสถาปัตยกรรมเปลือกหอยเดิม เปลี่ยนสีปะการังและอุปกรณ์ตามหน้าที่ ไม่มีสัตว์ซ้ำในภาพฉาก

## Elevation & Depth

กล่องงานหลักใช้เส้นขอบและสีพื้น ไม่มีเงาทั่วหน้า แบนเนอร์ใช้เงากลาง 0 6px 20px rgba(0, 0, 0, .2) ภาพตัวละครใช้เงาตามรูป alpha ไม่สร้างขอบตัดทรงเรขาคณิตแทนภาพ

## Shapes

กล่องงานและแบนเนอร์มุม 14px ปุ่มมุม 12px ช่องกรอกมุม 9px ปุ่มเลือกสัตว์ 44px มุม 10px การเลือกแผนกและ focus ต้องมีขอบ/outline ไม่พึ่งสีอย่างเดียว

## Components

ปุ่ม ช่องกรอก แถบตัวเลือก และข้อความสถานะคง affordance เดิม สี success/warning/danger ไม่เปลี่ยนความหมายตามฉาก

ชุดอุปกรณ์ department-props.png มี 4 ช่องตามลำดับ นักเขียน / นักวาด / เสียงพากย์ / ตัดต่อ ใช้ภาพโปร่งใสจริง ไม่วาดตัวละครซ้ำ อุปกรณ์นักวาดมีกองสีบีบและหลอดสีเปิดฝา

**The Visible Motion Rule.** อุปกรณ์ขยับด้วย CSS ไม่เกิน 2px/0.8deg รอบ 5 วินาทีเมื่อ working และ 8 วินาทีเมื่อ idle หยุดเมื่อ hidden หรือ offscreen; waiting/offline ไม่มีการขยับอุปกรณ์ โหมด reduced-motion แสดงภาพนิ่ง สถานะและเวลาไม่หาย ภาพพื้นหลังใหญ่ไม่เคลื่อนไหว

## Do's and Don'ts

- Do เก็บภาพ/สคริปต์/สไตล์ทั้งหมดใน extension และฝัง provenance ของภาพที่สร้างใหม่
- Do ใช้ตัวแปรสีเดิมให้ทั้งแผง รวม scrollbar, caret, focus และ placeholder
- Do คง polling agent 3 วินาทีและหยุดเมื่อ document.hidden
- Don't เพิ่ม dependency หรือวง requestAnimationFrame เพื่อขยับของตกแต่ง
- Don't เปลี่ยนภาพ 3D สัตว์ทะเลที่ผู้ใช้ยืนยันเป็น SVG จำลอง
- Don't ยึดกลิฟ emoji และเงา hard-offset ที่มีในปุ่มบางส่วนเป็นข้อกำหนดดีไซน์สำหรับหน้าจอใหม่

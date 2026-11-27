"""เทสต์ cap_pauses — ย่อช่วงหยุดกลางประโยคของ VoxCPM2 ให้ไม่เกิน ~0.3 วิ แบบ ElevenLabs

    python tts/voxcpm/test_cap_pauses.py   (ต้องมี numpy)
"""
import importlib.util
import sys
from pathlib import Path

import numpy as np

spec = importlib.util.spec_from_file_location("synth_voxcpm", Path(__file__).with_name("synth_voxcpm.py"))
sv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sv)
sys.stdout = sys.__stdout__  # synth_voxcpm ปิด stdout ไว้ส่งสถานะให้ Node

SR = 24000
tone = lambda s: (0.5 * np.sin(np.linspace(0, 2 * np.pi * 220 * s, int(SR * s)))).astype(np.float32)
quiet = lambda s: np.zeros(int(SR * s), dtype=np.float32)
passed = 0


def check(name, cond):
    global passed
    assert cond, name
    passed += 1
    print(f"  ✓ {name}")


# เคสจริง: "เทียนจี้กำลังจะ [หยุด 1.69 วิ] แพ้พนันกษัตริย์" บน 1080 Ti
wav = np.concatenate([quiet(0.5), tone(1.0), quiet(1.69), tone(1.5), quiet(0.3)])
out = sv.cap_pauses(wav, SR)
check("ช่วงหยุด 1.69 วิกลางประโยค → เหลือ ~0.3 วิ (ยาวลด ~1.39 วิ)", abs((len(wav) - len(out)) / SR - 1.39) < 0.03)
check("ความเงียบหัว/ท้ายไฟล์ไม่แตะ (2_tts ตัดเอง)", np.all(out[: int(SR * 0.49)] == 0) and np.all(out[-int(SR * 0.29):] == 0))

short = np.concatenate([tone(1.0), quiet(0.3), tone(1.0)])
check("ช่วงหยุดสั้น 0.3 วิ (ตรงช่องว่าง/\"...\") ไม่โดนตัด", len(sv.cap_pauses(short, SR)) == len(short))

two = np.concatenate([tone(0.6), quiet(0.9), tone(0.6), quiet(1.2), tone(0.6)])
check("หลายช่วงในประโยคเดียว ย่อทุกช่วง", abs(len(sv.cap_pauses(two, SR)) / SR - (1.8 + 0.6)) < 0.05)

check("max_pause = 0 / None → ไม่แตะ", len(sv.cap_pauses(two, SR, 0)) == len(two) and len(sv.cap_pauses(two, SR, None)) == len(two))
check("เงียบทั้งไฟล์ → คืนไฟล์เดิม", len(sv.cap_pauses(quiet(2.0), SR)) == int(SR * 2.0))

print(f"\nผ่าน {passed} ข้อ")

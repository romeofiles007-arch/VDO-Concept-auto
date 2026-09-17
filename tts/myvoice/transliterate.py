"""
EN word -> Thai phonetic transcription for F5-TTS Thai input preprocessing.

Strategy (in priority order, configurable):
  1. User dictionary (transliterate_user.json) — editable from UI
  2. Built-in dictionary — common tech/brand/common words (hand-curated)
  3. Gemini API   — context-aware Thai phonetic (when enabled + key set)
  4. Acronym spell-out — all-uppercase 1-5 chars → letter-by-letter Thai
  5. g2p_en fallback — CMU dict + neural fallback → ARPABET → Thai chars

Gemini results are auto-cached into the user dictionary so repeat words
don't trigger another API call.

Settings file: settings_local.json (gitignored)
  { "gemini_api_key": "...", "use_gemini": true }
"""
from __future__ import annotations
import json
import os
import re
from pathlib import Path

# ============================================================
# Built-in dictionary (handcrafted, lowercase keys)
# ============================================================
BUILTIN_DICT: dict[str, str] = {
    # — AI / models / brands —
    "chatgpt": "แชตจีพีที",
    "gpt": "จีพีที",
    "openai": "โอเพนเอไอ",
    "anthropic": "แอนโทรปิก",
    "claude": "คล็อด",
    "gemini": "เจมินาย",
    "midjourney": "มิดเจอร์นี่",
    "stability": "สเตบิลิตี้",
    "huggingface": "ฮักกิ้งเฟซ",

    # — Tech companies / products —
    "google": "กูเกิล",
    "youtube": "ยูทูบ",
    "facebook": "เฟซบุ๊ก",
    "meta": "เมต้า",
    "twitter": "ทวิตเตอร์",
    "instagram": "อินสตาแกรม",
    "tiktok": "ติ๊กต็อก",
    "iphone": "ไอโฟน",
    "ipad": "ไอแพด",
    "macbook": "แม็คบุ๊ก",
    "apple": "แอปเปิล",
    "android": "แอนดรอยด์",
    "samsung": "ซัมซุง",
    "windows": "วินโดวส์",
    "microsoft": "ไมโครซอฟท์",
    "excel": "เอกเซล",
    "word": "เวิร์ด",
    "powerpoint": "พาวเวอร์พอยต์",
    "outlook": "เอาต์ลุ๊ก",
    "github": "กิตฮับ",
    "gitlab": "กิตแล็บ",
    "tesla": "เทสลา",
    "amazon": "อะเมซอน",
    "netflix": "เน็ตฟลิกซ์",
    "spotify": "สปอติฟาย",
    "discord": "ดิสคอร์ด",
    "slack": "สแล็ก",
    "zoom": "ซูม",
    "line": "ไลน์",
    "wechat": "วีแชต",
    "telegram": "เทเลแกรม",
    "whatsapp": "วอตส์แอป",
    "shopee": "ช้อปปี้",
    "lazada": "ลาซาด้า",

    # — Common tech terms —
    "wifi": "ไวไฟ",
    "bluetooth": "บลูทูธ",
    "internet": "อินเทอร์เน็ต",
    "online": "ออนไลน์",
    "offline": "ออฟไลน์",
    "email": "อีเมล",
    "website": "เว็บไซต์",
    "web": "เว็บ",
    "browser": "เบราว์เซอร์",
    "chrome": "โครม",
    "firefox": "ไฟร์ฟอกซ์",
    "safari": "ซาฟารี",
    "edge": "เอดจ์",
    "url": "ยูอาร์แอล",
    "link": "ลิงก์",
    "search": "เสิร์ช",
    "click": "คลิก",
    "download": "ดาวน์โหลด",
    "upload": "อัปโหลด",
    "share": "แชร์",
    "like": "ไลก์",
    "comment": "คอมเมนต์",
    "subscribe": "ซับสไครบ์",
    "follow": "ฟอลโลว์",
    "post": "โพสต์",
    "video": "วิดีโอ",
    "photo": "โฟโต้",
    "image": "อิมเมจ",
    "live": "ไลฟ์",
    "stream": "สตรีม",
    "channel": "แชนแนล",
    "feed": "ฟีด",
    "page": "เพจ",
    "menu": "เมนู",
    "tab": "แท็บ",
    "file": "ไฟล์",
    "folder": "โฟลเดอร์",
    "save": "เซฟ",
    "delete": "ดีลีท",
    "edit": "เอดิต",
    "code": "โค้ด",
    "data": "ดาต้า",
    "database": "ดาต้าเบส",
    "server": "เซิร์ฟเวอร์",
    "client": "ไคลเอนต์",
    "app": "แอป",
    "application": "แอปพลิเคชัน",
    "software": "ซอฟต์แวร์",
    "hardware": "ฮาร์ดแวร์",
    "model": "โมเดล",
    "feature": "ฟีเจอร์",
    "tool": "ทูล",
    "update": "อัปเดต",
    "upgrade": "อัปเกรด",
    "install": "อินสตอลล์",
    "uninstall": "อันอินสตอลล์",
    "login": "ล็อกอิน",
    "logout": "ล็อกเอาต์",
    "signup": "ไซน์อัพ",
    "register": "รีจิสเตอร์",
    "password": "พาสเวิร์ด",
    "username": "ยูสเซอร์เนม",
    "system": "ซิสเต็ม",
    "device": "ดีไวซ์",
    "screen": "สกรีน",
    "display": "ดิสเพลย์",
    "monitor": "มอนิเตอร์",
    "keyboard": "คีย์บอร์ด",
    "mouse": "เมาส์",
    "phone": "โฟน",
    "tablet": "แท็บเล็ต",
    "computer": "คอมพิวเตอร์",
    "laptop": "แล็ปท็อป",
    "notebook": "โน้ตบุ๊ก",
    "battery": "แบตเตอรี่",
    "charger": "ชาร์จเจอร์",
    "cable": "เคเบิล",
    "port": "พอร์ต",
    "scan": "สแกน",
    "print": "ปริ้นต์",
    "printer": "พรินเตอร์",

    # — Common business / payment —
    "team": "ทีม",
    "project": "โปรเจกต์",
    "task": "ทาสก์",
    "manage": "แมเนจ",
    "account": "แอ็กเคานต์",
    "payment": "เพย์เมนต์",
    "credit": "เครดิต",
    "card": "การ์ด",
    "premium": "พรีเมียม",
    "free": "ฟรี",
    "trial": "ไทรอัล",
    "demo": "เดโม",
    "plus": "พลัส",
    "pro": "โปร",
    "lite": "ไลต์",
    "basic": "เบสิก",
    "standard": "สแตนดาร์ด",
    "enterprise": "เอ็นเตอร์ไพรส์",

    # — Common general words —
    "hello": "เฮลโล",
    "hi": "ไฮ",
    "bye": "บาย",
    "okay": "โอเค",
    "yes": "เยส",
    "no": "โน",
    "good": "กู้ด",
    "bad": "แบด",
    "thank": "แทงค์",
    "thanks": "แทงค์",
    "generate": "เจเนอเรท",
    "create": "ครีเอท",
    "design": "ดีไซน์",
    "draft": "ดราฟต์",
    "test": "เทสต์",
    "demo": "เดโม",
    "version": "เวอร์ชัน",
    "update": "อัปเดต",
    "title": "ไทเทิล",
    "content": "คอนเทนต์",
    "concept": "คอนเซปต์",
    "style": "สไตล์",
    "trend": "เทรนด์",
    "viral": "ไวรัล",
    "icon": "ไอคอน",
    "logo": "โลโก้",
    "banner": "แบนเนอร์",
    "block": "บล็อก",
    "review": "รีวิว",
    "feedback": "ฟีดแบ็ก",
    "user": "ยูสเซอร์",
    "level": "เลเวล",
    "step": "สเต็ป",
    "guide": "ไกด์",
    "tip": "ทิป",
    "tips": "ทิปส์",
    "with": "วิธ",
    "without": "วิธเอาท์",
    "for": "ฟอร์",
    "from": "ฟรอม",
    "and": "แอนด์",
    "or": "ออร์",
    "the": "เดอะ",
    "released": "รีลีสด์",
    "release": "รีลีส",
    "improved": "อิมพรูฟด์",
    "improve": "อิมพรูฟ",
    "improvement": "อิมพรูฟเมนต์",
    "benchmark": "เบนช์มาร์ก",
    "benchmarks": "เบนช์มาร์กส์",
    "sonnet": "ซอนเน็ต",
    "haiku": "ไฮกุ",
    "opus": "โอปุส",
    "flash": "แฟลช",
    "performance": "เพอร์ฟอร์แมนซ์",
    "powerful": "พาวเวอร์ฟูล",
    "advanced": "แอดวานซ์",
    "intelligence": "อินเทลลิเจนซ์",
    "artificial": "อาร์ติฟิเชียล",
    "neural": "นิวรอล",
    "network": "เน็ตเวิร์ก",
    "machine": "แมชชีน",
    "learning": "เลิร์นนิง",
    "deep": "ดีพ",
    "language": "แลงเกวจ",
    "speech": "สปีช",
    "voice": "วอยซ์",
    "audio": "ออดิโอ",
    "input": "อินพุต",
    "output": "เอาต์พุต",
    "process": "โปรเซส",
    "training": "เทรนนิ่ง",
    "train": "เทรน",
    "dataset": "ดาต้าเซต",
    "prompt": "พรอมต์",
    "token": "โทเคน",
    "context": "คอนเท็กซ์",
    "summary": "ซัมมารี",
    "notion": "โนชั่น",
    "note": "โน้ต",
    "notes": "โน้ตส์",
    "copilot": "โคไพล็อต",
    "codex": "โค้ดเด็กซ์",
    "cursor": "เคอร์เซอร์",
    "perplexity": "เพอร์เพล็กซิตี้",
    "elevenlabs": "อีเลฟเวนแล็บส์",
    "stability": "สเตบิลิตี้",
    "runway": "รันเวย์",
    "ideogram": "ไอดิโอแกรม",
    "leonardo": "ลีโอนาร์โด",
    "deepseek": "ดีพซีก",
    "mistral": "มิสทรัล",
    "llama": "ลามา",
    "qwen": "เคียวเอ็น",
    "grok": "กร็อก",
    "gemini": "เจมินาย",
    "vertex": "เวอร์เท็กซ์",
    "bedrock": "เบดร็อก",
    "azure": "แอชัวร์",
    "aws": "เอดับเบิลยูเอส",
    "throughput": "ทรูพุท",
    "latency": "ลาเทนซี",
    "playground": "เพลย์กราวด์",
    "endpoint": "เอนด์พอยต์",
    "webhook": "เว็บฮุก",
    "callback": "คอลแบ็ก",
    "deploy": "ดีพลอย",
    "deployment": "ดีพลอยเมนต์",
    "production": "โปรดักชัน",
    "staging": "สเตจจิง",
    "rollback": "โรลแบ็ก",
    "pipeline": "ไปป์ไลน์",
    "workflow": "เวิร์กโฟลว์",
    "framework": "เฟรมเวิร์ก",
    "library": "ไลบรารี่",
    "package": "แพ็กเกจ",
    "module": "โมดูล",
    "function": "ฟังก์ชัน",
    "variable": "วาเรียเบิล",
    "boolean": "บูเลียน",
    "string": "สตริง",
    "integer": "อินทีเจอร์",
    "float": "โฟลต",
    "array": "อาร์เรย์",
    "object": "อ็อบเจกต์",
    "agent": "เอเจนต์",
    "agents": "เอเจนต์ส์",
    "automation": "ออโตเมชัน",
    "automate": "ออโตเมท",
    "router": "เราเตอร์",
    "proxy": "พร็อกซี",
    "cache": "แคช",
    "queue": "คิว",
    "stack": "สแต็ก",
    "thread": "เธรด",
    "async": "อะซิงค์",
    "sync": "ซิงค์",
    "console": "คอนโซล",
    "log": "ล็อก",
    "logs": "ล็อกส์",
    "debug": "ดีบัก",
    "trace": "เทรซ",
    "metric": "เมตริก",
    "metrics": "เมตริกส์",
    "tier": "เทียร์",
    "quota": "โควต้า",
    "rate": "เรท",
    "limit": "ลิมิต",
    "token": "โทเคน",
    "tokens": "โทเคนส์",
    "embedding": "เอ็มเบดดิ้ง",
    "vector": "เวกเตอร์",
    "database": "เดต้าเบส",
    "query": "เควรี",
    "response": "เรสปอนส์",
    "request": "รีเควสต์",
    "header": "เฮดเดอร์",
    "json": "เจซัน",
    "yaml": "ยามล์",
    "schema": "สคีมา",
    "config": "คอนฟิก",
    "settings": "เซตติงส์",
    "preset": "พรีเซ็ต",
    "anthropic": "แอนโทรปิก",
    "claude": "คล็อด",
    "sonnet": "ซอเหนด",
    "opus": "โอปุส",
    "haiku": "ไฮกุ",
    "openai": "โอเพนเอไอ",
    "plan": "แพลน",
    "plans": "แพลนส์",
    "planning": "แพลนนิ่ง",
    "package": "แพ็กเกจ",
    "packs": "แพ็กส์",
    "pack": "แพ็ก",
    "back": "แบ็ก",
    "track": "แทร็ก",
    "stack": "สแต็ก",
    "snack": "สแน็ก",
    "tracks": "แทร็กส์",
    "task": "ทาสก์",
    "tasks": "ทาสก์ส",
    "fast": "ฟาสต์",
    "last": "ลาสต์",
    "cast": "คาสต์",
    "broadcast": "บรอดคาสต์",
    "podcast": "พ็อดคาสต์",
    "land": "แลนด์",
    "hand": "แฮนด์",
    "brand": "แบรนด์",
    "stand": "สแตนด์",
    "grand": "แกรนด์",
    "command": "คอมมานด์",
    "demand": "ดีมานด์",
    "ban": "แบน",
    "scan": "สแกน",
    "span": "สแปน",
    "fan": "แฟน",
    "man": "แมน",
    "can": "แคน",
    "van": "แวน",
    "team": "ทีม",
    "stream": "สตรีม",
    "scheme": "สคีม",
    "theme": "ธีม",
    "meme": "มีม",
    "start": "สตาร์ท",
    "smart": "สมาร์ท",
    "chart": "ชาร์ต",
    "part": "พาร์ต",
    "art": "อาร์ต",
    "card": "การ์ด",
    "hard": "ฮาร์ด",
    "guard": "การ์ด",
    "lord": "ลอร์ด",
    "word": "เวิร์ด",
    "world": "เวิลด์",
    "form": "ฟอร์ม",
    "platform": "แพลตฟอร์ม",
    "format": "ฟอร์แมต",
    "perfect": "เพอร์เฟกต์",
    "select": "ซีเลกต์",
    "object": "อ็อบเจกต์",
    "subject": "ซับเจกต์",
    "project": "โปรเจกต์",
    "effect": "เอฟเฟกต์",
    "connect": "คอนเน็กต์",
    "direct": "ไดเรกต์",
    "control": "คอนโทรล",
    "scroll": "สโครล",
    "role": "โรล",
    "goal": "โกล",
    "bowl": "โบวล์",
    "cool": "คูล",
    "tool": "ทูล",
    "pool": "พูล",
    "rule": "รูล",
    "school": "สคูล",
    "full": "ฟูล",
    "pull": "พูล",
    "bug": "บั๊ก",
    "fix": "ฟิกซ์",
    "mix": "มิกซ์",
    "box": "บ็อกซ์",
    "fox": "ฟ็อกซ์",
    "tax": "แท็กซ์",
    "max": "แม็กซ์",
    "next": "เน็กซ์ต์",
    "text": "เท็กซ์ต์",
    "step": "สเต็ป",
    "drop": "ดร็อป",
    "top": "ท็อป",
    "stop": "สต็อป",
    "shop": "ช็อป",
    "pop": "ป็อป",
    "rock": "ร็อก",
    "lock": "ล็อก",
    "clock": "คล็อก",
    "block": "บล็อก",
    "click": "คลิก",
    "trick": "ทริก",
    "pick": "พิก",
    "stick": "สติก",
    "quick": "ควิก",
    "thick": "ทิก",
    "buy": "บาย",
    "guy": "กาย",
    "try": "ทราย",
    "sky": "สกาย",
    "fly": "ฟลาย",
    "key": "คีย์",
    "money": "มันนี่",
    "honey": "ฮันนี่",
    "story": "สตอรี่",
    "history": "ฮิสตอรี่",
    "energy": "เอเนอร์จี้",
    "battery": "แบตเตอรี่",
    "company": "คอมพานี",
    "country": "คันทรี่",
    "city": "ซิตี้",
    "family": "แฟมิลี่",
    "happy": "แฮปปี้",
    "sorry": "ซอรี่",
    "really": "เรียลลี่",
    "very": "เวรี่",
    "every": "เอฟรี่",
    "easy": "อีซี่",
    "lazy": "เลซี่",
    "crazy": "เครซี่",
    "ready": "เรดดี้",
    "study": "สตัดดี้",
    "body": "บอดี้",
    "buddy": "บัดดี้",
    "candy": "แคนดี้",
    "lady": "เลดี้",
    "baby": "เบบี้",
    "hobby": "ฮอบบี้",
    "lobby": "ล็อบบี้",
    "lucky": "ลักกี้",
    "rocky": "ร็อกกี้",
    "sticky": "สติ๊กกี้",
    "tricky": "ทริ๊กกี้",
    "show": "โชว์",
    "blow": "โบลว์",
    "flow": "โฟลว์",
    "glow": "โกลว์",
    "snow": "สโนว์",
    "slow": "สโลว์",
    "know": "โนว์",
    "throw": "โธรว์",
}

# ============================================================
# Acronym spell-out
# ============================================================
ALPHABET_TH: dict[str, str] = {
    'a': 'เอ', 'b': 'บี', 'c': 'ซี', 'd': 'ดี', 'e': 'อี', 'f': 'เอฟ',
    'g': 'จี', 'h': 'เอช', 'i': 'ไอ', 'j': 'เจ', 'k': 'เค', 'l': 'แอล',
    'm': 'เอ็ม', 'n': 'เอ็น', 'o': 'โอ', 'p': 'พี', 'q': 'คิว', 'r': 'อาร์',
    's': 'เอส', 't': 'ที', 'u': 'ยู', 'v': 'วี', 'w': 'ดับเบิลยู', 'x': 'เอ็กซ์',
    'y': 'วาย', 'z': 'แซด',
}

# ============================================================
# ARPABET → Thai phoneme mapping (rough, for fallback)
# Each entry: phoneme key → tuple (consonant_or_independent, vowel_modifier)
# We emit a flat character sequence — F5-TTS doesn't need proper grammar,
# just chars its vocab.txt recognises.
# ============================================================
# Independent consonants
ARPABET_CONS: dict[str, str] = {
    'B': 'บ', 'CH': 'ช', 'D': 'ด', 'DH': 'ด', 'F': 'ฟ', 'G': 'ก', 'HH': 'ฮ',
    'JH': 'จ', 'K': 'ค', 'L': 'ล', 'M': 'ม', 'N': 'น', 'NG': 'ง', 'P': 'พ',
    'R': 'ร', 'S': 'ส', 'SH': 'ช', 'T': 'ท', 'TH': 'ธ', 'V': 'ว', 'W': 'ว',
    'Y': 'ย', 'Z': 'ซ', 'ZH': 'ฉ',
}
# Vowels — emit with placeholder อ so each vowel reads as a standalone syllable.
ARPABET_VOWELS: dict[str, str] = {
    'AA': 'อา', 'AE': 'แอ', 'AH': 'อะ', 'AO': 'ออ', 'AW': 'อาว', 'AY': 'ไอ',
    'EH': 'เอ', 'ER': 'เออร์', 'EY': 'เอ', 'IH': 'อิ', 'IY': 'อี', 'OW': 'โอ',
    'OY': 'ออย', 'UH': 'อู', 'UW': 'อู',
}

# ============================================================
# User dict (editable)
# ============================================================
USER_DICT_PATH = Path(__file__).parent / "transliterate_user.json"

def list_user_dict() -> dict[str, str]:
    if not USER_DICT_PATH.exists():
        return {}
    try:
        raw = json.loads(USER_DICT_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}
    # Strip thanthakhat from any legacy entries
    cleaned = {k: _THANTHAKHAT_RE.sub("", v) for k, v in raw.items()}
    if cleaned != raw:
        try:
            USER_DICT_PATH.write_text(
                json.dumps(cleaned, ensure_ascii=False, indent=2, sort_keys=True),
                encoding="utf-8",
            )
        except Exception:
            pass
    return cleaned

def _save_user_dict(d: dict[str, str]) -> None:
    USER_DICT_PATH.write_text(
        json.dumps(d, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )

def add_user_entry(en: str, th: str) -> dict[str, str]:
    en = en.strip().lower()
    th = strip_thanthakhat(th.strip())
    if not en or not th:
        return list_user_dict()
    d = list_user_dict()
    d[en] = th
    _save_user_dict(d)
    return d

def remove_user_entry(en: str) -> dict[str, str]:
    en = en.strip().lower()
    d = list_user_dict()
    d.pop(en, None)
    _save_user_dict(d)
    return d

# ============================================================
# Settings (Gemini key, toggles)
# ============================================================
SETTINGS_PATH = Path(__file__).parent / "settings_local.json"

def load_settings() -> dict:
    if SETTINGS_PATH.exists():
        try:
            return json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}

def save_settings(d: dict) -> None:
    SETTINGS_PATH.write_text(
        json.dumps(d, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

def set_gemini_key(key: str) -> dict:
    s = load_settings()
    s["gemini_api_key"] = key.strip()
    save_settings(s)
    return s

def get_gemini_key() -> str:
    s = load_settings()
    return s.get("gemini_api_key", "") or os.environ.get("GEMINI_API_KEY", "")


def get_ollama_settings() -> dict:
    s = load_settings()
    return {
        "use_ollama": bool(s.get("use_ollama", False)),
        "url": (
            s.get("ollama_url")
            or os.environ.get("OLLAMA_URL")
            or "http://127.0.0.1:11434"
        ).rstrip("/"),
        "model": (
            s.get("ollama_model")
            or os.environ.get("OLLAMA_MODEL")
            or "qwen2.5:7b"
        ),
    }


def set_ollama_settings(use: bool, url: str, model: str) -> dict:
    s = load_settings()
    s["use_ollama"] = bool(use)
    if url and url.strip():
        s["ollama_url"] = url.strip()
    if model and model.strip():
        s["ollama_model"] = model.strip()
    save_settings(s)
    return s


def transliterate_via_ollama(words: list[str], timeout: int = 180) -> dict[str, str]:
    """Batch transliterate via local Ollama. Returns {word: thai} on success, {} on failure."""
    words = [w for w in words if w and w.strip()]
    if not words:
        return {}
    cfg = get_ollama_settings()
    if not cfg["use_ollama"]:
        return {}
    try:
        import requests
    except ImportError:
        print("[transliterate] requests not available")
        return {}
    url = f"{cfg['url']}/api/chat"
    prompt = _LLM_PROMPT.format(words_json=json.dumps(words, ensure_ascii=False))
    try:
        r = requests.post(
            url,
            json={
                "model": cfg["model"],
                "messages": [{"role": "user", "content": prompt}],
                "stream": False,
                "format": "json",
                "options": {"temperature": 0.0, "num_predict": 2048},
            },
            timeout=timeout,
        )
        r.raise_for_status()
        body = r.json()
        text = (body.get("message", {}) or {}).get("content", "").strip()
        if not text:
            return {}
        data = json.loads(text)
        if not isinstance(data, dict):
            return {}
        return {k: str(v).strip() for k, v in data.items() if str(v).strip()}
    except Exception as e:
        print(f"[transliterate] Ollama call failed: {e}")
        return {}


def ollama_status() -> tuple[bool, str]:
    """Return (ok, message) for current Ollama config."""
    cfg = get_ollama_settings()
    if not cfg["use_ollama"]:
        return False, "disabled"
    try:
        import requests
        r = requests.get(f"{cfg['url']}/api/tags", timeout=3)
        r.raise_for_status()
        tags = r.json().get("models", [])
        names = [t.get("name", "") for t in tags]
        if cfg["model"] not in names:
            return False, f"server up but model '{cfg['model']}' not pulled (available: {', '.join(names[:5])})"
        return True, f"ready · model={cfg['model']}"
    except Exception as e:
        return False, f"server unreachable: {e}"


# ============================================================
# Gemini backend
# ============================================================
_gemini_model = None
_gemini_key_cached = None

def _get_gemini():
    """Return a configured GenerativeModel, or None if unavailable / no key."""
    global _gemini_model, _gemini_key_cached
    key = get_gemini_key()
    if not key:
        return None
    if _gemini_model is not None and _gemini_key_cached == key:
        return _gemini_model
    try:
        import google.generativeai as genai
        genai.configure(api_key=key)
        _gemini_model = genai.GenerativeModel("gemini-2.0-flash-exp")
        _gemini_key_cached = key
        return _gemini_model
    except Exception as e:
        print(f"[transliterate] Gemini unavailable: {e}")
        _gemini_model = None
        return None


_LLM_PROMPT = """You spell each English word into Thai script PHONETICALLY — what a Thai TTS model will pronounce closest to the original English sound. PRIORITISE SOUND over orthographic correctness.

Style rules:
- Optimised for a Thai-text-to-speech model (F5-TTS). The output is read aloud, NOT read by humans.
- DO NOT use การันต์ "์" anywhere. If a silent consonant would normally take it, drop the consonant entirely.
- Drop silent letters and final consonants that a Thai TTS would over-pronounce.
- Use the simplest Thai vowel/tone that produces the right sound.
- It is OK to break Thai spelling rules if the resulting sound is closer to the English original.
- For acronyms (1–5 uppercase letters): spell each letter (AI→เอไอ, API→เอพีไอ).
- Examples of the style we want:
    "Sonnet"     → "ซอเหนด"
    "ChatGPT"    → "แชดจีพีที"
    "benchmarks" → "เบนมากส"
    "throughput" → "ทรูพุท"
    "iPhone"     → "ไอโฟน"
    "Generate"   → "เจเนอเรท"
    "Microsoft"  → "ไมโครซอฟ"
    "PowerPoint" → "พาวเวอพอย"

Output ONLY a JSON object {{en_word: thai_phonetic}}. No markdown. No commentary. Keep capitalisation of the keys exactly as given.

Words to transliterate:
{words_json}

JSON:"""

# Kept for backward-compat
_GEMINI_PROMPT = _LLM_PROMPT
_DEPRECATED_GEMINI_PROMPT = """You spell each English word into Thai script PHONETICALLY — what a Thai TTS model will pronounce closest to the original English sound. PRIORITISE SOUND over orthographic correctness.

Style rules:
- Optimised for a Thai-text-to-speech model (F5-TTS). The output is read aloud, NOT read by humans.
- Drop silent letters and final consonants that a Thai TTS would over-pronounce.
- Use the simplest Thai vowel/tone that produces the right sound. Avoid การันต์ (์) unless absolutely necessary.
- It is OK to break Thai spelling rules if the resulting sound is closer to the English original.
- For acronyms (1–5 uppercase letters): spell each letter (AI→เอไอ, API→เอพีไอ).
- Examples of the style we want:
    "Sonnet"     → "ซอเหนด"    (NOT "ซอนเน็ต" — the final 't' sound is dropped, 'นเหนด' lets the TTS keep the syllable open)
    "ChatGPT"    → "แชดจีพีที"
    "benchmarks" → "เบนมาคส์"
    "throughput" → "ทรูพุท"
    "iPhone"     → "ไอโฟน"
    "Generate"   → "เจเนอเรท"
    "Microsoft"  → "ไมโครซอฟ"

Output ONLY a JSON object {{en_word: thai_phonetic}}. No markdown. No commentary. Keep capitalisation of the keys exactly as given.

Words to transliterate:
{words_json}

JSON:"""

def transliterate_via_gemini(words: list[str], timeout: int = 12) -> dict[str, str]:
    """Batch transliterate via Gemini. Returns {word: thai}. Empty dict on failure."""
    words = [w for w in words if w and w.strip()]
    if not words:
        return {}
    model = _get_gemini()
    if model is None:
        return {}
    prompt = _GEMINI_PROMPT.format(words_json=json.dumps(words, ensure_ascii=False))
    try:
        resp = model.generate_content(
            prompt,
            generation_config={"temperature": 0.0, "response_mime_type": "application/json"},
            request_options={"timeout": timeout},
        )
        text = (getattr(resp, "text", None) or "").strip()
        if not text:
            return {}
        data = json.loads(text)
        if not isinstance(data, dict):
            return {}
        # ensure all values are strings
        return {k: str(v).strip() for k, v in data.items() if str(v).strip()}
    except Exception as e:
        print(f"[transliterate] Gemini call failed: {e}")
        return {}


# ============================================================
# g2p_en lazy loader
# ============================================================
_g2p = None
def _get_g2p():
    global _g2p
    if _g2p is None:
        try:
            from g2p_en import G2p
            _g2p = G2p()
        except Exception as e:
            print(f"[transliterate] g2p_en unavailable: {e}")
            _g2p = False
    return _g2p

# ============================================================
# Core
# ============================================================
def is_acronym(word: str) -> bool:
    """Treat 1–5 char all-uppercase token as an acronym (read letter-by-letter)."""
    return 1 <= len(word) <= 5 and word.isupper()

def transliterate_acronym(word: str) -> str:
    return "".join(ALPHABET_TH.get(c.lower(), c) for c in word)

def transliterate_g2p(word: str) -> str:
    g2p = _get_g2p()
    if not g2p:
        return word
    try:
        phs = g2p(word)
    except Exception:
        return word
    out: list[str] = []
    for p in phs:
        base = re.sub(r'[0-9]', '', str(p)).upper().strip()
        if not base:
            continue
        if base in ARPABET_VOWELS:
            out.append(ARPABET_VOWELS[base])
        elif base in ARPABET_CONS:
            out.append(ARPABET_CONS[base])
        # skip unknown
    return "".join(out) or word

# Match a contiguous English word (allow internal hyphen/dot/apostrophe inside letters)
_EN_RE = re.compile(r"[A-Za-z]+(?:[\-.'’][A-Za-z]+)*")

# Strip Thai thanthakhat (การันต์) "์" AND the consonant it sits on —
# F5-TTS-THAI mis-pronounces silent-letter syllables, and the user wants
# the silenced consonant gone too (e.g. "ไมโครซอฟท์" → "ไมโครซอฟ", not "ไมโครซอฟท").
# Pattern: any single Thai consonant followed immediately by ์ → drop both.
_THANTHAKHAT_PAIR_RE = re.compile(r"[ก-ฮ]์")
# Backup: any orphan ์ (no consonant before) → just drop it.
_THANTHAKHAT_RE = re.compile(r"์")

def strip_thanthakhat(text: str) -> str:
    if not text:
        return text
    text = _THANTHAKHAT_PAIR_RE.sub("", text)
    text = _THANTHAKHAT_RE.sub("", text)
    return text


def _lookup_dicts(core: str, user_dict: dict[str, str]) -> tuple[str | None, str]:
    """Return (thai, source) if found in user or built-in; otherwise (None, '')."""
    lc = core.lower()
    if lc in user_dict:
        return user_dict[lc], "user"
    if lc in BUILTIN_DICT:
        return BUILTIN_DICT[lc], "builtin"
    return None, ""


def transliterate_word(word: str, user_dict: dict[str, str] | None = None,
                        gemini_cache: dict[str, str] | None = None) -> str:
    """Convert single English token to Thai phonetic. (single-word, no Gemini call)
    Output has thanthakhat (์) stripped — F5-TTS-THAI mis-pronounces them."""
    if not word:
        return word
    core_match = re.search(r"[A-Za-z]+", word)
    if not core_match:
        return word
    core = core_match.group(0)

    if user_dict is None:
        user_dict = list_user_dict()
    hit, _ = _lookup_dicts(core, user_dict)
    if hit is None and gemini_cache and core.lower() in gemini_cache:
        hit = gemini_cache[core.lower()]
    if hit is None:
        hit = transliterate_acronym(core) if is_acronym(core) else transliterate_g2p(core)

    hit = strip_thanthakhat(hit)
    pre = word[:core_match.start()]
    post = word[core_match.end():]
    return pre + hit + post


def transliterate_text(text: str, user_dict: dict[str, str] | None = None,
                        use_llm: bool | None = None) -> str:
    """Replace every English word in `text` with its Thai phonetic form.
    If `use_llm` is True (default = follow settings), unknown words are
    batched to Ollama first (if enabled), then Gemini, and cached in user dict."""
    if not text:
        return text
    if user_dict is None:
        user_dict = list_user_dict()

    settings = load_settings()
    use_ollama = bool(settings.get("use_ollama", False))
    use_gemini = bool(settings.get("use_gemini", False))
    if use_llm is False:
        use_ollama = use_gemini = False

    # Collect unknown words once
    llm_cache: dict[str, str] = {}
    unknown: list[str] = []
    seen: set[str] = set()
    for m in _EN_RE.finditer(text):
        word = m.group(0)
        core_m = re.search(r"[A-Za-z]+", word)
        if not core_m:
            continue
        core = core_m.group(0)
        lc = core.lower()
        if lc in seen:
            continue
        seen.add(lc)
        hit, _ = _lookup_dicts(core, user_dict)
        if hit is not None or is_acronym(core):
            continue
        unknown.append(core)

    def _commit(results: dict[str, str]) -> dict[str, str]:
        if not results:
            return {}
        persistent = list_user_dict()
        ok: dict[str, str] = {}
        for k, v in results.items():
            lc = k.lower()
            v_clean = strip_thanthakhat(v)
            llm_cache[lc] = v_clean
            persistent[lc] = v_clean
            ok[lc] = v_clean
        _save_user_dict(persistent)
        return ok

    # Priority: Gemini first (best Thai quality) → Ollama fallback (offline)
    if unknown and use_gemini and get_gemini_key():
        ok = _commit(transliterate_via_gemini(unknown))
        if ok:
            unknown = [w for w in unknown if w.lower() not in ok]
            user_dict = list_user_dict()
    if unknown and use_ollama:
        _commit(transliterate_via_ollama(unknown))
        user_dict = list_user_dict()

    return _EN_RE.sub(
        lambda m: transliterate_word(m.group(0), user_dict, llm_cache),
        text,
    )


def preview_text(text: str, user_dict: dict[str, str] | None = None,
                  use_llm: bool | None = None) -> list[tuple[str, str, str]]:
    """Return [(english_word, thai_translit, source), ...] for each EN word.
    Triggers LLM call if enabled (and caches results)."""
    if user_dict is None:
        user_dict = list_user_dict()
    # Run transliterate_text once to populate LLM cache via user dict
    transliterate_text(text, user_dict=user_dict, use_llm=use_llm)
    user_dict = list_user_dict()

    results: list[tuple[str, str, str]] = []
    for m in _EN_RE.finditer(text):
        word = m.group(0)
        core = re.search(r"[A-Za-z]+", word).group(0)
        hit, src = _lookup_dicts(core, user_dict)
        if hit is None:
            if is_acronym(core):
                hit, src = transliterate_acronym(core), "acronym"
            else:
                hit, src = transliterate_g2p(core), "g2p"
        results.append((word, strip_thanthakhat(hit), src))
    return results


if __name__ == "__main__":
    samples = [
        "ผมจะมาสอนการใช้ ChatGPT สำหรับสร้างภาพ",
        "ใช้ AI Generate กี่วินาทีก็ได้",
        "Manage account ก็ลองจ่ายกันดู ChatGPT Plus เริ่มต้นที่ 600 บาท",
        "เปิด Excel แล้วเข้า Microsoft Word พร้อม PowerPoint",
        "TikTok กับ Instagram ก็ใช้ AI ทำ content ได้",
        "Anthropic เปิดตัว Claude 4 รุ่นใหม่",
    ]
    for s in samples:
        print(f"\nINPUT : {s}")
        print(f"OUTPUT: {transliterate_text(s)}")
        for word, tr, src in preview_text(s):
            print(f"   • [{src:7s}] {word!r} → {tr!r}")

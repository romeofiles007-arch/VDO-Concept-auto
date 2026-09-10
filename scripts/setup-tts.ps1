# สร้าง venv สำหรับ TTS — รันครั้งเดียว
# ใช้: powershell -ExecutionPolicy Bypass -File scripts\setup-tts.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

Write-Host '[1/4] ตรวจ Python 3.11' -ForegroundColor Cyan
$py = & py -3.11 --version 2>$null
if (-not $py) { throw 'ไม่พบ Python 3.11 — ลงจาก https://www.python.org/downloads/release/python-3119/ ก่อน' }
Write-Host "      $py"

Write-Host '[2/4] สร้าง venv ที่ tts\.venv' -ForegroundColor Cyan
if (-not (Test-Path 'tts\.venv')) { & py -3.11 -m venv tts\.venv }
$pip = 'tts\.venv\Scripts\pip.exe'
& $pip install --upgrade pip --quiet

Write-Host '[3/4] ลง PyTorch CUDA 12.8 (ไฟล์ใหญ่ ~2.5GB ใช้เวลาสักพัก)' -ForegroundColor Cyan
& $pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128

Write-Host '[4/4] ลง TTS engine' -ForegroundColor Cyan
& $pip install -r tts\requirements.txt

$check = & tts\.venv\Scripts\python.exe -c "import torch; print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU only')"
Write-Host "`nพร้อมแล้ว — GPU: $check" -ForegroundColor Green
Write-Host "ขั้นต่อไป: วางไฟล์เสียงต้นแบบ 10-15 วิ ที่ tts\voices\narrator_ref.wav"
Write-Host "แล้วใส่ข้อความที่พูดในไฟล์นั้นลงใน config\project.config.json -> tts.referenceText"

# ติดตั้งระบบเสียงของโปรเจกต์ (tts\.venv) — รันครั้งเดียวต่อเครื่อง
# ใช้: powershell -ExecutionPolicy Bypass -File scripts\setup-tts.ps1
#
# ได้ครบในที่เดียว ไม่ต้องมี Copy My Voice:
#   - สร้างเสียงไทยด้วย F5-TTS-THAI (การ์ดจอ NVIDIA)
#   - เทรนเสียงของตัวเอง
#   - ถอดเสียงด้วย Whisper (นำเข้าเสียงจากที่อื่น)
#   - เสียงออนไลน์ฟรี Edge TTS

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
# Python ตัวอื่นในเครื่อง (เช่น DaVinci Resolve) ตั้งตัวแปรพวกนี้ไว้ ทำให้ venv พัง
Remove-Item Env:PYTHONHOME, Env:PYTHONPATH -ErrorAction SilentlyContinue

Write-Host '[1/5] หา Python 3.10' -ForegroundColor Cyan
$pyCmd = $null
if ((& py -3.10 --version 2>$null) -match '3\.10') { $pyCmd = @('py', '-3.10') }
elseif (Get-Command uv -ErrorAction SilentlyContinue) {
  & uv python install 3.10
  $pyCmd = @('uv', 'run', '--python', '3.10', '--no-project', 'python')
}
if (-not $pyCmd) { throw 'ไม่พบ Python 3.10 — ลงจาก https://www.python.org/downloads/release/python-31011/ (ติ๊ก py launcher) แล้วรันใหม่' }
Write-Host "      ใช้ $($pyCmd -join ' ')"

Write-Host '[2/5] สร้าง tts\.venv' -ForegroundColor Cyan
if (-not (Test-Path 'tts\.venv\Scripts\python.exe')) {
  & $pyCmd[0] $pyCmd[1..($pyCmd.Length - 1)] -m venv tts\.venv
}
$py = Join-Path $root 'tts\.venv\Scripts\python.exe'
& $py -m pip install --upgrade pip --quiet

Write-Host '[3/5] ลง PyTorch CUDA 12.4 (ไฟล์ใหญ่ ~2.5GB)' -ForegroundColor Cyan
& $py -m pip install torch==2.4.1 torchaudio==2.4.1 --index-url https://download.pytorch.org/whl/cu124

Write-Host '[4/5] ลงระบบเสียง (F5-TTS-THAI, Whisper, Edge TTS)' -ForegroundColor Cyan
& $py -m pip install -r tts\requirements.txt

Write-Host '[5/5] ตรวจ' -ForegroundColor Cyan
$env:KMP_DUPLICATE_LIB_OK = 'TRUE'
& $py -c "import torch, f5_tts_th, faster_whisper, edge_tts; print('GPU:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'ไม่มี (จะช้ามาก)')"
if ($LASTEXITCODE -ne 0) { throw 'ติดตั้งไม่ครบ — ดูข้อความ error ด้านบน' }

Write-Host "`nระบบเสียงพร้อมแล้ว" -ForegroundColor Green
Write-Host 'เปิดแผงข้างของ extension → ขั้นที่ 3 เลือกเสียง Edge ได้ทันที หรือเทรนเสียงของตัวเอง'

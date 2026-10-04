# ติดตั้ง VoxCPM2 (โคลนเสียงของเรา อ่านไทยแม่นที่สุด) ลง tts\.venv-voxcpm — แยกจากระบบเสียงหลัก
# ต้องมี uv (https://docs.astral.sh/uv/) และการ์ดจอ NVIDIA (ใช้ VRAM ~8GB)
# โมเดล openbmb/VoxCPM2 (~5GB) ดาวน์โหลดเองตอนใช้ครั้งแรก
#
#   powershell -ExecutionPolicy Bypass -File scripts\setup-voxcpm.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$venv = Join-Path $root 'tts\.venv-voxcpm'
$python = Join-Path $venv 'Scripts\python.exe'
Remove-Item Env:PYTHONHOME -ErrorAction SilentlyContinue
Remove-Item Env:PYTHONPATH -ErrorAction SilentlyContinue
$env:UV_LINK_MODE = 'copy'

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  Write-Host 'ไม่พบ uv — ติดตั้งก่อน: powershell -c "irm https://astral.sh/uv/install.ps1 | iex"'
  exit 1
}
if (-not (Test-Path $python)) { uv venv --python 3.12 $venv }
uv pip install --python $python torch torchaudio --index-url https://download.pytorch.org/whl/cu126
uv pip install --python $python voxcpm soundfile
& $python -c "import torch, voxcpm; print('VoxCPM2 พร้อมใช้ · CUDA:', torch.cuda.is_available())"

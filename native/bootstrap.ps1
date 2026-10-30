# ตัวติดตั้งขั้นแรก — ติดตั้งครั้งแรก.bat เรียกไฟล์นี้ (ไฟล์นี้ต้องบันทึกเป็น UTF-8 แบบมี BOM ไม่งั้น PowerShell 5 อ่านภาษาไทยเพี้ยน)
#
# หน้าที่เดียว: หา Node.js 20+ ให้ได้ แล้วส่งต่อให้ native\install.mjs ทำที่เหลือทั้งหมด
#   1. runtime\node\node.exe ที่แถมมากับแพ็กเกจ
#   2. node ที่ลงไว้ในเครื่อง (ถ้ารุ่น 20 ขึ้นไป)
#   3. ไม่มีทั้งคู่ → ดาวน์โหลด Node.js LTS แบบ zip จาก nodejs.org (ตรวจ SHA256) วางที่ runtime\node — ไม่ต้องกด next
# ไม่แตะ PATH / registry ของระบบ ไม่ต้องใช้สิทธิ์ admin · รันซ้ำได้

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

function Show-Popup([string]$text, [string]$icon = 'Error') {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }
    [void][System.Windows.Forms.MessageBox]::Show($owner, $text, 'Cartoon Auto', 'OK', $icon)
  } catch {}
}

function Test-Node([string]$exe) {
  if (-not $exe -or -not (Test-Path -LiteralPath $exe)) { return $false }
  try {
    $major = & $exe -p "process.versions.node.split('.')[0]" 2>$null
    return ([int]$major -ge 20)
  } catch { return $false }
}

try {
  Write-Host 'Cartoon Auto — กำลังติดตั้ง ไม่ต้องกดอะไร รอจนขึ้นหน้าต่างสรุป'
  Write-Host ''

  # ไฟล์ที่แตกจาก zip ที่ดาวน์โหลดมามีป้าย "มาจากอินเทอร์เน็ต" — ปลดออกครั้งเดียว ไม่งั้น Windows ถามยืนยันทุกครั้งที่เปิดโปรแกรมในแพ็กเกจ
  $self = Join-Path $root 'ติดตั้งครั้งแรก.bat'
  if (Get-Item -LiteralPath $self -Stream Zone.Identifier -ErrorAction SilentlyContinue) {
    Write-Host '▸ ปลดป้าย "ไฟล์จากอินเทอร์เน็ต" ของไฟล์ในโฟลเดอร์นี้'
    Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue
  }

  $node = Join-Path $root 'runtime\node\node.exe'
  if (Test-Node $node) {
    Write-Host '✓ Node.js (ในโฟลเดอร์ runtime)'
  } else {
    $sys = (Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    if (Test-Node $sys) {
      $node = $sys
      Write-Host "✓ Node.js ในเครื่อง ($sys)"
    } else {
      Write-Host '▸ ดาวน์โหลด Node.js (~30 MB) — ครั้งแรกครั้งเดียว'
      [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
      $base = 'https://nodejs.org/dist/latest-v24.x/'
      $sums = [string](Invoke-WebRequest -UseBasicParsing -Uri ($base + 'SHASUMS256.txt')).Content
      $line = ($sums -split "`n" | Where-Object { $_ -match '\snode-v[\d.]+-win-x64\.zip\s*$' } | Select-Object -First 1)
      if (-not $line) { throw 'หาไฟล์ Node.js สำหรับ Windows ใน nodejs.org ไม่เจอ' }
      $hash, $file = $line.Trim() -split '\s+'
      $tmp = Join-Path $env:TEMP ('cartoon-node-' + [guid]::NewGuid().ToString('N'))
      New-Item -ItemType Directory -Path $tmp | Out-Null
      try {
        $zip = Join-Path $tmp $file
        Invoke-WebRequest -UseBasicParsing -Uri ($base + $file) -OutFile $zip
        if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne $hash.ToUpper()) { throw 'ไฟล์ Node.js ที่ดาวน์โหลดเสีย (SHA256 ไม่ตรง) — ลองใหม่อีกครั้ง' }
        Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
        $exe = Get-ChildItem -LiteralPath $tmp -Recurse -Filter node.exe | Select-Object -First 1
        if (-not $exe) { throw 'แตกไฟล์ Node.js แล้วไม่พบ node.exe' }
        New-Item -ItemType Directory -Path (Split-Path -Parent $node) -Force | Out-Null
        Copy-Item -LiteralPath $exe.FullName -Destination $node -Force
      } finally {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
      }
      if (-not (Test-Node $node)) { throw 'ลง Node.js แล้วแต่รันไม่ได้ (โปรแกรมป้องกันไวรัสอาจบล็อก runtime\node\node.exe)' }
      Write-Host "✓ Node.js $file"
    }
  }

  & $node (Join-Path $root 'native\install.mjs') @args
  exit $LASTEXITCODE
} catch {
  $msg = $_.Exception.Message
  Write-Host ''
  Write-Host "✗ ติดตั้งไม่สำเร็จ: $msg"
  if ($args -notcontains '--quiet') {
    Show-Popup ("ติดตั้งไม่สำเร็จ`n`n$msg`n`nตรวจว่าต่ออินเทอร์เน็ตอยู่ แล้วดับเบิลคลิก ติดตั้งครั้งแรก.bat อีกครั้ง")
  }
  exit 1
}

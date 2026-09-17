# Rebuild deterministic toolbar PNGs; no external tools or network required.
Add-Type -AssemblyName System.Drawing
$iconOutput = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../extension/icons'))
[IO.Directory]::CreateDirectory($iconOutput) | Out-Null
$accentBrush = New-Object Drawing.SolidBrush ([Drawing.ColorTranslator]::FromHtml('#d9481c'))
$creamBrush = New-Object Drawing.SolidBrush ([Drawing.ColorTranslator]::FromHtml('#fffdf8'))

function RoundedPath([single]$x, [single]$y, [single]$w, [single]$h, [single]$radius) {
  $path = New-Object Drawing.Drawing2D.GraphicsPath
  $diameter = $radius * 2
  $path.AddArc($x, $y, $diameter, $diameter, 180, 90)
  $path.AddArc($x + $w - $diameter, $y, $diameter, $diameter, 270, 90)
  $path.AddArc($x + $w - $diameter, $y + $h - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($x, $y + $h - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

try {
  foreach ($size in @(16, 32, 48, 128)) {
    $canvas = New-Object Drawing.Bitmap 512, 512
    $graphics = [Drawing.Graphics]::FromImage($canvas)
    $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.ScaleTransform(4, 4)
    $background = RoundedPath 0 0 128 128 28
    $bubble = RoundedPath 23 29 82 60 7
    $graphics.FillPath($accentBrush, $background)
    $graphics.FillPath($creamBrush, $bubble)
    $graphics.FillPolygon($creamBrush, [Drawing.PointF[]]@(
      [Drawing.PointF]::new(42, 88), [Drawing.PointF]::new(61, 88), [Drawing.PointF]::new(42, 103)
    ))
    $graphics.FillPolygon($accentBrush, [Drawing.PointF[]]@(
      [Drawing.PointF]::new(54, 44), [Drawing.PointF]::new(79, 59), [Drawing.PointF]::new(54, 74)
    ))
    $png = New-Object Drawing.Bitmap $size, $size
    $resize = [Drawing.Graphics]::FromImage($png)
    $resize.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $resize.DrawImage($canvas, 0, 0, $size, $size)
    $png.Save((Join-Path $iconOutput "icon-$size.png"), [Drawing.Imaging.ImageFormat]::Png)
    $resize.Dispose()
    $png.Dispose()
    $background.Dispose()
    $bubble.Dispose()
    $graphics.Dispose()
    $canvas.Dispose()
    Write-Output "Created icon-$size.png"
  }
} finally {
  $accentBrush.Dispose()
  $creamBrush.Dispose()
}

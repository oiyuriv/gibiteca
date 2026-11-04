# Gera os ícones PNG da Gibiteca: fundo vermelho com retícula, "G" amarelo de quadrinho com contorno preto.
Add-Type -AssemblyName System.Drawing
$out = Join-Path $PSScriptRoot 'icons'
New-Item -ItemType Directory -Force $out | Out-Null

function New-Icon([int]$s, [string]$path) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

  # fundo vermelho com degradê
  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush (New-Object System.Drawing.PointF 0, 0), (New-Object System.Drawing.PointF $s, $s), ([System.Drawing.Color]::FromArgb(255, 240, 72, 82)), ([System.Drawing.Color]::FromArgb(255, 176, 26, 44))
  $g.FillRectangle($bg, 0, 0, $s, $s)

  # retícula (pontinhos de gibi antigo), mais fortes no canto de baixo
  $step = $s / 14.0
  for ($y = 0; $y -lt 15; $y++) {
    for ($x = 0; $x -lt 15; $x++) {
      $cx = $x * $step + (($y % 2) * $step / 2)
      $cy = $y * $step
      $k = (($cx + $cy) / (2 * $s))
      $r = $step * 0.36 * $k
      if ($r -gt 0.6) {
        $b = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(70, 90, 0, 10))
        $g.FillEllipse($b, [single]($cx - $r), [single]($cy - $r), [single](2 * $r), [single](2 * $r))
        $b.Dispose()
      }
    }
  }

  # explosão amarela atrás da letra
  $burst = New-Object System.Drawing.Drawing2D.GraphicsPath
  $pts = @()
  $n = 14
  for ($i = 0; $i -lt (2 * $n); $i++) {
    $ang = [Math]::PI * $i / $n - [Math]::PI / 2
    $rad = if ($i % 2 -eq 0) { 0.47 * $s } else { 0.36 * $s }
    $pts += New-Object System.Drawing.PointF ([single](0.5 * $s + $rad * [Math]::Cos($ang))), ([single](0.52 * $s + $rad * [Math]::Sin($ang)))
  }
  $burst.AddPolygon($pts)
  $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 255, 255, 255))), $burst)
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::Black), ([single](0.022 * $s))
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $g.DrawPath($pen, $burst)

  # "G"
  $fam = New-Object System.Drawing.FontFamily 'Impact'
  $txt = New-Object System.Drawing.Drawing2D.GraphicsPath
  $fmt = [System.Drawing.StringFormat]::GenericTypographic
  $txt.AddString('G', $fam, 0, [single](0.56 * $s), (New-Object System.Drawing.PointF 0, 0), $fmt)
  $bd = $txt.GetBounds()
  $m = New-Object System.Drawing.Drawing2D.Matrix
  $m.Translate([single]((($s - $bd.Width) / 2) - $bd.X), [single]((0.52 * $s - $bd.Height / 2) - $bd.Y))
  $txt.Transform($m)
  $rot = New-Object System.Drawing.Drawing2D.Matrix
  $rot.RotateAt(-6, (New-Object System.Drawing.PointF ([single](0.5 * $s)), ([single](0.52 * $s))))
  $txt.Transform($rot)

  # sombra preta deslocada
  $sh = $txt.Clone()
  $ms = New-Object System.Drawing.Drawing2D.Matrix
  $ms.Translate([single](0.03 * $s), [single](0.03 * $s))
  $sh.Transform($ms)
  $g.FillPath([System.Drawing.Brushes]::Black, $sh)

  $yellow = New-Object System.Drawing.Drawing2D.LinearGradientBrush (New-Object System.Drawing.PointF 0, ([single](0.25 * $s))), (New-Object System.Drawing.PointF 0, ([single](0.8 * $s))), ([System.Drawing.Color]::FromArgb(255, 255, 228, 92)), ([System.Drawing.Color]::FromArgb(255, 255, 184, 28))
  $g.FillPath($yellow, $txt)
  $pen2 = New-Object System.Drawing.Pen ([System.Drawing.Color]::Black), ([single](0.026 * $s))
  $pen2.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $g.DrawPath($pen2, $txt)

  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}

New-Icon 180 (Join-Path $out 'icon-180.png')
New-Icon 192 (Join-Path $out 'icon-192.png')
New-Icon 512 (Join-Path $out 'icon-512.png')
Write-Host 'Ícones gerados em' $out

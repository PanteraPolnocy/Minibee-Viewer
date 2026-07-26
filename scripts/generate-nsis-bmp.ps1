# Generates NSIS and WiX installer bitmaps for Minibee Viewer.
# Optional master art: src-tauri/icons/nsis/source.png (shared by both installers).
#
#   powershell -ExecutionPolicy Bypass -File scripts/generate-nsis-bmp.ps1
#
# NSIS (24-bit BMP):
#   src-tauri/icons/nsis/header.bmp           150 x 57
#   src-tauri/icons/nsis/sidebar.bmp          164 x 314
#   src-tauri/icons/nsis/uninstall-header.bmp 150 x 57
#
# WiX MSI (24-bit BMP):
#   src-tauri/icons/wix/banner.bmp            493 x 58
#   src-tauri/icons/wix/dialog.bmp            493 x 312

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$repoRoot = Split-Path -Parent $PSScriptRoot
$nsisDir = Join-Path $repoRoot 'src-tauri/icons/nsis'
$wixDir = Join-Path $repoRoot 'src-tauri/icons/wix'
$sourceCandidates = @(
    (Join-Path $nsisDir 'source.png'),
    (Join-Path $wixDir 'source.png'),
    (Join-Path $repoRoot 'src-tauri/icons/icon.png'),
    (Join-Path $repoRoot 'src-tauri/icons/Square310x310Logo.png')
)

$source = $sourceCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $source) {
    throw 'No source image found. Add src-tauri/icons/nsis/source.png or keep icon.png in place.'
}

New-Item -ItemType Directory -Force -Path $nsisDir | Out-Null
New-Item -ItemType Directory -Force -Path $wixDir | Out-Null

function New-Font {
    param(
        [double]$Size,
        [System.Drawing.FontStyle]$Style = [System.Drawing.FontStyle]::Regular
    )
    return New-Object System.Drawing.Font('Segoe UI', $Size, $Style, [System.Drawing.GraphicsUnit]::Point)
}

function Get-FittingFont {
    param(
        [System.Drawing.Graphics]$Graphics,
        [string]$Text,
        [double]$MaxWidth,
        [double]$StartSize = 9,
        [double]$MinSize = 6.5,
        [System.Drawing.FontStyle]$Style = [System.Drawing.FontStyle]::Bold
    )

    $size = $StartSize
    while ($size -ge $MinSize) {
        $font = New-Font -Size $size -Style $Style
        $measured = $Graphics.MeasureString($Text, $font)
        $font.Dispose()
        if ($measured.Width -le $MaxWidth) {
            return New-Font -Size $size -Style $Style
        }
        $size -= 0.5
    }
    return New-Font -Size $MinSize -Style $Style
}

function Draw-WrappedText {
    param(
        [System.Drawing.Graphics]$Graphics,
        [string]$Text,
        [System.Drawing.Font]$Font,
        [System.Drawing.Brush]$Brush,
        [float]$X,
        [float]$Y,
        [float]$Width,
        [float]$Height
    )

    $rect = New-Object System.Drawing.RectangleF $X, $Y, $Width, $Height
    $format = New-Object System.Drawing.StringFormat
    $format.Trimming = [System.Drawing.StringTrimming]::EllipsisWord
    $format.FormatFlags = [System.Drawing.StringFormatFlags]::LineLimit
    $Graphics.DrawString($Text, $Font, $Brush, $rect, $format)
    $format.Dispose()
}

function New-InstallerBitmap {
    param(
        [string]$Destination,
        [int]$Width,
        [int]$Height,
        [string]$Mode
    )

    $bgTop = [System.Drawing.Color]::FromArgb(255, 22, 18, 12)
    $bgBottom = [System.Drawing.Color]::FromArgb(255, 35, 28, 18)
    $accent = [System.Drawing.Color]::FromArgb(255, 240, 180, 41)

    $bitmap = New-Object System.Drawing.Bitmap $Width, $Height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush (
        (New-Object System.Drawing.Rectangle 0, 0, $Width, $Height),
        $bgTop,
        $bgBottom,
        90
    )
    $graphics.FillRectangle($brush, 0, 0, $Width, $Height)
    $brush.Dispose()

    $sourceImage = [System.Drawing.Image]::FromFile($source)
    try {
        if ($Mode -eq 'sidebar') {
            $padX = 12
            $padY = 16
            $textWidth = $Width - (2 * $padX)
            $iconBoxH = [int]($Height * 0.34)
            $scale = [Math]::Min(($textWidth) / $sourceImage.Width, $iconBoxH / $sourceImage.Height)
            $drawW = [int]($sourceImage.Width * $scale)
            $drawH = [int]($sourceImage.Height * $scale)
            $x = [int](($Width - $drawW) / 2)
            $y = $padY
            $graphics.DrawImage($sourceImage, $x, $y, $drawW, $drawH)

            $textTop = $y + $drawH + 14
            $textHeight = $Height - $textTop - 14

            $titleFont = Get-FittingFont -Graphics $graphics -Text 'Minibee Viewer' -MaxWidth $textWidth -StartSize 10.5 -MinSize 8.5
            $titleBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 255, 232, 170))
            Draw-WrappedText -Graphics $graphics -Text 'Minibee Viewer' -Font $titleFont -Brush $titleBrush -X $padX -Y $textTop -Width $textWidth -Height 24

            $bodyTop = $textTop + 24
            $bodyHeight = $textHeight - 24
            $bodyFont = New-Font -Size 7.5
            $bodyBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 196, 176, 140))
            Draw-WrappedText -Graphics $graphics -Text 'A lightweight buzz into the infinite grid.' -Font $bodyFont -Brush $bodyBrush -X $padX -Y $bodyTop -Width $textWidth -Height $bodyHeight

            $graphics.FillRectangle((New-Object System.Drawing.SolidBrush $accent), 0, ($Height - 5), $Width, 5)
            $titleFont.Dispose(); $bodyFont.Dispose(); $titleBrush.Dispose(); $bodyBrush.Dispose()
        }
        elseif ($Mode -eq 'wix-dialog') {
            $padX = 28
            $padY = 24
            $textWidth = $Width - (2 * $padX)
            $iconBoxH = [int]($Height * 0.36)
            $scale = [Math]::Min($textWidth / $sourceImage.Width, $iconBoxH / $sourceImage.Height)
            $drawW = [int]($sourceImage.Width * $scale)
            $drawH = [int]($sourceImage.Height * $scale)
            $x = [int](($Width - $drawW) / 2)
            $y = $padY
            $graphics.DrawImage($sourceImage, $x, $y, $drawW, $drawH)

            $textTop = $y + $drawH + 20
            $titleFont = New-Font -Size 18 -Style ([System.Drawing.FontStyle]::Bold)
            $titleBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 255, 232, 170))
            Draw-WrappedText -Graphics $graphics -Text 'Minibee Viewer' -Font $titleFont -Brush $titleBrush -X $padX -Y $textTop -Width $textWidth -Height 34

            $bodyTop = $textTop + 36
            $bodyHeight = $Height - $bodyTop - 20
            $bodyFont = New-Font -Size 11
            $bodyBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 196, 176, 140))
            Draw-WrappedText -Graphics $graphics -Text 'A lightweight buzz into the infinite grid.' -Font $bodyFont -Brush $bodyBrush -X $padX -Y $bodyTop -Width $textWidth -Height $bodyHeight

            $graphics.FillRectangle((New-Object System.Drawing.SolidBrush $accent), 0, ($Height - 6), $Width, 6)
            $titleFont.Dispose(); $bodyFont.Dispose(); $titleBrush.Dispose(); $bodyBrush.Dispose()
        }
        elseif ($Mode -eq 'wix-banner') {
            $padX = 16
            $iconSize = [int]($Height - 12)
            $scale = [Math]::Min($iconSize / $sourceImage.Width, $iconSize / $sourceImage.Height)
            $drawW = [int]($sourceImage.Width * $scale)
            $drawH = [int]($sourceImage.Height * $scale)
            $x = $padX
            $y = [int](($Height - $drawH) / 2)
            $graphics.DrawImage($sourceImage, $x, $y, $drawW, $drawH)

            $textX = $x + $drawW + 14
            $textWidth = $Width - $textX - 16
            $titleFont = New-Font -Size 13 -Style ([System.Drawing.FontStyle]::Bold)
            $titleBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 255, 232, 170))
            $titleY = [int](($Height - 18) / 2) - 1
            $graphics.DrawString('Minibee Viewer', $titleFont, $titleBrush, $textX, $titleY)

            $graphics.FillRectangle((New-Object System.Drawing.SolidBrush $accent), 0, ($Height - 4), $Width, 4)
            $titleFont.Dispose(); $titleBrush.Dispose()
        }
        else {
            $padX = 8
            $iconSize = [int]($Height - 10)
            $scale = [Math]::Min($iconSize / $sourceImage.Width, $iconSize / $sourceImage.Height)
            $drawW = [int]($sourceImage.Width * $scale)
            $drawH = [int]($sourceImage.Height * $scale)
            $x = $padX
            $y = [int](($Height - $drawH) / 2)
            $graphics.DrawImage($sourceImage, $x, $y, $drawW, $drawH)

            $label = if ($Mode -eq 'uninstall') { 'Uninstall' } else { 'Setup' }
            $textX = $x + $drawW + 6
            $textWidth = $Width - $textX - 4
            $font = Get-FittingFont -Graphics $graphics -Text $label -MaxWidth $textWidth -StartSize 8.5 -MinSize 7
            $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 255, 232, 170))
            $measured = $graphics.MeasureString($label, $font)
            $textY = [int](($Height - $measured.Height) / 2)
            $graphics.DrawString($label, $font, $brush, $textX, $textY)
            $font.Dispose(); $brush.Dispose()
        }
    }
    finally {
        $sourceImage.Dispose()
    }

    $graphics.Dispose()
    $bitmap.Save($Destination, [System.Drawing.Imaging.ImageFormat]::Bmp)
    $bitmap.Dispose()
}

New-InstallerBitmap -Destination (Join-Path $nsisDir 'header.bmp') -Width 150 -Height 57 -Mode 'header'
New-InstallerBitmap -Destination (Join-Path $nsisDir 'sidebar.bmp') -Width 164 -Height 314 -Mode 'sidebar'
New-InstallerBitmap -Destination (Join-Path $nsisDir 'uninstall-header.bmp') -Width 150 -Height 57 -Mode 'uninstall'
New-InstallerBitmap -Destination (Join-Path $wixDir 'banner.bmp') -Width 493 -Height 58 -Mode 'wix-banner'
New-InstallerBitmap -Destination (Join-Path $wixDir 'dialog.bmp') -Width 493 -Height 312 -Mode 'wix-dialog'

Write-Host "Generated installer bitmaps from $source"
Write-Host "  NSIS -> $nsisDir"
Write-Host "  WiX  -> $wixDir"

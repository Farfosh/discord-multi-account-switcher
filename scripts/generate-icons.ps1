[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$IconDirectory = Join-Path $ProjectRoot 'extension\icons'
New-Item -ItemType Directory -Path $IconDirectory -Force | Out-Null

function New-RoundedPath {
    param(
        [System.Drawing.RectangleF]$Rectangle,
        [float]$Radius
    )

    $Diameter = $Radius * 2
    $Path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $Path.AddArc($Rectangle.X, $Rectangle.Y, $Diameter, $Diameter, 180, 90)
    $Path.AddArc($Rectangle.Right - $Diameter, $Rectangle.Y, $Diameter, $Diameter, 270, 90)
    $Path.AddArc($Rectangle.Right - $Diameter, $Rectangle.Bottom - $Diameter, $Diameter, $Diameter, 0, 90)
    $Path.AddArc($Rectangle.X, $Rectangle.Bottom - $Diameter, $Diameter, $Diameter, 90, 90)
    $Path.CloseFigure()
    return $Path
}

foreach ($Size in @(16, 32, 48, 128)) {
    $Bitmap = New-Object System.Drawing.Bitmap($Size, $Size)
    $Graphics = [System.Drawing.Graphics]::FromImage($Bitmap)
    $Graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $Graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $Graphics.Clear([System.Drawing.Color]::Transparent)

    $Inset = [Math]::Max(1, [Math]::Round($Size * 0.035))
    $Rectangle = New-Object System.Drawing.RectangleF(
        [float]$Inset,
        [float]$Inset,
        [float]($Size - ($Inset * 2)),
        [float]($Size - ($Inset * 2))
    )
    $Path = New-RoundedPath -Rectangle $Rectangle -Radius ([float]($Size * 0.25))
    $StartColor = [System.Drawing.Color]::FromArgb(255, 142, 125, 255)
    $EndColor = [System.Drawing.Color]::FromArgb(255, 87, 70, 223)
    $Brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $Rectangle,
        $StartColor,
        $EndColor,
        45.0
    )
    $Graphics.FillPath($Brush, $Path)

    $Font = New-Object System.Drawing.Font(
        'Segoe UI',
        [float]($Size * 0.50),
        [System.Drawing.FontStyle]::Bold,
        [System.Drawing.GraphicsUnit]::Pixel
    )
    $TextBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $TextSize = $Graphics.MeasureString('D', $Font)
    $TextX = ($Size - $TextSize.Width) / 2
    $TextY = (($Size - $TextSize.Height) / 2) - ($Size * 0.018)
    $Graphics.DrawString('D', $Font, $TextBrush, [float]$TextX, [float]$TextY)

    $OutputPath = Join-Path $IconDirectory ("icon$Size.png")
    $Bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)

    $TextBrush.Dispose()
    $Font.Dispose()
    $Brush.Dispose()
    $Path.Dispose()
    $Graphics.Dispose()
    $Bitmap.Dispose()
}

Write-Host 'Extension icons generated.' -ForegroundColor Green

param([string]$Jobs)
# Crops many rectangles out of PNG screenshots in one go. $Jobs is a JSON file:
#   [{ "src": "...png", "dst": "...png", "x": 0, "y": 0, "w": 10, "h": 10, "flat": "#D9D9D9" }, ...]
# Used by capture-cars.js; one process for a whole page keeps the capture quick.
# flat: the game's list cards shade their picture darker towards the bottom; each row's background
# (the colour at its left edge) is replaced by this one, so the picture sits on one flat grey.
function Flatten($bmp, $hex) {
    $flat = [System.Drawing.ColorTranslator]::FromHtml($hex)
    for ($y = 0; $y -lt $bmp.Height; $y++) {
        $bg = $bmp.GetPixel(1, $y)
        if ($bg.R -eq $flat.R -and $bg.G -eq $flat.G -and $bg.B -eq $flat.B) { continue }
        if ([math]::Abs($bg.R - $bg.G) -gt 2 -or [math]::Abs($bg.G - $bg.B) -gt 2) { continue }
        for ($x = 0; $x -lt $bmp.Width; $x++) {
            $p = $bmp.GetPixel($x, $y)
            if ([math]::Abs($p.R - $bg.R) -le 2 -and [math]::Abs($p.G - $bg.G) -le 2 -and [math]::Abs($p.B - $bg.B) -le 2) { $bmp.SetPixel($x, $y, $flat) }
        }
    }
}
Add-Type -AssemblyName System.Drawing
$list = Get-Content -Raw -Encoding UTF8 $Jobs | ConvertFrom-Json
$open = @{}
try {
    foreach ($j in $list) {
        if (-not $open.ContainsKey($j.src)) { $open[$j.src] = [System.Drawing.Image]::FromFile($j.src) }
        $img = $open[$j.src]
        $out = New-Object System.Drawing.Bitmap ([int]$j.w), ([int]$j.h)
        $g = [System.Drawing.Graphics]::FromImage($out)
        $g.DrawImage($img, (New-Object System.Drawing.Rectangle 0, 0, ([int]$j.w), ([int]$j.h)), (New-Object System.Drawing.Rectangle ([int]$j.x), ([int]$j.y), ([int]$j.w), ([int]$j.h)), [System.Drawing.GraphicsUnit]::Pixel)
        $g.Dispose()
        if ($j.flat) { Flatten $out $j.flat }
        $out.Save($j.dst, [System.Drawing.Imaging.ImageFormat]::Png)
        $out.Dispose()
    }
} finally {
    foreach ($i in $open.Values) { $i.Dispose() }
}

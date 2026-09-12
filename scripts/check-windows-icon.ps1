param(
  [Parameter(Mandatory = $true)][string]$FilePath,
  [string]$SourcePng
)

$ErrorActionPreference = 'Stop'
$resolvedIconFile = (Resolve-Path -LiteralPath $FilePath).Path
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SlyorrentIconCheck {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, EntryPoint = "ExtractIconExW")]
  public static extern uint Extract(string file, int index, out IntPtr large, out IntPtr small, uint count);
  [DllImport("user32.dll")]
  public static extern bool DestroyIcon(IntPtr icon);
}
'@

$largeIconHandle = [IntPtr]::Zero
$smallIconHandle = [IntPtr]::Zero
try {
  $extractedIconCount = [SlyorrentIconCheck]::Extract($resolvedIconFile, 0, [ref]$largeIconHandle, [ref]$smallIconHandle, 1)
  if ($extractedIconCount -eq 0 -or $largeIconHandle -eq [IntPtr]::Zero -or $smallIconHandle -eq [IntPtr]::Zero) {
    throw 'Windows cannot extract the application icons.'
  }
  if ($SourcePng) {
    Add-Type -AssemblyName System.Drawing
    $sourceBitmap = [System.Drawing.Bitmap]::FromFile((Resolve-Path -LiteralPath $SourcePng).Path)
    try {
      $transparentSamples = 0
      $visibleSamples = 0
      for ($sampleY = 0; $sampleY -lt $sourceBitmap.Height; $sampleY += [Math]::Max(1, [int]($sourceBitmap.Height / 64))) {
        for ($sampleX = 0; $sampleX -lt $sourceBitmap.Width; $sampleX += [Math]::Max(1, [int]($sourceBitmap.Width / 64))) {
          $alpha = $sourceBitmap.GetPixel($sampleX, $sampleY).A
          if ($alpha -eq 0) { $transparentSamples++ }
          if ($alpha -ge 240) { $visibleSamples++ }
        }
      }
      if ($transparentSamples -lt 10 -or $visibleSamples -lt 10) { throw 'The logo must contain real transparency and visible artwork.' }
      foreach ($corner in @(@(0.12, 0.12), @(0.88, 0.12), @(0.12, 0.88), @(0.88, 0.88))) {
        $pixel = $sourceBitmap.GetPixel([int]($sourceBitmap.Width * $corner[0]), [int]($sourceBitmap.Height * $corner[1]))
        if ($pixel.A -ne 0) { throw 'The rounded corners must be transparent.' }
      }
      foreach ($beakY in @(0.55, 0.60, 0.65)) {
        $pixel = $sourceBitmap.GetPixel([int]($sourceBitmap.Width * 0.5), [int]($sourceBitmap.Height * $beakY))
        if ($pixel.A -ne 255 -or $pixel.R -ne 255 -or $pixel.G -ne 255 -or $pixel.B -ne 255) { throw 'The owl face must be white where the beak was removed.' }
      }
    }
    finally { $sourceBitmap.Dispose() }
  }
  [pscustomobject]@{ File = [IO.Path]::GetFileName($resolvedIconFile); LargeIcon = $true; SmallIcon = $true; AlphaChecked = [bool]$SourcePng; RoundedCornersChecked = [bool]$SourcePng; BeakRemovedChecked = [bool]$SourcePng } | ConvertTo-Json -Compress
}
finally {
  if ($largeIconHandle -ne [IntPtr]::Zero) { [void][SlyorrentIconCheck]::DestroyIcon($largeIconHandle) }
  if ($smallIconHandle -ne [IntPtr]::Zero) { [void][SlyorrentIconCheck]::DestroyIcon($smallIconHandle) }
}

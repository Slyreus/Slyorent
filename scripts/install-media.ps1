[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if ($PSVersionTable.PSEdition -eq 'Desktop') {
    $trustedModules = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\Modules'
    $env:PSModulePath = $trustedModules
    Import-Module (Join-Path $trustedModules 'Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -Force
    Import-Module (Join-Path $trustedModules 'Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -Force
}

$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtime = Join-Path $repository '.runtime'
$media = Join-Path $runtime 'media\ffmpeg-9.0.2'
$archive = Join-Path $runtime 'downloads\ffmpeg-9.0.2-essentials_build.zip'
$archiveHash = '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba'
$source = 'https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip'
$files = @(
    @{ Entry='bin/ffmpeg.exe'; Name='ffmpeg.exe'; Hash='3256173f3f8bffd7df12227c68adf68025edb1832273a9530688a7bb1ed8edec' },
    @{ Entry='bin/ffprobe.exe'; Name='ffprobe.exe'; Hash='f0d36ecbbdd3bcfac3efa078c96c7271c2e68b3810595552ac3b7f17e9a65c52' },
    @{ Entry='LICENSE'; Name='LICENSE.txt'; Hash='8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903' },
    @{ Entry='README.txt'; Name='README.txt'; Hash='0342de6bb39dd421cbec2c00d89ad274b640d75ad3f2cab09ffd647ce2d8f949' }
)

function Assert-PrivateRuntimePath([string]$target) {
    $absolute = [IO.Path]::GetFullPath($target)
    if (-not $absolute.StartsWith($runtime + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Chemin hors du runtime.' }
    $cursor = $absolute
    while ($cursor.Length -ge $runtime.Length) {
        if (Test-Path -LiteralPath $cursor) {
            if (((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Lien interdit dans le runtime.' }
        }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
}
function Test-Hash([string]$file, [string]$expected) {
    return (Test-Path -LiteralPath $file -PathType Leaf) -and ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -eq $expected)
}
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitOperatingSystem) { throw 'Le moteur media exige Windows x64.' }
Assert-PrivateRuntimePath $media
Assert-PrivateRuntimePath $archive
New-Item -ItemType Directory -Path $media -Force | Out-Null
New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($archive)) -Force | Out-Null

$complete = $true
foreach ($item in $files) {
    $target = Join-Path $media $item.Name
    Assert-PrivateRuntimePath $target
    if (-not (Test-Hash $target $item.Hash)) { $complete = $false }
}
if ($complete) { Write-Host 'FFmpeg et FFprobe 9.0.2 deja presents et verifies.'; exit 0 }
if (-not (Test-Hash $archive $archiveHash)) {
    $partial = $archive + '.download'
    Assert-PrivateRuntimePath $partial
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $source -OutFile $partial -UseBasicParsing
    if (-not (Test-Hash $partial $archiveHash)) { throw 'Empreinte de l archive FFmpeg invalide.' }
    Move-Item -LiteralPath $partial -Destination $archive -Force
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
    foreach ($item in $files) {
        $target = Join-Path $media $item.Name
        Assert-PrivateRuntimePath $target
        if (Test-Hash $target $item.Hash) { continue }
        if (Test-Path -LiteralPath $target) { throw ('Fichier media inattendu : ' + $item.Name) }
        $entry = $zip.GetEntry('ffmpeg-9.0.2-essentials_build/' + $item.Entry)
        if ($null -eq $entry) { throw ('Entree media absente : ' + $item.Name) }
        $temporary = $target + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
        Assert-PrivateRuntimePath $temporary
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $temporary)
        if (-not (Test-Hash $temporary $item.Hash)) { Remove-Item -LiteralPath $temporary; throw ('Empreinte media invalide : ' + $item.Name) }
        Move-Item -LiteralPath $temporary -Destination $target
    }
} finally { $zip.Dispose() }
Write-Host 'FFmpeg et FFprobe 9.0.2 installes et verifies.'

[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtime = Join-Path $repository '.runtime'
$work = Join-Path $runtime 'openssl-build'
$output = Join-Path $runtime 'openssl-output'
$artifacts = Join-Path $runtime 'artifacts'
foreach ($directory in @($work, $output, $artifacts)) {
    $absolute = [IO.Path]::GetFullPath($directory)
    if (-not $absolute.StartsWith($runtime + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Chemin de compilation interdit.' }
    if (Test-Path -LiteralPath $absolute) { throw 'Le dossier de compilation doit etre neuf.' }
    New-Item -ItemType Directory -Path $absolute | Out-Null
}
function Get-VerifiedArchive([string]$uri, [string]$target, [string]$hash) {
    Invoke-WebRequest -Uri $uri -OutFile $target -UseBasicParsing
    if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash) { throw 'Archive de compilation non conforme.' }
}
$sourceUrl = 'https://github.com/openssl/openssl/releases/download/openssl-3.5.9/openssl-3.5.9.tar.gz'
$sourceHash = '603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a'
$sourceArchive = Join-Path $work 'openssl-3.5.9.tar.gz'
Get-VerifiedArchive $sourceUrl $sourceArchive $sourceHash
& tar -xzf $sourceArchive -C $work
if ($LASTEXITCODE -ne 0) { throw 'Extraction OpenSSL impossible.' }
$nasmArchive = Join-Path $work 'nasm.zip'
Get-VerifiedArchive 'https://www.nasm.us/pub/nasm/releasebuilds/3.02/win64/nasm-3.02-win64.zip' $nasmArchive '161d0bfaff53c2f9e9f3e69fd0672323ebabafd1268976a5cec11be92a19aee7'
Expand-Archive -LiteralPath $nasmArchive -DestinationPath (Join-Path $work 'nasm')
$nasm = Get-ChildItem -LiteralPath (Join-Path $work 'nasm') -Filter nasm.exe -Recurse -File
if (@($nasm).Count -ne 1) { throw 'NASM introuvable.' }
$env:PATH = $nasm.DirectoryName + ';' + $env:PATH
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$visualStudio = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $visualStudio) { throw 'Compilateur Visual C++ introuvable.' }
$vcvars = Join-Path $visualStudio 'VC\Auxiliary\Build\vcvars64.bat'
$environmentLines = & cmd.exe /d /c ('call "{0}" >nul && set' -f $vcvars)
if ($LASTEXITCODE -ne 0) { throw 'Initialisation Visual C++ impossible.' }
foreach ($line in $environmentLines) {
    if ($line -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') }
}
$perl = 'C:\Strawberry\perl\bin\perl.exe'
if (-not (Test-Path -LiteralPath $perl)) { $perl = (Get-Command perl -ErrorAction Stop).Source }
$env:SOURCE_DATE_EPOCH = '1790683200'
$configuration = @('VC-WIN64A-HYBRIDCRT', 'shared', 'no-tests', 'no-makedepend', 'no-module', 'no-autoload-config', '--prefix=C:/Slyorrent-OpenSSL', '--openssldir=C:/Slyorrent-OpenSSL/ssl')
$sourceDirectory = Join-Path $work 'openssl-3.5.9'
Push-Location $sourceDirectory
try {
    & $perl Configure @configuration
    if ($LASTEXITCODE -ne 0) { throw 'Configuration OpenSSL impossible.' }
    & nmake /NOLOGO /S build_libs build_apps
    if ($LASTEXITCODE -ne 0) { throw 'Compilation OpenSSL impossible.' }
    $version = & '.\apps\openssl.exe' version
    if ($LASTEXITCODE -ne 0 -or $version -notmatch '^OpenSSL 3\.5\.9\b') { throw 'Version OpenSSL incorrecte.' }
    [IO.File]::WriteAllBytes((Join-Path $work 'probe.txt'), [Text.Encoding]::ASCII.GetBytes('abc'))
    $digest = & '.\apps\openssl.exe' dgst -sha256 (Join-Path $work 'probe.txt')
    if ($LASTEXITCODE -ne 0 -or $digest -notmatch 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad$') { throw 'Controle SHA256 OpenSSL incorrect.' }
    foreach ($name in @('libcrypto-3-x64.dll', 'libssl-3-x64.dll')) { Copy-Item -LiteralPath (Join-Path $sourceDirectory $name) -Destination (Join-Path $output $name) }
    Copy-Item -LiteralPath (Join-Path $sourceDirectory 'LICENSE.txt') -Destination (Join-Path $output 'LICENSE.txt')
    $manifest = [ordered]@{ version='3.5.9'; architecture='x64'; sourceUrl=$sourceUrl; sourceSha256=$sourceHash; configuration=$configuration; workflowCommit=$env:GITHUB_SHA; runId=$env:GITHUB_RUN_ID; files=@() }
    foreach ($file in Get-ChildItem -LiteralPath $output -File) { $manifest.files += @{ name=$file.Name; sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() } }
    [IO.File]::WriteAllText((Join-Path $output 'BUILD.json'), ($manifest | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
    Compress-Archive -LiteralPath @((Join-Path $output 'libcrypto-3-x64.dll'), (Join-Path $output 'libssl-3-x64.dll'), (Join-Path $output 'LICENSE.txt'), (Join-Path $output 'BUILD.json')) -DestinationPath (Join-Path $artifacts 'OpenSSL-3.5.9-windows-x64.zip')
    Write-Host $version
    Get-FileHash -LiteralPath (Join-Path $artifacts 'OpenSSL-3.5.9-windows-x64.zip') -Algorithm SHA256 | Select-Object Hash
} finally { Pop-Location }

[CmdletBinding()]
param(
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Codex et certains runtimes de développement injectent parfois des modules
# PowerShell Core incompatibles dans Windows PowerShell 5.1. En édition Desktop,
# charger explicitement les modules Microsoft livrés par Windows empêche aussi
# qu'un module homonyme placé dans le profil utilisateur détourne ces commandes.
if ($PSVersionTable.PSEdition -eq 'Desktop') {
    $trustedModuleRoot = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\Modules'
    $env:PSModulePath = $trustedModuleRoot
    Import-Module (Join-Path $trustedModuleRoot 'Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -Force -ErrorAction Stop
    Import-Module (Join-Path $trustedModuleRoot 'Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -Force -ErrorAction Stop
}

$TransmissionVersion = '4.1.3'
$TransmissionAsset = "transmission-$TransmissionVersion-x64.msi"
$TransmissionUri = "https://github.com/transmission/transmission/releases/download/$TransmissionVersion/$TransmissionAsset"
$TransmissionSha256 = 'c8ea492d8f46fadac26e0c05b244cabba556201d5fe348dfcf1cf036621741f8'
$ExpectedSigner = 'SignPath Foundation'

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'Cet installateur local du moteur est reserve a Windows.'
}
if (-not [Environment]::Is64BitOperatingSystem) {
    throw 'Transmission 4.1.3 x64 exige une edition 64 bits de Windows.'
}

$RepositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$RuntimeRoot = Join-Path $RepositoryRoot '.runtime'
$DownloadRoot = Join-Path $RuntimeRoot 'downloads'
$EngineParent = Join-Path $RuntimeRoot 'engine'
$EngineRoot = Join-Path $EngineParent "transmission-$TransmissionVersion"
$MsiPath = Join-Path $DownloadRoot $TransmissionAsset
$InstallLog = Join-Path $RuntimeRoot "install-transmission-$TransmissionVersion.log"

function Assert-PathInsideRuntime {
    param([Parameter(Mandatory)][string]$Path)

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $fullRuntime = [System.IO.Path]::GetFullPath($RuntimeRoot).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    $runtimePrefix = $fullRuntime + [System.IO.Path]::DirectorySeparatorChar

    if (-not $fullPath.StartsWith($runtimePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refus d'operer hors du repertoire .runtime : $fullPath"
    }
}

function Assert-NoReparsePointInsideRuntime {
    param([Parameter(Mandatory)][string]$Path)

    Assert-PathInsideRuntime -Path $Path
    $fullRuntime = [System.IO.Path]::GetFullPath($RuntimeRoot).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $relativePath = $fullPath.Substring($fullRuntime.Length).TrimStart(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )

    $cursor = $fullRuntime
    $segments = @($relativePath -split '[\\/]' | Where-Object { $_.Length -gt 0 })
    foreach ($segment in @('.') + $segments) {
        if ($segment -ne '.') {
            $cursor = Join-Path $cursor $segment
        }
        if (-not (Test-Path -LiteralPath $cursor)) {
            continue
        }
        $item = Get-Item -LiteralPath $cursor -Force
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Point de reanalyse interdit dans le runtime local : $cursor"
        }
    }
}

function Assert-MicrosoftSystemBinary {
    param([Parameter(Mandatory)][string]$Path)

    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    $subject = if ($null -eq $signature.SignerCertificate) { '' } else { $signature.SignerCertificate.Subject }
    if ($signature.Status.ToString() -ne 'Valid' -or $subject -notmatch 'O=Microsoft Corporation(?:,|$)') {
        throw "Binaire systeme Microsoft non authentifie : $Path"
    }
}

function Assert-Sha256 {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Expected
    )

    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $Expected.ToLowerInvariant()) {
        throw "Empreinte SHA-256 invalide pour $Path. Attendue: $Expected ; obtenue: $actual"
    }
}

function Assert-Authenticode {
    param([Parameter(Mandatory)][string]$Path)

    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.Status.ToString() -ne 'Valid') {
        throw "Signature Authenticode invalide pour $Path : $($signature.StatusMessage)"
    }

    if ($null -eq $signature.SignerCertificate -or
        $signature.SignerCertificate.Subject -notlike "*$ExpectedSigner*") {
        $subject = if ($null -eq $signature.SignerCertificate) {
            '<aucun certificat>'
        }
        else {
            $signature.SignerCertificate.Subject
        }
        throw "Signataire inattendu pour $Path : $subject"
    }

    return $signature
}

function Assert-EnginePayload {
    param([Parameter(Mandatory)][string]$Root)

    $payload = Join-Path $Root 'PFiles\Transmission'
    $requiredExecutables = @(
        'transmission-daemon.exe',
        'transmission-remote.exe'
    )

    foreach ($name in $requiredExecutables) {
        $path = Join-Path $payload $name
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Moteur incomplet : $name est absent de $payload"
        }
    }

    $signedTools = @(Get-ChildItem -LiteralPath $payload -Filter 'transmission-*.exe' -File)
    if ($signedTools.Count -lt $requiredExecutables.Count) {
        throw "Moteur incomplet : aucun ensemble d'outils Transmission valide dans $payload"
    }

    foreach ($tool in $signedTools) {
        $productVersion = $tool.VersionInfo.ProductVersion
        if ([string]::IsNullOrWhiteSpace($productVersion) -or
            $productVersion -notmatch '^4\.1\.3(?:\s|\(|$)') {
            throw "Version inattendue pour $($tool.Name) : $productVersion"
        }
        $null = Assert-Authenticode -Path $tool.FullName
    }

    return [pscustomobject]@{
        Payload = $payload
        Daemon = Join-Path $payload 'transmission-daemon.exe'
        Remote = Join-Path $payload 'transmission-remote.exe'
        Tools = $signedTools
    }
}

foreach ($directory in @($RuntimeRoot, $DownloadRoot, $EngineParent)) {
    $null = New-Item -ItemType Directory -Path $directory -Force
}

Assert-PathInsideRuntime -Path $MsiPath
Assert-PathInsideRuntime -Path $EngineRoot
Assert-PathInsideRuntime -Path $InstallLog

$downloadRequired = $Force -or -not (Test-Path -LiteralPath $MsiPath -PathType Leaf)
if (-not $downloadRequired) {
    try {
        Assert-Sha256 -Path $MsiPath -Expected $TransmissionSha256
        $null = Assert-Authenticode -Path $MsiPath
        Write-Host "MSI officiel deja present et verifie : $MsiPath"
    }
    catch {
        Write-Warning "Le MSI en cache est refuse : $($_.Exception.Message)"
        $downloadRequired = $true
    }
}

if ($downloadRequired) {
    $partialPath = "$MsiPath.download"
    Assert-PathInsideRuntime -Path $partialPath
    if (Test-Path -LiteralPath $partialPath) {
        Remove-Item -LiteralPath $partialPath -Force
    }

    Write-Host "Telechargement de Transmission $TransmissionVersion depuis la publication officielle..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    try {
        Invoke-WebRequest -Uri $TransmissionUri -OutFile $partialPath -UseBasicParsing
        Assert-Sha256 -Path $partialPath -Expected $TransmissionSha256
        $null = Assert-Authenticode -Path $partialPath
        Move-Item -LiteralPath $partialPath -Destination $MsiPath -Force
    }
    catch {
        if (Test-Path -LiteralPath $partialPath) {
            Remove-Item -LiteralPath $partialPath -Force
        }
        throw
    }
}

$null = Assert-Sha256 -Path $MsiPath -Expected $TransmissionSha256
$msiSignature = Assert-Authenticode -Path $MsiPath

if (-not $Force -and (Test-Path -LiteralPath $EngineRoot -PathType Container)) {
    try {
        $existingEngine = Assert-EnginePayload -Root $EngineRoot
        Write-Host "Transmission $TransmissionVersion est deja extrait et verifie."
        Write-Host "Daemon : $($existingEngine.Daemon)"
        exit 0
    }
    catch {
        Write-Warning "L'extraction existante sera remplacee : $($_.Exception.Message)"
    }
}

$stageRoot = Join-Path $EngineParent ".transmission-$TransmissionVersion-stage-$([Guid]::NewGuid().ToString('N'))"
Assert-PathInsideRuntime -Path $stageRoot
$null = New-Item -ItemType Directory -Path $stageRoot -Force
Assert-NoReparsePointInsideRuntime -Path $stageRoot

try {
    $msiexec = Join-Path ([Environment]::SystemDirectory) 'msiexec.exe'
    if (-not (Test-Path -LiteralPath $msiexec -PathType Leaf)) {
        throw "msiexec.exe est introuvable : $msiexec"
    }
    Assert-MicrosoftSystemBinary -Path $msiexec

    Write-Host 'Extraction administrative locale du MSI (aucune installation systeme)...'
    $msiArguments = @(
        '/a',
        "`"$MsiPath`"",
        '/qn',
        '/norestart',
        "TARGETDIR=`"$stageRoot`"",
        '/L*v',
        "`"$InstallLog`""
    )
    $msiProcess = Start-Process -FilePath $msiexec -ArgumentList $msiArguments -Wait -PassThru -WindowStyle Hidden
    $exitCode = $msiProcess.ExitCode
    if ($exitCode -notin @(0, 1641, 3010)) {
        throw "msiexec a echoue avec le code $exitCode. Journal : $InstallLog"
    }

    $null = Assert-EnginePayload -Root $stageRoot

    if (Test-Path -LiteralPath $EngineRoot) {
        $runningTransmission = @(Get-Process -Name 'transmission-*' -ErrorAction SilentlyContinue)
        if ($runningTransmission.Count -gt 0) {
            $processIds = ($runningTransmission.Id | Sort-Object) -join ', '
            throw "Fermez Slyorent et Transmission avant de remplacer le moteur (PID : $processIds)."
        }
        Assert-PathInsideRuntime -Path $EngineRoot
        Assert-NoReparsePointInsideRuntime -Path $EngineRoot
        Remove-Item -LiteralPath $EngineRoot -Recurse -Force
    }
    Move-Item -LiteralPath $stageRoot -Destination $EngineRoot

    $installedEngine = Assert-EnginePayload -Root $EngineRoot
    $manifest = [ordered]@{
        engine = 'Transmission'
        version = $TransmissionVersion
        source = $TransmissionUri
        sha256 = $TransmissionSha256
        authenticodeSubject = $msiSignature.SignerCertificate.Subject
        installedAtUtc = [DateTime]::UtcNow.ToString('o')
        daemon = $installedEngine.Daemon.Substring($RepositoryRoot.Length).TrimStart('\')
        remote = $installedEngine.Remote.Substring($RepositoryRoot.Length).TrimStart('\')
    }
    $manifestPath = Join-Path $EngineRoot 'secutorrent-engine.json'
    $manifest | ConvertTo-Json | Set-Content -LiteralPath $manifestPath -Encoding UTF8

    Write-Host "Transmission $TransmissionVersion installe localement et verifie."
    Write-Host "SHA-256 : $TransmissionSha256"
    Write-Host "Signataire : $($msiSignature.SignerCertificate.Subject)"
    Write-Host "Daemon : $($installedEngine.Daemon)"
}
finally {
    if (Test-Path -LiteralPath $stageRoot) {
        Assert-PathInsideRuntime -Path $stageRoot
        Assert-NoReparsePointInsideRuntime -Path $stageRoot
        Remove-Item -LiteralPath $stageRoot -Recurse -Force
    }
}

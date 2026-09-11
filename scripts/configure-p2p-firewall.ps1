[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$enginePath = Join-Path $repositoryRoot '.runtime\engine\transmission-4.1.3\PFiles\Transmission\transmission-daemon.exe'
$expectedSha256 = '397DD842BBB4398F0E35A5B299AF19ADD28D8175564017B6F239A855646665BD'

$resolvedEngine = (Resolve-Path -LiteralPath $enginePath).Path
$resolvedRoot = (Resolve-Path -LiteralPath $repositoryRoot).Path.TrimEnd('\')
if (-not $resolvedEngine.StartsWith("$resolvedRoot\", [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Le moteur Transmission sort du dépôt Slyorrent.'
}
if ((Get-FileHash -LiteralPath $resolvedEngine -Algorithm SHA256).Hash -ne $expectedSha256) {
  throw 'Empreinte du moteur Transmission inattendue.'
}

$rules = @(
  @{ Name = 'SecuTorrent-P2P-TCP-51413'; DisplayName = 'Slyorrent P2P TCP 51413'; Protocol = 'TCP' },
  @{ Name = 'SecuTorrent-P2P-UDP-51413'; DisplayName = 'Slyorrent P2P UDP 51413'; Protocol = 'UDP' }
)

foreach ($spec in $rules) {
  $existing = Get-NetFirewallRule -Name $spec.Name -ErrorAction SilentlyContinue
  if ($existing) {
    Remove-NetFirewallRule -Name $spec.Name
  }
  New-NetFirewallRule `
    -Name $spec.Name `
    -DisplayName $spec.DisplayName `
    -Description 'Autorise uniquement le moteur Transmission signé de Slyorrent sur son port P2P fixe.' `
    -Enabled True `
    -Direction Inbound `
    -Action Allow `
    -Profile Private `
    -Program $resolvedEngine `
    -Protocol $spec.Protocol `
    -LocalPort 51413 | Out-Null
}

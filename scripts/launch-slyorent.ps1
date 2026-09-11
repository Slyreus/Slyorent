$ErrorActionPreference = "Stop"

$workspace = Split-Path -Parent $PSScriptRoot
$electronPath = Join-Path $workspace "node_modules\electron\dist\electron.exe"

if (-not (Test-Path -LiteralPath $electronPath -PathType Leaf)) {
    throw "Le moteur Electron de Slyorrent est introuvable."
}

$alreadyRunning = Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" |
    Where-Object { $_.ExecutablePath -eq $electronPath } |
    Select-Object -First 1

if ($alreadyRunning) {
    exit 0
}

$npmPath = (Get-Command npm.cmd -ErrorAction Stop).Source
Start-Process -FilePath $npmPath -ArgumentList @("start") -WorkingDirectory $workspace -WindowStyle Hidden

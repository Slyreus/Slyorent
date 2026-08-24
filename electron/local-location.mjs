import { execFile } from "node:child_process";

const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const MAX_OUTPUT_BYTES = 8 * 1024;
const LOCATION_TIMEOUT_MS = 12_000;

const WINDOWS_LOCATION_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  [Windows.Devices.Geolocation.Geolocator, Windows.Devices.Geolocation, ContentType = WindowsRuntime] | Out-Null
  [Windows.Devices.Geolocation.Geoposition, Windows.Devices.Geolocation, ContentType = WindowsRuntime] | Out-Null
  $locator = New-Object Windows.Devices.Geolocation.Geolocator
  $locator.DesiredAccuracyInMeters = 10000
  $operation = $locator.GetGeopositionAsync()
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 } |
    Select-Object -First 1
  if ($null -eq $asTask) {
    @{ status = 'unavailable'; reason = 'unsupported' } | ConvertTo-Json -Compress
    exit 0
  }
  $task = $asTask.MakeGenericMethod([Windows.Devices.Geolocation.Geoposition]).Invoke($null, @($operation))
  if (-not $task.Wait(8000)) {
    @{ status = 'unavailable'; reason = 'timeout' } | ConvertTo-Json -Compress
    exit 0
  }
  $position = $task.Result
  $coordinate = $position.Coordinate.Point.Position
  @{
    status = 'available'
    latitude = [double]$coordinate.Latitude
    longitude = [double]$coordinate.Longitude
    accuracyMeters = [double]$position.Coordinate.Accuracy
  } | ConvertTo-Json -Compress
} catch {
  @{ status = 'unavailable'; reason = 'disabled-or-denied' } | ConvertTo-Json -Compress
}
`;

function runWindowsLocationScript() {
  const encoded = Buffer.from(WINDOWS_LOCATION_SCRIPT, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    execFile(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      windowsHide: true,
      timeout: LOCATION_TIMEOUT_MS,
      killSignal: "SIGKILL",
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT_BYTES,
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function unavailable(reason, capturedAt) {
  return Object.freeze({
    status: "unavailable",
    source: "windows-location-service",
    local: true,
    approximate: true,
    reason,
    manualPlacementAllowed: true,
    capturedAt,
    persisted: false,
  });
}

export function normalizeWindowsLocationPayload(payload, capturedAt = new Date().toISOString()) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return unavailable("invalid-response", capturedAt);
  if (payload.status !== "available") {
    const allowedReasons = new Set(["unsupported", "disabled-or-denied", "timeout", "invalid-response"]);
    return unavailable(allowedReasons.has(payload.reason) ? payload.reason : "invalid-response", capturedAt);
  }
  const latitude = payload.latitude;
  const longitude = payload.longitude;
  const accuracyMeters = payload.accuracyMeters;
  if (typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
    || typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return unavailable("invalid-response", capturedAt);
  }
  return Object.freeze({
    status: "available",
    source: "windows-location-service",
    local: true,
    approximate: true,
    latitude: Math.round(latitude * 10) / 10,
    longitude: Math.round(longitude * 10) / 10,
    accuracyMeters: typeof accuracyMeters === "number" && Number.isFinite(accuracyMeters) && accuracyMeters >= 0 && accuracyMeters <= 10_000_000
      ? Math.round(accuracyMeters)
      : null,
    capturedAt,
    persisted: false,
  });
}

export async function locateSelfWithWindows({ platform = process.platform, runner = runWindowsLocationScript, clock = () => new Date() } = {}) {
  const capturedAt = clock().toISOString();
  if (platform !== "win32") return unavailable("unsupported", capturedAt);
  try {
    const stdout = await runner();
    if (typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) return unavailable("invalid-response", capturedAt);
    return normalizeWindowsLocationPayload(JSON.parse(stdout.replace(/^\uFEFF/u, "").trim()), capturedAt);
  } catch (error) {
    const reason = error?.killed || error?.signal ? "timeout" : error?.code === "ENOENT" ? "unsupported" : "disabled-or-denied";
    return unavailable(reason, capturedAt);
  }
}

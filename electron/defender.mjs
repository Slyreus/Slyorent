import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const MAX_OUTPUT = 64 * 1024;
const SIGNATURE_MAX_AGE_MS = 72 * 60 * 60 * 1_000;
let verifiedMpCmdRun = null;

function systemRoot() {
  const candidate = path.resolve(process.env.SystemRoot || "C:\\Windows");
  if (path.basename(candidate).toLowerCase() !== "windows" || path.dirname(candidate).toLowerCase() !== path.parse(candidate).root.toLowerCase()) {
    throw new Error("Le répertoire système Windows n'est pas canonique.");
  }
  return candidate;
}

function systemPowerShell() {
  return path.join(systemRoot(), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function securePowerShellEnvironment(extra = {}) {
  const root = systemRoot();
  return {
    ...process.env,
    PSModulePath: [
      path.join(root, "System32", "WindowsPowerShell", "v1.0", "Modules"),
      path.join(path.parse(root).root, "Program Files", "WindowsPowerShell", "Modules"),
    ].join(";"),
    ...extra,
  };
}

function run(executable, args, { timeoutMs = 60_000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      shell: false,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      try { child.kill("SIGKILL"); } catch { /* Processus déjà terminé. */ }
      settled = true;
      reject(new Error("Le contrôle Microsoft Defender a dépassé le délai autorisé."));
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-MAX_OUTPUT); });
    child.stderr?.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-MAX_OUTPUT); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function findMpCmdRun() {
  if (verifiedMpCmdRun) return verifiedMpCmdRun;
  const platformRoot = path.join(path.parse(systemRoot()).root, "ProgramData", "Microsoft", "Windows Defender", "Platform");
  let entries;
  try { entries = await readdir(platformRoot, { withFileTypes: true }); } catch { entries = []; }
  const versions = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  for (const version of versions) {
    const candidate = path.join(platformRoot, version, "MpCmdRun.exe");
    try {
      if ((await stat(candidate)).isFile()) {
        const command = "$ErrorActionPreference='Stop'; $s=Get-AuthenticodeSignature -LiteralPath $env:SECUTORRENT_AUTHENTICODE_TARGET; [pscustomobject]@{Status=[string]$s.Status;Subject=$s.SignerCertificate.Subject} | ConvertTo-Json -Compress; if ([string]$s.Status -ne 'Valid') { exit 3 }";
        const signature = await run(systemPowerShell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], {
          timeoutMs: 30_000,
          env: securePowerShellEnvironment({ SECUTORRENT_AUTHENTICODE_TARGET: candidate }),
        });
        let proof;
        try { proof = JSON.parse(signature.stdout.trim()); } catch { proof = null; }
        if (signature.code === 0 && proof?.Status === "Valid" && /^CN=Microsoft Windows Publisher, O=Microsoft Corporation(?:,|$)/i.test(proof.Subject || "")) {
          verifiedMpCmdRun = candidate;
          return candidate;
        }
      }
    } catch { /* Essayer la version suivante. */ }
  }
  throw new Error("Microsoft Defender MpCmdRun.exe est introuvable.");
}

export async function defenderHealth() {
  if (process.platform !== "win32") throw new Error("Microsoft Defender est obligatoire pour ouvrir un média dans cette version Windows.");
  const command = [
    "$ErrorActionPreference='Stop'",
    "$s=Get-MpComputerStatus",
    "$s | Select-Object AMServiceEnabled,AntivirusEnabled,RealTimeProtectionEnabled,BehaviorMonitorEnabled,IoavProtectionEnabled,AntivirusSignatureLastUpdated | ConvertTo-Json -Compress",
  ].join("; ");
  const result = await run(systemPowerShell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], {
    timeoutMs: 30_000,
    env: securePowerShellEnvironment(),
  });
  if (result.code !== 0) throw new Error("Impossible de vérifier l'état de Microsoft Defender.");
  let status;
  try { status = JSON.parse(result.stdout.trim()); } catch { throw new Error("État Microsoft Defender illisible."); }
  const required = ["AMServiceEnabled", "AntivirusEnabled", "RealTimeProtectionEnabled", "BehaviorMonitorEnabled", "IoavProtectionEnabled"];
  if (required.some((key) => status[key] !== true)) throw new Error("Microsoft Defender ou une de ses protections essentielles est désactivé.");
  const serializedDate = String(status.AntivirusSignatureLastUpdated || "");
  const powershellDate = /^\/Date\((\d+)(?:[+-]\d+)?\)\/$/.exec(serializedDate);
  const signatureDate = powershellDate ? new Date(Number(powershellDate[1])) : new Date(serializedDate);
  if (!Number.isFinite(signatureDate.getTime()) || Date.now() - signatureDate.getTime() > SIGNATURE_MAX_AGE_MS) {
    throw new Error("Les signatures Microsoft Defender ont plus de 72 heures.");
  }
  return { healthy: true, signatureUpdatedAt: signatureDate.toISOString() };
}

export async function scanFileWithDefender(filePath, { timeoutMs = 30 * 60_000 } = {}) {
  const before = await stat(filePath);
  if (!before.isFile()) throw new Error("La cible Defender n'est pas un fichier ordinaire.");
  const executable = await findMpCmdRun();
  const result = await run(executable, [
    "-Scan",
    "-ScanType", "3",
    "-File", filePath,
    "-ReturnHR",
  ], { timeoutMs });
  if (result.code !== 0) {
    const error = new Error("Microsoft Defender a bloqué le fichier ou n'a pas pu certifier son innocuité.");
    error.code = "DEFENDER_BLOCKED";
    throw error;
  }
  const after = await stat(filePath);
  if (!after.isFile() || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    const error = new Error("Le fichier a changé pendant l'analyse Microsoft Defender.");
    error.code = "FILE_CHANGED_DURING_SCAN";
    throw error;
  }
  return { clean: true, size: after.size, mtimeMs: after.mtimeMs };
}

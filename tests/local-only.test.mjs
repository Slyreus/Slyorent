import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const guardPath = path.join(repositoryRoot, "scripts", "assert-local-only.mjs");

async function temporaryFixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "secutorrent-guard-test-"));
  t.after(async () => {
    const resolved = path.resolve(directory);
    const temporaryRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
    assert.ok(resolved.startsWith(temporaryRoot), "la suppression reste confinée au dossier temporaire");
    await rm(resolved, { recursive: true, force: true });
  });
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ private: true }), "utf8");
  return directory;
}

function runGuard(directory) {
  return spawnSync(process.execPath, [guardPath, directory], { encoding: "utf8", windowsHide: true });
}

test("la garde local-only accepte un projet sans hébergement", async (t) => {
  const directory = await temporaryFixture(t);
  await writeFile(path.join(directory, "main.mjs"), "const host = '127.0.0.1';\n", "utf8");
  const result = runGuard(directory);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Garde local-only: OK/u);
});

test("la garde local-only bloque un manifeste d'hébergement", async (t) => {
  const directory = await temporaryFixture(t);
  const manifestDirectory = path.join(directory, ".openai");
  await mkdir(manifestDirectory);
  await writeFile(path.join(manifestDirectory, "hosting.json"), "{}\n", "utf8");
  const result = runGuard(directory);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /manifeste d'hebergement interdit/u);
});

test("la fenêtre Electron garde l'isolation de contexte et le sandbox", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(path.join(repositoryRoot, "electron", "main.mjs"), "utf8"));
  assert.match(source, /sandbox:\s*true/u);
  assert.match(source, /contextIsolation:\s*true/u);
  assert.match(source, /nodeIntegration:\s*false/u);
  assert.match(source, /webviewTag:\s*false/u);
  assert.match(source, /webSecurity:\s*true/u);
  assert.match(source, /setWindowOpenHandler\(\(\)\s*=>\s*\(\{\s*action:\s*"deny"/u);
  assert.match(source, /else\s+await\s+mainWindow\.loadFile\(renderer\.indexFile\)/u);
  assert.match(source, /!app\.isPackaged\s*&&\s*process\.env\.SECUTORRENT_RENDERER_URL/u);
  assert.match(source, /!app\.isPackaged\s*&&\s*process\.env\.SECUTORRENT_DEVTOOLS/u);
  assert.match(source, /script-src 'self';/u);
  assert.doesNotMatch(source, /script-src[^;]*unsafe-inline/u);
  assert.doesNotMatch(source, /loadURL\(["'`]http/u);
});

test("le renderer ne peut choisir ou ouvrir qu'un dossier validé par le processus principal", async () => {
  const { readFile } = await import("node:fs/promises");
  const preload = await readFile(path.join(repositoryRoot, "electron", "preload.cjs"), "utf8");
  const main = await readFile(path.join(repositoryRoot, "electron", "main.mjs"), "utf8");

  assert.match(preload, /chooseDownloadDirectory:\s*\(\)\s*=>\s*invoke\("chooseDownloadDirectory"\)/u);
  assert.match(preload, /chooseTorrentDestination:\s*\(\)\s*=>\s*invoke\("chooseTorrentDestination"\)/u);
  assert.match(preload, /openDownloadDirectory:\s*\(\)\s*=>\s*invoke\("openDownloadDirectory"\)/u);
  assert.match(preload, /openTorrentDirectory:\s*\(id\)\s*=>\s*invoke\("openTorrentDirectory",\s*\{\s*id\s*\}\)/u);
  assert.doesNotMatch(preload, /openPath|openDirectory:\s*\([^)]*path/iu);
  assert.match(main, /properties:\s*\["openDirectory",\s*"createDirectory",\s*"dontAddToRecent"\]/u);
  assert.match(main, /service\.resolveTorrentDownloadDirectory\(id\)/u);
  assert.match(main, /manager\.approveLibraryRoot\(selection\.filePaths\[0\]\)/u);
  assert.match(main, /capability\.ownerId\s*!==\s*event\.sender\.id/u);
  assert.match(main, /shell\.openPath\(directory\)/u);
});

test("l'installation du moteur reste locale et vérifie version, hash et signature", async () => {
  const { readFile } = await import("node:fs/promises");
  const installer = await readFile(path.join(repositoryRoot, "scripts", "install-engine.ps1"), "utf8");
  const manager = await readFile(path.join(repositoryRoot, "electron", "transmission-manager.mjs"), "utf8");

  assert.match(installer, /TransmissionVersion\s*=\s*'4\.1\.3'/u);
  assert.match(installer, /TransmissionSha256\s*=\s*'[a-f0-9]{64}'/u);
  assert.match(installer, /Assert-Sha256\s+-Path\s+\$partialPath/u);
  assert.match(installer, /Assert-Authenticode\s+-Path\s+\$partialPath/u);
  assert.match(installer, /'\/a'/u);
  assert.match(installer, /Assert-PathInsideRuntime\s+-Path\s+\$EngineRoot/u);
  assert.doesNotMatch(installer, /winget\s+install/iu);
  assert.match(manager, /EXPECTED_DAEMON_SHA256\s*=\s*"[a-f0-9]{64}"/u);
  assert.match(manager, /EXPECTED_ENGINE_DLLS\s*=\s*Object\.freeze/u);
  assert.match(manager, /actual\.length\s*!==\s*expected\.length/u);
  assert.match(manager, /await\s+verifyEngineDlls\(path\.dirname\(resolved\)\)/u);
});

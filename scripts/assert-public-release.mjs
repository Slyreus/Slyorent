import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { extractFile, listPackage } from "@electron/asar";
import { NtExecutable, NtExecutableResource, Resource } from "resedit";
import { inspectWindowsIco } from "./icon-resources.mjs";
import { mediaPathsForApp, MEDIA_SHA256 } from "../electron/media-binaries.mjs";
import { NETWORK_ENGINE_DIRECTORY } from "../electron/network-runtime.mjs";
import { trustedEngineFiles } from "../electron/transmission-manager.mjs";

const root = path.resolve(process.argv[2] || ".");
const expectedPackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const resources = path.join(root, "release", "win-unpacked", "resources");
const asarPath = path.join(resources, "app.asar");
const engineSource = path.join(root, ".runtime", "engine", NETWORK_ENGINE_DIRECTORY, "PFiles", "Transmission");
const enginePackaged = path.join(resources, ".runtime", "engine", "transmission-4.1.3", "PFiles", "Transmission");
const errors = [];
const runtimeFiles = ["electron/network-runtime.mjs", "electron/cast-network.mjs", "electron/cast-clients.mjs", "electron/cast-gateway.mjs", "electron/cast-service.mjs", "electron/cast-receiver/index.html", "electron/cast-receiver/receiver.js", "electron/cast-receiver/receiver.css", "electron/main.mjs", "electron/preload.cjs", "electron/torrent-service.mjs"];

const enginePins = trustedEngineFiles();
const engineFiles = Object.keys(enginePins).sort();

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function regularFile(filePath, label) {
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) errors.push(`${label} absent`);
  return Boolean(info?.isFile());
}

async function relativeFiles(directory, current = directory) {
  const found = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) found.push(...await relativeFiles(directory, absolute));
    else if (entry.isFile()) found.push(path.relative(directory, absolute).replaceAll("\\", "/"));
    else errors.push(`entrée non régulière dans le package : ${path.relative(directory, absolute)}`);
  }
  return found;
}

if (await regularFile(asarPath, "app.asar")) {
  const entries = listPackage(asarPath).map((entry) => entry.replaceAll("\\", "/").replace(/^\//u, ""));
  const forbiddenRoots = [".git/", ".next/", ".openai/", ".runtime/", ".wrangler/", "app/", "release/", "scripts/", "src/", "tests/"];
  for (const entry of entries) {
    if (forbiddenRoots.some((prefix) => entry === prefix.slice(0, -1) || entry.startsWith(prefix))) errors.push(`entrée interdite dans app.asar : ${entry}`);
    if (/\.(?:env|key|log|mmdb|msi|part|pem|pfx|resume|torrent)$/iu.test(entry)) errors.push(`fichier sensible dans app.asar : ${entry}`);
  }
  for (const required of ["dist/index.html", "electron/main.mjs", "electron/preload.cjs", "electron/transmission-manager.mjs", "electron/library-preferences.mjs", "electron/library-preferences-schema.mjs", "electron/library-destination.mjs", "electron/library-file-move.mjs", "electron/media-binaries.mjs", "electron/media-binary-path.mjs", "electron/media-adapter.mjs", "electron/media-profile.mjs", "electron/subtitles.mjs", "public/slyorus.png", "public/slyorrent-logo.png", ...runtimeFiles]) {
    if (!entries.includes(required)) errors.push(`entrée requise absente de app.asar : ${required}`);
  }
  for (const module of ["electron/transmission-manager.mjs", "electron/library-preferences.mjs", "electron/library-preferences-schema.mjs", "electron/media-adapter.mjs", "electron/media-binary-path.mjs", "electron/media-binaries.mjs", "electron/library-destination.mjs", "electron/library-file-move.mjs", "electron/media-profile.mjs", "electron/subtitles.mjs", ...runtimeFiles]) {
    if (entries.includes(module) && !extractFile(asarPath, path.join(...module.split("/"))).equals(await readFile(path.join(root, module)))) errors.push(`module de médiathèque périmé : ${module}`);
  }
  const frontendFiles = (await relativeFiles(path.join(root, "dist"))).map(file => `dist/${file}`).sort();
  const packagedFrontend = entries.filter(entry => entry.startsWith("dist/") && /\.[^/]+$/u.test(entry)).sort();
  if (JSON.stringify(frontendFiles) !== JSON.stringify(packagedFrontend)) errors.push("interface empaquetée différente du build courant");
  for (const file of frontendFiles) {
    if (entries.includes(file) && !extractFile(asarPath, path.join(...file.split("/"))).equals(await readFile(path.join(root, ...file.split("/"))))) errors.push(`interface périmée : ${file}`);
  }
  const packageDocument = JSON.parse(extractFile(asarPath, "package.json").toString("utf8"));
  if (packageDocument.version !== expectedPackage.version || packageDocument.productName !== "Slyorrent") errors.push("métadonnées de version invalides dans app.asar");

  const currentUsername = String(process.env.USERNAME || "").trim().toLowerCase();
  const textEntries = entries.filter((entry) => /\.(?:cjs|css|html|js|json|md|mjs|txt|yml)$/iu.test(entry) && !entry.endsWith("package-lock.json"));
  for (const entry of textEntries) {
    let content;
    try { content = extractFile(asarPath, path.join(...entry.split("/"))).toString("utf8"); }
    catch { continue; }
    if (content.length > 3_000_000) continue;
    if (currentUsername.length >= 3 && content.toLowerCase().includes(currentUsername)) errors.push(`nom du profil Windows dans app.asar : ${entry}`);
    if (/(?:gho|ghp|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/gu.test(content)) errors.push(`jeton GitHub dans app.asar : ${entry}`);
    if (/[A-Za-z]:[\\/]Users[\\/](?!Public[\\/]|Default[\\/])/iu.test(content)) errors.push(`chemin Windows personnel dans app.asar : ${entry}`);
  }
}

try {
  const iconPath = path.join(root, "public", "slyorrent.ico");
  const expectedIcons = inspectWindowsIco(await readFile(iconPath));
  const executablePath = path.join(root, "release", "win-unpacked", "Slyorrent.exe");
  const executable = NtExecutable.from(await readFile(executablePath), { ignoreCert: true });
  const nativeResources = NtExecutableResource.from(executable);
  const groups = Resource.IconGroupEntry.fromEntries(nativeResources.entries);
  if (!groups.length) throw new Error("aucune icône dans l'exécutable");
  for (const group of groups) {
    if (group.icons.length !== expectedIcons.length) throw new Error("résolutions manquantes dans l'exécutable");
    for (let index = 0; index < expectedIcons.length; index += 1) {
      const actual = nativeResources.entries.find((entry) => entry.type === 3 && entry.id === group.icons[index].iconID && entry.lang === group.lang);
      if (!actual || !Buffer.from(actual.bin).equals(expectedIcons[index].png)) throw new Error("logo de l'exécutable différent du logo validé");
    }
  }
  if (await sha256(iconPath) !== await sha256(path.join(resources, "slyorrent.ico"))) throw new Error("icône des associations absente ou différente");
  if (process.platform === "win32") {
    await promisify(execFile)("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts", "check-windows-icon.ps1"), "-FilePath", executablePath], { windowsHide: true, timeout: 30_000 });
  }
} catch (error) { errors.push(`icônes Windows : ${error.message}`); }

const packagedEngineFiles = (await relativeFiles(enginePackaged).catch(() => [])).map((file) => file.toLowerCase()).sort();
if (JSON.stringify(packagedEngineFiles) !== JSON.stringify(engineFiles)) errors.push("la liste du moteur Transmission embarqué ne correspond pas à l’allowlist");
for (const relativeName of engineFiles) {
  const source = path.join(engineSource, ...relativeName.split("/"));
  const packaged = path.join(enginePackaged, ...relativeName.split("/"));
  if (await regularFile(source, `source Transmission ${relativeName}`) && await regularFile(packaged, `Transmission embarqué ${relativeName}`)) {
    if (await sha256(source) !== enginePins[relativeName] || await sha256(packaged) !== enginePins[relativeName]) errors.push(`Transmission modifié pendant le packaging : ${relativeName}`);
  }
}

const binaryChecks = [
  [mediaPathsForApp(root).ffmpeg, mediaPathsForApp(asarPath).ffmpeg, MEDIA_SHA256.ffmpeg, "FFmpeg"],
  [mediaPathsForApp(root).ffprobe, mediaPathsForApp(asarPath).ffprobe, MEDIA_SHA256.ffprobe, "FFprobe"],
];
const mediaDirectory = path.dirname(mediaPathsForApp(asarPath).ffmpeg);
const packagedMediaFiles = (await relativeFiles(mediaDirectory).catch(() => [])).sort();
if (JSON.stringify(packagedMediaFiles) !== JSON.stringify(["LICENSE.txt", "README.txt", "ffmpeg.exe", "ffprobe.exe"].sort())) errors.push("la liste des moteurs média embarqués ne correspond pas à l’allowlist");
for (const [source, packaged, expected, label] of binaryChecks) {
  if (await regularFile(source, `${label} source`) && await regularFile(packaged, `${label} embarqué`)) {
    if (await sha256(source) !== expected || await sha256(packaged) !== expected) errors.push(`${label} modifié ou inattendu`);
  }
}

for (const license of [
  "Slyorrent-LICENSE.txt", "THIRD_PARTY_NOTICES.md", "Transmission-COPYING.txt", "FFmpeg-GPL-3.0.txt",
  "FFmpeg-BUILD.txt", "geoip-lite-and-GeoLite2-LICENSE.txt", "WORLD_GEOMETRY_LICENSE.md",
  "OpenSSL-LICENSE.txt", "OpenSSL-BUILD.json", "curl-LICENSE.txt", "curl-BUILD.json", "zlib-LICENSE.txt",
]) await regularFile(path.join(resources, "licenses", license), `licence ${license}`);

if (errors.length > 0) {
  console.error("Garde installateur: ECHEC");
  for (const error of [...new Set(errors)].sort()) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log("Garde installateur: OK — contenu allowlisté, moteurs intacts, licences présentes, aucune donnée personnelle détectée.");
}

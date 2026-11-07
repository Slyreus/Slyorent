import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import yauzl from "yauzl";
import { canonicalPathWithoutLinks } from "../electron/safe-path.mjs";
import { trustedEngineFiles } from "../electron/transmission-manager.mjs";
import { NETWORK_COMPONENTS, NETWORK_DLLS, NETWORK_ENGINE_DIRECTORY, NETWORK_BUILD_RUN } from "../electron/network-runtime.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = path.join(repository, ".runtime");
const downloads = path.join(runtime, "downloads");
const source = path.join(runtime, "engine", "transmission-4.1.4", "PFiles", "Transmission");
const patched = path.join(runtime, "engine", NETWORK_ENGINE_DIRECTORY);
const sha256 = async file => createHash("sha256").update(await readFile(file)).digest("hex");
async function privatePath(candidate) {
  const relative = path.relative(runtime, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Chemin hors du runtime.");
  let cursor = candidate;
  while (cursor.length >= runtime.length) {
    const info = await lstat(cursor).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
    if (info?.isSymbolicLink()) throw new Error("Lien interdit dans le runtime.");
    cursor = path.dirname(cursor);
  }
}
async function exactFiles(root, expected, relative = "") {
  const found = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = path.posix.join(relative.replaceAll("\\", "/"), entry.name);
    if (entry.isDirectory()) found.push(...await exactFiles(root, null, name));
    else if (entry.isFile()) found.push(name.toLowerCase());
    else throw new Error("Entrée non régulière dans le moteur.");
  }
  if (expected && JSON.stringify(found.sort()) !== JSON.stringify(expected.map(name => name.toLowerCase()).sort())) throw new Error("Contenu inattendu dans le moteur.");
  return found;
}
async function verifyFiles(root, files) {
  await exactFiles(root, Object.keys(files));
  for (const [name, expected] of Object.entries(files)) {
    const file = path.join(root, ...name.split("/"));
    await canonicalPathWithoutLinks(file);
    if (await sha256(file) !== expected) throw new Error(`Empreinte incorrecte : ${name}`);
  }
}
async function unpack(archive, target, names) {
  const zip = await promisify(yauzl.open)(archive, { lazyEntries: true, strictFileNames: true });
  const found = new Set();
  await new Promise((resolve, reject) => {
    zip.on("error", reject);
    zip.on("end", resolve);
    zip.on("entry", entry => {
      void (async () => {
        if (!names.includes(entry.fileName) || found.has(entry.fileName) || entry.uncompressedSize > 20 * 1024 * 1024) throw new Error("Contenu réseau non autorisé.");
        found.add(entry.fileName);
        const stream = await new Promise((accept, refuse) => zip.openReadStream(entry, (error, value) => error ? refuse(error) : accept(value)));
        await pipeline(stream, createWriteStream(path.join(target, entry.fileName), { flags: "wx" }));
        zip.readEntry();
      })().catch(error => { zip.close(); reject(error); });
    });
    zip.readEntry();
  });
  if (found.size !== names.length) throw new Error("Archive réseau incomplète.");
}
async function componentDirectory(component) {
  const destination = path.join(runtime, "network", `${component.name}-${component.version}`);
  await privatePath(destination);
  if (await lstat(destination).catch(() => null)) {
    await verifyFiles(destination, component.files);
    return destination;
  }
  const archive = path.join(downloads, component.archive);
  await privatePath(archive);
  if (await sha256(archive).catch(() => "") !== component.sha256) {
    const response = await fetch(`https://github.com/Slyreus/Slyorent/releases/download/v1.1.11/${component.archive}`);
    if (response.status === 404 && process.env.CI === "true" && process.env.SLYORRENT_NETWORK_BOOTSTRAP_RUN === String(NETWORK_BUILD_RUN)) {
      await promisify(execFile)("gh", ["run", "download", String(NETWORK_BUILD_RUN), "--repo", "Slyreus/Slyorent", "--name", "Network-libraries-windows-x64", "--dir", downloads], { windowsHide: true });
    } else {
      if (!response.ok || Number(response.headers.get("content-length")) > 25 * 1024 * 1024) throw new Error("Téléchargement des bibliothèques réseau impossible.");
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 25 * 1024 * 1024 || createHash("sha256").update(bytes).digest("hex") !== component.sha256) throw new Error("Archive réseau non conforme.");
      await writeFile(archive, bytes, { flag: "w" });
    }
  }
  if (await sha256(archive) !== component.sha256) throw new Error("Archive réseau non conforme.");
  const temporary = path.join(runtime, `network-stage-${randomUUID()}`);
  await privatePath(temporary);
  await mkdir(temporary);
  await unpack(archive, temporary, Object.keys(component.files));
  await verifyFiles(temporary, component.files);
  await mkdir(path.dirname(destination), { recursive: true });
  await rename(temporary, destination);
  return destination;
}

if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Les bibliothèques réseau exigent Windows x64.");
for (const item of [downloads, patched]) await privatePath(item);
await mkdir(downloads, { recursive: true });
const sources = new Map();
for (const component of NETWORK_COMPONENTS) {
  const directory = await componentDirectory(component);
  for (const name of Object.keys(component.files).filter(name => Object.hasOwn(NETWORK_DLLS, name))) sources.set(name, path.join(directory, name));
}
if (await lstat(patched).catch(() => null)) {
  await verifyFiles(path.join(patched, "PFiles", "Transmission"), trustedEngineFiles());
  console.log("Transmission, OpenSSL et libcurl déjà vérifiés.");
} else {
  const stage = `${patched}-stage-${randomUUID()}`;
  await privatePath(stage);
  const engine = path.join(stage, "PFiles", "Transmission");
  await mkdir(engine, { recursive: true });
  for (const [name, expected] of Object.entries(trustedEngineFiles())) {
    const original = sources.get(name) || path.join(source, ...name.split("/"));
    await canonicalPathWithoutLinks(original);
    if (await sha256(original) !== expected) throw new Error(`Source du moteur non conforme : ${name}`);
    await copyFile(original, path.join(engine, name));
  }
  await verifyFiles(engine, trustedEngineFiles());
  await rename(stage, patched);
  console.log("Transmission avec OpenSSL 3.5.9 et libcurl 8.23.0 préparé et vérifié.");
}

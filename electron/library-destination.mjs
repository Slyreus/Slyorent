import path from "node:path";

const windowsLimit = 259;
const extendedWindowsLimit = 32_760;
const tooLong = () => Object.assign(new Error("Le chemin reste trop long pour Windows. Choisissez une bibliothèque plus proche de la racine du disque."), { code: "DESTINATION_PATH_TOO_LONG" });
function relativeNames(files) {
  return files.map((file) => {
    const name = String(file.name || "").replaceAll("\\", "/");
    if (!name || name.includes("\0") || path.win32.isAbsolute(name) || name.split("/").some((part) => !part || part === "." || part === ".." || part.includes(":"))) throw new Error("Chemin de fichier torrent interdit.");
    return name;
  });
}
export function assertLibraryPathBudget(directory, files, platform = process.platform) {
  const names = relativeNames(files);
  if (platform === "win32" && names.some((name) => path.win32.join(directory, name).length > extendedWindowsLimit || name.split("/").some((part) => part.length > 255))) throw tooLong();
}
export function requiresLocalLibraryMove(directory, files, platform = process.platform) {
  return platform === "win32" && relativeNames(files).some(name => path.win32.join(directory, name).length > windowsLimit);
}
export function libraryFolderName({ root, name, hash, files, suffix = 1, platform = process.platform }) {
  let cleaned = String(name || "Torrent").normalize("NFKC").replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, "").replace(/[<>:"/\\|?*]/gu, " ").replace(/\s{2,}/gu, " ").trim().replace(/[. ]+$/u, "") || "Torrent";
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(cleaned)) cleaned = `_${cleaned}`;
  const tail = suffix === 1 ? "" : ` (${suffix})`;
  const longest = Math.max(0, ...relativeNames(files).map((file) => file.length));
  const legacyBudget = windowsLimit - root.length - longest - tail.length - 2;
  const limit = platform === "win32" && legacyBudget >= 12 ? Math.min(120, legacyBudget) : 120;
  if (cleaned.length > limit) {
    const tag = String(hash || "").replace(/[^a-f0-9]/giu, "").slice(0, 8) || "torrent";
    cleaned = `${cleaned.slice(0, limit - tag.length - 1).replace(/[. ]+$/u, "")}-${tag}`;
  }
  const folder = cleaned + tail;
  assertLibraryPathBudget(path.join(root, folder), files, platform);
  return folder;
}

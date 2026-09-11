import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

const MAX_PENDING = 16;
const TTL_MS = 15 * 60_000;
const MAX_SIZE = 10 * 1024 * 1024;

export function localTorrentPath(value, platform = process.platform) {
  if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u001f\u007f"<>|]/u.test(value)) return null;
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (platform === "win32" ? !/^[A-Za-z]:[\\/]/u.test(value) || value.slice(2).includes(":") : !value.startsWith("/") || value.startsWith("//")) return null;
  if (paths.extname(value).toLowerCase() !== ".torrent") return null;
  return paths.normalize(value);
}

export function torrentPathsFromArguments(argv, platform = process.platform) {
  if (!Array.isArray(argv)) return [];
  const paths = new Map();
  for (const item of argv.slice(0, 64)) {
    const filePath = localTorrentPath(item, platform);
    if (filePath) paths.set(platform === "win32" ? filePath.toLowerCase() : filePath, filePath);
    if (paths.size >= MAX_PENDING) break;
  }
  return [...paths.values()];
}

export async function inspectTorrentOpenFile(filePath) {
  const safe = localTorrentPath(filePath);
  if (!safe) throw new Error("Seuls les fichiers .torrent locaux sont acceptés.");
  const info = await lstat(safe);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_SIZE) throw new Error("Fichier .torrent invalide ou trop volumineux.");
  const resolved = await realpath(safe);
  if (!localTorrentPath(resolved)) throw new Error("Le fichier ne se trouve pas sur un chemin local autorisé.");
  return { path: resolved, size: info.size, mtimeMs: info.mtimeMs, ino: info.ino, dev: info.dev };
}

export class TorrentOpenQueue {
  #pending = new Map();
  #inspect;
  #clock;
  #onChange;
  #platform;
  #chain = Promise.resolve();
  constructor({ inspect = inspectTorrentOpenFile, clock = Date.now, onChange = () => {}, platform = process.platform } = {}) {
    this.#inspect = inspect; this.#clock = clock; this.#onChange = onChange; this.#platform = platform;
  }
  #prune() {
    for (const [token, file] of this.#pending) if (file.expiresAt <= this.#clock()) this.#pending.delete(token);
  }
  snapshot() {
    this.#prune();
    return [...this.#pending].map(([token, file]) => ({ token, name: (this.#platform === "win32" ? path.win32 : path.posix).basename(file.path).replace(/[\u202a-\u202e\u2066-\u2069]/gu, ""), size: file.size }));
  }
  enqueue(argv) {
    const operation = this.#chain.then(async () => {
      this.#prune();
      let added = 0, rejected = 0;
      for (const filePath of torrentPathsFromArguments(argv, this.#platform)) {
        if (this.#pending.size >= MAX_PENDING) { rejected += 1; continue; }
        try {
          const file = await this.#inspect(filePath);
          const identity = this.#platform === "win32" ? file.path.toLowerCase() : file.path;
          if ([...this.#pending.values()].some((entry) => entry.identity === identity)) continue;
          this.#pending.set(randomUUID(), { ...file, identity, expiresAt: this.#clock() + TTL_MS }); added += 1;
        } catch { rejected += 1; }
      }
      if (added) this.#onChange();
      return { added, rejected };
    });
    this.#chain = operation.catch(() => undefined);
    return operation;
  }
  dismiss(token) {
    this.#prune();
    if (typeof token === "string" && this.#pending.delete(token)) this.#onChange();
    return { ok: true };
  }
  async take(token) {
    this.#prune();
    const file = typeof token === "string" && this.#pending.get(token);
    if (!file) throw new Error("Ouverture expirée. Ouvrez à nouveau le fichier .torrent.");
    this.#pending.delete(token); this.#onChange();
    const current = await this.#inspect(file.path);
    if (["path", "size", "mtimeMs", "ino", "dev"].some((key) => current[key] !== file[key])) throw new Error("Le fichier a changé. Ouvrez-le à nouveau.");
    return current.path;
  }
}

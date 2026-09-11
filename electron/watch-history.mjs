import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalizeInfohash } from "./infohash.mjs";

const MAX_ENTRIES = 10_000;
const MAX_FILE_BYTES = 3 * 1024 * 1024;
const MAX_DURATION = 7 * 24 * 60 * 60;

export function watchKey(hash, fileIndex) {
  const canonical = canonicalizeInfohash(hash);
  if (!canonical || !Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex >= 10_000) throw new Error("Référence de visionnage invalide.");
  return `${canonical}:${fileIndex}`;
}

function normalizeRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Suivi de visionnage invalide.");
  const { position, duration, completed, updatedAt } = value;
  if (![position, duration].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= MAX_DURATION)
    || position > duration || typeof completed !== "boolean" || !Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    throw new Error("Position de lecture invalide.");
  }
  return { position, duration, completed, updatedAt };
}

/** Le suivi reste local ; aucune adresse, aucun nom de fichier ni chemin n'est enregistré. */
export class WatchHistory {
  #filePath;
  #entries = new Map();
  #writes = Promise.resolve();
  #unavailable = false;

  constructor(filePath) { this.#filePath = filePath; }

  async initialize() {
    await mkdir(path.dirname(this.#filePath), { recursive: true, mode: 0o700 });
    try {
      const info = await lstat(this.#filePath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) throw new Error("Fichier de suivi de visionnage invalide.");
      const document = JSON.parse(await readFile(this.#filePath, "utf8"));
      if (document?.schemaVersion !== 1 || !Array.isArray(document.entries) || document.entries.length > MAX_ENTRIES) throw new Error("Format du suivi de visionnage invalide.");
      for (const [key, value] of document.entries) {
        if (typeof key !== "string") throw new Error("Référence de visionnage invalide.");
        const [hash, index] = key.split(":");
        if (watchKey(hash, Number(index)) !== key) throw new Error("Référence de visionnage invalide.");
        this.#entries.set(key, normalizeRecord(value));
      }
    } catch (error) {
      // Conserver un fichier illisible intact, sans empêcher le lecteur de démarrer.
      if (error?.code !== "ENOENT") { this.#entries.clear(); this.#unavailable = true; }
    }
    return this;
  }

  snapshot() {
    if (this.#unavailable) throw new Error("Le suivi local est illisible. Le fichier existant a été conservé.");
    return Object.fromEntries([...this.#entries].map(([key, value]) => [key, { ...value }]));
  }

  flush() { return this.#writes; }

  update(hash, fileIndex, values) {
    const key = watchKey(hash, fileIndex);
    const incoming = normalizeRecord({ ...values, updatedAt: Date.now() });
    return this.#mutate(key, (previous) => ({ ...incoming, completed: previous?.completed === true || incoming.completed }));
  }

  mark(hash, fileIndex, watched) {
    if (typeof watched !== "boolean") throw new Error("Statut de visionnage invalide.");
    return this.#mutate(watchKey(hash, fileIndex), (previous) => ({
      position: watched ? previous?.duration || 0 : 0,
      duration: previous?.duration || 0,
      completed: watched,
      updatedAt: Date.now(),
    }));
  }

  #mutate(key, updater) {
    if (this.#unavailable) return Promise.reject(new Error("Le suivi local est indisponible. Le fichier existant a été conservé."));
    const task = this.#writes.then(async () => {
      const record = updater(this.#entries.get(key));
      const next = new Map(this.#entries);
      next.set(key, record);
      if (next.size > MAX_ENTRIES) {
        const oldest = [...next].sort((a, b) => a[1].updatedAt - b[1].updatedAt).slice(0, next.size - MAX_ENTRIES);
        for (const [oldKey] of oldest) next.delete(oldKey);
      }
      const temporary = `${this.#filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ schemaVersion: 1, entries: [...next] }), { encoding: "utf8", mode: 0o600, flag: "wx" });
        await rename(temporary, this.#filePath);
        this.#entries = next;
      } finally { await unlink(temporary).catch(() => undefined); }
      return { key, ...record };
    });
    this.#writes = task.catch(() => undefined);
    return task;
  }
}

import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalPathWithoutLinks } from "./safe-path.mjs";
import { LIBRARY_DEFAULTS, normalizeLibraryPreferences, validLibraryKey } from "./library-preferences-schema.mjs";

export class LibraryPreferences {
  #file;
  #state = normalizeLibraryPreferences(LIBRARY_DEFAULTS);
  #writes = Promise.resolve();
  #unavailable = false;
  constructor(filePath) { this.#file = path.resolve(filePath); }
  async initialize() {
    await mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    await canonicalPathWithoutLinks(path.dirname(this.#file));
    try {
      const info = await lstat(this.#file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error("Fichier de préférences invalide.");
      const document = JSON.parse(await readFile(this.#file, "utf8"));
      if (document.schemaVersion !== 1) throw new Error("Version des préférences invalide.");
      this.#state = normalizeLibraryPreferences(document.preferences);
    } catch (error) { if (error.code !== "ENOENT") this.#unavailable = true; }
    return this;
  }
  snapshot() {
    if (this.#unavailable) throw new Error("Préférences locales illisibles. Le fichier existant est conservé.");
    return structuredClone(this.#state);
  }
  flush() { return this.#writes; }
  update(patch) {
    const task = this.#writes.then(async () => {
      const current = this.snapshot();
      if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).some((key) => !["view", "groupBy", "sort", "descending", "favorite"].includes(key))) throw new Error("Modification des préférences invalide.");
      const { favorite, ...settings } = patch;
      if (favorite !== undefined) {
        if (!favorite || !validLibraryKey(favorite.key) || typeof favorite.value !== "boolean") throw new Error("Favori invalide.");
        current.favorites = current.favorites.filter((key) => key !== favorite.key);
        if (favorite.value) current.favorites.push(favorite.key);
      }
      const next = normalizeLibraryPreferences({ ...current, ...settings });
      const temporary = `${this.#file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ schemaVersion: 1, preferences: next }), { encoding: "utf8", mode: 0o600, flag: "wx" });
        await rename(temporary, this.#file);
        this.#state = next;
      } finally { await unlink(temporary).catch(() => undefined); }
      return this.snapshot();
    });
    this.#writes = task.catch(() => undefined);
    return task;
  }
}

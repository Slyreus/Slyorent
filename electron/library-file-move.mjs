import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, link, lstat, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { canonicalPathWithoutLinks } from "./safe-path.mjs";
import { assertLibraryPathBudget } from "./library-destination.mjs";

const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;
async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function identity(file) { return lstat(file, { bigint: true }); }
async function removeOwned(file, expected) {
  const current = await identity(file).catch(() => null);
  if (current?.isFile() && sameFile(current, expected)) await unlink(file);
}

// Les originaux restent en quarantaine tant que le moteur n'a pas confirmé
// son nouvel emplacement. Chaque cible est créée sans remplacer de fichier.
export async function stageLibraryFiles({ destination, files, linkFile = link }) {
  const root = await canonicalPathWithoutLinks(destination);
  assertLibraryPathBudget(root, files);
  const staged = [];
  try {
    for (const file of files) {
      const source = await canonicalPathWithoutLinks(file.filePath);
      const before = await lstat(source);
      if (!before.isFile() || before.size !== file.size || before.mtimeMs !== file.mtimeMs) throw new Error("Un fichier a changé après l’analyse.");
      const original = await identity(source);
      const target = path.resolve(root, ...file.name.replaceAll("\\", "/").split("/"));
      const relative = path.relative(root, target);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Le déplacement sort de la bibliothèque.");
      let parent = root;
      for (const segment of path.relative(root, path.dirname(target)).split(path.sep).filter(Boolean)) {
        parent = path.join(parent, segment);
        await mkdir(parent).catch(error => { if (error.code !== "EEXIST") throw error; });
        await canonicalPathWithoutLinks(parent);
      }
      let copied = false;
      try { await linkFile(source, target); }
      catch (error) {
        if (!["EXDEV", "ENOTSUP", "ENOSYS"].includes(error.code)) throw error;
        await copyFile(source, target, constants.COPYFILE_EXCL);
        copied = true;
      }
      const created = await identity(target);
      staged.push({ file, source, target, original, created });
      if (!sameFile(original, await identity(source))) throw new Error("Un fichier a changé pendant le déplacement.");
      if (copied ? await digest(source) !== await digest(target) : !sameFile(original, created)) throw new Error("La copie du fichier ne correspond pas à l’original.");
      if (!sameFile(original, await identity(source)) || !sameFile(created, await identity(target))) throw new Error("Un fichier a changé pendant le déplacement.");
    }
    return {
      files: await Promise.all(staged.map(async ({ file, target }) => {
        const info = await lstat(target);
        return { ...file, filePath: target, size: info.size, mtimeMs: info.mtimeMs };
      })),
      async removeSources() {
        for (const entry of staged) {
          if (!sameFile(entry.created, await identity(entry.target))) throw new Error("Un fichier de la bibliothèque a changé.");
          await removeOwned(entry.source, entry.original);
        }
      },
    };
  } catch (error) {
    await Promise.allSettled(staged.map(entry => removeOwned(entry.target, entry.created)));
    throw error;
  }
}

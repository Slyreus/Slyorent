import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stageLibraryFiles } from "../electron/library-file-move.mjs";

test("ranger les chemins longs et les copies entre volumes sans supprimer la source avant confirmation", async t => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "slyorrent-file-move-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const copied of [false, true]) {
    const destination = path.join(root, copied ? "copy" : "link");
    const name = `${"serie-".repeat(12)}/${"saison-".repeat(12)}/${"episode-".repeat(10)}.mkv`;
    const source = path.join(root, copied ? "source-copy" : "source-link", ...name.split("/"));
    await mkdir(path.dirname(source), { recursive: true });
    await mkdir(destination);
    await writeFile(source, "media de test");
    const info = await lstat(source);
    const staged = await stageLibraryFiles({ destination, files: [{ name, filePath: source, size: info.size, mtimeMs: info.mtimeMs }],
      ...(copied ? { linkFile: async () => { throw Object.assign(new Error("volume distinct"), { code: "EXDEV" }); } } : {}) });
    assert.equal((await readFile(source)).toString(), "media de test");
    assert.equal((await readFile(staged.files[0].filePath)).toString(), "media de test");
    assert.ok(staged.files[0].filePath.length > 259);
    await staged.removeSources();
    await assert.rejects(lstat(source), { code: "ENOENT" });
    assert.equal((await readFile(staged.files[0].filePath)).toString(), "media de test");
  }
});

test("conserver les originaux et les fichiers existants si le rangement échoue", async t => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "slyorrent-file-collision-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = path.join(root, "library");
  await mkdir(destination);
  const files = [];
  for (const name of ["first.bin", "second.bin"]) {
    const filePath = path.join(root, name);
    await writeFile(filePath, "original");
    const info = await lstat(filePath);
    files.push({ name, filePath, size: info.size, mtimeMs: info.mtimeMs });
  }
  await writeFile(path.join(destination, "second.bin"), "a conserver");
  await assert.rejects(stageLibraryFiles({ destination, files }), { code: "EEXIST" });
  assert.equal((await readFile(path.join(destination, "second.bin"))).toString(), "a conserver");
  await assert.rejects(lstat(path.join(destination, "first.bin")), { code: "ENOENT" });
  for (const file of files) assert.equal((await readFile(file.filePath)).toString(), "original");
});

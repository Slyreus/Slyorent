import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalPathWithoutLinks, UnsafePathError } from "../electron/safe-path.mjs";

test("un alias Windows 8.3 devient canonique sans être pris pour un lien", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "slyorent-safe-path-"));
  t.after(async () => rm(await realpath(directory), { recursive: true, force: true }));
  assert.equal(await canonicalPathWithoutLinks(directory), await realpath(directory));
});

test("un lien dans un composant du chemin reste interdit", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "slyorent-linked-path-"));
  const canonicalRoot = await realpath(root);
  t.after(async () => rm(canonicalRoot, { recursive: true, force: true }));
  const target = path.join(canonicalRoot, "target");
  const linked = path.join(canonicalRoot, "linked");
  await mkdir(target);
  try {
    await symlink(target, linked, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error?.code === "EPERM") return t.skip("La création de liens est désactivée sur cette machine.");
    throw error;
  }
  await assert.rejects(
    canonicalPathWithoutLinks(linked),
    (error) => error instanceof UnsafePathError && error.code === "SYMBOLIC_PATH_COMPONENT",
  );
});

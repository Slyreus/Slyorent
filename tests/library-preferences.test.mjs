import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LibraryPreferences } from "../electron/library-preferences.mjs";
import { LIBRARY_DEFAULTS, normalizeLibraryPreferences } from "../electron/library-preferences-schema.mjs";

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "slyorrent-library-test-"));
  t.after(async () => { assert.ok(path.resolve(root).startsWith(`${path.resolve(os.tmpdir())}${path.sep}slyorrent-library-test-`)); await rm(root, { recursive: true, force: true }); });
  const file = path.join(root, "preferences.json");
  return { root, file, preferences: await new LibraryPreferences(file).initialize() };
}
test("conserver la vue, le tri et les favoris après redémarrage", async (t) => {
  const { file, root, preferences } = await setup(t);
  assert.deepEqual(preferences.snapshot(), LIBRARY_DEFAULTS);
  await preferences.update({ view: "list", groupBy: "torrent", sort: "added", descending: true, favorite: { key: "series:orbite", value: true } });
  const reopened = await new LibraryPreferences(file).initialize();
  assert.deepEqual(reopened.snapshot(), { view: "list", groupBy: "torrent", sort: "added", descending: true, favorites: ["series:orbite"] });
  const detached = reopened.snapshot(); detached.favorites.length = 0;
  assert.equal(reopened.snapshot().favorites.length, 1);
  assert.deepEqual(await readdir(root), ["preferences.json"]);
});
test("sérialiser les changements rapides sans perdre de favori", async (t) => {
  const { file, preferences } = await setup(t);
  await Promise.all(Array.from({ length: 50 }, (_, index) => preferences.update({ favorite: { key: `movie:film ${index}`, value: true } })));
  await preferences.update({ favorite: { key: "movie:film 0", value: true } });
  await preferences.update({ favorite: { key: "movie:film 1", value: false } });
  await preferences.flush();
  const reopened = await new LibraryPreferences(file).initialize();
  assert.equal(reopened.snapshot().favorites.length, 49);
  assert.equal(reopened.snapshot().favorites.includes("movie:film 1"), false);
});
test("refuser les paramètres invalides sans écraser le classement", async (t) => {
  const { preferences } = await setup(t);
  for (const patch of [null, [], { view: "network" }, { sort: "secret" }, { groupBy: "path" }, { descending: 1 }, { path: "C:/private" }, { favorites: [] }, { favorite: { key: "torrent:12", value: true } }, { favorite: { key: "movie:a\n", value: true } }, { favorite: { key: "series:x", value: "yes" } }]) await assert.rejects(preferences.update(patch));
  assert.deepEqual(preferences.snapshot(), LIBRARY_DEFAULTS);
  await preferences.update({ sort: "size" });
  assert.equal(preferences.snapshot().sort, "size");
});
test("préserver un fichier endommagé et normaliser la vue par titres", async (t) => {
  const { file } = await setup(t);
  await writeFile(file, "broken-json");
  const preferences = await new LibraryPreferences(file).initialize();
  assert.throws(() => preferences.snapshot(), /conservé/);
  await assert.rejects(preferences.update({ sort: "size" }), /conservé/);
  assert.equal(await readFile(file, "utf8"), "broken-json");
  assert.equal(normalizeLibraryPreferences({ ...LIBRARY_DEFAULTS, groupBy: "none" }).groupBy, "title");
  assert.throws(() => normalizeLibraryPreferences({ ...LIBRARY_DEFAULTS, favorites: Array(2001).fill("movie:x") }));
  assert.throws(() => normalizeLibraryPreferences({ ...LIBRARY_DEFAULTS, favorites: Array.from({ length: 2000 }, (_, i) => `movie:${i} ${"漢".repeat(340)}`) }), /volumineuse/);
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WatchHistory, watchKey } from "../electron/watch-history.mjs";

const hash = "a".repeat(40);
async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "slyorent-watch-test-"));
  t.after(async () => { assert.ok(path.resolve(root).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)); await rm(root, { recursive: true, force: true }); });
  const file = path.join(root, "history.json");
  return { file, history: await new WatchHistory(file).initialize() };
}

test("conserver le suivi au redémarrage sans nom de média ni chemin", async (t) => {
  const { file, history } = await setup(t);
  await history.update(hash, 2, { position: 156.4, duration: 1500, completed: false, fileName: "private.mkv", path: "private-folder" });
  const reopened = await new WatchHistory(file).initialize();
  assert.equal(reopened.snapshot()[`${hash}:2`].position, 156.4);
  const serialized = await readFile(file, "utf8");
  assert.ok(!serialized.includes("private"));
  assert.equal(watchKey(hash.toUpperCase(), 2), `${hash}:2`);
});

test("sérialiser les sauvegardes de plusieurs épisodes sans perte", async (t) => {
  const { file, history } = await setup(t);
  await Promise.all(Array.from({ length: 20 }, (_, index) => history.update(hash, index, { position: index, duration: 1800, completed: false })));
  await history.flush();
  const reopened = await new WatchHistory(file).initialize();
  assert.equal(Object.keys(reopened.snapshot()).length, 20);
  assert.equal(reopened.snapshot()[`${hash}:19`].position, 19);
  const detached = history.snapshot();
  detached[`${hash}:19`].position = 0;
  assert.equal(history.snapshot()[`${hash}:19`].position, 19);
});

test("conserver le statut vu pendant une relecture et permettre sa remise à zéro", async (t) => {
  const { history } = await setup(t);
  await history.update(hash, 0, { position: 99, duration: 100, completed: true });
  await history.update(hash, 0, { position: 10, duration: 100, completed: false });
  assert.equal(history.snapshot()[`${hash}:0`].completed, true);
  await history.mark(hash, 0, false);
  assert.equal(history.snapshot()[`${hash}:0`].completed, false);
  assert.equal(history.snapshot()[`${hash}:0`].position, 0);
  await history.mark(hash, 1, true);
  assert.equal(history.snapshot()[`${hash}:1`].completed, true);
});

test("refuser les références et positions incohérentes", async (t) => {
  const { history } = await setup(t);
  const valid = { position: 10, duration: 100, completed: false };
  for (const values of [{ ...valid, position: -1 }, { ...valid, position: NaN }, { ...valid, position: 101 }, { ...valid, duration: Infinity }, { ...valid, completed: "true" }]) assert.throws(() => history.update(hash, 0, values));
  for (const index of [-1, .5, 10000, "1"]) assert.throws(() => watchKey(hash, index));
  assert.throws(() => watchKey("invalid", 0));
  assert.throws(() => history.mark(hash, 0, "true"));
});

test("préserver un historique endommagé sans empêcher le démarrage", async (t) => {
  const { file } = await setup(t);
  await writeFile(file, "not-json");
  const history = await new WatchHistory(file).initialize();
  assert.throws(() => history.snapshot(), /illisible/);
  await assert.rejects(history.mark(hash, 0, true), /conservé/);
  assert.equal(await readFile(file, "utf8"), "not-json");
});

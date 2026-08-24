import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ContentRegistry, ContentRegistryIntegrityError } from "../electron/content-registry.mjs";

const HASH_A = "A".repeat(40);
const NORMALIZED_HASH_A = HASH_A.toLowerCase();
const HASH_B = "b".repeat(64);
const HASH_B_MULTIHASH = `1220${HASH_B}`;

async function privateTemporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "slyorent-content-registry-test-"));
  t.after(async () => {
    const resolved = path.resolve(directory);
    const temporaryRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
    assert.ok(resolved.startsWith(temporaryRoot), "la suppression reste confinée au dossier temporaire");
    await rm(resolved, { recursive: true, force: true });
  });
  return directory;
}

function safeFiles() {
  return [
    {
      index: 1,
      name: "Saison 1\\episode-02.mkv",
      size: 2_048,
      mtimeMs: 1_776_729_600_123.5,
      filePath: "C:\\Users\\Public\\Documents\\Slyorent\\Saison 1\\episode-02.mkv",
    },
    {
      index: 0,
      name: "Saison 1\\episode-01.mkv",
      size: 1_024,
      mtimeMs: 1_776_729_600_000,
    },
  ];
}

test("le registre conserve les destinations et validations sûres après redémarrage", async (t) => {
  const directory = await privateTemporaryDirectory(t);
  const clock = () => new Date("2026-08-21T12:34:56.000Z");
  const registry = await new ContentRegistry({ directory, clock }).initialize();

  const planned = await registry.upsertPlan({
    hash: HASH_A,
    libraryRoot: "C:\\Users\\Public\\Documents\\Slyorent",
    createSubfolder: true,
  });
  assert.deepEqual(planned, {
    hash: NORMALIZED_HASH_A,
    plan: {
      libraryRoot: "C:\\Users\\Public\\Documents\\Slyorent",
      createSubfolder: true,
      updatedAt: "2026-08-21T12:34:56.000Z",
    },
    safe: null,
  });

  const marked = await registry.markSafe({
    hash: HASH_A,
    finalDirectory: "C:\\Users\\Public\\Documents\\Slyorent\\Saison 1",
    files: safeFiles(),
  });
  assert.deepEqual(marked.safe.files.map((file) => file.index), [0, 1]);
  assert.equal(marked.safe.files[0].filePath, null);
  assert.equal(marked.safe.files[1].filePath?.endsWith("episode-02.mkv"), true);

  const reopened = await new ContentRegistry(directory).initialize();
  assert.deepEqual(reopened.get(HASH_A), marked);
  assert.deepEqual(reopened.entries(), [marked]);

  const detached = reopened.get(HASH_A);
  detached.safe.files[0].name = "modification-externe.mkv";
  assert.equal(reopened.get(HASH_A).safe.files[0].name, "Saison 1\\episode-01.mkv");

  const stored = await readFile(path.join(directory, "content-registry.json"), "utf8");
  const key = await readFile(path.join(directory, "content-registry.key"));
  assert.equal(key.length, 32);
  assert.doesNotMatch(stored, /magnet:|tracker|passkey|announce/u);
  assert.equal(stored.includes(key.toString("hex")), false);
  assert.deepEqual((await readdir(directory)).sort(), ["content-registry.json", "content-registry.key"]);
});

test("le registre refuse toute altération authentifiée incorrectement", async (t) => {
  const directory = await privateTemporaryDirectory(t);
  const registry = await new ContentRegistry(directory).initialize();
  await registry.upsertPlan({ hash: HASH_A, libraryRoot: "D:\\Médiathèque", createSubfolder: false });
  await registry.markSafe({ hash: HASH_A, finalDirectory: "D:\\Médiathèque", files: safeFiles() });

  const registryPath = path.join(directory, "content-registry.json");
  const document = JSON.parse(await readFile(registryPath, "utf8"));
  document.entries[0].safe.finalDirectory = "D:\\Contenu détourné";
  await writeFile(registryPath, `${JSON.stringify(document)}\n`, "utf8");

  await assert.rejects(
    new ContentRegistry(directory).initialize(),
    (error) => error instanceof ContentRegistryIntegrityError
      && error.code === "CONTENT_REGISTRY_INTEGRITY"
      && /altéré/u.test(error.message),
  );
});

test("un schéma injecté ou une clé remplacée provoque un échec fermé", async (t) => {
  const injectedDirectory = await privateTemporaryDirectory(t);
  const injected = await new ContentRegistry(injectedDirectory).initialize();
  await injected.upsertPlan({ hash: HASH_A, libraryRoot: "D:\\Médiathèque", createSubfolder: true });
  const injectedPath = path.join(injectedDirectory, "content-registry.json");
  const document = JSON.parse(await readFile(injectedPath, "utf8"));
  document.entries[0].magnet = "magnet:?xt=urn:btih:secret";
  await writeFile(injectedPath, JSON.stringify(document), "utf8");
  await assert.rejects(
    new ContentRegistry(injectedDirectory).initialize(),
    (error) => error instanceof ContentRegistryIntegrityError && /Schéma/u.test(error.message),
  );

  const rekeyedDirectory = await privateTemporaryDirectory(t);
  const rekeyed = await new ContentRegistry(rekeyedDirectory).initialize();
  await rekeyed.upsertPlan({ hash: HASH_A, libraryRoot: "D:\\Médiathèque", createSubfolder: true });
  await writeFile(path.join(rekeyedDirectory, "content-registry.key"), Buffer.alloc(32, 7));
  await assert.rejects(
    new ContentRegistry(rekeyedDirectory).initialize(),
    (error) => error instanceof ContentRegistryIntegrityError && /altéré/u.test(error.message),
  );
});

test("les changements de destination invalident le statut sûr et les suppressions sont explicites", async (t) => {
  const directory = await privateTemporaryDirectory(t);
  let now = new Date("2026-08-21T08:00:00.000Z");
  const registry = await new ContentRegistry({ directory, clock: () => now }).initialize();
  await registry.upsertPlan({ hash: HASH_A, libraryRoot: "D:\\Films", createSubfolder: true });
  const safe = await registry.markSafe({ hash: HASH_A, finalDirectory: "D:\\Films\\Film", files: safeFiles() });

  now = new Date("2026-08-21T09:00:00.000Z");
  const unchanged = await registry.upsertPlan({ hash: HASH_A, libraryRoot: "D:\\Films", createSubfolder: true });
  assert.deepEqual(unchanged.safe, safe.safe);
  assert.equal(unchanged.plan.updatedAt, "2026-08-21T08:00:00.000Z");

  const changed = await registry.upsertPlan({ hash: HASH_A, libraryRoot: "E:\\Films", createSubfolder: false });
  assert.equal(changed.safe, null);
  assert.equal(changed.plan.updatedAt, "2026-08-21T09:00:00.000Z");
  await registry.markSafe({ hash: HASH_A, finalDirectory: "E:\\Films", files: safeFiles() });
  assert.equal(await registry.invalidate(HASH_A), true);
  assert.equal(await registry.invalidate(HASH_A), false);
  assert.equal(registry.get(HASH_A).safe, null);
  assert.equal(await registry.remove(HASH_A), true);
  assert.equal(await registry.remove(HASH_A), false);
  assert.equal(registry.get(HASH_A), null);
});

test("le registre canonise un multihash BitTorrent v2 avant persistance", async (t) => {
  const directory = await privateTemporaryDirectory(t);
  const registry = await new ContentRegistry(directory).initialize();
  const planned = await registry.upsertPlan({
    hash: HASH_B_MULTIHASH.toUpperCase(),
    libraryRoot: "D:\\Vidéos",
    createSubfolder: true,
  });

  assert.equal(planned.hash, HASH_B);
  assert.deepEqual(registry.get(HASH_B_MULTIHASH), planned);

  const reopened = await new ContentRegistry(directory).initialize();
  assert.deepEqual(reopened.get(HASH_B), planned);
  const stored = JSON.parse(await readFile(path.join(directory, "content-registry.json"), "utf8"));
  assert.equal(stored.entries[0].hash, HASH_B);
});

test("les écritures concurrentes restent ordonnées et les entrées sensibles ou hors limites sont refusées", async (t) => {
  const directory = await privateTemporaryDirectory(t);
  const registry = await new ContentRegistry(directory).initialize();
  await Promise.all([
    registry.upsertPlan({ hash: HASH_B, libraryRoot: "D:\\Séries", createSubfolder: true }),
    registry.upsertPlan({ hash: HASH_A, libraryRoot: "D:\\Films", createSubfolder: false }),
  ]);
  assert.deepEqual(registry.entries().map((entry) => entry.hash), [NORMALIZED_HASH_A, HASH_B]);

  await assert.rejects(
    registry.upsertPlan({ hash: HASH_A, libraryRoot: "D:\\Films", createSubfolder: false, tracker: "secret" }),
    /champs invalides/u,
  );
  await assert.rejects(
    registry.markSafe({
      hash: HASH_A,
      finalDirectory: "D:\\Films",
      files: [{ index: 0, name: "film.mkv", size: 10, mtimeMs: 10, passkey: "secret" }],
    }),
    /champs invalides/u,
  );
  await assert.rejects(
    registry.markSafe({ hash: HASH_A, finalDirectory: "D:\\Films", files: [] }),
    /Liste de fichiers invalide/u,
  );
  await assert.rejects(
    registry.markSafe({
      hash: HASH_A,
      finalDirectory: "D:\\Films",
      files: Array.from({ length: 8_193 }, (_, index) => ({ index, name: `f-${index}`, size: 0, mtimeMs: 0 })),
    }),
    /Liste de fichiers invalide/u,
  );
  assert.throws(() => registry.get("not-an-infohash"), /Infohash invalide/u);
});

import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defenderHealth, scanFileWithDefender } from "../electron/defender.mjs";

const defenderUnavailableExpected = process.env.SLYORENT_CI_DEFENDER_UNAVAILABLE === "1";

test("Microsoft Defender actif certifie un fichier local inoffensif", {
  skip: process.platform !== "win32" || defenderUnavailableExpected,
  timeout: 120_000,
}, async (t) => {
  const temporaryRoot = await realpath(os.tmpdir());
  const directory = await realpath(await mkdtemp(path.join(temporaryRoot, "secutorrent-defender-test-")));
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(`${temporaryRoot}${path.sep}`), "la suppression reste confinée au dossier temporaire");
    await rm(resolved, { recursive: true, force: true });
  });
  const filePath = path.join(directory, "harmless.txt");
  const contents = "SecuTorrent Defender local self-test.\n";
  await writeFile(filePath, contents, "utf8");

  const health = await defenderHealth();
  assert.equal(health.healthy, true);
  assert.ok(Number.isFinite(new Date(health.signatureUpdatedAt).getTime()));

  const result = await scanFileWithDefender(filePath, { timeoutMs: 60_000 });
  assert.equal(result.clean, true);
  assert.equal(result.size, Buffer.byteLength(contents));
  assert.ok(Number.isFinite(result.mtimeMs));
});

test("Slyorrent refuse de certifier un fichier lorsque Defender est indisponible", {
  skip: process.platform !== "win32" || !defenderUnavailableExpected,
  timeout: 30_000,
}, async () => {
  await assert.rejects(
    defenderHealth(),
    /Defender|protection|signatures|vérifier l'état/iu,
  );
});

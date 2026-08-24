import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AuditIntegrityError, AuditLog } from "../electron/audit-log.mjs";

async function privateTemporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "secutorrent-audit-test-"));
  t.after(async () => {
    const resolved = path.resolve(directory);
    const temporaryRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
    assert.ok(resolved.startsWith(temporaryRoot), "la suppression reste confinée au dossier temporaire");
    await rm(resolved, { recursive: true, force: true });
  });
  return directory;
}

test("le journal conserve une chaîne HMAC ordonnée et masque les secrets", async (t) => {
  const directory = await privateTemporaryDirectory(t);
  const audit = await new AuditLog(directory).initialize();

  await Promise.all([
    audit.append("torrent.added", { torrentId: 7, magnet: "magnet-secret" }),
    audit.append("torrent.started", { torrentId: 7, nested: { tracker: "tracker-secret" } }),
  ]);

  const recent = await audit.recent(10);
  assert.equal(recent.length, 2);
  assert.deepEqual(recent.map((record) => record.seq), [2, 1]);
  assert.equal(recent[1].details.magnet, "[redacted]");
  assert.equal(recent[0].details.nested.tracker, "[redacted]");
  assert.equal(recent[0].prevHash, recent[1].hash);

  const reopened = await new AuditLog(directory).initialize();
  assert.equal((await reopened.recent(10)).length, 2);
});

test("le journal refuse une ligne altérée", async (t) => {
  const directory = await privateTemporaryDirectory(t);
  const audit = await new AuditLog(directory).initialize();
  await audit.append("torrent.added", { torrentId: 12 });

  const journalPath = path.join(directory, "audit.jsonl");
  const record = JSON.parse((await readFile(journalPath, "utf8")).trim());
  record.details.torrentId = 13;
  await writeFile(journalPath, `${JSON.stringify(record)}\n`, "utf8");

  await assert.rejects(
    new AuditLog(directory).initialize(),
    (error) => error instanceof AuditIntegrityError && /altérée/u.test(error.message),
  );
});

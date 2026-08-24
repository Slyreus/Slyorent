import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MediaVault, validateMediaSignature } from "../electron/media-vault.mjs";

async function temporaryMedia(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "secutorrent-media-test-"));
  t.after(async () => {
    const resolved = path.resolve(directory);
    const temporaryRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
    assert.ok(resolved.startsWith(temporaryRoot), "la suppression reste confinée au dossier temporaire");
    await rm(resolved, { recursive: true, force: true });
  });
  const filePath = path.join(directory, "media.mp4");
  const contents = Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from("ftypisom", "ascii"),
    Buffer.from("contenu-media-local", "ascii"),
  ]);
  await writeFile(filePath, contents);
  return { filePath, contents };
}

function ownedRequest(url, ownerWebContentsId, init) {
  const request = new Request(url, init);
  Object.defineProperty(request, "webContentsId", { value: ownerWebContentsId });
  return request;
}

test("le coffre média valide la signature et sert uniquement des plages bornées", async (t) => {
  const { filePath, contents } = await temporaryMedia(t);
  const file = await stat(filePath);
  assert.equal(await validateMediaSignature(filePath), "video/mp4");

  const vault = new MediaVault();
  const issued = vault.issue({
    filePath,
    torrentKey: "torrent-test",
    ownerWebContentsId: 42,
    mimeType: "video/mp4",
    name: "media.mp4",
    expectedSize: file.size,
    expectedMtimeMs: file.mtimeMs,
  });

  const forbidden = await vault.handle(ownedRequest(issued.url, 43));
  assert.equal(forbidden.status, 403);

  const response = await vault.handle(ownedRequest(issued.url, 42, { headers: { Range: "bytes=4-7" } }));
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), `bytes 4-7/${contents.length}`);
  assert.equal(Buffer.from(await response.arrayBuffer()).toString("ascii"), "ftyp");

  const invalidRange = await vault.handle(ownedRequest(issued.url, 42, { headers: { Range: "bytes=0-1,4-5" } }));
  assert.equal(invalidRange.status, 416);
});

test("le coffre révoque un jeton lorsque le fichier a changé après l'analyse", async (t) => {
  const { filePath } = await temporaryMedia(t);
  const file = await stat(filePath);
  const vault = new MediaVault();
  const issued = vault.issue({
    filePath,
    torrentKey: "torrent-test",
    ownerWebContentsId: 9,
    mimeType: "video/mp4",
    name: "media.mp4",
    expectedSize: file.size,
    expectedMtimeMs: file.mtimeMs,
  });

  await appendFile(filePath, Buffer.from("mutation", "ascii"));
  assert.equal((await vault.handle(ownedRequest(issued.url, 9))).status, 409);
  assert.equal((await vault.handle(ownedRequest(issued.url, 9))).status, 404);
});

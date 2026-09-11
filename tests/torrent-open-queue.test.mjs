import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TorrentOpenQueue, inspectTorrentOpenFile, localTorrentPath, torrentPathsFromArguments } from "../electron/torrent-open-queue.mjs";

const file = "C:\\Users\\Public\\Documents\\Un film.torrent";
const inspect = async (filePath) => ({ path: filePath, size: 100, mtimeMs: 42, ino: 123, dev: 2 });

test("Ouvrir avec accepte les chemins locaux entre espaces, pas les URL, UNC ou arguments de commande", () => {
  assert.deepEqual(torrentPathsFromArguments(["app.exe", "--", file, file, "C:/Films/Épisode 2.TORRENT"], "win32"), [file, "C:\\Films\\Épisode 2.TORRENT"]);
  for (const invalid of ["https://example.invalid/a.torrent", "file:///C:/a.torrent", "\\\\server\\a.torrent", "\\\\?\\C:\\a.torrent", "C:relative.torrent", "C:\\a.exe:stream.torrent", "--a.torrent", "C:\\a.torrent.exe", 'C:\\a".torrent', "C:\\a\n.torrent"]) assert.equal(localTorrentPath(invalid, "win32"), null);
  assert.equal(localTorrentPath(file, "linux"), null);
});

test("la file Windows conserve les imports au démarrage et ne révèle que des jetons", async () => {
  let changes = 0;
  const queue = new TorrentOpenQueue({ inspect, platform: "win32", onChange: () => { changes += 1; } });
  assert.deepEqual(await queue.enqueue([file]), { added: 1, rejected: 0 });
  assert.deepEqual(await queue.enqueue([file.toLowerCase()]), { added: 0, rejected: 0 });
  const [item] = queue.snapshot();
  assert.equal(item.name, "Un film.torrent");
  assert.equal(item.size, 100);
  assert.doesNotMatch(JSON.stringify(item), /Public|Documents|C:/);
  assert.match(item.token, /^[a-f0-9-]{36}$/);
  assert.equal(await queue.take(item.token), file);
  assert.equal(queue.snapshot().length, 0);
  await assert.rejects(queue.take(item.token), /expirée/);
  assert.equal(changes, 2);
});

test("les ouvertures simultanées restent bornées et les annulations n’importent rien", async () => {
  const queue = new TorrentOpenQueue({ inspect, platform: "win32" });
  await Promise.all(Array.from({ length: 30 }, (_, index) => queue.enqueue([`C:\\data\\${index}.torrent`])));
  assert.equal(queue.snapshot().length, 16);
  const [first, second] = queue.snapshot();
  queue.dismiss(first.token);
  assert.equal(queue.snapshot()[0].token, second.token);
  await assert.rejects(queue.take(first.token), /expirée/);
});

test("un jeton expiré ou un fichier remplacé ne peut pas être importé", async () => {
  let now = 0, changed = false;
  const queue = new TorrentOpenQueue({ platform: "win32", clock: () => now, inspect: async (filePath) => ({ ...await inspect(filePath), mtimeMs: changed ? 43 : 42 }) });
  await queue.enqueue([file]);
  const expired = queue.snapshot()[0].token;
  now = 16 * 60_000;
  assert.equal(queue.snapshot().length, 0);
  await assert.rejects(queue.take(expired), /expirée/);
  await queue.enqueue([file]);
  const token = queue.snapshot()[0].token;
  changed = true;
  await assert.rejects(queue.take(token), /a changé/);
  assert.equal(queue.snapshot().length, 0);
});

test("l’inspection refuse les fichiers vides, trop gros, absents et les répertoires", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "slyorrent-open-test-"));
  try {
    const filePath = path.join(directory, "sample.torrent");
    await assert.rejects(inspectTorrentOpenFile(filePath));
    await writeFile(filePath, "");
    await assert.rejects(inspectTorrentOpenFile(filePath), /invalide/);
    await writeFile(filePath, "de");
    assert.equal((await inspectTorrentOpenFile(filePath)).size, 2);
    await writeFile(filePath, Buffer.alloc(10 * 1024 * 1024 + 1));
    await assert.rejects(inspectTorrentOpenFile(filePath), /volumineux/);
    await assert.rejects(inspectTorrentOpenFile(directory));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("l’association Windows préserve l’application par défaut et les données de la V1", async () => {
  const read = (filePath) => readFile(new URL(`../${filePath}`, import.meta.url), "utf8");
  const [installer, config, main, preload, page, packageText] = await Promise.all([read("build/file-associations.nsh"), read("electron-builder.yml"), read("electron/main.mjs"), read("electron/preload.cjs"), read("app/page.tsx"), read("package.json")]);
  assert.match(installer, /Software\\Classes\\\.torrent\\OpenWithProgids/);
  assert.match(installer, /Applications\\Slyorrent\.exe\\SupportedTypes/);
  assert.doesNotMatch(installer, /UserChoice|WriteReg\w+ HKCU "Software\\Classes\\\.torrent"/);
  assert.match(installer, /Slyorrent\.exe\$\\" \$\\"%1\$\\"/);
  assert.match(config, /include: build\/file-associations\.nsh/);
  assert.match(config, /appId: com\.slyreus\.slyorent/);
  assert.match(main, /LEGACY_USER_DATA_DIRECTORY = "SecuTorrent Slyorus"/);
  assert.match(main, /app\.on\("second-instance", \(_event, argv\)/);
  assert.match(main, /await queueTorrentFiles\(process\.argv\)/);
  assert.match(main, /params\.rightsConfirmed !== true \|\| params\.startPaused !== true/);
  assert.match(main, /await openQueue\.take\(params\.pendingToken\)/);
  assert.match(preload, /onPendingTorrentImports/);
  assert.match(page, /pendingToken: externalImport\.token/);
  assert.equal(JSON.parse(packageText).productName, "Slyorrent");
});

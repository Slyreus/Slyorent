import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AuditLog } from "../electron/audit-log.mjs";
import { TorrentService } from "../electron/torrent-service.mjs";
import { TransmissionManager } from "../electron/transmission-manager.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const enginePath = path.join(
  repositoryRoot,
  ".runtime",
  "engine",
  "transmission-4.1.3",
  "PFiles",
  "Transmission",
  "transmission-daemon.exe",
);
const canRunEngine = process.platform === "win32" && existsSync(enginePath);

async function temporaryDirectory(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function canonicalPathKey(candidate) {
  const canonical = await realpath(candidate);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

async function assertSameRealPath(actual, expected, message) {
  assert.equal(await canonicalPathKey(actual), await canonicalPathKey(expected), message);
}

async function tcpEndpointAccepts(host, port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const settle = (accepted) => {
      socket.destroy();
      resolve(accepted);
    };
    socket.setTimeout(1_500, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

function bencode(value) {
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`, "ascii"), value]);
  if (typeof value === "string") return bencode(Buffer.from(value, "utf8"));
  if (Number.isSafeInteger(value)) return Buffer.from(`i${value}e`, "ascii");
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value).sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    return Buffer.concat([
      Buffer.from("d", "ascii"),
      ...entries.flatMap(([key, entry]) => [bencode(key), bencode(entry)]),
      Buffer.from("e", "ascii"),
    ]);
  }
  throw new TypeError("Valeur bencode de test non prise en charge.");
}

test("le moteur local signé démarre et répond en JSON-RPC sur son profil isolé", { skip: !canRunEngine, timeout: 30_000 }, async (t) => {
  const directory = await temporaryDirectory("secutorrent-engine-test-");
  const previousPortMapping = process.env.SECUTORRENT_ENABLE_PORTMAP;
  process.env.SECUTORRENT_ENABLE_PORTMAP = "0";

  const audit = await new AuditLog(path.join(directory, "audit")).initialize();
  const defaultLibrary = path.join(directory, "default-library");
  const manager = new TransmissionManager({
    appPath: repositoryRoot,
    userDataPath: path.join(directory, "profile"),
    defaultLibraryPath: defaultLibrary,
    audit,
  });
  t.after(async () => {
    await manager.stop();
    if (previousPortMapping === undefined) delete process.env.SECUTORRENT_ENABLE_PORTMAP;
    else process.env.SECUTORRENT_ENABLE_PORTMAP = previousPortMapping;
    const resolved = await realpath(directory);
    const temporaryRoot = `${await realpath(os.tmpdir())}${path.sep}`;
    assert.ok(resolved.startsWith(temporaryRoot), "la suppression reste confinée au dossier temporaire");
    await rm(resolved, { recursive: true, force: true });
  });

  const status = await manager.start();
  assert.equal(status.running, true);
  assert.equal(status.rpcReady, true);
  assert.match(status.version, /^4\.1\.3/u);
  assert.equal(status.portMapping, false);
  await assertSameRealPath(status.quarantineDir, manager.paths.data);
  await assertSameRealPath(status.downloadDir, defaultLibrary);

  const initialDownloadSession = await manager.rpc.call("session_get", { fields: ["download_dir"] });
  await assertSameRealPath(initialDownloadSession.download_dir, manager.paths.data);

  const selectedDownloads = path.join(directory, "selected-downloads");
  await mkdir(selectedDownloads, { recursive: true });
  const storageChange = await manager.setDownloadDirectory(selectedDownloads);
  assert.equal(storageChange.changed, true);
  await assertSameRealPath(storageChange.directory, selectedDownloads);
  await assertSameRealPath(manager.status().downloadDir, selectedDownloads);
  const downloadSession = await manager.rpc.call("session_get", { fields: ["download_dir"] });
  await assertSameRealPath(downloadSession.download_dir, manager.paths.data);
  const storagePolicy = JSON.parse(await readFile(path.join(manager.paths.profile, "storage-policy.json"), "utf8"));
  assert.equal(storagePolicy.schemaVersion, 1);
  const allowedDirectoryKeys = await Promise.all(storagePolicy.allowedDirectories.map(canonicalPathKey));
  assert.equal(allowedDirectoryKeys.includes(await canonicalPathKey(selectedDownloads)), true);
  assert.equal(allowedDirectoryKeys.includes(await canonicalPathKey(defaultLibrary)), true);
  assert.equal(allowedDirectoryKeys.includes(await canonicalPathKey(manager.paths.data)), true);
  await assert.rejects(manager.setDownloadDirectory(path.parse(selectedDownloads).root), /racine d'un disque/u);
  await assert.rejects(manager.setDownloadDirectory(repositoryRoot), /contenir l'application/u);
  const approvedLibrary = path.join(directory, "approved-library");
  await mkdir(approvedLibrary, { recursive: true });
  const approval = await manager.approveLibraryRoot(approvedLibrary);
  assert.equal(approval.changed, true);
  await assertSameRealPath(await manager.resolveAllowedDownloadRoot(approvedLibrary), approvedLibrary);
  await assertSameRealPath(manager.status().downloadDir, selectedDownloads, "approuver une racine ne change pas la bibliothèque par défaut");
  const unapprovedDownloads = path.join(directory, "unapproved-downloads");
  await mkdir(unapprovedDownloads, { recursive: true });
  await assert.rejects(manager.resolveAllowedDownloadRoot(unapprovedDownloads), /n'a pas été autorisé/u);

  const session = await manager.rpc.call("session_get", { fields: ["rpc_version_semver", "version"] });
  assert.match(session.rpc_version_semver, /^6\./u);
  assert.match(session.version, /^4\.1\.3/u);

  const settings = JSON.parse(await readFile(path.join(manager.paths.profile, "settings.json"), "utf8"));
  assert.equal(settings["rpc-bind-address"], "127.0.0.1");
  assert.equal(settings["rpc-authentication-required"], true);
  assert.equal(settings["rpc-whitelist-enabled"], true);
  assert.equal(settings["port-forwarding-enabled"], false);
  assert.equal(settings["start-added-torrents"], false);
  assert.equal(settings.start_paused, true);
  assert.equal(settings["lpd-enabled"], false);
  assert.equal(settings["watch-dir-enabled"], false);
  assert.equal(settings["script-torrent-added-enabled"], false);
  assert.equal(settings["script-torrent-done-enabled"], false);
  assert.equal(settings["script-torrent-done-seeding-enabled"], false);
  await assertSameRealPath(settings["download-dir"], manager.paths.data);
  await assertSameRealPath(settings["incomplete-dir"], manager.paths.incomplete);
  assert.equal(String(settings["rpc-password"]).includes("secret-"), false, "le secret RPC ne reste pas en clair après chargement");
  assert.equal(await tcpEndpointAccepts("127.0.0.1", settings["rpc-port"]), true);

  const nonLoopbackAddress = Object.values(os.networkInterfaces())
    .flat()
    .find((address) => address?.family === "IPv4" && address.internal === false)?.address;
  if (nonLoopbackAddress) {
    assert.equal(
      await tcpEndpointAccepts(nonLoopbackAddress, settings["rpc-port"]),
      false,
      `le RPC ne doit pas accepter de connexion via ${nonLoopbackAddress}`,
    );
  }

  const torrents = await manager.rpc.call("torrent_get", { fields: ["id"] });
  assert.deepEqual(torrents.torrents, []);

  const torrentPath = path.join(directory, "fixture.torrent");
  const payload = Buffer.from("x", "ascii");
  await writeFile(torrentPath, bencode({
    info: {
      length: payload.length,
      name: "fixture.bin",
      "piece length": 16_384,
      pieces: createHash("sha1").update(payload).digest(),
    },
  }));
  const service = new TorrentService({
    manager,
    audit,
    mediaVault: { revokeTorrent() {}, issue() { throw new Error("non utilisé"); } },
  });
  const imported = await service.importTorrentFile(torrentPath, { rightsConfirmed: true, startPaused: true });
  assert.equal(imported.ok, true);
  assert.equal(imported.torrent.name, "fixture.bin");
  assert.equal(imported.torrent.status, "stopped");
  assert.equal(imported.torrent.files.length, 1);
  assert.equal(imported.torrent.files[0].name, "fixture.bin");
  assert.equal(imported.torrent.files[0].length, 1);
  const importedRaw = await manager.rpc.call("torrent_get", { ids: [imported.torrent.id], fields: ["download_dir"] });
  await assertSameRealPath(importedRaw.torrents[0].download_dir, manager.paths.data);
  await service.remove({ id: imported.torrent.id, deleteData: false });
});

test("le dossier choisi persiste après un redémarrage du moteur", { skip: !canRunEngine, timeout: 45_000 }, async (t) => {
  const directory = await temporaryDirectory("slyorent-storage-test-");
  const userDataPath = path.join(directory, "profile");
  const defaultLibrary = path.join(directory, "default-library");
  const selectedDownloads = path.join(directory, "downloads");
  await Promise.all([defaultLibrary, selectedDownloads].map((target) => mkdir(target, { recursive: true })));
  const audit = await new AuditLog(path.join(directory, "audit")).initialize();
  let manager = new TransmissionManager({ appPath: repositoryRoot, userDataPath, defaultLibraryPath: defaultLibrary, audit });
  t.after(async () => {
    await manager.stop();
    await rm(directory, { recursive: true, force: true });
  });

  await manager.start();
  await manager.setDownloadDirectory(selectedDownloads);
  await manager.stop();

  // Format produit avant la séparation quarantaine/bibliothèque : il reste lisible
  // même si la nouvelle bibliothèque par défaut n'était pas encore enregistrée.
  await writeFile(path.join(userDataPath, "engine-profile", "storage-policy.json"), `${JSON.stringify({
    schemaVersion: 1,
    downloadDirectory: selectedDownloads,
    allowedDirectories: [path.join(userDataPath, "quarantine"), selectedDownloads],
  }, null, 2)}\n`, "utf8");

  manager = new TransmissionManager({ appPath: repositoryRoot, userDataPath, defaultLibraryPath: defaultLibrary, audit });
  const restarted = await manager.start();
  await assertSameRealPath(restarted.downloadDir, selectedDownloads);
  await assertSameRealPath(restarted.quarantineDir, manager.paths.data);
  await assertSameRealPath(await manager.resolveAllowedDownloadRoot(defaultLibrary), defaultLibrary);
  await assertSameRealPath(await manager.resolveAllowedDownloadRoot(manager.paths.data), manager.paths.data);
  const session = await manager.rpc.call("session_get", { fields: ["download_dir"] });
  await assertSameRealPath(session.download_dir, manager.paths.data);
});

test("le moteur honore au démarrage le mappage demandé par la politique globale", { skip: !canRunEngine, timeout: 30_000 }, async (t) => {
  const directory = await temporaryDirectory("secutorrent-portmap-test-");
  const previousPeerPort = process.env.SECUTORRENT_PEER_PORT;
  process.env.SECUTORRENT_PEER_PORT = "52143";
  const userDataPath = path.join(directory, "profile");
  const profilePath = path.join(userDataPath, "engine-profile");
  await mkdir(profilePath, { recursive: true });
  await writeFile(path.join(profilePath, "global-sharing-policy.json"), `${JSON.stringify({
    schemaVersion: 2,
    enabled: true,
    shareMode: "share-all",
    ratioLimit: null,
    idleMinutes: null,
    uploadLimitKbps: null,
    portMapping: true,
    priorityMode: true,
  })}\n`, "utf8");
  const audit = await new AuditLog(path.join(directory, "audit")).initialize();
  const manager = new TransmissionManager({ appPath: repositoryRoot, userDataPath, audit });
  t.after(async () => {
    await manager.stop();
    if (previousPeerPort === undefined) delete process.env.SECUTORRENT_PEER_PORT;
    else process.env.SECUTORRENT_PEER_PORT = previousPeerPort;
    await rm(directory, { recursive: true, force: true });
  });

  const status = await manager.start();
  const session = await manager.rpc.call("session_get", {
    fields: ["port_forwarding_enabled", "peer_port", "seed_queue_enabled", "queue_stalled_enabled"],
  });
  assert.equal(status.portMapping, true);
  assert.equal(status.priorityMode, true);
  assert.equal(status.uploadSlotsPerTorrent, 4);
  assert.equal(session.port_forwarding_enabled, true);
  assert.equal(session.peer_port, 52_143);
  assert.equal(session.seed_queue_enabled, false);
  assert.equal(session.queue_stalled_enabled, false);

  const settings = JSON.parse(await readFile(path.join(manager.paths.profile, "settings.json"), "utf8"));
  assert.equal(settings["seed-queue-enabled"], false);
  assert.equal(settings["queue-stalled-enabled"], false);
  assert.equal(settings["upload-slots-per-torrent"], 4);
});

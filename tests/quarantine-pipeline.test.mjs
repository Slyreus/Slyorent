import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ContentRegistry } from "../electron/content-registry.mjs";
import { TorrentService } from "../electron/torrent-service.mjs";

const HASH = "0123456789abcdef0123456789abcdef01234567";
const MAGNET = `magnet:?xt=urn:btih:${HASH}&dn=Serie%20Test`;

function clone(value) {
  return structuredClone(value);
}

function containsPath(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function torrentRecord(downloadDirectory) {
  return {
    id: 1,
    hash_string: HASH,
    name: "Serie Test",
    status: 0,
    percent_done: 0,
    metadata_percent_complete: 1,
    recheck_progress: 0,
    rate_download: 0,
    rate_upload: 0,
    eta: -1,
    upload_ratio: 0,
    uploaded_ever: 0,
    downloaded_ever: 0,
    seconds_seeding: 0,
    size_when_done: 4,
    peers_connected: 0,
    peers_getting_from_us: 0,
    peers_sending_to_us: 0,
    error_string: "",
    is_private: false,
    download_dir: downloadDirectory,
    files: [{ name: "episode-01.mkv", length: 4, bytes_completed: 0 }],
    file_stats: [{ wanted: true }],
    trackers: [],
    tracker_stats: [],
    bandwidth_priority: 0,
    peer_limit: 50,
    honors_session_limits: true,
    seed_ratio_mode: 2,
    seed_ratio_limit: 0,
    seed_idle_mode: 2,
    seed_idle_limit: 0,
    upload_limited: false,
    upload_limit: 0,
    peers: [],
  };
}

function sessionRecord() {
  return {
    seed_ratio_limited: false,
    seed_ratio_limit: 2,
    idle_seeding_limit_enabled: false,
    idle_seeding_limit: 30,
    speed_limit_up_enabled: false,
    speed_limit_up: 100,
    port_forwarding_enabled: false,
    alt_speed_enabled: false,
    seed_queue_enabled: true,
    preferred_transports: ["utp", "tcp"],
    encryption: "preferred",
    lpd_enabled: false,
    queue_stalled_enabled: true,
    peer_limit_global: 200,
    peer_limit_per_torrent: 50,
    upload_slots_per_torrent: 8,
  };
}

function localManager({ quarantine, library, profile, timeline }) {
  const state = { session: sessionRecord(), torrents: [] };
  let verificationStates = [];
  const roots = [quarantine, library].map((root) => path.resolve(root));

  const manager = {
    paths: { data: quarantine, profile },
    status: () => ({ downloadDir: library, uploadSlotsPerTorrent: 8, portMapping: false }),
    async resolveAllowedDownloadRoot(candidate) {
      const resolved = path.resolve(candidate);
      const root = roots.find((allowed) => containsPath(allowed, resolved));
      if (!root) throw new Error("Répertoire local non autorisé par le test.");
      return root;
    },
    notePortMapping() {},
    notePriorityMode() {},
    rpc: {
      async call(method, params = {}) {
        timeline.push({ type: "rpc", method, params: clone(params) });
        if (method === "session_get") return clone(state.session);
        if (method === "session_stats") return {};
        if (method === "session_set") {
          Object.assign(state.session, clone(params));
          return {};
        }
        if (method === "torrent_add") {
          assert.equal(params.paused, true);
          assert.equal(path.resolve(params.download_dir), path.resolve(quarantine));
          state.torrents.push(torrentRecord(params.download_dir));
          return { torrent_added: { id: 1 } };
        }
        if (method === "torrent_get") {
          const ids = Array.isArray(params.ids) ? new Set(params.ids.map(Number)) : null;
          const selected = ids ? state.torrents.filter((torrent) => ids.has(Number(torrent.id))) : state.torrents;
          const project = (torrent) => !Array.isArray(params.fields)
            ? torrent
            : Object.fromEntries(params.fields.filter((field) => Object.hasOwn(torrent, field)).map((field) => [field, torrent[field]]));
          const response = {
            torrents: clone(selected.map(project)),
          };
          if (verificationStates.length > 0) {
            const next = verificationStates.shift();
            for (const torrent of state.torrents) Object.assign(torrent, clone(next));
          }
          return response;
        }
        if (method === "torrent_stop") {
          const ids = new Set((params.ids || state.torrents.map(({ id }) => id)).map(Number));
          for (const torrent of state.torrents) {
            if (!ids.has(Number(torrent.id))) continue;
            torrent.status = 0;
            torrent.rate_download = 0;
            torrent.rate_upload = 0;
          }
          return {};
        }
        if (method === "torrent_verify") {
          const ids = new Set((params.ids || []).map(Number));
          for (const torrent of state.torrents) if (ids.has(Number(torrent.id))) Object.assign(torrent, { status: 1, recheck_progress: 0 });
          verificationStates = [
            { status: 2, recheck_progress: 0.5 },
            { status: 0, recheck_progress: 1 },
          ];
          return {};
        }
        if (method === "torrent_set_location") {
          assert.equal(params.move, true);
          const ids = new Set((params.ids || []).map(Number));
          for (const torrent of state.torrents) {
            if (!ids.has(Number(torrent.id))) continue;
            for (const file of torrent.files) {
              const segments = file.name.replace(/\\/gu, "/").split("/");
              const source = path.join(torrent.download_dir, ...segments);
              const target = path.join(params.location, ...segments);
              await mkdir(path.dirname(target), { recursive: true });
              await rename(source, target);
            }
            torrent.download_dir = params.location;
          }
          return {};
        }
        if (method === "torrent_set") {
          const ids = new Set((params.ids || state.torrents.map(({ id }) => id)).map(Number));
          for (const torrent of state.torrents) {
            if (!ids.has(Number(torrent.id))) continue;
            for (const [key, value] of Object.entries(params)) if (key !== "ids") torrent[key] = clone(value);
          }
          return {};
        }
        if (method === "torrent_start" || method === "torrent_start_now") {
          const ids = new Set((params.ids || []).map(Number));
          for (const torrent of state.torrents) if (ids.has(Number(torrent.id))) torrent.status = Number(torrent.percent_done) >= 0.999999 ? 6 : 4;
          return {};
        }
        if (method === "torrent_remove") {
          const ids = new Set((params.ids || []).map(Number));
          state.torrents = state.torrents.filter((torrent) => !ids.has(Number(torrent.id)));
          return {};
        }
        throw new Error(`RPC inattendu dans le pipeline: ${method}`);
      },
    },
  };
  return { manager, state };
}

function serviceWith({ manager, registry, timeline, scanFile }) {
  return new TorrentService({
    manager,
    contentRegistry: registry,
    audit: {
      async append(event, details) {
        timeline.push({ type: "audit", event, details: clone(details) });
      },
    },
    mediaVault: { revokeTorrent() {}, issue() { throw new Error("Lecteur non utilisé dans ce test."); } },
    defenderHealthCheck: async () => {
      timeline.push({ type: "defender-health" });
      return { healthy: true, signatureUpdatedAt: "2026-08-21T08:00:00.000Z" };
    },
    scanFile,
    verificationTimeoutMs: 2_000,
    verificationPollMs: 10,
    moveTimeoutMs: 2_000,
  });
}

test("un téléchargement reste réciproque, puis s'arrête et ne seed qu'après validation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "slyorent-quarantine-pipeline-"));
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    await rm(resolved, { recursive: true, force: true });
  });
  const quarantine = path.join(root, "quarantine");
  const library = path.join(root, "library");
  const profile = path.join(root, "profile");
  const registryDirectory = path.join(profile, "content-security");
  await Promise.all([quarantine, library, profile].map((directory) => mkdir(directory, { recursive: true })));
  const canonicalLibrary = await realpath(library);
  const timeline = [];
  const { manager, state } = localManager({ quarantine, library, profile, timeline });
  const registry = new ContentRegistry(registryDirectory);
  const defenderSnapshots = [];
  const service = serviceWith({
    manager,
    registry,
    timeline,
    scanFile: async (filePath) => {
      timeline.push({ type: "defender-scan", filePath });
      defenderSnapshots.push({ status: state.torrents[0].status, safe: registry.get(HASH)?.safe ?? null });
      const file = await stat(filePath);
      return { size: file.size, mtimeMs: file.mtimeMs };
    },
  });

  assert.deepEqual(await service.initializeSecurity(), { ok: true, restored: 0, pending: 0 });
  const downloadPhaseStart = timeline.length;
  await service.addMagnet({
    magnet: MAGNET,
    rightsConfirmed: true,
    startPaused: true,
    destination: { libraryRoot: library, createSubfolder: true },
  });
  const planned = registry.get(HASH);
  assert.equal(planned.plan.libraryRoot, canonicalLibrary);
  assert.equal(planned.plan.createSubfolder, true);
  assert.equal(planned.safe, null);
  assert.equal(path.resolve(state.torrents[0].download_dir), path.resolve(quarantine));
  assert.equal(timeline.some(({ method }) => method === "torrent_start" || method === "torrent_start_now"), false);
  await service.initializeSharing();
  await service.start(1);
  assert.equal(state.torrents[0].status, 4);
  assert.equal(state.torrents[0].upload_limited, false, "les pièces vérifiées restent échangeables pendant le téléchargement");
  assert.equal(state.torrents[0].seed_ratio_mode, 1);
  assert.equal(state.torrents[0].seed_ratio_limit, 0, "Transmission arrêtera ce torrent dès son passage à 100 %");
  await service.maintainSharing();
  assert.equal(state.torrents[0].upload_limited, false, "la maintenance ne réintroduit pas une limite nulle");
  assert.equal(state.torrents[0].seed_ratio_mode, 1);
  assert.equal(state.torrents[0].seed_ratio_limit, 0);
  assert.equal(
    timeline.slice(downloadPhaseStart).some(({ method, params }) => method === "torrent_set"
      && params?.upload_limited === true && params?.upload_limit === 0),
    false,
    "aucun chemin magnet, démarrage ou maintenance ne bloque la réciprocité",
  );

  const quarantinedFile = path.join(quarantine, "episode-01.mkv");
  await writeFile(quarantinedFile, "safe", "utf8");
  Object.assign(state.torrents[0], {
    status: 6,
    percent_done: 1,
    downloaded_ever: 4,
    files: [{ name: "episode-01.mkv", length: 4, bytes_completed: 4 }],
  });
  const validationPhaseStart = timeline.length;
  const maintenance = await service.maintainValidation();
  assert.equal(maintenance.checked, true);
  assert.deepEqual(maintenance.stoppedIds, [1]);
  const validation = maintenance.result;
  assert.equal(validation.clean, true);
  assert.equal(validation.moved, true);
  assert.equal(validation.resumed, true);
  assert.equal(state.torrents[0].status, 6);
  assert.equal(state.torrents[0].upload_limited, false);
  assert.equal(state.torrents[0].seed_ratio_mode, 0, "le seed validé reprend la politique globale");
  assert.deepEqual(defenderSnapshots, [{ status: 0, safe: null }], "Defender analyse uniquement un torrent arrêté et encore non approuvé");

  const expectedDirectory = await realpath(path.join(library, "Serie Test"));
  const finalFile = path.join(expectedDirectory, "episode-01.mkv");
  assert.equal(path.resolve(state.torrents[0].download_dir), path.resolve(expectedDirectory));
  assert.equal((await stat(finalFile)).size, 4);
  await assert.rejects(stat(quarantinedFile), (error) => error?.code === "ENOENT");
  const setLocation = timeline.find(({ method }) => method === "torrent_set_location");
  assert.deepEqual(setLocation?.params, { ids: [1], location: expectedDirectory, move: true });

  const validationTimeline = timeline.slice(validationPhaseStart);
  const indexOf = (predicate) => validationTimeline.findIndex(predicate);
  const stopIndex = indexOf(({ method }) => method === "torrent_stop");
  const verifyIndex = indexOf(({ method }) => method === "torrent_verify");
  const verificationCleanIndex = indexOf(({ event }) => event === "torrent.verification_clean");
  const defenderIndex = indexOf(({ type }) => type === "defender-scan");
  const moveIndex = indexOf(({ method }) => method === "torrent_set_location");
  const persistedIndex = indexOf(({ event }) => event === "torrent.safe_persisted");
  const startIndex = indexOf(({ method }) => method === "torrent_start_now" || method === "torrent_start");
  assert.ok(stopIndex < verifyIndex, "le torrent est arrêté avant la vérification complète");
  assert.ok(verifyIndex < verificationCleanIndex, "la vérification Transmission se termine en premier");
  assert.ok(verificationCleanIndex < defenderIndex, "Defender intervient après la vérification des pièces");
  assert.ok(defenderIndex < moveIndex, "le déplacement attend le résultat antivirus");
  assert.ok(moveIndex < persistedIndex, "le statut sûr est persisté après le déplacement");
  assert.ok(persistedIndex < startIndex, "le partage ne démarre qu'après la persistance du statut sûr");
  assert.equal(validationTimeline.filter(({ method }) => method === "torrent_start_now" || method === "torrent_start").length, 1);

  const persistedRegistry = new ContentRegistry(registryDirectory);
  let restorationScans = 0;
  const restoredService = serviceWith({
    manager,
    registry: persistedRegistry,
    timeline,
    scanFile: async () => {
      restorationScans += 1;
      throw new Error("Defender ne doit pas rescanner une validation persistée intacte.");
    },
  });
  assert.deepEqual(await restoredService.initializeSecurity(), { ok: true, restored: 1, pending: 0 });
  assert.equal(restorationScans, 0);
  assert.equal((await restoredService.list())[0].files[0].scanStatus, "clean");
  const restoredEntry = persistedRegistry.get(HASH);
  assert.equal(restoredEntry.safe.finalDirectory, expectedDirectory);
  assert.equal(restoredEntry.safe.files[0].filePath, finalFile);
  await restoredService.initializeSharing();
  state.torrents[0].status = 0;
  const restoredMaintenance = await restoredService.maintainSharing();
  assert.deepEqual(restoredMaintenance.restartedIds, [1]);
  assert.equal(state.torrents[0].status, 6, "la maintenance peut partager un statut sûr restauré");

  await writeFile(finalFile, "tampered", "utf8");
  const staleRegistry = new ContentRegistry(registryDirectory);
  const staleService = serviceWith({
    manager,
    registry: staleRegistry,
    timeline,
    scanFile: async () => {
      throw new Error("Une restauration invalide ne doit pas lancer Defender implicitement.");
    },
  });
  const stalePhaseStart = timeline.length;
  assert.deepEqual(await staleService.initializeSecurity(), { ok: true, restored: 0, pending: 1 });
  assert.equal(staleRegistry.get(HASH).safe, null);
  assert.equal((await staleService.list())[0].files[0].scanStatus, "not-scanned");
  await staleService.initializeSharing();
  assert.equal(state.torrents[0].status, 0, "le démarrage sécurisé arrête un partage dont le fichier a changé");
  assert.equal(
    timeline.slice(stalePhaseStart).some(({ method }) => method === "torrent_stop"),
    true,
    "le torrent altéré est stoppé",
  );
  const startsBeforeRefusal = timeline.filter(({ method }) => method === "torrent_start" || method === "torrent_start_now").length;
  await assert.rejects(staleService.start(1), /Vérifiez et analysez/u);
  assert.equal(
    timeline.filter(({ method }) => method === "torrent_start" || method === "torrent_start_now").length,
    startsBeforeRefusal,
    "aucun partage ne redémarre sans nouvelle validation",
  );
});

test("la garde de fin restaure la politique individuelle après validation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "slyorent-individual-guard-"));
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    await rm(resolved, { recursive: true, force: true });
  });
  const quarantine = path.join(root, "quarantine");
  const library = path.join(root, "library");
  const profile = path.join(root, "profile");
  await Promise.all([quarantine, library, profile].map((directory) => mkdir(directory, { recursive: true })));
  const timeline = [];
  const { manager, state } = localManager({ quarantine, library, profile, timeline });
  const registry = new ContentRegistry(path.join(profile, "content-security"));
  const service = serviceWith({
    manager,
    registry,
    timeline,
    scanFile: async (filePath) => {
      timeline.push({ type: "defender-scan", filePath });
      const file = await stat(filePath);
      return { size: file.size, mtimeMs: file.mtimeMs };
    },
  });

  await service.initializeSecurity();
  await service.addMagnet({
    magnet: MAGNET,
    rightsConfirmed: true,
    startPaused: true,
    destination: { libraryRoot: library, createSubfolder: true },
  });
  await service.initializeSharing();
  await service.setGlobalSharing({
    enabled: false,
    shareMode: "individual",
    ratioLimit: null,
    idleMinutes: null,
    uploadLimitKbps: null,
    portMapping: false,
    priorityMode: false,
  });
  await service.setSeedPolicy({ id: 1, ratioLimit: 2.5, idleMinutes: 45, uploadLimitKbps: 128 });
  await service.start(1);
  assert.equal(state.torrents[0].status, 4);
  assert.equal(state.torrents[0].upload_limited, true, "une limite individuelle non nulle reste active");
  assert.equal(state.torrents[0].upload_limit, 128);
  assert.equal(state.torrents[0].seed_ratio_mode, 1);
  assert.equal(state.torrents[0].seed_ratio_limit, 0, "la limite de ratio utilisateur est temporairement remplacée par la garde de fin");

  const quarantinedFile = path.join(quarantine, "episode-01.mkv");
  await writeFile(quarantinedFile, "safe", "utf8");
  Object.assign(state.torrents[0], {
    status: 6,
    percent_done: 1,
    downloaded_ever: 4,
    files: [{ name: "episode-01.mkv", length: 4, bytes_completed: 4 }],
  });
  const maintenance = await service.maintainValidation();
  assert.equal(maintenance.result.clean, true);
  assert.equal(maintenance.result.resumed, true);
  assert.equal(state.torrents[0].status, 6);
  assert.equal(state.torrents[0].seed_ratio_mode, 1);
  assert.equal(state.torrents[0].seed_ratio_limit, 2.5, "la limite de ratio choisie est restaurée après validation");
  assert.equal(state.torrents[0].seed_idle_mode, 1);
  assert.equal(state.torrents[0].seed_idle_limit, 45);
  assert.equal(state.torrents[0].upload_limited, true);
  assert.equal(state.torrents[0].upload_limit, 128);
});

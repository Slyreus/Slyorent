import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TorrentService } from "../electron/torrent-service.mjs";

const HASH = "0123456789abcdef0123456789abcdef01234567";
const SECOND_HASH = "89abcdef0123456789abcdef0123456789abcdef";
const THIRD_HASH = "fedcba9876543210fedcba9876543210fedcba98";
const MAGNET = `magnet:?xt=urn:btih:${HASH}&dn=Contenu%20autorise`;

function rawTorrent(overrides = {}) {
  return {
    id: 1,
    hash_string: HASH,
    name: "Contenu autorisé",
    status: 0,
    percent_done: 0,
    metadata_percent_complete: 0,
    rate_download: 0,
    rate_upload: 0,
    eta: -1,
    upload_ratio: 0,
    uploaded_ever: 0,
    downloaded_ever: 0,
    seconds_seeding: 0,
    size_when_done: 0,
    peers_connected: 0,
    peers_getting_from_us: 0,
    peers_sending_to_us: 0,
    error_string: "",
    is_private: false,
    download_dir: "C:\\quarantine",
    files: [],
    file_stats: [],
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
    ...overrides,
  };
}

function defaultSession(overrides = {}) {
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
    ...overrides,
  };
}

function clone(value) {
  return structuredClone(value);
}

function statefulHarness({
  directory = "C:\\quarantine",
  torrents = [rawTorrent()],
  session = defaultSession(),
  sessionStats = {},
  portTest = { port_is_open: null, ip_protocol: "ipv4" },
  torrentAdded = null,
  failOnce = null,
  managerStatus = { uploadSlotsPerTorrent: 8 },
  verificationSequence = null,
  defenderHealthCheck,
  scanFile,
  verificationTimeoutMs,
  verificationPollMs,
  contentRegistry,
} = {}) {
  const calls = [];
  const events = [];
  const state = { session: clone(session), torrents: torrents.map((torrent) => clone(torrent)) };
  let failureUsed = false;
  const runtime = { portMapping: Boolean(session.port_forwarding_enabled) };
  let pendingVerificationStates = [];
  const manager = {
    paths: { data: directory, profile: directory },
    status: () => ({ ...managerStatus, portMapping: runtime.portMapping, downloadDir: directory }),
    async resolveAllowedDownloadRoot(candidate) {
      const resolvedCandidate = path.resolve(candidate);
      const resolvedDirectory = path.resolve(directory);
      const relative = path.relative(resolvedDirectory, resolvedCandidate);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Répertoire non autorisé.");
      return resolvedDirectory;
    },
    notePortMapping(enabled) { runtime.portMapping = enabled === true; },
    rpc: {
      async call(method, params = {}) {
        calls.push({ method, params: clone(params) });
        if (!failureUsed && failOnce?.(method, params, calls.length)) {
          failureUsed = true;
          const error = new Error(`Échec RPC simulé: ${method}`);
          error.code = "SIMULATED_RPC_FAILURE";
          throw error;
        }
        if (method === "session_get") return clone(state.session);
        if (method === "session_stats") return clone(sessionStats);
        if (method === "port_test") {
          if (portTest instanceof Error) throw portTest;
          return clone(portTest);
        }
        if (method === "session_set") {
          Object.assign(state.session, clone(params));
          return {};
        }
        if (method === "torrent_get") {
          const ids = Array.isArray(params.ids) ? new Set(params.ids.map(Number)) : null;
          const response = { torrents: clone(ids ? state.torrents.filter(({ id }) => ids.has(Number(id))) : state.torrents) };
          if (pendingVerificationStates.length > 0) {
            const next = pendingVerificationStates.shift();
            for (const torrent of state.torrents) Object.assign(torrent, clone(next));
          }
          return response;
        }
        if (method === "torrent_set") {
          const ids = Array.isArray(params.ids) ? new Set(params.ids.map(Number)) : null;
          for (const torrent of state.torrents) {
            if (ids && !ids.has(Number(torrent.id))) continue;
            for (const [key, value] of Object.entries(params)) if (key !== "ids") torrent[key] = clone(value);
          }
          return {};
        }
        if (method === "torrent_start" || method === "torrent_start_now") {
          const ids = new Set((params.ids || state.torrents.map(({ id }) => id)).map(Number));
          for (const torrent of state.torrents) if (ids.has(Number(torrent.id))) torrent.status = Number(torrent.percent_done) >= 0.999999 ? 6 : 4;
          return {};
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
          const sequence = verificationSequence || [
            { status: 1, recheck_progress: 0 },
            { status: 2, recheck_progress: 0.5 },
            { status: 0, recheck_progress: 1 },
          ];
          if (sequence.length > 0) {
            for (const torrent of state.torrents) Object.assign(torrent, clone(sequence[0]));
            pendingVerificationStates = sequence.slice(1).map(clone);
          }
          return {};
        }
        if (method === "torrent_add") {
          if (torrentAdded) {
            const added = clone(torrentAdded);
            if (!state.torrents.some(({ id }) => Number(id) === Number(added.id))) state.torrents.push(added);
            return { torrent_added: { id: Number(added.id) } };
          }
          return { torrent_added: { id: 1 } };
        }
        if (method === "torrent_remove") {
          const ids = new Set((params.ids || []).map(Number));
          state.torrents = state.torrents.filter(({ id }) => !ids.has(Number(id)));
          return {};
        }
        return {};
      },
    },
  };
  const audit = { append: async (event, details) => events.push({ event, details: clone(details) }) };
  const mediaVault = { revokeTorrent() {}, issue() { throw new Error("non utilisé"); } };
  return {
    service: new TorrentService({
      manager,
      audit,
      mediaVault,
      ...(defenderHealthCheck ? { defenderHealthCheck } : {}),
      ...(scanFile ? { scanFile } : {}),
      ...(verificationTimeoutMs ? { verificationTimeoutMs } : {}),
      ...(verificationPollMs ? { verificationPollMs } : {}),
      ...(contentRegistry ? { contentRegistry } : {}),
    }),
    manager, audit, mediaVault, calls, events, state, runtime,
  };
}

async function temporaryHarness(context, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "secutorrent-sharing-v2-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const torrents = (options.torrents || [rawTorrent()]).map((torrent) => ({ ...torrent, download_dir: directory }));
  return { directory, ...statefulHarness({ ...options, directory, torrents }) };
}

function globalPolicy(overrides = {}) {
  return {
    schemaVersion: 2,
    enabled: true,
    shareMode: "share-all",
    ratioLimit: null,
    idleMinutes: null,
    uploadLimitKbps: null,
    portMapping: false,
    priorityMode: true,
    ...overrides,
  };
}

async function healthyDefender() {
  return { healthy: true, signatureUpdatedAt: "2026-08-21T08:00:00.000Z" };
}

async function cleanFileScan(filePath) {
  const info = await stat(filePath);
  return { size: info.size, mtimeMs: info.mtimeMs };
}

function diagnosticTracker(overrides = {}) {
  return {
    announce: "https://tracker.example/announce",
    announce_state: 0,
    has_announced: true,
    last_announce_succeeded: true,
    last_announce_timed_out: false,
    last_announce_result: "Success",
    last_announce_time: 1_700_000_000,
    next_announce_time: 1_700_001_800,
    seeder_count: 10,
    leecher_count: 3,
    download_count: 50,
    downloader_count: 3,
    last_announce_peer_count: 12,
    ...overrides,
  };
}

test("un magnet autorisé est toujours ajouté en pause et sans démarrage implicite", async () => {
  const { service, calls, events } = statefulHarness();
  const result = await service.addMagnet({ magnet: MAGNET, rightsConfirmed: true, startPaused: true });
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], { method: "torrent_add", params: { filename: MAGNET, paused: true, download_dir: "C:\\quarantine" } });
  assert.equal(calls.some(({ method }) => method === "torrent_start" || method === "torrent_start_now"), false);
  assert.equal(events[0].event, "torrent.added");
  assert.equal(events[0].details.rightsConfirmed, true);
});

test("l'ajout est refusé avant tout RPC sans confirmation explicite", async () => {
  const { service, calls } = statefulHarness();
  await assert.rejects(service.addMagnet({ magnet: MAGNET, rightsConfirmed: false, startPaused: true }), /confirmer vos droits/u);
  await assert.rejects(service.addMagnet({ magnet: MAGNET, rightsConfirmed: true, startPaused: false }), /ajouté en pause/u);
  assert.deepEqual(calls, []);
});

test("le démarrage refuse les trackers locaux avant toute mutation", async () => {
  const { service, calls } = statefulHarness({ torrents: [rawTorrent({ trackers: [{ announce: "http://127.0.0.1:8080/announce" }] })] });
  await assert.rejects(service.start(1), /réseau local ou réservé/u);
  assert.deepEqual(calls.map(({ method }) => method), ["torrent_get"]);
});

test("une politique V1 persistée migre vers schemaVersion 2 et active explicitement priorityMode", async (context) => {
  const harness = await temporaryHarness(context);
  await writeFile(path.join(harness.directory, "global-sharing-policy.json"), `${JSON.stringify({
    enabled: true, shareMode: "individual", ratioLimit: null, idleMinutes: null, uploadLimitKbps: null, portMapping: false,
  })}\n`, "utf8");
  const policy = await harness.service.initializeSharing();
  const stored = JSON.parse(await readFile(path.join(harness.directory, "global-sharing-policy.json"), "utf8"));
  assert.equal(policy.schemaVersion, 2);
  assert.equal(policy.priorityMode, true);
  assert.equal(stored.schemaVersion, 2);
  assert.equal(stored.priorityMode, true);
});

test("un infohash multihash v2 reste présent dans la baseline sous sa forme canonique", async (context) => {
  const v2Hash = "a".repeat(64);
  const harness = await temporaryHarness(context, {
    torrents: [rawTorrent({ hash_string: `1220${v2Hash}` })],
  });

  await harness.service.initializeSharing();
  const stored = JSON.parse(await readFile(path.join(harness.directory, "individual-sharing-baseline.json"), "utf8"));
  assert.equal(stored.torrents.length, 1);
  assert.equal(stored.torrents[0].hash_string, v2Hash);
});

test("le mode priorité V2 emploie les noms RPC 4.1, favorise la demande et ne réannonce jamais", async (context) => {
  const tracker = { announce: "https://1.1.1.1/announce" };
  const harness = await temporaryHarness(context, {
    torrents: [
      rawTorrent({ id: 1, hash_string: HASH, percent_done: 1, bandwidth_priority: -1, trackers: [tracker] }),
      rawTorrent({ id: 2, hash_string: SECOND_HASH, percent_done: 1, trackers: [tracker], tracker_stats: [{ ...tracker, last_announce_succeeded: true, leecher_count: 7 }] }),
      rawTorrent({ id: 3, hash_string: THIRD_HASH, percent_done: 0.5 }),
    ],
  });
  const result = await harness.service.setGlobalSharing(globalPolicy());
  const sessionCall = harness.calls.find(({ method }) => method === "session_set");
  const generalTorrentCall = harness.calls.find(({ method, params }) => method === "torrent_set" && "seed_ratio_mode" in params);
  const highCall = harness.calls.find(({ method, params }) => method === "torrent_set" && params.bandwidth_priority === 1);
  const normalCall = harness.calls.find(({ method, params }) => method === "torrent_set" && params.bandwidth_priority === 0);
  assert.equal(result.policy.schemaVersion, 2);
  assert.equal(result.policy.priorityMode, true);
  assert.equal(result.restartRequired, true);
  assert.deepEqual(result.effective, { bandwidthPriority: 1, uploadSlotsPerTorrent: 8, targetUploadSlotsPerTorrent: 4, seedQueueEnabled: false });
  assert.equal(sessionCall.params.seed_ratio_limited, false);
  assert.equal(Object.hasOwn(sessionCall.params, "ratio_limit_enabled"), false);
  assert.equal(sessionCall.params.seed_queue_enabled, false);
  assert.equal(sessionCall.params.queue_stalled_enabled, false);
  assert.deepEqual(generalTorrentCall.params.ids, [1, 2, 3]);
  assert.deepEqual(highCall.params.ids, [2]);
  assert.deepEqual(normalCall.params.ids, [1]);
  assert.deepEqual(harness.calls.find(({ method }) => method === "torrent_start_now"), { method: "torrent_start_now", params: { ids: [1, 2] } });
  assert.equal(harness.calls.some(({ method }) => method === "torrent_reannounce"), false);
  const stored = JSON.parse(await readFile(path.join(harness.directory, "global-sharing-policy.json"), "utf8"));
  assert.equal(stored.schemaVersion, 2);
  assert.equal(stored.priorityMode, true);
});

test("les trackers sont prévalidés avant la moindre mutation globale", async (context) => {
  const harness = await temporaryHarness(context, { torrents: [rawTorrent({ percent_done: 1, trackers: [{ announce: "http://127.0.0.1:6969/announce" }] })] });
  await assert.rejects(harness.service.setGlobalSharing(globalPolicy()), /réseau local ou réservé/u);
  const mutators = new Set(["session_set", "torrent_set", "torrent_start", "torrent_start_now", "torrent_stop", "torrent_reannounce"]);
  assert.equal(harness.calls.some(({ method }) => mutators.has(method)), false);
  assert.deepEqual(harness.calls.map(({ method }) => method).sort(), ["session_get", "torrent_get"]);
});

test("désactiver la politique V2 restaure la baseline de session et de torrent", async (context) => {
  const baselineSession = defaultSession({
    seed_ratio_limited: true, seed_ratio_limit: 1.75, idle_seeding_limit_enabled: true, idle_seeding_limit: 47,
    speed_limit_up_enabled: true, speed_limit_up: 731, port_forwarding_enabled: true, alt_speed_enabled: true,
    seed_queue_enabled: true, preferred_transports: ["tcp"], encryption: "required", queue_stalled_enabled: true,
    peer_limit_global: 123, peer_limit_per_torrent: 31,
  });
  const baselineTorrent = rawTorrent({
    percent_done: 1, bandwidth_priority: -1, peer_limit: 17, honors_session_limits: false,
    seed_ratio_mode: 1, seed_ratio_limit: 1.25, seed_idle_mode: 1, seed_idle_limit: 23,
    upload_limited: true, upload_limit: 456,
  });
  const harness = await temporaryHarness(context, { torrents: [baselineTorrent], session: baselineSession });
  await harness.service.initializeSharing();
  await harness.service.setGlobalSharing(globalPolicy({ enabled: false, shareMode: "individual", portMapping: true, priorityMode: false }));
  for (const [key, value] of Object.entries(baselineSession)) {
    if (key === "upload_slots_per_torrent") continue;
    assert.deepEqual(harness.state.session[key], value, `session.${key} doit revenir à la baseline`);
  }
  const restored = harness.state.torrents[0];
  for (const key of ["bandwidth_priority", "peer_limit", "honors_session_limits", "seed_ratio_mode", "seed_ratio_limit", "seed_idle_mode", "seed_idle_limit", "upload_limited", "upload_limit"]) {
    assert.deepEqual(restored[key], baselineTorrent[key], `torrent.${key} doit revenir à la baseline`);
  }
  assert.equal(harness.service.globalSharing().enabled, false);
});

test("un échec pendant le démarrage prioritaire déclenche un rollback complet", async (context) => {
  const originalSession = defaultSession({ speed_limit_up_enabled: true, speed_limit_up: 640 });
  const originalTorrent = rawTorrent({ percent_done: 1, status: 0, bandwidth_priority: 0, peer_limit: 29, upload_limited: true, upload_limit: 222 });
  const harness = await temporaryHarness(context, { torrents: [originalTorrent], session: originalSession, failOnce: (method) => method === "torrent_start_now" });
  const originalState = clone(harness.state);
  const previousPolicy = harness.service.globalSharing();
  await assert.rejects(harness.service.setGlobalSharing(globalPolicy({ ratioLimit: 3, uploadLimitKbps: 2_048, portMapping: true })), /Échec RPC simulé/u);
  assert.deepEqual(harness.state, originalState);
  assert.deepEqual(harness.service.globalSharing(), previousPolicy);
  assert.equal(harness.calls.filter(({ method }) => method === "torrent_start_now").length, 1);
  assert.equal(harness.calls.some(({ method }) => method === "torrent_stop"), true, "le rollback restaure aussi l'état arrêté");
});

test("un démarrage individuel utilise start_now lorsque la priorité globale est active", async () => {
  const { service, calls } = statefulHarness({ torrents: [rawTorrent({ percent_done: 1 })] });
  await service.start(1);
  assert.equal(calls.some(({ method }) => method === "torrent_start_now"), true);
  assert.equal(calls.some(({ method }) => method === "torrent_start"), false);
});

test("un nouveau téléchargement est prioritaire dès son démarrage et sans limite individuelle", async () => {
  const harness = statefulHarness({
    torrents: [rawTorrent({ percent_done: 0.25, status: 0, bandwidth_priority: 0, upload_limited: true, upload_limit: 64 })],
  });

  await harness.service.start(1);

  const priority = harness.calls.find(({ method, params }) => method === "torrent_set" && params.bandwidth_priority === 1);
  assert.deepEqual(priority?.params, {
    ids: [1], bandwidth_priority: 1, upload_limited: false, honors_session_limits: true, seed_ratio_mode: 0, seed_idle_mode: 0,
  });
  assert.equal(harness.calls.some(({ method }) => method === "torrent_start_now"), true);
  assert.equal(harness.state.torrents[0].status, 4);
});

test("le mode global d'arrêt bloque aussi les démarrages individuels", async (context) => {
  const harness = await temporaryHarness(context, { torrents: [rawTorrent({ percent_done: 1 })] });
  await harness.service.setGlobalSharing(globalPolicy({ shareMode: "stop-all", ratioLimit: 2, idleMinutes: 30, uploadLimitKbps: 512 }));
  await assert.rejects(harness.service.start(1), /Tout arrêter/u);
  assert.equal(harness.calls.some(({ method }) => method === "torrent_stop"), true);
});

test("le contrôle fusionné attend la vérification avant Defender puis reprend le seed", async (context) => {
  let harness;
  const scanPhases = [];
  harness = await temporaryHarness(context, {
    torrents: [rawTorrent({
      percent_done: 1,
      status: 6,
      files: [{ name: "media.bin", length: 4, bytes_completed: 4 }],
      file_stats: [{ wanted: true }],
    })],
    defenderHealthCheck: healthyDefender,
    scanFile: async (filePath) => {
      scanPhases.push({ status: harness.state.torrents[0].status, verifyCalls: harness.calls.filter(({ method }) => method === "torrent_verify").length });
      return cleanFileScan(filePath);
    },
    verificationPollMs: 10,
  });
  await writeFile(path.join(harness.directory, "media.bin"), "safe", "utf8");

  const result = await harness.service.verifyAndScan(1);

  assert.equal(result.clean, true);
  assert.equal(result.resumed, true);
  assert.equal(result.torrent.files[0].scanStatus, "clean");
  assert.deepEqual(scanPhases, [{ status: 0, verifyCalls: 1 }]);
  const events = harness.events.map(({ event }) => event);
  assert.ok(events.indexOf("torrent.verification_clean") < events.indexOf("torrent.scan_started"));
  assert.ok(harness.calls.findIndex(({ method }) => method === "torrent_verify") < harness.calls.findIndex(({ method }) => method === "torrent_start_now"));
  assert.equal(harness.state.torrents[0].status, 6);
});

test("le contrôle fusionné respecte Tout arrêter après un résultat propre", async (context) => {
  const harness = await temporaryHarness(context, {
    torrents: [rawTorrent({ percent_done: 1, status: 0, files: [], file_stats: [] })],
    defenderHealthCheck: healthyDefender,
    scanFile: cleanFileScan,
    verificationPollMs: 10,
  });
  await harness.service.setGlobalSharing(globalPolicy({ shareMode: "stop-all" }));
  harness.calls.length = 0;

  const result = await harness.service.verifyAndScan(1);

  assert.equal(result.clean, true);
  assert.equal(result.resumed, false);
  assert.equal(harness.calls.some(({ method }) => method === "torrent_start" || method === "torrent_start_now"), false);
});

test("des pièces manquantes après vérification empêchent Defender mais permettent la réparation", async (context) => {
  let scanCalls = 0;
  const harness = await temporaryHarness(context, {
    torrents: [rawTorrent({
      percent_done: 1,
      status: 6,
      files: [{ name: "media.bin", length: 4, bytes_completed: 4 }],
      file_stats: [{ wanted: true }],
    })],
    verificationSequence: [
      { status: 1, recheck_progress: 0 },
      { status: 2, recheck_progress: 0.5 },
      { status: 0, recheck_progress: 1, percent_done: 0.5, files: [{ name: "media.bin", length: 4, bytes_completed: 2 }] },
    ],
    defenderHealthCheck: healthyDefender,
    scanFile: async () => { scanCalls += 1; return { size: 4, mtimeMs: 1 }; },
    verificationPollMs: 10,
  });
  await writeFile(path.join(harness.directory, "media.bin"), "safe", "utf8");

  await assert.rejects(harness.service.verifyAndScan(1), /pièces sont manquantes/u);
  assert.equal(scanCalls, 0);
  assert.equal(harness.state.torrents[0].status, 0);
  const quarantine = JSON.parse(await readFile(path.join(harness.directory, "sharing-quarantine.json"), "utf8"));
  assert.deepEqual(quarantine.entries, []);
  await harness.service.start(1);
  assert.equal(harness.state.torrents[0].status, 4);
});

test("un double contrôle simultané est refusé", async (context) => {
  const harness = await temporaryHarness(context, {
    torrents: [rawTorrent({ percent_done: 1, status: 0, files: [], file_stats: [] })],
    defenderHealthCheck: healthyDefender,
    scanFile: cleanFileScan,
    verificationPollMs: 10,
  });

  const first = harness.service.verifyAndScan(1);
  await assert.rejects(harness.service.verifyAndScan(1), /déjà en cours/u);
  await first;
  assert.equal(harness.calls.filter(({ method }) => method === "torrent_verify").length, 1);
});

test("un échec Defender après vérification maintient l'arrêt et la quarantaine", async (context) => {
  const harness = await temporaryHarness(context, {
    torrents: [rawTorrent({
      percent_done: 1,
      status: 6,
      files: [{ name: "media.bin", length: 4, bytes_completed: 4 }],
      file_stats: [{ wanted: true }],
    })],
    defenderHealthCheck: healthyDefender,
    scanFile: async () => { throw Object.assign(new Error("Menace simulée"), { code: "THREAT_FOUND" }); },
    verificationPollMs: 10,
  });
  await writeFile(path.join(harness.directory, "media.bin"), "safe", "utf8");

  await assert.rejects(harness.service.verifyAndScan(1), /Menace simulée/u);
  assert.equal(harness.state.torrents[0].status, 0);
  assert.equal(harness.calls.some(({ method }) => method === "torrent_start" || method === "torrent_start_now"), false);
  const quarantine = JSON.parse(await readFile(path.join(harness.directory, "sharing-quarantine.json"), "utf8"));
  assert.equal(quarantine.entries.length, 1);
  assert.equal(quarantine.entries[0].reason, "scan-failed");
  await assert.rejects(harness.service.start(1), /partage reste bloqué/u);
});

test("une analyse propre reprend un torrent qui partageait en mode priorité", async (context) => {
  const harness = await temporaryHarness(context, {
    torrents: [rawTorrent({ percent_done: 1, status: 6, files: [], file_stats: [] })],
    defenderHealthCheck: healthyDefender,
    scanFile: cleanFileScan,
  });
  const result = await harness.service.scan(1);
  assert.equal(result.clean, true);
  assert.equal(harness.calls.some(({ method }) => method === "torrent_stop"), true);
  assert.equal(harness.calls.some(({ method }) => method === "torrent_start_now"), true);
  assert.equal(harness.state.torrents[0].status, 6);
});

test("une analyse échouée laisse impérativement le torrent stoppé", async (context) => {
  const harness = await temporaryHarness(context, {
    torrents: [rawTorrent({ percent_done: 1, status: 6, rate_download: 100, files: [{ name: "incomplet.bin", length: 1, bytes_completed: 0 }], file_stats: [{ wanted: true }] })],
  });
  await assert.rejects(harness.service.scan(1), /incomplet/u);
  assert.equal(harness.state.torrents[0].status, 0);
  const stopIndex = harness.calls.findIndex(({ method }) => method === "torrent_stop");
  assert.notEqual(stopIndex, -1);
  assert.equal(harness.calls.slice(stopIndex + 1).some(({ method }) => method === "torrent_start" || method === "torrent_start_now"), false);
});

test("maintainSharing relance uniquement les seeds complets stoppés avec start_now, sans réannonce", async () => {
  const harness = statefulHarness({
    torrents: [
      rawTorrent({ id: 1, hash_string: HASH, percent_done: 1, status: 0, bandwidth_priority: 1 }),
      rawTorrent({ id: 2, hash_string: SECOND_HASH, percent_done: 1, status: 6, bandwidth_priority: 1 }),
      rawTorrent({ id: 3, hash_string: THIRD_HASH, percent_done: 0.75, status: 0, bandwidth_priority: 0 }),
      rawTorrent({ id: 4, hash_string: "1111111111111111111111111111111111111111", percent_done: 1, status: 5, bandwidth_priority: 1 }),
    ],
  });

  const result = await harness.service.maintainSharing();

  assert.equal(result.changed, true);
  assert.deepEqual(result.restartedIds, [1]);
  assert.deepEqual(harness.calls.filter(({ method }) => method === "torrent_start_now"), [{ method: "torrent_start_now", params: { ids: [1] } }]);
  assert.equal(harness.calls.some(({ method }) => method === "torrent_start"), false);
  assert.equal(harness.calls.some(({ method }) => method === "torrent_reannounce"), false);
  assert.equal(harness.state.torrents.find(({ id }) => id === 1).status, 6);
  assert.equal(harness.state.torrents.find(({ id }) => id === 3).status, 0);
});

test("maintainSharing prévalide les trackers avant toute mutation", async () => {
  const harness = statefulHarness({
    torrents: [rawTorrent({ percent_done: 1, status: 0, trackers: [{ announce: "http://127.0.0.1:6969/announce" }] })],
  });

  await assert.rejects(harness.service.maintainSharing(), /réseau local ou réservé/u);

  const mutators = new Set(["session_set", "torrent_set", "torrent_start", "torrent_start_now", "torrent_stop", "torrent_reannounce"]);
  assert.equal(harness.calls.some(({ method }) => mutators.has(method)), false);
  assert.deepEqual(harness.calls.map(({ method }) => method).sort(), ["session_get", "torrent_get"]);
});

test("sharingDiagnostics expose les volumes réels, la performance et expurge URL et passkey", async () => {
  const secretUrl = "https://tracker.example/announce?passkey=PASSKEY-BRUTE-INTERDITE";
  const secretHex = "0123456789abcdef0123456789abcdef01234567";
  const harness = statefulHarness({
    torrents: [
      rawTorrent({
        id: 1,
        percent_done: 1,
        status: 6,
        rate_upload: 512_000,
        uploaded_ever: 10_000,
        downloaded_ever: 2_000,
        upload_ratio: 5,
        peers_connected: 2,
        peers_getting_from_us: 1,
        bandwidth_priority: 1,
        tracker_stats: [diagnosticTracker({ announce: secretUrl, last_announce_result: `Erreur ${secretUrl} jeton ${secretHex}` })],
      }),
      rawTorrent({
        id: 2,
        hash_string: SECOND_HASH,
        percent_done: 1,
        status: 5,
        rate_upload: 1_000,
        uploaded_ever: 500,
        peers_connected: 1,
        bandwidth_priority: 0,
        tracker_stats: [diagnosticTracker()],
      }),
    ],
    session: defaultSession({
      peer_port: 51_413,
      port_forwarding_enabled: true,
      seed_queue_enabled: false,
      speed_limit_up_enabled: true,
      speed_limit_up: 4_096,
      peer_limit_global: 321,
      peer_limit_per_torrent: 67,
      upload_slots_per_torrent: 4,
    }),
    sessionStats: { upload_speed: 600_000, cumulative_stats: { uploaded_bytes: 12_000 }, active_torrent_count: 2 },
    portTest: { port_is_open: true, ip_protocol: "ipv4" },
    managerStatus: { uploadSlotsPerTorrent: 4 },
  });

  const diagnostics = await harness.service.sharingDiagnostics();

  assert.equal(diagnostics.verdict, "healthy");
  assert.deepEqual(diagnostics.totals, { rateUpload: 600_000, uploadedBytes: 12_000, activeTorrents: 2 });
  assert.deepEqual(diagnostics.performance, {
    priorityMode: true,
    bandwidthPriority: 1,
    uploadSlotsPerTorrent: 4,
    seedQueueEnabled: false,
    highPriorityTorrents: 1,
    activeSeedTorrents: 2,
    connectedPeers: 3,
    activeUploadPeers: 1,
    completePeers: 0,
    incompletePeers: 0,
    interestedPeers: 0,
    locallyChokedPeers: 0,
    unchokedInterestedPeers: 0,
    uploadRate: 513_000,
    uploadedEver: 10_500,
    peerLimitGlobal: 321,
    peerLimitPerTorrent: 67,
    uploadLimitKbps: 4_096,
    encryption: "preferred",
    transports: ["utp", "tcp"],
  });
  assert.equal(diagnostics.torrents[0].trackers[0].host, "tracker.example");
  const serialized = JSON.stringify(diagnostics);
  assert.equal(serialized.includes(secretUrl), false);
  assert.equal(serialized.includes("PASSKEY-BRUTE-INTERDITE"), false);
  assert.equal(serialized.includes(secretHex), false);
  assert.equal(harness.calls.some(({ method }) => method === "session_stats"), true);
  assert.equal(harness.calls.some(({ method }) => method === "port_test"), true);
});

test("sharingDiagnostics récupère l'infohash requis par le registre de sécurité", async () => {
  const hashes = [];
  const harness = statefulHarness({
    torrents: [rawTorrent({ percent_done: 1, status: 6 })],
    contentRegistry: {
      get(hash) {
        hashes.push(hash);
        return null;
      },
    },
  });

  const diagnostics = await harness.service.sharingDiagnostics();
  const torrentGet = harness.calls.find(({ method }) => method === "torrent_get");

  assert.equal(diagnostics.torrents.length, 1);
  assert.equal(torrentGet.params.fields.includes("hash_string"), true);
  assert.deepEqual(hashes, [HASH]);
});

test("sharingDiagnostics agrège le flux des pairs sans exposer leurs identifiants", async () => {
  const peerSecrets = {
    address: "198.51.100.73",
    client_name: "Client privé à ne jamais exposer",
    peer_id: "-UT9999-IDENTIFIANT-BRUT",
    flag_str: "DHEIX",
  };
  const passkey = "PASSKEY-PAIR-FLOW-INTERDITE";
  const harness = statefulHarness({
    torrents: [rawTorrent({
      id: 1,
      percent_done: 1,
      status: 6,
      peers_connected: 5,
      tracker_stats: [diagnosticTracker({
        announce: `https://tracker.example/announce?passkey=${passkey}`,
        downloader_count: 31,
        last_announce_peer_count: 4,
      })],
      peers: [
        { ...peerSecrets, progress: 1, peer_is_interested: false, peer_is_choked: false, is_uploading_to: false, is_incoming: true, is_utp: true, is_encrypted: true, bytes_to_peer: 999, rate_to_peer: 0 },
        { ...peerSecrets, address: "198.51.100.74", progress: 0.4, peer_is_interested: false, peer_is_choked: false, is_uploading_to: false, is_incoming: false, is_utp: false, is_encrypted: false, bytes_to_peer: 0, rate_to_peer: 0 },
        { ...peerSecrets, address: "198.51.100.75", progress: 0.5, peer_is_interested: true, peer_is_choked: true, is_uploading_to: false, is_incoming: false, is_utp: false, is_encrypted: false, bytes_to_peer: 0, rate_to_peer: 0 },
        { ...peerSecrets, address: "198.51.100.76", progress: 0.6, peer_is_interested: true, peer_is_choked: false, is_uploading_to: false, is_incoming: false, is_utp: false, is_encrypted: false, bytes_to_peer: 2_048, rate_to_peer: 0 },
        { ...peerSecrets, address: "198.51.100.77", progress: 0.7, peer_is_interested: true, peer_is_choked: false, is_uploading_to: true, is_incoming: true, is_utp: true, is_encrypted: true, bytes_to_peer: 4_096, rate_to_peer: 512 },
      ],
    })],
    session: defaultSession({ peer_port: 51_413, port_forwarding_enabled: true, upload_slots_per_torrent: 4 }),
    portTest: { port_is_open: true, ip_protocol: "ipv4" },
    managerStatus: { uploadSlotsPerTorrent: 4 },
  });

  const diagnostics = await harness.service.sharingDiagnostics();

  assert.deepEqual(diagnostics.torrents[0].peerFlow, {
    connected: 5,
    complete: 1,
    incomplete: 4,
    interested: 3,
    unchokedInterested: 2,
    uploading: 1,
    incoming: 2,
    utp: 2,
    tcp: 3,
    encrypted: 2,
    bytesToPeers: 7_143,
    rateToPeers: 512,
  });
  assert.equal(diagnostics.performance.completePeers, 1);
  assert.equal(diagnostics.performance.incompletePeers, 4);
  assert.equal(diagnostics.performance.interestedPeers, 3);
  assert.equal(diagnostics.performance.unchokedInterestedPeers, 2);
  assert.equal(diagnostics.trackers, undefined);

  const serialized = JSON.stringify(diagnostics);
  for (const secret of [peerSecrets.address, peerSecrets.client_name, peerSecrets.peer_id, peerSecrets.flag_str, passkey, HASH]) {
    assert.equal(serialized.includes(secret), false, `Le diagnostic ne doit pas contenir ${secret}`);
  }
  assert.equal(serialized.includes("address"), false);
  assert.equal(serialized.includes("client_name"), false);
  assert.equal(serialized.includes("peer_id"), false);
  assert.equal(serialized.includes("flag_str"), false);
});

const peerFlowVerdicts = [
  {
    label: "seed-peers-only",
    peers: [{ progress: 1, peer_is_interested: false, peer_is_choked: false, is_uploading_to: false }],
    expected: "seed-peers-only",
  },
  {
    label: "peers-not-interested",
    peers: [{ progress: 0.5, peer_is_interested: false, peer_is_choked: false, is_uploading_to: false }],
    expected: "peers-not-interested",
  },
  {
    label: "locally-choked",
    peers: [{ progress: 0.5, peer_is_interested: true, peer_is_choked: true, is_uploading_to: false }],
    expected: "locally-choked",
  },
  {
    label: "awaiting-requests",
    peers: [{ progress: 0.5, peer_is_interested: true, peer_is_choked: false, is_uploading_to: false, rate_to_peer: 0 }],
    expected: "awaiting-requests",
  },
];

for (const scenario of peerFlowVerdicts) {
  test(`sharingDiagnostics produit le verdict ${scenario.label} depuis les états réels des pairs`, async () => {
    const harness = statefulHarness({
      torrents: [rawTorrent({
        percent_done: 1,
        status: 6,
        peers_connected: scenario.peers.length,
        tracker_stats: [diagnosticTracker({ leecher_count: 4 })],
        peers: scenario.peers,
      })],
      session: defaultSession({ peer_port: 51_413, port_forwarding_enabled: true, upload_slots_per_torrent: 4 }),
      portTest: { port_is_open: true, ip_protocol: "ipv4" },
      managerStatus: { uploadSlotsPerTorrent: 4 },
    });

    const diagnostics = await harness.service.sharingDiagnostics();

    assert.equal(diagnostics.verdict, scenario.expected);
  });
}

const diagnosticVerdicts = [
  {
    label: "ready-awaiting-peers",
    expected: "ready-awaiting-peers",
    port: true,
    torrent: { tracker_stats: [diagnosticTracker({ leecher_count: 4 })] },
  },
  {
    label: "reachable-no-demand",
    expected: "reachable-no-demand",
    port: true,
    torrent: { tracker_stats: [diagnosticTracker({ leecher_count: 0 })] },
  },
  {
    label: "closed",
    expected: "closed",
    port: false,
    torrent: { tracker_stats: [diagnosticTracker({ leecher_count: 4 })] },
  },
  {
    label: "tracker-error",
    expected: "tracker-error",
    port: true,
    torrent: { tracker_stats: [diagnosticTracker({ last_announce_succeeded: false, last_announce_result: "Connection failed" })] },
  },
  {
    label: "peers-choked",
    expected: "peers-choked",
    port: true,
    torrent: { peers_connected: 3, peers_getting_from_us: 0, rate_upload: 0, tracker_stats: [diagnosticTracker({ leecher_count: 4 })] },
  },
];

for (const scenario of diagnosticVerdicts) {
  test(`sharingDiagnostics produit le verdict ${scenario.label}`, async () => {
    const harness = statefulHarness({
      torrents: [rawTorrent({ percent_done: 1, status: 6, ...scenario.torrent })],
      session: defaultSession({ peer_port: 51_413, port_forwarding_enabled: true, upload_slots_per_torrent: 4 }),
      portTest: { port_is_open: scenario.port, ip_protocol: "ipv4" },
      managerStatus: { uploadSlotsPerTorrent: 4 },
    });

    const diagnostics = await harness.service.sharingDiagnostics();

    assert.equal(diagnostics.verdict, scenario.expected);
    assert.equal(diagnostics.port.reachable, scenario.port);
  });
}

test("sharingDiagnostics donne priorité au verdict policy-stopped", async (context) => {
  const harness = await temporaryHarness(context, {
    torrents: [rawTorrent({ percent_done: 1, status: 6, tracker_stats: [diagnosticTracker()] })],
    portTest: { port_is_open: true, ip_protocol: "ipv4" },
  });
  await harness.service.setGlobalSharing(globalPolicy({ shareMode: "stop-all" }));

  const diagnostics = await harness.service.sharingDiagnostics();

  assert.equal(diagnostics.verdict, "policy-stopped");
  assert.equal(diagnostics.performance.activeSeedTorrents, 0);
});

test("un ratio global atteint interdit toute relance automatique ou explicite", async (context) => {
  const torrent = rawTorrent({ percent_done: 1, status: 0, upload_ratio: 2.5, bandwidth_priority: 1 });
  const harness = await temporaryHarness(context, { torrents: [torrent] });
  const policy = globalPolicy({ ratioLimit: 2 });
  await writeFile(path.join(harness.directory, "global-sharing-policy.json"), `${JSON.stringify(policy)}\n`, "utf8");

  await harness.service.initializeSharing();
  await harness.service.setGlobalSharing(policy);
  const maintenance = await harness.service.maintainSharing();
  await assert.rejects(harness.service.start(1), /ratio global est déjà atteint/u);

  assert.equal(maintenance.changed, false);
  assert.deepEqual(maintenance.restartedIds, []);
  assert.equal(harness.calls.some(({ method }) => method === "torrent_start" || method === "torrent_start_now"), false);
  assert.equal(harness.state.torrents[0].status, 0);
});

test("idleMinutes bloque la maintenance automatique mais une action share-all explicite peut réarmer le seed", async (context) => {
  const harness = await temporaryHarness(context, {
    torrents: [rawTorrent({ percent_done: 1, status: 0, upload_ratio: 0.5, bandwidth_priority: 1 })],
  });
  const policy = globalPolicy({ ratioLimit: 2, idleMinutes: 30 });
  await writeFile(path.join(harness.directory, "global-sharing-policy.json"), `${JSON.stringify(policy)}\n`, "utf8");

  await harness.service.initializeSharing();
  const maintenance = await harness.service.maintainSharing();
  const startsBeforeUserAction = harness.calls.filter(({ method }) => method === "torrent_start" || method === "torrent_start_now").length;
  await harness.service.setGlobalSharing(policy);

  assert.equal(maintenance.changed, false);
  assert.equal(startsBeforeUserAction, 0);
  assert.deepEqual(harness.calls.filter(({ method }) => method === "torrent_start_now"), [{ method: "torrent_start_now", params: { ids: [1] } }]);
  assert.equal(harness.state.torrents[0].status, 6);
});

test("un échec d'analyse persiste la quarantaine entre instances, puis une analyse propre la lève", async (context) => {
  const harness = await temporaryHarness(context, {
    torrents: [rawTorrent({
      percent_done: 1,
      status: 6,
      files: [{ name: "incomplet.bin", length: 1, bytes_completed: 0 }],
      file_stats: [{ wanted: true }],
    })],
    defenderHealthCheck: healthyDefender,
    scanFile: cleanFileScan,
  });

  await assert.rejects(harness.service.scan(1), /incomplet/u);
  const quarantinePath = path.join(harness.directory, "sharing-quarantine.json");
  const failedRegistry = JSON.parse(await readFile(quarantinePath, "utf8"));
  assert.equal(failedRegistry.schemaVersion, 1);
  assert.equal(failedRegistry.entries.length, 1);
  assert.equal(failedRegistry.entries[0].hash, HASH);

  const startsAfterFailure = harness.calls.filter(({ method }) => method === "torrent_start" || method === "torrent_start_now").length;
  const maintenance = await harness.service.maintainSharing();
  assert.equal(maintenance.changed, false);
  assert.equal(harness.calls.filter(({ method }) => method === "torrent_start" || method === "torrent_start_now").length, startsAfterFailure);

  const restartedService = new TorrentService({
    manager: harness.manager,
    audit: harness.audit,
    mediaVault: harness.mediaVault,
    defenderHealthCheck: healthyDefender,
    scanFile: cleanFileScan,
  });
  const startsBeforeInitialize = harness.calls.filter(({ method }) => method === "torrent_start" || method === "torrent_start_now").length;
  await restartedService.initializeSharing();
  assert.equal(harness.calls.filter(({ method }) => method === "torrent_start" || method === "torrent_start_now").length, startsBeforeInitialize);
  assert.equal(harness.state.torrents[0].status, 0);
  const blockedDiagnostics = await restartedService.sharingDiagnostics();
  assert.equal(blockedDiagnostics.verdict, "security-blocked");
  assert.equal(blockedDiagnostics.torrents[0].sharingBlocked, true);

  harness.state.torrents[0].files = [];
  harness.state.torrents[0].file_stats = [];
  const clean = await restartedService.scan(1);
  const cleanRegistry = JSON.parse(await readFile(quarantinePath, "utf8"));
  assert.equal(clean.clean, true);
  assert.equal(clean.resumed, true);
  assert.deepEqual(cleanRegistry.entries, []);
  assert.equal(harness.state.torrents[0].status, 6);
});

test("passer priorityMode de true à false restaure seed_queue et queue_stalled depuis la baseline", async (context) => {
  const harness = await temporaryHarness(context, {
    session: defaultSession({ seed_queue_enabled: true, queue_stalled_enabled: false }),
  });

  await harness.service.initializeSharing();
  assert.equal(harness.state.session.seed_queue_enabled, false);
  assert.equal(harness.state.session.queue_stalled_enabled, false);

  await harness.service.setGlobalSharing(globalPolicy({ shareMode: "individual", priorityMode: false }));
  assert.equal(harness.state.session.seed_queue_enabled, true);
  assert.equal(harness.state.session.queue_stalled_enabled, false);
});

test("une baseline persistée est restaurée lorsque la politique démarre désactivée malgré un état manager écrasé", async (context) => {
  const persistedSession = defaultSession({
    seed_ratio_limited: true,
    seed_ratio_limit: 1.5,
    idle_seeding_limit_enabled: true,
    idle_seeding_limit: 45,
    speed_limit_up_enabled: true,
    speed_limit_up: 777,
    port_forwarding_enabled: true,
    alt_speed_enabled: true,
    seed_queue_enabled: true,
    preferred_transports: ["tcp"],
    encryption: "required",
    lpd_enabled: false,
    queue_stalled_enabled: true,
    peer_limit_global: 144,
    peer_limit_per_torrent: 33,
  });
  const persistedTorrent = rawTorrent({
    status: 0,
    percent_done: 1,
    bandwidth_priority: -1,
    peer_limit: 21,
    honors_session_limits: false,
    seed_ratio_mode: 1,
    seed_ratio_limit: 1.25,
    seed_idle_mode: 1,
    seed_idle_limit: 19,
    upload_limited: true,
    upload_limit: 345,
  });
  const harness = await temporaryHarness(context, {
    session: defaultSession({ seed_queue_enabled: false, queue_stalled_enabled: false, speed_limit_up_enabled: false }),
    torrents: [rawTorrent({ ...persistedTorrent, status: 6, bandwidth_priority: 1, peer_limit: 99, upload_limited: false, upload_limit: 0 })],
  });
  await writeFile(path.join(harness.directory, "global-sharing-policy.json"), `${JSON.stringify(globalPolicy({ enabled: false, shareMode: "individual", portMapping: true, priorityMode: false }))}\n`, "utf8");
  await writeFile(path.join(harness.directory, "individual-sharing-baseline.json"), `${JSON.stringify({
    schemaVersion: 1,
    session: persistedSession,
    torrents: [persistedTorrent],
  })}\n`, "utf8");

  await harness.service.initializeSharing();

  for (const key of [
    "seed_ratio_limited", "seed_ratio_limit", "idle_seeding_limit_enabled", "idle_seeding_limit", "speed_limit_up_enabled",
    "speed_limit_up", "port_forwarding_enabled", "alt_speed_enabled", "seed_queue_enabled", "preferred_transports", "encryption",
    "lpd_enabled", "queue_stalled_enabled", "peer_limit_global", "peer_limit_per_torrent",
  ]) assert.deepEqual(harness.state.session[key], persistedSession[key], `session.${key} doit provenir du fichier de baseline`);
  const restored = harness.state.torrents[0];
  for (const key of [
    "status", "bandwidth_priority", "peer_limit", "honors_session_limits", "seed_ratio_mode", "seed_ratio_limit",
    "seed_idle_mode", "seed_idle_limit", "upload_limited", "upload_limit",
  ]) assert.deepEqual(restored[key], persistedTorrent[key], `torrent.${key} doit provenir du fichier de baseline`);
});

test("un nouveau torrent ajouté sous override est capturé dans la baseline puis restauré en pause", async (context) => {
  const addedTorrent = rawTorrent({ id: 2, hash_string: SECOND_HASH, status: 0, bandwidth_priority: 0, peer_limit: 50 });
  const harness = await temporaryHarness(context, {
    torrents: [rawTorrent({ id: 1, hash_string: HASH, status: 0 })],
    torrentAdded: addedTorrent,
  });
  await harness.service.initializeSharing();

  const secondMagnet = `magnet:?xt=urn:btih:${SECOND_HASH}&dn=Nouveau%20contenu`;
  await harness.service.addMagnet({ magnet: secondMagnet, rightsConfirmed: true, startPaused: true });
  const persisted = JSON.parse(await readFile(path.join(harness.directory, "individual-sharing-baseline.json"), "utf8"));
  const captured = persisted.torrents.find(({ hash_string: hash }) => hash === SECOND_HASH);
  assert.equal(captured.status, 0);
  assert.equal(captured.bandwidth_priority, 0);

  const current = harness.state.torrents.find(({ id }) => id === 2);
  Object.assign(current, { status: 6, bandwidth_priority: 1, peer_limit: 120, upload_limited: true, upload_limit: 999 });
  await harness.service.setGlobalSharing(globalPolicy({ enabled: false, shareMode: "individual", priorityMode: false }));

  assert.equal(current.status, 0);
  assert.equal(current.bandwidth_priority, 0);
  assert.equal(current.peer_limit, 50);
  assert.equal(current.upload_limited, false);
  assert.equal(current.upload_limit, 0);
});

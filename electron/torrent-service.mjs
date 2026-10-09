import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { defenderHealth, scanFileWithDefender } from "./defender.mjs";
import { canonicalizeInfohash, isCanonicalInfohash } from "./infohash.mjs";
import { locateSelfWithWindows } from "./local-location.mjs";
import { assertSafeMagnetNetworkTargets, assertSafeTrackerUrls, inspectMagnet } from "./magnet-security.mjs";
import { isMediaName, validateMediaSignature } from "./media-vault.mjs";
import { PeerTelemetry } from "./peer-telemetry.mjs";

const MAX_TORRENT_FILE_SIZE = 10 * 1024 * 1024;
const MAX_FILES_PER_TORRENT = 10_000;
const DEFAULT_VERIFICATION_TIMEOUT_MS = 12 * 60 * 60 * 1_000;
const DEFAULT_VERIFICATION_POLL_MS = 250;
const DEFAULT_MOVE_TIMEOUT_MS = 30 * 60 * 1_000;
const TORRENT_FIELDS = [
  "id", "hash_string", "name", "status", "percent_done", "metadata_percent_complete", "added_date",
  "rate_download", "rate_upload", "eta", "upload_ratio", "uploaded_ever", "downloaded_ever",
  "seconds_seeding", "size_when_done", "peers_connected", "error_string", "is_private",
  "download_dir", "files", "file_stats", "trackers", "peers", "recheck_progress",
  "peers_getting_from_us", "peers_sending_to_us", "tracker_stats",
  "upload_limited", "upload_limit", "seed_ratio_mode", "seed_ratio_limit", "seed_idle_mode", "seed_idle_limit",
  "bandwidth_priority", "peer_limit", "honors_session_limits", "is_stalled", "queue_position",
];
const PEER_SNAPSHOT_FIELDS = ["id", "name", "peers"];

const STATUS_NAMES = new Map([
  [0, "stopped"], [1, "queued-verification"], [2, "verifying"],
  [3, "queued-download"], [4, "downloading"], [5, "queued-seed"], [6, "seeding"],
]);

function assertTorrentId(id) {
  if (!Number.isInteger(id) || id < 0 || id > 2_147_483_647) throw new Error("Identifiant torrent invalide.");
  return id;
}

function safeName(value, fallback = "Torrent sans nom") {
  return String(value || fallback)
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "")
    .slice(0, 512) || fallback;
}

function containsPath(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function samePath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(String(value || ""));
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function safeFolderName(value) {
  const cleaned = safeName(value, "Torrent")
    .replace(/[<>:"/\\|?*]/g, " ")
    .replace(/[. ]+$/u, "")
    .replace(/\s{2,}/gu, " ")
    .slice(0, 120)
    .trim();
  const candidate = cleaned || "Torrent";
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(candidate) ? `_${candidate}` : candidate;
}

async function resolveSafeTorrentFile(allowedRoot, downloadDir, torrentFileName) {
  if (typeof torrentFileName !== "string" || torrentFileName.includes("\0") || path.isAbsolute(torrentFileName)) throw new Error("Chemin de fichier torrent interdit.");
  const normalizedSegments = torrentFileName.replace(/\\/g, "/").split("/");
  if (normalizedSegments.some((segment) => segment === ".." || segment === "")) throw new Error("Chemin de fichier torrent ambigu.");
  const rootReal = await realpath(allowedRoot);
  const directoryReal = await realpath(downloadDir);
  if (!containsPath(rootReal, directoryReal)) throw new Error("Le torrent pointe hors du stockage Slyorrent.");
  const candidate = path.resolve(directoryReal, ...normalizedSegments);
  if (!containsPath(rootReal, candidate)) throw new Error("Le fichier pointe hors du stockage Slyorrent.");
  const linkInfo = await lstat(candidate);
  if (linkInfo.isSymbolicLink()) throw new Error("Les liens symboliques sont interdits dans les torrents.");
  const fileReal = await realpath(candidate);
  if (!containsPath(rootReal, fileReal)) throw new Error("Un lien de répertoire sort du stockage Slyorrent.");
  return fileReal;
}

function trackerUrls(torrent) {
  return (Array.isArray(torrent.trackers) ? torrent.trackers : [])
    .map((tracker) => tracker?.announce)
    .filter((value) => typeof value === "string");
}

const DEFAULT_GLOBAL_SHARING = Object.freeze({
  schemaVersion: 2,
  enabled: true,
  shareMode: "share-all",
  ratioLimit: null,
  idleMinutes: null,
  uploadLimitKbps: null,
  portMapping: false,
  priorityMode: true,
});

function boundedGlobalPolicy(input = {}) {
  const enabled = input.enabled !== false;
  const shareMode = new Set(["individual", "share-all", "stop-all"]).has(input.shareMode) ? input.shareMode : "individual";
  const ratioLimit = input.ratioLimit === null || input.ratioLimit === undefined ? null : Number(input.ratioLimit);
  const idleMinutes = input.idleMinutes === null || input.idleMinutes === undefined ? null : Number(input.idleMinutes);
  const uploadLimitKbps = input.uploadLimitKbps === null || input.uploadLimitKbps === undefined ? null : Number(input.uploadLimitKbps);
  if (ratioLimit !== null && (!Number.isFinite(ratioLimit) || ratioLimit < 0.1 || ratioLimit > 100)) throw new Error("Ratio global hors limites (0,1 à 100).");
  if (idleMinutes !== null && (!Number.isInteger(idleMinutes) || idleMinutes < 1 || idleMinutes > 10_080)) throw new Error("Inactivité globale hors limites (1 à 10080 minutes).");
  if (uploadLimitKbps !== null && (!Number.isInteger(uploadLimitKbps) || uploadLimitKbps < 1 || uploadLimitKbps > 1_000_000)) throw new Error("Limite globale d'upload hors limites.");
  if (typeof input.portMapping !== "boolean" && input.portMapping !== undefined) throw new Error("Choix de mappage de port invalide.");
  if (typeof input.priorityMode !== "boolean" && input.priorityMode !== undefined) throw new Error("Choix du mode priorité invalide.");
  return {
    schemaVersion: 2,
    enabled,
    shareMode,
    ratioLimit,
    idleMinutes,
    uploadLimitKbps,
    portMapping: input.portMapping === true,
    priorityMode: input.priorityMode !== false,
  };
}

function isRunningStatus(value) {
  return new Set([3, 4, 5, 6]).has(Number(value));
}

function boundedNumber(value, fallback, minimum, maximum, integer = false) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum && (!integer || Number.isInteger(number)) ? number : fallback;
}

function trackerHasDemand(torrent) {
  if (Number(torrent.peers_getting_from_us || 0) > 0) return true;
  return (torrent.tracker_stats || []).some((tracker) => tracker.last_announce_succeeded && Number(tracker.leecher_count || 0) > 0);
}

function ratioLimitReached(policy, torrent) {
  return policy.enabled && policy.ratioLimit !== null && Number(torrent.upload_ratio || 0) + Number.EPSILON >= policy.ratioLimit;
}

function eligibleForAutomaticSeedStart(policy, torrent, { userInitiated = false } = {}) {
  if (ratioLimitReached(policy, torrent)) return false;
  // Transmission traite un redémarrage après limite d'inactivité comme une reprise manuelle.
  // Une action explicite peut le réarmer. Au redémarrage, seule une activité assez récente prouve
  // que l'arrêt vient du démarrage sécurisé en pause et non de la limite déjà atteinte.
  if (policy.idleMinutes === null || userInitiated) return true;
  const activityDate = Number(torrent.activity_date || 0);
  const idleSeconds = Math.floor(Date.now() / 1_000) - activityDate;
  return activityDate > 0 && idleSeconds >= 0 && idleSeconds < policy.idleMinutes * 60;
}

function trackerResult(value) {
  return String(value || "")
    .replace(/https?:\/\/\S+/giu, "[URL protégée]")
    .replace(/[a-f\d]{24,}/giu, "[secret protégé]")
    .slice(0, 180);
}

function trackerHost(value) {
  try { return new URL(value).hostname.slice(0, 253); } catch { return "tracker invalide"; }
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function summarizePeerFlow(rawPeers) {
  const peers = Array.isArray(rawPeers) ? rawPeers.slice(0, 512) : [];
  const summary = {
    connected: peers.length,
    complete: 0,
    incomplete: 0,
    interested: 0,
    unchokedInterested: 0,
    uploading: 0,
    incoming: 0,
    utp: 0,
    tcp: 0,
    encrypted: 0,
    bytesToPeers: 0,
    rateToPeers: 0,
  };
  for (const peer of peers) {
    if (Number(peer?.progress || 0) >= 0.999999) summary.complete += 1;
    else summary.incomplete += 1;
    if (peer?.peer_is_interested === true) {
      summary.interested += 1;
      if (peer.peer_is_choked === false) summary.unchokedInterested += 1;
    }
    if (peer?.is_uploading_to === true) summary.uploading += 1;
    if (peer?.is_incoming === true) summary.incoming += 1;
    if (peer?.is_utp === true) summary.utp += 1;
    else if (peer?.is_utp === false) summary.tcp += 1;
    if (peer?.is_encrypted === true) summary.encrypted += 1;
    summary.bytesToPeers += nonNegativeNumber(peer?.bytes_to_peer);
    summary.rateToPeers += nonNegativeNumber(peer?.rate_to_peer);
  }
  return summary;
}

export class TorrentService {
  #manager;
  #audit;
  #mediaVault;
  #mediaAdapter;
  #adaptedScanRecords = new Map();
  #adaptedScansPending = new Map();
  #mediaPreparations = new Map();
  #mediaCancellations = new Map();
  #peerTelemetry;
  #selfLocator;
  #scanRecords = new Map();
  #scanningIds = new Set();
  #globalSharing = { ...DEFAULT_GLOBAL_SHARING };
  #globalSharingPath;
  #individualBaselinePath;
  #sharingQuarantinePath;
  #baselineSharingState = null;
  #sharingQuarantine = new Map();
  #sharingChain = Promise.resolve();
  #defenderHealth;
  #scanFile;
  #verificationTimeoutMs;
  #verificationPollMs;
  #moveTimeoutMs;
  #contentRegistry;

  constructor({
    manager,
    audit,
    mediaVault,
    mediaAdapter = null,
    peerTelemetry = new PeerTelemetry(),
    selfLocator = locateSelfWithWindows,
    defenderHealthCheck = defenderHealth,
    scanFile = scanFileWithDefender,
    verificationTimeoutMs = DEFAULT_VERIFICATION_TIMEOUT_MS,
    verificationPollMs = DEFAULT_VERIFICATION_POLL_MS,
    moveTimeoutMs = DEFAULT_MOVE_TIMEOUT_MS,
    contentRegistry = null,
  }) {
    this.#manager = manager;
    this.#audit = audit;
    this.#mediaVault = mediaVault;
    this.#mediaAdapter = mediaAdapter;
    this.#peerTelemetry = peerTelemetry;
    this.#selfLocator = selfLocator;
    this.#defenderHealth = defenderHealthCheck;
    this.#scanFile = scanFile;
    this.#contentRegistry = contentRegistry;
    this.#verificationTimeoutMs = boundedNumber(verificationTimeoutMs, DEFAULT_VERIFICATION_TIMEOUT_MS, 1_000, DEFAULT_VERIFICATION_TIMEOUT_MS, true);
    this.#verificationPollMs = boundedNumber(verificationPollMs, DEFAULT_VERIFICATION_POLL_MS, 10, 5_000, true);
    this.#moveTimeoutMs = boundedNumber(moveTimeoutMs, DEFAULT_MOVE_TIMEOUT_MS, 1_000, DEFAULT_MOVE_TIMEOUT_MS, true);
    this.#globalSharingPath = path.join(manager.paths.profile || manager.paths.data, "global-sharing-policy.json");
    this.#individualBaselinePath = path.join(manager.paths.profile || manager.paths.data, "individual-sharing-baseline.json");
    this.#sharingQuarantinePath = path.join(manager.paths.profile || manager.paths.data, "sharing-quarantine.json");
  }

  #registryEntry(torrentOrHash) {
    if (!this.#contentRegistry) return null;
    const hash = this.#sharingHash(torrentOrHash);
    return hash ? this.#contentRegistry.get(hash) : null;
  }

  #isSafeForSharing(torrent) {
    if (!this.#contentRegistry) return true;
    const entry = this.#registryEntry(torrent);
    if (!entry?.safe) return false;
    const wanted = (torrent.files || [])
      .map((file, index) => ({ file, index, wanted: torrent.file_stats?.[index]?.wanted !== false }))
      .filter(({ wanted }) => wanted);
    if (wanted.length !== entry.safe.files.length) return false;
    return wanted.every(({ file, index }) => {
      const record = this.#scanRecords.get(this.#scanKey(torrent.hash_string, index));
      return record?.status === "clean"
        && Number(file.bytes_completed) === Number(file.length)
        && Number(record.size) === Number(file.length);
    });
  }

  #isSharingProtected(torrent) {
    return this.#scanningIds.has(Number(torrent.id))
      || this.#isSharingQuarantined(torrent)
      || (Number(torrent.percent_done) >= 0.999999 && !this.#isSafeForSharing(torrent));
  }

  #isPreValidationDownload(torrent) {
    return Boolean(this.#contentRegistry) && Number(torrent.percent_done) < 0.999999;
  }

  async #enforcePreValidationExchangeGuard(torrents) {
    const incomplete = torrents.filter((torrent) => this.#isPreValidationDownload(torrent));
    const ids = incomplete.map((torrent) => Number(torrent.id));
    if (ids.length > 0) {
      await this.#manager.rpc.call("torrent_set", {
        ids,
        seed_ratio_mode: 1,
        seed_ratio_limit: 0,
        honors_session_limits: true,
      });
    }
    const releasedUploadIds = incomplete
      .filter((torrent) => Boolean(torrent.upload_limited) && Number(torrent.upload_limit) === 0)
      .map((torrent) => Number(torrent.id));
    if (releasedUploadIds.length > 0) {
      await this.#manager.rpc.call("torrent_set", { ids: releasedUploadIds, upload_limited: false, honors_session_limits: true });
    }
    return { guardedIds: ids, releasedUploadIds };
  }

  async #canonicalLibraryRoot(directory) {
    const allowedRoot = await this.#allowedDownloadRoot(directory);
    const canonical = await realpath(directory);
    if (!containsPath(allowedRoot, canonical)) throw new Error("La destination n'est plus autorisée.");
    const quarantine = await realpath(this.#manager.paths.data);
    if (containsPath(quarantine, canonical) || containsPath(canonical, quarantine)) {
      throw new Error("La bibliothèque doit rester distincte de la quarantaine.");
    }
    return canonical;
  }

  async #upsertDestinationPlan(raw, destination = null) {
    if (!this.#contentRegistry) return null;
    const libraryRoot = await this.#canonicalLibraryRoot(destination?.libraryRoot || this.#manager.status().downloadDir);
    const createSubfolder = destination?.createSubfolder !== false;
    return this.#contentRegistry.upsertPlan({ hash: raw.hash_string, libraryRoot, createSubfolder });
  }

  async #restoreSafeEntry(raw, entry) {
    try {
      if (!entry?.safe || !entry.plan || Number(raw.percent_done) < 0.999999) throw new Error("SAFE_RECORD_INCOMPLETE");
      const libraryRoot = await this.#canonicalLibraryRoot(entry.plan.libraryRoot);
      const finalDirectory = await realpath(entry.safe.finalDirectory);
      const rawDirectory = await realpath(raw.download_dir);
      if (!containsPath(libraryRoot, finalDirectory) || !samePath(finalDirectory, rawDirectory)) throw new Error("SAFE_RECORD_LOCATION_MISMATCH");
      const wantedFiles = (raw.files || [])
        .map((file, index) => ({ file, index, wanted: raw.file_stats?.[index]?.wanted !== false }))
        .filter(({ wanted }) => wanted);
      if (wantedFiles.length !== entry.safe.files.length) throw new Error("SAFE_RECORD_FILESET_MISMATCH");
      const persistedByIndex = new Map(entry.safe.files.map((file) => [Number(file.index), file]));
      const restored = [];
      for (const { file, index } of wantedFiles) {
        const persisted = persistedByIndex.get(index);
        if (!persisted || persisted.name !== file.name || Number(persisted.size) !== Number(file.length)
          || Number(file.bytes_completed) !== Number(file.length)) throw new Error("SAFE_RECORD_FILE_MISMATCH");
        const allowedRoot = await this.#allowedDownloadRoot(raw.download_dir);
        const filePath = await resolveSafeTorrentFile(allowedRoot, raw.download_dir, file.name);
        const current = await stat(filePath);
        if (current.size !== Number(persisted.size) || current.mtimeMs !== Number(persisted.mtimeMs)
          || (persisted.filePath && !samePath(persisted.filePath, filePath))) throw new Error("SAFE_RECORD_STALE");
        restored.push({ index, filePath, size: current.size, mtimeMs: current.mtimeMs });
      }
      for (const record of restored) this.#scanRecords.set(this.#scanKey(raw.hash_string, record.index), { status: "clean", ...record });
      return true;
    } catch (error) {
      this.#invalidateScanRecords(raw);
      await this.#contentRegistry.invalidate(raw.hash_string);
      await this.#audit.append("torrent.safe_record_invalidated", {
        torrentId: Number(raw.id),
        reason: String(error?.code || error?.message || "SAFE_RECORD_INVALID").slice(0, 80),
      }).catch(() => undefined);
      return false;
    }
  }

  async initializeSecurity() {
    if (!this.#contentRegistry) return { ok: true, restored: 0, pending: 0 };
    await this.#contentRegistry.initialize();
    const response = await this.#manager.rpc.call("torrent_get", { fields: TORRENT_FIELDS });
    const torrents = Array.isArray(response.torrents) ? response.torrents : [];
    let restored = 0;
    let pending = 0;
    for (const raw of torrents) {
      let entry = this.#registryEntry(raw);
      if (!entry?.plan) entry = await this.#upsertDestinationPlan(raw);
      if (entry?.safe && await this.#restoreSafeEntry(raw, entry)) restored += 1;
      else if (Number(raw.percent_done) >= 0.999999) pending += 1;
    }
    await this.#audit.append("security.content_registry_restored", { torrents: torrents.length, restored, pending });
    return { ok: true, restored, pending };
  }

  async initializeSharing() {
    try {
      const stored = JSON.parse(await readFile(this.#globalSharingPath, "utf8"));
      this.#globalSharing = boundedGlobalPolicy(stored);
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      this.#globalSharing = { ...DEFAULT_GLOBAL_SHARING };
    }
    await this.#readSharingQuarantine();
    const current = await this.#readSharingState();
    let quarantineChanged = false;
    if (this.#contentRegistry) {
      for (const torrent of current.torrents) {
        const hash = this.#sharingHash(torrent);
        if (this.#sharingQuarantine.has(hash) && this.#isSafeForSharing(torrent)) {
          this.#sharingQuarantine.delete(hash);
          quarantineChanged = true;
        }
      }
    }
    if (quarantineChanged) await this.#writeSharingQuarantine();
    const storedBaseline = await this.#readSharingBaseline();
    this.#baselineSharingState = storedBaseline
      || this.#persistableSharingBaseline(this.#baselineWithoutTemporaryGuards(current));
    if (!storedBaseline) await this.#writeSharingBaseline(this.#baselineSharingState);
    await this.#serializeSharing(() => this.#applyGlobalSharing({ persist: true, audit: false, userInitiated: false }));
    if (!this.#globalSharing.enabled) await this.#refreshIndividualBaseline();
    return this.globalSharing();
  }

  #serializeSharing(operation) {
    const run = this.#sharingChain.then(operation, operation);
    this.#sharingChain = run.catch(() => undefined);
    return run;
  }

  globalSharing() {
    return { ...this.#globalSharing };
  }

  async #writeGlobalSharing() {
    const temporary = `${this.#globalSharingPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.#globalSharing, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, this.#globalSharingPath);
  }

  #baselineWithoutTemporaryGuards(snapshot, fallbackSnapshot = null) {
    const fallbackByHash = new Map((fallbackSnapshot?.torrents || [])
      .map((torrent) => [this.#sharingHash(torrent), torrent]));
    const torrents = (snapshot?.torrents || []).map((torrent) => {
      const hash = this.#sharingHash(torrent);
      const fallback = fallbackByHash.get(hash);
      const ratioGuarded = Number(torrent.seed_ratio_mode) === 1 && Number(torrent.seed_ratio_limit) === 0;
      const fallbackRatioGuarded = Number(fallback?.seed_ratio_mode) === 1 && Number(fallback?.seed_ratio_limit) === 0;
      const uploadBlocked = Boolean(torrent.upload_limited) && Number(torrent.upload_limit) === 0;
      const fallbackUploadBlocked = Boolean(fallback?.upload_limited) && Number(fallback?.upload_limit) === 0;
      return {
        ...torrent,
        ...(ratioGuarded ? {
          seed_ratio_mode: fallback && !fallbackRatioGuarded ? fallback.seed_ratio_mode : 2,
          seed_ratio_limit: fallback && !fallbackRatioGuarded ? fallback.seed_ratio_limit : 0,
        } : {}),
        ...(uploadBlocked ? {
          upload_limited: fallback && !fallbackUploadBlocked ? fallback.upload_limited : false,
          upload_limit: fallback && !fallbackUploadBlocked ? fallback.upload_limit : 0,
        } : {}),
      };
    });
    return { ...snapshot, torrents };
  }

  #persistableSharingBaseline(snapshot) {
    const sourceSession = snapshot?.session || {};
    const transports = Array.isArray(sourceSession.preferred_transports)
      ? [...new Set(sourceSession.preferred_transports.filter((value) => value === "tcp" || value === "utp"))]
      : ["utp", "tcp"];
    const rawEncryption = sourceSession.encryption === "tolerated" ? "allowed" : sourceSession.encryption;
    const encryption = new Set(["required", "preferred", "allowed"]).has(rawEncryption) ? rawEncryption : "preferred";
    return {
      schemaVersion: 1,
      session: {
        seed_ratio_limited: sourceSession.seed_ratio_limited === true,
        seed_ratio_limit: boundedNumber(sourceSession.seed_ratio_limit, 2, 0.1, 100),
        idle_seeding_limit_enabled: sourceSession.idle_seeding_limit_enabled === true,
        idle_seeding_limit: boundedNumber(sourceSession.idle_seeding_limit, 30, 1, 10_080, true),
        speed_limit_up_enabled: sourceSession.speed_limit_up_enabled === true,
        speed_limit_up: boundedNumber(sourceSession.speed_limit_up, 100, 1, 1_000_000, true),
        port_forwarding_enabled: sourceSession.port_forwarding_enabled === true,
        alt_speed_enabled: sourceSession.alt_speed_enabled === true,
        seed_queue_enabled: sourceSession.seed_queue_enabled !== false,
        preferred_transports: transports.length > 0 ? transports : ["utp", "tcp"],
        encryption,
        lpd_enabled: sourceSession.lpd_enabled === true,
        queue_stalled_enabled: sourceSession.queue_stalled_enabled !== false,
        peer_limit_global: boundedNumber(sourceSession.peer_limit_global, 200, 1, 10_000, true),
        peer_limit_per_torrent: boundedNumber(sourceSession.peer_limit_per_torrent, 50, 1, 2_000, true),
      },
      torrents: (Array.isArray(snapshot?.torrents) ? snapshot.torrents : []).slice(0, MAX_FILES_PER_TORRENT).map((torrent) => ({
        hash_string: this.#sharingHash(torrent),
        status: boundedNumber(torrent.status, 0, 0, 6, true),
        bandwidth_priority: boundedNumber(torrent.bandwidth_priority, 0, -1, 1, true),
        peer_limit: boundedNumber(torrent.peer_limit, 50, 1, 2_000, true),
        honors_session_limits: torrent.honors_session_limits !== false,
        seed_ratio_mode: boundedNumber(torrent.seed_ratio_mode, 2, 0, 2, true),
        seed_ratio_limit: boundedNumber(torrent.seed_ratio_limit, 0, 0, 100),
        seed_idle_mode: boundedNumber(torrent.seed_idle_mode, 2, 0, 2, true),
        seed_idle_limit: boundedNumber(torrent.seed_idle_limit, 0, 0, 10_080, true),
        upload_limited: Boolean(torrent.upload_limited),
        upload_limit: boundedNumber(torrent.upload_limit, 0, 0, 1_000_000, true),
      })).filter((torrent) => isCanonicalInfohash(torrent.hash_string)),
    };
  }

  async #writeSharingBaseline(snapshot) {
    const temporary = `${this.#individualBaselinePath}.${process.pid}.${randomUUID()}.tmp`;
    const baseline = this.#persistableSharingBaseline(
      this.#baselineWithoutTemporaryGuards(snapshot, this.#baselineSharingState),
    );
    await writeFile(temporary, `${JSON.stringify(baseline, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, this.#individualBaselinePath);
  }

  async #readSharingBaseline() {
    try {
      const parsed = JSON.parse(await readFile(this.#individualBaselinePath, "utf8"));
      if (parsed?.schemaVersion !== 1 || !parsed.session || !Array.isArray(parsed.torrents) || parsed.torrents.length > MAX_FILES_PER_TORRENT) return null;
      const baseline = this.#persistableSharingBaseline(parsed);
      if (baseline.torrents.length !== parsed.torrents.length) return null;
      return this.#persistableSharingBaseline(this.#baselineWithoutTemporaryGuards(baseline));
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async #readSharingQuarantine() {
    try {
      const parsed = JSON.parse(await readFile(this.#sharingQuarantinePath, "utf8"));
      if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.entries) || parsed.entries.length > MAX_FILES_PER_TORRENT) {
        throw new Error("Le registre local de quarantaine de partage est invalide.");
      }
      const next = new Map();
      for (const entry of parsed.entries) {
        const hash = canonicalizeInfohash(entry?.hash);
        if (!hash) throw new Error("Le registre local de quarantaine de partage est invalide.");
        next.set(hash, {
          hash,
          blockedAt: typeof entry.blockedAt === "string" && Number.isFinite(Date.parse(entry.blockedAt)) ? entry.blockedAt : new Date(0).toISOString(),
          reason: new Set(["scan-pending", "scan-failed"]).has(entry.reason) ? entry.reason : "scan-failed",
        });
      }
      this.#sharingQuarantine = next;
    } catch (error) {
      if (error?.code === "ENOENT") {
        this.#sharingQuarantine = new Map();
        return;
      }
      throw error;
    }
  }

  async #writeSharingQuarantine() {
    const temporary = `${this.#sharingQuarantinePath}.${process.pid}.${randomUUID()}.tmp`;
    const entries = [...this.#sharingQuarantine.values()].sort((left, right) => left.hash.localeCompare(right.hash));
    await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, this.#sharingQuarantinePath);
  }

  #sharingHash(torrentOrHash) {
    const value = typeof torrentOrHash === "string" ? torrentOrHash : torrentOrHash?.hash_string;
    return canonicalizeInfohash(value) || "";
  }

  #isSharingQuarantined(torrentOrHash) {
    return this.#sharingQuarantine.has(this.#sharingHash(torrentOrHash));
  }

  async #blockSharing(hash, reason) {
    const normalized = this.#sharingHash(hash);
    if (!normalized) throw new Error("Infohash invalide pour la quarantaine de partage.");
    this.#sharingQuarantine.set(normalized, { hash: normalized, blockedAt: new Date().toISOString(), reason: reason === "scan-pending" ? "scan-pending" : "scan-failed" });
    this.#mediaVault.revokeTorrent(normalized);
    await this.#writeSharingQuarantine();
  }

  async #clearSharingBlock(hash) {
    const normalized = this.#sharingHash(hash);
    const previous = this.#sharingQuarantine.get(normalized);
    if (!previous) return;
    this.#sharingQuarantine.delete(normalized);
    try {
      await this.#writeSharingQuarantine();
    } catch (error) {
      this.#sharingQuarantine.set(normalized, previous);
      throw error;
    }
  }

  async #refreshIndividualBaseline() {
    if (this.#globalSharing.enabled) return;
    try {
      const current = await this.#readSharingState();
      this.#baselineSharingState = this.#persistableSharingBaseline(
        this.#baselineWithoutTemporaryGuards(current, this.#baselineSharingState),
      );
      await this.#writeSharingBaseline(this.#baselineSharingState);
    } catch (error) {
      await this.#audit.append("sharing.baseline_persist_failed", { reason: String(error?.code || "BASELINE_WRITE_FAILED").slice(0, 80) }).catch(() => undefined);
    }
  }

  async #captureNewIndividualBaseline() {
    try {
      const state = await this.#readSharingState();
      const baseline = this.#baselineSharingState || { session: state.session, torrents: [] };
      const known = new Set((baseline.torrents || []).map((torrent) => this.#sharingHash(torrent)));
      const additions = state.torrents.filter((torrent) => !known.has(this.#sharingHash(torrent)));
      if (additions.length === 0) return;
      this.#baselineSharingState = this.#persistableSharingBaseline(this.#baselineWithoutTemporaryGuards({
        session: baseline.session,
        torrents: [...baseline.torrents, ...additions],
      }, baseline));
      await this.#writeSharingBaseline(this.#baselineSharingState);
    } catch (error) {
      await this.#audit.append("sharing.baseline_persist_failed", { reason: String(error?.code || "BASELINE_WRITE_FAILED").slice(0, 80) }).catch(() => undefined);
    }
  }

  async #forgetIndividualBaseline(hash) {
    const baseline = this.#baselineSharingState;
    if (!baseline) return;
    const normalized = this.#sharingHash(hash);
    const torrents = baseline.torrents.filter((torrent) => this.#sharingHash(torrent) !== normalized);
    if (torrents.length === baseline.torrents.length) return;
    this.#baselineSharingState = { session: baseline.session, torrents };
    await this.#writeSharingBaseline(this.#baselineSharingState).catch(async (error) => {
      await this.#audit.append("sharing.baseline_persist_failed", { reason: String(error?.code || "BASELINE_WRITE_FAILED").slice(0, 80) }).catch(() => undefined);
    });
  }

  async #readSharingState() {
    const [{ torrents = [] }, session] = await Promise.all([
      this.#manager.rpc.call("torrent_get", {
        fields: [
          "id", "hash_string", "status", "percent_done", "upload_ratio", "activity_date", "trackers", "tracker_stats", "peers_getting_from_us",
          "files", "file_stats",
          "bandwidth_priority", "peer_limit", "honors_session_limits", "seed_ratio_mode", "seed_ratio_limit",
          "seed_idle_mode", "seed_idle_limit", "upload_limited", "upload_limit",
        ],
      }),
      this.#manager.rpc.call("session_get", {
        fields: [
          "seed_ratio_limited", "seed_ratio_limit", "idle_seeding_limit_enabled", "idle_seeding_limit",
          "speed_limit_up_enabled", "speed_limit_up", "port_forwarding_enabled", "alt_speed_enabled",
          "seed_queue_enabled", "preferred_transports", "encryption", "lpd_enabled", "queue_stalled_enabled",
          "peer_limit_global", "peer_limit_per_torrent",
        ],
      }),
    ]);
    return { session, torrents: Array.isArray(torrents) ? torrents : [] };
  }

  #sessionRestorePayload(session, portMapping = session.port_forwarding_enabled) {
    const payload = { port_forwarding_enabled: portMapping === true };
    for (const key of [
      "seed_ratio_limited", "seed_ratio_limit", "idle_seeding_limit_enabled", "idle_seeding_limit",
      "speed_limit_up_enabled", "speed_limit_up", "alt_speed_enabled", "seed_queue_enabled",
      "preferred_transports", "encryption", "lpd_enabled", "queue_stalled_enabled",
      "peer_limit_global", "peer_limit_per_torrent",
    ]) {
      if (session[key] !== undefined) payload[key] = session[key];
    }
    return payload;
  }

  #torrentRestorePayload(torrent) {
    return {
      ids: [Number(torrent.id)],
      bandwidth_priority: Number(torrent.bandwidth_priority ?? 0),
      peer_limit: Number(torrent.peer_limit || 50),
      honors_session_limits: torrent.honors_session_limits !== false,
      seed_ratio_mode: Number(torrent.seed_ratio_mode ?? 2),
      seed_ratio_limit: Number(torrent.seed_ratio_limit || 0),
      seed_idle_mode: Number(torrent.seed_idle_mode ?? 2),
      seed_idle_limit: Number(torrent.seed_idle_limit || 0),
      upload_limited: Boolean(torrent.upload_limited),
      upload_limit: Number(torrent.upload_limit || 0),
    };
  }

  async #restoreSharingState(snapshot) {
    await this.#manager.rpc.call("session_set", this.#sessionRestorePayload(snapshot.session));
    for (const torrent of snapshot.torrents) await this.#manager.rpc.call("torrent_set", this.#torrentRestorePayload(torrent));
    const protectedTorrent = (torrent) => this.#isSharingProtected(torrent);
    const stopped = snapshot.torrents.filter((torrent) => !isRunningStatus(torrent.status) || protectedTorrent(torrent)).map((torrent) => Number(torrent.id));
    const running = snapshot.torrents.filter((torrent) => isRunningStatus(torrent.status) && !protectedTorrent(torrent)).map((torrent) => Number(torrent.id));
    if (stopped.length > 0) await this.#manager.rpc.call("torrent_stop", { ids: stopped });
    if (running.length > 0) await this.#manager.rpc.call("torrent_start", { ids: running });
  }

  async #applyPriorityGroups(torrents, priorityMode) {
    const eligible = torrents.filter((torrent) => !this.#isSharingProtected(torrent));
    const completed = eligible.filter((torrent) => Number(torrent.percent_done) >= 0.999999);
    const activeIncomplete = eligible.filter((torrent) => Number(torrent.percent_done) < 0.999999 && new Set([3, 4]).has(Number(torrent.status)));
    const blockedHigh = torrents.filter((torrent) => this.#isSharingProtected(torrent) && Number(torrent.bandwidth_priority ?? 0) !== 0).map((torrent) => Number(torrent.id));
    const demanded = priorityMode ? completed.filter(trackerHasDemand) : [];
    const high = priorityMode ? [...activeIncomplete, ...(demanded.length > 0 ? demanded : completed)] : [];
    const highIds = new Set(high.map((torrent) => Number(torrent.id)));
    const highChanged = high.filter((torrent) => Number(torrent.bandwidth_priority ?? 0) !== 1).map((torrent) => Number(torrent.id));
    const normalChanged = eligible.filter((torrent) => !highIds.has(Number(torrent.id)) && Number(torrent.bandwidth_priority ?? 0) !== 0).map((torrent) => Number(torrent.id));
    if (highChanged.length > 0) await this.#manager.rpc.call("torrent_set", { ids: highChanged, bandwidth_priority: 1 });
    if (normalChanged.length > 0) await this.#manager.rpc.call("torrent_set", { ids: normalChanged, bandwidth_priority: 0 });
    if (blockedHigh.length > 0) await this.#manager.rpc.call("torrent_set", { ids: blockedHigh, bandwidth_priority: 0 });
    return { highPriorityIds: [...highIds], completedIds: completed.map((torrent) => Number(torrent.id)) };
  }

  async #applyGlobalSharing({ persist, audit, userInitiated }) {
    const policy = this.#globalSharing;
    const before = await this.#readSharingState();
    const completed = before.torrents.filter((torrent) => Number(torrent.percent_done) >= 0.999999 && !this.#scanningIds.has(Number(torrent.id)));
    const shareableCompleted = completed.filter((torrent) => !this.#isSharingProtected(torrent));
    const eligible = before.torrents.filter((torrent) => !this.#isSharingProtected(torrent));
    for (const torrent of eligible) await assertSafeTrackerUrls(trackerUrls(torrent));

    try {
      const protectedRunning = before.torrents.filter((torrent) => isRunningStatus(torrent.status)
        && this.#isSharingProtected(torrent))
        .map((torrent) => Number(torrent.id));
      if (protectedRunning.length > 0) await this.#manager.rpc.call("torrent_stop", { ids: protectedRunning });
      if (policy.enabled) {
        await this.#manager.rpc.call("session_set", {
          seed_ratio_limited: policy.ratioLimit !== null,
          ...(policy.ratioLimit === null ? {} : { seed_ratio_limit: policy.ratioLimit }),
          idle_seeding_limit_enabled: policy.idleMinutes !== null,
          ...(policy.idleMinutes === null ? {} : { idle_seeding_limit: policy.idleMinutes }),
          speed_limit_up_enabled: policy.uploadLimitKbps !== null,
          ...(policy.uploadLimitKbps === null ? {} : { speed_limit_up: policy.uploadLimitKbps }),
          port_forwarding_enabled: policy.portMapping,
          alt_speed_enabled: false,
          seed_queue_enabled: policy.priorityMode ? false : this.#baselineSharingState?.session?.seed_queue_enabled !== false,
          queue_stalled_enabled: policy.priorityMode ? false : this.#baselineSharingState?.session?.queue_stalled_enabled !== false,
          preferred_transports: ["utp", "tcp"],
          encryption: "preferred",
          lpd_enabled: false,
        });
        if (eligible.length > 0) {
          await this.#manager.rpc.call("torrent_set", {
            ids: eligible.map((torrent) => Number(torrent.id)),
            seed_ratio_mode: 0,
            seed_idle_mode: 0,
            upload_limited: false,
            honors_session_limits: true,
          });
        }
        await this.#enforcePreValidationExchangeGuard(before.torrents);
        await this.#applyPriorityGroups(before.torrents, policy.priorityMode);
      } else {
        const baseline = this.#baselineSharingState || before;
        await this.#manager.rpc.call("session_set", this.#sessionRestorePayload(baseline.session, policy.portMapping));
        const baselineByHash = new Map(baseline.torrents.map((torrent) => [this.#sharingHash(torrent), torrent]));
        const resumeIds = [];
        const stopIds = [];
        for (const torrent of before.torrents) {
          const original = baselineByHash.get(this.#sharingHash(torrent));
          await this.#manager.rpc.call("torrent_set", original ? this.#torrentRestorePayload({ ...original, id: torrent.id }) : {
            ids: [Number(torrent.id)], bandwidth_priority: 0, peer_limit: 50, honors_session_limits: true,
            seed_ratio_mode: 2, seed_ratio_limit: 0, seed_idle_mode: 2, seed_idle_limit: 0, upload_limited: false, upload_limit: 0,
          });
          if (original && isRunningStatus(original.status) && !this.#isSharingProtected(torrent)) resumeIds.push(Number(torrent.id));
          else stopIds.push(Number(torrent.id));
        }
        await this.#enforcePreValidationExchangeGuard(before.torrents);
        if (stopIds.length > 0) await this.#manager.rpc.call("torrent_stop", { ids: stopIds });
        if (resumeIds.length > 0) await this.#manager.rpc.call("torrent_start", { ids: resumeIds });
      }

      if (policy.enabled && policy.shareMode === "stop-all" && before.torrents.length > 0) {
        await this.#manager.rpc.call("torrent_stop", { ids: before.torrents.map(({ id }) => Number(id)) });
      } else if (policy.enabled && policy.shareMode === "share-all") {
        const startable = shareableCompleted.filter((torrent) => Number(torrent.status) === 0 && eligibleForAutomaticSeedStart(policy, torrent, { userInitiated }));
        if (startable.length > 0) await this.#manager.rpc.call(policy.priorityMode ? "torrent_start_now" : "torrent_start", { ids: startable.map(({ id }) => Number(id)) });
      }

      if (persist) await this.#writeGlobalSharing();
      this.#manager.notePortMapping?.(policy.portMapping);
      this.#manager.notePriorityMode?.(policy.enabled && policy.priorityMode);
      if (audit) await this.#audit.append("sharing.global_policy_changed", {
        schemaVersion: policy.schemaVersion,
        enabled: policy.enabled,
        shareMode: policy.shareMode,
        ratioLimit: policy.ratioLimit,
        idleMinutes: policy.idleMinutes,
        uploadLimitKbps: policy.uploadLimitKbps,
        portMapping: policy.portMapping,
        priorityMode: policy.priorityMode,
      });
    } catch (error) {
      try {
        await this.#restoreSharingState(before);
        await this.#enforcePreValidationExchangeGuard(before.torrents);
      } catch (rollbackError) {
        await this.#audit.append("sharing.rollback_failed", { reason: String(rollbackError?.code || "ROLLBACK_FAILED") });
      }
      throw error;
    }
  }

  async setGlobalSharing(input) {
    const next = boundedGlobalPolicy(input);
    return this.#serializeSharing(async () => {
      const previous = this.#globalSharing;
      if (!previous.enabled && next.enabled) {
        const current = await this.#readSharingState();
        this.#baselineSharingState = this.#persistableSharingBaseline(
          this.#baselineWithoutTemporaryGuards(current, this.#baselineSharingState),
        );
        await this.#writeSharingBaseline(this.#baselineSharingState);
      }
      this.#globalSharing = next;
      try {
        await this.#applyGlobalSharing({ persist: true, audit: true, userInitiated: true });
        const expectedSlots = next.enabled && next.priorityMode ? 4 : 8;
        const managerStatus = this.#manager.status?.() || {};
        const currentSlots = Number(managerStatus.uploadSlotsPerTorrent || expectedSlots);
        return {
          ok: true,
          policy: this.globalSharing(),
          restartRequired: currentSlots !== expectedSlots,
          effective: {
            bandwidthPriority: next.enabled && next.priorityMode ? 1 : 0,
            uploadSlotsPerTorrent: currentSlots,
            targetUploadSlotsPerTorrent: expectedSlots,
            seedQueueEnabled: next.enabled && next.priorityMode ? false : this.#baselineSharingState?.session?.seed_queue_enabled !== false,
          },
        };
      } catch (error) {
        this.#globalSharing = previous;
        this.#manager.notePortMapping?.(previous.portMapping);
        this.#manager.notePriorityMode?.(previous.enabled && previous.priorityMode);
        await this.#writeGlobalSharing().catch(() => undefined);
        throw error;
      }
    });
  }

  async maintainSharing() {
    return this.#serializeSharing(async () => {
      const policy = this.#globalSharing;
      const state = await this.#readSharingState();
      const protectedRunning = state.torrents.filter((torrent) => isRunningStatus(torrent.status)
        && this.#isSharingProtected(torrent))
        .map((torrent) => Number(torrent.id));
      if (protectedRunning.length > 0) await this.#manager.rpc.call("torrent_stop", { ids: protectedRunning });
      const { guardedIds, releasedUploadIds } = await this.#enforcePreValidationExchangeGuard(state.torrents);
      if (!policy.enabled || policy.shareMode !== "share-all") {
        return {
          ok: true,
          changed: protectedRunning.length > 0 || releasedUploadIds.length > 0,
          stoppedProtectedIds: protectedRunning,
          guardedIds,
          releasedUploadIds,
        };
      }
      const stoppedComplete = state.torrents.filter((torrent) => Number(torrent.percent_done) >= 0.999999
        && Number(torrent.status) === 0
        && !this.#isSharingProtected(torrent)
        && eligibleForAutomaticSeedStart(policy, torrent));
      for (const torrent of stoppedComplete) await assertSafeTrackerUrls(trackerUrls(torrent));
      const priorities = await this.#applyPriorityGroups(state.torrents, policy.priorityMode);
      if (stoppedComplete.length > 0) {
        await this.#manager.rpc.call(policy.priorityMode ? "torrent_start_now" : "torrent_start", { ids: stoppedComplete.map((torrent) => Number(torrent.id)) });
      }
      return {
        ok: true,
        changed: stoppedComplete.length > 0 || protectedRunning.length > 0 || releasedUploadIds.length > 0,
        restartedIds: stoppedComplete.map((torrent) => Number(torrent.id)),
        stoppedProtectedIds: protectedRunning,
        guardedIds,
        releasedUploadIds,
        ...priorities,
      };
    });
  }

  async maintainValidation() {
    if (!this.#contentRegistry) return { ok: true, checked: false };
    const response = await this.#manager.rpc.call("torrent_get", { fields: TORRENT_FIELDS });
    const torrents = Array.isArray(response.torrents) ? response.torrents : [];
    const unsafeCompleted = torrents.filter((torrent) => Number(torrent.percent_done) >= 0.999999 && !this.#isSafeForSharing(torrent));
    const runningIds = unsafeCompleted.filter((torrent) => isRunningStatus(torrent.status)).map((torrent) => Number(torrent.id));
    if (runningIds.length > 0) await this.#manager.rpc.call("torrent_stop", { ids: runningIds });
    const candidate = unsafeCompleted.find((torrent) => {
      if (this.#scanningIds.has(Number(torrent.id))) return false;
      return this.#sharingQuarantine.get(this.#sharingHash(torrent))?.reason !== "scan-failed";
    });
    if (!candidate) return { ok: true, checked: false, stoppedIds: runningIds };
    if (!this.#registryEntry(candidate)?.plan) await this.#upsertDestinationPlan(candidate);
    const result = await this.verifyAndScan(Number(candidate.id));
    return { ok: true, checked: true, torrentId: Number(candidate.id), stoppedIds: runningIds, result };
  }

  async sharingDiagnostics() {
    const fields = [
      "id", "hash_string", "name", "status", "percent_done", "rate_upload", "uploaded_ever", "downloaded_ever", "upload_ratio",
      "seconds_seeding", "peers_connected", "peers_getting_from_us", "peers_sending_to_us", "is_private", "tracker_stats",
      "bandwidth_priority", "peer_limit", "honors_session_limits", "is_stalled", "queue_position", "peers", "files", "file_stats",
    ];
    let portError = null;
    const [{ torrents = [] }, session, sessionStats, port] = await Promise.all([
      this.#manager.rpc.call("torrent_get", { fields }),
      this.#manager.rpc.call("session_get", { fields: [
        "peer_port", "port_forwarding_enabled", "encryption", "preferred_transports", "seed_queue_enabled",
        "speed_limit_up_enabled", "speed_limit_up", "peer_limit_global", "peer_limit_per_torrent",
      ] }),
      this.#manager.rpc.call("session_stats").catch(() => ({})),
      this.#manager.rpc.call("port_test", { ip_protocol: "ipv4" }).catch((error) => {
        portError = String(error?.code || "PORT_TEST_FAILED").slice(0, 80);
        return { port_is_open: null, ip_protocol: "ipv4" };
      }),
    ]);
    const normalizedTorrents = torrents.map((torrent) => ({
      id: Number(torrent.id), name: safeName(torrent.name), status: STATUS_NAMES.get(Number(torrent.status)) || "unknown",
      percentDone: Number(torrent.percent_done || 0), rateUpload: Number(torrent.rate_upload || 0), uploadedEver: Number(torrent.uploaded_ever || 0),
      downloadedEver: Number(torrent.downloaded_ever || 0), uploadRatio: Number(torrent.upload_ratio || 0), secondsSeeding: Number(torrent.seconds_seeding || 0),
      peersConnected: Number(torrent.peers_connected || 0), peersGettingFromUs: Number(torrent.peers_getting_from_us || 0), peersSendingToUs: Number(torrent.peers_sending_to_us || 0),
      isPrivate: Boolean(torrent.is_private), bandwidthPriority: Number(torrent.bandwidth_priority ?? 0), peerLimit: Number(torrent.peer_limit || 0),
      honorsSessionLimits: torrent.honors_session_limits !== false, isStalled: Boolean(torrent.is_stalled), queuePosition: Number(torrent.queue_position || 0),
      sharingBlocked: this.#isSharingProtected(torrent),
      peerFlow: summarizePeerFlow(torrent.peers),
      trackers: (torrent.tracker_stats || []).map((tracker) => ({
        host: trackerHost(tracker.announce), announceState: Number(tracker.announce_state || 0), hasAnnounced: Boolean(tracker.has_announced),
        lastAnnounceSucceeded: Boolean(tracker.last_announce_succeeded), lastAnnounceTimedOut: Boolean(tracker.last_announce_timed_out),
        lastAnnounceResult: trackerResult(tracker.last_announce_result), lastAnnounceTime: Number(tracker.last_announce_time || 0), nextAnnounceTime: Number(tracker.next_announce_time || 0),
        seeders: Number(tracker.seeder_count ?? -1), leechers: Number(tracker.leecher_count ?? -1), downloads: Number(tracker.download_count ?? -1),
        downloaders: Number(tracker.downloader_count ?? -1), lastAnnouncePeerCount: Number(tracker.last_announce_peer_count ?? -1),
      })),
    }));
    const completed = normalizedTorrents.filter((torrent) => torrent.percentDone >= 0.999999);
    const trackers = completed.flatMap((torrent) => torrent.trackers);
    const hasSuccessfulTracker = trackers.some((tracker) => tracker.lastAnnounceSucceeded);
    const hasTrackerFailure = trackers.some((tracker) => tracker.hasAnnounced && !tracker.lastAnnounceSucceeded);
    const hasDemand = trackers.some((tracker) => tracker.lastAnnounceSucceeded && tracker.leechers > 0);
    const isUploading = completed.some((torrent) => torrent.rateUpload > 0 || torrent.peersGettingFromUs > 0);
    const hasConnectedPeers = completed.some((torrent) => torrent.peersConnected > 0);
    const sampledPeers = completed.reduce((total, torrent) => total + torrent.peerFlow.connected, 0);
    const completePeers = completed.reduce((total, torrent) => total + torrent.peerFlow.complete, 0);
    const incompletePeers = completed.reduce((total, torrent) => total + torrent.peerFlow.incomplete, 0);
    const interestedPeers = completed.reduce((total, torrent) => total + torrent.peerFlow.interested, 0);
    const unchokedInterestedPeers = completed.reduce((total, torrent) => total + torrent.peerFlow.unchokedInterested, 0);
    const locallyChokedPeers = Math.max(0, interestedPeers - unchokedInterestedPeers);
    const hasSecurityBlock = completed.some((torrent) => torrent.sharingBlocked);
    const reachable = typeof port.port_is_open === "boolean" ? port.port_is_open : null;
    let verdict = "ready-awaiting-peers";
    if (this.#globalSharing.enabled && this.#globalSharing.shareMode === "stop-all") verdict = "policy-stopped";
    else if (isUploading) verdict = "healthy";
    else if (completed.length === 0) verdict = "degraded";
    else if (hasSecurityBlock) verdict = "security-blocked";
    else if (!hasSuccessfulTracker && hasTrackerFailure) verdict = "tracker-error";
    else if (reachable === false) verdict = "closed";
    else if (sampledPeers > 0 && incompletePeers === 0) verdict = "seed-peers-only";
    else if (sampledPeers > 0 && interestedPeers === 0) verdict = "peers-not-interested";
    else if (sampledPeers > 0 && interestedPeers > 0 && unchokedInterestedPeers === 0) verdict = "locally-choked";
    else if (sampledPeers > 0 && unchokedInterestedPeers > 0) verdict = "awaiting-requests";
    else if (hasConnectedPeers) verdict = "peers-choked";
    else if (reachable === null) verdict = "degraded";
    else if (!hasDemand) verdict = "reachable-no-demand";
    const managerStatus = this.#manager.status?.() || {};
    return {
      capturedAt: new Date().toISOString(),
      policy: this.globalSharing(),
      verdict,
      port: { peerPort: Number(session.peer_port || 0), reachable, mappingEnabled: Boolean(session.port_forwarding_enabled), protocol: port.ip_protocol || "ipv4", error: portError },
      totals: {
        rateUpload: Number(sessionStats.upload_speed || normalizedTorrents.reduce((total, torrent) => total + torrent.rateUpload, 0)),
        uploadedBytes: Number(sessionStats.cumulative_stats?.uploaded_bytes || normalizedTorrents.reduce((total, torrent) => total + torrent.uploadedEver, 0)),
        activeTorrents: Number(sessionStats.active_torrent_count || 0),
      },
      performance: {
        priorityMode: this.#globalSharing.enabled && this.#globalSharing.priorityMode,
        bandwidthPriority: this.#globalSharing.enabled && this.#globalSharing.priorityMode ? 1 : 0,
        uploadSlotsPerTorrent: Number(managerStatus.uploadSlotsPerTorrent || 0),
        seedQueueEnabled: Boolean(session.seed_queue_enabled),
        highPriorityTorrents: completed.filter((torrent) => torrent.bandwidthPriority === 1).length,
        activeSeedTorrents: completed.filter((torrent) => torrent.status === "seeding" || torrent.status === "queued-seed").length,
        connectedPeers: completed.reduce((total, torrent) => total + torrent.peersConnected, 0),
        activeUploadPeers: completed.reduce((total, torrent) => total + torrent.peersGettingFromUs, 0),
        completePeers,
        incompletePeers,
        interestedPeers,
        locallyChokedPeers,
        unchokedInterestedPeers,
        uploadRate: completed.reduce((total, torrent) => total + torrent.rateUpload, 0),
        uploadedEver: normalizedTorrents.reduce((total, torrent) => total + torrent.uploadedEver, 0),
        peerLimitGlobal: Number(session.peer_limit_global || 0),
        peerLimitPerTorrent: Number(session.peer_limit_per_torrent || 0),
        uploadLimitKbps: session.speed_limit_up_enabled ? Number(session.speed_limit_up || 0) : null,
        encryption: String(session.encryption || "unknown"),
        transports: Array.isArray(session.preferred_transports) ? session.preferred_transports.map(String) : [],
      },
      torrents: normalizedTorrents,
    };
  }

  inspectMagnet(magnet) {
    return inspectMagnet(magnet);
  }

  #scanKey(hash, index) {
    return `${hash}:${index}`;
  }

  #invalidateScanRecords(raw) {
    for (let index = 0; index < (raw.files?.length || 0); index += 1) this.#scanRecords.delete(this.#scanKey(raw.hash_string, index));
    this.#mediaVault.revokeTorrent(raw.hash_string);
  }

  async #allowedDownloadRoot(downloadDirectory) {
    return realpath(await this.#manager.resolveAllowedDownloadRoot(downloadDirectory));
  }

  #newTorrentDownloadDirectory() {
    return this.#manager.paths.data;
  }

  #normalized(torrent, peers = []) {
    const fileStats = Array.isArray(torrent.file_stats) ? torrent.file_stats : [];
    const files = (Array.isArray(torrent.files) ? torrent.files : []).map((file, index) => {
      const fileStat = fileStats[index] || {};
      const record = this.#scanRecords.get(this.#scanKey(torrent.hash_string, index));
      const bytesCompleted = Number(file.bytes_completed || 0);
      const length = Number(file.length || 0);
      const scanStatus = record?.status === "clean" && (record.size !== length || bytesCompleted !== length) ? "stale" : record?.status || "not-scanned";
      return {
        index,
        name: safeName(file.name, `Fichier ${index + 1}`),
        length,
        bytesCompleted,
        wanted: fileStat.wanted !== false,
        media: isMediaName(file.name || ""),
        scanStatus,
      };
    });
    return {
      id: Number(torrent.id),
      hash: String(torrent.hash_string || ""),
      name: safeName(torrent.name),
      addedAt: boundedNumber(torrent.added_date, 0, 0, Date.now() / 1000 + 86400, true) * 1000,
      status: STATUS_NAMES.get(Number(torrent.status)) || "unknown",
      percentDone: Number(torrent.percent_done || 0),
      metadataPercentComplete: Number(torrent.metadata_percent_complete || 0),
      rateDownload: Number(torrent.rate_download || 0),
      rateUpload: Number(torrent.rate_upload || 0),
      eta: Number(torrent.eta ?? -1),
      uploadRatio: Number(torrent.upload_ratio || 0),
      uploadedEver: Number(torrent.uploaded_ever || 0),
      downloadedEver: Number(torrent.downloaded_ever || 0),
      secondsSeeding: Number(torrent.seconds_seeding || 0),
      sizeWhenDone: Number(torrent.size_when_done || 0),
      peersConnected: Number(torrent.peers_connected || 0),
      peersGettingFromUs: Number(torrent.peers_getting_from_us || 0),
      peersSendingToUs: Number(torrent.peers_sending_to_us || 0),
      errorString: safeName(torrent.error_string || "", ""),
      isPrivate: Boolean(torrent.is_private),
      uploadLimited: Boolean(torrent.upload_limited),
      uploadLimitKbps: Number(torrent.upload_limit || 0),
      seedRatioMode: Number(torrent.seed_ratio_mode ?? 2),
      seedRatioLimit: Number(torrent.seed_ratio_limit || 0),
      seedIdleMode: Number(torrent.seed_idle_mode ?? 2),
      seedIdleLimit: Number(torrent.seed_idle_limit || 0),
      bandwidthPriority: Number(torrent.bandwidth_priority ?? 0),
      peerLimit: Number(torrent.peer_limit || 0),
      honorsSessionLimits: torrent.honors_session_limits !== false,
      isStalled: Boolean(torrent.is_stalled),
      queuePosition: Number(torrent.queue_position || 0),
      sharingBlocked: this.#isSharingProtected(torrent),
      globalOverrideApplied: this.#globalSharing.enabled,
      trackerSummary: (torrent.tracker_stats || []).map((tracker) => ({
        host: trackerHost(tracker.announce),
        lastAnnounceSucceeded: Boolean(tracker.last_announce_succeeded),
        lastAnnounceResult: trackerResult(tracker.last_announce_result),
        seeders: Number(tracker.seeder_count ?? -1),
        leechers: Number(tracker.leecher_count ?? -1),
      })),
      peers,
      files,
    };
  }

  async #rawTorrent(id) {
    assertTorrentId(id);
    const response = await this.#manager.rpc.call("torrent_get", { ids: [id], fields: TORRENT_FIELDS });
    const torrent = response.torrents?.[0];
    if (!torrent) throw new Error("Torrent introuvable.");
    return torrent;
  }

  async list() {
    const response = await this.#manager.rpc.call("torrent_get", { fields: TORRENT_FIELDS });
    const torrents = Array.isArray(response.torrents) ? response.torrents : [];
    const telemetry = this.#peerTelemetry.normalizeTorrents(torrents);
    return torrents.map((torrent) => this.#normalized(torrent, telemetry.peersByTorrentId.get(Number(torrent.id)) || []));
  }

  async peerSnapshot() {
    const response = await this.#manager.rpc.call("torrent_get", { fields: PEER_SNAPSHOT_FIELDS });
    return this.#peerTelemetry.snapshot(response.torrents);
  }

  async locateSelf() {
    return this.#selfLocator();
  }

  async resolveTorrentDownloadDirectory(id) {
    const raw = await this.#rawTorrent(assertTorrentId(id));
    const allowedRoot = await this.#allowedDownloadRoot(raw.download_dir);
    const directory = await realpath(raw.download_dir);
    if (!containsPath(allowedRoot, directory)) throw new Error("Le répertoire du torrent n'est plus autorisé.");
    return directory;
  }

  async addMagnet({ magnet, rightsConfirmed, startPaused, destination = null }) {
    if (rightsConfirmed !== true) throw new Error("Vous devez confirmer vos droits de téléchargement et de partage.");
    if (startPaused !== true) throw new Error("Par sécurité, tout magnet doit être ajouté en pause.");
    const inspection = await assertSafeMagnetNetworkTargets(magnet);
    const response = await this.#manager.rpc.call("torrent_add", {
      filename: magnet,
      paused: true,
      download_dir: this.#newTorrentDownloadDirectory(),
    });
    const added = response.torrent_added || response.torrent_duplicate;
    if (!added?.id && added?.id !== 0) throw new Error("Transmission n'a pas confirmé l'ajout.");
    try {
      const raw = await this.#rawTorrent(Number(added.id));
      const previous = this.#registryEntry(raw);
      const entry = await this.#upsertDestinationPlan(raw, destination);
      if (previous?.safe && !entry?.safe) {
        this.#invalidateScanRecords(raw);
        await this.#manager.rpc.call("torrent_stop", { ids: [Number(added.id)] });
        await this.#blockSharing(raw.hash_string, "scan-pending");
      }
      await this.#audit.append("torrent.added", {
        torrentId: added.id, source: "magnet", duplicate: Boolean(response.torrent_duplicate), verdict: inspection.verdict,
        rightsConfirmed: true, destinationConfigured: Boolean(entry?.plan), createSubfolder: entry?.plan?.createSubfolder ?? null,
      });
      if (this.#globalSharing.enabled) await this.#captureNewIndividualBaseline();
      else await this.#refreshIndividualBaseline();
      await this.#enforcePreValidationExchangeGuard([raw]);
      return { ok: true, torrent: this.#normalized(await this.#rawTorrent(Number(added.id))) };
    } catch (error) {
      if (!response.torrent_duplicate) await this.#manager.rpc.call("torrent_remove", { ids: [Number(added.id)], delete_local_data: false }).catch(() => undefined);
      throw error;
    }
  }

  async importTorrentFile(filePath, { rightsConfirmed, startPaused, destination = null }) {
    if (rightsConfirmed !== true) throw new Error("Vous devez confirmer vos droits de téléchargement et de partage.");
    if (startPaused !== true) throw new Error("Par sécurité, tout torrent doit être importé en pause.");
    const linkInfo = await lstat(filePath);
    if (!linkInfo.isFile() || linkInfo.isSymbolicLink() || linkInfo.size <= 0 || linkInfo.size > MAX_TORRENT_FILE_SIZE || path.extname(filePath).toLowerCase() !== ".torrent") {
      throw new Error("Le fichier .torrent sélectionné est invalide ou trop volumineux.");
    }
    const bytes = await readFile(filePath);
    if (bytes[0] !== 0x64 || bytes[bytes.length - 1] !== 0x65) throw new Error("Le fichier ne ressemble pas à un dictionnaire bencode.");
    const response = await this.#manager.rpc.call("torrent_add", {
      metainfo: bytes.toString("base64"),
      paused: true,
      download_dir: this.#newTorrentDownloadDirectory(),
    });
    const added = response.torrent_added || response.torrent_duplicate;
    if (!added?.id && added?.id !== 0) throw new Error("Transmission n'a pas confirmé l'import.");
    try {
      const raw = await this.#rawTorrent(Number(added.id));
      await assertSafeTrackerUrls(trackerUrls(raw));
      const previous = this.#registryEntry(raw);
      const entry = await this.#upsertDestinationPlan(raw, destination);
      if (previous?.safe && !entry?.safe) {
        this.#invalidateScanRecords(raw);
        await this.#manager.rpc.call("torrent_stop", { ids: [Number(added.id)] });
        await this.#blockSharing(raw.hash_string, "scan-pending");
      }
      await this.#audit.append("torrent.added", {
        torrentId: added.id, source: "torrent-file", duplicate: Boolean(response.torrent_duplicate), rightsConfirmed: true,
        destinationConfigured: Boolean(entry?.plan), createSubfolder: entry?.plan?.createSubfolder ?? null,
      });
      if (this.#globalSharing.enabled) await this.#captureNewIndividualBaseline();
      else await this.#refreshIndividualBaseline();
      await this.#enforcePreValidationExchangeGuard([raw]);
      return { ok: true, torrent: this.#normalized(await this.#rawTorrent(Number(added.id))) };
    } catch (error) {
      if (!response.torrent_duplicate) await this.#manager.rpc.call("torrent_remove", { ids: [Number(added.id)], delete_local_data: false }).catch(() => undefined);
      throw error;
    }
  }

  async start(id) {
    if (this.#scanningIds.has(Number(id))) throw new Error("Un contrôle de sécurité est déjà en cours pour ce torrent.");
    if (this.#globalSharing.enabled && this.#globalSharing.shareMode === "stop-all") throw new Error("Le mode global « Tout arrêter » bloque les démarrages individuels.");
    const raw = await this.#rawTorrent(assertTorrentId(id));
    if (this.#isSharingQuarantined(raw)) throw new Error("Le partage reste bloqué jusqu'à une analyse antivirus propre.");
    if (Number(raw.percent_done) >= 0.999999 && !this.#isSafeForSharing(raw)) {
      throw new Error("Vérifiez et analysez ce torrent avant de commencer le partage.");
    }
    await assertSafeTrackerUrls(trackerUrls(raw));
    const globalManaged = this.#globalSharing.enabled;
    const globalSeed = globalManaged && Number(raw.percent_done) >= 0.999999;
    if (globalSeed && ratioLimitReached(this.#globalSharing, raw)) throw new Error("Le ratio global est déjà atteint. Modifiez la limite avant de relancer ce partage.");
    const priorityTorrent = globalManaged && this.#globalSharing.priorityMode;
    if (globalManaged) {
      await this.#manager.rpc.call("torrent_set", {
        ids: [id], bandwidth_priority: priorityTorrent ? 1 : 0, upload_limited: false,
        honors_session_limits: true, seed_ratio_mode: 0, seed_idle_mode: 0,
      });
    }
    await this.#enforcePreValidationExchangeGuard([raw]);
    await this.#manager.rpc.call(priorityTorrent ? "torrent_start_now" : "torrent_start", { ids: [id] });
    await this.#audit.append("torrent.started", { torrentId: id, priorityTorrent, prioritySeed: priorityTorrent && Number(raw.percent_done) >= 0.999999 });
    await this.#refreshIndividualBaseline();
    return { ok: true, torrent: this.#normalized(await this.#rawTorrent(id)) };
  }

  async stop(id) {
    if (this.#scanningIds.has(Number(id))) throw new Error("Le contrôle de sécurité doit se terminer avant cette action.");
    if (this.#globalSharing.enabled && this.#globalSharing.shareMode === "share-all") throw new Error("Le mode global « Partager tout » maintient les seeds actifs. Utilisez « Tout arrêter » ou désactivez les paramètres globaux.");
    assertTorrentId(id);
    await this.#manager.rpc.call("torrent_stop", { ids: [id] });
    await this.#audit.append("torrent.stopped", { torrentId: id });
    await this.#refreshIndividualBaseline();
    return { ok: true, torrent: this.#normalized(await this.#rawTorrent(id)) };
  }

  async #waitUntilStopped(id) {
    const deadline = Date.now() + 10_000;
    let raw = await this.#rawTorrent(id);
    while (Date.now() < deadline) {
      if (Number(raw.status) === 0 && Number(raw.rate_download) === 0 && Number(raw.rate_upload) === 0) return raw;
      await new Promise((resolve) => setTimeout(resolve, this.#verificationPollMs));
      raw = await this.#rawTorrent(id);
    }
    throw Object.assign(new Error("Le torrent ne s'est pas arrêté avant le contrôle."), { code: "STOP_TIMEOUT" });
  }

  async #waitForVerification(id) {
    const deadline = Date.now() + this.#verificationTimeoutMs;
    let observedVerification = false;
    let stoppedSamples = 0;
    let raw = await this.#rawTorrent(id);
    while (Date.now() < deadline) {
      const status = Number(raw.status);
      if (status === 1 || status === 2) {
        observedVerification = true;
        stoppedSamples = 0;
      } else if (observedVerification) {
        return raw;
      } else if (status === 0) {
        stoppedSamples += 1;
        if (stoppedSamples >= 3) return raw;
      } else {
        throw Object.assign(new Error("Le torrent a redémarré pendant sa vérification."), { code: "VERIFY_INTERRUPTED" });
      }
      await new Promise((resolve) => setTimeout(resolve, this.#verificationPollMs));
      raw = await this.#rawTorrent(id);
    }
    throw Object.assign(new Error("La vérification des pièces a dépassé le délai de sécurité."), { code: "VERIFY_TIMEOUT" });
  }

  async #prepareFinalDirectory(raw, plan) {
    const libraryRoot = await this.#canonicalLibraryRoot(plan.libraryRoot);
    if (plan.createSubfolder !== true) return libraryRoot;
    const baseName = safeFolderName(raw.name);
    for (let suffix = 1; suffix <= 1_000; suffix += 1) {
      const candidate = path.join(libraryRoot, suffix === 1 ? baseName : `${baseName} (${suffix})`);
      if (!containsPath(libraryRoot, candidate)) throw new Error("Le sous-dossier calculé sort de la bibliothèque.");
      if (samePath(raw.download_dir, candidate)) return realpath(candidate);
      try {
        await mkdir(candidate, { recursive: false });
        return realpath(candidate);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    throw Object.assign(new Error("Impossible de créer un sous-dossier libre dans la bibliothèque."), { code: "DESTINATION_EXHAUSTED" });
  }

  async #waitForLocation(id, destination) {
    const deadline = Date.now() + this.#moveTimeoutMs;
    let raw = await this.#rawTorrent(id);
    while (Date.now() < deadline) {
      if (samePath(raw.download_dir, destination)) {
        const wantedFiles = (raw.files || [])
          .map((file, index) => ({ file, index, wanted: raw.file_stats?.[index]?.wanted !== false }))
          .filter(({ wanted }) => wanted);
        try {
          const allowedRoot = await this.#allowedDownloadRoot(raw.download_dir);
          for (const { file } of wantedFiles) await resolveSafeTorrentFile(allowedRoot, raw.download_dir, file.name);
          return raw;
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, this.#verificationPollMs));
      raw = await this.#rawTorrent(id);
    }
    throw Object.assign(new Error("Le déplacement vers la bibliothèque a dépassé le délai de sécurité."), { code: "MOVE_TIMEOUT" });
  }

  async #moveToLibrary(raw, plan) {
    const destination = await this.#prepareFinalDirectory(raw, plan);
    if (!samePath(raw.download_dir, destination)) {
      await this.#manager.rpc.call("torrent_set_location", { ids: [Number(raw.id)], location: destination, move: true });
      await this.#audit.append("torrent.library_move_started", { torrentId: Number(raw.id), createSubfolder: plan.createSubfolder === true });
    }
    const moved = await this.#waitForLocation(Number(raw.id), destination);
    await this.#audit.append("torrent.library_move_complete", { torrentId: Number(raw.id) });
    return moved;
  }

  async #safeFileSnapshot(raw) {
    const allowedRoot = await this.#allowedDownloadRoot(raw.download_dir);
    const files = [];
    for (let index = 0; index < (raw.files?.length || 0); index += 1) {
      if (raw.file_stats?.[index]?.wanted === false) continue;
      const file = raw.files[index];
      const filePath = await resolveSafeTorrentFile(allowedRoot, raw.download_dir, file.name);
      const current = await stat(filePath);
      if (current.size !== Number(file.length) || Number(file.bytes_completed) !== Number(file.length)) {
        throw new Error("Un fichier a changé pendant son déplacement vers la bibliothèque.");
      }
      files.push({ index, name: file.name, size: current.size, mtimeMs: current.mtimeMs, filePath });
    }
    return files;
  }

  async #resumeValidatedTorrent(raw) {
    const policyAllowsResume = !this.#globalSharing.enabled || this.#globalSharing.shareMode !== "stop-all";
    const shouldResume = policyAllowsResume && !ratioLimitReached(this.#globalSharing, raw);
    if (!shouldResume) return false;
    await assertSafeTrackerUrls(trackerUrls(raw));
    if (this.#globalSharing.enabled) {
      await this.#manager.rpc.call("torrent_set", {
        ids: [Number(raw.id)], bandwidth_priority: this.#globalSharing.priorityMode ? 1 : 0, upload_limited: false,
        honors_session_limits: true, seed_ratio_mode: 0, seed_idle_mode: 0,
      });
    } else {
      const individual = this.#baselineSharingState?.torrents?.find((torrent) => this.#sharingHash(torrent) === this.#sharingHash(raw));
      if (individual) {
        await this.#manager.rpc.call("torrent_set", this.#torrentRestorePayload({ ...individual, id: Number(raw.id) }));
      } else {
        await this.#manager.rpc.call("torrent_set", {
          ids: [Number(raw.id)],
          seed_ratio_mode: 2,
          seed_ratio_limit: 0,
          ...(Boolean(raw.upload_limited) && Number(raw.upload_limit) === 0 ? { upload_limited: false } : {}),
        });
      }
    }
    await this.#manager.rpc.call(this.#globalSharing.enabled && this.#globalSharing.priorityMode ? "torrent_start_now" : "torrent_start", { ids: [Number(raw.id)] });
    await this.#audit.append("torrent.validation_resumed", { torrentId: Number(raw.id), prioritySeed: this.#globalSharing.enabled && this.#globalSharing.priorityMode });
    return true;
  }

  async verifyAndScan(id) {
    assertTorrentId(id);
    if (this.#scanningIds.has(id)) throw Object.assign(new Error("Un contrôle est déjà en cours pour ce torrent."), { code: "VALIDATION_BUSY" });
    this.#scanningIds.add(id);
    let raw = null;
    let wasRunning = false;
    let validationStarted = false;
    let repairRequired = false;
    try {
      raw = await this.#rawTorrent(id);
      if (Number(raw.percent_done) < 0.999999) throw new Error("Le torrent doit être entièrement téléchargé avant le contrôle.");
      if ((raw.files?.length || 0) > MAX_FILES_PER_TORRENT) throw new Error("Le torrent contient trop de fichiers pour un contrôle sûr.");
      wasRunning = isRunningStatus(raw.status);
      validationStarted = true;
      if (this.#contentRegistry) {
        if (!this.#registryEntry(raw)?.plan) await this.#upsertDestinationPlan(raw);
        await this.#contentRegistry.invalidate(raw.hash_string);
      }
      this.#invalidateScanRecords(raw);
      await this.#blockSharing(raw.hash_string, "scan-pending");
      await this.#manager.rpc.call("torrent_stop", { ids: [id] });
      raw = await this.#waitUntilStopped(id);
      await this.#manager.rpc.call("torrent_verify", { ids: [id] });
      await this.#audit.append("torrent.verification_started", { torrentId: id, wasRunning });
      raw = await this.#waitForVerification(id);
      const wantedFiles = (raw.files || []).map((file, index) => ({ file, wanted: raw.file_stats?.[index]?.wanted !== false })).filter(({ wanted }) => wanted);
      const complete = Number(raw.percent_done) >= 0.999999
        && wantedFiles.every(({ file }) => Number(file.bytes_completed) === Number(file.length));
      if (!complete) {
        repairRequired = true;
        await this.#clearSharingBlock(raw.hash_string);
        await this.#audit.append("torrent.verification_incomplete", { torrentId: id });
        throw Object.assign(new Error("Des pièces sont manquantes. Relancez le téléchargement, puis recommencez le contrôle."), { code: "VERIFY_INCOMPLETE" });
      }
      await this.#audit.append("torrent.verification_clean", { torrentId: id, files: wantedFiles.length });
      const scanResult = await this.scan(id, {
        validationOwned: true, wasRunning, sharingAlreadyBlocked: true, deferFinalization: Boolean(this.#contentRegistry),
      });
      if (!this.#contentRegistry) return scanResult;
      const plan = this.#registryEntry(raw)?.plan;
      if (!plan) throw new Error("La destination de bibliothèque est absente.");
      raw = await this.#moveToLibrary(await this.#rawTorrent(id), plan);
      const safeFiles = await this.#safeFileSnapshot(raw);
      await this.#contentRegistry.markSafe({ hash: raw.hash_string, finalDirectory: raw.download_dir, files: safeFiles });
      this.#invalidateScanRecords(raw);
      for (const file of safeFiles) {
        this.#scanRecords.set(this.#scanKey(raw.hash_string, file.index), {
          status: "clean", filePath: file.filePath, size: file.size, mtimeMs: file.mtimeMs,
        });
      }
      await this.#audit.append("torrent.safe_persisted", { torrentId: id, files: safeFiles.length });
      await this.#clearSharingBlock(raw.hash_string);
      const resumed = await this.#resumeValidatedTorrent(raw);
      return {
        ...scanResult,
        resumed,
        moved: true,
        torrent: this.#normalized(await this.#rawTorrent(id)),
      };
    } catch (error) {
      if (validationStarted) {
        await this.#manager.rpc.call("torrent_stop", { ids: [id] }).catch(() => undefined);
        await this.#audit.append("torrent.validation_failed", {
          torrentId: id,
          phase: repairRequired ? "verification-incomplete" : "verification-or-scan",
          reason: String(error?.code || "VALIDATION_FAILED").slice(0, 80),
        }).catch(() => undefined);
      }
      throw error;
    } finally {
      this.#scanningIds.delete(id);
    }
  }

  async remove({ id, deleteData }) {
    if (this.#scanningIds.has(Number(id))) throw new Error("Le contrôle de sécurité doit se terminer avant de retirer ce torrent.");
    const raw = await this.#rawTorrent(assertTorrentId(id));
    if (deleteData !== true && deleteData !== false) throw new Error("Le choix de suppression des données doit être explicite.");
    if (deleteData) await this.#manager.rpc.call("torrent_stop", { ids: [id] });
    await this.#manager.rpc.call("torrent_remove", { ids: [id], delete_local_data: deleteData });
    for (let index = 0; index < (raw.files?.length || 0); index += 1) this.#scanRecords.delete(this.#scanKey(raw.hash_string, index));
    this.#mediaVault.revokeTorrent(raw.hash_string);
    await this.#audit.append("torrent.removed", { torrentId: id, localDataDeleted: deleteData });
    await this.#clearSharingBlock(raw.hash_string).catch(() => undefined);
    if (this.#contentRegistry) await this.#contentRegistry.remove(raw.hash_string);
    if (this.#globalSharing.enabled) await this.#forgetIndividualBaseline(raw.hash_string);
    else await this.#refreshIndividualBaseline();
    return { ok: true };
  }

  async setSeedPolicy({ id, ratioLimit, idleMinutes, uploadLimitKbps }) {
    if (this.#scanningIds.has(Number(id))) throw new Error("Le contrôle de sécurité doit se terminer avant de modifier ce torrent.");
    if (this.#globalSharing.enabled) throw new Error("La priorité globale est active. Désactivez-la avant de modifier ce torrent individuellement.");
    assertTorrentId(id);
    const ratio = ratioLimit === null ? null : Number(ratioLimit);
    const idle = idleMinutes === null ? null : Number(idleMinutes);
    const upload = uploadLimitKbps === null ? null : Number(uploadLimitKbps);
    if (ratio !== null && (!Number.isFinite(ratio) || ratio < 0.1 || ratio > 100)) throw new Error("Ratio cible hors limites (0,1 à 100).");
    if (idle !== null && (!Number.isInteger(idle) || idle < 1 || idle > 10_080)) throw new Error("Durée de seed hors limites (1 à 10080 minutes).");
    if (upload !== null && (!Number.isInteger(upload) || upload < 1 || upload > 1_000_000)) throw new Error("Limite d'upload hors limites.");
    await this.#manager.rpc.call("torrent_set", {
      ids: [id],
      seed_ratio_mode: ratio === null ? 2 : 1,
      ...(ratio === null ? {} : { seed_ratio_limit: ratio }),
      seed_idle_mode: idle === null ? 2 : 1,
      ...(idle === null ? {} : { seed_idle_limit: idle }),
      upload_limited: upload !== null,
      ...(upload === null ? {} : { upload_limit: upload }),
    });
    await this.#audit.append("torrent.seed_policy_changed", { torrentId: id, ratioLimit: ratio, idleMinutes: idle, uploadLimitKbps: upload });
    await this.#refreshIndividualBaseline();
    await this.#enforcePreValidationExchangeGuard([await this.#rawTorrent(id)]);
    return { ok: true, torrent: this.#normalized(await this.#rawTorrent(id)) };
  }

  async scan(id, {
    validationOwned = false,
    wasRunning: previousRunning,
    sharingAlreadyBlocked = false,
    deferFinalization = false,
  } = {}) {
    if (!validationOwned && this.#scanningIds.has(Number(id))) throw Object.assign(new Error("Un contrôle est déjà en cours pour ce torrent."), { code: "VALIDATION_BUSY" });
    assertTorrentId(id);
    if (!validationOwned) this.#scanningIds.add(id);
    let raw;
    let wasRunning = typeof previousRunning === "boolean" ? previousRunning : false;
    let scanCompleted = false;
    try {
      raw = await this.#rawTorrent(id);
      if (raw.percent_done < 0.999999) throw new Error("Le torrent doit être entièrement téléchargé avant l'analyse.");
      if ((raw.files?.length || 0) > MAX_FILES_PER_TORRENT) throw new Error("Le torrent contient trop de fichiers pour une analyse sûre.");
      if (typeof previousRunning !== "boolean") wasRunning = isRunningStatus(raw.status);
      if (!sharingAlreadyBlocked) {
        try {
          await this.#blockSharing(raw.hash_string, "scan-pending");
        } catch (error) {
          await this.#manager.rpc.call("torrent_stop", { ids: [id] }).catch(() => undefined);
          throw error;
        }
      }
      await this.#manager.rpc.call("torrent_stop", { ids: [id] });
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        raw = await this.#rawTorrent(id);
        if (Number(raw.status) === 0 && Number(raw.rate_download) === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (Number(raw.status) !== 0) throw new Error("Le torrent ne s'est pas arrêté avant l'analyse.");
      const wantedFiles = (raw.files || []).map((file, index) => ({ file, index, wanted: raw.file_stats?.[index]?.wanted !== false })).filter(({ wanted }) => wanted);
      if (wantedFiles.some(({ file }) => Number(file.bytes_completed) !== Number(file.length))) throw new Error("Un fichier sélectionné est incomplet.");

      const health = await this.#defenderHealth();
      await this.#audit.append("torrent.scan_started", { torrentId: id, files: wantedFiles.length, defenderHealthy: health.healthy, wasRunning });
      let scanned = 0;
      for (const { file, index } of wantedFiles) {
        const key = this.#scanKey(raw.hash_string, index);
        this.#scanRecords.set(key, { status: "scanning" });
        try {
          const allowedRoot = await this.#allowedDownloadRoot(raw.download_dir);
          const filePath = await resolveSafeTorrentFile(allowedRoot, raw.download_dir, file.name);
          const result = await this.#scanFile(filePath);
          this.#scanRecords.set(key, { status: "clean", filePath, size: result.size, mtimeMs: result.mtimeMs });
          scanned += 1;
        } catch (error) {
          this.#scanRecords.set(key, { status: "blocked" });
          await this.#blockSharing(raw.hash_string, "scan-failed").catch(() => undefined);
          await this.#audit.append("torrent.scan_blocked", { torrentId: id, fileIndex: index, reason: error.code || "SCAN_FAILED" });
          throw error;
        }
      }
      await this.#audit.append("torrent.scan_clean", { torrentId: id, files: scanned, signatureUpdatedAt: health.signatureUpdatedAt });
      scanCompleted = true;
      if (deferFinalization) {
        return {
          ok: true, clean: true, resumed: false, filesScanned: scanned, signatureUpdatedAt: health.signatureUpdatedAt,
          torrent: this.#normalized(await this.#rawTorrent(id)),
        };
      }
      await this.#clearSharingBlock(raw.hash_string);
      const requestedResume = wasRunning || (this.#globalSharing.enabled && this.#globalSharing.shareMode === "share-all");
      const policyAllowsResume = !this.#globalSharing.enabled || this.#globalSharing.shareMode !== "stop-all";
      const shouldResume = requestedResume && policyAllowsResume && !ratioLimitReached(this.#globalSharing, raw);
      if (shouldResume) {
        const cleanRaw = await this.#rawTorrent(id);
        await assertSafeTrackerUrls(trackerUrls(cleanRaw));
        if (this.#globalSharing.enabled) {
          await this.#manager.rpc.call("torrent_set", {
            ids: [id], bandwidth_priority: this.#globalSharing.priorityMode ? 1 : 0, upload_limited: false, honors_session_limits: true, seed_ratio_mode: 0, seed_idle_mode: 0,
          });
        }
        await this.#manager.rpc.call(this.#globalSharing.enabled && this.#globalSharing.priorityMode ? "torrent_start_now" : "torrent_start", { ids: [id] });
        await this.#audit.append("torrent.scan_resumed", { torrentId: id, prioritySeed: this.#globalSharing.enabled && this.#globalSharing.priorityMode });
      }
      return { ok: true, clean: true, resumed: shouldResume, filesScanned: scanned, signatureUpdatedAt: health.signatureUpdatedAt, torrent: this.#normalized(await this.#rawTorrent(id)) };
    } finally {
      if (!validationOwned) this.#scanningIds.delete(id);
      if (!scanCompleted) await this.#audit.append("torrent.scan_left_stopped", { torrentId: id }).catch(() => undefined);
    }
  }

  async mediaReference({ id, fileIndex }) {
    const raw = await this.#rawTorrent(assertTorrentId(id));
    if (!Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex >= (raw.files?.length || 0) || !isMediaName(raw.files[fileIndex].name)) throw new Error("Référence média invalide.");
    return { hash: raw.hash_string, fileIndex };
  }

  #mediaRequestKey(requestId, ownerWebContentsId) {
    if (typeof requestId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(requestId) || !Number.isInteger(ownerWebContentsId) || ownerWebContentsId <= 0) throw new Error("Requête média invalide.");
    return `${ownerWebContentsId}:${requestId}`;
  }

  cancelMediaPreparation(requestId, ownerWebContentsId) {
    const key = this.#mediaRequestKey(requestId, ownerWebContentsId);
    this.#mediaPreparations.get(key)?.controller.abort();
    this.#mediaCancellations.set(key, Date.now());
    for (const [candidate, timestamp] of this.#mediaCancellations) if (timestamp < Date.now() - 60_000) this.#mediaCancellations.delete(candidate);
    while (this.#mediaCancellations.size > 256) this.#mediaCancellations.delete(this.#mediaCancellations.keys().next().value);
    return { ok: true };
  }

  cancelMediaOwner(ownerWebContentsId) {
    for (const [key, job] of this.#mediaPreparations) if (key.startsWith(`${ownerWebContentsId}:`)) job.controller.abort();
  }

  mediaPreparation(requestId, ownerWebContentsId) {
    const job = this.#mediaPreparations.get(this.#mediaRequestKey(requestId, ownerWebContentsId));
    return job && !job.controller.signal.aborted ? { ...job.progress } : null;
  }

  async #prepareMediaRequest({ requestId = randomUUID(), ...options }, ownerWebContentsId, action) {
    const key = this.#mediaRequestKey(requestId, ownerWebContentsId);
    if (this.#mediaPreparations.has(key)) throw new Error("Requête média déjà en cours.");
    if (this.#mediaPreparations.size >= 12) throw Object.assign(new Error("Trop de médias en préparation. Fermez un lecteur puis réessayez."), { code: "MEDIA_PREPARATION_BUSY" });
    const controller = new AbortController();
    if ((this.#mediaCancellations.get(key) || 0) > Date.now() - 60_000) controller.abort();
    const job = { controller, progress: { stage: "probe", percent: null } };
    this.#mediaPreparations.set(key, job);
    const onProgress = (progress) => {
      if (controller.signal.aborted) return;
      if (!["probe", "queued", "video", "audio", "subtitles", "finalizing", "scan", "ready"].includes(progress.stage)) return;
      job.progress = { stage: progress.stage, percent: Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, Math.floor(progress.percent))) : null, hardware: progress.hardware === true };
    };
    try { controller.signal.throwIfAborted(); return await action(options, controller.signal, onProgress); }
    finally { this.#mediaPreparations.delete(key); }
  }

  openMedia(options, ownerWebContentsId) {
    return this.#prepareMediaRequest(options, ownerWebContentsId, (params, signal, onProgress) => this.#openMedia(params, ownerWebContentsId, signal, onProgress));
  }

  openSubtitle(options, ownerWebContentsId) {
    return this.#prepareMediaRequest(options, ownerWebContentsId, async ({ id, fileIndex, trackIndex }, signal, onProgress) => {
      if (!this.#mediaAdapter) throw new Error("Le moteur de sous-titres est indisponible.");
      const context = await this.#validatedMedia({ id, fileIndex }, signal);
      const mimeType = await validateMediaSignature(context.filePath);
      if (!["video/x-matroska", "video/mp4", "video/webm"].includes(mimeType)) throw new Error("Ce média ne contient pas de sous-titres intégrés lisibles.");
      const vtt = await this.#mediaAdapter.extractSubtitle({
        sourcePath: context.filePath, sourceSize: context.record.size, sourceMtimeMs: context.record.mtimeMs,
        trackIndex, signal, onProgress,
      });
      await this.#checkMediaValidation(context, signal);
      await this.#audit.append("media.subtitle_loaded", { torrentId: id, fileIndex, trackIndex });
      return { vtt };
    });
  }

  async #validatedMedia({ id, fileIndex }, signal) {
    signal.throwIfAborted();
    const raw = await this.#rawTorrent(assertTorrentId(id));
    if (this.#isSharingProtected(raw)) throw new Error("Le média est bloqué pendant le contrôle de sécurité.");
    if (!Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex >= (raw.files?.length || 0)) throw new Error("Index de fichier invalide.");
    const file = raw.files[fileIndex];
    if (raw.file_stats?.[fileIndex]?.wanted === false || Number(file.bytes_completed) !== Number(file.length)) throw new Error("Le média n'est pas entièrement disponible.");
    const key = this.#scanKey(raw.hash_string, fileIndex);
    const record = this.#scanRecords.get(key);
    if (record?.status !== "clean") throw new Error("Une analyse Microsoft Defender propre est obligatoire avant lecture.");
    const allowedRoot = await this.#allowedDownloadRoot(raw.download_dir);
    const filePath = await resolveSafeTorrentFile(allowedRoot, raw.download_dir, file.name);
    const current = await stat(filePath);
    if (filePath !== record.filePath || current.size !== record.size || current.mtimeMs !== record.mtimeMs) {
      this.#scanRecords.set(key, { status: "stale" });
      this.#mediaVault.revokeTorrent(raw.hash_string);
      throw new Error("Le média a changé depuis son analyse et doit être rescanné.");
    }
    return { raw, file, key, record, filePath };
  }

  async #checkMediaValidation({ raw, key, record, filePath }, signal) {
    const sourceAfter = await stat(filePath);
    signal.throwIfAborted();
    if (this.#isSharingProtected(raw) || this.#scanRecords.get(key) !== record || sourceAfter.size !== record.size || sourceAfter.mtimeMs !== record.mtimeMs) throw new Error("La validation du média a changé pendant son ouverture.");
  }

  async #openMedia({ id, fileIndex, purpose = "playback", audioTrack }, ownerWebContentsId, signal, onProgress) {
    if (!new Set(["playback", "thumbnail"]).has(purpose)) throw new Error("Usage du flux média invalide.");
    const context = await this.#validatedMedia({ id, fileIndex }, signal);
    const { raw, file, record, filePath } = context;
    let servedPath = filePath;
    let servedSize = record.size;
    let servedMtimeMs = record.mtimeMs;
    let mimeType = await validateMediaSignature(filePath);
    let audioAdapted = false;
    let audioCodec = null;
    let audioLanguage = null;
    let videoAdapted = false;
    let videoCodec = null;
    let audioTracks = [];
    let subtitleTracks = [];
    let selectedAudioTrack = null;
    if (purpose === "playback" && this.#mediaAdapter && ["video/x-matroska", "video/mp4", "video/webm"].includes(mimeType)) {
      await this.#audit.append("media.preparation_started", { torrentId: id, fileIndex });
      const options = { sourcePath: filePath, sourceSize: record.size, sourceMtimeMs: record.mtimeMs, audioTrack, signal, onProgress };
      const analysis = await this.#mediaAdapter.inspect(options);
      audioTracks = analysis.audioTracks;
      subtitleTracks = analysis.subtitleTracks;
      selectedAudioTrack = analysis.audio?.index ?? null;
      audioCodec = analysis.audio ? String(analysis.audio.codec_name).toUpperCase() : null;
      audioLanguage = analysis.audio?.tags?.language || null;
      const adapted = await this.#mediaAdapter.prepare(options);
      signal.throwIfAborted();
      if (adapted) {
        onProgress({ stage: "scan", percent: null });
        const adaptedScan = this.#adaptedScanRecords.get(adapted.filePath);
        if (!adaptedScan || adaptedScan.size !== adapted.size || adaptedScan.mtimeMs !== adapted.mtimeMs) {
          const scanKey = JSON.stringify([adapted.filePath, adapted.size, adapted.mtimeMs]);
          if (!this.#adaptedScansPending.has(scanKey)) {
            const task = this.#scanFile(adapted.filePath).then((clean) => {
              if (clean.size !== adapted.size || clean.mtimeMs !== adapted.mtimeMs) throw new Error("La version compatible a changé pendant son analyse.");
              this.#adaptedScanRecords.set(adapted.filePath, { size: clean.size, mtimeMs: clean.mtimeMs });
              while (this.#adaptedScanRecords.size > 256) this.#adaptedScanRecords.delete(this.#adaptedScanRecords.keys().next().value);
            }).finally(() => this.#adaptedScansPending.delete(scanKey));
            this.#adaptedScansPending.set(scanKey, task);
          }
          await this.#adaptedScansPending.get(scanKey);
        }
        servedPath = adapted.filePath;
        servedSize = adapted.size;
        servedMtimeMs = adapted.mtimeMs;
        mimeType = await validateMediaSignature(servedPath);
        audioAdapted = adapted.audioAdapted;
        audioCodec = adapted.audioCodec;
        audioLanguage = adapted.audioLanguage;
        videoAdapted = adapted.videoAdapted === true;
        videoCodec = adapted.videoCodec || null;
        await this.#audit.append("media.preparation_ready", { torrentId: id, fileIndex, cacheHit: adapted.cacheHit, audioCodec, audioLanguage, videoAdapted, videoCodec });
      }
    }
    await this.#checkMediaValidation(context, signal);
    const issued = this.#mediaVault.issue({
      filePath: servedPath,
      torrentKey: raw.hash_string,
      ownerWebContentsId,
      mimeType,
      name: safeName(audioAdapted || videoAdapted ? `${path.parse(file.name).name}.compatible.mp4` : path.basename(file.name), "Média"),
      expectedSize: servedSize,
      expectedMtimeMs: servedMtimeMs,
    });
    await this.#audit.append("media.access_issued", { torrentId: id, fileIndex, expiresAt: issued.expiresAt });
    onProgress({ stage: "ready", percent: 100 });
    return { ...issued, audioAdapted, audioCodec, audioLanguage, videoAdapted, videoCodec, audioTracks, subtitleTracks, selectedAudioTrack };
  }
}

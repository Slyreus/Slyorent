import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { access, lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { TransmissionRpcClient } from "./transmission-rpc.mjs";
import { canonicalPathWithoutLinks, UnsafePathError } from "./safe-path.mjs";
import { NETWORK_DLLS, NETWORK_ENGINE_DIRECTORY } from "./network-runtime.mjs";

const EXPECTED_DAEMON_SHA256 = "1ce3ebd74e4067962bfd04e8cbe6c891ec8f12d64bcc2dc908762520fc2a8816";
const ENGINE_RELATIVE_PATH = path.join(".runtime", "engine", NETWORK_ENGINE_DIRECTORY, "PFiles", "Transmission", "transmission-daemon.exe");
// Conserver le chemin installé pour préserver les autorisations réseau existantes.
const PACKAGED_ENGINE_RELATIVE_PATH = path.join(".runtime", "engine", "transmission-4.1.3", "PFiles", "Transmission", "transmission-daemon.exe");
const STORAGE_POLICY_SCHEMA_VERSION = 1;
const MAX_ALLOWED_DOWNLOAD_DIRECTORIES = 32;
const EXPECTED_ENGINE_DLLS = Object.freeze({
  ...NETWORK_DLLS,
  "z.dll": "11d13bd3c0e711cb00f7de24ef2c9c8034b4c8a149c71f52f2ab05900d24cf5c",
});

export function trustedEngineFiles() {
  return Object.freeze({ "transmission-daemon.exe": EXPECTED_DAEMON_SHA256, ...EXPECTED_ENGINE_DLLS });
}

function randomCredential(prefix) {
  return `${prefix}-${randomBytes(24).toString("base64url")}`;
}

async function findFreeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function atomicSettingsWrite(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, filePath);
}

function containsPath(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function directoryKey(directory) {
  const resolved = path.resolve(directory);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function engineDllFiles(root, directory = root) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Un lien symbolique est interdit dans le moteur Transmission.");
    if (entry.isDirectory()) found.push(...await engineDllFiles(root, absolute));
    else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".dll") found.push(path.relative(root, absolute).replaceAll("\\", "/").toLowerCase());
  }
  return found;
}

async function verifyEngineDlls(engineDirectory) {
  const actual = (await engineDllFiles(engineDirectory)).sort();
  const expected = Object.keys(EXPECTED_ENGINE_DLLS).sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error("L'ensemble des DLL du moteur Transmission a été modifié.");
  }
  for (const [relativeName, expectedHash] of Object.entries(EXPECTED_ENGINE_DLLS)) {
    const candidate = await realpath(path.join(engineDirectory, ...relativeName.split("/")));
    if (path.dirname(candidate) !== engineDirectory && !candidate.startsWith(`${engineDirectory}${path.sep}`)) throw new Error("Une DLL Transmission sort de son répertoire.");
    if (await sha256File(candidate) !== expectedHash) throw new Error(`Empreinte inattendue pour ${relativeName}.`);
  }
}

function secureEngineEnvironment(engineDirectory) {
  const windowsRoot = path.resolve(process.env.SystemRoot || "C:\\Windows");
  if (path.basename(windowsRoot).toLowerCase() !== "windows" || path.dirname(windowsRoot).toLowerCase() !== path.parse(windowsRoot).root.toLowerCase()) {
    throw new Error("Le répertoire système Windows n'est pas canonique.");
  }
  const environment = {
    SystemRoot: windowsRoot,
    WINDIR: windowsRoot,
    ProgramData: path.join(path.parse(windowsRoot).root, "ProgramData"),
    PATH: [engineDirectory, path.join(windowsRoot, "System32"), windowsRoot].join(path.delimiter),
  };
  for (const key of ["APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "USERPROFILE"]) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return environment;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= minimum && numeric <= maximum ? numeric : fallback;
}

async function requestedStartupPreferences(profileDirectory) {
  const defaults = {
    portMapping: process.env.SECUTORRENT_ENABLE_PORTMAP === "1",
    priorityMode: true,
  };
  try {
    const policy = JSON.parse(await readFile(path.join(profileDirectory, "global-sharing-policy.json"), "utf8"));
    if (!policy || typeof policy !== "object" || Array.isArray(policy)) return defaults;
    return {
      portMapping: policy.portMapping === true,
      priorityMode: policy.enabled !== false && policy.priorityMode !== false,
    };
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return defaults;
    throw error;
  }
}

export class TransmissionManager {
  #appPath;
  #canonicalAppPath;
  #userDataPath;
  #audit;
  #process = null;
  #rpc = null;
  #rpcReady = false;
  #version = null;
  #rpcVersion = null;
  #stopping = false;
  #portMapping = false;
  #priorityMode = true;
  #uploadSlotsPerTorrent = 4;
  #defaultLibraryPath;
  #downloadDirectory;
  #allowedDownloadDirectories = new Map();
  #storagePolicyPath;
  #storageChangeChain = Promise.resolve();

  constructor({ appPath, userDataPath, audit, defaultLibraryPath = null }) {
    this.#appPath = path.resolve(appPath);
    this.#canonicalAppPath = this.#appPath;
    this.#userDataPath = path.resolve(userDataPath);
    this.#audit = audit;
    this.paths = Object.freeze({
      profile: path.join(this.#userDataPath, "engine-profile"),
      data: path.join(this.#userDataPath, "quarantine"),
      incomplete: path.join(this.#userDataPath, "quarantine-incomplete"),
    });
    this.#defaultLibraryPath = defaultLibraryPath === null ? this.paths.data : path.resolve(defaultLibraryPath);
    this.#downloadDirectory = this.#defaultLibraryPath;
    this.#storagePolicyPath = path.join(this.paths.profile, "storage-policy.json");
    this.peerPort = boundedInteger(process.env.SECUTORRENT_PEER_PORT, 51_413, 1_024, 65_535);
  }

  async #canonicalDownloadDirectory(directory) {
    if (typeof directory !== "string" || directory.length < 1 || directory.length > 32_767 || directory.includes("\0") || !path.isAbsolute(directory)) {
      throw new Error("Répertoire de téléchargement invalide.");
    }
    const requested = path.resolve(directory);
    if (requested === path.parse(requested).root) throw new Error("La racine d'un disque ne peut pas servir de répertoire de téléchargement.");
    if (process.platform === "win32" && requested.startsWith("\\\\")) throw new Error("Les emplacements réseau ne sont pas autorisés.");
    const info = await lstat(requested);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Le répertoire choisi doit être un dossier local réel.");
    const canonical = await realpath(requested);
    if (containsPath(this.#canonicalAppPath, canonical) || containsPath(canonical, this.#canonicalAppPath)) {
      throw new Error("Le répertoire de téléchargement ne peut pas contenir l'application ni s'y trouver.");
    }
    const protectedRoots = [process.env.SystemRoot, process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramData]
      .filter((value) => typeof value === "string" && path.isAbsolute(value))
      .map((value) => path.resolve(value));
    if (protectedRoots.some((root) => containsPath(root, canonical))) throw new Error("Un dossier système ne peut pas recevoir de téléchargements.");
    const internalData = await realpath(this.paths.data);
    const overlapsUserData = containsPath(this.#userDataPath, canonical) || containsPath(canonical, this.#userDataPath);
    if (overlapsUserData && !containsPath(internalData, canonical)) {
      throw new Error("Ce dossier interne est réservé au profil sécurisé de Slyorrent.");
    }
    return canonical;
  }

  async #assertDirectoryWritable(directory) {
    const probe = path.join(directory, `.slyorent-write-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
    let created = false;
    try {
      await writeFile(probe, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
      created = true;
    } catch {
      throw new Error("Slyorrent ne peut pas écrire dans le dossier choisi.");
    } finally {
      if (created) await unlink(probe).catch(() => undefined);
    }
  }

  async #writeStoragePolicy(downloadDirectory, allowedDirectories) {
    const directories = [...allowedDirectories.values()];
    if (directories.length > MAX_ALLOWED_DOWNLOAD_DIRECTORIES) throw new Error("Trop d'anciens répertoires de téléchargement sont enregistrés.");
    await atomicSettingsWrite(this.#storagePolicyPath, {
      schemaVersion: STORAGE_POLICY_SCHEMA_VERSION,
      downloadDirectory,
      allowedDirectories: directories,
    });
  }

  async #loadStoragePolicy() {
    const quarantine = await this.#canonicalDownloadDirectory(this.paths.data);
    let fallback = quarantine;
    if (directoryKey(this.#defaultLibraryPath) !== directoryKey(quarantine)) {
      try {
        fallback = await this.#canonicalDownloadDirectory(this.#defaultLibraryPath);
      } catch {
        await this.#audit.append("storage.default_library_rejected", { fallbackUsed: true }).catch(() => undefined);
      }
    }
    const allowed = new Map([
      [directoryKey(quarantine), quarantine],
      [directoryKey(fallback), fallback],
    ]);
    let selected = fallback;
    try {
      const stored = JSON.parse(await readFile(this.#storagePolicyPath, "utf8"));
      if (stored?.schemaVersion !== STORAGE_POLICY_SCHEMA_VERSION || typeof stored.downloadDirectory !== "string" || !Array.isArray(stored.allowedDirectories) || stored.allowedDirectories.length > MAX_ALLOWED_DOWNLOAD_DIRECTORIES) {
        throw new Error("Politique de stockage invalide.");
      }
      const candidates = [stored.downloadDirectory, ...stored.allowedDirectories].slice(0, MAX_ALLOWED_DOWNLOAD_DIRECTORIES);
      let storedSelectionKey = null;
      for (const [index, candidate] of candidates.entries()) {
        try {
          const canonical = await this.#canonicalDownloadDirectory(candidate);
          const key = directoryKey(canonical);
          allowed.set(key, canonical);
          if (index === 0) storedSelectionKey = key;
        } catch { /* Un ancien dossier absent ou non sûr n'est plus autorisé. */ }
      }
      const storedSelection = storedSelectionKey ? allowed.get(storedSelectionKey) : null;
      selected = storedSelection && directoryKey(storedSelection) !== directoryKey(quarantine) ? storedSelection : fallback;
    } catch (error) {
      if (error?.code !== "ENOENT") await this.#audit.append("storage.policy_rejected", { fallbackUsed: true }).catch(() => undefined);
    }
    this.#allowedDownloadDirectories = allowed;
    this.#downloadDirectory = selected;
  }

  setDownloadDirectory(directory) {
    const run = this.#storageChangeChain.then(() => this.#setDownloadDirectory(directory));
    this.#storageChangeChain = run.catch(() => undefined);
    return run;
  }

  async #setDownloadDirectory(directory) {
    const canonical = await this.#canonicalDownloadDirectory(directory);
    if (directoryKey(canonical) === directoryKey(this.#downloadDirectory)) {
      return { ok: true, changed: false, directory: this.#downloadDirectory, appliesTo: "new-torrents" };
    }
    await this.#assertDirectoryWritable(canonical);
    const nextAllowed = new Map(this.#allowedDownloadDirectories);
    nextAllowed.set(directoryKey(canonical), canonical);
    if (nextAllowed.size > MAX_ALLOWED_DOWNLOAD_DIRECTORIES) throw new Error("Trop d'anciens répertoires sont encore utilisés.");
    await this.#writeStoragePolicy(canonical, nextAllowed);
    this.#downloadDirectory = canonical;
    this.#allowedDownloadDirectories = nextAllowed;
    await this.#audit.append("storage.library_directory_changed", { appliesTo: "new-torrents", retainedPreviousDirectories: nextAllowed.size - 1 });
    return { ok: true, changed: true, directory: canonical, appliesTo: "new-torrents" };
  }

  approveLibraryRoot(directory) {
    const run = this.#storageChangeChain.then(() => this.#approveLibraryRoot(directory));
    this.#storageChangeChain = run.catch(() => undefined);
    return run;
  }

  async #approveLibraryRoot(directory) {
    const canonical = await this.#canonicalDownloadDirectory(directory);
    await this.#assertDirectoryWritable(canonical);
    const key = directoryKey(canonical);
    if (this.#allowedDownloadDirectories.has(key)) {
      return { ok: true, changed: false, directory: canonical };
    }
    const nextAllowed = new Map(this.#allowedDownloadDirectories);
    nextAllowed.set(key, canonical);
    if (nextAllowed.size > MAX_ALLOWED_DOWNLOAD_DIRECTORIES) throw new Error("Trop de racines de bibliothèque sont encore utilisées.");
    await this.#writeStoragePolicy(this.#downloadDirectory, nextAllowed);
    this.#allowedDownloadDirectories = nextAllowed;
    await this.#audit.append("storage.library_root_approved", { retainedDirectories: nextAllowed.size });
    return { ok: true, changed: true, directory: canonical };
  }

  async resolveAllowedDownloadRoot(directory) {
    const canonical = await this.#canonicalDownloadDirectory(directory);
    const root = [...this.#allowedDownloadDirectories.values()].find((candidate) => containsPath(candidate, canonical));
    if (!root) throw new Error("Le torrent référence un répertoire qui n'a pas été autorisé par Slyorrent.");
    return root;
  }

  async #resolveAndVerifyEngine() {
    const candidates = [
      path.join(this.#appPath, ENGINE_RELATIVE_PATH),
      path.join(process.resourcesPath || "", PACKAGED_ENGINE_RELATIVE_PATH),
      path.join(process.cwd(), ENGINE_RELATIVE_PATH),
    ];
    for (const candidate of [...new Set(candidates)]) {
      try {
        await access(candidate);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      let resolved;
      try {
        resolved = await canonicalPathWithoutLinks(candidate);
      } catch (error) {
        if (error instanceof UnsafePathError) throw new Error("Un lien ou point de reanalyse est interdit pour le moteur Transmission.");
        throw error;
      }
      const digest = await sha256File(resolved);
      if (digest !== EXPECTED_DAEMON_SHA256) throw new Error("Empreinte SHA-256 du moteur Transmission inattendue.");
      await verifyEngineDlls(path.dirname(resolved));
      return resolved;
    }
    throw new Error(`Transmission 4.1.4 est introuvable dans ${ENGINE_RELATIVE_PATH}.`);
  }

  async start() {
    if (this.#process && this.#rpcReady) return this.status();
    await Promise.all(Object.values(this.paths).map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
    if (directoryKey(this.#defaultLibraryPath) !== directoryKey(this.paths.data)) {
      await mkdir(this.#defaultLibraryPath, { recursive: true, mode: 0o700 });
    }
    const [canonicalAppPath, canonicalUserData, canonicalProfile, canonicalData, canonicalIncomplete, canonicalDefaultLibrary] = await Promise.all([
      canonicalPathWithoutLinks(this.#appPath),
      canonicalPathWithoutLinks(this.#userDataPath),
      canonicalPathWithoutLinks(this.paths.profile),
      canonicalPathWithoutLinks(this.paths.data),
      canonicalPathWithoutLinks(this.paths.incomplete),
      canonicalPathWithoutLinks(this.#defaultLibraryPath),
    ]);
    this.#canonicalAppPath = canonicalAppPath;
    this.#userDataPath = canonicalUserData;
    this.paths = Object.freeze({
      profile: canonicalProfile,
      data: canonicalData,
      incomplete: canonicalIncomplete,
    });
    this.#defaultLibraryPath = canonicalDefaultLibrary;
    this.#storagePolicyPath = path.join(this.paths.profile, "storage-policy.json");
    await this.#loadStoragePolicy();
    const executable = await this.#resolveAndVerifyEngine();
    const rpcPort = await findFreeLoopbackPort();
    const username = randomCredential("st");
    const password = randomCredential("secret");
    const settingsPath = path.join(this.paths.profile, "settings.json");
    const startupPreferences = await requestedStartupPreferences(this.paths.profile);
    this.#portMapping = startupPreferences.portMapping;
    this.#priorityMode = startupPreferences.priorityMode;
    this.#uploadSlotsPerTorrent = this.#priorityMode ? 4 : 8;

    const settings = {
      alt_speed_enabled: false,
      anti_brute_force_enabled: true,
      anti_brute_force_threshold: 10,
      blocklist_enabled: false,
      default_trackers: "",
      dht_enabled: true,
      download_dir: this.paths.data,
      encryption: "preferred",
      incomplete_dir: this.paths.incomplete,
      incomplete_dir_enabled: true,
      lpd_enabled: false,
      peer_limit_global: 200,
      peer_limit_per_torrent: 50,
      peer_port: this.peerPort,
      peer_port_random_on_start: false,
      pex_enabled: true,
      port_forwarding_enabled: this.#portMapping,
      preferred_transports: ["utp", "tcp"],
      proxy_url: "",
      queue_stalled_enabled: !this.#priorityMode,
      rename_partial_files: true,
      rpc_authentication_required: true,
      rpc_bind_address: "127.0.0.1",
      rpc_enabled: true,
      rpc_host_whitelist: "localhost,127.0.0.1",
      rpc_host_whitelist_enabled: true,
      rpc_password: password,
      rpc_port: rpcPort,
      rpc_url: "/transmission/",
      rpc_username: username,
      rpc_whitelist: "127.0.0.1,::1",
      rpc_whitelist_enabled: true,
      script_torrent_added_enabled: false,
      script_torrent_done_enabled: false,
      script_torrent_done_seeding_enabled: false,
      seed_queue_enabled: !this.#priorityMode,
      start_added_torrents: false,
      start_paused: true,
      torrent_complete_verify_enabled: true,
      trash_original_torrent_files: false,
      umask: "077",
      upload_slots_per_torrent: this.#uploadSlotsPerTorrent,
      watch_dir_enabled: false,
    };
    await atomicSettingsWrite(settingsPath, settings);

    await this.#audit.append("engine.starting", {
      rpcPort,
      peerPort: this.peerPort,
      portMapping: settings.port_forwarding_enabled,
      priorityMode: this.#priorityMode,
      uploadSlotsPerTorrent: this.#uploadSlotsPerTorrent,
    });
    const child = spawn(executable, [
      "--foreground",
      "--config-dir", this.paths.profile,
      "--download-dir", this.paths.data,
      "--incomplete-dir", this.paths.incomplete,
      "--paused",
      "--auth",
      "--allowed", "127.0.0.1,::1",
      "--rpc-bind-address", "127.0.0.1",
      "--port", String(rpcPort),
      "--peerport", String(this.peerPort),
      "--peerlimit-global", "200",
      "--peerlimit-torrent", "50",
      "--encryption-preferred",
      "--no-lpd",
      ...(settings.port_forwarding_enabled ? ["--portmap"] : ["--no-portmap"]),
    ], {
      cwd: path.dirname(executable),
      windowsHide: true,
      shell: false,
      env: secureEngineEnvironment(path.dirname(executable)),
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.#process = child;
    this.#rpc = new TransmissionRpcClient({ port: rpcPort, username, password });
    let stderrTail = "";
    child.stderr?.on("data", (chunk) => { stderrTail = `${stderrTail}${chunk}`.slice(-4_096); });
    child.once("exit", (code, signal) => {
      const expected = this.#stopping;
      this.#process = null;
      this.#rpcReady = false;
      this.#rpc = null;
      void this.#audit.append(expected ? "engine.stopped" : "engine.crashed", { code, signal }).catch(() => undefined);
    });

    try {
      const session = await this.#rpc.waitUntilReady({ timeoutMs: 20_000 });
      if (!String(session.rpc_version_semver || "").startsWith("6.")) throw new Error(`Version RPC Transmission incompatible: ${session.rpc_version_semver || "inconnue"}.`);
      if (!String(session.version || "").startsWith("4.1.4")) throw new Error(`Version Transmission inattendue: ${session.version || "inconnue"}.`);
      this.#version = session.version;
      this.#rpcVersion = session.rpc_version_semver;
      this.#rpcReady = true;
      await this.#audit.append("engine.started", { version: this.#version, rpcPort, peerPort: this.peerPort });
      return this.status();
    } catch (error) {
      await this.#terminateChild();
      throw new Error(`${error.message}${stderrTail ? " (le moteur a refusé son profil sécurisé)" : ""}`);
    }
  }

  get rpc() {
    if (!this.#rpcReady || !this.#rpc) throw new Error("Le moteur P2P local n'est pas prêt.");
    return this.#rpc;
  }

  status() {
    const running = Boolean(this.#process && !this.#process.killed);
    const state = this.#rpcReady ? "ready" : running ? "starting" : "stopped";
    return {
      ready: this.#rpcReady,
      state,
      running,
      rpcReady: this.#rpcReady,
      version: this.#version,
      rpcVersion: this.#rpcVersion,
      quarantineDir: this.paths.data,
      downloadDir: this.#downloadDirectory,
      incompleteDir: this.paths.incomplete,
      peerPort: this.peerPort,
      portMapping: this.#portMapping,
      priorityMode: this.#priorityMode,
      uploadSlotsPerTorrent: this.#uploadSlotsPerTorrent,
    };
  }

  notePortMapping(enabled) {
    this.#portMapping = enabled === true;
  }

  notePriorityMode(enabled) {
    this.#priorityMode = enabled === true;
  }

  async stop() {
    if (!this.#process) return;
    this.#stopping = true;
    try { if (this.#rpcReady && this.#rpc) await this.#rpc.call("session_close", {}, 3_000); } catch { /* Arrêt forcé borné ci-dessous. */ }
    await this.#terminateChild();
    this.#stopping = false;
  }

  async #terminateChild() {
    const child = this.#process;
    if (!child) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    try { child.kill("SIGTERM"); } catch { /* Déjà arrêté. */ }
    const ended = await Promise.race([exited.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 4_000))]);
    if (!ended && child.pid) {
      if (process.platform === "win32") {
        await new Promise((resolve) => {
          const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, shell: false, stdio: "ignore" });
          killer.once("exit", resolve);
          killer.once("error", resolve);
        });
      } else {
        try { child.kill("SIGKILL"); } catch { /* Déjà arrêté. */ }
      }
    }
    this.#process = null;
    this.#rpcReady = false;
    this.#rpc = null;
  }
}

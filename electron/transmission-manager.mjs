import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { access, lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { TransmissionRpcClient } from "./transmission-rpc.mjs";

const EXPECTED_DAEMON_SHA256 = "397dd842bbb4398f0e35a5b299af19add28d8175564017b6f239a855646665bd";
const ENGINE_RELATIVE_PATH = path.join(".runtime", "engine", "transmission-4.1.3", "PFiles", "Transmission", "transmission-daemon.exe");
const STORAGE_POLICY_SCHEMA_VERSION = 1;
const MAX_ALLOWED_DOWNLOAD_DIRECTORIES = 32;
const EXPECTED_ENGINE_DLLS = Object.freeze({
  "dbus-1.dll": "48f5d441e8fca6878817f2fe1a1bb62eec36aedab1ec238670d07d85efb335be",
  "imageformats/qgif.dll": "62bf09be7a1eafb725857fa2b21792afd57796e77a6e705d1e32f1ab81428395",
  "imageformats/qico.dll": "e7150d59d0fdbfb0bf9dc2fe07bcf547323792bcc9a69047955781864bc5b6e7",
  "imageformats/qjpeg.dll": "db71aa33d0a91ed35e7bf9b48a860ac018cc7c5774c931f30e69be33e3baa96d",
  "imageformats/qsvg.dll": "f20bdb24204de9965c513c37e569cf2b4edc3b14e73194b83372c0d7b30256bc",
  "libcrypto-3-x64.dll": "dadd54776f7dead0130acf18938cbdc89bdfa7e4d036d66aa735a24ab84e877e",
  "libcurl.dll": "bd47510f26da03bf9f55d27d03d54ae7ebac7f444c3f05169bf9aa3837f3594a",
  "libssl-3-x64.dll": "537170dc0cdf023437bea8d59d298823d60bca200e1d70be85f2a1da3dfd4d55",
  "platforms/qwindows.dll": "677232212542506f8838ecd05d4be4d718346e1bad911025ae41a518a7e7b1a4",
  "qt6core.dll": "1943159265d9c989e5607de1aac2495cc4f46dea8566b374da18c661b6de278d",
  "qt6dbus.dll": "4c9b09b845e0cf67fa1f927629ba21b267e0de29e33907ef5029a78ec3d1642b",
  "qt6gui.dll": "bfb50c4d1dbd60a01c9088487fe79d749e1d3a2bb131fef3df33cad1b453fc51",
  "qt6network.dll": "9ca377a5cd20a70d2c6f082ba73b27d1e4f049e8ae058a0d61eef33025e5b90f",
  "qt6svg.dll": "1a4bc8a7cd46b4636aef746a50285dab5b5b81fbe8494dceaab02af45ca475e9",
  "qt6widgets.dll": "fd0306ec97f4b46e5c1b20e29aa26c9672ab5235d9182fb358b7ba19579bd4dc",
  "styles/qmodernwindowsstyle.dll": "3248422614952a17127aa3634d0628248c6bb377cd82cbe083514569a6743c4a",
  "tls/qopensslbackend.dll": "1e14c826e348083ee07007cf8d913fac4e9db966a969be82af4695fa2668f28d",
  "zlib.dll": "536c6fc588a549f024a715ea250b0f3bfa038d3912b831594bb527cb6e5a1720",
});

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
  const qtConfig = path.join(engineDirectory, "qt.conf");
  if (await sha256File(qtConfig) !== "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855") throw new Error("La configuration Qt du moteur a été modifiée.");
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
    if (containsPath(this.#appPath, canonical) || containsPath(canonical, this.#appPath)) {
      throw new Error("Le répertoire de téléchargement ne peut pas contenir l'application ni s'y trouver.");
    }
    const protectedRoots = [process.env.SystemRoot, process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramData]
      .filter((value) => typeof value === "string" && path.isAbsolute(value))
      .map((value) => path.resolve(value));
    if (protectedRoots.some((root) => containsPath(root, canonical))) throw new Error("Un dossier système ne peut pas recevoir de téléchargements.");
    const internalData = await realpath(this.paths.data);
    const overlapsUserData = containsPath(this.#userDataPath, canonical) || containsPath(canonical, this.#userDataPath);
    if (overlapsUserData && !containsPath(internalData, canonical)) {
      throw new Error("Ce dossier interne est réservé au profil sécurisé de Slyorent.");
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
      throw new Error("Slyorent ne peut pas écrire dans le dossier choisi.");
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
      for (const candidate of candidates) {
        try {
          const canonical = await this.#canonicalDownloadDirectory(candidate);
          allowed.set(directoryKey(canonical), canonical);
        } catch { /* Un ancien dossier absent ou non sûr n'est plus autorisé. */ }
      }
      const storedSelection = allowed.get(directoryKey(stored.downloadDirectory));
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
    if (!root) throw new Error("Le torrent référence un répertoire qui n'a pas été autorisé par Slyorent.");
    return root;
  }

  async #resolveAndVerifyEngine() {
    const candidates = [
      path.join(this.#appPath, ENGINE_RELATIVE_PATH),
      path.join(process.resourcesPath || "", ENGINE_RELATIVE_PATH),
      path.join(process.cwd(), ENGINE_RELATIVE_PATH),
    ];
    for (const candidate of [...new Set(candidates)]) {
      try {
        await access(candidate);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      const resolved = await realpath(candidate);
      if (resolved.toLowerCase() !== path.resolve(candidate).toLowerCase()) throw new Error("Un lien ou point de reanalyse est interdit pour le moteur Transmission.");
      const digest = await sha256File(resolved);
      if (digest !== EXPECTED_DAEMON_SHA256) throw new Error("Empreinte SHA-256 du moteur Transmission inattendue.");
      await verifyEngineDlls(path.dirname(resolved));
      return resolved;
    }
    throw new Error(`Transmission 4.1.3 est introuvable dans ${ENGINE_RELATIVE_PATH}.`);
  }

  async start() {
    if (this.#process && this.#rpcReady) return this.status();
    await Promise.all(Object.values(this.paths).map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
    if (directoryKey(this.#defaultLibraryPath) !== directoryKey(this.paths.data)) {
      await mkdir(this.#defaultLibraryPath, { recursive: true, mode: 0o700 });
    }
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
      if (!String(session.version || "").startsWith("4.1.3")) throw new Error(`Version Transmission inattendue: ${session.version || "inconnue"}.`);
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

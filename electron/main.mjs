import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from "electron";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AuditLog } from "./audit-log.mjs";
import { ContentRegistry } from "./content-registry.mjs";
import { MediaAdapter } from "./media-adapter.mjs";
import { MediaVault } from "./media-vault.mjs";
import { createDefaultPeerTelemetry } from "./peer-telemetry.mjs";
import { SharingHistory } from "./sharing-history.mjs";
import { TorrentService } from "./torrent-service.mjs";
import { TransmissionManager } from "./transmission-manager.mjs";
import { WatchHistory } from "./watch-history.mjs";
import { TorrentOpenQueue } from "./torrent-open-queue.mjs";

const IPC_CHANNEL = "secutorrent:rpc";
const PRODUCT_NAME = "Slyorrent";
const LEGACY_USER_DATA_DIRECTORY = "SecuTorrent Slyorus";
const MAX_REQUESTS_PER_MINUTE = 600;
const SHARING_MAINTENANCE_INTERVAL_MS = 60_000;
const VALIDATION_MAINTENANCE_INTERVAL_MS = 2_000;
const DESTINATION_CAPABILITY_TTL_MS = 10 * 60_000;
const MAX_DESTINATION_CAPABILITIES = 32;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

protocol.registerSchemesAsPrivileged([{
  scheme: "secutorrent-media",
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
}]);

function containsPath(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function rendererLocation(appPath) {
  if (!app.isPackaged && process.env.SECUTORRENT_RENDERER_URL) {
    const url = new URL(process.env.SECUTORRENT_RENDERER_URL);
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) {
      throw new Error("SECUTORRENT_RENDERER_URL doit être une URL HTTP de boucle locale sans identifiants.");
    }
    url.hash = "";
    return Object.freeze({ mode: "development", url });
  }

  const distRoot = await realpath(path.join(appPath, "dist"));
  const indexFile = await realpath(path.join(distRoot, "index.html"));
  if (!containsPath(distRoot, indexFile) || !(await stat(indexFile)).isFile()) throw new Error("Le renderer local dist/index.html est absent ou sort du build signé.");
  return Object.freeze({ mode: "production", distRoot, indexFile });
}

async function fileUrlIsInside(url, renderer) {
  if (renderer.mode !== "production" || url.protocol !== "file:") return false;
  try {
    const resolved = await realpath(fileURLToPath(url));
    return containsPath(renderer.distRoot, resolved);
  } catch {
    return false;
  }
}

function productionNavigationAllowed(url, renderer) {
  if (renderer.mode !== "production" || url.protocol !== "file:") return false;
  try { return path.resolve(fileURLToPath(url)) === renderer.indexFile; } catch { return false; }
}

async function senderAllowed(event, mainWindow, renderer) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame) return false;
  try {
    const senderUrl = new URL(event.senderFrame.url);
    return renderer.mode === "development" ? senderUrl.origin === renderer.url.origin : fileUrlIsInside(senderUrl, renderer);
  } catch { return false; }
}

function createRateLimiter() {
  const buckets = new Map();
  return (webContentsId) => {
    const now = Date.now();
    const cutoff = now - 60_000;
    const recent = (buckets.get(webContentsId) || []).filter((timestamp) => timestamp > cutoff);
    if (recent.length >= MAX_REQUESTS_PER_MINUTE) return false;
    recent.push(now);
    buckets.set(webContentsId, recent);
    return true;
  };
}

function errorEnvelope(id, error) {
  const safeCode = typeof error?.code === "string" || Number.isInteger(error?.code) ? error.code : "OPERATION_FAILED";
  const safeMessage = String(error?.message || "Opération locale refusée.").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500);
  return { jsonrpc: "2.0", id, error: { code: safeCode, message: safeMessage } };
}

function registerIpc({ mainWindow, renderer, service, manager, audit, sharingHistory, watchHistory, mediaVault, openQueue }) {
  const allowRequest = createRateLimiter();
  const destinationCapabilities = new Map();
  const pruneDestinationCapabilities = () => {
    const now = Date.now();
    for (const [token, capability] of destinationCapabilities) {
      if (capability.expiresAt <= now) destinationCapabilities.delete(token);
    }
  };
  const destinationFromRequest = async (params, event) => {
    if (params.createSubfolder !== undefined && typeof params.createSubfolder !== "boolean") {
      throw Object.assign(new Error("Choix du sous-dossier invalide."), { code: "INVALID_DESTINATION" });
    }
    const createSubfolder = params.createSubfolder !== false;
    const token = params.destinationToken;
    if (token === undefined || token === null || token === "") {
      const libraryRoot = manager.status().downloadDir;
      await manager.resolveAllowedDownloadRoot(libraryRoot);
      return { libraryRoot, createSubfolder };
    }
    if (typeof token !== "string" || token.length > 128) throw Object.assign(new Error("Destination expirée ou invalide."), { code: "INVALID_DESTINATION" });
    pruneDestinationCapabilities();
    const capability = destinationCapabilities.get(token);
    destinationCapabilities.delete(token);
    if (!capability || capability.ownerId !== event.sender.id || capability.expiresAt <= Date.now()) {
      throw Object.assign(new Error("Destination expirée. Choisissez à nouveau le dossier."), { code: "DESTINATION_EXPIRED" });
    }
    const approved = await manager.approveLibraryRoot(capability.directory);
    return { libraryRoot: approved.directory, createSubfolder };
  };
  const openLocalDirectory = async (directory, details) => {
    const result = await shell.openPath(directory);
    if (result) {
      await audit.append("storage.directory_open_failed", details).catch(() => undefined);
      throw new Error("Windows n'a pas pu ouvrir ce dossier.");
    }
    await audit.append("storage.directory_opened", details);
    return { ok: true };
  };
  const methods = new Map([
    ["status", async () => manager.status()],
    ["list", async () => service.list()],
    ["globalSharing", async () => service.globalSharing()],
    ["setGlobalSharing", async (params) => service.setGlobalSharing(params)],
    ["sharingDiagnostics", async () => service.sharingDiagnostics()],
    ["sharingHistory", async ({ hours }) => sharingHistory.summary(hours)],
    ["peerSnapshot", async () => service.peerSnapshot()],
    ["locateSelf", async () => service.locateSelf()],
    ["inspectMagnet", async ({ magnet }) => service.inspectMagnet(magnet)],
    ["addMagnet", async (params, event) => service.addMagnet({ ...params, destination: await destinationFromRequest(params, event) })],
    ["importTorrent", async (params, event) => {
      if (params.rightsConfirmed !== true || params.startPaused !== true) throw new Error("Confirmez les droits et l’import en pause.");
      if (params.pendingToken !== undefined) {
        const destination = await destinationFromRequest(params, event);
        const filePath = await openQueue.take(params.pendingToken);
        return service.importTorrentFile(filePath, { ...params, destination });
      }
      const selection = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
        title: "Importer un fichier torrent autorisé",
        buttonLabel: "Inspecter en pause",
        filters: [{ name: "Fichiers BitTorrent", extensions: ["torrent"] }],
        properties: ["openFile", "dontAddToRecent"],
      });
      if (selection.canceled || selection.filePaths.length !== 1) return { ok: false, canceled: true };
      return service.importTorrentFile(selection.filePaths[0], { ...params, destination: await destinationFromRequest(params, event) });
    }],
    ["pendingTorrentImports", async () => openQueue.snapshot()],
    ["dismissTorrentImport", async ({ token }) => openQueue.dismiss(token)],
    ["chooseTorrentDestination", async (_params, event) => {
      const selection = await dialog.showOpenDialog(mainWindow, {
        title: "Destination dans la bibliothèque",
        buttonLabel: "Choisir ce dossier",
        defaultPath: manager.status().downloadDir,
        properties: ["openDirectory", "createDirectory", "dontAddToRecent"],
      });
      if (selection.canceled || selection.filePaths.length !== 1) return { ok: false, canceled: true };
      const approved = await manager.approveLibraryRoot(selection.filePaths[0]);
      pruneDestinationCapabilities();
      if (destinationCapabilities.size >= MAX_DESTINATION_CAPABILITIES) throw new Error("Trop de destinations sont en attente.");
      const token = randomUUID();
      destinationCapabilities.set(token, { directory: approved.directory, ownerId: event.sender.id, expiresAt: Date.now() + DESTINATION_CAPABILITY_TTL_MS });
      return { ok: true, token, directory: approved.directory };
    }],
    ["chooseDownloadDirectory", async () => {
      const selection = await dialog.showOpenDialog(mainWindow, {
        title: "Bibliothèque par défaut",
        buttonLabel: "Utiliser ce dossier",
        defaultPath: manager.status().downloadDir,
        properties: ["openDirectory", "createDirectory", "dontAddToRecent"],
      });
      if (selection.canceled || selection.filePaths.length !== 1) return { ok: false, canceled: true };
      return manager.setDownloadDirectory(selection.filePaths[0]);
    }],
    ["openDownloadDirectory", async () => {
      const directory = manager.status().downloadDir;
      await manager.resolveAllowedDownloadRoot(directory);
      return openLocalDirectory(directory, { scope: "default" });
    }],
    ["openTorrentDirectory", async ({ id }) => {
      const directory = await service.resolveTorrentDownloadDirectory(id);
      return openLocalDirectory(directory, { scope: "torrent", torrentId: id });
    }],
    ["start", async ({ id }) => service.start(id)],
    ["stop", async ({ id }) => service.stop(id)],
    ["verifyAndScan", async ({ id }) => service.verifyAndScan(id)],
    ["remove", async (params) => service.remove(params)],
    ["setSeedPolicy", async (params) => service.setSeedPolicy(params)],
    ["openMedia", async (params, event) => service.openMedia(params, event.sender.id)],
    ["renewMedia", async ({ url }, event) => mediaVault.renew(url, event.sender.id)],
    ["releaseMedia", async ({ url }, event) => mediaVault.release(url, event.sender.id)],
    ["cancelMediaPreparation", async ({ requestId }, event) => service.cancelMediaPreparation(requestId, event.sender.id)],
    ["watchHistory", async () => watchHistory.snapshot()],
    ["savePlayback", async (params) => {
      const reference = await service.mediaReference(params);
      return watchHistory.update(reference.hash, reference.fileIndex, params);
    }],
    ["setMediaWatched", async (params) => {
      const reference = await service.mediaReference(params);
      return watchHistory.mark(reference.hash, reference.fileIndex, params.watched);
    }],
    ["audit", async ({ limit }) => audit.recent(limit)],
  ]);

  ipcMain.removeHandler(IPC_CHANNEL);
  ipcMain.handle(IPC_CHANNEL, async (event, request) => {
    const id = request?.id ?? null;
    try {
      if (!(await senderAllowed(event, mainWindow, renderer))) {
        await audit.append("security.ipc_sender_rejected", { webContentsId: event.sender.id });
        throw Object.assign(new Error("Émetteur IPC non autorisé."), { code: "UNAUTHORIZED" });
      }
      if (!allowRequest(event.sender.id)) throw Object.assign(new Error("Trop de requêtes locales."), { code: "RATE_LIMITED" });
      if (request?.jsonrpc !== "2.0" || !(typeof id === "string" || Number.isSafeInteger(id)) || typeof request.method !== "string") {
        throw Object.assign(new Error("Enveloppe JSON-RPC invalide."), { code: "INVALID_REQUEST" });
      }
      const handler = methods.get(request.method);
      if (!handler) throw Object.assign(new Error("Méthode locale inconnue."), { code: "METHOD_NOT_FOUND" });
      const params = request.params === undefined ? {} : request.params;
      if (!params || Array.isArray(params) || typeof params !== "object") throw Object.assign(new Error("Paramètres JSON-RPC invalides."), { code: "INVALID_PARAMS" });
      const result = await handler(params, event);
      return { jsonrpc: "2.0", id, result };
    } catch (error) {
      return errorEnvelope(id, error);
    }
  });
}

function lockRendererSession(window, renderer, mediaVault) {
  const windowSession = window.webContents.session;
  const permissionAllowed = (webContents, permission) => webContents === window.webContents
    && !window.isDestroyed()
    && permission === "fullscreen";
  windowSession.setPermissionCheckHandler((webContents, permission) => permissionAllowed(webContents, permission));
  windowSession.setPermissionRequestHandler((webContents, permission, callback) => callback(permissionAllowed(webContents, permission)));
  windowSession.setDevicePermissionHandler(() => false);
  windowSession.on("will-download", (event) => event.preventDefault());
  windowSession.webRequest.onBeforeRequest((details, callback) => {
    void (async () => {
      let allowed = false;
      try {
        const target = new URL(details.url);
        if (["secutorrent-media:", "blob:", "data:"].includes(target.protocol)) {
          allowed = true;
        } else if (renderer.mode === "development") {
          allowed = ["http:", "ws:"].includes(target.protocol) && target.hostname === renderer.url.hostname && target.port === renderer.url.port;
        } else {
          allowed = await fileUrlIsInside(target, renderer);
        }
      } catch { /* URL refusée. */ }
      callback({ cancel: !allowed });
    })();
  });
  windowSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders };
    const connectSource = renderer.mode === "development" ? "connect-src 'self' ws://127.0.0.1:* ws://[::1]:*" : "connect-src 'self'";
    responseHeaders["Content-Security-Policy"] = [
      `default-src 'self'; base-uri 'self'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob: secutorrent-media:; ${connectSource}`,
    ];
    responseHeaders["Permissions-Policy"] = ["camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), hid=(), clipboard-read=(), fullscreen=(self)"];
    responseHeaders["X-Content-Type-Options"] = ["nosniff"];
    responseHeaders["X-Frame-Options"] = ["DENY"];
    responseHeaders["Referrer-Policy"] = ["no-referrer"];
    callback({ responseHeaders });
  });
  const ownerId = window.webContents.id;
  window.webContents.once("destroyed", () => mediaVault.revokeOwner(ownerId));
}

async function bootstrap() {
  app.setAppUserModelId("com.slyreus.slyorent");
  const renderer = await rendererLocation(app.getAppPath());
  const audit = await new AuditLog(path.join(app.getPath("userData"), "security-audit")).initialize();
  const manager = new TransmissionManager({
    appPath: app.getAppPath(),
    userDataPath: app.getPath("userData"),
    defaultLibraryPath: path.join(app.getPath("documents"), PRODUCT_NAME),
    audit,
  });
  const sharingHistory = await new SharingHistory({
    filePath: path.join(app.getPath("userData"), "engine-profile", "sharing-history.json"),
    manager,
    audit,
  }).initialize();
  const mediaVault = new MediaVault();
  const watchHistory = await new WatchHistory(path.join(app.getPath("userData"), "watch-history.json")).initialize();
  const mediaAdapter = await new MediaAdapter({ cacheDirectory: path.join(app.getPath("userData"), "media-cache"), isFileInUse: (filePath) => mediaVault.isFileInUse(filePath) }).initialize();
  const peerTelemetry = await createDefaultPeerTelemetry({ databasePath: path.join(app.getAppPath(), ".runtime", "geoip", "GeoLite2-City.mmdb") });
  const contentRegistry = new ContentRegistry(path.join(app.getPath("userData"), "content-security"));
  const service = new TorrentService({ manager, audit, mediaVault, mediaAdapter, peerTelemetry, contentRegistry });
  let sharingMaintenanceTimer = null;
  let sharingMaintenanceInFlight = null;
  let validationMaintenanceTimer = null;
  let validationMaintenanceInFlight = null;

  const stopSharingMaintenance = async () => {
    await watchHistory.flush();
    if (sharingMaintenanceTimer !== null) {
      clearInterval(sharingMaintenanceTimer);
      sharingMaintenanceTimer = null;
    }
    if (validationMaintenanceTimer !== null) {
      clearInterval(validationMaintenanceTimer);
      validationMaintenanceTimer = null;
    }
    if (sharingMaintenanceInFlight) await sharingMaintenanceInFlight;
    if (validationMaintenanceInFlight) {
      await Promise.race([
        validationMaintenanceInFlight,
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
    if (manager.status().ready) {
      await sharingHistory.record().catch(async (error) => {
        await audit.append("sharing.history_record_failed", { reason: String(error?.code || "HISTORY_WRITE_FAILED").slice(0, 80) }).catch(() => undefined);
      });
    }
  };

  try {
    await manager.start();
    await service.initializeSecurity();
    await service.initializeSharing();
    await sharingHistory.record().catch(async (error) => {
      await audit.append("sharing.history_record_failed", { reason: String(error?.code || "HISTORY_WRITE_FAILED").slice(0, 80) }).catch(() => undefined);
    });
    sharingMaintenanceTimer = setInterval(() => {
      if (sharingMaintenanceInFlight) return;
      sharingMaintenanceInFlight = (async () => {
        await service.maintainSharing().catch(async (error) => {
          const code = error?.code;
          const reason = Number.isInteger(code) || (typeof code === "string" && /^[a-z0-9_.-]{1,64}$/i.test(code))
            ? String(code)
            : "MAINTENANCE_FAILED";
          await audit.append("sharing.maintenance_failed", { reason }).catch(() => undefined);
        });
        await sharingHistory.record().catch(async (error) => {
          await audit.append("sharing.history_record_failed", { reason: String(error?.code || "HISTORY_WRITE_FAILED").slice(0, 80) }).catch(() => undefined);
        });
      })().finally(() => {
        sharingMaintenanceInFlight = null;
      });
    }, SHARING_MAINTENANCE_INTERVAL_MS);
    sharingMaintenanceTimer.unref?.();
    validationMaintenanceTimer = setInterval(() => {
      if (validationMaintenanceInFlight) return;
      validationMaintenanceInFlight = service.maintainValidation().catch(async (error) => {
        const code = typeof error?.code === "string" && /^[a-z0-9_.-]{1,64}$/i.test(error.code) ? error.code : "VALIDATION_MAINTENANCE_FAILED";
        await audit.append("security.validation_maintenance_failed", { reason: code }).catch(() => undefined);
      }).finally(() => {
        validationMaintenanceInFlight = null;
      });
    }, VALIDATION_MAINTENANCE_INTERVAL_MS);
    validationMaintenanceTimer.unref?.();

  const mainWindow = new BrowserWindow({
    width: 1_440,
    height: 930,
    minWidth: 1_050,
    minHeight: 700,
    show: false,
    backgroundColor: "#050b18",
    autoHideMenuBar: true,
    title: PRODUCT_NAME,
    icon: path.join(app.getAppPath(), "public", "slyorus.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      spellcheck: false,
      partition: "secutorrent-local",
    },
  });
  mainWindow.webContents.session.protocol.handle("secutorrent-media", (request) => mediaVault.handle(request));
  lockRendererSession(mainWindow, renderer, mediaVault);
  registerIpc({ mainWindow, renderer, service, manager, audit, sharingHistory, watchHistory, mediaVault, openQueue });
  const mediaOwnerId = mainWindow.webContents.id;
  mainWindow.on("closed", () => service.cancelMediaOwner(mediaOwnerId));

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, destination) => {
    let allowed = false;
    try {
      const target = new URL(destination);
      allowed = renderer.mode === "development" ? target.origin === renderer.url.origin : productionNavigationAllowed(target, renderer);
    } catch { /* Navigation refusée ci-dessous. */ }
    if (!allowed) event.preventDefault();
  });
  mainWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.on("render-process-gone", (_event, details) => void audit.append("renderer.process_gone", { reason: details.reason, exitCode: details.exitCode }).catch(() => undefined));
  if (renderer.mode === "development") await mainWindow.loadURL(renderer.url.href);
  else await mainWindow.loadFile(renderer.indexFile);
  if (!app.isPackaged && process.env.SECUTORRENT_DEVTOOLS === "1") mainWindow.webContents.openDevTools({ mode: "detach" });
  await audit.append("app.ready", { engineVersion: manager.status().version });
  return { mainWindow, manager, audit, stopSharingMaintenance };
  } catch (error) {
    await stopSharingMaintenance().catch(() => undefined);
    await manager.stop().catch(() => undefined);
    throw error;
  }
}

app.setName(PRODUCT_NAME);
// Le nom du produit change, pas l'emplacement des torrents, audits et quarantaines existants.
app.setPath("userData", path.join(app.getPath("appData"), LEGACY_USER_DATA_DIRECTORY));
const hasLock = app.requestSingleInstanceLock();
let runtime = null;
let shutdownStarted = false;
const openQueue = new TorrentOpenQueue({ onChange: () => {
  const window = runtime?.mainWindow;
  if (window && !window.isDestroyed()) window.webContents.send("secutorrent:pending-imports");
} });
async function queueTorrentFiles(argv) {
  const result = await openQueue.enqueue(argv);
  if (result.rejected) dialog.showErrorBox("Fichier .torrent refusé", "Fichier local invalide, inaccessible, trop volumineux ou file d’attente pleine.");
}

if (!hasLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    void queueTorrentFiles(argv).catch(() => undefined);
    const window = runtime?.mainWindow;
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.on("open-file", (event, filePath) => { event.preventDefault(); void queueTorrentFiles([filePath]).catch(() => undefined); });
  app.whenReady().then(async () => {
    await queueTorrentFiles(process.argv);
    runtime = await bootstrap();
    if (openQueue.snapshot().length) runtime.mainWindow.webContents.send("secutorrent:pending-imports");
  }).catch((error) => {
    dialog.showErrorBox(`${PRODUCT_NAME} n'a pas démarré`, String(error?.message || error));
    app.exit(1);
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (shutdownStarted || !runtime) return;
    event.preventDefault();
    shutdownStarted = true;
    void runtime.stopSharingMaintenance().catch(() => undefined)
      .then(() => runtime.audit.append("app.stopping").catch(() => undefined))
      .then(() => runtime.manager.stop())
      .finally(() => app.quit());
  });
}

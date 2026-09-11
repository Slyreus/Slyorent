const { contextBridge, ipcRenderer } = require("electron");

const CHANNEL = "secutorrent:rpc";
let requestId = 0;

async function invoke(method, params = {}) {
  const id = ++requestId;
  const response = await ipcRenderer.invoke(CHANNEL, { jsonrpc: "2.0", id, method, params });
  if (!response || response.jsonrpc !== "2.0" || response.id !== id) throw new Error("Réponse IPC Slyorrent invalide.");
  if (response.error) {
    const error = new Error(String(response.error.message || "Opération refusée."));
    Object.defineProperty(error, "code", { value: response.error.code || "IPC_ERROR", enumerable: true });
    throw error;
  }
  return response.result;
}

const api = Object.freeze({
  status: () => invoke("status"),
  list: () => invoke("list"),
  globalSharing: () => invoke("globalSharing"),
  setGlobalSharing: (options) => invoke("setGlobalSharing", options),
  sharingDiagnostics: () => invoke("sharingDiagnostics"),
  sharingHistory: (hours = 12) => invoke("sharingHistory", { hours }),
  peerSnapshot: () => invoke("peerSnapshot"),
  locateSelf: () => invoke("locateSelf"),
  inspectMagnet: (magnet) => invoke("inspectMagnet", { magnet }),
  addMagnet: (options) => invoke("addMagnet", options),
  importTorrent: (options) => invoke("importTorrent", options),
  pendingTorrentImports: () => invoke("pendingTorrentImports"),
  dismissTorrentImport: (token) => invoke("dismissTorrentImport", { token }),
  onPendingTorrentImports: (callback) => {
    if (typeof callback !== "function") throw new TypeError("Fonction attendue.");
    const listener = () => callback();
    ipcRenderer.on("secutorrent:pending-imports", listener);
    return () => ipcRenderer.removeListener("secutorrent:pending-imports", listener);
  },
  chooseTorrentDestination: () => invoke("chooseTorrentDestination"),
  chooseDownloadDirectory: () => invoke("chooseDownloadDirectory"),
  openDownloadDirectory: () => invoke("openDownloadDirectory"),
  openTorrentDirectory: (id) => invoke("openTorrentDirectory", { id }),
  start: (id) => invoke("start", { id }),
  stop: (id) => invoke("stop", { id }),
  verifyAndScan: (id) => invoke("verifyAndScan", { id }),
  remove: (options) => invoke("remove", options),
  setSeedPolicy: (options) => invoke("setSeedPolicy", options),
  openMedia: (options) => invoke("openMedia", options),
  renewMedia: (url) => invoke("renewMedia", { url }),
  releaseMedia: (url) => invoke("releaseMedia", { url }),
  cancelMediaPreparation: (requestId) => invoke("cancelMediaPreparation", { requestId }),
  watchHistory: () => invoke("watchHistory"),
  savePlayback: (options) => invoke("savePlayback", options),
  setMediaWatched: (options) => invoke("setMediaWatched", options),
  audit: (limit = 100) => invoke("audit", { limit }),
});

contextBridge.exposeInMainWorld("secuTorrent", api);

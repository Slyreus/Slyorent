import { app, BrowserWindow, ipcMain, protocol } from "electron";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MediaVault } from "../../electron/media-vault.mjs";
import { WatchHistory } from "../../electron/watch-history.mjs";

const directory = path.resolve(process.argv[2]);
app.setPath("userData", path.join(directory, "profile"));
protocol.registerSchemesAsPrivileged([{ scheme: "secutorrent-media", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false } }]);
async function run() {
await app.whenReady();
const filePath = path.join(directory, "sample.mp4");
const file = await stat(filePath);
const history = await new WatchHistory(path.join(directory, "watch-history.json")).initialize();
const vault = new MediaVault();
const hash = "b".repeat(40);
const calls = [];
const outstanding = new Set();
const cancellations = new Set();
let delay = 0;
const window = new BrowserWindow({ width: 1250, height: 900, show: false, webPreferences: { preload: path.join(path.dirname(fileURLToPath(import.meta.url)), "preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, autoplayPolicy: "no-user-gesture-required" } });
window.webContents.setAudioMuted(true);
window.webContents.session.protocol.handle("secutorrent-media", (request) => vault.handle(request));
window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !["file:", "secutorrent-media:"].includes(new URL(details.url).protocol) }));
window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
window.webContents.on("console-message", (_event, details) => { if (details.level === "error") console.error(details.message); });
const timer = setTimeout(() => { console.log("FAIL Délai du test dépassé"); app.exit(1); }, 70_000);
ipcMain.handle("media-test", async (_event, method, params = {}) => {
  switch (method) {
    case "openMedia": {
      calls.push({ fileIndex: params.fileIndex, purpose: params.purpose });
      const pendingDelay = delay; delay = 0;
      if (pendingDelay) await new Promise((resolve) => setTimeout(resolve, pendingDelay));
      if (cancellations.has(params.requestId)) throw new Error("Préparation annulée.");
      const issued = vault.issue({ filePath, torrentKey: hash, ownerWebContentsId: window.webContents.id, mimeType: "video/mp4", name: "sample.mp4", expectedSize: file.size, expectedMtimeMs: file.mtimeMs });
      outstanding.add(issued.url);
      return issued;
    }
    case "renewMedia": return vault.renew(params.url, window.webContents.id);
    case "releaseMedia": outstanding.delete(params.url); return vault.release(params.url, window.webContents.id);
    case "cancelMediaPreparation": cancellations.add(params.requestId); return { ok: true };
    case "watchHistory": return history.snapshot();
    case "savePlayback": return history.update(hash, params.fileIndex, params);
    case "setMediaWatched": return history.mark(hash, params.fileIndex, params.watched);
    case "expire": vault.revokeOwner(window.webContents.id); outstanding.clear(); return true;
    case "delay": delay = 600; return true;
    case "metrics": return { calls, outstanding: outstanding.size };
    case "finish":
      clearTimeout(timer);
      await history.flush();
      console.log(params.ok ? `PASS ${params.message}` : `FAIL ${params.message}`);
      setTimeout(() => app.exit(params.ok ? 0 : 1), 50);
      return true;
    default: throw new Error("Méthode de test inconnue.");
  }
});
await window.loadFile(path.join(directory, "dist", "index.html"));
}
void run().catch((error) => { console.log(`FAIL ${error.message}`); app.exit(1); });

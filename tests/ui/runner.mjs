import { app, BrowserWindow, ipcMain, protocol } from "electron";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MediaVault } from "../../electron/media-vault.mjs";
import { WatchHistory } from "../../electron/watch-history.mjs";
import { LibraryPreferences } from "../../electron/library-preferences.mjs";

const directory = path.resolve(process.argv[2]);
app.setPath("userData", path.join(directory, "profile"));
protocol.registerSchemesAsPrivileged([{ scheme: "secutorrent-media", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false } }]);
async function run() {
await app.whenReady();
const filePath = path.join(directory, "sample.mp4");
const file = await stat(filePath);
const history = await new WatchHistory(path.join(directory, "watch-history.json")).initialize();
const preferences = await new LibraryPreferences(path.join(directory, "library-preferences.json")).initialize();
const vault = new MediaVault();
const hash = "b".repeat(40);
const calls = [];
const outstanding = new Set();
const cancellations = new Set();
let delay = 0;
const window = new BrowserWindow({ width: 1250, height: 900, show: false, webPreferences: { preload: path.join(path.dirname(fileURLToPath(import.meta.url)), "preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false, offscreen: true, autoplayPolicy: "no-user-gesture-required" } });
window.webContents.setAudioMuted(true);
window.webContents.session.protocol.handle("secutorrent-media", (request) => vault.handle(request));
window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !["file:", "secutorrent-media:"].includes(new URL(details.url).protocol) }));
window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
window.webContents.on("console-message", (details) => { if (details.level === "error") console.error(details.message); });
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
    case "mediaPreparation": return { stage: "video", percent: 42, hardware: false };
    case "watchHistory": return history.snapshot();
    case "libraryPreferences": return preferences.snapshot();
    case "saveLibraryPreferences": return preferences.update(params);
    case "savePlayback": return history.update(hash, params.fileIndex, params);
    case "setMediaWatched": return history.mark(hash, params.fileIndex, params.watched);
    case "expire": vault.revokeOwner(window.webContents.id); outstanding.clear(); return true;
    case "delay": delay = 2200; return true;
    case "metrics": return { calls, outstanding: outstanding.size };
    case "verifyAndScan": calls.push({ action: "verifyAndScan", id: params.id }); return { ok: true };
    case "openTorrentDirectory": calls.push({ action: "openTorrentDirectory", id: params.id }); return { ok: true };
    case "resize": window.setContentSize(params.small ? 520 : 1250, 900); return true;
    case "capture": {
      if (!["catalog-titles", "catalog-series", "catalog-small"].includes(params.name)) throw new Error("Capture inconnue.");
      const output = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.runtime/catalog-preview");
      await mkdir(output, { recursive: true });
      window.webContents.invalidate();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const captured = await window.webContents.capturePage();
      await writeFile(path.join(output, `${params.name}.png`), captured.toPNG());
      if (params.frameRect) {
        const pixels = captured.crop(params.frameRect).toBitmap();
        let red = 0;
        for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 2] > 160 && pixels[i] < 90 && pixels[i + 1] < 90) red++;
        if (red < 50) throw new Error(`Frame synthétique absente de l'aperçu : ${red} pixels rouges.`);
      }
      return true;
    }
    case "finish":
      clearTimeout(timer);
      await history.flush();
      await preferences.flush();
      console.log(params.ok ? `PASS ${params.message}` : `FAIL ${params.message}`);
      setTimeout(() => app.exit(params.ok ? 0 : 1), 50);
      return true;
    default: throw new Error("Méthode de test inconnue.");
  }
});
await window.loadFile(path.join(directory, "dist", "index.html"));
}
void run().catch((error) => { console.log(`FAIL ${error.message}`); app.exit(1); });

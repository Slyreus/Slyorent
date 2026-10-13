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
let castState = { active: false };
let castTimer;
const window = new BrowserWindow({ width: 1250, height: 900, show: false, webPreferences: { preload: path.join(path.dirname(fileURLToPath(import.meta.url)), "preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false, offscreen: true, autoplayPolicy: "no-user-gesture-required" } });
window.webContents.setAudioMuted(true);
window.webContents.session.protocol.handle("secutorrent-media", (request) => vault.handle(request));
window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !["file:", "blob:", "secutorrent-media:"].includes(new URL(details.url).protocol) }));
window.webContents.session.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: secutorrent-media:; connect-src 'self'"] } }));
window.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === "fullscreen"));
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
      return { ...issued, audioLanguage: params.audioTrack === 2 ? "fre" : "jpn", selectedAudioTrack: params.audioTrack ?? 1,
        audioTracks: [{ index: 1, language: "jpn", title: "", codec: "aac", channels: 2, default: true, forced: false }, { index: 2, language: "fre", title: "", codec: "aac", channels: 2, default: false, forced: false }],
        subtitleTracks: [{ index: 3, language: "fre", title: "", codec: "ass", default: true, forced: false, supported: true }, { index: 4, language: "eng", title: "", codec: "subrip", default: false, forced: false, supported: true }],
      };
    }
    case "openSubtitle": {
      if (cancellations.has(params.requestId)) throw new Error("Préparation annulée.");
      if (![3, 4].includes(params.trackIndex)) throw new Error("Piste de sous-titres introuvable.");
      return { vtt: `WEBVTT\n\n00:00:00.000 --> 00:01:00.000\n${params.trackIndex === 3 ? "Sous-titres français de test.\nNous retrouverons le chemin\net rejoindrons la ville avant la tombée de la nuit." : "English test subtitles"}\n` };
    }
    case "castDiscover": return { devices: [{ id: "tv-test", kind: "chromecast", name: "TV de test", model: "Test" }], networks: [{ id: "network-test", name: "Réseau de test", address: "192.168.1.10" }] };
    case "castStatus": return castState;
    case "castStart": {
      if (typeof params.autoNext !== "boolean" || !params.queue.length || params.deviceId !== "tv-test") throw new Error("Options de cast incorrectes");
      await new Promise(resolve => setTimeout(resolve, 250));
      clearTimeout(castTimer);
      castState = { active: true, kind: "chromecast", deviceName: "TV de test", queue: params.queue, item: params.queue[params.index], index: params.index, total: params.queue.length, position: params.position, duration: 60, playing: false, paired: true, phase: "preparing", loading: true, preparation: { stage: "video", percent: 42, hardware: false }, autoNext: params.autoNext, volumeSupported: true, volume: .6, audioTracks: [{ index: 1, language: "jpn", codec: "aac", channels: 2 }, { index: 2, language: "fre", codec: "aac", channels: 2 }], subtitleTracks: [{ index: 3, language: "fre", codec: "ass", supported: true }], selectedAudioTrack: params.audioTrack ?? 1, selectedSubtitleTrack: params.subtitleTrack === undefined ? 3 : params.subtitleTrack };
      castTimer = setTimeout(() => { if (castState.active) castState = { ...castState, phase: "loading", loading: false, playing: true, preparation: null, nextPrepared: true }; }, 1200);
      return castState;
    }
    case "castControl": {
      calls.push({ castAction: params.action, value: params.value });
      if (params.action === "stop") { clearTimeout(castTimer); castState = { active: false }; }
      else if (params.action === "pause" || params.action === "play") castState = { ...castState, playing: params.action === "play" };
      else if (params.action === "seek") castState = { ...castState, position: params.value };
      else if (params.action === "volume") castState = { ...castState, volume: params.value };
      else if (params.action === "autoNext") castState = { ...castState, autoNext: params.value };
      else if (params.action === "tracks") castState = { ...castState, selectedAudioTrack: params.audioTrack ?? castState.selectedAudioTrack, selectedSubtitleTrack: params.subtitleTrack === undefined ? castState.selectedSubtitleTrack : params.subtitleTrack };
      else if (["next", "previous", "episode"].includes(params.action)) { const index = params.action === "episode" ? params.value : castState.index + (params.action === "next" ? 1 : -1); castState = { ...castState, index, item: castState.queue[index], position: 0, playing: true }; }
      else throw new Error("Commande de test inconnue");
      return castState;
    }
    case "castFailure": clearTimeout(castTimer); castState = { active: false, error: "Appareil de test déconnecté." }; return true;
    case "castSilentStop": clearTimeout(castTimer); castState = { active: false }; return true;
    case "fullscreen": return window.webContents.executeJavaScript("document.querySelector('.sly-media-player').requestFullscreen().then(() => true, () => false)", true);
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
    case "resize": window.setContentSize(params.wide ? 1920 : params.small ? 520 : 1250, params.wide ? 1080 : 900); return true;
    case "capture": {
      if (!["catalog-titles", "catalog-series", "catalog-small", "player-captions", "player-captions-wide", "player-captions-small", "player-cast-preparing", "player-cast-playing", "player-cast-small", "player-cast-error"].includes(params.name)) throw new Error("Capture inconnue.");
      // Les aperçus du lecteur servent au contrôle visuel local ; les mesures de mise en page restent vérifiées en CI.
      if (process.env.GITHUB_ACTIONS === "true" && params.name.startsWith("player-")) return true;
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

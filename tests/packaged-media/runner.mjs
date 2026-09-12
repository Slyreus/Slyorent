import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, protocol } from "electron";

const archive = path.resolve(process.argv[2]);
const directory = path.resolve(process.argv[3]);
app.setPath("userData", path.join(directory, "profile"));
protocol.registerSchemesAsPrivileged([{ scheme: "secutorrent-media", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false } }]);

async function run() {
  await app.whenReady();
  // Charger les modules depuis le véritable ASAR : les tests de développement
  // seuls ne couvrent pas les chemins des exécutables dépaquetés.
  const { MediaAdapter } = await import(pathToFileURL(path.join(archive, "electron", "media-adapter.mjs")).href);
  const { MediaVault } = await import(pathToFileURL(path.join(archive, "electron", "media-vault.mjs")).href);
  const sourcePath = path.join(directory, "sample.mkv");
  const source = await stat(sourcePath);
  const adapter = await new MediaAdapter({ cacheDirectory: path.join(directory, "cache"), hardwareAcceleration: false }).initialize();
  const options = { sourcePath, sourceSize: source.size, sourceMtimeMs: source.mtimeMs };
  const prepared = await adapter.prepare(options);
  assert.equal(prepared.audioAdapted, true);
  assert.equal(prepared.videoAdapted, true);
  assert.equal(prepared.videoCodec, "H264");
  assert.equal(prepared.audioCodec, "AAC");
  assert.equal(prepared.audioLanguage, "fre");
  assert.equal(prepared.cacheHit, false);
  const cached = await adapter.prepare(options);
  assert.equal(cached.cacheHit, true);
  assert.equal(cached.filePath, prepared.filePath);

  const window = new BrowserWindow({ show: false, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
    autoplayPolicy: "no-user-gesture-required",
  } });
  window.webContents.setAudioMuted(true);
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !["file:", "secutorrent-media:"].includes(new URL(details.url).protocol) }));
  const vault = new MediaVault();
  window.webContents.session.protocol.handle("secutorrent-media", (request) => vault.handle(request));
  const media = vault.issue({
    filePath: prepared.filePath, torrentKey: "b".repeat(40), ownerWebContentsId: window.webContents.id,
    mimeType: prepared.mimeType, name: "sample.mp4", expectedSize: prepared.size, expectedMtimeMs: prepared.mtimeMs,
  });
  await window.loadFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "player.html"));
  const playback = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const video = document.querySelector("video");
    const timer = setTimeout(() => reject(new Error("Lecture trop longue à démarrer.")), 15000);
    video.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Échec du décodage média.")); }, { once: true });
    video.addEventListener("timeupdate", () => {
      if (video.currentTime < 0.25) return;
      clearTimeout(timer);
      const result = { duration: video.duration, width: video.videoWidth, audioBytes: video.webkitAudioDecodedByteCount || 0 };
      video.pause();
      resolve(result);
    });
    video.src = ${JSON.stringify(media.url)};
    video.play().catch((error) => { clearTimeout(timer); reject(error); });
  })`);
  assert.equal(playback.width, 320);
  assert.ok(playback.duration >= 1.9 && playback.duration < 3);
  assert.ok(playback.audioBytes > 0, "La piste AAC doit être réellement décodée.");
  vault.revokeOwner(window.webContents.id);
  window.destroy();
  console.log("PASS Média empaqueté : HEVC 10 bits / E-AC3 français → H264 / AAC, cache, lecture vidéo et décodage audio.");
  app.exit(0);
}

void run().catch((error) => { console.log(`FAIL ${error.code || "MEDIA_TEST_FAILED"} : ${error.message}`); app.exit(1); });

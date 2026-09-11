import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.resolve(process.argv[2]);
const preview = process.argv.includes("--preview");
app.setPath("userData", path.join(directory, "profile"));
async function run() {
  await app.whenReady();
  const window = new BrowserWindow({ width: 1480, height: 1000, show: true, autoHideMenuBar: true, webPreferences: { preload: path.join(path.dirname(fileURLToPath(import.meta.url)), "preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: preview } });
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: new URL(details.url).protocol !== "file:" }));
  window.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === "fullscreen"));
  window.webContents.session.setPermissionCheckHandler((_contents, permission) => permission === "fullscreen");
  const errors = [];
  window.webContents.on("console-message", (_event, details) => { if (details.level === "error") errors.push(details.message); });
  const timer = setTimeout(() => { console.log("FAIL Délai du test dépassé"); app.exit(1); }, preview ? 600_000 : 55_000);
  ipcMain.handle("map-test", async (event, method, params = {}) => {
    if (event.sender !== window.webContents) throw new Error("Fenêtre inattendue.");
    if (method === "fullscreen") { await window.webContents.executeJavaScript(`document.querySelector('[aria-label="Carte en plein écran"]').click()`, true); return true; }
    if (method === "resize") { window.setContentSize(520, 900); return true; }
    if (method === "finish") {
      const ok = params.ok && errors.length === 0;
      clearTimeout(timer);
      console.log(`${ok ? "PASS" : "FAIL"} ${params.message}${errors.length ? ` · ${errors.join(" · ")}` : ""}`);
      setTimeout(() => app.exit(ok ? 0 : 1), 80);
      return true;
    }
    throw new Error("Méthode inconnue.");
  });
  window.on("closed", () => { clearTimeout(timer); app.quit(); });
  await window.loadFile(path.join(directory, "dist", "index.html"), preview ? { hash: "preview" } : {});
}
void run().catch((error) => { console.log(`FAIL ${error.message}`); app.exit(1); });

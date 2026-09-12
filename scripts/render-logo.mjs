import { app, BrowserWindow } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [source, destination] = process.argv.slice(2);
if (!source || !destination || !path.isAbsolute(source) || !path.isAbsolute(destination)) throw new Error("Chemins de rendu invalides.");
app.setPath("userData", path.join(path.dirname(destination), "profile"));
app.disableHardwareAcceleration();
const timer = setTimeout(() => app.exit(1), 30_000);

async function render() {
  const svg = await readFile(source);
  await app.whenReady();
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith("data:") }));
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const document = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:"><img id="logo" alt="" src="data:image/svg+xml;base64,${svg.toString("base64")}">`;
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(document)}`);
  const png = await window.webContents.executeJavaScript(`(async () => {
    const logo = document.getElementById("logo");
    await logo.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 1024; canvas.height = 1024;
    canvas.getContext("2d").drawImage(logo, 0, 0, 1024, 1024);
    return canvas.toDataURL("image/png");
  })()`);
  if (!png.startsWith("data:image/png;base64,")) throw new Error("Rendu PNG invalide.");
  await writeFile(destination, Buffer.from(png.slice("data:image/png;base64,".length), "base64"));
  window.destroy();
}

void render().then(() => { clearTimeout(timer); app.exit(0); }).catch((error) => { console.error(error.message); clearTimeout(timer); app.exit(1); });

// Le preload de test est sandboxé comme celui de l'application.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("mediaTest", { invoke: (method, params) => ipcRenderer.invoke("media-test", method, params) });

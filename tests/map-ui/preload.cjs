// eslint-disable-next-line @typescript-eslint/no-require-imports -- Preload Electron sandboxé.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("mapTest", { invoke: (method, params) => ipcRenderer.invoke("map-test", method, params) });

// Minimal bridge for the shell-update banner injected by main.js: contextIsolation
// stays on, so the banner's click handler reaches the main process through this
// instead of nodeIntegration.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hiveShell", {
  relaunchUpdate: () => ipcRenderer.send("shell-update-relaunch"),
  onRelaunchError: (cb) => ipcRenderer.on("shell-update-relaunch-error", (_event, message) => cb(message)),
});

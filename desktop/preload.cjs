const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopAssistant", {
  onPushToTalk(callback) {
    if (typeof callback !== "function") return () => {};
    const listener = () => callback();
    ipcRenderer.on("desktop:push-to-talk", listener);
    return () => ipcRenderer.removeListener("desktop:push-to-talk", listener);
  },
});

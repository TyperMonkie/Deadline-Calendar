const { contextBridge, ipcRenderer } = require("electron");

// Seed the legacy browser store before any renderer bundle runs. The desktop
// JSON file remains authoritative; this bridge also protects users if Chromium
// ever restores an older renderer bundle that still reads localStorage.
const startupDataResult = ipcRenderer.sendSync("data:load-sync");
if (startupDataResult?.ok) {
  try {
    localStorage.setItem("ddl-calendar.tasks.v1", JSON.stringify(startupDataResult.data.tasks));
    localStorage.setItem("ddl-calendar.sync.v1", JSON.stringify(startupDataResult.data.syncState));
  } catch {
    // The normal IPC bootstrap below still works when localStorage is unavailable.
  }
}

contextBridge.exposeInMainWorld("ddlCalendar", {
  platform: "desktop",
  data: {
    loadSync: () => ipcRenderer.sendSync("data:load-sync"),
    load: () => ipcRenderer.invoke("data:load"),
    save: (input) => ipcRenderer.invoke("data:save", input),
  },
  mail: {
    getStatusSync: () => ipcRenderer.sendSync("mail:get-status-sync"),
    getStatus: () => ipcRenderer.invoke("mail:get-status"),
    configure: (input) => ipcRenderer.invoke("mail:configure", input),
    sync: () => ipcRenderer.invoke("mail:sync"),
  },
  learn: {
    openLogin: () => ipcRenderer.invoke("learn:open-login"),
    getStatus: () => ipcRenderer.invoke("learn:get-status"),
    saveSession: () => ipcRenderer.invoke("learn:save-session"),
    refreshAssignment: (input) => ipcRenderer.invoke("learn:refresh-assignment", input),
    onAuthenticated: (callback) => {
      const listener = () => callback();
      ipcRenderer.on("learn:authenticated", listener);
      return () => ipcRenderer.removeListener("learn:authenticated", listener);
    },
  },
  attachments: {
    download: (input) => ipcRenderer.invoke("attachments:download", input),
    exists: (filePath) => ipcRenderer.invoke("attachments:exists", filePath),
    open: (filePath) => ipcRenderer.invoke("attachments:open", filePath),
    show: (filePath) => ipcRenderer.invoke("attachments:show", filePath),
    onProgress: (callback) => {
      const listener = (_event, progress) => callback(progress);
      ipcRenderer.on("attachments:progress", listener);
      return () => ipcRenderer.removeListener("attachments:progress", listener);
    },
  },
});

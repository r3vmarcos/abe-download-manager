const { contextBridge, ipcRenderer } = require("electron");

// Ponte mínima: o frontend usa isto para abrir o seletor de pasta nativo.
contextBridge.exposeInMainWorld("abe", {
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  restart: () => ipcRenderer.invoke("restart"),
});

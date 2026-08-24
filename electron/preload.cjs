const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fleetRentalBot', {
  getBootstrap: () => ipcRenderer.invoke('app:get-bootstrap'),
});

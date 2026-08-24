const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fleetRentalBot', {
  getBootstrap: () => ipcRenderer.invoke('app:get-bootstrap'),
  loadWatchlist: () => ipcRenderer.invoke('watchlist:load'),
  saveWatchlist: (document) => ipcRenderer.invoke('watchlist:save', document),
});
